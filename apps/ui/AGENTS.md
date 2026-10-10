# Happier UI Instructions

Package-specific instructions for `apps/ui`. These supplement the root constitution and override broader guidance where more specific.

## Product design and experience

- Read `../../DESIGN.md` in full before creating or changing user-facing UI, UX, copy, motion, onboarding, responsive composition, accessibility behavior, or meaningful loading/empty/error/recovery states when the work can materially affect the experience, and before a substantive design review. Purely mechanical changes and small non-material experience edits do not need the full document unless a design decision arises. It is the canonical definition of Happier as a **Warm and Fluid Companion** and of the experience quality expected across mobile, web, and desktop.
- Load `.agents/skills/happier-ui-craft` before designing, building, or reviewing a surface. It holds the working method and taste rules (hierarchy, anatomy, control choice, copy, stability, side-by-side validation) that apply `DESIGN.md`.
- The design doctrine does not authorize unrelated redesigns or scope expansion. Inspect and reuse canonical components, tokens, motion primitives, copy patterns, and state/navigation owners before adding or changing a pattern.
- External design skills are optional accelerators, never prerequisites or alternate sources of product doctrine. When relevant and available, use `apple-design`, `interface-details`, `make-interfaces-feel-better`, `emil-design-eng`, and `review-animations` as focused aids. A contributor without those skills must still have the complete Happier quality bar through `DESIGN.md`, these package instructions, and canonical code.
- Landing-page or fixed-art-direction skills such as `frontend-design`, `design-taste-frontend`, `high-end-visual-design`, `minimalist-ui`, and `gpt-taste` may inform a bounded signature or web-storytelling surface when relevant. Do not apply their mandatory fonts, colors, frameworks, layout recipes, motion machinery, or universal aesthetic rules to routine product UI. Happier's `DESIGN.md`, canonical primitives, accessibility requirements, platform contracts, and measured evidence override every generic prescription or magic value from a skill.

## Commands and validation

Use yarn:

- `yarn start` — Expo development server.
- `yarn ios` / `yarn android` / `yarn web` — platform targets.
- `yarn typecheck` — required after TypeScript changes.
- `yarn test` — Vitest tests.
- `yarn tauri:dev` / `yarn tauri:build:*` — desktop flows.

Use the smallest relevant test slice while iterating, then run the UI typecheck/build-enforcing and broader relevant lanes before handoff.

## Structure and ownership

- Expo Router routes live in `sources/app/**` and remain thin screen entrypoints; extract non-trivial UI/logic into domain-owned components, hooks, sync modules, or utilities.
- Keep `components/`, `hooks/`, `utils/`, and `sync/` roots thin and prefer real domain subfolders.
- Preserve `@/...` aliases and update every import/export during moves; do not leave compatibility wrappers by default.
- Buckets are lowercase; feature folders may follow the established camelCase convention. Avoid `_folders` outside Expo Router and `__tests__` conventions.
- Session UI belongs under `components/sessions/**`, not a competing singular folder.

## Sync boundaries

- `sources/sync/sync.ts` is the public sync orchestrator/wiring entrypoint.
- `sync/api/**` owns request/response adapters and protocol mapping.
- `sync/runtime/**` owns small cross-cutting runtime helpers.
- `sync/encryption/**` owns encryption/decryption/sealing/share-key helpers.
- `sync/engine/**` owns effectful orchestration.
- `sync/store/**` owns state domains, selectors, normalization, and persistence-facing state.
- `sync/domains/**` owns domain behavior and must not depend on `sync/store/**`.
- `sync/ops/**` owns orchestration-facing operations.
- `sync/domains/plugins/availability/generatedBundledPluginUiArtifacts.js` is an ignored app-preseed runtime output. Its single producer/check is `scripts/generateBundledPluginUiArtifacts.mjs`, invoked after workspace/plugin publication by `ensure:workspace:built`; it projects exact digest-addressed assets from each plugin package's canonical `dist/happier-plugin-ui/ui-artifacts.json`. The committed sibling `.d.ts` owns its TypeScript shape, so source typechecks do not publish runtime artifacts. Change the UI generator or declaration, never the output. Platform-specific `.web`/`.ios`/`.android` inventories are retired and must stay absent. The CLI generator owns semantic/catalog/daemon projections and never this byte graph.
- In 0.3 development source, explicit web artifact construction and source QA web export share `apps/stack/scripts/build/build_source_web_ui.mjs#prepareSourceWebUi`. It reuses the inventory producer via `scripts/prepareSourcePluginUiArtifacts.mjs`, compiling current authored manifests and UI entrypoints with the SDK's canonical compiler and explicit source resolution into private inputs. This preparation does not publish workspace dist or overwrite a live Expo inventory. Stack supplies the private inventory through `HAPPIER_UI_PLUGIN_ARTIFACT_INVENTORY` to the existing Metro resolver; Expo retains browser/asset export and the web artifact owner retains final publication. Metro resolves explicit authored workspace exports, preferring nested `browser`/`react-native` source targets before portable `happier-source` targets; do not infer source paths from dist or replace platform branches with a generic source override. Explicit rebuild/reload selects new web bytes. Ordinary Expo and public package builds keep their existing preparation inputs.

