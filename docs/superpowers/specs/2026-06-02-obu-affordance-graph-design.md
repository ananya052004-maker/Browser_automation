# OBU Affordance Graph — Design

**Date:** 2026-06-02
**Status:** Draft for review
**Principle:** OBU remains LLM-first. The browser environment should expose a richer, more human-like, evidence-backed semantic operating surface without narrowing the agent's action space or turning lifecycle/state-machine infrastructure into an operational burden.

---

## 1. Problem

The current OBU observation stack is capable, but fragmented:

- `tab.snapshotText()` / `tab.affordances()` provide a capped, flat affordance summary with locator recipes and uniqueness metadata.
- `tab.domSnapshot()` exposes a full Playwright ARIA snapshot string, but the string is not connected to stable executable node ids.
- `tab.dom_cua.get_visible_dom()` exposes viewport-visible DOM-CUA nodes with observation-scoped `node_id`s and geometry-backed actions.
- `tab.observe()` wraps several sections in a lifecycle envelope with ownership, freshness, diagnostics, and action-family support.

This gives the agent multiple useful observation channels, but it does not yet provide a single semantic environment model that answers:

- What actionable things exist on the page?
- What are their roles, names, states, hierarchy, frame ownership, and blocker context?
- Which execution routes can reliably act on each thing?
- What evidence supports each route?
- How should stale observations, frame changes, overlay changes, and partial snapshots be diagnosed?

The result is that agents still have to bridge too much environment state themselves, especially on pages with iframes, shadow DOM, custom controls, consent overlays, login walls, geo gates, and weak selectors.

The goal is not to replace LLM judgement with deterministic rules. The goal is to let the LLM observe a semantic operating environment closer to what a human perceives, while keeping the full open action space available.

## 2. Key External Reference: Stagehand

Stagehand's useful contribution is not "a11y tree" in isolation. Its core idea is a hybrid snapshot:

```text
AX tree      -> semantic structure for the LLM
DOM index    -> stable executable addressing
frame merge  -> global cross-iframe context
encoded ids  -> connection between LLM output and real DOM nodes
```

Relevant Stagehand source:

- `packages/core/lib/v3/understudy/a11y/snapshot/capture.ts`
- `packages/core/lib/v3/understudy/a11y/snapshot/a11yTree.ts`
- `packages/core/lib/v3/understudy/a11y/snapshot/domTree.ts`
- `packages/core/lib/v3/understudy/deepLocator.ts`
- `packages/core/lib/v3/handlers/observeHandler.ts`

Stagehand `observe()` flow:

1. Capture a hybrid snapshot across frames.
2. Render a compact AX-derived semantic tree with encoded ids.
3. Send that tree to the LLM.
4. LLM returns candidate actions referencing `elementId`.
5. System maps `elementId` to XPath through `combinedXpathMap`.
6. Action execution uses the resolved selector.

Stagehand strengths worth borrowing:

- AX tree as the LLM-facing semantic layer.
- `frameOrdinal-backendNodeId` encoded ids.
- DOM index from backend node ids to XPath/tag/scroll metadata.
- Frame tree merge and iframe prefixing.
- Scoped snapshot via `focusSelector`.
- `ignoreSelectors` to suppress overlays, ads, and irrelevant subtrees.
- Shadow DOM piercing and selector fallback.
- Deep locator semantics for cross-iframe XPath / hop notation.
- Self-heal pattern: on action failure, re-snapshot and re-resolve.

Stagehand limitations we should not copy directly:

- Public observe output is only action candidates, not a reusable environment graph.
- XPath is the primary executable bridge; it lacks richer locator confidence and alternatives.
- It has limited lifecycle/freshness semantics compared with OBU.
- It does not model OBU ownership, runtime epochs, observation invalidation, DOM-CUA node scopes, or late-success reconciliation.
- It does not provide a first-class blocker taxonomy for login, consent, CAPTCHA, paywall, geo gates, and browser error pages.

