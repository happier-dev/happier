# Intent review

Use for an explicit intent/simplification review or after three fixes on one owner, before a fourth patch. Review the whole owner and its reachable corridor; do not edit source. Write only the authorized report and evidence. This mode proposes deletions; it does not authorize implementing them or amending an approved plan.

This reference is the canonical intent-review method. Campaign briefs point here and add only their mutable assignment: scope, paths, local reference clones, already-reviewed work and the reporting route. `lanes/APPROVALS-SIMPLIFY.md` in `.project/plans/plugin-platform-simplification/seams-2026-10-12/` is a worked example, not a universal approvals contract.

## Mechanism table

Inventory every check, state, code, custody mode, retry, cache and guard on the path. Owners answer the questions with primary evidence; the reviewer verifies the answers and assigns the verdict, rather than letting owners certify their own mechanisms. Separate observed facts from derived reasoning; mark an unknown origin or missing evidence explicitly.

| Mechanism (file:line) | Intent, one plain sentence | Real harm prevented, concrete user-visible scenario | Reachable today? How? | Evidence of need (owner ruling, released contract, reproduced incident, named security threat) | What already covers it (which owner already decides this fact) | Reference does (same flow, `file:line`): same, nothing, or simpler | Cost: codes, branches, files, incidents it caused (cite board/lane evidence) | Origin: plan section, review finding or commit | Verdict |
|---|---|---|---|---|---|---|---|---|---|

- Default: `DELETE`. `KEEP` requires a named reachable harm and evidence; "in case", "defense in depth", "possible race" and "future consumer" are not evidence.
- Other verdicts: `MERGE into <one owner>` or `SIMPLIFY to <smaller rule>`. Apply deletion recursively to machinery that exists only to support another mechanism. A second place deciding a fact its owner already decides is `MERGE into <owner>`.
- Trace the origin to learn whether plans, reviews, security passes or implementation habits introduced it; name the plan wording that produced it. Do not infer historical intent from code shape.
- For exactness/currentness claims, name the failure if approximate and try the domain's own revision check first, decided once at its owner. Preserve real security, released compatibility and user features; missing evidence is not authority to remove them.
- Admitted work is checked once at admission; the server authorizes each later call with a cheap "this admitted job is still active" lookup, not a fresh permission evaluation, and the executor stops on a local cancel signal. Re-checks per step are `DELETE`.
- Revocation takes effect at the next natural boundary (next request or admission, new Session or deploy, reconnect, next secret acquisition); admitted work finishes or the user stops it. Mid-operation re-checks and kill-on-revoke machinery are `DELETE` unless the access is open-ended and interactive (a live terminal, an open stream).
- Plugins are trusted, unsandboxed code. Mechanisms that protect against plugins (allowlists, endpoint or DNS pinning, egress fences, capability checks, "untrusted plugin" validation) are `DELETE`, and so are mechanisms that protect users against themselves. Keep protection against other people (Accounts, Team members, link recipients), secrets out of agent transcripts and logs, and E2EE toward the server.
- No invented limits or budgets: propose no numeric caps or call budgets. Count tests assert the design's shape (one admission per request, zero re-checks per step, work proportional to real units) and record measured counts.

## Reference comparison

Compare each mechanism with what the cited reference open-source projects do for the same user flow.

- **Which references:** start with the ones the plan already cites (search the plan for project names, "Rationale" and `research-clones`). Use the local clones the campaign brief lists. If a cited reference is not cloned, shallow-clone the public repository read-only into a scratch research directory outside the checkout. Never install, build or run anything from it.
- **Same flow, side by side:** for the reviewed flow (one deploy, one inbound message, one session start, one approval), describe in a few lines what the reference does: its checks, states and round trips, with `file:line`. Fill the "Reference does" column from it.
- A mechanism none of the references has is `DELETE` unless it names a Happier-specific requirement they lack (for example E2EE, a server that must not trust a daemon, several Machines or Accounts, Teams, agents acting for a user) and its concrete harm. "We are more careful" is not one.
- References are evidence of what is enough, not authority. Don't copy a weaker practice where Happier has a named requirement (for example a secret passed through ENV), and don't add reference features the plan doesn't include.
- **Summary line:** how many mechanisms have no reference equivalent, and how many of those have a Happier-specific requirement.

