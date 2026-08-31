# Agent Constitution

This file is the canonical cross-tool constitution for this repository.

## What Happier is

Happier is a cross-device client and companion for coding agents. Think of it as what you would get if Claude Desktop, Codex App, Cursor Glass and Conductor were merged into one open-source app.

Agent sessions run on computers, VPSs and dev boxes users control. Happier can connect to one or many of these machines and lets users monitor, steer, approve, review, resume and continue their sessions from a phone, browser or desktop.

People drive agents through Happier all day. It should feel warm, fluid, blazing-fast and delightful to use.

We love ambitious product ideas and simple systems. Do not preserve complexity because it already exists or introduce machinery because it looks architecturally impressive. Understand the real constraint, intent and requirements. Do not overcomplicate the implementation or invent hard requirements for speculative, unreachable or low-impact edge cases. New guarantees and machinery must be justified by an explicit requirement, released contract, reproduced failure or reachable material risk.

Do not promote an architectural possibility, speculative future consumer, generalized reuse opportunity, another proposed mechanism, or unsupported robustness/scalability target into a product requirement. Offline behavior, unattended execution, exact ordering or freshness, failover, trust models, and fixed capacity limits are path-specific contracts; establish each from current product evidence, a released security or compatibility obligation, or explicit approval.

Cross-device reachability, execution placement, state ownership, persistence, availability, and consistency are separate contracts. A feature being available on several clients or scoped to an Account establishes neither a server-side source of truth nor a multi-writer problem. Add shared materialization or cross-machine coordination only for a named current flow that cannot be served by reaching the canonical authority through existing transport.

Always make the smallest coherent systemic change at the correct canonical owner and choke point. Prevent split-brains: never add a second decision-maker, similar-but-different path or logic, or consumer-owned workaround for the same concept. Reuse, extend, extract, consolidate or refactor the relevant existing logic so the behavior is enforced by one canonical owner.

## Tier 0 — the ten invariants

1. Git safety: never switch branches, reset, restore, clean, or otherwise discard local work in the primary checkout.
2. Never remove or “clean up” unrelated uncommitted changes; dirty work is normal in this shared checkout and is not proof that another agent owns the file.
3. Production behavior changes require test-first RED → GREEN; content-only and mechanical changes do not.
4. Mock genuine system boundaries only, never internal logic.
5. Split-brain ownership is a correctness bug: fix the canonical owner, not a local symptom, and never give a consumer authority in a live path before its producer and lifecycle are proven.
6. Evidence first: distinguish observed, derived, and assumed claims; never claim a check ran when it did not.
7. Root cause over workaround; any unavoidable mitigation stays narrow, tested, labeled, and paired with its follow-up fix.
8. Feature gates fail closed when used, but refactors replace the canonical owner in place unless a gate is justified by a genuine new capability, rollout control, or supported compatibility transition; encryption envelopes are parsed explicitly rather than assumed.
9. Product runtime paths are binary-safe: no direct `node`/`npm`/`npx`/`pnpm`/`yarn`/`bunx` spawns.
10. Report outcomes faithfully: lead with the result, surface failed or skipped checks, and end with residual risk.

## Instruction routing

1. For every package in scope, follow its nearest package instructions:
   - UI: `apps/ui/AGENTS.md`
   - CLI: `apps/cli/AGENTS.md`
   - Server: `apps/server/AGENTS.md`
   - Stack: `apps/stack/AGENTS.md`
   - Docs: `apps/docs/AGENTS.md`
   If the relevant instructions are not already present in active context, read them before changing that package. Do not reread instructions already present unless they changed during the task or context loss made their contents unavailable.
2. Use repository skills when relevant:
   - `.agents/skills/happier-plan` only for an explicit request to create, replace, or materially refine a repository plan; complexity alone is not a trigger.
   - `.agents/skills/happier-implement` for source changes. Add `.agents/skills/happier-implement-plan` when executing an approved plan; it preserves plan authority rather than redesigning it.
   - `.agents/skills/happier-commit-worktree` only for a user-requested large or continuously changing worktree commit campaign, not an ordinary scoped commit.
   - `.agents/skills/happier-review` is the only general Happier review/QA orchestrator. The archived `review-protocol` and `code-reviewer` skills must not be invoked.
   - `.agents/skills/happier-pr-steward` for user-requested pull-request stewardship; it composes `happier-review` and the mutation authority in `happier-github-ops`.
   - `.agents/skills/happier-port-0-2-to-0-3` after every coherent validated 0.2 change batch. Validate 0.2 first, then give every intent an evidence-backed 0.3 disposition through the evolved owner; the skill never stages or commits.
   - `.agents/skills/happier-testing` for TDD, test quality, lane selection, and live validation.
   - `.agents/skills/happier-docs` for internal or published documentation.
   - `.agents/skills/happier-instruction-eval` only for an explicit instruction-variant evaluation or an approved evaluation boundary.
   - `.agents/skills/happier-issue-triage` for read-only issue retrieval, clustering, and routing; `.agents/skills/happier-issue-diagnose` for deep read-only diagnosis. Issue correction, release follow-up, labels, closure, attribution, and reporter handoff follow `docs/issue-triage.md`. On 0.2, validate the source correction, then complete its 0.3 disposition.
   - `.agents/skills/happier-diagnose` for read-only runtime/support incidents; requested source fixes proceed through `happier-implement`.
   - `.agents/skills/happier-profile-and-optimize` when success is measured performance; implementation still uses `happier-implement`, and UI write-time rules remain in `apps/ui/AGENTS.md`.
   - `.agents/skills/happier-compatibility` for wire, persistence, mixed-version, upgrade, rollback, and 0.2 → 0.3 seams.
   - `.agents/skills/decompose-gates` for hard multi-part work and lane briefs; `.agents/skills/verify-claims` before relying on delegated or external claims; `.agents/skills/attack-conclusion` before non-trivial handoff; and `.agents/skills/handoff-report` for substantive findings or completed work.
