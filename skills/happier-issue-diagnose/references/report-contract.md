# Issue diagnosis report contract

Lead with the outcome, not the investigation chronology.

## Required sections

### Disposition

State the three axes in compact prose:

- behavior evidence;
- version/release status with named basis;
- recommended response.

### What is established

Separate:

- **Observed:** directly present in issue data, logs, diagnostics, source, artifacts, or reproduction.
- **Derived:** follows from named observed facts and the verified code/contract path.
- **Unverified:** reporter claims, plausible causes, version assumptions, or missing evidence.

### Root cause and owner

When verified, name the originating failure layer, failure mechanism, canonical owner, affected corridor, and why the behavior belongs there. Name active duplicate decisions, bypasses, or compatibility paths and whether each should be removed, migrated, or intentionally retained.

If not verified, say `INCONCLUSIVE` or `LIKELY_NOT_VERIFIED` and identify the cheapest missing discriminator. Do not substitute a nearby error or suspicious function for a root cause.

### Version and release basis

Name the reported, source, loaded, fix, and released-artifact bases that were actually established. Explicitly distinguish fixed-in-source from shipped.

### Recommended response

Describe concrete owner-level changes or the non-code response. Prefer reuse, refinement, extraction, consolidation, migration, or removal over a parallel implementation. Separate mitigation from root-cause correction.

### Evidence and validation

List the deciding issue fields, source/tests, private diagnostic categories, reproduction recipe/result, and artifact/release evidence. Redact sensitive data and state any checks that could not run.

### Approval boundary and residual risk

State whether the next action is implementation, GitHub write-back, release work, more evidence, guidance, or no change. Ask for approval only when the next action requires it. End with what could still invalidate the conclusion.

## GitHub-facing summary

If the user later authorizes a public comment, derive a short sanitized summary from the report:

- user-visible behavior and affected version basis;
- verified or explicitly tentative cause;
- next action or precise missing information;
- public links to commits, releases, PRs, or canonical issues.

Never include private diagnostics, raw logs, credentials, machine identities, personal paths, or unsupported confidence scores.
