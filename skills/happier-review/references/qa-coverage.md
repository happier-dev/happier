# Comprehensive, Proportionate QA

## Contents

- Coverage ledger and material behavior dimensions
- State-transition, compatibility, scripted, and exploratory coverage
- Automated/live evidence, resource ownership, and failure handling
- Independent QA-completeness audit

## Principle

Proportionality removes irrelevant dimensions, not meaningful scenarios. Agents must not use “risk-based” as permission for one happy-path check. Enumerate the affected behavior/state space first; every material reachable flow, state, and distinct contract receives evidence or an explicit disposition. Organize evidence at the user-flow or canonical-owner level rather than multiplying rows by implementation detail.

## Build the coverage ledger

Derive QA rows from:

- intent and plan claim ledger;
- changed behavior and affected corridor;
- user roles, permissions, accounts, machines, and providers that alter behavior;
- state machines, persistence, queues, retries, reconnects, and cleanup;
- released/predecessor compatibility directions;
- prior regressions and tests changed or bypassed;
- the two or three quietest/highest-cost failure spots;
- platform/runtime differences in the changed path.

Record:

| ID | Feature/contract | Interface | Preconditions/state | Steps | Expected | Risk covered | Status | Evidence | Follow-up |
|---|---|---|---|---|---|---|---|---|---|

Statuses: `NOT_RUN`, `RUNNING`, `PASS`, `FAIL`, `BLOCKED`, `UNREACHABLE`, `OUT_OF_SCOPE`, or explicitly authorized `DEFERRED`.

`UNREACHABLE` and `OUT_OF_SCOPE` require evidence/rationale. `BLOCKED` names the missing prerequisite and next action. Never silently remove a failing or inconvenient row.

## Material behavior dimensions

Across each independently observable user flow or canonical-owner contract, inventory these dimensions and exercise every materially reachable one:

1. primary success path;
2. most likely failure;
3. highest-cost or quietest failure;
4. relevant invalid, empty, minimum/maximum, or malformed boundary;
5. repeated action, retry, idempotency, or duplicate submission when possible;
6. cancellation/partial failure and resulting state when possible;
7. reload, reconnect, resume, restart, or recovery for stateful/lifecycle flows;
8. persistence round-trip and historical-state reading when data is stored;
9. authorization, ownership, wrong-account/tenant/relay isolation when protected;
10. one neighboring regression through the same canonical owner;
11. live browser/device/CLI/API/daemon path for user-visible behavior when runnable;
12. required compatibility directions and materially affected Windows, Linux, and macOS dimensions.

One scenario may decide several dimensions. Collapse equivalent roles, platforms, providers, states, or interfaces only after naming why they cannot materially change the result. Add rows for materially distinct contracts or risks; do not duplicate equivalent rows merely to satisfy a numeric floor.

## State-transition coverage

When behavior has meaningful state, list:

- relevant starting states;
- valid transitions;
- invalid transitions that must be rejected;
- interruption points;
- restored/reloaded states;
- terminal and cleanup states.

Use a state/transition table rather than prose when it makes omissions visible. Do not enumerate theoretical states the system cannot reach.

## Compatibility and rollout QA

Use `skills/happier-compatibility`. Cover every affected required old/new direction with a contract/vector result. Select end-to-end rows from actual deployment, coexistence, rollback, and persisted-data risk.

Do not multiply UI × CLI × daemon × server × provider × OS when a dimension cannot affect the changed seam. Collapse a dimension only after naming why its behavior is equivalent; the boundary or ship closeout audits decision-material omissions once for the integrated surface.

## Scripted and exploratory passes

Run scripted acceptance rows first or establish why exploratory evidence must precede them. For user-visible changes, then perform a bounded exploratory charter based on the diff and risks, including relevant attempts such as:

- unexpected action order;
- rapid/repeated actions;
- navigation during pending work;
- stale or concurrent state;
- recovery after network/process interruption;
- long/unusual real-world input;
- loading, empty, error, disabled, and partial-success states;
- accessibility, keyboard/focus, viewport, and platform behavior when affected.

Record charter, duration/extent, paths exercised, observations, and evidence. “Clicked around” is not QA evidence.

## Automated versus live evidence

Automated tests prove stable contracts efficiently; they do not replace a live gate when the harness cannot reproduce the real interaction/runtime. Live observations find gaps; encode durable regressions in the narrowest valuable automated test afterward when fixes are authorized.

Use `skills/happier-testing` for exact lanes and browser/device skills for execution. For a failure, capture the smallest decisive combination of UI state, structured output, logs, network response, process/database state, or screenshot. Screenshots alone rarely prove data/lifecycle correctness.

## Stability and resource ownership

Final QA must identify the tested relevant source state, loaded bundle or binary when applicable, server, account, and relevant configuration. This identifies what actually ran; it does not freeze the worktree or create a separate release representation. Do not assume hot reload or use a knowingly half-wired path as final evidence. Moving work may still receive advisory QA; reconcile changed decision-material paths and rerun affected scenarios before the verdict.

Parallelize only flows with independent code and mutable resources. Track ownership of accounts/browser storage, daemons/services, databases, VMs/devices, ports, artifact directories, and provider sessions. Do not stop or restart externally managed processes without authorization.

When the user supplies a managed stack or running environment, reuse it and its stated access path; do not start a competing stack. If its state is unsuitable or a managed process appears to need restart/stop, report the evidence and ask rather than taking ownership of it.

For platform-sensitive QA, exercise the actual affected runtime when it is authorized and available: the host macOS environment, an existing authorized Linux VM/container such as Lima, or an authorized Windows connection. Record OS/build/architecture and the observed loaded source/build identity, manage only resources started by the lane, and keep machine addresses and credentials runtime-supplied rather than hardcoded in the skill or evidence.

For runtime failures, inspect the evidence sources that can decide the cause: structured CLI/API output, Happier/session/provider logs, browser console and network traffic, daemon/server process state, persistence/database state, and platform/service logs. Use `skills/happier-diagnose` for Happier-specific log/session diagnosis. Do not add source instrumentation in read-only modes.

## Failure handling by output mode

- `report`/`comment`: capture, diagnose to the evidence-supported depth, add a finding or blocker, continue safe independent rows.
- `staged`: finish triage and proposed root-cause fix clusters, then wait for approval.
- `fix`: diagnose, prove RED where behavior changes, fix the canonical owner, rerun the row and broader risk lane, then re-review.

Do not chase unrelated environment failures. Do not dismiss a failure as unrelated without a discriminating observation.

## QA completion audit

At a substantial boundary or ship verdict, a reviewer other than the QA lane owner checks when required by risk and available:

- every affected feature/plan claim maps to rows;
- every materially reachable dimension was covered or defensibly inapplicable without duplicating equivalent rows;
- failures and blockers remain visible;
- evidence proves expected results rather than merely showing commands ran;
- omitted roles/platforms/providers/version directions are justified;
- loaded build/runtime identity is trustworthy;
- exploratory coverage targeted current risks.

When an independent reviewer is unavailable or the review is intentionally single-agent, perform one compact adversarial omission pass at the applicable boundary and record that independence was unavailable. Do not repeat this after every lane or reuse an “all green” conclusion as the audit; rebuild the affected-flow list from the target, material plan outcomes, owner, state model, and changed contracts, then compare it to the ledger.

QA is not complete merely because every existing row is green; the ledger itself must be complete for the affected surface.
