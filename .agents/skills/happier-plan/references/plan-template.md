# <Program or feature title> — PLAN

Status: DRAFT · Contract revision: r1 · Approval and amendment record: <dates and decisions> · Execution tracking: <path to the program's tracking document>
Relationships: Supersedes / Extends / Consumes: <plan paths or none>. One active authority per live seam: if another plan already designs or writes the same seam, stop for adjudication instead of designing it again.

## Gate

The gate is the only mandatory part. It fits on one page and is written before any design prose. Lanes read the gate, their own unit and that unit's "Also read" sections.

### 1. Flows

Problem and target outcome in two sentences; non-goals in one line. Then what people do, step by step, and every feature that must keep working.

| Flow | Who | Steps (entry → visible outcome) | Features that must keep working | Calls, writes and publications per user action and unchanged refresh, as formulas of real units (e.g. deploy = 1 admit + N services + 1 settle; unchanged input = 0 writes/publications, same identities) |
|---|---|---|---|---|

### 2. Mechanism ledger

One row per check, state, timer, retry, cache, lock, lease, receipt, limit or approval the design adds (in a cleanup plan: keeps). Wording such as exact, current authority, freshness, re-check, re-prove or fail closed appears only here, on the row of the owner that decides it.

| Mechanism | Owner (one place) | User-visible harm without it | Reachable how (repro / incident / named cross-person threat) | Reference that does it (repo:path) OR Happier-specific requirement | Cost per operation |
|---|---|---|---|---|---|

A row that lacks harm and reachability, or lacks both a reference and a Happier-specific requirement, is deleted, not listed. Plugins are trusted, unsandboxed code: protection against a plugin, or of users against themselves, is not a Happier-specific requirement.

### 3. Accepted imperfections

Races and edge cases deliberately not handled, each with why it is visible and recoverable (root `AGENTS.md` "Choose good compromises"). Never silent loss of authoritative data, exposure to another person, secrets in transcripts or logs, or E2EE.

### 4. Ship journey

One composed end-to-end recipe: entry point, Account and state, actions, visible outcome, recovery path, and the loaded-runtime identity that proves it. Release checks (devices, real tenants, mail, signing, packaging), each with its prerequisite; they are not completion gates.

## Design

Free-form, below the gate. Answer each item that applies; skip the rest without a heading. Cite generic rules, logs and evidence by path instead of copying them. There is no size cap; length comes from flows, owners and decisions.

- **Current state.** Search wide before designing (`happier-plan` §3), with `file:line`: the canonical owner and why it owns the behavior; every entry point, caller, producer, consumer, reader and writer; existing split-brains, bypasses and similar-but-different paths; schemas, persistence, compatibility provenance and external contracts; existing tests, testkits and live QA surfaces; the two or three quietest failure points.
- **Facts and owners.** Each fact the flows depend on (authority, admission, readiness, availability, limits, lifecycle state), its one owner and place, when a change takes effect, and the surfaces and callers that consume it (each a path to test once, not a place for its own guard). Cross-device or cross-runtime work states separately the client surfaces, canonical authority and executor, transport, durable state and lifetime, behavior while the authority is unavailable, and required consistency; a feature reachable from several clients does not by itself move its authority to the server.
- **Actions and surfaces.** Each flow's design-lab scene and the code owner that produces it. Every user-facing capability is one Action that every surface reaches through the Action executor: Action id, read/write, placement, agent approval default (`safety` / `approvalPolicy.agentDefault`), person confirmation, and the surfaces reaching it (UI, CLI, agent tools, phone); read Actions for anything an agent must choose from. Each designed surface's loading, empty, failed and offline states with the lab outcome, and each designed page's whole-page fidelity acceptance and owning design lane (`happier-ui-craft` validation).
- **States, values and resources.** Every non-terminal state's persisted fact, writer, reader and settling event (including stop, cancel, fail, retry, archive, revoke and reload); where each new persisted value lives; each resource's one loader, when it loads, what it fetches at real scale and what invalidates it. Any derived or persisted state names its lazy per-Account build; no startup rebuild or backfill. Idle cost is zero apart from named liveness.
- **Shape tests.** Each Flows formula becomes a count test registered in `.agents/skills/happier-performance/references/flow-budgets.md` (`it.fails` until the units land); each new producer, timer or poll carries its `happier-performance` count contract. For derived state, prove a server with N Accounts and no derived state reaches ready with zero rebuild work. Usage's startup rebuild hit P2028 on 277 Accounts and broke every server start (2026-11).
- **Design and decisions.** Final ownership, data and control flow, interfaces, invariants, placement, migrations, removals and retained compatibility seams with removal conditions. Choices that are approved and binding, delegated within named constraints, or deferred; one-way decisions with their undo consequence; open owner questions, one per row with the recommended answer.
- **Execution units.** U1 delivers the ship journey thin, end to end, through real wiring; later units widen it. Each unit: owner and scope · dependencies and preconditions · deletes · deciding check · Flows rows · Also read: <exact neighbouring sections>.
- **QA and completion.** Risk-weighted automated and live scenarios for every affected flow and its reachable failure, recovery, platform and compatibility directions, against the moving source and the existing development stack; observable acceptance criteria, negative requirements, and what prevents completion.

Execution status, gate results and incident narration live in the tracking document named in the header, never in this file.