Source snapshot used for this review: local Stagehand clone at
`/Users/labrinyang/projects/stagehand`, `main` at commit `dc1445df805cd3ad1f577278f978932244023a2e`.

## 3. OBU Current Strengths To Preserve

OBU already has architecture Stagehand does not:

- `TabObservation` lifecycle envelope with `observationId`, `status`, `sections`, `lifecycle`, `ownership`, `actionFamilies`, `diagnostics`.
- Observation freshness checks before action execution.
- Observation invalidation after consuming action-bound observations.
- DOM-CUA visible DOM snapshots scoped by observation id.
- OOPIF-aware DOM-CUA routing and geometry-backed actions.
- Visual observations that pair screenshots with DOM-CUA annotation bounds.
- Multiple action modalities: locator, DOM-CUA, coordinate CUA, raw evaluation, screenshot, DOM snapshot, and scoped re-observe.

The new design must attach to this lifecycle architecture rather than bypass it.

Affordance Graph is therefore an additional observation section and action substrate, not a replacement for `snapshotText`, `domSnapshot`, `dom_cua`, screenshot, locator, or evaluate.

## 4. Design Goal

Add an `AffordanceGraph` observation layer that composes existing and new evidence into a graph:

```text
A11y semantic tree
+ DOM/backend-node index
+ frame/iframe context
+ DOM-CUA visible geometry
+ locator recipes
+ screenshot/visual annotations
+ blocker diagnostics
+ OBU lifecycle revisions
= Affordance Graph
```

The graph gives the LLM a compact semantic structure to reason over, while retaining all existing action paths:

- Read the affordance graph.
- Read DOM-CUA.
- Read screenshot / visual annotations.
- Read full `domSnapshot()`.
- Evaluate page JavaScript.
- Use locator APIs.
- Use coordinate actions.
- Re-observe.
- Scope observation to a local subtree.

This is LLM-first and evidence-rich, not rule-first.

## 5. Non-Goals

- Do not make Affordance Graph the only action space.
- Do not force the agent to choose only system-enumerated actions.
- Do not auto-click consent, login, or blocker UI.
- Do not hide raw evidence or remove fallback observation tools.
- Do not replace lifecycle checks with graph-local heuristics.
- Do not make XPath the only locator output.
- Do not make every observation heavy by default before measuring token/performance impact.

## 6. Proposed Public API

### 6.1 Optional section on `tab.observe()`

Add an opt-in field first:

```ts
await tab.observe({
  mode: "actionable",
  includeAffordanceGraph: true,
});
```

`TabObservation` gains:

```ts
affordanceGraph?: TabAffordanceGraph;
```

`sections` gains:

```ts
affordanceGraph: ObservationSectionStatus;
```

`ObservationLifecycle` gains:

```ts
affordanceSemanticRevision?: string;
affordanceLocatorRevision?: string;
affordanceGeometryRevision?: string;
affordanceDiagnosticsRevision?: string;
```

V1 should keep the default off unless the agent explicitly requests it. Only after Phase 2 hybrid-snapshot validation and prompt/playbook validation may `mode: "actionable"` include the graph by default, and only if token and latency budgets are acceptable.

### 6.2 Direct graph read

Add:

```ts
await tab.affordanceGraph({
  scope?: AffordanceGraphScope;
  ignoreSelectors?: string[];
  includeIframes?: boolean;
  includeDomCua?: boolean;
  includeScreenshot?: boolean;
  actionable?: boolean;
  maxNodes?: number;
  timeout?: number;
});

type AffordanceGraphScope =
  | { kind: "locator"; selector: string }
  | { kind: "frame-locator"; frameSelector: string; selector?: string }
  | { kind: "xpath"; expression: string };
```

Scope grammar must not introduce a third selector dialect:

- `kind: "locator"` uses the same selector syntax accepted by `tab.locator(selector)`.
- `kind: "frame-locator"` maps to the existing `tab.frameLocator(frameSelector).locator(selector)` model.
- `kind: "xpath"` is allowed only once the host hybrid snapshot substrate exists, because XPath needs the same frame/deep-locator semantics as the encoded-id map.

