# <Program or feature title> — PLAN

Status: DRAFT · Contract revision: r1 · Approval and amendment record: <dates and decisions> · Evidence basis: <date, paths>
Relationships: Supersedes / Extends / Consumes: <plan paths or none>. One active authority per live seam: if another plan already designs or writes the same seam, stop for adjudication instead of designing it again.

This is the layout for `happier-plan` §5. There is no size cap: a big feature may need a big plan. Length comes from flows, owners and decisions, not from restated rules, per-mechanism ceremony or copies of other documents; cite those by path.

## 1. Users and flows

Problem, target outcome, non-goals and plan-specific forbidden mechanisms. Then what people do, step by step, and every feature that must keep working. Use stable ids (F1, R1, I1) for flows, requirements and invariants in substantive plans.

| Flow | Who | Steps (entry → visible outcome) | Features that must keep working | Lab scene and the code owner that produces it |
|---|---|---|---|---|

**Actions and surfaces.** Every user-facing capability is one Action that every surface reaches through the Action executor (UI, CLI, agent tools, phone):

| Capability | Action id | Read / write | Placement | Agent approval default (`safety` / `approvalPolicy.agentDefault`) | Person confirmation | Surfaces reaching it |
|---|---|---|---|---|---|---|

Anything an agent must choose from has a read Action. Each designed surface lists its loading, empty, failed and offline states with the lab outcome. Each designed page names its whole-page fidelity acceptance and the design lane that owns it (`happier-ui-craft` validation).

## 2. Current state

Search wide before designing (root `AGENTS.md` "Discovery and evidence before change"), with `file:line`: the canonical owner and why it owns the behavior; every entry point, caller, producer, consumer, reader and writer; existing split-brains, bypasses and similar-but-different paths in the corridor; schemas, persistence, compatibility provenance and external contracts; existing tests, testkits and live QA surfaces; the two or three quietest failure points. A field's presence is not proof the behavior works.

## 3. What the references do

For each flow, what the cited reference projects do (`repo/path:line`): their checks, states and round trips. They are evidence of what is enough, never requirements or scope, and their names stay out of Happier code, copy and identifiers.

| Flow | Reference | What it does | Checks and calls observed |
|---|---|---|---|

## 4. What is different for Happier, and why

Only differences with a named Happier-specific requirement (E2EE, an untrusted daemon, several Machines or Accounts, Teams, agents acting for a person, a released contract) and the user-visible harm without them. Plugins are trusted, unsandboxed code, so protection against a plugin, or of users against themselves, is not such a requirement. References never lower a named security requirement.

| Difference | Requirement | User-visible harm if absent | Mechanism |
|---|---|---|---|

## 5. Facts and their owners

One row per fact the flows depend on (authority, admission, currentness, readiness, availability, limits, lifecycle state). One owner and one place decides it. Every surface and caller found in §1–§2 consumes that owner's typed result instead of re-checking it, and is a path to test once, not a place for its own guard.

| Fact | Owner (file or module) | Decided where | Takes effect when it changes | Surfaces and callers that consume it |
|---|---|---|---|---|

- **Admitted work:** decided once at admission. The server authorizes each later call with a cheap "this admitted job is still active" lookup, not a fresh permission evaluation; the executor stops on its local cancel signal.
- **Withdrawal and revocation:** take effect at the next natural boundary (next request or admission, new Session or deploy, reconnect, next secret acquisition). Admitted work finishes or the person stops it. Only open-ended interactive access (a live terminal, an open stream) closes at once.
- **Exact, current, fresh, fail closed:** each names the concrete failure if approximate and the row above that decides it; prefer the domain's own revision check over another layer.
- **Cross-device or cross-runtime:** state separately the client surfaces, canonical authority and executor, transport, durable state and lifetime, behavior while the authority is unavailable, and required consistency. A feature reachable from several clients does not by itself move its authority to the server.
- **States and values:** every user-visible or persisted non-terminal state (pending, claimed, parked, waiting) names its persisted fact, writer, reader and the event that advances or settles it, including stop, cancel, fail, retry, archive, revoke and reload; a state with no settling event is a defect. Every new persisted value names where it lives (owning record, Session metadata, server-visible non-content metadata, device-local store, or a deliberate setting).
- **Resources:** each resource a feature reads, publishes or keeps alive names its one loader, when it loads, what it fetches at real scale and what invalidates it (real change only). Idle cost is zero apart from named liveness.

## 6. Shape contracts

The design's shape per flow, written as count tests before implementation (`it.fails` until the units land) and registered in `.agents/skills/happier-performance/references/flow-budgets.md`. They assert shape, not invented numbers, and record the measured counts.

| Flow | Shape (for example one admission per request · zero authority re-checks per step or command · one secret read per phase · work proportional to the real unit) | Real unit the work scales with | Test path |
|---|---|---|---|

Each new producer, timer or poll also carries its `happier-performance` count contract.

## 7. Design, rules and mechanisms

Final ownership, data and control flow, interfaces, invariants, file and module placement, migrations, removals, and retained compatibility seams with their removal conditions.

The minimal rules, each as `Rule. Owner: <owner>. Harm: <user-visible harm>. Evidence: <owner ruling / released contract / reproduced incident / named threat>.` Every mechanism beyond the owners above gets the one line from `happier-plan` §4; no line, no mechanism. Limits (timeouts, caps, retries) appear only with the resource or contract they protect.

## 8. Not built

What was considered and deliberately not built, and why (no reference has it and no Happier-specific requirement, no reachable harm, owner ruling). Required: an empty list means §3–§4 were not challenged.

## 9. Decisions

Approved and binding; intentionally delegated to implementation within named constraints; deferred or excluded. One-way decisions with their undo consequence. Rejected alternatives only when a later reader would otherwise rediscover them. Open owner decisions: one question per row with the recommended answer; a ruling names one owner and one shape.

## 10. Execution units

Ordered consumed verticals. Unit 1 delivers the composed journey thin, end to end, through real wiring, and names its live recipe and loaded-runtime identity; later units widen it. Each unit:

- **U<n> — <outcome>.** Owner and scope · Dependencies and preconditions · Deletes · Deciding check · Shape rows · Requirement and invariant ids · Also read: <exact neighbouring sections>.

## 11. QA and completion

Risk-weighted automated and live scenarios for every affected flow and its reachable failure, recovery, platform and compatibility directions, run against the moving source and the existing development stack. Observable acceptance criteria and negative requirements; what prevents completion; one composed end-to-end journey as the ship recipe. Release checks (devices, real tenants, mail, signing, packaging), each with its prerequisite; they are not completion gates.

## 12. Execution tracking

A mutable status and evidence area kept separate from this contract: a section here, or the program's existing tracking document. Status-only updates do not change the contract revision.