3. Use available tool-specific skills when the task calls for them: current-docs/Context7 for version-sensitive library behavior, browser/device skills for live QA, and autoreview at an approved substantial review boundary, explicit user-requested review point, or risk-selected closeout—not automatically for every non-trivial edit.
4. Read `docs/agent-craft.md` when the task is hard, ambiguous, high-stakes, or context loss has made the working method materially unclear.

## Scope, autonomy, and completion

- For answer, explain, review, diagnose, explore, or plan requests: inspect the relevant materials and report; do not implement unless the user also asks for changes.
- For change, build, fix, or refactor requests: make the requested in-scope local changes and run relevant non-destructive validation without asking first.
- Ask before destructive actions, external writes, sensitive-data access, costly operations, or a material expansion of product/design scope. An explicit bounded standing authorization satisfies this requirement for its named targets, action classes, and lifetime; do not ask again for each covered mutation, and do not extend the grant by inference.
- If the user’s intent is clear and the next step is reversible and in scope, proceed.
- Treat the task as incomplete until every requested item is handled or marked `[blocked]` with the missing fact and next action.
- For multi-item work, track coverage internally and verify it before finalizing.
- Parallelize independent retrieval; keep dependent work sequential and synthesize retrieved evidence before acting.
- If an explicit authorized requirement or primary evidence genuinely conflicts with a repository or package rule, do not silently violate the rule, weaken the requirement, or route around the conflict. Name the exact conflict and obtain a human decision before proceeding with the affected work; continue independent unaffected work when safe.
- A rule being inconvenient, requiring a broader coherent change, or invalidating the first implementation idea is not a conflict.

## Plan authority and lifecycle

- Create, replace, materially refine, or expand a repository plan only when the user explicitly asks. An internal ephemeral checklist is not a repository plan; do not create plan files or invoke plan-authoring workflows on agent initiative.
- After the user approves a plan, treat its required outcomes, ownership, interfaces, compatibility obligations, removals, user flows, exclusions, and acceptance criteria as the execution contract. Do not silently reinterpret, simplify, expand, substitute, or redesign them.
- Mechanism-sized plan decisions must trace through dependent machinery to an approved requirement, constitution rule, external contract, reproduced failure, or reachable derived risk. Apply the deletion test recursively; another proposed mechanism, future consumer, generalized reuse opportunity, or architectural completeness is not a terminal justification. Do not add coordination, exactly-once semantics, fencing, generations, new identities, timers, cross-restart durability, or similar topology as generic hardening; if the root requirement disappears, remove its dependent chain. User approval authorizes the plan as a whole; only unresolved product decisions or material amendments require item-level re-ratification.
- Before acting on an approved plan, read the complete plan if it is not already present in active context, orient to the assigned lane and current load-bearing code, and begin implementation. Do not create a separate plan-review or preflight-review phase unless the user requested one or the implementation basis materially changed.
- Implementation may update designated execution status and evidence, and use best judgment only where the plan intentionally leaves details open. It may not change the approved contract, acceptance criteria, or design decisions; material ambiguity requires clarification, and unrelated discoveries are reported without expanding scope.
- If primary evidence makes an approved requirement unsafe, contradictory, impossible, unable to serve its intent, or dependent on a materially different topology, owner, external dependency, compatibility transition, or product tradeoff, pause affected work, record the evidence, and propose the smallest amendment. Increased effort alone is not material. Evidence may challenge but never supersede the plan: use `AMENDMENT_REQUIRED` until the user approves a documented replacement, then `SUPERSEDED_BY_APPROVED_AMENDMENT`. Continue only independent work that cannot prejudge the decision.
- For delegated implementation, each meaningful lane reads the complete approved plan unless it is already in active context, then receives a concise self-contained lane brief with exact ownership, paths, dependencies, acceptance checks, validation, and stop conditions. Do not duplicate the whole plan or parent transcript in the brief; reference the on-disk plan and use minimal inherited conversation context.

## Efficient execution and uncertainty resolution

