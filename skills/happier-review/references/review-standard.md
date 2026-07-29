# Integrated Review Standard

## Contents

- Review orientation, finding threshold, evidence, and triage
- Correctness, security, data/contracts/lifecycle, and compatibility
- Split-brains, architecture/complexity, and test quality
- Performance, UX/accessibility, cross-platform behavior, and final finding disposition

## Review orientation

Review like a skeptical senior production reviewer. Try to refute correctness, not confirm the author's narrative. Focus findings on the review target and changed behavior while reading all unchanged corridor code needed to reach a reliable conclusion.

Start with the highest-risk silent failures, then audit the boring mechanical surface where omissions hide. Green tests and polished architecture are evidence inputs, not proof.

## Finding threshold and provenance

A confirmed finding must be:

- objective and reproducible or directly derivable;
- decision-material and actionable;
- supported by primary evidence;
- tied to concrete impact;
- located precisely;
- attributed as `introduced`, `exposed/activated`, or `pre-existing corridor debt required for coherence`.

Do not raise style preferences, generic best-practice advice, theoretical edge cases without reachability, or broad rewrites without demonstrated complexity/correctness impact. A low-confidence concern is an investigation question, not a finding.

A reviewer may propose any evidence-backed correction, simplification, addition, removal, mechanism, process change, or plan amendment relevant to the target; it does not assign implementation or amend an approved plan. The orchestrator re-derives the claim and adjudicates the impact, proposed response, and authority separately. Require a reproduced failure, reachable risk, or named live consumer before accepting a response that adds a protocol, persisted state, lifecycle, control plane, or other mechanism-sized complexity.

Before recommending a response, identify where the failure entered: approved intent/contract, plan design or integration, canonical implementation, test/harness, runtime/environment/external contract, or unrelated system. Repair the originating layer. A confirmed code symptom does not authorize a plan change, a harness defect does not prove production is wrong, and an environment failure is not fixed by weakening product behavior.

Severity follows impact and reachability:

- `CRITICAL`: credible security compromise, irreversible data loss/corruption, or primary product/release failure.
- `HIGH`: major correctness/security/data/lifecycle failure in a reachable important path.
- `MEDIUM`: concrete limited-scope correctness issue or architectural/test debt likely to produce divergence or defects.
- `LOW`: small objective defect with limited impact; never use for cosmetic taste.

Security category does not automatically determine severity.

## Finding evidence packet

Record:

- ID, severity, category, and provenance;
- precise file/symbol/line;
- concise observation;
- evidence and reproduction/derivation;
- impact and affected users/surfaces;
- root cause and canonical owner;
- recommended coherent fix;
- validation required;
- confidence and any remaining assumption.

When expected behavior cannot be derived from the applicable approved contract, current external contract, or observed canonical behavior, do not guess a passing or failing verdict. Record the material ambiguity or missing evidence separately from implementation status and name what would resolve it.

For a PR-style comment, reduce this to at most two constructive sentences plus the location. Keep the evidence packet in the review report/workspace.

## Correctness and resilience

Check:

- happy, error, cancellation, partial-failure, retry, recovery, and cleanup paths;
- null/undefined/empty/boundary values only where reachable;
- stale, repeated, reordered, concurrent, and resumed operations where state/lifecycle makes them possible;
- atomicity, idempotency, transaction boundaries, resource cleanup, and ownership transfer;
- errors that are swallowed, silently converted, or leave misleading success state;
- feature gates, state transitions, and impossible-state handling;
- generated/built/runtime wiring and artifacts, not only source presence;
- unsafe casts, unclear optionality, and weak models that permit reachable illegal states.

Do not add defensive fallback paths for states that cannot occur. Prove impossibility or understand and model the state.

## Security, auth, and privacy

Activate when external input, protected resources, credentials, execution, files, network, encryption, or trust boundaries are touched. Check:

- boundary validation and safe parsing;
- authentication plus resource-specific authorization/ownership;
- account, tenant, relay, session, and machine isolation;
- injection, traversal, unsafe spawn/shell, SSRF, XSS, and deserialization reachability;
- secret exposure in logs, prompts, reports, artifacts, client bundles, and errors;
- privacy-minimized responses and diagnostics;
- fail-closed gates and explicit encryption envelopes;
- dependency risk only for changed/new dependency surface.

Do not report a security label without a concrete attack/failure path and impact.

## Data, contracts, compatibility, and lifecycle

Check:

- producer/consumer and reader/writer agreement;
- schema/migration ordering, rollback/coexistence reachability, and historical data;
- read-modify-write races, duplicate processing, dedupe keys, watermarks, and transaction/after-transaction behavior;
- HTTP/socket/IPC/CLI error and success contracts;
- released cross-component and persisted contracts, not every internal module signature;
- services, daemons, sockets, retries, takeover, cancellation, and process cleanup.

Use `skills/happier-compatibility` for released/predecessor claims. Do not preserve undeployed internals or reconstruct historical fixtures from current types.

## Split-brains, duplication, and ownership

A split-brain exists when multiple active paths independently decide the same domain concept. Search by symbols and domain identifiers across owners, registries, parsers, normalizers, state machines, schemas, feature decisions, persistence writers/readers, adapters, and tests.

