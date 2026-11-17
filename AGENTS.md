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

**Search wide, decide once.** Discovery stays broad: find every affected product surface, entry point, caller and consumer, the existing owner, and every same-concept split-brain in the touched corridor, and do the refactor that leaves one owner. Enforcement stays narrow: each fact (authority, admission, currentness, readiness, availability, limits, lifecycle state) is decided once by its canonical owner, and every surface consumes that owner's typed result instead of re-deciding or re-checking it. Admitted work is checked once at admission; the server authorizes each later call with a cheap "this admitted job is still active" lookup rather than a fresh permission evaluation, and the executor stops on its local cancel signal. A rule that says a fact must be exact, current, fresh or fail closed also names the one place that decides it. A discovered surface is a consumer of the owner and a path to test once, never a place for its own copy of the check. The same holds for recommendations: a review, QA or design finding that proposes a new flow step, control, component, check, helper or Action names the existing owner, pattern or component it reuses; when none fits, it says so and the change goes to that concept's owner, never into the reviewed surface as local logic.

## Tier 0 — the ten invariants

1. Git safety: never switch branches, reset, restore, clean, stash, or otherwise move local work out of the primary checkout. `git stash` is repo-wide regardless of the current directory — it sweeps every tracked modification in the shared checkout, thousands of files belonging to other lanes, and is forbidden even though it "saves" rather than deletes.
2. Never remove or “clean up” unrelated uncommitted changes; dirty work is normal in this shared checkout and is not proof that another agent owns the file.
3. Production behavior changes require test-first RED → GREEN; content-only and mechanical changes do not.
4. Mock genuine system boundaries only, never internal logic.
5. Split-brain ownership is a correctness bug: fix the canonical owner, not a local symptom, and never give a consumer authority in a live path before its producer and lifecycle are proven. Evolve SDK and protocol seams only under the [protocol-evolution doctrine](docs/compatibility.md#sdk-protocol-evolution).
6. Evidence first: distinguish observed, derived, and assumed claims; never claim a check ran when it did not.
7. Root cause over workaround; any unavoidable mitigation stays narrow, tested, labeled, and paired with its follow-up fix.
8. Feature gates fail closed when used (decided once by the canonical feature-decision helper, not re-checked by each consumer), but refactors replace the canonical owner in place unless a gate is justified by a genuine new capability, rollout control, or supported compatibility transition; encryption envelopes are parsed explicitly rather than assumed.
9. Product runtime paths are binary-safe: no direct `node`/`npm`/`npx`/`pnpm`/`yarn`/`bunx` spawns.
10. Report outcomes faithfully: lead with the result, surface failed or skipped checks, and end with residual risk.

## Choose good compromises

Optimize for fewer concepts, decision-makers, branches, dependencies, invalid states, failure paths, and facts callers must know—not the fewest characters, lines, files, tests, or diff hunks. Prefer direct idiomatic code over clever one-liners. Start with the cheapest mechanism that serves the flow: the owner's existing decision, one check at the point of effect, an idempotency key, a retry the person can see, or best effort with a visible warning.

- **Validate at the trust boundary, then trust internal data.** Authorize and validate where a request or data crosses a trust boundary: another person, Account, Team member or link recipient; external input; the server toward E2EE content. Behind that boundary there is no re-validation, no re-read of your own writes, and no re-check of a fact its owner already decided. Admitted work is checked once at admission; the server authorizes each later call with, at most, a cheap "this admitted job is still active" lookup (where no server-readable active-job authority exists, the signed admission proof plus the executor's local cancel suffices), and the executor stops on its local cancel signal.
- Revocation and other withdrawals take effect at the next natural boundary: the next request or admission, a new Session or deploy, a reconnect, the next secret acquisition. Work already admitted finishes or the person stops it. Only open-ended interactive access with no natural end (a live terminal, an open stream) closes when access is revoked. Do not build mid-operation re-checks or kill-on-revoke machinery for other cases.
- **Mechanisms that need a reproduced failure.** Fences, generations, leases, receipts, custody records, quarantines, new identities, multi-phase admission, per-step re-authorization, exactly-once settlement, cross-restart durability, coordination protocols, state machines, registries, tables, credentials, gates, parallel paths, new timers, and custom timeouts, caps or retry budgets are built only for a named reproduced failure, released contract, owner ruling, named cross-person threat or live consumer, and only when the existing owner cannot enforce the contract. A possible race or edge case is not itself a correctness requirement. Before adding one, state the reachable consequence without it, the authority and state affected, observability, existing recovery, and reversibility. Distinguish authoritative or non-reconstructible state from a projection proven refreshable from an available source; do not infer disposability from a `cache` label. Apply the deletion test recursively: if removing the mechanism removes only complexity while the required behavior still holds, do not build it, and remove the chain that exists only to support it. "In case", "defense in depth", "possible race" and "future consumer" are not evidence.
- **References are the yardstick.** When a plan or intent review cites reference projects, compare each mechanism with what they do for the same user flow. A mechanism none of them has needs a named Happier-specific requirement (E2EE, an untrusted daemon, several Machines or Accounts, Teams, agents acting for a user) and its concrete harm, or it is removed. References show what is enough; they never supply requirements, add scope, or lower a named security requirement.
- A limit, quota, timeout, retry budget, size cap, truncation threshold, or guard is product behavior. Before adding or changing one, find the canonical lifecycle/resource owner and reuse its budget or boundary. Do not invent a local default or "safety" ceiling from intuition, a nearby value, a test duration, or one observed sample; a subordinate phase must not impose a shorter competing cutoff on its containing operation without a separate contract. If no correctness, security, external/platform, storage, or measured resource boundary requires a limit, omit it. When a bound is required, name the protected resource or contract, derive the value from that boundary, make firing observable, specify recovery, and test both the boundary and valid behavior near it. Preserve useful valid data through paging, bounded projection, truncation, or explicit incompleteness when safe; reject only when the owning contract requires rejection. There are no numeric budgets for plan size or for call, check or mechanism counts: a big feature may need a big plan and a complex flow many calls. Count tests assert the design's shape instead (one admission per request, zero authority re-checks per step, work proportional to real units such as services or changed items, not multiplied by layers or retries) and record the measured counts.
- A frequency or cost claim ("rare", "never in practice", "cheap") that accepts or rejects machinery must be measured or cited. Before adding a process boundary, worker or queue, measure where the cost comes from and show the boundary removes it rather than moving it.
- **Accept the glitch.** A rare, visible, recoverable glitch beats permanent complexity. Name each race or edge case you deliberately leave unhandled, and why it is visible and recoverable, in the plan gate or the handoff. This never covers silent loss of authoritative data, exposure to another person, secrets in transcripts or logs, or E2EE.

## Instruction routing

1. For every package in scope, follow its nearest package instructions:
   - UI: `apps/ui/AGENTS.md`
   - CLI: `apps/cli/AGENTS.md`
   - Server: `apps/server/AGENTS.md`
   - Stack: `apps/stack/AGENTS.md`
   - Docs: `apps/docs/AGENTS.md`
   If the relevant instructions are not already present in active context, read them before changing that package. Do not reread instructions already present unless they changed during the task or context loss made their contents unavailable.
2. Use repository skills when the requested task matches their purpose, not merely a keyword. Reuse unchanged instructions already active in context; after context loss, recover only the missing applicable instructions and task state. Do not reload a skill or its references at every lane, phase, or handoff. Use the existing routing:
   - `.agents/skills/happier-plan` only for an explicit request to create, replace, or materially refine a repository plan; complexity alone is not a trigger.
   - `.agents/skills/happier-implement` for source changes. Add `.agents/skills/happier-implement-plan` when executing an approved plan; it preserves plan authority rather than redesigning it.
   - `.agents/skills/happier-plugin-authoring` before scaffolding or changing a plugin through the public authoring workflow.
   - `.agents/skills/happier-commit-worktree` only for a user-requested large or continuously changing worktree commit campaign, not an ordinary scoped commit.
   - `.agents/skills/happier-review` is the only general Happier review/QA orchestrator. The archived `review-protocol` and `code-reviewer` skills must not be invoked.
   - `.agents/skills/happier-slopo` for advisory embedding-assisted duplicate discovery; similarity alone is never a defect, refactor order, completeness verdict, or CI gate.
   - `.agents/skills/happier-pr-steward` for user-requested 0.3 pull-request stewardship; it composes `happier-review` and the mutation authority in `happier-github-ops`.
   - `.agents/skills/happier-testing` for TDD, test quality, lane selection, and live validation.
   - `.agents/skills/happier-performance` for any change on a per-arrival, per-request, per-render or idle path, and for profiling or optimization: performance invariants, anti-pattern checks, count-based cost contracts and live measurement.
   - `.agents/skills/happier-docs` for internal or published documentation.
   - `.agents/skills/happier-ui-craft` before designing, building, or reviewing user-facing UI (including plugin UI); it turns `DESIGN.md` into concrete decisions and the side-by-side validation loop.
   - `.agents/skills/happier-instruction-eval` only for an explicit instruction-variant evaluation or an approved evaluation boundary.
   - `.agents/skills/happier-issue-triage` for read-only issue retrieval, clustering, and routing; `.agents/skills/happier-issue-diagnose` for deep read-only diagnosis. Issue correction, release follow-up, labels, closure, attribution, and reporter handoff follow `docs/issue-triage.md`.
   - `.agents/skills/happier-controlled-stack-qa` only after an explicit request for a dedicated isolated/stable/snapshot-backed/manual-restart QA stack; reuse that stack for the session unless the user requests replacement.
   - `.agents/skills/happier-remote-work` after explicit remote-compute authorization, which lasts for the user session unless narrowed or revoked.
   - `.agents/skills/happier-diagnose` for read-only runtime/support incidents; requested source fixes proceed through `happier-implement`.
   - `.agents/skills/happier-compatibility` for wire, persistence, mixed-version, upgrade, rollback, and `../0.2` → `dev` seams.
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
- Cleanup plans produced by an owner-approved intent campaign are approved by default when they follow that campaign's approved rules: check once at admission with server per-call authorization and a local cancel signal, revocation at the next natural boundary, no invented limits, reference comparison, and no lost user feature. Only real product questions and the named security reviews (authorization, credential, encryption) go to the owner. The grant covers those cleanup plans only; it does not approve other plans or instruction changes (`.project/OWNER-RULINGS.md`, 2026-10-29).
- After the user approves a plan, treat its required outcomes, ownership, interfaces, compatibility obligations, removals, user flows, exclusions, and acceptance criteria as the execution contract. Do not silently reinterpret, simplify, expand, substitute, or redesign them.
- Mechanism-sized plan decisions follow **Choose good compromises** and trace to an approved requirement, constitution rule, external contract, reproduced failure or reachable derived risk; another proposed mechanism, future consumer, generalized reuse opportunity or architectural completeness is not a terminal justification, and if the root requirement disappears its dependent chain goes. User approval authorizes the plan as a whole; only unresolved product decisions or material amendments require item-level re-ratification.
- Before acting on an approved plan, read its gate, your unit and the sections that unit's "Also read" line names (the whole plan when it is small enough to read whole) if they are not already present in active context, orient to the assigned lane and current load-bearing code, and begin implementation. Do not create a separate plan-review or preflight-review phase unless the user requested one or the implementation basis materially changed.
- Implementation may update designated execution status and evidence, and use best judgment only where the plan intentionally leaves details open. It may not change the approved contract, acceptance criteria, or design decisions; material ambiguity requires clarification, and unrelated discoveries are reported without expanding scope.
- A mechanism clause in an approved plan that contradicts a later owner ruling on mechanisms (OWNER-RULINGS Process) is rewritten in place by the implementing lane or program lead, citing the ruling; this is not an amendment.
- If primary evidence makes an approved requirement unsafe, contradictory, impossible, unable to serve its intent, or dependent on a materially different topology, owner, external dependency, compatibility transition, or product tradeoff, pause affected work, record the evidence, and propose the smallest amendment. Increased effort alone is not material. Evidence may challenge but never supersede the plan: use `AMENDMENT_REQUIRED` until the user approves a documented replacement, then `SUPERSEDED_BY_APPROVED_AMENDMENT`. Continue only independent work that cannot prejudge the decision.
- For delegated implementation, each meaningful lane reads the approved plan's gate, its own unit and that unit's "Also read" sections unless they are already in active context, then receives a concise self-contained lane brief with exact ownership, paths, dependencies, acceptance checks, validation, and stop conditions. Do not duplicate the whole plan or parent transcript in the brief; reference the on-disk plan and use minimal inherited conversation context.

## Efficient execution and uncertainty resolution

- Route potentially broad read-only repository work (`rg`, `find`, inventories/counts), tests, typechecks, lint/static analysis, and builds that write only ignored artifacts through `./apps/stack/bin/hstack-exec` (`--script=<local-script>` or `-- <command>`); never invoke a `*:local` script directly because those are executor implementation targets. Keep source/Git mutations, generators/codemods/formatters, databases/migrations, Stack lifecycle, devices/simulators, and unforwarded secrets local; see `.agents/skills/happier-remote-work` for exact-target and sync-barrier exceptions.
- For those routed categories, do not invoke `*:local`, compiler, test-runner, or broad-search entry points directly. Pass them through the wrapper; `--local` is the only per-invocation local escape hatch.
- Do not invoke Turbo's `typecheck:source:finite` or package `typecheck:finite` implementation tasks directly. They intentionally omit dispatch because the public `typecheck` owner has already selected an execution host; use the public `typecheck` script or wrap an ad hoc check with `hstack-exec`.

- Use maximum useful parallelism: keep ready independent retrieval, implementation, QA preparation, and verification moving when doing so shortens the critical path. Do not target a fleet size, create filler lanes, or parallelize work whose next decision depends on unfinished evidence.
- When model-selectable delegation is available, use the **user-approved implementation, review and QA models for the active tool**, at a high reasoning effort, for substantial bounded implementation, diagnosis, migration, test, and documentation lanes—not only one- or two-task probes. Raise the effort tier when a lane is unusually broad, stateful, or high-risk. The tool-specific model roster is owned by that tool's instructions, not by this constitution: for Claude Code it is `.claude/CLAUDE.md`, whose current ruling governs and overrides any model named here. Do not assume a direct local model alias exists for a given route. Reserve the strongest available tier for orchestration, cross-owner synthesis, architecture/security/release adjudication, and substantial integrated finding-delta review; do not have it redo an already verified implementation or review every microchange—re-derive only decision-material claims at the next meaningful boundary. The orchestrator continues ready integration work while delegates run rather than delegating and waiting idly.
- Coordinate only actual collisions: incompatible decisions at one live contract or conceptual seam, destructive rewrites/moves, generated outputs with one producer, or an exclusive mutable runtime resource. A dirty, previously touched or concurrently edited file or hunk is not a collision; re-read current bytes, preserve compatible work, and merge the change. Ask only when competing intents cannot be reconciled from the plan and evidence.
- Treat uncertainty as an investigation task. First ask whether the missing answer is empirical: if source, history, a focused prototype, test, measurement, log, runtime observation, or current primary documentation can decide it safely, retrieve that evidence. Ask only for a genuine product, preference, authority, or tradeoff decision evidence cannot settle, or unavailable external state. Mark `[blocked]` only after meaningful safe retrieval cannot resolve a decision-material ambiguity.
- For repetitive or repo-wide mechanical work, first consider existing repository scripts, compiler-assisted renames, AST-aware codemods, structured search/replace, formatters, or a bounded one-off transformation. Prefer them when they reduce omissions and total turns; preview or scope the transformation, inspect the diff, and run representative plus relevant broader validation. Do not build a codemod when a few direct edits are safer and faster.
- Amortize expensive validation across the smallest coherent batch that shares its build, generated output, or runtime. Intermediate implementation handoffs use focused RED/GREEN plus risk-selected adjacent checks; they may defer an expensive integrated or live lane only by naming the unrun check, the exact later boundary that owns it, and the prerequisite for running it. Deferred evidence cannot close a gate or support `VERIFIED_COMPLETE`.
- Tool batching, waiting, monitoring and resume rules live in `docs/agent-craft.md` §9 (moved there verbatim): batch independent known calls, wait on the operation's own completion signal instead of polling, keep working while it is pending, and resume a lane on its existing handle.
- Process artifacts are costs, not evidence. Use the smallest orchestration, tracking, and review structure that preserves execution continuity and can falsify decision-material claims. Do not create source/worktree/plan hashes, release-representation manifests, leases, receipts, custody logs, mirrored status systems, per-lane ledgers, task-count gates, or repeated review rounds unless an approved product or release protocol requires that exact mechanism. A feature plan cannot declare itself a release protocol to create this exception. Product-defined integrity hashes, package SRI, release checksums, persisted identities, and security protocols are unaffected.

## Product priorities

- Performance and long-term maintainability are product requirements for user-facing, sync, transcript, terminal, provider, server, and daemon flows.
- Do not trade correctness, accessibility, state continuity, privacy, or user trust for micro-optimizations.
- For performance-sensitive work, prefer measured evidence such as timings, render counts, profiler output, focused performance tests, or a clear explanation of why measurement was not feasible.
- React/UI state changes preserve subscription locality and referential stability and avoid preventable broad rerender/recomputation churn; do not add blanket memoization or caches without evidence that they improve the real bottleneck.
- Account and device settings hold preferences a person (or an agent acting for one) changes deliberately. Observed, derived, automatic, per-interaction, per-turn, per-event, last-used, history, cursor, counter, dismissal and progress state belong to the owning record, Session metadata, server-visible non-content metadata, or a device-local store. A settings consumer subscribes to the keys it reads through the owner's key-scoped subscription, never to the snapshot or version. Continuous controls commit once per gesture.
- Live state is pushed, not polled. The push, delivery, reconciliation, producer, polling and user-recovery rules that apply to every change on these paths live in `.agents/skills/happier-performance` §0 (moved there verbatim); a performance optimization never regresses user-visible behavior, freshness, continuity, accessibility, layout, platform behavior or recovery UX.
- Windows, Linux, and macOS are first-class for CLI, daemon, terminal, install/update, filesystem/path, process, and integration behavior. Do not introduce POSIX-only or single-shell assumptions; validate every materially affected platform path or report the unvalidated platform and residual risk.
- Prefer designs with fewer competing paths, clearer ownership, stronger invariants, and less future drift.

## Discovery and evidence before change

Before changing production behavior:

- Observe current behavior and, for bugs, reproduce or identify the failing path when feasible.
- Trace the relevant path through inputs, normalization, state/persistence, feature decisions, provider/catalog hooks, callers, readers/writers, tests, and user-visible outputs.
- Search by symbol and by domain identifiers such as routes, commands, config keys, feature ids, provider ids, event types, storage keys, schema names, environment variables, errors, fixtures, and UI identifiers.
- Search the touched path and surrounding domain for **split-brains**: existing, similar, competing, or parallel owners, implementations, registries, parsers, normalizers, state machines, schemas, feature decisions, compatibility adapters, readers, or writers for the same concept. A hand-copied list of another owner's schema keys, enum values, or hint facts is a split-brain too: derive it from the owner's export, because a silently stale copy fails as wrong behavior, not as an error.
- No inline arrays or literal checks of action ids outside the owning `actionIds*.ts` modules; consume the owner export or predicate. Advisory changed-file grep below: inspect candidate additions in the diff; it finds array candidates, may match other dotted strings, and is not exhaustive.

  ```bash
  ./apps/stack/bin/hstack-exec --local -- bash -lc 'git diff --name-only -z --diff-filter=AMR -- "apps/**/*.ts" "packages/**/*.ts" ":(exclude)**/*[Aa]ctionIds*.ts" ":(exclude)**/*.test.ts" ":(exclude)**/*.spec.ts" ":(exclude)**/*.d.ts" | xargs -0 -r rg -n -U --pcre2 "\[\s*[\x27\x22][a-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+[\x27\x22]\s*,\s*[\x27\x22][a-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+[\x27\x22]"'
  ```

- Change behavior through the established canonical owner; reuse, extend, refine, extract, consolidate, migrate, or remove there before adding logic.
- Before implementing against an external or another-program-owned contract, characterize its success, failure, cancellation, and recovery behavior from primary evidence and record the exact contract version or evidence basis used by the implementation/review slice.
- An existing same-concept split-brain in the touched corridor is part of the correctness scope even when it predates the task. Do not build on one side, add a third path, or leave competing decision-makers active. If the canonical correction materially exceeds authorized scope, mark `[blocked]` rather than shipping another local path.
- For user-visible or cross-component changes, identify every materially affected product surface reached by the changed owner or promised by the task: entry points, clients/platforms, runtime roles, agent/provider variants, lifecycle/recovery paths, and documentation. Mark unaffected surfaces not applicable with a reason. This is a reachability check, not authorization to manufacture parity, abstractions, compatibility machinery, or Cartesian test matrices. Route every surface found here through the one owner, then test each distinct path once; a surface does not get its own copy of the owner's check or guard.
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
- Canonical-page search, verification of documented behavior against code and release channel, and release-status labelling live in `.agents/skills/happier-docs` §3 (moved there verbatim).

## Risk-weighted execution

- Risk is probability of error × cost of error × silence of failure. Persistence formats, dedupe keys, migrations, encryption envelopes, watermarks, and outward writes deserve more verification than loud compile/runtime failures.
- Mechanism, revocation, limit and measured-claim rules live in **Choose good compromises** above; they apply here.
- Before implementation, name the load-bearing facts whose falsity would make the change unsafe or incorrect, prioritizing the two or three most damaging or least visible failure points. Design verification checks (tests, probes, observations) that can falsify those facts at the lowest practical real boundary; they are evidence, not additional product runtime guards.
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
- Solution economy does not mean localism. Scope follows the required behavior, invariant, canonical owner, and materially affected corridor—not only the file, function, package, or user-visible path named in the request. A change is incomplete when it repairs the named path while leaving the same reachable defect, divergent decision, bypass, or split-brain elsewhere.
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
- Land behavior as the smallest consumed vertical through its real entry point, owner, and output. Do not build a dormant horizontal replacement spine and weave its consumer branches into live paths while its producer or activation remains absent.
- A broad refactor is not overengineering when evidence shows it is necessary to establish one authoritative behavior, migrate consumers, remove duplicated decisions or active split-brains, eliminate invalid states, or prevent predictable divergence. Do not absorb unrelated debt, but do not classify necessary systemic work as unrelated merely because it crosses files or packages.
- Typed models, state machines, registries, lookup tables, interfaces, and adapters are tools, not defaults or anti-patterns. Use them when observed domain variation, lifecycle, ownership, or invariants justify them and they remove distributed branching, duplicated rules, lockstep edits, or invalid states.
- A broader refactor is justified when evidence shows repeated or divergent logic, recurring special cases, cross-layer leakage, callers changing in lockstep, an interface exposing implementation knowledge, or repeated implementation friction caused by the current shape. Name that evidence and the complexity the refactor removes.
- Reject an abstraction when it adds concepts, modes, configuration, dependencies, failure paths, or indirection without reducing caller knowledge, duplicate decisions, branching, lifecycle risk, or future change cost. A single implementation is a reason to examine the seam, not an automatic veto; a real external boundary or enforced invariant may justify it.
- Do not centralize coincidental similarity across distinct bounded contexts. Parse and normalize at boundaries, enforce domain rules in the domain owner, and keep adapters thin unless behavior truly belongs there.
- If the domain is inherently complex, model that complexity explicitly rather than hiding it in simplistic local code that pushes the burden into callers, synchronized flags, compatibility paths, or operations.
- When a change establishes a new owner, crosses package boundaries, introduces persistence or concurrency, or materially changes a public interface, write the intended caller-visible usage first, derive interfaces and placement from what callers should know, and compare plausible designs. If implementation repeatedly fights the chosen shape, stop and redesign; for routine work, follow the existing owner and patterns.
- If the systemic fix is genuinely blocked, mark `[blocked]` and explain the required owner-level change; do not present a local mitigation as complete.

## Compatibility and version skew

- The deterministic repo-local development stack bound to the current checkout owns retained development data; its database is **not disposable**. Never delete, reset, recreate, replace, truncate, clean, or discard that database to resolve migration drift.
- Follow the 2026-10-31 **Migrations: no edits during development, one consolidation before 0.3 release** row in `.project/OWNER-RULINGS.md` for migration authoring, the named release check and accidental-edit reconciliation; the reconciliation procedure is in `apps/stack/AGENTS.md` **Repo-local development database reconciliation**. A 0.3 migration that drops, renames or reshapes is ordinary work (2026-11-16 **Non-additive migrations are normal in 0.3**): no per-migration ruling and no parking for one. Every migration enters the shared migrations folder in the same commit as the schema and code that use it, because a migration in source that the shared dev DB has not applied makes consumer stacks refuse to start (`ESHAREDDBMIGRATIONSMISSING`). A lane deploys an additive one itself through the canonical deploy command (2026-11-16 **Lanes do routine operator work themselves**); a non-additive one applies at the next repo-dev restart through the existing migrate path.
- This standing authorization is narrow: it does not apply to `main`, shared, staging, production, external, another checkout's/named QA stack, or otherwise user-owned databases. Those targets retain their normal backup, approval, and operational requirements. If current-checkout stack identity or database ownership is ambiguous, fail closed without mutating any candidate.

- Use `.agents/skills/happier-compatibility` and read `docs/compatibility.md` when a change affects cross-component wire behavior, persisted/session/settings formats, schemas or migrations, feature/capability negotiation, installer/service state, upgrades, coexistence, or rollback.

## Multi-agent and Git safety

- Assume the checkout is actively shared and uncommitted changes are normal. They may be concurrent work, but they do not reserve a file; inspect and preserve them while adding compatible in-scope changes.
- Never remove, revert, overwrite, or “clean up” unrelated work. If an unrelated change looks accidental, ask before altering it.
- Stop only processes you started and recorded by PID. Never use pattern or port kills (`pkill -f`, `killall`, kill-by-port) in a shared environment: patterns match other agents' browsers, sign-in helpers and shells.
- A temporary bypass of your own hunks (an A/B run) happens in the shared, hot-reloaded checkout. Bypass only the files the check imports, keep the window minimal and record the bytes you wrote. Before restoring, compare each file with those bytes; if it changed, re-apply your hunks onto the current bytes. Never restore a whole-file backup over a file someone else edited.
- Write shared source atomically: prepare the complete parseable edit in a sibling temporary file, merge any intervening changes from current bytes, then rename it into place; never reformat foreign hunks. Use patch tools against current filesystem bytes; never write back a full-file read copied from tool output, which may be truncated or stale.
- Leave shared source loadable: before you end a turn, park or hand off, every package you touched must load. Check it once at that point, never per edit: import each file you changed (`node --conditions=happier-source --import ./packages/cli-common/registerSourceRuntime.mjs -e "await import('./<changed file>')"`, about 0.5 s each, local, never queued); UI files under `apps/ui` use `@/` aliases this loader can't resolve, so check them with their focused Vitest instead, and run the touched package's build when you changed published exports, manifests or generated projections. Entry-loads and the full Protocol import run once per commit inside the commit gate. Otherwise finish or revert the edit. Order edits so every intermediate state loads, because others hot-reload these bytes between your writes: write a new module, export, schema or setting declaration before the first file that imports or uses it, and declare a setting key in the same write as its first use. A half-landed edit that breaks loading for others (a missing export, an import of a not-yet-written module, a stale generated copy, a stray symlink) is an URGENT defect you own until it is fixed (Systemic retrospective, 2026-11-03/04: six such edits each halted many lanes).
- Rotate coordination boards daily, retaining prior posts in the board's existing archive, and post a CLAIM before editing shared persisted schemas (settings, migrations, or wire contracts). Keep lane reports to about 80 lines; Claude-specific report formatting lives in `.claude/CLAUDE.md`.
- Do not create ad-hoc summary, report, or status files; use the final response or an approved project location.
- Never switch branches in the primary checkout.
- Do not create or delete branches unless explicitly requested.
- Never run or emulate destructive cleanup without explicit approval, including `git reset`, `git restore`, `git clean`, `git checkout`, `git switch`, `git stash`, or any command that moves work out of the tree. This applies to **every clause of a compound command**, including one whose leading verb is read-only — `git stash list >/dev/null; …; git stash` is a violation, and `cd <package> && git stash` still stashes the whole repository.
- To decide whether a failure is yours or pre-existing, never manufacture a clean tree. Use `git diff --stat <path>` to see whether you touched it at all, `git diff HEAD -- <path>` to read the concurrent change, or `git worktree add` for a throwaway clean basis. If it still cannot be attributed, report it as unattributed and let the orchestrator adjudicate.
- Use read-only Git commands for inspection unless the user requested a mutation.
- Dependency inputs (`pnpm-lock.yaml`, `pnpm-workspace.yaml`, `patches/**`, any `package.json`, `node_modules`) are shared, fleet-wide refresh triggers. Third-party versions and `patches/**`: prepare and validate the change in a worktree outside the checkout, with no symlinked `node_modules`, and hand the diff to the dependency applier. Workspace-only wiring (a workspace package's `package.json`, exports, or another workspace package's dependency on it): apply it yourself, run `pnpm install --lockfile-only`, then install only through the dependency-refresh owner with a real installer, and post one notice. Commit a new workspace package with its `pnpm-workspace.yaml` entry and lockfile importer: left uncommitted, they break every routed preparation and HEAD install (2026-11-16, `ERR_PNPM_PACKAGE_MANAGER_NO_IMPORTER`). There is no hold, window, or forced dev restart per change (`.project/OWNER-RULINGS.md` 2026-11-01 "Un-gating dependency work"). Never run a raw `pnpm install` in the shared checkout.
- Never stage (`git add`) or commit except when executing an explicitly requested commit (from the user or an approved plan). When a commit is requested, assemble it by explicit pathspec from current bytes; never trust or wholesale-commit an inherited index.
- Standing commit authority (owner, 2026-11-04; simplified 2026-11-07): a lane's `DONE` means its verified work is committed. Commit what works, in coarse coherent commits, while everyone keeps working on moving source. Every commit leaves HEAD loadable: producers land before or with their consumers (owner ruling 2026-11-15, commit producer closure). A lane commits its own hunks. When a file also carries other lanes' uncommitted edits, commit by hunk or patch, never the whole file. Include another lane's uncommitted hunk only when your change needs it and it is finished; name its owner in the message. If the producer you need is unfinished, leave the consumer out until it lands; a foreign owner's silence is not a reason to sweep unfinished work. Gate: entry-loads 7/7 when TypeScript changed, plus the lane's focused tests, on the shared checkout. Commit from a private index with `git commit-tree` and a compare-and-swap `update-ref` (`.agents/skills/happier-commit-worktree` fast path), never the shared index. The exact-tree coherence finalizer is not a commit gate; HEAD health is fixed forward through the per-wave package typecheck, and one HEAD coherence pass runs before any push. No pushes without a separate request. Apply the [producer-closure check](.agents/skills/happier-commit-worktree/SKILL.md#5-form-coherent-change-packets) before every commit.
- Ordinary commits and Git pushes, including PR-stewardship pushes, use the current machine's Git identity and configured Git credentials. Verify `git config user.name` and `git config user.email` before the first commit, never rewrite them to a GitHub bot or another contributor, and stop rather than inventing a missing identity. GitHub API/UI mutations use `happier-bot` through `.agents/skills/happier-github-ops`. Its isolated `ghops git push` transport remains available only when exact or bounded standing authorization explicitly selects the bot as push actor; never infer that exception from ordinary commit/push authority, PR stewardship, or a machine-credential failure. When rebasing another author's work, preserve every original author while the current machine identity remains the committer and default push actor, and never alter persistent Git identity.
- Add a verified `Co-authored-by:` trailer only when that specific commit materially incorporates another person's code, patch, design, causal diagnosis, decisive reproduction, or substantially adopted fix direction. PR/issue authorship, participation, review ownership, a routine report, generic suggestion, requested log, or confirmation alone does not justify co-authorship. Evaluate attribution commit by commit; acknowledge helpful non-code contributions publicly even when they do not meet the commit-attribution threshold.
- For shared multi-program work, record one active authority for each conceptual seam. A dependent plan consumes that owner's contract; two plans must not independently design or write the same live seam. Plans that overlap existing work name `Supersedes:`, `Extends:`, and `Consumes:` relationships or stop for adjudication.
- A long-running multi-program effort maintains one current-status pointer in its existing canonical tracking document (current integration boundary, blockers, and superseded predecessors). This is a section in an existing file, not a new registry, lease system, or mandatory artifact for routine single-agent work.
- A dormant or gated program must not half-land changes to live dispatch, session lifecycle, persistence, migrations, daemon startup/shutdown, or other runtime paths. Such a live-path change is its own consumed vertical with RED evidence and the risk-appropriate composed/live gate.

## Testing: contract value, not test volume

### Behavior-change rule

- Any production behavior change requires TDD: write or update the relevant test first, verify RED for the intended reason, implement minimal GREEN, then refactor with tests green.
- Content-only Markdown/template/copy changes, styling-only changes without interaction/accessibility/visibility impact, and mechanical renames/moves/formatting do not require new tests; run relevant existing checks.

### Test selection and quality

Load `.agents/skills/happier-testing` **Workflow** and **Test Value Gate** before selecting or writing tests; they are the canonical per-flow acceptance-test, inventory, RED-validity, owner-boundary, discriminating-case and redundancy rules.

- Do not add runtime tests that merely restate TypeScript types, mirror implementation structure, assert pass-through wiring or incidental call counts, or police wording, Markdown, whitespace, raw styles, or example values.
- Assert stable outcomes, state, error type/code/shape/status, and published contracts rather than implementation details or exact prose.

### Mock boundaries

- A system boundary is outside the owning process’s deterministic internal logic: third-party APIs/services, OS/process adapters, platform/native SDKs, network transports, persistent databases, clocks, randomness, or environment adapters.
- Internal domain services, parsers, normalization, reducers/selectors, stores, orchestration helpers, provider catalogs, feature decisions, and state machines are not mockable boundaries.
- Use canonical package testkits before creating boundary mocks. When a boundary mock is necessary, preserve the real internal path beneath it, mirror the real schema, document why, and assert outcomes/state rather than only calls.
- UI tests prefer `apps/ui/sources/dev/testkit/**` and `@/dev/testkit` for shared boundaries.

### Validation

- Use the smallest relevant slice for RED/GREEN loops.
- Validate implementation directly from the current moving source and the existing development stack: focused source RED/GREEN first, risk-selected adjacent lanes next, package typecheck/build once per coherent integrated batch, and loaded-runtime QA for claims that depend on the real process or bundle.
- Feature implementation, review, and QA must not create, freeze, package, install, identify, or certify a separate release representation of the source. Do not add archive-production, local-package-installation, frozen-byte reuse, or release-artifact gates to feature completion; actual release automation owns producing and verifying what it publishes when a release is explicitly dispatched.
- At the smallest coherent integrated/package boundary, require the touched package’s typecheck/build-enforcing lane and relevant broader tests. Intermediate handoffs use focused RED/GREEN and risk-selected adjacent checks, naming any deferred check, its later owning boundary, and prerequisite. Deferred evidence cannot close its gate; final handoffs require applicable successful evidence or report the missing gate blocked. When several lanes integrate into one shared checkout, the orchestrator runs that package typecheck once per integration wave and lanes read its log for their own files instead of each queuing a full typecheck. A typecheck that failed to launch, timed out or was killed is `not run`, never "no errors". Never wrap a queued check, test or finalizer in your own timeout and never re-pin it: keep its handle, wait with the longest supported interruptible wait, and do independent work meanwhile (2026-11-05: a lane-local 40-minute timeout killed a queued typecheck and a finalizer).
- In the shared moving checkout, a lane's package-typecheck evidence is the canonical runner's diagnostics delta against the most recent recorded baseline, compared by file:line:code location, never by count: zero new diagnostics anywhere in the package caused by the lane's change. Do not log per-lane deltas as `owed` until a recorded file:line:code baseline exists. Use one integration-wave run with that baseline, or report no delta evidence. New diagnostics in paths the lane did not touch are listed as unattributed for the integration owner. A lane whose focused tests and other deciding checks pass with a zero delta is `DONE` even while the package is red from other work; whole-package green is not a per-lane completion state. One named integration owner keeps each package's baseline falling and owns whole-package green at the program boundary.
- Reuse successful validation only after checking its actual command, scope, terminal result, and applicability to the relevant current source, dependencies, configuration, and environment. Rerun affected checks after relevant changes, failures, missing evidence, or unresolved uncertainty, not merely because work changed hands or context was compacted. Preserve independent re-execution required by risk or an explicit ship/release gate; a summary saying "passed" is not execution evidence.
- User-visible behavior also needs the risk-appropriate live gate when runnable; use `.agents/skills/happier-testing` for lane, rerun, device, browser, and live-validation rules.
- For user-visible or environment-dependent programs, name the composed live recipe and required runtime identity before implementation. A green owner test, registered-but-uninvoked wiring, or a still-running command is not completion; run the recipe against the observed loaded runtime/build identity or mark it `[blocked]` with the missing prerequisite. Identifying what ran is evidence for that claim, not a source freeze or a requirement to package source-driven/hot-reloaded paths.
- Implementation completion and release evidence are different obligations. A lane, plan, or program is implementation-complete when its behavior lands at the canonical owner with reachable wiring, required removals, RED → GREEN proof, the touched packages' typecheck/build lanes, and the evidence the executor can produce itself: focused and integration suites, the managed development stack, and browser QA where runnable. Evidence that needs physical devices, real third-party tenants, mail delivery, signing, packaging, or production-like infrastructure is release evidence: release automation and human QA own it, it is listed once per program as named release checks with their prerequisite, and it is never encoded as per-lane or per-feature completion gates, activation ledgers, certification matrices, or repeated "measure later" sections. Missing release evidence does not hold a lane at `IMPLEMENTED_NOT_VERIFIED` and does not authorize adding gates, ledgers, or review rounds to reach completion. A program's ship recipe is one composed end-to-end journey plus its named release checks.
- Never claim a test, typecheck, build, or manual QA passed unless it actually ran. Report skipped or unavailable validation and why.

## Type safety and code hygiene

- Keep TypeScript strict; do not weaken `tsconfig` or type rules to pass checks.
- `@ts-ignore` is forbidden. Use `@ts-expect-error` only on the exact expected-failure line with a short rationale.
- Prefer inference for local variables, private implementation details, and obvious return values. Add explicit types when they prevent widening, expose an invariant, stabilize inference, or define an exported/public, wire, persistence, package, or security-sensitive contract.
- Production `any` types and broad `as any` casts are forbidden except at a narrowly isolated genuinely untyped external boundary or boundary fixture/harness with a one-line rationale. Prefer `unknown`, validate it, and narrow to a real type immediately.
- Prefer `satisfies`, explicit interfaces, typed fixtures, and canonical schemas over casting.
- No production TODO/FIXME placeholders, stray debug output, dead code, or commented-out blocks.

### TypeScript compiler ownership

- Never invoke bare `tsc`, `npx tsc`, `node_modules/.bin/tsc`, or `typescript/bin/tsc`; those can select the retained TypeScript 5 API package.
- For an ad hoc development invocation, use `pnpm run tsc ...` or `node scripts/workspaces/runTypeScriptCli.mjs ...`. `scripts/workspaces/resolveTypeScriptCliInvocation.mjs` is the only compiler-selection owner; never add compiler fallbacks, and compiler failures never fall back. Typechecks select pinned `tsrs` where supported; builds stay Microsoft TypeScript 7.1.0-beta, whose verdict is final.

Before compiler-script changes or ad hoc compilation, read `docs/testing.md` **TypeScript toolchain**, including **Agent rules**, for the complete selection, override, executor and platform rules.

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

## Agent and Provider architecture


Before Agent/Provider changes read `docs/agents-catalog.md` **Agent and Provider architecture** AND `docs/providers.md`; they own terminology, contribution placement and generic-host variation. Agents are executable coding backends; Providers are model sources.

## Runtime core, plugin platform, and SDK seam

- Plugins are trusted, unsandboxed code that can run any Node code or command. Do not build protections against them (per-plugin allowlists, endpoint or DNS pinning, egress restrictions, capability fences, "untrusted plugin" checks), and do not over-protect users against themselves. What stays: protection against other people (other Accounts, Team members, link recipients), secrets kept out of agent transcripts and logs, and E2EE toward the server.

Before runtime core, plugin-platform or SDK changes read `docs/runtime-core.md` AND `docs/plugin-platform.md` **Runtime core, plugin platform, and SDK seam**, including the standing ABI/ownership rules and historical-corpus restriction. Approved plans remain execution contracts, not standing architecture authority.

## Feature, encryption, and runtime triggers

- Feature work: read `docs/feature-gating.md` before deciding that a gate is appropriate. Refactors and replacements are in-place by default; genuine new/experimental capabilities use canonical feature ids/decision helpers, enforce dependencies centrally, gate only on `readServerEnabledBit(...) === true`, and treat missing/malformed bits as disabled. `capabilities` are diagnostic, not gates.
- Encryption/storage work: read `docs/encryption.md`. Persisted
  `Account.encryptionMode`, never key presence, is the Account-mode authority.
  Plaintext Accounts have no client Account data-encryption material; never fabricate
  or require it for plain paths. Parse `{ t: 'encrypted', c }` and
  `{ t: 'plain', v }` explicitly, keep server at-rest and device-local keys separate
  from client E2EE, and route Account-scoped readers and writers through the mode and
  envelope owner, which rejects mode/content mismatches with a typed result before
  disclosure or mutation. Fail inconsistent or
  unavailable E2EE material closed without reinterpreting it as plain.
- Runtime/install/package work: read `docs/binary-runtime.md` and `docs/cli-architecture.md`. Shipped paths must work without system Node/package managers, detection/install/validation/spawn must share one source of truth, and the importing package owns each dependency. Published hosts bundle the internal workspace dependency closure.
- Optional runtime capabilities (Iroh/relays, plugins, catalogs, background services) are additive. A failure to configure, acquire or reach one settles as a typed unavailable state with a visible reason and never exits the server or daemon or blocks ordinary readiness. Only a positively classified security refusal (identity, authentication, authorization) may stop startup, and only before any credential leaves. A capability that becomes default-on adds one composed startup test per supported server, database and Account-mode shape it reaches.

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

Before deleting or narrowing anything, trace every caller of the touched function, hook or component up to each entry point and mark each one affected or not applicable, with a reason.

- Run the `.agents/skills/attack-conclusion` self-simplification pass in place before every non-trivial handoff (callers and machinery first; every hunk traced to one outcome/invariant/fix sentence; would I still build this; split-brain; falsifiers; tests name their failure; net delta from the diff). A gap it finds becomes code only when reproduced or concretely reachable, and then at its owner; an imagined gap is residual risk. Routine author self-checks create no separate reviewer, workspace, report, or approval gate; record only changes they caused and unresolved risk.
- For deep reviews, plan-completeness audits, worktree/feature audits, or review-plus-QA/fix loops, use `.agents/skills/happier-review` so the target basis, affected corridor, findings, QA obligations, and evidence are handled coherently.
- The orchestrator checks delegated outputs against current source/diffs and deciding evidence. Re-derive load-bearing delegated claims at the next substantial boundary; scripts or focused inspection may verify deterministic inventories and mechanical transformations. Release, schema/data, security-critical, and user-visible ship gates require a different reviewer with re-measured decision-material evidence.
- Review to refute, not confirm. Lead with any finding; if none, state what was attacked and how.
- Review findings are candidate claims, not work orders. Re-derive each claim, then adjudicate impact, response, and authority separately: a real defect may have an overengineered proposed fix, a material plan deviation remains `AMENDMENT_REQUIRED`, and a mechanism-sized response needs a reproduced failure, reachable risk, or named live consumer.
- Review may inspect moving, dirty, partial, or completed work without freezing, hashing, leasing, or snapshotting it. Record a concise observed basis; moving-work review is advisory, while completion verdicts reconcile materially affected observations against current implementation and evidence. Batch formal independent review at substantial integration boundaries, explicit user requests, and high-risk ship gates—not every lane or microchange. After fixes, review the finding delta and affected corridor; repeat fully only when contract, architecture, scope, boundary, or risk materially changed.
- A plan-wide program reuses its canonical plan QA matrix and at most one review workspace for each substantial integrated boundary. Sublanes, findings, fixes, and reruns contribute evidence to that existing boundary record; they do not create parallel QA ledgers or one workspace per lane.
- Final reports lead with the outcome, then evidence-pointed reasoning, then residual risk.
- Verify every requested item is covered or marked `[blocked]`.
- Report checks actually run and validation that could not run.
- For behavior changes, repeat the split-brain audit across the touched corridor; name the canonical owner and every duplicate, bypass, legacy, or compatibility path removed or intentionally retained, including why a retained path is not a competing owner.
- For behavior changes, state the net mechanism delta: checks, states, error codes, timers, retries and files as `+added / −removed`, each addition with its one-line justification (harm prevented, how it is reachable, evidence, owner).
- Ensure no unapproved `*_SUMMARY.md`, `*_ANALYSIS.md`, or similar report file was created.
- Use Conventional Commits for commits and squash messages: `<type>[optional scope][!]: <description>`.

## Critical reminder

Before finalizing:

- Preserve existing work: do not discard unrelated changes or switch branches in the primary checkout.
- When we talk about overengineering, the target is not the feature; it is the underlying implementation logic. Start from the feature's real intent and requirements, preserve those outcomes, and ask whether any disproportionate machinery exists only to satisfy unreal, assumed, speculative, or unreachable requirements. Choose the simplest implementation that satisfies the real requirements. Before adding logic, inspect whether the behavior can be satisfied by or folded into existing canonical logic through reuse, extraction, refinement, extension, consolidation, or refactoring; reject split-brain, similar-but-different, or parallel paths when an existing owner can satisfy the need.
- Confirm the canonical owner, relevant consumers, and surrounding same-concept paths were inspected; refactor touched split-brains and do not leave a competing active implementation or bypass.
- If behavior changed, prove RED → GREEN with the smallest meaningful owner-level test, mock only genuine system boundaries, and run relevant validation.
- Report the outcome honestly, including failed or skipped checks, blockers, and residual risk.

## Owner rulings and usage economy

Applicable scoped owner rulings in `.project/OWNER-RULINGS.md` remain authoritative, including later amendments and standing grants; consult relevant rows before revisiting a settled decision.

Cap tool outputs; inspect counts/headings first and read needed slices. Never dump boards, large logs or whole reports; use scoped Git status/diff and targeted execution-run gets. Batch independent calls; do not reread active context. Logs and briefs use file pointers. For final lane messages and board replies, keep it short: what the reader must do, the result, and pointers; never paste logs or large output; detail lives in the lane report. Before board/coordination work, read the 2026-10-31 **Usage economy and board conventions** row in `.project/OWNER-RULINGS.md` **Process and orchestration**: wake only for addressed work, qualifying ALL-leads notices or your own lanes’ terminal results; wait on the job’s own completion signal.