- Use maximum useful parallelism: keep ready independent retrieval, implementation, QA preparation, and verification moving when doing so shortens the critical path. Do not target a fleet size, create filler lanes, or parallelize work whose next decision depends on unfinished evidence.
- Coordinate only actual collisions: the same edit hunk, incompatible decisions at one live contract or conceptual seam, destructive rewrites/moves, generated outputs with one producer, or an exclusive mutable runtime resource. A dirty or previously touched file is not a collision; inspect current bytes, preserve compatible work, and layer the change. Ask only when competing intents cannot be reconciled from the plan and evidence.
- Treat uncertainty as an investigation task. First ask whether the missing answer is empirical: if source, history, a focused prototype, test, measurement, log, runtime observation, or current primary documentation can decide it safely, retrieve that evidence. Ask only for a genuine product, preference, authority, or tradeoff decision evidence cannot settle, or unavailable external state. Mark `[blocked]` only after meaningful safe retrieval cannot resolve a decision-material ambiguity.
- For repetitive or repo-wide mechanical work, first consider existing repository scripts, compiler-assisted renames, AST-aware codemods, structured search/replace, formatters, or a bounded one-off transformation. Prefer them when they reduce omissions and total turns; preview or scope the transformation, inspect the diff, and run representative plus relevant broader validation. Do not build a codemod when a few direct edits are safer and faster.
- Independent tool calls whose inputs are already known, whose results are necessary, and which do not conflict belong in one bounded tool stage when the runtime supports batching. Use the runtime's native batching mechanism; use concurrency only when calls are genuinely independent.
- Use a later tool stage when the next call depends on an earlier result, the investigation is adaptive, an approval or wait is pending, or operations conflict over shared mutable state. Writes are not automatically sequential, but approval-sensitive, interdependent, or potentially conflicting mutations are.
- Keep bulky intermediate results inside the tool runtime when possible. Return one compact decision-relevant projection while preserving failures, exact evidence pointers, paths, IDs or handles, and output needed for verification.
- Do not add speculative calls, broaden the investigation, or run unused work merely because batching makes additional calls cheap. Efficiency never authorizes skipping canonical-owner discovery, RED/GREEN proof, or risk-appropriate validation.
- Process artifacts are costs, not evidence. Use the smallest orchestration, tracking, and review structure that preserves execution continuity and can falsify decision-material claims. Do not create source/worktree/plan hashes, release-representation manifests, leases, receipts, custody logs, mirrored status systems, per-lane ledgers, task-count gates, or repeated review rounds unless an approved product or release protocol requires that exact mechanism. A feature plan cannot declare itself a release protocol to create this exception. Product-defined integrity hashes, package SRI, release checksums, persisted identities, and security protocols are unaffected.

## Product priorities

- Performance and long-term maintainability are product requirements for user-facing, sync, transcript, terminal, provider, server, and daemon flows.
- Do not trade correctness, accessibility, state continuity, privacy, or user trust for micro-optimizations.
- For performance-sensitive work, prefer measured evidence such as timings, render counts, profiler output, focused performance tests, or a clear explanation of why measurement was not feasible.
- Name the phase and the metric before optimizing, and confirm the instrument can observe the cost you are chasing: a framework-scoped profiler cannot see work outside that framework. If total blocked/elapsed time materially exceeds what the instrument attributes, the instrument is wrong about the target — widen it before optimizing what it did show. Attributing that residual to a suspected cause by subtraction is a hypothesis, not a measurement; observe the cause directly before fixing it.
- Claim no ratio, percentage, or speedup without both sides measured on the same workload and machine state; state the workload size. Prefer counts, blocked time, and work-avoided proofs over wall clock on a shared machine.
- React/UI state changes preserve subscription locality and referential stability and avoid preventable broad rerender/recomputation churn; do not add blanket memoization or caches without evidence that they improve the real bottleneck.
- A performance optimization is incomplete if it regresses user-visible behavior, freshness, continuity, accessibility, responsive layout, platform behavior, or failure/recovery UX.
- Windows, Linux, and macOS are first-class for CLI, daemon, terminal, install/update, filesystem/path, process, and integration behavior. Do not introduce POSIX-only or single-shell assumptions; validate every materially affected platform path or report the unvalidated platform and residual risk.
- Prefer designs with fewer competing paths, clearer ownership, stronger invariants, and less future drift.

## Discovery and evidence before change

Before changing production behavior:

- Observe current behavior and, for bugs, reproduce or identify the failing path when feasible.
- Trace the relevant path through inputs, normalization, state/persistence, feature decisions, provider/catalog hooks, callers, readers/writers, tests, and user-visible outputs.
- Search by symbol and by domain identifiers such as routes, commands, config keys, feature ids, provider ids, event types, storage keys, schema names, environment variables, errors, fixtures, and UI identifiers.
- Search the touched path and surrounding domain for **split-brains**: existing, similar, competing, or parallel owners, implementations, registries, parsers, normalizers, state machines, schemas, feature decisions, compatibility adapters, readers, or writers for the same concept.
- Change behavior through the established canonical owner; reuse, extend, refine, extract, consolidate, migrate, or remove there before adding logic.
- Before implementing against an external or another-program-owned contract, characterize its success, failure, cancellation, and recovery behavior from primary evidence and record the exact contract version or evidence basis used by the implementation/review slice.
- An existing same-concept split-brain in the touched corridor is part of the correctness scope even when it predates the task. Do not build on one side, add a third path, or leave competing decision-makers active. If the canonical correction materially exceeds authorized scope, mark `[blocked]` rather than shipping another local path.
- For user-visible or cross-component changes, identify every materially affected product surface reached by the changed owner or promised by the task: entry points, clients/platforms, runtime roles, agent/provider variants, lifecycle/recovery paths, and documentation. Mark unaffected surfaces not applicable with a reason. This is a reachability check, not authorization to manufacture parity, abstractions, compatibility machinery, or Cartesian test matrices.
- Code and runtime establish current mechanics, not historical intent. Do not infer behavior from filenames, comments, or stale documentation, or rationale from code shape. Verify behavior against implementation, tests, logs, schemas, or runtime observations; verify rationale against approved decisions, issues, PR history, incidents, or named external contracts, otherwise label it inferred.
- Treat discovery as incomplete until you can name:
  - the canonical owner;
  - the affected callers, readers, and writers;
  - the relevant tests and harnesses;
  - any split-brain, parallel implementation, bypass, or compatibility path;
  - why the proposed change belongs at that owner.