This direct method is useful when the agent wants only the graph surface, but it must still preserve observation semantics. It returns a graph observation envelope, not a bare graph:

```ts
export type TabAffordanceGraphObservation = {
  observationId: string;
  createdAt: number;
  lifecycle: ObservationLifecycle;
  sections: { affordanceGraph: ObservationSectionStatus };
  graph: TabAffordanceGraph;
};
```

When `actionable: false`, the graph may omit DOM-CUA and coordinate locators and can be treated as read-only. When `actionable !== false`, the method must allocate an observation id and bind any DOM-CUA or coordinate locators to that id and lifecycle.

### 6.3 Future graph action target

Defer until the Phase 2 hybrid substrate is validated:

```ts
await tab.act.click({
  source: "affordance",
  nodeId: "f0-be123",
  observationId,
});
```

The first implementation should expose graph evidence only. Action-target support comes later.

## 7. Data Model

### 7.1 `TabAffordanceGraph`

```ts
export type TabAffordanceGraph = {
  version: 1;
  graphId: string;
  createdAt: number;
  outline: string;
  nodes: AffordanceNode[];
  edges: AffordanceEdge[];
  frames: AffordanceFrame[];
  blockers: BlockerSignal[];
  diagnostics: AffordanceGraphDiagnostics;
  meta: {
    shown: number;
    total?: number;
    truncated: boolean;
    revisions: {
      semantic: string;
      locator?: string;
      geometry?: string;
      visual?: string;
      diagnostics?: string;
    };
    executableBridge: "none" | "partial" | "complete";
    sources: Array<"a11y" | "dom-index" | "dom-cua" | "snapshot-text" | "visual">;
  };
};
```

### 7.2 `AffordanceNode`

```ts
export type AffordanceNode = {
  id: string; // e.g. "f0-be123"
  role: string;
  name?: string;
  description?: string;
  value?: string | number | boolean;
  tag?: string;
  type?: string;
  state?: {
    disabled?: boolean;
    checked?: boolean;
    selected?: boolean;
    expanded?: boolean;
    focused?: boolean;
    editable?: boolean;
    required?: boolean;
  };
  frame: {
    ordinal: number;
    frameId?: string;
    url?: string;
    parentNodeId?: string;
  };
  tree: {
    parentId?: string;
    childIds?: string[];
    depth: number;
  };
  geometry?: {
    rect?: { x: number; y: number; width: number; height: number };
    inViewport?: boolean;
    visible?: boolean;
    occluded?: boolean;
  };
  locators: AffordanceLocatorRecipe[];
  actions: AffordanceActionHint[];
  evidence: {
    ax?: Record<string, unknown>;
    dom?: Record<string, unknown>;
    domCua?: Record<string, unknown>;
    visual?: Record<string, unknown>;
  };
  confidence: {
    semantic: EvidenceConfidence;
    locator: EvidenceConfidence;
    actionability: EvidenceConfidence;
  };
  diagnostics?: string[];
};

export type EvidenceConfidence = "high" | "medium" | "low" | "unknown";
```

### 7.3 Locator recipes

```ts
export type AffordanceLocatorRecipe =
  | {
      kind: "role";
      expression: string;
      matchCount?: number;
      unique?: boolean;
      confidence: EvidenceConfidence;
      evidence: string;
    }
  | {
      kind: "testid" | "css" | "xpath" | "text" | "label";
      expression: string;
      matchCount?: number;
      unique?: boolean;
      confidence: EvidenceConfidence;
      evidence: string;
    }
  | {
      kind: "dom-cua";
      nodeId: string;
      observationId: string;
      confidence: EvidenceConfidence;
      evidence: string;
    }
  | {
      kind: "coordinate";
      x: number;
      y: number;
      annotationId?: string;
      visualRevision?: string;
      annotationRevision?: string;
      confidence: EvidenceConfidence;
      evidence: string;
    };
```

