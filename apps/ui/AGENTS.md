# Happier UI Instructions

Package-specific instructions for `apps/ui`. These supplement the root constitution and override broader guidance where more specific.

## Product design and experience

- Read `../../DESIGN.md` in full before creating or changing user-facing UI, UX, copy, motion, onboarding, responsive composition, accessibility behavior, or meaningful loading/empty/error/recovery states when the work can materially affect the experience, and before a substantive design review. Purely mechanical changes and small non-material experience edits do not need the full document unless a design decision arises. It is the canonical definition of Happier as a **Warm and Fluid Companion** and of the experience quality expected across mobile, web, and desktop.
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

## Provider registry

- Generic UI, screens, and sync code consume provider behavior through `sources/agents/catalog/**`, `sources/agents/registry/**`, and shared abstractions.
- Provider-owned UI behavior belongs under `sources/agents/providers/<provider>/**`.
- Do not branch on provider ids in generic screens/components/sync code when the catalog or registry can expose the behavior.
- Extend the canonical entry shape and implement variation in the provider-owned module.

Details: `../../docs/agents-catalog.md`.

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

## Performance and continuity

- Preserve last-known-good UI during refresh; do not flash empty/loading states for hydrated lists, transcripts, detail panels, or cached snapshots.
- Status UI must be truthful. Spinners, progress states, disabled actions, activity labels, and completion indicators derive from the canonical lifecycle owner and stop or transition on success, failure, cancellation, disconnect, and recovery. Do not maintain a second UI-only interpretation of whether work is active. A retry that ends the way the last attempt ended publishes nothing new: an already-unreachable target stays presented as unreachable across its retry attempts instead of cycling through loading and error.
- Do not use indefinite JavaScript-, layout-, or continuously repainting decorative animations. Long-running status motion must be compositor/worklet-safe where applicable, pause while hidden, backgrounded, or offscreen, honor reduced motion, and be measured when its frame, CPU, GPU, or battery cost can be material.
- Preserve referential stability for unchanged rows, items, maps, and arrays; patch the smallest affected state. Reconcile incoming state — a server echo, a refetch, a settings sync — against the current value and reuse the previous reference for structurally equal parts; replacing a container wholesale re-renders every consumer of every field it holds even when nothing changed. Reuse is per field and per entry, not all-or-nothing: when one fact changes, every other fact, map entry, and array keeps its previous identity. A builder that returns the previous object only when everything is equal and otherwise rebuilds everything re-keys every consumer on each partial change. Zustand no-op updaters return the previous state itself: an empty partial still creates a root state and notifies subscribers. Exercise notification suppression with the real store, since a merge-only test harness cannot prove that contract.
- A clock is not a fact. Equality checks, cache and memo keys, change or observation tokens, and published derived state exclude timestamps, cursors, revisions stamped on every read, presence ticks, and attempt counters unless that exact value is what the consumer renders. One included clock makes every consumer of the whole structure change on every tick (live examples: machine `activeAt` in a header cache key, an Account-wide cursor stamped into each plugin's availability observation, a refresh clock publishing an Account change).
- Avoid rebuilding expensive derived state unless structural inputs changed, and build variant-specific props, options, and derived data inside the branch that consumes them; a builder that runs on every render and is then discarded by the other variant is pure waste.
- Always-mounted navigation chrome, badges, tabs, and closed popovers consume only their canonical stable summary projection (for example a count, attention bit, or lifecycle state). Mount detailed record subscriptions, joins, sorting, labels, row models, and action callbacks inside the module-scope leaf that is actually open, focused, or otherwise data-active; hiding its rendered output is insufficient while its hooks remain mounted. The summary and detail paths must delegate classification to the same domain owner so deferring detail work does not create a second policy. Prove both sides: unrelated updates retain the closed summary identity without mounting detail work, while opening or focusing the surface produces current details and preserves continuity when it closes or blurs.
- Unopened composer controls and pickers do not issue machine RPCs, decrypt records, or build detail projections. Expose one descriptor-level intent/open signal and route every visible-chip, keyboard/focus, hover, and collapsed-overflow entry point through it; the same detail owner may then preserve last-known state and refresh while demanded. Do not add a second load path for overflow or a mount-time fallback for devices without hover.
- Keep subscriptions/selectors as narrow as the ownership model permits and verify render scope/counts when a change can fan out. Passing a whole store object or snapshot down into child hooks or components re-couples everything the selector just narrowed — pass the fields, or subscribe in the leaf that uses them. Returning the same selected result can prevent a render while still recomputing on every store notification; measure computation as well as renders, and reuse unchanged projected inputs through the existing owner with its freshness and lifecycle invalidation.
- A virtualized list that keeps `renderItem` stable through refs must project every global non-item input that changes row behavior through its existing `extraData` owner. Parent props and updated callbacks do not by themselves update mounted or recycled cells. Keep high-frequency row-local state in a row-local subscription owner instead of using `extraData` to invalidate every mounted row. For active/inactive surfaces, prove the transition reaches the mounted row boundary and removes row-local subscriptions; checking only the list wrapper is insufficient.
- Put high-frequency state — composer text, scroll offset, pointer position, elapsed time — in an external store subscribed by the leaf that renders it. Held in `useState` inside a screen-level hook or model, it re-runs every hook and every consumer of that model on each keystroke or frame.
- A value that will land in a dependency array must be identity-stable at the caller; an inline arrow, object, or array literal passed down re-triggers every effect, memo, and subscription it reaches. A value read only after commit belongs in a ref, not in the dependency array.
- Mount effects do not write persisted or synced state. A write on mount round-trips through the server echo and buys a second render wave on every mount; persist on real user intent instead.
- Collect ids and call the batched owner once; a request issued per row, per item, or per effect run is an N+1 even when each call is cheap, and it is the batching owner's contract that must change, not the call site's loop. Any read-then-await-then-write path needs in-flight sharing so concurrent runs collapse onto one request instead of racing and each writing back a snapshot taken before the others landed.
- Internal queue and admission bounds must protect a named measured resource or external/platform contract. Do not reject ordinary concurrent bulk work merely because an implementation-owned queue reaches an arbitrary multiple of its batch size, and never turn queue pressure into a bulk native-to-JavaScript fallback that moves CPU work onto the UI runtime. Serialize or coalesce at the canonical owner, preserve cancellation, and keep any required timeout observable.
- The React Compiler is off in this app, so manual memoisation is load-bearing — and a memo whose dependencies change every render is pure overhead. Do not apply blanket `memo`, `useMemo`, `useCallback`, or caches without a demonstrated benefit and correct invalidation; when adding one, be able to say what keeps its dependencies stable.
- For transcript/session-list work, validate scroll anchoring, pagination, viewport restoration, virtualization, and large-session responsiveness.
- Treat the native first transcript viewport as bounded presentation work: reuse the existing native prepend/page-size owner when a smaller first page fills the viewport, while keeping catch-up and repair paging at their correctness-owned size. Do not create a second page-size policy in the screen or list.
- A changing component *type* remounts its whole subtree, discarding state, measurements, scroll position, and animations. So never pick between two types on state or a prop — vary the subscription, props, or callback inside one component instead. The same defect fires unconditionally when a component is *declared* in a render body or a `useMemo`, since every recompute mints a new type and re-fires its effects; with a periodically-changing dependency such as a clock tick, it remounts on a timer. Hoist components to module scope and pass what they closed over as props. Returning an element or a render callback from a memo is fine; returning a new component type is not. Native wrapper and scroll-view accessory topology counts too: conditionally adding or removing `RefreshControl` can change child position or wrapper type and remount retained rows. Keep the native element topology stable, gate its work and handlers through props, and verify focus cycles preserve row mounts and scroll position.
- Every repeating timer, poll, subscription, and animation loop declares its stop condition: paused when backgrounded, hidden, or offscreen, and honoring reduced-motion. A loop that keeps running unseen is a battery and accessibility defect, not just a perf one.
- Only worklet-safe code may run inside `useAnimatedStyle`, `useDerivedValue`, and gesture worklets. A plain imported function called there throws on the UI thread and surfaces as unrelated-looking errors elsewhere; prefer hoisting the computation so the worklet closes over a plain value over marking more code `'worklet'`.
- A perf change that lands on one platform lands on all of them: verify native and web (and desktop when affected) still take the intended path, since one branch can silently disable the optimization on the other.
- Performance work must preserve accessibility, responsive layout, i18n, and platform behavior, with measured validation when feasible.

## React and React Native skill routing

- These tool-specific skills are accelerators, not universal dependencies. Use them when available; otherwise apply the same repository evidence and validation rules directly, and report an unavailable tool only when it leaves a decision-material gap.
- For React Native or Expo implementation/review, use the installed `vercel-react-native-skills` selectively and read only the rules relevant to the task. Happier's canonical primitives, owners, package instructions, and measured evidence override generic prescriptions about libraries, navigation, modals, styling, state, memoization, or folder structure.
- For component trees, props/state/hooks, render ownership, or suspected rerender churn, use `react-devtools` with bounded inspection. For explicit performance/optimization work, take method and instrument choice from `.agents/skills/happier-profile-and-optimize`, then use `argent-react-native-optimization` and `argent-react-native-profiler`: capture a reproducible baseline, identify the measured bottleneck, make one evidence-backed optimization cycle, replay the same flow, and report whether performance improved, stayed flat, or regressed. The React profiler measures render work only — reconcile its total against JS-thread blocked time before concluding that render churn is the bottleneck, because crypto, parsing, storage, and effect work do not appear in it.
- For component API or composition refactors involving boolean-prop proliferation, variants, compound components, or shared context boundaries, use `vercel-composition-patterns`; the root durable-design evidence bar still decides whether an abstraction is justified.
- Apply all tool-specific skills under the root scope, delegation, process-ownership, and validation rules. Do not inherit a generic skill's mandatory fleet size, whole-app sweep, process restart, tool installation/upgrade, package-manager command, or architectural rewrite when it is not authorized or relevant here.

## Testing and live validation

- Prefer `@/dev/testkit` and helpers under `sources/dev/testkit/**`.
- Do not create inline mock families for boundaries already owned by the testkit, including `expo-router`, `@/text`, `@/modal`, `react-native`, `react-native-unistyles`, and storage.
- Exercise real UI/domain logic below those boundaries and assert observable behavior rather than copy, raw styles, implementation details, or incidental calls.
- Render and inspect incremental visual changes. For device QA, pin the loaded bundle with a full Metro reload, Fast Refresh off, and a module probe when bundle identity matters.
- Use `.agents/skills/happier-testing` for browser/device live gates and known memory-heavy suite guidance.
