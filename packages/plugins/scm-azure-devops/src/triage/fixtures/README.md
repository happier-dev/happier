# Azure DevOps provider fixtures

Boundary fixtures for the Azure DevOps REST client. They are mocked at the HTTP transport
only: the request construction, decoding, mapping, and paging beneath them run for real.

## Provenance — read this before trusting a fixture

These are **documented-shape** fixtures built from the published Azure DevOps REST `7.1`
reference (Core Projects, Git Repositories, Git Pull Requests, and the common error envelope).
They are **not** recordings from a live Azure DevOps organization: no live credential was
available when they were written.

Every identifier is fabricated. Organization, project, repository, and person names are
fictional, GUIDs are synthetic, and no token, PAT, cookie, or personal detail appears in any
file. `signInInterception.html` is a reduced stand-in for the HTML sign-in page Azure DevOps
serves in place of API content when a credential is unusable; its request-context field is
literally `REDACTED`.

## What is therefore unverified

A fixture proves this client parses the documented shape correctly. It cannot prove Azure
actually emits that shape. The behaviors still unverified against a live account are recorded
in the lane report, and include: the `connectionData` identity read and its pinned preview
`api-version`, whether `_apis/projects` issues `x-ms-continuationtoken` under `$top=1` at 7.1,
the exact status of the sign-in interception, and the live rate-limit header set on a real
`429`. Replacing any file here with a real scrubbed recording is an improvement, not a rewrite:
the decoders are shape-driven and the assertions are behavior-driven.