Do not collapse this to one selector. A graph node should expose alternatives and confidence.

Confidence is ordinal and route-local. It must not be treated as a globally comparable floating-point score across locator, DOM-CUA, and coordinate routes. Resolver ranking is defined separately in Section 8.3.

### 7.4 Frames, action hints, and diagnostics

```ts
export type AffordanceFrame = {
  ordinal: number;
  frameId?: string;
  parentOrdinal?: number;
  hostNodeId?: string;
  url?: string;
  title?: string;
  sameOrigin?: boolean;
  degraded?: boolean;
  degradationReason?: string;
};

export type AffordanceActionHint =
  | "click"
  | "fill"
  | "type"
  | "press"
  | "select"
  | "hover"
  | "scroll"
  | "drag"
  | "download"
  | "inspect";

export type AffordanceGraphDiagnostics = {
  advisories: string[];
  sourceErrors: Record<string, string>;
  sourceStatus: Record<
    "a11y" | "dom-index" | "dom-cua" | "snapshot-text" | "visual" | "frame-merge",
    "present" | "partial" | "unsupported" | "failed" | "omitted"
  >;
  degradedFrames: AffordanceFrame[];
  locatorAmbiguities: Array<{
    nodeId: string;
    locatorKind: AffordanceLocatorRecipe["kind"];
    matchCount?: number;
    detail: string;
  }>;
};
```

### 7.5 Edges

```ts
export type AffordanceEdge =
  | { kind: "parent-child"; from: string; to: string }
  | { kind: "label-for"; from: string; to: string }
  | { kind: "controls"; from: string; to: string }
  | { kind: "owns"; from: string; to: string }
  | { kind: "described-by"; from: string; to: string }
  | { kind: "frame-hosts"; from: string; toFrameOrdinal: number }
  | { kind: "near"; from: string; to: string; distance?: number };
```

V1 can implement only `parent-child` and `frame-hosts`. The rest are future-compatible.

### 7.6 Blocker signals

```ts
export type BlockerSignal = {
  kind:
    | "consent"
    | "login_wall"
    | "captcha"
    | "paywall"
    | "geo_gate"
    | "modal_overlay"
    | "browser_error_page"
    | "download_or_filechooser"
    | "unknown_blocker";
  confidence: EvidenceConfidence;
  nodeIds?: string[];
  evidence: string[];
  recommendedAgentAction?: string;
};
```

Blocker detection is diagnostic only. The agent decides what to do.

## 8. Capture Pipeline

### 8.1 V1: SDK read-only graph preview

Use existing OBU surfaces:

- `snapshotText()` for locator recipes and coarse interactables.
- `dom_cua.get_visible_dom({ format: "json" | "compact_text" })` for visible nodes, geometry, and observation-bound DOM-CUA `node_id`s when an observation id is available.
- `domSnapshot()` for semantic ARIA outline.
- `screenshot` / visual annotations when requested.

V1 does not require a new host method, but it is explicitly a preview layer. It must not claim the full Stagehand-style semantic-node-to-executable-target invariant because current `domSnapshot()` strips Playwright ARIA refs and cannot map ARIA lines back to backend nodes. V1 graph metadata must therefore set:

```ts
meta.executableBridge = "none" | "partial";
```

V1 validates only:

- Does graph outline improve LLM navigation decisions?
- Does combining existing evidence reduce weak-selector guessing in prompts?
- Does blocker evidence help without automatic behavior?
- Are token and latency budgets acceptable?

V1 must label nodes by source:

- `snapshot-text:*` for flattened interactables from `snapshotText`.
- `dom-cua:*` for visible DOM-CUA nodes.
- `aria-line:*` for read-only semantic outline rows from `domSnapshot`.

Only `dom-cua:*` nodes can carry DOM-CUA action-bound recipes, and only when bound to a current observation id. `aria-line:*` nodes are read-only evidence until Phase 2.

### 8.2 V2: minimal host hybrid snapshot method

Add a lower-level host method:

```text
TAB_HYBRID_SNAPSHOT
```

The method should capture:

- CDP Accessibility tree per frame.
- DOM tree per CDP session with adaptive depth fallback.
- Backend-node id mapping.
- Tag/type/scrollable metadata.
- XPath and frame-prefix maps.
- Encoded ids (`f{ordinal}-be{backendNodeId}` or similar).
- Per-frame outlines and a merged global outline.
- URL map from AX node URL properties.

This is the Stagehand-inspired substrate. It should live in the host so SDK and agents get one canonical environment model. The public SDK-level `tab.affordanceGraph()` composes this substrate with DOM-CUA, screenshot, lifecycle, and diagnostics.

V2 is the first phase allowed to set:

```ts
meta.executableBridge = "complete";
```

for nodes whose encoded id has a validated DOM-index mapping and at least one executable locator recipe.

### 8.2.1 Backend capability contract

The hybrid method must be capability-aware. It must not silently become CDP-only.

| Source | Purpose | If present | If partial/unsupported |
|---|---|---|---|
| `a11y` | LLM semantic tree | emit AX-derived nodes and outline | fall back to `snapshotText`/`domSnapshot` evidence; mark semantic confidence `low` or `unknown` |
| `dom-index` | encoded id -> executable DOM location | emit backend-node map, XPath/frame data, tag/type metadata | graph is read-only for affected semantic nodes; `executableBridge` is `none` or `partial` |
| `frame-merge` | cross-iframe global context | prefix child-frame paths and attach child outlines under iframe host nodes | mark `degradedFrames`; do not invent parent-child edges |
| `dom-cua` | viewport geometry and observation-scoped action ids | attach visible geometry and DOM-CUA recipes | omit DOM-CUA recipes; keep semantic graph usable |
| `visual` | screenshot/annotation fallback | attach coordinate recipes only with visual revisions | omit coordinate recipes; no visual freshness gate |

Every source reports `present`, `partial`, `unsupported`, `failed`, or `omitted` through `diagnostics.sourceStatus`. Partial output is preferred over failing the entire observation.

### 8.3 V3: graph-aware action resolver

After graph quality is validated, add `source: "affordance"` targets. Resolver order:

1. Prefer route-local `high` confidence recipes with uniqueness evidence, in this order: `testid`, `role`, `label`, `text`, `css`.
2. Prefer DOM-CUA when the node is visible, observation-scoped, and the action is pointer/typing compatible.
3. Prefer frame-scoped locator over global XPath when both exist.
4. Use XPath only as a fallback, and only when its encoded-id mapping is current.
5. Use coordinate fallback only when visual/annotation revisions match and no semantic locator route is reliable.

Confidence is advisory inside each route. Resolver order is not a numeric max across all routes.

### 8.4 V4: graph-aware self-heal

On action failure:

```text
failed action
-> scoped re-observe around previous node/context
-> semantic fingerprint match (role/name/frame/nearby labels)
-> re-rank locator recipes
-> retry only when confidence is high enough
-> otherwise return diagnostic for LLM
```

This borrows Stagehand's self-heal idea but keeps OBU's lifecycle and confidence model.

## 9. Lifecycle And State-Machine Integration

Affordance Graph must ride inside the existing `ObserveRequestState` lifecycle:

```text
requested
-> preflight
-> reading_backend
-> composing_snapshot
-> succeeded | partial | blocked | failed | cancelled
```

No new top-level observe states are required for V1. Graph capture is a section:

- `sections.affordanceGraph = present` when graph builds successfully.
- `failed` when graph capture fails but observation can still return other sections.
- `blocked` only when the requested graph mode cannot produce any usable graph because required backend capability is unsupported.
- `omitted` when not requested.

Freshness:

- Add dependency-specific graph revisions to `ObservationLifecycle`.
- `affordanceSemanticRevision` hashes semantic node ids, roles, names, frame ownership, and graph topology.
- `affordanceLocatorRevision` hashes executable locator recipes and encoded-id mappings.
- `affordanceGeometryRevision` hashes DOM-CUA geometry and observation-scoped visible-node membership when included.
- `affordanceDiagnosticsRevision` hashes blocker signals and degraded-source diagnostics, but it must not gate action execution.
- Action targets using graph nodes must validate only the revisions relevant to the selected route:
  - semantic locator route: semantic + locator.
  - DOM-CUA route: semantic + geometry + DOM-CUA revision.
  - coordinate route: semantic + geometry + visual/annotation revisions.
- Graph observations are non-durable, like other observation ids. A resumed task must re-observe.

Invalidation:

- Consuming a graph-bound action invalidates that observation id.
- Route/URL/frame tree/viewport/modal changes should mark relevant graph targets stale through existing freshness checks.

Diagnostics:

- Preserve section failures rather than throwing away the whole observation.
- Report degraded graph sources: missing AX tree, missing DOM index, failed child frame, truncated graph, unsupported DOM-CUA, screenshot unavailable.

## 10. LLM-Facing Representation

The LLM should receive a compact outline plus selected node evidence, not a giant raw JSON blob by default.

Example outline:

```text
[f0-be101] document
  [f0-be122] navigation
    [f0-be130] link "Flights"
    [f0-be131] link "Hotels"
  [f0-be210] dialog "Cookie preferences" [blocker: consent]
    [f0-be215] button "Accept all"
    [f0-be216] button "Reject all"
  [f0-be300] form "Search"
    [f0-be301] textbox "Destination"
    [f0-be302] button "Search"
```

The JSON graph remains available for tool consumers, but the model prompt should prefer outline + compact node rows.

Important: the outline should not hide raw alternatives. If the agent needs full DOM, screenshot, or evaluate, those remain available.

## 11. Business-Logic Interpretation

Affordance Graph is an environment observation, not an agent policy.

From a reinforcement-learning perspective:

- The environment exposes richer state.
- The action space remains broad.
- State-machine/lifecycle checks improve reliability but should not become tactical burdens.
- The agent still chooses attention, scope, and actions.

Bad design:

```text
The environment provides only preselected action candidates.
The agent must choose one of them.
The state machine rejects anything outside that projection.
```

Good design:

```text
The environment provides a semantic graph with evidence and revisions.
The agent may use graph nodes, locators, DOM-CUA, screenshots, evaluate, or re-observe.
The state machine only enforces freshness, ownership, and safety invariants.
```

## 12. Testing Strategy

### Unit tests

- AX node decoration: role/name/state/tag corrections.
- DOM index: backendNodeId -> XPath/tag/frame map.
- Frame merge: iframe host nodes inject child frame outlines.
- Scoped graph: `scope` narrows output and falls back cleanly.
- Ignore selectors: excluded subtrees do not appear in graph or locator maps.
- Locator recipes: uniqueness/confidence/ambiguity are correct.
- Blocker signals: consent/login/captcha/paywall examples produce diagnostic evidence only.
- Revision hashing: semantic, locator, geometry, visual, and diagnostic revisions change only when their own dependency changes.
- V1 preview graph: `aria-line:*` nodes are read-only and never expose action-bound recipes.
- Capability matrix: unsupported/partial sources produce `diagnostics.sourceStatus` and preserve partial output.

### Integration tests

- `tab.observe({ includeAffordanceGraph: true })` returns graph while preserving existing text/domCua/screenshot sections.
- Partial failure of graph source does not fail whole observation when other sections are usable.
- DOM-CUA graph locators require current observation id.
- Graph action target, once added, validates freshness before execution.
- OOPIF/frame cases preserve frame ownership and executable routing.
- Direct `tab.affordanceGraph()` returns a graph observation envelope with lifecycle and section status.

### Live validation workflows

Use a diverse validation set:

- Consent modal.
- Login wall.
- Search form.
- Product card add-to-cart.
- Date picker.
- Dropdown/select.
- iframe embedded flow.
- Shadow DOM button.
- Infinite-scroll/list page.
- Geo or region consent page.
- Browser error page.
- Paywall-like page.
- CAPTCHA-like page, expecting diagnostic/handoff, not bypass.

