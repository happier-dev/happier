# Sentry HTTP-boundary fixtures

Each file is one recorded HTTP exchange at the transport boundary:
`{ request, status, headers, body }`. Tests mock only the transport and run the real
parsing, mapping, pagination and classification logic against these bytes.

Provenance and scrubbing rules:

- Shapes are taken from Sentry's published OpenAPI schema and official API
  documentation examples (`evidence/research/sentry-api.md`, tagged `[SCHEMA]`/`[DOC]`),
  not from a live authenticated account. No fixture is claimed to be live-verified.
- Every organization slug, project slug, host name, user identifier, e-mail address
  and token is a neutral placeholder (`example-org`, `example-project`,
  `sentry.example.com`). No credential, cookie, bearer token, real organization
  identifier or personal datum appears in any fixture.
- `Authorization` never appears in a recorded request or response header map.
