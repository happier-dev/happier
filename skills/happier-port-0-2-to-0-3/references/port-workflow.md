# 0.2 to 0.3 Port Workflow

Keep the port map in the conversation; do not create a repository ledger.

## Intake

Capture the source and destination checkout locations, repository identities, HEADs, branches, dirty states, inherited indexes, source change basis, and source validation. Verify the semantic release line independently of folder names. Record whether the destination was supplied explicitly or resolved through the optional verified `../v0.3.x` alias.

## Intent inventory

For every source behavior or fix, record:

- outcome and failure prevented;
- canonical source owner and affected corridor;
- deciding source tests;
- compatibility or persistence implications;
- destination owner and evolved sibling paths;
- disposition: already satisfied, adapted, broadened, or not applicable;
- destination changes and deciding checks.

Group several files under one intent when they form one vertical. Split one file into multiple intents when its hunks serve different outcomes.

## Port order

1. Validate a coherent source batch and record its current basis and intent for this port pass.
2. Re-discover the destination architecture and same-concept paths.
3. Decide every intent before editing.
4. Implement applicable changes through destination owners and tests.
5. Run focused and risk-appropriate broader destination checks.
6. Inspect the exact destination diff and leave commit authority to the caller.
7. After a later source follow-up, re-read its changed intent and destination disposition; repeat the full analysis only when scope, ownership, or architecture materially changed.

## Exit audit

Verify that no source intent was omitted because a filename disappeared, no 0.2 owner or assumption was reintroduced, no broader 0.3 sibling retained the same defect, no unrelated destination bytes were overwritten, no staging or commit occurred, and every skipped or unavailable check is reported.