Success criteria:

- LLM can identify relevant controls from graph outline without weak selector guessing.
- Agent can choose alternate tools when graph is insufficient.
- Graph diagnostics explain degraded observations.
- No regression in existing `snapshotText`, `domSnapshot`, `dom_cua`, or visual observe behavior.

## 13. Rollout Plan

### Phase 1: Spec and data model

- Add TypeScript types.
- Add `includeAffordanceGraph` option and section status.
- Implement SDK-only read-only graph preview from existing surfaces.
- Add tests for graph shape, source labels, section behavior, preview/read-only invariants, and revision stability.

### Phase 2: Minimal Stagehand-style hybrid substrate

- Add host-level `TAB_HYBRID_SNAPSHOT` method.
- Capture AX tree + DOM index + frame merge.
- Add explicit `f{ordinal}-be{backendNodeId}` encoded ids and XPath/frame maps.
- Add scoped and ignored-selector support.
- Add backend capability diagnostics and partial-output behavior.
- Add deep DOM fallback tests similar to Stagehand's CBOR-depth coverage.

### Phase 3: Agent-facing prompt/playbook update

- Teach the agent to prefer Affordance Graph for semantic orientation.
- Keep explicit fallback guidance: DOM-CUA, screenshot, domSnapshot, evaluate, locator, coordinate, re-observe.
- Add examples for consent/login/iframe/shadow DOM.

### Phase 4: Graph action target

- Add `source: "affordance"` targets.
- Add resolver and confidence ranking.
- Add freshness enforcement through route-specific graph revisions.

### Phase 5: Self-heal and blocker diagnostics

- Add scoped re-observe and semantic fingerprint matching.
- Add blocker taxonomy evidence.
- Validate against the 14-site autoresearch workflow.

## 14. Risks And Mitigations

- **Token bloat:** graph outline must be compact; full JSON remains optional.
- **Latency:** start opt-in; measure capture time; cache per observation only.
- **Over-cleaning:** keep raw fallback surfaces and evidence fields.
- **XPath fragility:** XPath is fallback, not the only recipe.
- **AX tree gaps:** combine with DOM-CUA, screenshot, and evaluate.
- **Frame routing complexity:** reuse OBU backend routing and learn from Stagehand frame prefixing.
- **State-machine burden:** keep graph as an observation section, not a separate operational protocol.
- **Website-specific overfitting:** blocker taxonomy uses evidence and confidence, not site rules.

## 15. Decisions

1. V1 is opt-in only through `includeAffordanceGraph` or direct `tab.affordanceGraph()`.
2. The host substrate method is named `TAB_HYBRID_SNAPSHOT`; the public SDK graph method remains `tab.affordanceGraph()`.
3. Encoded ids use the explicit form `f{ordinal}-be{backendNodeId}`.
4. Blocker detection starts in SDK as diagnostic evidence only; host-level blocker evidence can be added later if it improves source quality.
5. Default graph cap is `maxNodes: 120`, with honest `shown`, `total`, `truncated`, and diagnostics. The cap affects graph output only, not the availability of full `domSnapshot()`, screenshot, evaluate, or scoped re-observe.

## 16. Recommended Decision

Proceed with Phase 1 as a low-risk read-only preview layer:

- Add `includeAffordanceGraph`.
- Compose a preview graph from existing OBU surfaces.
- Mark executable bridge as `none` or `partial`.
- Preserve current behavior by default.
- Measure whether graph improves LLM orientation, blocker diagnosis, and tool choice on complex workflows.

Then implement Phase 2 before claiming robust executable graph behavior or adding `source: "affordance"` actions. Phase 1 can validate prompt usefulness; Phase 2 is required to validate the hybrid semantic-id-to-executable-target invariant.

This keeps the work aligned with the principle: LLM-first, evidence-rich observation, broad action freedom, and lifecycle-aware execution.