- If one of those remains materially unknown, keep investigating. Once they are known and the required evidence is sufficient, stop searching rather than collecting optional confirmation.
- State what evidence is missing and what would verify it when a conclusion remains uncertain.

## Documentation ownership

- `docs/**` owns internal technical and product-architecture documentation: protocols, canonical owners, data flows, compatibility, persistence, encryption, deployment internals, and contributor-facing architecture.
- `apps/docs/content/docs/**` owns published documentation for users, operators, self-hosters, providers, and public contributors.
- A behavior or contract change updates every materially affected canonical documentation page in the same coherent change, or the handoff explains why no documentation change was needed.
- Search for and update the existing canonical page before creating another. Do not leave similar-but-different explanations of the same concept.
- Documentation is a claim, not proof of implementation. Verify Happier behavior against the implementing code and the target release/channel before documenting it.
- Distinguish shipped, preview, development-only, experimental, deprecated, and planned behavior explicitly. Do not present an unreleased intermediate as available.

## Risk-weighted execution

- Risk is probability of error × cost of error × silence of failure. Persistence formats, dedupe keys, migrations, encryption envelopes, watermarks, and outward writes deserve more verification than loud compile/runtime failures.
- A possible race or edge case is not itself a correctness requirement. Before adding reliability or coordination machinery, state the reachable consequence without it, the authority and state affected, observability, existing recovery, and reversibility. Distinguish authoritative or non-reconstructible state from a projection proven refreshable from an available source; do not infer disposability from a `cache` label.
- A limit, quota, timeout, retry budget, or guard is product behavior. Name the actual resource or contract it protects, derive it from that boundary rather than a nearby number, and specify what happens when it fires. Preserve useful valid data through bounded projection, truncation, or explicit incompleteness when safe; reject only when correctness, security, or an external/platform contract requires it.
- Before implementation, name the load-bearing facts whose falsity would make the change unsafe or incorrect, prioritizing the two or three most damaging or least visible failure points. Design checks that can falsify those facts at the lowest practical real boundary.
- A fallback, retry, downgrade, or `catch` that cannot be observed in production is itself a defect: report it on a signal that is on by default, or fail loudly instead. A path gated behind opt-in telemetry is unobserved.
- Coalescing, de-dupe, and cache keys must include every input that changes the result, and only work guaranteed to settle may be coalesced — one hung shared promise poisons every later caller. A read-await-write cache without in-flight sharing lets N concurrent callers each do the whole job, and a batch or threshold API called one item at a time silently disables the decision it exists to make.
- Audit boring mechanical stretches as deliberately as the interesting core.
- For implementation work:
  1. establish current behavior and the canonical owner;
  2. inventory existing coverage and choose the smallest meaningful RED test when behavior changes;
  3. make the smallest coherent systemic change;
  4. run the narrowest relevant GREEN check;
  5. broaden validation according to risk;
  6. self-review for bypasses, duplicate paths, neighboring cases, and environment gaps.

## Scope-preserving solution economy

- Establish the complete authorized outcome before optimizing the solution. Explicit user requirements and approved-plan obligations—including integration, migration, removals, compatibility, UX, security, accessibility, platform behavior, performance, testing, and validation—are not optional complexity. Simplify only inside that boundary; changing an approved outcome requires the normal clarification or amendment process.
- Solution economy does not mean localism. Scope follows the required behavior, invariant, canonical owner, and materially affected corridor—not only the file, function, package, or user-visible path named in the request. A change is incomplete when it repairs the named path while leaving the same reachable defect, divergent decision, bypass, or split-brain elsewhere. After fixing a defect, use the defect itself as a search key: enumerate every other caller, instance, and platform build of that concept and record each as fixed or explicitly exempt. A comment or local workaround describing a hazard is a sweep trigger — the sibling call sites face the same hazard unguarded.
- Before adding code, files, abstractions, dependencies, configuration, state, or coordination, consider the options in this order:
  1. add nothing when the complete requirement already holds or the proposed mechanism is speculative;
  2. fix, reuse, refine, consolidate, or replace through the canonical owner, migrating every materially affected consumer and removing active competing owners or bypasses;
  3. use the language or standard library;
  4. use a native platform capability when it satisfies every affected product surface and contract;
  5. use an existing dependency already owned by the affected package when it reduces total lifetime complexity;
  6. otherwise add the smallest clear, coherent, consumed implementation.
