# API

This document covers the HTTP API surface and authentication flows. For WebSocket updates and event payloads, see `protocol.md`. For encryption boundaries and encoding details, see `encryption.md`.

## Method conventions
- **GET** is used for reads.
- **POST** is used for mutations or actions, even when the operation doesn't map cleanly to a single entity.
- **DELETE** is used when intent is unambiguous (e.g., removing a token or deleting a session/artifact).

We intentionally avoid the full REST verb palette because many operations span multiple entities or have non-CRUD semantics.

## Authentication
Most endpoints require `Authorization: Bearer <token>`.

### Challenge transition (supported compatibility)

The v1 challenge shape below is a compatibility transition, not a permanent
contract. Retain it only while a published stable or preview artifact, or the
current `../remote-dev` predecessor, can still send v1 to a v2-capable server.
New clients choose v1 only when the ready server capability says
`capabilities.auth.keyChallenge.v2` is absent or false. A network, timeout,
malformed, or 5xx capability-probe failure does not trigger a v1 downgrade.
Clients do not advertise their challenge version. Retire v1 only after immutable
stable/preview artifact evidence and the current predecessor show that no
supported authenticating client still needs it. This is a release-frontier
decision based on immutable artifact evidence and current predecessor behavior.

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

Signed terminal credentials carry `account_automation`, not present-user
authority. Automation definition/run management reads and mutations, run
cancellation, and webhook
endpoint/status/replay/discard controls therefore return
`present_user_required` to terminal callers. Automation worker routes use the
separate machine path: the request must carry a current machine-installation
publisher proof whose machine matches the requested `machineId`.

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

The direct Account-server routes behind Settings and daemon verification are:

- `POST /v1/auth/api-tokens/create` — requires `present_user` and returns the
  plaintext bearer once with its non-secret summary.
- `POST /v1/auth/api-tokens/list` — returns non-secret summaries through the
  signed Account credential path; an API Token is not accepted as the route
  credential.
- `POST /v1/auth/api-tokens/revoke` — requires `present_user` and revokes the
  exact Account-owned token id.
- `POST /v1/auth/api-tokens/revoke-all` — requires `present_user` and revokes
  every API Token for the authenticated Account.
- `POST /v1/auth/api-tokens/introspect` — uses the daemon's signed Account
  credential to verify a PAT supplied as the request subject. It returns only
  the minimal Account-bound `account_automation` principal and never returns
  the bearer.

## External Action API (Developer Preview source contract)

The protocol declares one public Action path and strict finite JSON envelopes:

```text
POST /v1/actions/:actionId
Authorization: Bearer <API Token>
```

Both the daemon-local adapter and the server-origin relay are implemented and
have been exercised together on the development stack, including server
routing to the selected daemon. This remains a development-source contract;
the HTTP API has not been deployed or released.

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
surfaces. Each public ingress verifies the PAT in Fastify `onRequest`, before
the JSON body parser runs. The API does not use SSE, has a 32 MiB
(33,554,432-byte) request-body ceiling, sends `Cache-Control: no-store`, and
does not enable CORS. The server-to-daemon relay accepts a 33 MiB
(34,603,008-byte) request carrier, leaving one MiB of framing headroom above
the public body limit. The server-mediated design is intentionally plaintext to
the configured server and avoids requiring an inbound public daemon address;
use daemon-local transport for direct local delivery. The transport does not
retry or fail a mutation over to another origin.

The API and Trusted plugins settings default to Allowed for Actions available on
those surfaces, so Action Settings add no approval prompt by default. A non-safe
contributed Action still requires the canonical live current-intent confirmation;
Allowed does not suppress the contribution's independent safety contract. A
present user can change either setting to require approval or turn the Action
off; neither setting exposes host-internal Actions or raises an API Token or
plugin above `account_automation`. Token management, approval decisions, and
other present-user controls remain discoverable where applicable but return
`present_user_required`.

### Contributed Action discovery and invocation

`action.spec.search` includes definitions contributed by the selected daemon's
currently committed plugin runtime when they are available and enabled for the
API surface. `action.spec.get` accepts the returned qualified id in
`<pluginId>/actions/<localId>` form and returns the complete declared input
schema. Invocation remains one host Action: call `action.invoke` with the exact
`{ pluginId, localId }` identity and declared input. The daemon resolves the
current plugin generation again before execution and applies the qualified
Action's API setting, plugin authorization/grants, availability, and any
non-safe current-intent confirmation; installation alone grants none of those
decisions.

Both the daemon-local and server origins limit the complete serialized response
envelope—not only `execution.result`—to 24,000,000 UTF-8 bytes. When an Action
finishes but its response would exceed that limit, the admitted HTTP response
uses the normal envelope with `execution.ok: false`,
`execution.errorCode: "result_too_large"`, and:

```json
{
  "executionCompleted": true,
  "maxSerializedBytes": 24000000
}
```

Those fields are the error's `execution.details`. `executionCompleted: true`
means the Action may already have committed a mutation, so callers must not
blindly retry it. They should inspect current state or use the Action owner's
idempotency contract. Actions with large data should return Artifact references,
use an existing stream Action, or expose bounded or paginated reads instead of
one oversized inline result.

The generated [SDK API inventory](../packages/sdk/API.md) is an export census,
not a complete Action method reference. Built-in Action contracts live in the
generated [Host Actions reference](../apps/docs/content/docs/plugins/api/host-actions.mdx).
Runtime callers discover available Actions with `actions.search` and
`action.spec.get`, then use raw `actions.execute` when the id is selected
dynamically. None of these should be duplicated as a hand-written Action list.

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