Raise a structural finding when evidence shows duplicated decisions, divergent behavior, caller knowledge, lockstep edits, bypasses, or lifecycle ownership conflict. Reuse, extend, refine, extract, consolidate, migrate, or remove at the canonical owner.

Do not use line count, five-line duplication, rule-of-three, one-use abstraction, folder name, or file-size thresholds as findings. Similar syntax across distinct bounded contexts can remain separate; name the distinction.

## Architecture and maintainability

Use a complexity ledger for architecture-impacting changes:

- **Added:** concepts, seams, adapters, dependencies, config, modes, states, branches, failure paths, and caller knowledge.
- **Removed:** duplicate decisions, invalid states, bypasses, special cases, compatibility paths, lockstep edits, and operational risks.

Judge total lifetime complexity, locality, leverage, and ownership—not diff size. Apply the deletion test to a proposed abstraction: if deletion merely spreads necessary complexity across callers, it may be deep and valuable; if deletion removes the complexity entirely, it may be pass-through ceremony.

### Subtraction review

For material additions, attempt subtraction while preserving the complete authorized contract. Ask whether a new mechanism has a live consumer, an existing canonical owner was reimplemented, the language/standard library or a suitable platform-native capability already satisfies the need, an existing package-owned dependency can carry it with lower lifetime cost, a wrapper enforces a real contract or merely forwards, configuration represents observed variation, and a fallback handles a reachable state rather than unexamined uncertainty.

Raise a finding only when the reviewer can identify what should disappear, which canonical owner or facility replaces it, and why required behavior, integration, migration, compatibility, UX, security, accessibility, performance, platform behavior, testing, and validation remain satisfied. Do not score net lines or dependencies, and do not turn this lens into a separate mandatory lane, gate, ledger, or review round.

If successive fixes mostly address hazards introduced by the new mechanism, or the implementation repeatedly fights the proposed ownership/model, reopen the design. Prefer deletion, contraction, or a smaller owner-level contract over continuing review-fix rounds that only make an unconsumed mechanism internally consistent.

Do not demand an abstraction because code repeats or reject one because there is currently one implementation. Require observed variation, a real external seam, lifecycle ownership, or an enforced invariant. Do not mechanically split large files; split when responsibilities or ownership are genuinely mixed.

Check that logic lives at its natural domain/package layer, imports respect public package surfaces, and files/folders remain cohesive and navigable. Wrong placement, grab-bag folders, thin wrapper stacks, or cross-layer leakage are findings only when tied to concrete caller knowledge, duplicated decisions, dependency inversion, drift, or maintenance/correctness cost.

## Testing review

Use `skills/happier-testing`. Verify:

- behavior changes have meaningful RED → GREEN evidence;
- RED failed for the intended contract, not setup/mock/fixture drift;
- tests distinguish a plausible wrong implementation;
- existing owner-level coverage was inventoried and consolidated;
- internal domain logic remains real; only system boundaries are mocked;
- assertions target outcomes/contracts, not wording, types, pass-through wiring, or incidental calls;
- fixtures/testkits have one canonical owner;
- compatibility vectors have historical provenance;
- live gates and broader lanes match the risk.

More tests are not automatically better. Missing material behavior coverage and redundant shallow tests are both findings when objectively demonstrated.

## Performance and user experience

Activate when the changed corridor can affect latency, throughput, rendering, memory, disk/network use, process count, scrolling, or responsiveness. Prefer measurements and profiler evidence over complexity guesses.

For React and React Native corridors, inspect subscription breadth, selector locality, referential stability, state/prop identity churn, list virtualization, and preventable rerender or recomputation cascades. Do not prescribe memoization or caching by reflex; require evidence that it removes the measured bottleneck without creating stale state or invalidation complexity.

For UI/UX, check primary flows, loading/empty/error/disabled states, accessibility, focus/keyboard/navigation, continuity, responsive layouts, and visible recovery only where affected. An optimization that improves an isolated metric while regressing freshness, feedback, state or scroll continuity, accessibility, responsive behavior, recovery, or perceived latency is not successful; design taste alone is not a code-review finding.

For CLI, daemon, terminal, installer/update, filesystem/path, process, service, or integration changes, treat Windows, Linux, and macOS as first-class. Inspect separator and case behavior, executable resolution, quoting/shell assumptions, signals/process trees, locks/atomic replacement, permissions, and service lifecycle where the changed seam can differ; require evidence for each materially affected platform or record the unvalidated platform as residual risk.

## Triage

The orchestrator reopens cited code/evidence and records four independent dispositions:

- **Claim:** `CONFIRMED`, `REFUTED`, or `INVESTIGATE` with a falsifying check.
- **Impact:** `MATERIAL`, `IMMATERIAL`, or `UNRELATED` with scope rationale.
- **Proposed response:** `ACCEPT`, `REPLACE_WITH_SIMPLER_FIX`, `DEFER`, or `REJECT` with reason.
- **Authority:** `WITHIN_PLAN`, `AMENDMENT_REQUIRED`, or `OUT_OF_SCOPE`.

Deduplicate symptoms under their root cause. Do not accept a finding merely because several reviewers repeated it.
