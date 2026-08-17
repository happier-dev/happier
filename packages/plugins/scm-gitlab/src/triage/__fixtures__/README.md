# GitLab provider response fixtures

Recorded from GitLab's current published REST API reference on 2026-08-14:

- `mergeRequestList.json` — `GET /api/v4/merge_requests` example body
  (<https://docs.gitlab.com/api/merge_requests/>).
- `issueList.json` — `GET /api/v4/issues` example body
  (<https://docs.gitlab.com/api/issues/>).
- `mergeRequestDraft.json`, `mergeRequestLocked.json`, `mergeRequestUndecodable.json`,
  `issueClosed.json`, `issueUnknownState.json` — the same published shapes narrowed to the
  documented field values this vertical must discriminate (`draft`, `locked`, `closed`,
  an unrecognized native state, and a row whose `iid` is missing).

No fixture carries a live credential, private locator, personal detail, or organization
identifier. Actor names, avatars and paths use the neutral placeholders GitLab's own
reference examples use, further reduced to `example-group/example-project` and
`example-user`. Every value is a published documentation shape, **not** a live capture:
no live GitLab.com account was available to this lane, so live-only behaviours are
recorded as unverified in the lane report.
