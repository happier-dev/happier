# Reporting a Happier diagnosis

Use only after presenting the diagnosis and receiving explicit user consent for the selected path.

## Choose private, public, or both

- **Private diagnostics upload:** logs and selected transcripts are sent to Happier's diagnostics service for maintainers.
- **Public GitHub issue:** a sanitized, searchable report is created at `happier-dev/happier`.

The paths are complementary. If the user selects both, upload privately first so the public issue can include the returned `reportId`. Consent to one path does not authorize the other.

## Private upload

Construct the current command from verified `happier bug-report --help` output. A typical invocation is:

```bash
happier bug-report \
  --title "<specific title>" \
  --summary "<concise evidence-backed summary>" \
  --current-behavior "<observed behavior>" \
  --expected-behavior "<established expected behavior>" \
  --repro-step "<step 1>" \
  --repro-step "<step 2>" \
  --frequency <always|often|sometimes|once> \
  --severity <blocker|high|medium|low> \
  --session-id <happier-session-id> \
  --attach-session-log <session-log-path> \
  --attach-provider-transcript <provider-transcript-path> \
  --include-diagnostics \
  --accept-privacy-notice
```

Use only flags confirmed by current help/source. Attach only relevant artifacts. Capture and report the resulting `reportId` and issue/fallback URL without exposing tokens or private contents.

## Public GitHub issue

Verify `gh` availability and authentication before attempting the external write. Use a specific title and sections appropriate to the evidence:

```markdown
## Description

<expected and observed behavior>

### Steps to reproduce

1. ...

## Root Cause

<only when verified or explicitly labeled as a hypothesis>

## Suggested Fix

<evidence-backed direction, not an authoritative work order>

## Affected Files

- `repo/relative/path.ts:line`

## Environment

- Happier CLI:
- OS:
- Provider:
- Diagnostics reportId:
```

If root cause is inconclusive, omit or clearly label the hypothesis. A useful issue may consist of reliable reproduction, observed/expected behavior, environment, and private `reportId`.

## Public privacy boundary

Allowed when relevant:

- repository-relative public source paths;
- short public-source snippets;
- sanitized reproduction steps;
- product version, provider family, and platform;
- private diagnostics `reportId`.

Never include:

- raw log or transcript contents;
- absolute user filesystem paths;
- hostnames or machine IDs;
- full session/provider identifiers;
- access keys, OAuth tokens, API keys, or credentials;
- private user content.

Show the user the resulting URL after creation. Do not edit, close, or comment on other issues unless separately authorized.
