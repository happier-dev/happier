# API

This document covers the HTTP API surface and authentication flows. For WebSocket updates and event payloads, see `protocol.md`. For encryption boundaries and encoding details, see `encryption.md`.

## Method conventions
- **GET** is used for reads.
- **POST** is used for mutations or actions, even when the operation doesn't map cleanly to a single entity.
- **DELETE** is used when intent is unambiguous (e.g., removing a token or deleting a session/artifact).

We intentionally avoid the full REST verb palette because many operations span multiple entities or have non-CRUD semantics.

## Authentication
Most endpoints require `Authorization: Bearer <token>`.

### Challenge transition (development source)

The v1 challenge shape below remains a compatibility transition, not a future
permanent contract. Development source adds an audience-bound, single-use v2
challenge and capability negotiation. A server retains v1 only while the
measured supported-client frontier includes v1-only authenticating clients; the
retirement condition is that every supported authenticating client advertises
v2 and the frontier has advanced beyond the recorded predecessor releases. Do
not replace that condition with a calendar date.

Auth flows:
- `POST /v1/auth`
  - Body: `{ publicKey, challenge, signature }` (base64 strings)
  - Verifies signature using the provided public key.
  - Upserts account by public key and returns `{ success, token }`.

- `POST /v1/auth/request`
  - Body: `{ publicKey, supportsV2? }`
  - Creates or returns a terminal auth request.
  - Response: `{ state: "requested" }` or `{ state: "authorized", token, response }`.

- `GET /v1/auth/request/status?publicKey=...`
  - Response: `{ status: "not_found" | "pending" | "authorized", supportsV2 }`.

- `POST /v1/auth/response`
  - Body: `{ response, publicKey }` (requires Bearer auth)
  - Approves a terminal auth request.

- `POST /v1/auth/account/request`
  - Body: `{ publicKey }`
  - Similar to terminal auth, but for account linking.

- `POST /v1/auth/account/response`
  - Body: `{ response, publicKey }` (requires Bearer auth)

### API Tokens (development source)

API Tokens are opaque `hap_v1_…` credentials stored server-side as
digest-backed records and shown in plaintext only in the mint response. The
canonical verifier accepts them as `account_automation`; it does not make the
caller a present user. Token creation, revocation, revocation of all tokens,
sign-out-everywhere, approval decisions, and security/API-policy controls
require `present_user`.

There are no v1 token scopes. `account.sessions.signOutEverywhere` invalidates
signed sessions but intentionally leaves API Tokens active; revoke API Tokens
through their individual or all-token controls instead. Server-origin
verification sees revocation on its next verification. The daemon has only a
bounded, in-memory positive validation cache: at most 60 seconds and never
extended while server introspection is unavailable.

## External Action API (Developer Preview source contract)

The protocol declares one public Action path and strict finite JSON envelopes:

```text
POST /v1/actions/:actionId
Authorization: Bearer <API Token>
```

Both the daemon-local adapter and the server-origin relay are implemented in
development source. This is not a deployed or released HTTP API, and
composed/live proof for the server origin remains outstanding.

Request:

```json
{
  "v": 1,
  "requestId": "optional-correlation-id",
  "target": { "kind": "machine", "machineId": "machine-id" },
  "input": {}
}
```

`target` may be omitted or use the machine or session form. It is
transport routing metadata, never Action input, caller provenance, approval
state, or host execution context. Daemon-local omission selects that daemon's
current machine. The server origin has no default machine: a caller must first
use the PAT-enabled `GET /v1/machines` discovery route and then provide an exact
machine target. Omitted targets return `target_required`. A session
target is valid only when canonical Session ownership derives one exact current
machine; an unavailable session placement returns `target_unavailable`. The
server validates the PAT and finite envelope, then relays over the target
daemon's existing server connection with server-stamped provenance. It does not
execute or interpret the Action; the target daemon does. The successful response
preserves the canonical Action result:

```json
{
  "v": 1,
  "actionId": "session.spawn_new",
  "requestId": "optional-correlation-id",
  "execution": { "ok": true, "result": {} }
}
```

Only PAT bearer authentication is accepted on public Action routes; signed
session bearers and `x-happier-daemon-token` are distinct credentials for other
surfaces. The API does not use SSE, has a 100 MiB request-body ceiling, sends
`Cache-Control: no-store`, and does not enable CORS. The server-mediated design
is intentionally plaintext to the configured server and avoids requiring an
inbound public daemon address; use daemon-local transport for direct local
delivery. The transport does not retry or fail a mutation over to another
origin.

The generated [SDK API inventory](../packages/sdk/API.md) is the source of
exported method names. It must not be duplicated as a hand-written action list.

## Endpoint catalog
### Sessions
- `GET /v1/sessions`
- `GET /v2/sessions/active?limit=...`
- `GET /v2/sessions?cursor=cursor_v1_<id>&limit=...&changedSince=...`
- `POST /v1/sessions` (create or load by `tag`)
- `GET /v1/sessions/:sessionId/messages`
- `DELETE /v1/sessions/:sessionId`

### Machines
- `POST /v1/machines` (create or load by id)
- `GET /v1/machines`
- `GET /v1/machines/:id`

### Artifacts
- `GET /v1/artifacts`
- `GET /v1/artifacts/:id`
- `POST /v1/artifacts`
- `POST /v1/artifacts/:id` (versioned update)
- `DELETE /v1/artifacts/:id`

### Access keys
- `GET /v1/access-keys/:sessionId/:machineId`
- `POST /v1/access-keys/:sessionId/:machineId`
- `PUT /v1/access-keys/:sessionId/:machineId`

### Key-value store
- `GET /v1/kv/:key`
- `GET /v1/kv?prefix=...&limit=...`
- `POST /v1/kv/bulk`
- `POST /v1/kv` (batch mutate)

### Account and usage
- `GET /v1/account/profile`
- `GET /v1/account/settings`
- `POST /v1/account/settings`
- `POST /v1/usage/query`

### Push tokens
- `POST /v1/push-tokens`
- `DELETE /v1/push-tokens/:token`
- `GET /v1/push-tokens`

### Connect (OAuth providers + vendor tokens)
- `GET /v1/auth/external/:provider/params`
- `POST /v1/auth/external/:provider/finalize`
- `DELETE /v1/auth/external/:provider/pending/:pending`
- `GET /v1/connect/external/:provider/params`
- `POST /v1/connect/external/:provider/finalize`
- `DELETE /v1/connect/external/:provider/pending/:pending`
- `DELETE /v1/connect/external/:provider`
- `GET /v1/oauth/:provider/callback`
- `POST /v1/connect/:vendor/register` (`vendor` in `openai | anthropic | gemini`)
- `GET /v1/connect/:vendor/token`
- `DELETE /v1/connect/:vendor`
- `GET /v1/connect/tokens`

### Users, friends, feed
- `GET /v1/user/:id`
- `GET /v1/user/search?query=...`
- `POST /v1/friends/add`
- `POST /v1/friends/remove`
- `GET /v1/friends`
- `GET /v1/feed`

### Version and voice
- `POST /v1/version`
- `POST /v1/voice/token`

### Dev-only
- `POST /logs-combined-from-cli-and-mobile-for-simple-ai-debugging` (only if enabled)

## Implementation references
- API routes: `apps/server/sources/app/api/routes`
- Auth module: `apps/server/sources/app/auth/auth.ts`