Evidence and rulings to apply: `.project/OWNER-RULINGS.md`, especially its 2026-10-29 rows and the Approvals and Actions rows (`approvals-default-never-mandatory`, `ui-confirm-only-irreversible`, `present-user-floors-simplify-ruling`, `cli-approval-replay-by-app`); `.project/plans/2026-10-29-program-census/RESUME-DECISIONS.md` §2.

## Deliverables

1. The table, including unresolved owner answers and the reviewer's judgments, and the reference summary line.
2. One minimal model: the smallest rules preserving every `KEEP` protection, including protections retained by merges/simplifications.
3. An ordered merge/delete plan, each step naming its canonical owner, meaningful RED → GREEN test (usually a shape-contract count test flipping from `it.fails`) and blast radius; keep the real-protection tests green throughout.
4. Exact plan/doc sections needing amendment, with the wording that produced each mechanism, and the inventory of tests encoding the protections that must survive. Distinguish recommendations from approved changes and source evidence from loaded reproductions.
5. The net mechanism delta of the proposal (`+/−` checks, states, codes, timers, retries, files) and the measured shape counts before and after.

Report in plain language and label observed versus derived. A finding needs a reproduction or concrete reachable scenario; unsupported concerns remain notes. After authorized fixes, review the finding delta rather than repeating the whole intent review unless its basis materially changed. No time limit.

## Challenge pass

A distinct, independent second review of an intent report, run by a different reviewer before the owner approves the report or anything is implemented (reviewer routing per the active tool's instructions). Review only: no source edits.

Inputs: the named report, its evidence folder, the code it cites, and the owning lead's answers to that reviewer. Then:

1. **Every `KEEP` and `SIMPLIFY`:** re-derive the claimed harm from current code. Is it real for actual users and reachable today in a way you can describe concretely (who does what, what breaks, what they see)? Is it already covered by another owner, such as the domain's own revision check, authentication or the canonical admission? Downgrade any that rest on "could", "in case", "defense in depth", "future consumer" or "exactness" without a named failure.
2. **Every `DELETE` and `MERGE`:** check that it does not remove a real protection: an authorization or privilege boundary, data loss, a double effect on a third party, or secret exposure. Upgrade only with concrete evidence.
3. **Everything the report proposes to add** (test infrastructure, pipelines, facades, owners, states, codes): apply the deletion test to the proposal itself. Prefer the smallest change that serves the real intent, often a deletion plus one existing owner.
4. **Reference check:** for each `KEEP` or `SIMPLIFY` row, check what the cited references do for the same flow. If none has it and the report names no Happier-specific requirement, downgrade it. If the report skipped the comparison, do it for the rows that decide the plan.
5. **What it missed:** mechanisms in scope it didn't list, or rated without evidence.

Output: `<REPORT>-CHALLENGE.md` next to the report, line 1 STATUS. Then a short "Where I disagree" table (row, original verdict, challenge verdict, one-line evidence); what the plan should drop or add; the corrected minimal plan in a few lines; and a plain-language owner summary of at most 10 lines. Label observed versus derived. No time limit.

## Program campaign

When the owner asks every lead to review its own program for over-building, each program gets one review covering both its plan text and its implementation, in this order:

1. **Intent review** by this method in full, naming which plan wording produced which mechanism.
2. **Challenge pass** of that report, before anything is implemented.
3. **Deletion lanes** implementing the corrected plan: shape RED → delete → GREEN, keeping the protection tests the review names, producers before consumers, and `pnpm check:entry-loads` per batch.
4. **Security seams** (authorization, credentials, encryption) get the owner-designated security review before they count as done.

Cleanup plans that follow the approved rules (check once at admission with server per-call authorization and a local cancel signal; revocation at the next natural boundary; no invented limits; reference comparison; no lost user feature) are approved by default (`.project/OWNER-RULINGS.md`, 2026-10-29). Only real product questions go to the owner, through the campaign's reporting route with a recommendation. This grant does not approve changes to the rules or instructions themselves.

The campaign brief names the already-reviewed programs whose reports are consumed rather than redone, the output paths, and the reporting route.