- Choose the earliest option that fully satisfies the complete contract and minimizes total lifetime complexity. Do not force an earlier rung when it worsens ownership, UX, compatibility, security, performance, platform behavior, or maintenance.
- When a deliberately simpler implementation relies on a bounded scale, topology, platform, or lifecycle assumption, encode that assumption through a type, invariant, assertion, or test when practical. Otherwise add a narrow owner-local explanation of the current ceiling and the observable condition that would invalidate it; do not build the hypothetical upgrade path or create a new debt ledger without a real requirement.
- This discipline governs solution selection. It does not cap discovery, testing, QA, security analysis, compatibility validation, review findings, documentation, or an explanation the user requested.

## Durable design and justified complexity

- Optimize for total system complexity and code health over the expected lifetime, not the smallest diff. A coherent fix may be broad or difficult; do not preserve a wrong owner, active split brain, or fragile state model merely to keep the patch small.
- Fix the owning cause rather than adding a workaround, duplicate path, or similar-but-different implementation. Design from the canonical owner and caller-visible contract so new behavior becomes a natural extension of the system rather than a bolted-on exception.
- Before adding a protocol, state machine, registry, table, lease, credential, generation, gate, or parallel path, name the reproduced failure or live consumer it serves and why the existing owner cannot enforce the contract. Apply the deletion test: if removing the mechanism removes only complexity while the required behavior still holds, do not build it.
- Land behavior as the smallest consumed vertical through its real entry point, owner, and output. Do not build a dormant horizontal replacement spine and weave its consumer branches into live paths while its producer or activation remains absent.
- Optimize for fewer concepts, decision-makers, branches, dependencies, invalid states, failure paths, and facts callers must know—not the fewest characters, lines, files, tests, or diff hunks. Prefer direct idiomatic code over clever one-liners.
- A broad refactor is not overengineering when evidence shows it is necessary to establish one authoritative behavior, migrate consumers, remove duplicated decisions or active split-brains, eliminate invalid states, or prevent predictable divergence. Do not absorb unrelated debt, but do not classify necessary systemic work as unrelated merely because it crosses files or packages.
- Typed models, state machines, registries, lookup tables, interfaces, and adapters are tools, not defaults or anti-patterns. Use them when observed domain variation, lifecycle, ownership, or invariants justify them and they remove distributed branching, duplicated rules, lockstep edits, or invalid states.
- A broader refactor is justified when evidence shows repeated or divergent logic, recurring special cases, cross-layer leakage, callers changing in lockstep, an interface exposing implementation knowledge, or repeated implementation friction caused by the current shape. Name that evidence and the complexity the refactor removes.
- Reject an abstraction when it adds concepts, modes, configuration, dependencies, failure paths, or indirection without reducing caller knowledge, duplicate decisions, branching, lifecycle risk, or future change cost. A single implementation is a reason to examine the seam, not an automatic veto; a real external boundary or enforced invariant may justify it.
- Do not centralize coincidental similarity across distinct bounded contexts. Parse and normalize at boundaries, enforce domain rules in the domain owner, and keep adapters thin unless behavior truly belongs there.
- If the domain is inherently complex, model that complexity explicitly rather than hiding it in simplistic local code that pushes the burden into callers, synchronized flags, compatibility paths, or operations.
- When a change establishes a new owner, crosses package boundaries, introduces persistence or concurrency, or materially changes a public interface, write the intended caller-visible usage first, derive interfaces and placement from what callers should know, and compare plausible designs. If implementation repeatedly fights the chosen shape, stop and redesign; for routine work, follow the existing owner and patterns.
- If the systemic fix is genuinely blocked, mark `[blocked]` and explain the required owner-level change; do not present a local mitigation as complete.

## Compatibility and version skew

- Use `.agents/skills/happier-compatibility` and read `docs/compatibility.md` when a change affects cross-component wire behavior, persisted/session/settings formats, schemas or migrations, feature/capability negotiation, installer/service state, upgrades, coexistence, or rollback.
- Compatibility obligations come from active released stable/preview component contracts and explicitly supported older releases. Resolve each component from immutable tags plus artifact/deploy evidence; rolling tags are only discovery pointers. `dev` builds, abandoned experiments, and undeployed internal paths are not lasting obligations unless a repository-specific predecessor rule says otherwise.
- Map affected producers, consumers, readers, writers, and persisted artifacts. Distinguish wire, semantic, persistence, and operational compatibility; preserve the seam, not old internal architecture.
- New readers accept supported released shapes and new writes use the canonical current shape. Require old readers to accept new writes only when mixed-version coexistence or rollback makes that direction reachable.
- New clients must capability-negotiate or degrade safely against supported older servers. For ordinary changes, new servers preserve released old-client operations they can still execute safely; prefer operation-scoped upgrade results over connection-wide rejection.
- If a genuinely major incompatibility makes old-client/new-server support expensive, stop for an explicit developer/product decision between graceful degradation, a documented client update requirement, and a heavier compatibility transition. Agents must not silently choose either forced upgrades or heavy compatibility machinery, and must not manufacture client-update requirements for routine server changes.
- For incompatible format or protocol transitions, use the narrowest necessary prepare/expand → activate/migrate → contract sequence. Compatibility adapters remain seam-owned, delegate domain decisions to the single canonical owner, and record their source release/predecessor plus removal condition.
- Validate affected reachable old/new directions without manufacturing Cartesian matrices, shims, fixture families, or fallbacks for seams the change cannot exercise. Prefer one discriminating test per material direction plus risk-selected end-to-end flows, using real artifacts or provenance-pinned vectors rather than reconstructed current-type fixtures.

