# {{VERSION_WITH_PREFIX}} Release Validation Tracking

## Read First After Any Compact

This file, `PLAN.md`, and `LEDGER.md` are the live source of truth for this validation run.

After any compact or interruption:
1. Read this section.
2. Read `PLAN.md` and continue from the first `[~]`, `FAILED`, or `[BLOCKED]` marker.
3. Read latest `LEDGER.md` entries for execution evidence.
4. Do not restart completed lanes unless evidence was invalidated.

## Mission

Validate the candidate release before preview promotion. The validation must prove that current preview users can upgrade without breaking installations, daemon-server connection, background services, auth, session creation, session management, provider launches, web UI, native mobile, server, CLI, and release artifacts.

This validation may implement root-cause fixes. It must not release, promote, publish, submit mobile builds, or mutate production.

## Non-Negotiables

- Work only in `{{WORKTREE_PATH}}`.
- Branch must stay `{{BRANCH_NAME}}` or another branch that satisfies the local release runner's `*/upstream-dev` guard.
- Never switch branches in the primary checkout.
- Never reset, restore, clean, or discard unrelated changes.
- Treat `.project/reviews/...` as ignored live state; do not commit it.
- Track every scenario, suspected issue, resolved issue, and deferred issue here or in lane docs linked here.
- Root-cause fixes only. No workaround fixes and no deleting valuable tests to make lanes pass.
- For behavior changes, follow TDD and record RED/GREEN evidence.
- For test fixes, prefer shared testkit/mock/factory repairs over repeated local mock patches.
- Start automated validation with parallel failure collection by resource group; cluster failures before fix dispatch unless a blocker makes evidence untrustworthy.
- Use high useful parallelism. Dirty or previously touched files do not reserve a scope; coordinate fix agents only where edit hunks, conceptual seams, generated outputs, or exclusive runtime resources actually collide.
- Keep `PLAN.md` as the concise marker board and active-agent queue; keep detailed execution in `LEDGER.md` and evidence files.
- Reuse the same account/browser/server URL for continuity QA unless a scenario explicitly tests account switching.

## Baseline Inventory

- Version: {{VERSION}}
- Source branch: {{SOURCE_BRANCH}}
- Candidate branch: {{BRANCH_NAME}}
- Worktree: {{WORKTREE_PATH}}
- Preview base revision: {{PREVIEW_BASE}}
- Drift commits since preview: {{DRIFT_COUNT}}
- Package versions:
{{PACKAGE_VERSIONS}}
- Predecessor audit: `.project/reviews/2026-04-15-preview-release-readiness-orchestrated-audit/`
- Stack publish scope: default out of scope unless human says otherwise
- Bump mode for dry-run: default `none` if versions are already candidate versions

### Released Component Baselines

Resolve rolling channel pointers once, then pin immutable evidence for the run. Add rows only for components relevant to this candidate.

| Component | Channel | Rolling pointer | Immutable version tag | Commit | Artifact/checksum evidence |
|---|---|---|---|---|---|
| TODO | stable/preview | TODO | TODO | TODO | TODO |

### Affected Version-Skew Directions

List directions coupled by the changed seam; do not manufacture unaffected Cartesian rows.

| Writer/producer | Reader/consumer | Upgrade/coexistence/rollback reason | Required/unreachable/unsupported | Deciding evidence |
|---|---|---|---|---|
| TODO | TODO | TODO | TODO | TODO |

## Open Questions

Answer in place. Do not append stale answers below.

1. Q: Are any components beyond app/server/relay/cli intended to publish in this validation cycle?
   A: TODO
2. Q: Are mobile EAS store submissions in scope?
   A: Default no; validation only unless human approves.
3. Q: Should stress run?
   A: Default no; run only if daemon/session concurrency risks surface.
4. Q: Did relay code, configuration, persistence, or migrations change, and if so what exact released-relay-to-candidate scenario is required?
   A: TODO

## Pre-Mortem

Fill before exiting Phase 1. Each hypothesis must map to at least one lane that catches it. Mandatory categories: daemon-ownership migration, installer-driven upgrade, session continuity, cross-platform divergence.

| # | Hypothesis | Catching test/scenario | Lane(s) | Status |
|---|---|---|---|---|
| H1 | TODO | TODO | TODO | TODO |
| H2 | TODO | TODO | TODO | TODO |
| H3 | TODO | TODO | TODO | TODO |
| H4 | TODO | TODO | TODO | TODO |
| H5 | TODO | TODO | TODO | TODO |

## Lane Status

{{LANE_TABLE}}

## Required Custom Check Command

```bash
{{CUSTOM_CHECKS_COMMAND}}
```

Before final handoff, this command must pass in the validation worktree.

## Manual QA Matrix

{{MANUAL_QA_MATRIX}}

## Risk Matrix

| Risk | Status | Covering Lane(s) | Evidence | Decision |
|---|---|---|---|---|
| Daemon ownership migration breaks existing preview installations | TODO | L16, L17, L18, L21, L23 | | |
| Daemon auth login in VM connects to wrong account/browser/server | TODO | L16, L21 | | |
| Background service conflict leaves relay ownerless or stale | TODO | L13-L18, L21 | | |
| Session continuity breaks across daemon/server/CLI update | TODO | L10-L12, L16-L18, L25 | | |
| Provider launch/regression for configured provider smoke lanes | TODO | L06, L16-L20 | | |
| Release assets or installers differ from local candidate expectation | TODO | L09, L13-L15, L24 | | |
| Mobile preview login/session creation regresses | TODO | L19 | | |

## Findings

Only high-confidence findings belong here. Suspicions start in lane docs and move here when confirmed.

| ID | Severity | Status | Finding | Fix | Evidence |
|---|---|---|---|---|---|

## Process Feedback

Use this section to improve the validation skill/templates after the run. Do not put release blockers here; blockers belong in Open Questions, Lane Status, Risk Matrix, or Findings.

| ID | Area | Friction / Doubt | Impact | Suggested Skill/Template Fix | Status |
|---|---|---|---|---|---|
| PF-001 | TODO | TODO | low/medium/high | TODO | open |

## Exit Criteria

The validation skill can stop only when all are true:

- Every required lane is `[x]` or `[DEFERRED-HUMAN-APPROVED]` in `PLAN.md`.
- Every row in Lane Status is DONE, green, or human-approved deferred.
- Every manual QA row is green, fixed-and-rerun-green, or human-approved deferred with release-note text.
- Every affected required version-skew direction has immutable baseline provenance and deciding evidence; unreachable/unsupported rows have rationale.
- No open questions remain unanswered.
- No suspected issue remains unresolved.
- Process Feedback items are either recorded for later template improvement or marked `none`.
- Reviewer lanes L23, L24, L25, and L27 are GREEN.
- After each fix cluster, the immediately affected lane and `node scripts/pipeline/run.mjs checks --profile fast` were rerun or the rerun is explicitly justified as not applicable.
- Final custom checks command is green.
- Local release dry-run L26 is complete and recorded.
- Handoff says “ready for validation review”, not “released”.
