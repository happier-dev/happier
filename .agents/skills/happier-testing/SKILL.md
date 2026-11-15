---
name: happier-testing
description: Author, change, review, delete, or audit Happier tests through observable contracts, canonical testkits, risk-selected validation, and safe subsystem cleanup. Use for behavior-changing TDD and for test-infrastructure or test-pruning work.
metadata: {"openclaw":{"homepage":"https://github.com/happier-dev/happier"}}
---

# Happier Testing And TDD

Use this skill whenever work adds, changes, reviews, deletes, or audits tests, fixtures, testkits, lane wiring, or validation behavior. It is the single test-quality owner; CI failure collection remains in `.agents/skills/happier-ci-stabilize`.

## Goal

Apply strict RED-GREEN-REFACTOR while following Happier-specific lane, fixture, and rerun rules so changes do not silently drift until a late pipeline sweep.

## Workflow

1. **Inventory first**
- Search for existing tests by symbol, route, command, feature id, config key, component name, or error code.
- Map the affected lane(s) and any shared/package-local harnesses the change can invalidate before editing code.
- Name the observable contract or material risk the test must distinguish before writing it.
- For user-visible or environment-dependent work, define the composed live recipe before implementation: exact entry point, provider/account/state, seeded scale profile under [happier-performance §3](../happier-performance/SKILL.md#3-landing-checks-for-a-perf-relevant-change), actions, expected outcome, recovery path, and build/bundle/runtime identity that will prove the result.
- Update the most relevant existing test first when possible.
- When behavior changes, update tests asserting the old behavior in the same change and cite the approved decision that changes their contract; preserving a green obsolete expectation is not compatibility coverage.
- Consolidate overlapping tests instead of stacking new ones on top.

2. **Classify failures correctly**
- `production defect`: runtime behavior is wrong
- `stale test or expectation`: assertions/fixtures assume an obsolete contract
- `harness or mock defect`: helpers/mocks/testkit do not represent real runtime wiring
- `release-control or setup defect`: workflow admission, permissions, generated prerequisites, or configuration are wrong
- `external service or configuration defect`: an external dependency, credential, account, or published state is unavailable or invalid
- `resource or timeout defect`: the owning resource budget, cleanup, runner, or lifecycle bound is wrong
- `inconclusive`: available evidence cannot yet identify the owning class

3. **RED**
- Write or update the smallest relevant test first.
- Run only the smallest relevant slice and confirm it fails because the intended behavior is missing or wrong, not because of setup, fixtures, mocks, wording, syntax, or an unrelated error.

4. **GREEN**
- Implement the smallest fix that satisfies the failing behavior.
- Keep internal behavior real; mock only system boundaries.

5. **REFACTOR**
- Extract shared helpers only when there is repeated real duplication or repeated stale drift.
- Keep file responsibilities focused.

6. **Broaden validation**
- After focused GREEN, run risk-selected adjacent checks; batch expensive package/build and broader checks at the coherent integration boundary under root **Validation**. Reuse applicable execution evidence under that policy instead of rerunning it for each handoff.
- Validate the current moving source and the existing development stack:
  1. **Inner loop:** run the smallest direct source-level RED/GREEN slice without a package build.
  2. **Lane confidence:** run one risk-selected adjacent corridor lane and source-level typechecking when it can run without republishing shared outputs.
  3. **Integrated package boundary:** run the package typecheck/build-enforcing lane once after the coherent batch sharing that output has settled.
  4. **Loaded-runtime boundary:** load/reload and probe the relevant bundle, module, process, or daemon, then batch the materially distinct live scenarios that consume it.
- Feature validation ends at the deciding source, integration, and loaded-runtime surfaces. Do not create, freeze, pack, install, identify, or certify a separate release representation; archive production and publication verification belong only to release automation during an explicitly dispatched release.
- Intermediate handoffs may defer a later expensive tier only when the result records the exact unrun check, later owning boundary, and prerequisite. Deferred evidence cannot close the affected gate or support `VERIFIED_COMPLETE`; before final handoff, run every required tier or report it `BLOCKED`.
- Do not invoke a package script whose setup republishes shared build/generated output merely to run a focused test when the canonical lane-specific source harness exists. Do not skip a build when the changed behavior itself consumes generated or built output.

## Test Value Gate

- Scope-preserving solution economy never caps evidence. Test and QA depth follow materially distinct behavior, reachable failure modes, and risk; implementation size, line count, or a desire for one runnable check cannot justify dropping a required contract, edge/failure/recovery case, compatibility direction, platform path, or live gate.
- TDD proves an observable contract; it does not require a new test for every changed function, branch, helper, or file.
- Prefer strengthening or consolidating the canonical owner-level test over adding overlapping coverage.
- One discriminating test is more valuable than many shallow permutations. Add cases only for materially different contracts, boundaries, or failure modes.
- A useful test distinguishes the intended implementation from at least one plausible incorrect implementation. If it would pass both, passes too easily, or contradicts visible behavior, challenge the fixture, instrument, harness, and observed branch before trusting the system; strengthen or remove the check. Reuse meaningful original RED evidence; a separate mutation is needed only when that evidence is missing or no longer establishes sensitivity to the relevant defect.
- Do not add runtime tests that merely restate TypeScript types, mirror implementation structure, assert pass-through wiring or incidental call counts, or police wording, formatting, raw styles, or example values.
- Count-based **cost contracts** are not incidental call counts. Examples: renders per arrival, SQL statements per request, requests per idle minute, bodies fetched per open. Cover publication and idle behavior at the canonical owner: requests per view, zero POSTs while hidden, zero reprojections per equal push, and zero collection visits with zero consumers. Usage's duplicate view requests, hidden POSTs, equal-push reprojections and unconsumed collection walks each escaped without an owner-level count contract (2026-11). These are observable performance contracts; write them as `.agents/skills/happier-performance` describes, with scale-shaped fixtures, real Postgres for query shapes, and compiled-bundle checks for dynamic imports.
- Exercise real internal behavior through the canonical/public owner boundary whenever practical.
- Remove or consolidate redundant tests introduced or exposed by the change.

Before retaining or adding a test, imagine two edits and answer two questions:

1. **Break the behavior** (the plausible implementation mistake: the wrong owner, the missed sibling, the inverted branch). The test must fail. Name that mistake; it is the failure the test catches.
2. **Change the internals without changing the behavior** (rename, extract, reorder, swap a collaborator). The test must still pass. If it fails, it is mirroring implementation.
3. Which observable behavior, invariant, released contract, or reachable material risk does it protect, and why does a stronger existing owner-level test not already catch the mistake from edit 1?
4. Does the test require a production export, reset, dependency injection seam, or mode that no production caller needs?

A missing answer is a review signal, not an automatic deletion verdict. Static inspection remains valid when it is the cheapest independent proof of a public API, generated artifact, package boundary, workflow permission/trust contract, migration, security property, or platform configuration and survives behavior-preserving refactoring.

## Explicit touched-path compiler evidence

In 0.3 development, use `pnpm run typecheck:touched -- apps/ui apps/ui/sources/path.ts`
from the repository root (also `apps/cli` / `apps/server`; paths are repository-relative).
It runs the complete public package typecheck through AUTO and compares explicit
paths by file:line:code with the newest complete shared Systemic `.locs` baseline.
Read both the touched delta and unattributed additions elsewhere; a zero touched
delta alone does not establish zero new diagnostics across the package. Missing
baseline or incomplete compilation is unavailable evidence, never GREEN. Do not
hand-build scoped tsconfigs. See `docs/testing.md` “Touched-path typecheck delta”.


## Test Audit And Mechanical Cleanup

For an explicit test-pruning, test-infrastructure, or whole-subsystem audit, read [test-audit.md](references/test-audit.md). Audit one canonical owner or subsystem at a time. Use deterministic analyzers and codemods for mechanical repetition, but keep contract value, keeper selection, compatibility obligations, and deletion decisions evidence-led.

## Compatibility Contract Gate

- Use `.agents/skills/happier-compatibility` when a behavior change affects wire/semantic contracts, persistence, schemas/migrations, feature negotiation, installer/service state, mixed versions, upgrades, or rollback.
- Name the exact released/predecessor producer and consumer plus the direction the test proves. Prefer the real historical serializer/client/artifact or a provenance-pinned golden vector; do not reconstruct “old” behavior from current types or a new mock.
- Add one discriminating contract/vector test per material reachable direction, then only the risk-selected end-to-end flows. Do not multiply UI × CLI × daemon × server permutations when the changed seam does not couple them.
- Inventory and consolidate existing compatibility fixtures and harnesses before adding another family; a compatibility test must not create a second implementation of the protocol it is meant to verify.
- Follow the 2026-10-31 **Migrations: no edits during development, one consolidation before 0.3 release** row in `.project/OWNER-RULINGS.md` for migration authoring, the named release check and accidental-edit reconciliation; the reconciliation procedure is in `apps/stack/AGENTS.md` **Repo-local development database reconciliation**. Never delete/reset/recreate/replace/clean it and never substitute a fresh database.

## Happier Lane Map

Canonical top-level lanes:
- `yarn test`
- `yarn test:integration`
- `yarn test:e2e:core:fast`
- `yarn test:e2e:core:slow`
- `yarn test:e2e:ui`
- `yarn test:agents`
- `yarn test:db-contract:docker`

CLI lane rule:
- `apps/cli` unit tests must not force a full CLI `dist` build.
- Use the lane-specific global setup files:
  - `src/test-setup.unit.ts`
  - `src/test-setup.integration.ts`
  - `src/test-setup.slow.ts`

## Seam tests (required when a change crosses a seam)

Most live failures in 0.3 were correct owners wired together wrongly: an empty environment handed to a real service, a reader never bound, an approval executor registered with the wrong dependencies, a producer emitting a field its strict consumer rejects, a cross-program change silently breaking another program's invariant. Owner-level tests that inject collaborators cannot see these. So:

- **Composed test through real wiring.** Each execution unit crossing a seam (composition root, registration, Action family, transport, persistence path or another program's contract) adds or extends at least one test from the real entry point to the real output through production composition: the real registration/executor/handler/schema/storage (in-process real Socket.IO, real HTTP, disposable real SQLite/Postgres), mocking only true external systems (third-party APIs, OS/process, clock). A feature that crosses processes (for example UI → server → daemon) requires one composed in-process journey test at the owning contract boundary (real UI Action executor → real protocol → real server handler → real daemon dispatcher over loopback, real stores), asserting the user-visible outcome and typed error. Make it the default RED for a defect found in live QA, entering through the same lifecycle entry the live failure used (fresh page load, native startup, Home rather than a Session, pinned account rather than pool), ideally reproduced from the live log line; a RED through a different entry is not a reproduction. Reuse the existing composed harnesses (N2 harness, FX106 `BrowserSurfaceHost`, `sol-test-cleanup` 6-journey API test); don't build a new runner. Create a harness per Action family/seam only when none exists. For an authorization, cross-Machine or cross-process contract, at least one test uses the real producer and the real boundary: real issuance, the real signing and projection owner, and the real route, RPC or process handler. A synthetic projection or fixture may supplement it but never replaces it. The composed test replaces equivalent internal-module mocks rather than adding to them; the test-policy runner counts those mocks. Why: the Sync 401, daemon direct-source rejection, unresolved Machine availability and PTY Stop continuation all passed synthetic tests and failed live (2026-11-03/04).
- **Registered ≠ wired.** Keep inventory/parity tests where a registration also needs a grant, declaration or consumer: Tauri capabilities, CLI Action declarations, focus/keyboard owners and driver registries. Registration alone missed notch grants, `shell.column`, keyboard-wanted, the phone Start driver and C02 start intent (UI refinements, 2026-11-04).
- **Mounted surfaces settle populated.** A change to plugin surface hosting, mounted readiness, subscriptions or contribution projection adds or extends one test that mounts a real contribution through the production host. The test asserts a populated read, or a typed refusal, rather than only the readiness flags.
- **Producer → consumer contract.** For every wire or persisted shape the change produces, run the real producer's output (including edge inputs) through the exact consumer/strict schema that reads it. A new waiting state gets a test that fails if its advancing edge is unwired; [happier-plan §4](../happier-plan/SKILL.md#4-select-the-smallest-coherent-target-design) owns the state-and-wake design rule.
- **Wiring sensitivity check.** A seam test must fail if the wiring under test is removed or mis-bound (comment out the registration / pass the wrong dependency once and confirm RED). If it would still pass, it is not testing the seam. Drive the production event: socket status, transport response, approval decision, the default factory. Never call a private lifecycle entry (`(x as any).subscribeToUpdates()`) or inject a test-bound dispatcher. Mock only the OS/process/network boundary beneath the production default factory.
- **Fixtures:** apply [Fixture And Mock Policy](#fixture-and-mock-policy) at the boundary the seam test proves. Do not force eager startup or synthesize provider artifacts when the behaviour depends on lazy start or real provider output; prefer the real provider fixture, or state what remains unmodelled. Why: synthetic transcripts and forced startup hid FIN row 8e's live failures (2026-11-02–04).
- **Cross-identity features run as the real other identity.** Behaviour that crosses OS users, Accounts or Machines (isolated Agent UIDs, member grants, signed child requests) gets one test that executes as the real different UID/Account/installation. A same-UID or single-Account fixture is not evidence for it (2026-11-04: five same-UID GREEN suites, every isolated live Session failed on socket/IPC access).
- **UI Actions go through the real dispatch and the real plugin schema.** A UI surface that triggers an Action or a plugin-contributed Action gets one test through the production dispatch path (e.g. `action.invoke`) validated against the plugin's real declared input schema and credential binding, not a hand-built input or a stubbed binding (2026-11-04: Vercel Inspect passed unit tests, failed live four times on route, input shape and binding).
- **Destructive or stateful live QA runs on a fresh throwaway Machine.** A journey that installs, mutates the host firewall or disk, or deletes uses a fresh product-made throwaway VM, created and deleted by the journey, not a long-lived shared guest whose accumulated state (disk, firewall, payload versions) produces false failures.
- **Route every ingress through the one owner, then test each distinct path once.** Inventory every route reaching the fixed behaviour (UI Action, Session MCP `action_execute`, signed-root `/actions/root/execute`, Machine RPC, recovery, deferred and Temporary-computer creation). Each must reach it through the shared owner; a route that needs its own guard or its own copy of the decision is a split-brain to fix at the owner. Drive each materially distinct route once through its production entry, or name the uncovered/not-applicable routes and why. A new or changed RPC or Action route gets one test through the real server router and its admission, not only the owner unit (2026-11-04/06: prices, continuation forwarding, a 0.2 `.strict()` route and the quota_refresh rebuild each passed owner tests and failed composed). A composed test through a newer route proves nothing about an older one. Composed tests enter through the same UI action or Action spec the person or agent uses. Why: an internal helper can pass while the real entry fails (FIN row 8e, 2026-11-02–04).
- **One canonical helper per repeated QA step.** When lanes repeat a QA or validation step (QA sign-in, touched-file typecheck, browser acquisition), use or request its canonical Stack/script command. Don't copy scripts into lane evidence folders. Why: about ten hand-copied `signin.mjs` scripts broke on three welcome-screen changes in one week (2026-11-04).
- **Security guards ship with owner positives.** Prove the legitimate owner still succeeds through the real composed path beside denial controls. For narrowing admission, isolation, custody or authority, or adding a refusal/required fact (requester custody, owner stamp, identity), put the guard at the shared owner those ingresses consume and cover each materially distinct guarded production ingress once, proving it reaches that owner (owner positive and denial), not that it carries its own guard: interactive Session, first Send, resume, spawn, bounded/execution Runs, workflow-run Session for both session and background-run targets, Voice, Custom ACP, file IO, terminal, MCP startup, Workflow child and Machine RPC. Apply the fixture policy below; missing custody is a producer investigation, never permission to default authority, and refusing the owner is a regression even when every negative passes. A loaded guard regression starts the [live-in-the-loop cycle](#live-validation-gates) immediately. Incident basis: `.project/OWNER-RULINGS.md` (10-29 guardrails); `.project/plans/2026-10-29-program-census/RESUME-DECISIONS.md` §2 (MI-1).
- **Cover every consumer and lifetime of the changed fact.** Use [happier-implement's writer/reader inventory](../happier-implement/SKILL.md#4-select-the-smallest-coherent-systemic-change) to verify a produced fact where it is read: warm and cold load, fresh and retained or stored records, live and reloaded, and sibling families sharing the owner (Session and Discussion, desktop and phone presenters, UI, CLI and daemon); consumers read the owner's fact rather than re-deciding it; test at least one non-owner consumer through its production entry, one test per distinct consumer behaviour, and name those not covered. Evidence: `.project/plans/2026-10-17-coordination/research/STATUS-DIGEST-2026-10-28-C.md` §6. Tests for persisted-data readers include the oldest supported stored shape (for example pre-migration or 0.2-registered records), alongside fresh fixtures. Why: fresh-only fixtures missed the near-shipped refusal of upgraded Machines (FIN, 2026-11-04).
- **Match the product's Account mode.** A path that seals or opens owner content needs its fixture in the Account mode the product uses. A plain-Account fixture gets an encrypted-Account twin, and a seed injected past the real entry (a direct draft seed, a pre-built store) does not count as the entry-path test.
- **Use the contract's principal.** Authorization fixtures use the present user when that is the admitted actor, not an automation Account (2026-11-15: stale `account_automation` fixtures).
- **Mounted acceptance.** After the owner accepts a new fact, assert the already-mounted view shows it without refresh and retires its stale edit buffer (b57bfdc7b2d: Use this plan left Your unsaved edits visible).
- **Match the live relationship shape and both directions.** A fixture for access, audience or identity presentation covers how people actually reach the resource (collective/Team-derived access, not only direct grants), every transition in both directions (leave and rejoin, revoke and restore) as it takes effect at the next natural boundary (next open, request or reconnect; a live terminal or open stream closes at once), and the warm mounted state as well as a cold load. Behaviour involving two people (guest/owner, Team viewer, shared Machine or link recipient) needs at least one composed test with two real Accounts on an installed daemon. Why: single-Account tests hid FIN row 8e authority failures (2026-11-02–04).
- **Match the live topology.** Cross-Machine flows use distinct source, receiver and controller Machines/installations. When a fact crosses a Machine boundary (a guest VM or remote daemon, a spawned runner, a grantee using someone else's Machine), the fixture gives the controller, the daemon host and the child process distinct network origins, and gives the owner and the grantee distinct Accounts. A single-host, single-Account fixture can't see a host-only URL handed to a guest, a host port taken by guest forwarding, or an admitted grantee refused by a second permission decision (incidents 2026-11-03: `8bc250c1a1`, `edb66305dd`, `a9fd138e81`; live QA found all three).
- **Cover the sibling paths.** When a fix or test covers one placement, architecture or host OS, add the same composed case for each sibling the changed owner serves: owner and member on a separate-users Machine, x86-64 and ARM64 payloads, Linux and macOS guests. Fork C on 2026-11-06 fixed the grantee launch, and the owner's own Session on the same Machine then failed separately; an ARM payload lacked a native addon that x64 had (C-TEAM-START, OWNER-PROVIDER, CLOUD-ENROLL).
- **Real input values and identities.** Fixtures use values the real platform produces, not convenient ones:
  - fractional DOM/RNW event timestamps through the strict wire schema;
  - the browser's default focus transfer before press handlers;
  - hit tests on the rendered centres of controls that can overlap;
  - the credential shape users actually run with (a connected account, not a no-auth probe) when the path runs as another OS user; composed tests use the real credential/bearer type. A composed test that claims an authorization path gets its authority through the real entry (a real bearer or PAT over real HTTP or RPC), never from a fixture-built signed root (Bot templates BT3, 2026-11-05: composed 5/5 passed while live returned 403). Why: the wrong bearer hid FIN row 8e authority failures (2026-11-02–04).

  Incidents 2026-11-03/04: drag `durationMs`, keyboard Hide, the presence capsule over the controls, and member Codex `client_start` all passed owner tests on convenient inputs.
- **Vendored engines and declared host tools are not external systems.** Behaviour that runs inside a vendored engine (Monaco, CodeMirror, Pierre) is tested against that engine with real input events, and a plugin's host-tool path is tested through the real tool admission (for example git through the plugin Exec), never a stubbed engine or exec.
- **Union and signature changes:** apply [happier-implement's shared-contract inventory and exhaustiveness rules](../happier-implement/SKILL.md#4-select-the-smallest-coherent-systemic-change).
- **Pending, empty and failed are three states.** Any owner that presents loaded data (counts, lists, coverage, availability, currency) gets one owner-level test with a held read (still pending: loading, never unavailable/zero/allowed), a settled empty result (a real zero), and a settled failure (unavailable). Its consumers branch on that status, never on the absence of data.
- **Prefer fewer, stronger tests.** Delete or merge unit tests that only re-assert collaborator calls or mirror implementation; keep one owner test per decision plus the seam test. A lane may not report a seam-crossing change as done on mocked unit tests alone: it needs the seam test, or the named composed live recipe actually run, or an explicit deferral naming the recipe and its owner.

- **Start at the real entry root.** A UI or runtime fix's RED starts at the real entry root (the platform root, not a subtree that omits a provider), or the report says why it can't. Read-aloud took three fixes because tests mounted below the web root.
- **Real-user pass first.** A QA batch starts with one real-user pass from Home with no prepared targets, not only at the end: scripted recipes set up their own state and hide what a person hits.
- **Producer through consumer.** A cross-layer seam fix has one test running the real producer through the real consumer's parser; stubbed boundaries hid 59 of 243 classified fixes.
- **Four typed states.** Loading, unavailable, answered-empty and partial are distinct states, rendered through the mounted consumer.
- **Composed journeys run as one uninterrupted session,** so one replay exposes every blocker instead of one per round.

## Fixture And Mock Policy

- `test:policy` reports internal-module `vi.mock` counts per package (`--report-only` lists files) and rejects per-file growth above `scripts/testing/lib/internalModuleMockBaseline.json`; replace internal mocks with composed tests, and identify a genuine otherwise-unrecognized system adapter with an immediately preceding `test-policy-boundary:` comment explaining the boundary.
- Do not partially mock central shared modules such as `@/sync/domains/state/storage`.
- Prefer package-local shared factories/testkits for repeated boundary mocks.
- Keep cross-repo primitives in `packages/tests/src/testkit`.
- Before adding a new helper or mock family, inspect the codebase for the existing canonical testkit/helper for that boundary. On a structural fixture/setup mismatch, trace the real producer-to-consumer input graph before another rerun; repair coherent fixtures rather than adding internal stubs one failure at a time.
- Prefer reusing, extending, generalizing, or extracting from canonical helpers over introducing similar-but-different variants.
- A count or identity RED drives the production producer path. A harness that republishes by replacing records with `setState`, or a boundary mock that returns fresh callbacks or objects on every render, manufactures churn production never has, and a mock that never republishes makes the test pass vacuously. Make boundary mocks identity-stable before trusting a RED, and confirm that the producer behavior the RED models really happens in source or live.
- A test reads an owner's output through that owner's testkit helper (for example a hit area through the `@/dev/testkit` hit-area reader) and never re-derives the owner's policy (thresholds, gap splitting, platform floors) in the assertion. A re-derived policy passes while the owner is wrong and breaks when the owner is right. If the helper does not exist yet, extend the owner's testkit rather than computing the value locally.
- A failure is "not ours" only after attribution evidence: `git diff --stat <path>` shows we did not touch it, or `git diff HEAD -- <path>` shows the concurrent change. When the failing suite imports anything the lane changed, an untouched test file is not that evidence; run an A/B instead: the same command fails identically with only the lane's hunks bypassed (root **Multi-agent and Git safety** bypass rule). Otherwise report it as unattributed. Never decide by guess, and never manufacture a clean tree to find out.
- A failing test in a file or suite the lane changed, including a count or budget assertion, is the lane's until its hunks are shown unrelated to the failing assertion. On 2026-10-27 a lane called two read-budget failures "unrelated"; its own change caused them.
- When a new canonical helper replaces older local variants, migrate or remove the overlapping variants instead of leaving parallel helper families behind.
- Be careful with repeat-offender boundaries: prefer canonical helpers over fresh inline mocks for UI boundaries such as `expo-router`, `@/text`, `@/modal`, `react-native`, and `react-native-unistyles`; prefer existing server route/DB harnesses over direct storage mocks when available.
- For `apps/ui` tests, treat `apps/ui/sources/dev/testkit/**` as the default surface. Read `apps/ui/sources/dev/testkit/README.md` first and prefer imports from `@/dev/testkit` for mocks, fixtures, render helpers, hook helpers, and harnesses.
- Do not add new inline `vi.mock(...)` families for `expo-router`, `@/text`, `@/modal`, `react-native`, `react-native-unistyles`, or `@/sync/domains/state/storage` when the UI testkit already owns that boundary. If a needed case is missing, extend the canonical UI testkit helper in the same change instead of inventing a file-local mock family.
- If a one-off local UI override is truly unavoidable, keep it minimal, base it on the canonical factory where possible, and leave a short justification comment rather than turning it into a new reusable pattern.
- **Producer-built fixtures.** Build valid fixtures, including boundary-mock inputs and responses, through the owner's canonical schema or Action contract and admission using the real producer or its owner-exported testkit builder, never hand-built shapes that can drift; captured, redacted stored records are also valid cross-owner inputs. Cover every producer intent (a Workflow question carries no mention; a committed install is already admitted), never hand-write a route answer when its owner exports a builder, and never inject state after the boundary the test claims to prove. Transport and batch-reader owners export their wire fixture builder (for example `createSessionReadBatchFetchBoundary`) so producer changes break fixtures in the same change. Malformed-input controls and provenance-pinned historical vectors retain their raw shape until the actual reader boundary they test.
- When one boundary spy carries several event kinds, filter to the event owned by the contract before asserting. Total call counts are incidental and drift when unrelated valid events are added.
- Extend the canonical boundary harness's default behavior for the exceptional event under test. Do not replace the whole boundary with a one-response stub that stops acknowledging neighboring protocol calls.
- Keep package-specific fixtures near the owning package:
  - UI helpers in `apps/ui`
  - CLI helpers in `apps/cli`
  - server helpers in `apps/server`
- Scratch, diagnostic or probe tests never live in package source trees and never import across apps (for example a server spec importing `apps/cli/src`). Compilers and test globs pick them up even when untracked. On 2026-10-26 one such spec raised every fleet server typecheck from 5 to 3,174 diagnostics. Keep them under `.happier/qa/<lane>/`, or put a composed client-to-route check in the cross-package harness that owns both sides (`packages/tests`). Delete them before reporting.

## UI E2E Rules

- Use stable `testID` selectors, not visible copy, as the primary selector contract.
- Click the real submit/confirm button after waiting for it to be enabled.
- Do not rely on Enter-to-send or similar settings-sensitive shortcuts unless the test explicitly configures the setting first.
- When a UI flow changes, update the corresponding Playwright spec in the same change.
- Use `packages/tests/src/testkit/uiE2e/browserDiagnostics.ts` for browser console, page-error, failed-request, and error-response collection. Append diagnostics with its stack-preserving helper instead of replacing the original exception and callsite.
- Label repeated lifecycle waits by phase. For cross-boundary scenarios, capture enough outcome state to identify the failing boundary before raising a timeout.
- Configure the UI state the assertion actually needs. A plain or all-untracked workspace is empty in the repository tree's **Project** mode; select **All files** through the shared helper when that is the tested surface.

## Anti-Flake Process Rules

- Within this task and its delegates, reuse an active run of the same spec/lane instead of launching an equivalent rerun. Follow root waiting/recovery policy; this requires no cross-session monitor coordination.
- If a runner hangs or is killed, inspect whether the failure is repo-owned, harness-owned, or environmental before retrying blindly.
- When shared process helpers change, rerun a broader lane that can reveal leaked handles or child-process cleanup regressions.
- Before starting Metro or Playwright in a shared development VM, inspect current compiler, Vitest, and Metro load. A bundle-fetch timeout under unrelated saturation is not valid RED evidence and must not become a larger repository timeout.
- Preserve the original stack, phase label, browser diagnostics, and focused artifacts. Inspect artifact metadata before downloading a potentially huge diagnostics tree.
- When a failure involves a timeout, retry count, request/body cap, or other bound, first prove which lifecycle or resource owner should govern it. Do not turn one slow run or fixture size into a new production limit. A deciding regression test should show reuse of the canonical budget/boundary and accept valid work beyond the incorrect local cutoff it replaces.

## Live Validation Gates

QA-host browser ownership, controlled-stack browser routing, dedicated-stack routing and blank web-startup diagnosis live in [references/live-qa.md](references/live-qa.md) (moved there verbatim); read it before browser or stack QA.

For QA Account sign-in, use `dev-targets browser signin` as documented in the [Stack browser guide](../../../apps/docs/content/docs/hstack/dev-targets.mdx). Pin each QA identity to one stack and include re-sign-in in that stack's reload recipe. A fresh guest proves its loaded build matches the current reload before replay credit (2026-11-15: setup identities adopted repo-dev's Home descriptor; guest Update downgraded to 0.2.20).

Host-test green alone is not shippable for user-visible behavior; this skill owns the lane-level live-validation rules.

- **Build your own fixtures before declaring blocked.** Create and clean up your own QA Sessions, scratch repositories, Account B data and test plugins within the authorized environment; a fixture you can create is not an external prerequisite. Verify the signed-in QA Account id before writing, and check the board for an existing CLAIM before launching a shared-seam run or editing that seam. Mark `BLOCKED` only for a prerequisite you cannot create within your authority, naming its owner and next action.
- Managed-stack browser QA and argent device QA are ship checks for UI-visible changes: run what the executor can reach now, and list the rest once as release checks owned by release automation and human QA. They are not per-lane or per-feature completion gates, and their absence does not authorize new gates, ledgers, or matrices. Write or extend host tests from what the live loop taught, afterwards.
- For daemon/session/provider/API behavior that depends on real process, transport, authentication, persistence, or provider semantics, run the named composed CLI/API/daemon recipe when the authorized environment is available. Corridor tests do not replace this check; when the environment is unavailable, record it as a release check with its prerequisite rather than as a blocker on implementation completion.
- Several source lanes may share one composed live session when that session reaches every material contract and records each scenario’s result; batching setup is not permission to omit a flow, state, failure, recovery, platform, or accessibility obligation.
- **Stop only on journey failures.** In a live replay, a copy, layout or other presentation defect is recorded with a screenshot and the replay continues. Stop and keep the fixture only when a Send, turn, wake, power or Delete fails, recording its typed code and full issue text. When a QA step can be reached through another in-product route (keyboard instead of an obscured control, the product's own recovery action), use it and record which route you took. Fork C replays on 2026-11-06 each lost a round by stopping on duplicated copy, an obscured button and an unconfirmed recovery dialog.
- **Capture before cleanup.** When a live step fails on a guest, VM or fixture you will delete, save its runtime logs (daemon admission phase, native command output) and the exact request before teardown. Deleting the guest deletes the only evidence: on 2026-11-05 a Docker `invalid_encrypted_envelope` on QA guest -g could not be diagnosed afterwards (MACH-DOCKER-TERM-ENVELOPE).
- A failed live row records the typed failure code and `failureCause.phase` alongside its Session or Request correlation, not only the visible text. Capture `effectAttempted` when supplied; if the boundary omitted a code or phase, record that absence and collect its server/daemon diagnostic before cleanup.
- A capture that shows an error is a failed capture even when the capture command, navigation and HTTP status succeeded. Read the rendered content: a dev error overlay, a typed-refusal banner, a skeleton that never resolves or a "not ready" state means the scenario failed, and the visible error is the evidence.
- **Loaded-module proof.** Before a live verdict or attributing a replay failure to current source, identify the serving process (pid → cmdline → bundle id → fix marker) and prove that the changed module and coupled producer/consumer are loaded, using Stack identity plus an owner-specific module probe when process identity is insufficient; a controller's bundle differs from a guest payload. A replay records the loaded source time of every participating daemon, including fixture worker homes; a daemon older than the fix is not evidence for it. If they differ, ask the stack lifecycle owner for a reload and retain the failure as evidence about the old runtime, never as grounds to repair data or widen admission (PERF #42, 2026-10-28). Transport, networking, child-process, dynamic-import and Bun/Node-sensitive changes also need a compiled-payload check, not only the source runtime. Before a live observation, check for an addressed lifecycle HOLD on the exact stack or fixture in use; unless restart or recovery is the scenario under test, observations overlapping that restart are inconclusive until the owner's READY names the loaded participants. Keep doing unaffected work; this is not a global quiet window (Triage ORCH, 2026-11-06: mid-reload observations were reported as product defects).
- After every QA stack reload, before declaring READY or starting scenario work, run an approximately two-minute live smoke on the loaded identities: an ordinary owner Start on their own Machine with a Session step reaching a result; retain the owned workflow Run whose Agent steps (a session target and a background-run target) reach their first conversation, and one cold direct-URL Session Info load that settles. A failing smoke is the round's first finding; do not spend the round on scenarios behind it. Why: fin2 reloads 136–137 shipped an owner-Start refusal this smoke would have caught in minutes (FIN, 2026-11-04).
- If a defect family escapes host tests twice, stop adding host tests and switch to live-in-the-loop: fix → load and identify the updated build/bundle/module actually consumed → replay the exact failing recipe → verify live, closing each defect with a live PASS against that observed basis in the same session. Hot reload or a module probe is sufficient when it proves the changed source is loaded. When a live failure carries no typed cause, the next step is a direct reproduction at the failing boundary (or fixing cause retention), not another unchanged full replay.
- Before fixing UI behaviour, reproduce it live in your managed browser on the borrowed dev Expo and write RED from that observation; scroll, focus, keyboard and layout claims include a real-browser frame sample in the RED. Iterate edit → reload → observe, and report DONE only with a live screenshot plus a rerun of the owner suite for every file touched. Incident basis: `.project/OWNER-RULINGS.md` (10-29 guardrails); `.project/plans/2026-10-29-program-census/RESUME-DECISIONS.md` §2 (Find reveal, Next focus, paint/push).
- Reuse an applicable successful full-suite result; release use alone does not require running it twice. Repeat the affected lane when investigating nondeterminism, shared-state leakage, order dependence, or when an explicit release protocol requires independent execution. Two passes are evidence, not proof of determinism.
- If a documented memory-heavy UI host suite OOMs at the default heap, rerun with `NODE_OPTIONS=--max-old-space-size=8192` instead of silently narrowing the lane.
- Device QA must pin bundle identity when stale Metro state could invalidate the result: full Metro reload, Fast Refresh off, and a module probe.
- **QA collector hygiene.**
  - **Sign-in helpers:** a helper that fills a secret catches every error and prints only a sanitized code, never `err.message`. Playwright exception text includes filled values.
  - **Timed observers:** arm them before the triggering action, never after the result appears.
  - **No debugger pausing:** no breakpoints or exception pausing during the action under test. It froze a Send and confounded a trace.
  - **Preconditions:** the brief names the state the target must be in, for example "this checkout has no project file, so Scripts shows Set up with an agent". A run on the wrong state proves nothing. The brief also names the lane-owned fixtures the lane may create, refresh and remove under its existing authorization, and the lifecycle owner for changes outside that scope (PERF ORCH, 2026-11-06: lanes stopped repeatedly to ask which fixture operations were allowed).
  - **Network evidence:** capture only a projection written first and dry-run on an unauthenticated request: method, pathname, status, counts, and named non-secret facts. Never print or write raw request/response objects, header maps, cookies, storage values or HAR; they carry sign-in headers. On 2026-10-28 a raw request dump leaked a QA Account's bearer header and the Account's sessions had to be revoked.
  - **Fixture provenance:** save a new QA Account's recovery key in the lane's evidence folder (never in a transcript) the moment it is created; a key held only in a browser profile is lost when the profile is reclaimed (Usage, 2026-11-05).
  - **Scoped captures:** capture the element under test by default. Unscoped DOM inventories and full-page captures of dialogs exposed Session identifiers twice (Usage, 2026-11-05).
  - **Shared Home and Account state is not stack-local.** QA stacks on the shared database share one Home and its Accounts, so `home.policy.set`, Account defaults or settings written from one stack reach every stack that restarts. Use the stack's own env for policy fixtures (for example `HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY`), and count a revert as done only when a read-back shows it (2026-11-05: a staged `optional` storage policy loaded on repo-dev; the first revert failed silently). Read-only reviewers avoid controls that may persist a preference on press, including source and model rows; authorized interactive QA exercises them only on lane-owned fixtures in its designated QA Account, and another QA Account is not blanket write authority (ACCEPT-1105, 2026-11-05: pressing a source row changed Account A's remembered model).
  - **Verdicts cite the runtime.** A PASS or FAIL names the loaded server and daemon identity and is valid only for a runtime whose source includes the commit under test. A failure on an older runtime is evidence about that runtime, not a product defect (2026-11-05: a Stop-hold "defect" was a QA server from before the field it rejected).
  - **Composition pairs:** cross each authoring surface between 390 and 1440 mid-input; preserve the same input node, value and open operation. Exercise remove/stop X then read Y on another surface (trigger → History, member → owner read, Stop → custody). Follow every “Open …” link to its exact destination (FIN E09/J18, 3a517717, Q220-01).
  - **Expected outcomes and routes:** derive each expected result from the plan/design contract (for example, a retained key copy means a rejoin needs no repair), not from a guess about the mechanism, and name the exact supported entry an agent must use (an Action through `action_execute`, not an invented tool name).
- **Judge as the person, not only the contract.** A journey verdict also states whether someone who doesn't know the internals would succeed: each state is clear, the next step is obvious, and the page matches its design lab ([happier-ui-craft](../happier-ui-craft/SKILL.md)). A typed result reaching the screen is necessary, not sufficient. Before calling a control missing, open the surface's overflow and header menus; before filing a defect, rule out the QA step itself (wrong entry, identity or runtime).
- **Reloads don't wait for commits.** A source runtime loads working-tree bytes: the stack owner reloads once the fix is in source, and reuses a recent entry-loads 7/7 on current source instead of queueing a new one (2026-11-07: about 5 h and 4.5 h lost twice).
- Close what you open. At the end of a browser QA lane, close every browser you launched: persistent Playwright/Chromium contexts, agent-browser sessions, and their temporary profile directories. An abandoned headless renderer keeps consuming CPU and memory on the shared machine for hours. Leave only a browser the human explicitly asked to keep, and never close another session's browser.

Do not mark a validation step complete merely because wiring is registered, a command reached a compiler/test runner, or a background process remains running. Record the terminal exit/result and decisive product evidence. If the live recipe cannot run, mark it `BLOCKED` with the missing prerequisite and next action; do not substitute more host tests and call the behavior shipped.

## Output Expectations

When reporting testing work, summarize:
- failing area and classification
- root cause
- targeted RED/GREEN evidence
- broader validation performed or applicable evidence reused; outstanding checks and prerequisites
- residual risk, if any