## Multi-agent and Git safety

- Assume the checkout is actively shared and uncommitted changes are normal. They may be concurrent work, but they do not reserve a file; inspect and preserve them while adding compatible in-scope changes.
- Never remove, revert, overwrite, or “clean up” unrelated work. If an unrelated change looks accidental, ask before altering it.
- Do not create ad-hoc summary, report, or status files; use the final response or an approved project location.
- Never switch branches in the primary checkout.
- Do not create or delete branches unless explicitly requested.
- Never run or emulate destructive cleanup without explicit approval, including `git reset`, `git restore`, `git clean`, `git checkout`, `git switch`, or any command intended to discard work.
- Use read-only Git commands for inspection unless the user requested a mutation.
- Never stage (`git add`) or commit except when executing an explicitly requested commit (from the user or an approved plan). When a commit is requested, assemble it by explicit pathspec from current bytes; never trust or wholesale-commit an inherited index.
- Ordinary commits and Git pushes, including PR-stewardship pushes, use the current machine's Git identity and configured Git credentials. Verify `git config user.name` and `git config user.email` before the first commit, never rewrite them to a GitHub bot or another contributor, and stop rather than inventing a missing identity. GitHub API/UI mutations use `happier-bot` through `.agents/skills/happier-github-ops`. Its isolated `ghops git push` transport remains available only when exact or bounded standing authorization explicitly selects the bot as push actor; never infer that exception from ordinary commit/push authority, PR stewardship, or a machine-credential failure. When rebasing another author's work, preserve every original author while the current machine identity remains the committer and default push actor, and never alter persistent Git identity.
- Add a verified `Co-authored-by:` trailer only when that specific commit materially incorporates another person's code, patch, design, causal diagnosis, decisive reproduction, or substantially adopted fix direction. PR/issue authorship, participation, review ownership, a routine report, generic suggestion, requested log, or confirmation alone does not justify co-authorship. Evaluate attribution commit by commit; acknowledge helpful non-code contributions publicly even when they do not meet the commit-attribution threshold.
- For shared multi-program work, record one active authority for each conceptual seam. A dependent plan consumes that owner's contract; two plans must not independently design or write the same live seam. Plans that overlap existing work name `Supersedes:`, `Extends:`, and `Consumes:` relationships or stop for adjudication.
- A long-running multi-program effort maintains one current-status pointer in its existing canonical tracking document (current integration boundary, blockers, and superseded predecessors). This is a section in an existing file, not a new registry, lease system, or mandatory artifact for routine single-agent work.
- A dormant or gated program must not half-land changes to live dispatch, session lifecycle, persistence, migrations, daemon startup/shutdown, or other runtime paths. Such a live-path change is its own consumed vertical with RED evidence and the risk-appropriate composed/live gate.

## Testing: contract value, not test volume

### Behavior-change rule

- Any production behavior change requires TDD: write or update the relevant test first, verify RED for the intended reason, implement minimal GREEN, then refactor with tests green.
- Content-only Markdown/template/copy changes, styling-only changes without interaction/accessibility/visibility impact, and mechanical renames/moves/formatting do not require new tests; run relevant existing checks.
- TDD proves an observable behavior contract. It does not require a new test for every changed function, branch, helper, or file.

### Test selection and quality

- Inventory existing tests by owner/symbol, route/command, config or feature id, component, error code, and package harness before writing a test.
- Prefer strengthening or consolidating the most relevant existing owner-level test over adding overlapping coverage.
- A valid RED test fails because the intended behavior is missing or wrong. Failure from fixtures, mocks, setup, wording, syntax, or unrelated runtime errors is not valid RED.
- Test through the canonical/public owner boundary when practical and exercise real internal logic.
- One discriminating test is more valuable than many shallow permutations. Add cases only for materially distinct contracts, boundaries, or failure modes.
- A useful test distinguishes the intended implementation from at least one plausible incorrect implementation. For a load-bearing assertion, prove that by execution rather than by reading: break the behavior and watch the test go red. A load-bearing test never observed failing is not evidence.
- Do not add runtime tests that merely restate TypeScript types, mirror implementation structure, assert pass-through wiring or incidental call counts, or police wording, Markdown, whitespace, raw styles, or example values.
- Assert stable outcomes, state, error type/code/shape/status, and published contracts rather than implementation details or exact prose.
- Remove or consolidate redundant tests introduced or exposed by the change.

### Mock boundaries

- A system boundary is outside the owning process’s deterministic internal logic: third-party APIs/services, OS/process adapters, platform/native SDKs, network transports, persistent databases, clocks, randomness, or environment adapters.
- Internal domain services, parsers, normalization, reducers/selectors, stores, orchestration helpers, provider catalogs, feature decisions, and state machines are not mockable boundaries.
- Use canonical package testkits before creating boundary mocks. When a boundary mock is necessary, preserve the real internal path beneath it, mirror the real schema, document why, and assert outcomes/state rather than only calls.
- UI tests prefer `apps/ui/sources/dev/testkit/**` and `@/dev/testkit` for shared boundaries.

### Validation

