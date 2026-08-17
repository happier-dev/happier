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

## Agent and Provider composition

- Agent UI contributions belong in `packages/plugins/<agentId>/src/ui/**` and project through generated host composition in `sources/agents/catalog/**` and `sources/agents/registry/**`.
- Do not recreate the retired `sources/agents/providers/**` host tree.
- Model Provider UI composition belongs in `sources/providers/**` and consumes first-class Provider contracts from protocol/plugin contributions.
- Generic screens, components, and sync code must not branch on Agent or Provider ids when a typed contribution, catalog hook, registry result, or provider-binding adapter can own the variation.

Details: `../../docs/agents-catalog.md` and `../../docs/providers.md`.

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
- Status UI must be truthful. Spinners, progress states, disabled actions, activity labels, and completion indicators derive from the canonical lifecycle owner and stop or transition on success, failure, cancellation, disconnect, and recovery. Do not maintain a second UI-only interpretation of whether work is active.
- Do not use indefinite JavaScript-, layout-, or continuously repainting decorative animations. Long-running status motion must be compositor/worklet-safe where applicable, pause while hidden, backgrounded, or offscreen, honor reduced motion, and be measured when its frame, CPU, GPU, or battery cost can be material.
- Preserve referential stability for unchanged rows, items, maps, and arrays; patch the smallest affected state.
- Avoid rebuilding expensive derived state unless structural inputs changed.
- Keep subscriptions/selectors as narrow as the ownership model permits and verify render scope/counts when a change can fan out; do not apply blanket `memo`, `useMemo`, `useCallback`, or caches without a demonstrated benefit and correct invalidation.
- For transcript/session-list work, validate scroll anchoring, pagination, viewport restoration, virtualization, and large-session responsiveness.
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
- Use `skills/happier-testing` for browser/device live gates and known memory-heavy suite guidance.