## Agent and Provider composition

- Agent UI contributions belong in `packages/plugins/<agentId>/src/ui/**` and project through generated host composition in `sources/agents/catalog/**` and `sources/agents/registry/**`.
- Do not recreate the retired `sources/agents/providers/**` host tree.
- Model Provider UI composition belongs in `sources/providers/**` and consumes first-class Provider contracts from protocol/plugin contributions.
- Generic screens, components, and sync code must not branch on Agent or Provider ids when a typed contribution, catalog hook, registry result, or provider-binding adapter can own the variation.

Details: [Agent catalog](../../docs/agents-catalog.md), [Providers](../../docs/providers.md), and [plugin platform/SDK ownership](../../docs/plugin-platform.md).

## Theme, typography, and i18n

- Use Unistyles theme tokens; do not hardcode colors or raw hex/rgb values.
- A bounded art-directed experience may define a named, theme-aware palette in one domain-owned token module when global semantic theme roles are genuinely insufficient. Feature components consume those named tokens rather than scattering raw values; document the boundary and light/dark/accessibility behavior, and do not turn it into a competing global design system.
- Icons use themed colors, tints, and backgrounds.
- Use app `Text`/`TextInput` primitives so in-app font scaling works; avoid new hardcoded font sizes.
- All user-visible strings, accessibility labels, and placeholders use `t(...)` and are added to every locale under `sources/text/translations/`.
- Inspect existing translation keys first and reuse common keys when appropriate.

## UI primitives and interaction

- Never use React Native `Alert`; use `@/modal`.
- Use the app `Popover` + `FloatingOverlay` systems for menus, tooltips, and context menus.
- Preserve existing modal/popover portal behavior and canonical web-dialog entrypoints.
- Apply layout width constraints from `@/components/layout` to full-screen scroll/content containers.
- Keep existing-object settings lists separate from creation/attachment actions.
- Worktrees remain usable without first creating a workspace.

## Configuration surfaces

Doctrine: `../../DESIGN.md` → "Configuration surfaces". Shared ownership: [Collection presentation](../../docs/collection-presentation.md) and [surface states](../../docs/surface-states.md). Binding implementation:

- **Page:** a full configuration/detail page is an `ItemList` (page presentation by default) that starts with a
  `PageHeader` (settings routes: `SettingsPageHeader`, titled from `settingsRouteRegistry`).
  `ItemGroup` and `Item` below it take the page anatomy automatically; menus and popovers reset to
  the grouped look in `FloatingOverlay`. Do not hand-build section headers, row dividers, sheets or
  dropdown triggers.
- **Sections:** use `ItemGroup` `title` + `description` (+ `action`), not `footer`, on pages.
- **Rows:** `Item` with one right-side control. Set `accessoryLayout="adaptive"` for segmented
  controls and field selects, and `"stacked"` for visual pickers and text areas. Preference rows pass
  no `icon`; identity marks (agent, provider, service, machine, avatar) stay.
- **Visual pickers:** `SelectionTiles variant="visual"` with `preview` elements that render the real
  component at static props (no subscriptions, no RPCs).
- **Collections:** `ListDetailLayout` (rail + detail, push when narrow) for deep entities;
  `ExpandableItem` rows for shallow ones. Selection comes from the route.
- **Machine context:** `MachineAdministrationTargetSelector presentation="chip"` in the page header
  actions. Keep it rendered through loading and error states.
- **Search:** declare every rendered setting in the page's `defineSettingsPage` module, register it in
  `settingsPageDeclarations.ts`, and render rows through `SettingRow`/`SettingAnchor` so the label and
  anchor come from the declaration.

## Performance and continuity