- Use the smallest relevant slice for RED/GREEN loops.
- Validate implementation directly from the current moving source and the existing development stack. Feature implementation, review, and QA must not create, freeze, package, install, identify, or certify a separate release representation of the source; actual release automation owns producing and verifying what it publishes when a release is explicitly dispatched.
- Before handoff, run the touched package’s typecheck/build-enforcing lane and the relevant broader test lane.
- User-visible behavior also needs the risk-appropriate live gate when runnable; use `.agents/skills/happier-testing` for lane, rerun, device, browser, and live-validation rules.
- For user-visible or environment-dependent programs, name the composed live recipe and required runtime identity before implementation. A green owner test, registered-but-uninvoked wiring, or a still-running command is not completion; run the recipe against the observed loaded source/build identity or mark it `[blocked]` with the missing prerequisite.
- Never claim a test, typecheck, build, or manual QA passed unless it actually ran. Report skipped or unavailable validation and why.

## Type safety and code hygiene

- Keep TypeScript strict; do not weaken `tsconfig` or type rules to pass checks.
- `@ts-ignore` is forbidden. Use `@ts-expect-error` only on the exact expected-failure line with a short rationale.
- Prefer inference for local variables, private implementation details, and obvious return values. Add explicit types when they prevent widening, expose an invariant, stabilize inference, or define an exported/public, wire, persistence, package, or security-sensitive contract.
- Production `any` types and broad `as any` casts are forbidden except at a narrowly isolated genuinely untyped external boundary or boundary fixture/harness with a one-line rationale. Prefer `unknown`, validate it, and narrow to a real type immediately.
- Prefer `satisfies`, explicit interfaces, typed fixtures, and canonical schemas over casting.
- No production TODO/FIXME placeholders, stray debug output, dead code, or commented-out blocks.

### TypeScript compiler ownership

- First-party compilation uses TypeScript 7 from `@typescript/native` through repository/workspace scripts. For an ad hoc development invocation, use `node scripts/workspaces/runTypeScriptCli.mjs ...`.
- Never invoke bare `tsc`, `npx tsc`, `node_modules/.bin/tsc`, or `typescript/bin/tsc`; those can select the retained TypeScript 5 API package.
- `scripts/workspaces/typescriptCommand.mjs` is the only compiler-selection owner. Orchestrators import it or use `runTypeScriptCli.mjs`/`buildTypeScriptPackageDist.mjs`; never add compiler fallbacks.
- The `typescript` dependency remains on 5.9 for compiler-API consumers. Do not use it for compilation, remove it, or upgrade it independently without inventorying and validating those consumers.
- The direct-`node` prohibition applies to shipped product runtime paths, not documented repository development commands.

## Files, folders, and moves

- Keep code with its natural owner and prefer focused modules in cohesive domain folders.
- Reuse the nearest real domain folder before creating a top-level bucket; do not create taxonomy-only or one-function folder ladders.
- Use folder context to keep filenames short and purpose-revealing. Avoid vague `utils`, `helpers`, `manager`, `misc`, or `common` names unless a narrow parent supplies the missing meaning.
- Keep one-off helpers near their only use; shared modules must represent a real shared concept.
- Split by responsibility/domain boundary, not mechanically by function or noun.
- Preserve package aliases and export boundaries during moves; do not replace stable aliases with fragile long relative imports.
- Delete obsolete files and paths when the canonical migration makes them unnecessary.

## Path canonicalization

Do not hand-roll home-directory handling. Use the owning helper:

- UI absolute expansion: `apps/ui/sources/utils/path/pathUtils.ts#resolveAbsolutePath`
- UI display formatting: `apps/ui/sources/utils/sessions/formatPathRelativeToHome.ts`
- CLI env/path expansion: `apps/cli/src/utils/path/expandHomeDirPath.ts`
- CLI handoff normalization: `apps/cli/src/session/handoff/paths/sessionHandoffPathNormalization.ts`

For path equality, identity, dedupe, or persistence keys, accept both `~/...` and `~\\...`, trim both separator styles at the home boundary, normalize mixed separators, and guard sibling-prefix collisions such as `C:\\Users\\alice` versus `C:\\Users\\alice2`.

## Provider and catalog architecture

When touching provider behavior, read `docs/agents-catalog.md`.

- Shared provider facts belong in `packages/agents/*`.
- CLI executable wiring belongs in `apps/cli/src/backends/catalog.ts` and `apps/cli/src/backends/<provider>/**`.
- UI provider composition belongs in `apps/ui/sources/agents/registry/**` and `apps/ui/sources/agents/providers/<provider>/**`.
- Protocol-owned provider policy/defaults belong in `packages/protocol/src/providers/<providerId>/**`.
- Shared/core code must not branch on provider ids when a catalog entry, adapter hook, or registry result can own the variation.
- Extend the canonical entry/hook shape and implement provider-specific behavior in the provider-owned module.

## Feature, encryption, and runtime triggers

