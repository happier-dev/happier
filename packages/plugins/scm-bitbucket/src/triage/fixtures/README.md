# Bitbucket Cloud provider boundary fixtures

These files are the recorded HTTP boundary for the Bitbucket Cloud triage client. Every field name,
nesting level, enum value, and envelope member is taken from Atlassian's published Bitbucket Cloud
API v2.0 OpenAPI document (`openapi: 3.0.0`, `info.version: 2.0`, retrieved from Atlassian's public
developer CDN at `https://dac-static.atlassian.com/cloud/bitbucket/swagger.v3.json`, 1,485,729 bytes,
2026-08-14 — byte-identical in size to the copy recorded by the plan corpus on 2026-08-12) and from
the published REST intro contract at `https://developer.atlassian.com/cloud/bitbucket/rest/intro/`.

**No live account was used and no credential exists in this directory.** Workspace slugs, repository
slugs, UUIDs, account UUIDs, display names, branch names, and commit hashes are inert invented values
that match the documented wire format (notably the literal curly braces Atlassian's schema requires
around every UUID). Nothing here is derived from a real customer, organization, or person.

Values that the published schema under-describes — `account.nickname`, `account.account_id`,
`account.type`, `workspace_base.name`, and the `type` discriminator carried by every real response
object — are present because real responses carry them and the client must decode tolerantly around
them. They are marked in `../providerShapes.md`.

| File | Route it records |
|---|---|
| `pullRequestsPageOne.json` | `GET /2.0/workspaces/{workspace}/pullrequests/{selected_user}` first page — unprojected, so `reviewers`/`participants` are absent as the collection default |
| `pullRequestsPageTwo.json` | the same collection's last page, including one identity-invalid row |
| `pullRequestSelf.json` | `GET /2.0/repositories/{workspace}/{repo_slug}/pullrequests/{pull_request_id}` — carries `reviewers` and `participants` without asking |
| `pullRequestsReviewPage.json` | `GET /2.0/repositories/{workspace}/{repo_slug}/pullrequests?state=OPEN&fields=+values.reviewers,+values.participants` — the projected collection both review lanes are read from |
| `userWorkspacesPage.json` | `GET /2.0/user/workspaces` — `paginated_workspace_access`, not `paginated_workspaces` |
| `workspaceRepositoriesPage.json` | `GET /2.0/repositories/{workspace}` |
| `currentUser.json` | `GET /2.0/user` — the credential's own provider-native identity, the only source of the workspace-member UUID every involvement lane is decided against |
| `errorNotFound.json` | the shared `error` envelope |

`pullRequestsReviewPage.json` records the shape the live 2026-08-15 probes established, and its rows
are chosen for the distinctions the review lanes turn on: one pull request approved by the viewer who
was never a requested reviewer (`reviewers: []`, no participant in the `REVIEWER` role — the case a
`reviewers.uuid`-filtered walk cannot reach), one where the viewer's review was requested and not yet
given, and one that involves the viewer not at all. The `participants` field names, nesting and enum
values match `pullRequestSelf.json` exactly, because the projection returns the same participant
object the by-id read does.