- Preserve last-known-good UI during refresh; do not flash empty/loading states for hydrated lists, transcripts, detail panels, or cached snapshots.
- Status UI must be truthful. Spinners, progress states, disabled actions, activity labels, and completion indicators derive from the canonical lifecycle owner and stop or transition on success, failure, cancellation, disconnect, and recovery. Do not maintain a second UI-only interpretation of whether work is active.
- Do not use indefinite JavaScript-, layout-, or continuously repainting decorative animations. Long-running status motion must be compositor/worklet-safe where applicable, pause while hidden, backgrounded, or offscreen, honor reduced motion, and be measured when its frame, CPU, GPU, or battery cost can be material.
- Preserve referential stability for unchanged rows, items, maps, and arrays; patch the smallest affected state. Reconcile incoming state — a server echo, a refetch, a settings sync — against the current value and reuse the previous reference for structurally equal parts; replacing a container wholesale re-renders every consumer of every field it holds even when nothing changed. Zustand no-op updaters return the previous state itself: an empty partial still creates a root state and notifies subscribers. Exercise notification suppression with the real store, since a merge-only test harness cannot prove that contract.
- Avoid rebuilding expensive derived state unless structural inputs changed, and build variant-specific props, options, and derived data inside the branch that consumes them; a builder that runs on every render and is then discarded by the other variant is pure waste.
- Always-mounted navigation chrome, badges, tabs, and closed popovers consume only their canonical stable summary projection (for example a count, attention bit, or lifecycle state). Mount detailed record subscriptions, joins, sorting, labels, row models, and action callbacks inside the module-scope leaf that is actually open, focused, or otherwise data-active; hiding its rendered output is insufficient while its hooks remain mounted. The summary and detail paths must delegate classification to the same domain owner so deferring detail work does not create a second policy. Prove both sides: unrelated updates retain the closed summary identity without mounting detail work, while opening or focusing the surface produces current details and preserves continuity when it closes or blurs.
- Unopened composer controls and pickers do not issue machine RPCs, decrypt records, or build detail projections. Expose one descriptor-level intent/open signal and route every visible-chip, keyboard/focus, hover, and collapsed-overflow entry point through it; the same detail owner may then preserve last-known state and refresh while demanded. Do not add a second load path for overflow or a mount-time fallback for devices without hover.
- Keep subscriptions/selectors as narrow as the ownership model permits and verify render scope/counts when a change can fan out. Passing a whole store object or snapshot down into child hooks or components re-couples everything the selector just narrowed — pass the fields, or subscribe in the leaf that uses them. Do not apply blanket `memo`, `useMemo`, `useCallback`, or caches without a demonstrated benefit and correct invalidation. Returning the same selected result can prevent a render while still recomputing on every store notification; measure computation as well as renders, and reuse unchanged projected inputs through the existing owner with its freshness and lifecycle invalidation.
- A virtualized list that keeps `renderItem` stable through refs must project every global non-item input that changes row behavior through its existing `extraData` owner. Parent props and updated callbacks do not by themselves update mounted or recycled cells. Keep high-frequency row-local state in a row-local subscription owner instead of using `extraData` to invalidate every mounted row. For active/inactive surfaces, prove the transition reaches the mounted row boundary and removes row-local subscriptions; checking only the list wrapper is insufficient.
- Put high-frequency state — composer text, scroll offset, pointer position, elapsed time — in an external store subscribed by the leaf that renders it. Held in `useState` inside a screen-level hook or model, it re-runs every hook and every consumer of that model on each keystroke or frame.
- A value that will land in a dependency array must be identity-stable at the caller; an inline arrow, object, or array literal passed down re-triggers every effect, memo, and subscription it reaches. A value read only after commit belongs in a ref, not in the dependency array.
- Mount effects do not write persisted or synced state. A write on mount round-trips through the server echo and buys a second render wave on every mount; persist on real user intent instead.
- Collect ids and call the batched owner once; a request issued per row, per item, or per effect run is an N+1 even when each call is cheap, and it is the batching owner's contract that must change, not the call site's loop. Any read-then-await-then-write path needs in-flight sharing so concurrent runs collapse onto one request instead of racing and each writing back a snapshot taken before the others landed.
- Internal queue and admission bounds must protect a named measured resource or external/platform contract. Do not reject ordinary concurrent bulk work merely because an implementation-owned queue reaches an arbitrary multiple of its batch size, and never turn queue pressure into a bulk native-to-JavaScript fallback that moves CPU work onto the UI runtime. Serialize or coalesce at the canonical owner, preserve cancellation, and keep any required timeout observable.
- Memory investigations distinguish cumulative allocation/GC traffic from live heap and native footprint. Use comparable warmed workloads and release/idle windows, then inspect strong retaining paths before claiming a leak or savings. For unexplained growth after a controlled repeat, identify surviving allocations and their lifetime owner instead of widening navigation and collecting another total. A weak-key cache is not proof of collectability when its values are opaque native handles: native code may strongly root the key. Use held-handle and dropped-handle controls across collections to establish that lifetime before changing application callbacks or retention policy. Object counts and shortest root paths are not dominator-retained sizes; account for weak-key/ephemeron semantics when interpreting a heap graph. Check diagnostic state first: repeated probe errors, heap snapshots, and long Fast Refresh sessions can contaminate the result. Disabled React profiling does not establish an empty DevTools baseline: inspect buffered operations/history and use its existing connection/flush lifecycle as a diagnostic control before attributing retention to the app. For native/external residuals, compare app-specific allocation generations and allocating stacks, then inspect native ownership or memory graphs; RSS alone cannot distinguish live allocations, leaked ownership, allocator reserve, and mapped memory. Temporary probes clear prior timers before replacing handles and stop callbacks before deleting their state; verify cleanup in the running app and respect the user’s restart authority when a clean baseline is needed. Match the debugger’s exact logical device and route to the simulator being driven and its native process; never select the first Metro target when several runtimes are connected. Native-code dependency patches require reconciling and rebuilding the existing native development project, then verifying launch/component registration; Fast Refresh does not load native changes. A JavaScript-only dependency patch instead needs an app JavaScript reload and a probe of the loaded patched behavior; it does not itself require a native rebuild. Record runtime reloads during captures; interrupted traces do not prove a continuous workload. If needed, pause auto-refresh through existing client development controls for the bounded measurement and restore the setting afterward.
- For transcript/session-list work, validate scroll anchoring, pagination, viewport restoration, virtualization, and large-session responsiveness.
- Treat the native first transcript viewport as bounded presentation work: reuse the existing native prepend/page-size owner when a smaller first page fills the viewport, while keeping catch-up and repair paging at their correctness-owned size. Do not create a second page-size policy in the screen or list.
- A changing component *type* remounts its whole subtree, discarding state, measurements, scroll position, and animations. So never pick between two types on state or a prop — vary the subscription, props, or callback inside one component instead. The same defect fires unconditionally when a component is *declared* in a render body or a `useMemo`, since every recompute mints a new type and re-fires its effects; with a periodically-changing dependency such as a clock tick, it remounts on a timer. Hoist components to module scope and pass what they closed over as props. Returning an element or a render callback from a memo is fine; returning a new component type is not. Native wrapper and scroll-view accessory topology counts too: conditionally adding or removing `RefreshControl` can change child position or wrapper type and remount retained rows. Keep the native element topology stable, gate its work and handlers through props, and verify focus cycles preserve row mounts and scroll position.
- Performance work must preserve accessibility, responsive layout, i18n, and platform behavior, with measured validation when feasible.
## React and React Native skill routing