- Feature work: read `docs/feature-gating.md` before deciding that a gate is appropriate. Refactors and replacements are in-place by default; genuine new/experimental capabilities use canonical feature ids/decision helpers, enforce dependencies centrally, gate only on `readServerEnabledBit(...) === true`, and treat missing/malformed bits as disabled. `capabilities` are diagnostic, not gates.
- Encryption/storage work: read `docs/encryption.md`. Parse `{ t: 'encrypted', c }` and `{ t: 'plain', v }` explicitly, enforce storage-mode/content compatibility at write boundaries, and keep sharing/data-key requirements mode-correct.
- Runtime/install/package work: read `docs/binary-runtime.md` and `docs/cli-architecture.md`. Shipped paths must work without system Node/package managers, detection/install/validation/spawn must share one source of truth, and the importing package owns each dependency. Published hosts bundle the internal workspace dependency closure.

## Context-efficient tools and retrieval

- Do not reduce required discovery to save tokens. Search broadly when needed to find canonical owners, callers/readers/writers, tests, duplicates, compatibility paths, or unknown scope.
- Keep broad computation separate from transcript volume: prefer matching-file inventories, totals, grouped/deduplicated results, and relevant excerpts over dumping every matching line.
- When `rtk` is available and supports the intended command, prefer `rtk <command ...>` for potentially verbose searches, file/log reads, Git operations, tests, container commands, and database queries.
- Do not spend unrelated task turns installing or debugging RTK. If unavailable or semantics/evidence require raw output, use a bounded raw command.
- Do not add extra model/tool turns merely to save a small output; use a command-aware reducer or one bounded command when possible.
- Seek minimum sufficient evidence. After each result, identify which required fact remains missing and retrieve only for that gap, an explicitly exhaustive request, or a materially unsupported claim. Stop when the requested outcome and evidence bar are satisfied; do not search for reassurance, optional examples, or better phrasing.
- Empty, partial, or suspiciously narrow output is not proof of absence; try one or two meaningful alternative retrieval paths.
- Compression is a preview, not destruction of evidence. For failures, ambiguity, security/data/schema work, or exact final verification, inspect the saved raw artifact or rerun a targeted raw command.

## Current documentation

- Use available Context7/current official documentation when library behavior is version-sensitive, post-training, uncertain, or material to correctness.

## Adversarial review and handoff

- Run a compact in-place `.agents/skills/attack-conclusion` self-check before every non-trivial handoff: test an alternative cause, neighboring cases, blast radius, environment gap, and hypothesis lock. Routine author self-checks create no separate reviewer, workspace, report, or approval gate; record only changes they caused and unresolved risk.
- For deep reviews, plan-completeness audits, worktree/feature audits, or review-plus-QA/fix loops, use `.agents/skills/happier-review` so the target basis, affected corridor, findings, QA obligations, and evidence are handled coherently.
- The orchestrator checks delegated outputs against current source/diffs and deciding evidence. Re-derive load-bearing delegated claims at the next substantial boundary; scripts or focused inspection may verify deterministic inventories and mechanical transformations. Release, schema/data, security-critical, and user-visible ship gates require a different reviewer with re-measured decision-material evidence.
- Review to refute, not confirm. Lead with any finding; if none, state what was attacked and how.
- Review findings are candidate claims, not work orders. Re-derive each claim, then adjudicate impact, response, and authority separately: a real defect may have an overengineered proposed fix, a material plan deviation remains `AMENDMENT_REQUIRED`, and a mechanism-sized response needs a reproduced failure, reachable risk, or named live consumer.
- Review may inspect moving, dirty, partial, or completed work without freezing, hashing, leasing, or snapshotting it. Record a concise observed basis; moving-work review is advisory, while completion verdicts reconcile materially affected observations against current implementation and evidence. Batch formal independent review at substantial integration boundaries, explicit user requests, and high-risk ship gates—not every lane or microchange. After fixes, review the finding delta and affected corridor; repeat fully only when contract, architecture, scope, boundary, or risk materially changed.
- Final reports lead with the outcome, then evidence-pointed reasoning, then residual risk.
- Verify every requested item is covered or marked `[blocked]`.
- Report checks actually run and validation that could not run.
- For behavior changes, repeat the split-brain audit across the touched corridor; name the canonical owner and every duplicate, bypass, legacy, or compatibility path removed or intentionally retained, including why a retained path is not a competing owner.
- Ensure no unapproved `*_SUMMARY.md`, `*_ANALYSIS.md`, or similar report file was created.
- Use Conventional Commits for commits and squash messages: `<type>[optional scope][!]: <description>`.

## Critical reminder

Before finalizing:

- Preserve existing work: do not discard unrelated changes or switch branches in the primary checkout.
- When we talk about overengineering, the target is not the feature; it is the underlying implementation logic. Start from the feature's real intent and requirements, preserve those outcomes, and ask whether any disproportionate machinery exists only to satisfy unreal, assumed, speculative, or unreachable requirements. Choose the simplest implementation that satisfies the real requirements. Before adding logic, inspect whether the behavior can be satisfied by or folded into existing canonical logic through reuse, extraction, refinement, extension, consolidation, or refactoring; reject split-brain, similar-but-different, or parallel paths when an existing owner can satisfy the need.
- Confirm the canonical owner, relevant consumers, and surrounding same-concept paths were inspected; refactor touched split-brains and do not leave a competing active implementation or bypass.
- If behavior changed, prove RED → GREEN with the smallest meaningful owner-level test, mock only genuine system boundaries, and run relevant validation.
- Report the outcome honestly, including failed or skipped checks, blockers, and residual risk.
