# PostHog HTTP boundary fixtures

These files are the recorded provider bodies used by this package's parser, mapper, and
pagination tests. They are the only place a PostHog response shape is asserted, so a
provider change shows up as a fixture change rather than as scattered inline literals.

## Provenance

Every response shape here is derived from the **live published PostHog OpenAPI document**
fetched unauthenticated from `https://eu.posthog.com/api/schema/?format=json` on
2026-08-14 (OpenAPI 3.1.0, 12,871,873 bytes). Each fixture's field set, requiredness,
nullability, and value type match the corresponding component in that document:

| Fixture | Schema component |
|---|---|
| `queryIssuesPage1.json`, `queryIssuesPage2.json` | `ErrorTrackingIssuesListResponse` / `ErrorTrackingIssueListItem` |
| `queryIssuesTolerantPage.json` | same, with deliberately malformed sibling rows |
| `queryIssueDetail.json` | `ErrorTrackingIssueDetail` |
| `crudIssueRead.json` | `ErrorTrackingIssueRead` |
| `queryIssueEventsPage.json` | `ErrorTrackingIssueEventsResponse` / `ErrorTrackingEvent` |
| `organizationsPage.json` | `PaginatedOrganizationList` / `Organization` |
| `organizationProjectsPage.json` | `PaginatedProjectBackwardCompatBasicList` / `ProjectBackwardCompatBasic` |
| `issueActivityPage.json` | *(none — see below)* |

`issueActivityPage.json` is the one exception to the table above. The published schema
declares `'200': No response body` for both activity routes, so there is no component to
derive it from. Its envelope — `results`, `next`, `previous`, `total_count` — and its
record fields come instead from PostHog's own current activity page response and activity
log serializer at `PostHog/posthog@71299185bb4ab7469dee1728bc5d6eedb3a8a319`
(`posthog/models/activity_logging/activity_page.py`), the deciding source this plan
records. The exact live field set therefore remains uncharacterized and is recorded as
residual risk rather than asserted as complete.

**These are schema-derived, not captured from a live account.** No PostHog credential was
used and no PostHog account was read while producing them. Value-level behavior that the
schema does not describe — the actual throttle status and headers, whether
`query/issue/` 404s for an out-of-window issue, the sampling method behind
`query/issue_events/`, and self-hosted route parity — remains uncharacterized and is
recorded as residual risk rather than asserted here.

## Scrubbing

All identifiers are inert placeholders: UUIDs are of the form
`0000000-…-0000000n`, hosts are `example`/`invalid` test domains, and person, email,
organization, project, and release values are fictional. No credential, token, cookie,
real organization identifier, or personal datum appears in any fixture. The
`queryIssueEventsPage.json` and `issueActivityPage.json` fixtures intentionally contain
sentinel values inside unapproved raw properties so that each boundary projector can be
proven to drop them.