- These tool-specific skills are accelerators, not universal dependencies. Use them when available; otherwise apply the same repository evidence and validation rules directly, and report an unavailable tool only when it leaves a decision-material gap.
- For React Native or Expo implementation/review, use the installed `vercel-react-native-skills` selectively and read only the rules relevant to the task. Happier's canonical primitives, owners, package instructions, and measured evidence override generic prescriptions about libraries, navigation, modals, styling, state, memoization, or folder structure.
- For component trees, props/state/hooks, render ownership, or suspected rerender churn, use `react-devtools` with bounded inspection. For explicit performance/optimization work, use `argent-react-native-optimization` and `argent-react-native-profiler`: capture a reproducible baseline, identify the measured bottleneck, make one evidence-backed optimization cycle, replay the same flow, and report whether performance improved, stayed flat, or regressed.
- For component API or composition refactors involving boolean-prop proliferation, variants, compound components, or shared context boundaries, use `vercel-composition-patterns`; the root durable-design evidence bar still decides whether an abstraction is justified.
- Apply all tool-specific skills under the root scope, delegation, process-ownership, and validation rules. Do not inherit a generic skill's mandatory fleet size, whole-app sweep, process restart, tool installation/upgrade, package-manager command, or architectural rewrite when it is not authorized or relevant here.

## Testing and live validation

- Prefer `@/dev/testkit` and helpers under `sources/dev/testkit/**`.
- Do not create inline mock families for boundaries already owned by the testkit, including `expo-router`, `@/text`, `@/modal`, `react-native`, `react-native-unistyles`, and storage.
- Exercise real UI/domain logic below those boundaries and assert observable behavior rather than copy, raw styles, implementation details, or incidental calls.
- Render and inspect incremental visual changes. For device QA, pin the loaded bundle with a full Metro reload, Fast Refresh off, and a module probe when bundle identity matters.
- Use `.agents/skills/happier-testing` for browser/device live gates and known memory-heavy suite guidance.
