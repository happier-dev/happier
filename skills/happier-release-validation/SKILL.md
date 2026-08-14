---
name: happier-release-validation
description: Run target-owned manual deep release certification from an explicit Happier checkout without dispatching a release.
---

# Happier Release Validation

This is the repository-owned entrypoint for the public release contract's
manual-only `deep` profile. It does not publish, promote, deploy, submit stores,
or create a release operation.

## Start from the target contract

From the explicit candidate checkout, inspect the target-owned profile and its
executable suite inventory:

```bash
node scripts/pipeline/run.mjs release-contract
node scripts/pipeline/run.mjs release-validate --profile deep --dry-run
```

`deep` is not part of normal release dispatch. This skill is its manual
entrypoint; the registry does not pretend that semantic compatibility or human
QA can be decided by a script.

For general release preparation or approval, first use the installed private
maintainer authority:

```bash
hmaint release bootstrap --repo <absolute checkout> --json
```

If `hmaint` is unavailable, stop and obtain the approved maintainer-tool
installation; do not substitute a copied release workflow or arbitrary shell
commands.

## Manual certification

1. Record the exact candidate source SHA and every independently versioned
   component that the candidate changes. Resolve supported stable/preview
   baselines to immutable tags/artifacts; a rolling tag is discovery only.
2. Read `docs/compatibility.md`, map only reachable old/new directions, and
   perform the target-owned suite commands for affected automatic-capable
   surfaces. Record unrun or unavailable proof as such.
3. Perform risk-selected installer/Docker, cross-OS, provider, mobile, and
   integrated-evidence review for the surfaces actually affected by the candidate.
   Keep editorial judgement, release-note wording, and subjective compatibility
   assessment human-reviewed; do not encode them as prose/style tests.
4. For every manual scenario, preserve practical evidence: candidate/baseline
   identity, command or observed user flow, result, and recovery/failure state.
   Use an existing release record when one exists; do not create a parallel
   ledger, lifecycle state, or certification authority.
5. Report passed, failed, skipped, and blocked checks to the maintainer. A
   manual certification is evidence for human approval, never the approval
   itself.

## Boundaries

- Use the canonical `scripts/pipeline/release-validation/validate-release.mjs`
  path through `scripts/pipeline/run.mjs`; do not copy its suite selection into
  this skill.
- Run only discriminating compatibility vectors or live flows for affected,
  reachable directions. Do not manufacture a component or platform matrix.
- Do not write release notes, tags, GitHub releases, credentials, deploy
  branches, or store submissions from this skill.
