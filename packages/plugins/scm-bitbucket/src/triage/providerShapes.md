# Bitbucket Cloud response shapes this client relies on

Basis: Atlassian's published Bitbucket Cloud API v2.0 OpenAPI document (`swagger.v3.json`, 1,485,729
bytes, retrieved 2026-08-14) and the published REST intro contract, plus read-only unauthenticated
`GET`s against four public `api.bitbucket.org` repositories on 2026-08-15 for the response shapes the
published schema does not settle. Documented claims and observed claims are labelled as such below;
no live account was used and no credential appears anywhere in this package.

## Envelope and paging

`{ size?, page?, pagelen, next?, previous?, values }`. Only `values` and `next` are guaranteed;
`size` "is an optional element that is not provided in all responses, as it can be expensive to
compute" and is treated as advisory, never as a count. `next` "should be treated as an opaque
location that is not to be constructed by clients" — it is followed verbatim after an origin check.
`pagelen` has a global minimum of 10 and a documented global maximum of 100, but the same section
adds that "some APIs may specify a different default".

**The repository pull-request collection caps `pagelen` at 50, and rejects rather than clamps.**
Observed live, unauthenticated, 2026-08-15 on four public repositories: `pagelen=50` answers `200`
with 50 rows, and `51`, `60`, `75`, `99` and `100` all answer
`400 {"type":"error","error":{"message":"Invalid pagelen"}}`, independent of any other parameter.
`resolveBitbucketPageGeometry` therefore caps the scan's native page size at
`BITBUCKET_MAX_PULL_REQUEST_PAGE_LENGTH`, not at the global maximum; a geometry built from 100 would
fail every lane request and present an account with pull requests as an account with none. The
global 100 still applies to the workspace and repository listing collections.

## Fields the published schema under-describes

Real responses carry these; the OpenAPI does not list them. They are decoded tolerantly and are
never required for identity.

| Object | Undocumented but real | Consequence |
|---|---|---|
| `account` | `nickname`, `account_id`, `type` | the schema lists only `links`, `created_on`, `display_name`, `uuid`; `nickname` is read as display-only |
| `workspace_base` | `name`, `type` | the schema lists only `links`, `uuid`, `slug` |
| every object | `type` discriminator | present on the wire, ignored for identity |

## Fields the endpoint omits by default, and the projection that restores them

`pullrequest.reviewers` is documented as included "only… on a pull request's `self` URL", and
`pullrequest.participants` "only… when an API requests a pull request by id", both "for performance
reasons". Those are **defaults**, not a capability ceiling: the REST intro's *Field discovery*
section names these two fields as its example of fields excluded from a collection "as it would
impact performance too much", inside the section documenting `fields` as the parameter for
overriding exactly that.

Observed live, unauthenticated, 2026-08-15: the repository pull-request collection returns neither
list by default, and returns both — `user.uuid`, `role`, `approved`, `state`, `participated_on`,
identical in shape to the by-id read — when asked with `fields=+values.reviewers,+values.participants`.
Across four public repositories, 48–50 of every 50 rows carried at least one `approved: true`.

`reviewers` and `participants` are **different populations** and neither substitutes for the other.
Bitbucket's own participants contract includes users who "are not explicit reviewers, but have
approved the pull request". Observed counterexample: a public pull request with `reviewers: []` whose
participants carried `approved: true`, with not one participant in the `REVIEWER` role.

BBQL cannot narrow on participants at all: `participants.uuid`, `participants.user.uuid`,
`participants.approved`, `participants.state` and `participants.role` each answer
`400 Field ".participants.<field>" does not support filtering`. That is a query-parser verdict issued
before authorization, so there is no credential-dependent variant and no silently-accepted predicate.
`reviewers.uuid` *is* filterable, and is deliberately not used: it would define the walk as "pull
requests you were asked to review". The involvement predicate is evaluated client-side instead, where
a participant's identity and their approval are properties of one object and the match is exact.

The entry model distinguishes `null` (the endpoint did not return the list) from `[]` (the list is
genuinely empty), because rendering the first as the second would state that a pull request has no
reviewers, or that nobody approved it, when the client simply never asked or was not answered. A
review walk that asked and got `null` back reports `review-evidence-unprojected` rather than
publishing an empty lane.

## Identity

`repository.uuid` is "The repository's **immutable** id… Doing this guarantees your URLs will
survive renaming of the repository by its owner, or even transfer of the repository to a different
user." `workspace.uuid` is "The workspace's immutable id." Both cross the wire wrapped in literal
curly braces, and both `workspace` and `repo_slug` path segments accept "the UUID in curly braces".
`full_name` is "the concatenation of the repository owner's username and the slugified name" — twice
mutable, so it is a locator only.

## Rate limits

The only documented headers are `X-RateLimit-Limit` ("the total number of requests permitted per
hour. Note, this is not the number of remaining possible requests"), `X-RateLimit-Resource`, and
`X-RateLimit-NearLimit`, and only for scaled limits on access-token/Forge requests. There is no
published remaining or reset header, no published throttling status code on the pull-request routes
(`429` appears in the OpenAPI only on the three code-search operations), and no published
`Retry-After`. A throttle without a real `Retry-After` therefore carries no deadline at all.

The published budget is not the flat 1,000/hour general figure. Atlassian's limit table gives
"any access to `/2.0/repositories/*`" — which every route this scan issues lives under — a band of
**1,000–10,000 per hour** for authenticated callers; anonymous callers are capped separately at 60.
The unfiltered repository review walk costs one request per repository whose open pull requests fit
one 50-row page, and `ceil(openPullRequests / 50)` for the rest.

## Non-standard statuses

`555` is documented on the raw-diff route as "If the diff was too large and timed out", and on
`POST …/pullrequests/{id}/merge` alongside `200`, `202`, and `409`.
