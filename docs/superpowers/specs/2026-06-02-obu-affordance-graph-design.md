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
affordanceGraphRevision?: string;
```

V1 should keep the default off unless the agent explicitly requests it. After validation, `mode: "actionable"` may include the graph by default if token and latency budgets are acceptable.

### 6.2 Direct graph read

Add:

```ts
await tab.affordanceGraph({
  scope?: string;
  ignoreSelectors?: string[];
  includeIframes?: boolean;
  includeDomCua?: boolean;
  includeScreenshot?: boolean;
  maxNodes?: number;
  timeout?: number;
});
```

This direct method is useful when the agent wants a graph without the full `TabObservation` envelope. Internally it should still allocate or accept an observation id when graph nodes contain action-bound DOM-CUA targets.

### 6.3 Future graph action target

Defer until graph quality is validated:

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
    revision: string;
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
    semantic: number;
    locator: number;
    actionability: number;
  };
  diagnostics?: string[];
};
```

### 7.3 Locator recipes

```ts
export type AffordanceLocatorRecipe =
  | {
      kind: "role";
      expression: string;
      matchCount?: number;
      unique?: boolean;
      confidence: number;
      evidence: string;
    }
  | {
      kind: "testid" | "css" | "xpath" | "text" | "label";
      expression: string;
      matchCount?: number;
      unique?: boolean;
      confidence: number;
      evidence: string;
    }
  | {
      kind: "dom-cua";
      nodeId: string;
      observationId: string;
      confidence: number;
      evidence: string;
    }
  | {
      kind: "coordinate";
      x: number;
      y: number;
      annotationId?: string;
      visualRevision?: string;
      annotationRevision?: string;
      confidence: number;
      evidence: string;
    };
```

Do not collapse this to one selector. A graph node should expose alternatives and confidence.

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
  confidence: number;
  nodeIds?: string[];
  evidence: string[];
  recommendedAgentAction?: string;
};
```

Blocker detection is diagnostic only. The agent decides what to do.

## 8. Capture Pipeline

### 8.1 V1: SDK graph composer

Use existing OBU surfaces:

- `snapshotText()` for locator recipes and coarse interactables.
- `dom_cua.get_visible_dom({ format: "json" | "compact_text" })` for visible nodes, geometry, and action-bound `node_id`s.
- `domSnapshot()` for semantic ARIA outline.
- `screenshot` / visual annotations when requested.

V1 does not require a new host method. It creates a graph good enough to validate:

- Does graph outline improve LLM navigation decisions?
- Does node evidence reduce weak-selector failure?
- Does blocker evidence help without automatic behavior?
- Are token and latency budgets acceptable?

Known V1 limitation: `domSnapshot()` currently strips Playwright ARIA refs, so it does not provide stable node ids by itself. V1 can still expose it as semantic outline evidence, while node ids come mostly from DOM-CUA and snapshotText locator recipes.

### 8.2 V2: host hybrid snapshot method

Add a host method, tentatively:

```text
TAB_AFFORDANCE_GRAPH
```

or split lower-level:

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

This is the Stagehand-inspired substrate. It should live in the host so SDK and agents get one canonical environment model.

### 8.3 V3: graph-aware action resolver

After graph quality is validated, add `source: "affordance"` targets. Resolver order:

1. Highest-confidence unique role/testid/label locator.
2. DOM-CUA target when visible and observation-scoped.
3. Frame-scoped locator.
4. XPath fallback.
5. Coordinate fallback only when visual/annotation revisions match.

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
- `blocked` when backend capability is unsupported.
- `omitted` when not requested.

Freshness:

- Add `affordanceGraphRevision` to `ObservationLifecycle`.
- Revision should hash semantic node ids, locator recipes, frame ids, blocker signals, and relevant DOM-CUA revision when included.
- Action targets using graph nodes must validate the graph revision before acting.
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
- Revision hashing: stable graph yields stable revision; meaningful changes alter it.

### Integration tests

- `tab.observe({ includeAffordanceGraph: true })` returns graph while preserving existing text/domCua/screenshot sections.
- Partial failure of graph source does not fail whole observation when other sections are usable.
- DOM-CUA graph locators require current observation id.
- Graph action target, once added, validates freshness before execution.
- OOPIF/frame cases preserve frame ownership and executable routing.

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
- Implement SDK-only graph composer from existing surfaces.
- Add tests for graph shape, section behavior, and revision stability.

### Phase 2: Stagehand-style hybrid substrate

- Add host-level hybrid snapshot method.
- Capture AX tree + DOM index + frame merge.
- Add encoded ids and XPath/frame maps.
- Add scoped and ignored-selector support.
- Add deep DOM fallback tests similar to Stagehand's CBOR-depth coverage.

### Phase 3: Agent-facing prompt/playbook update

- Teach the agent to prefer Affordance Graph for semantic orientation.
- Keep explicit fallback guidance: DOM-CUA, screenshot, domSnapshot, evaluate, locator, coordinate, re-observe.
- Add examples for consent/login/iframe/shadow DOM.

### Phase 4: Graph action target

- Add `source: "affordance"` targets.
- Add resolver and confidence ranking.
- Add freshness enforcement through `affordanceGraphRevision`.

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

## 15. Open Questions For Review

1. Should V1 expose `affordanceGraph` by default in `mode: "actionable"`, or only behind `includeAffordanceGraph` until validation?
2. Should the host method be named `tab_affordance_graph` or lower-level `tab_hybrid_snapshot`?
3. Should encoded ids use Stagehand-like `0-123` or more explicit `f0-be123`?
4. Should blocker detection live in SDK composer first, or host once the hybrid substrate exists?
5. What should the max default graph size be before truncation advisories appear?

## 16. Recommended Decision

Proceed with Phase 1 as a low-risk validation layer:

- Add `includeAffordanceGraph`.
- Compose graph from existing OBU surfaces.
- Preserve current behavior by default.
- Measure whether graph improves LLM navigation/operation on complex workflows.

Then implement Phase 2 only after Phase 1 demonstrates that the graph representation improves output robustness.

This keeps the work aligned with the principle: LLM-first, evidence-rich observation, broad action freedom, and lifecycle-aware execution.
