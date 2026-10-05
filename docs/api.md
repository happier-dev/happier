# API

This document covers the HTTP API surface and authentication flows. For WebSocket updates and event payloads, see `protocol.md`. For encryption boundaries and encoding details, see `encryption.md`.

## Method conventions
- **GET** is used for reads.
- **POST** is used for mutations or actions, even when the operation doesn't map cleanly to a single entity.
- **DELETE** is used when intent is unambiguous (e.g., removing a token or deleting a session/artifact).

We intentionally avoid the full REST verb palette because many operations span multiple entities or have non-CRUD semantics.

## Authentication
Most endpoints require `Authorization: Bearer <token>`.

### Home authentication entry (0.3 development source)

`POST /v1/auth/entry` is the public, stateless discovery endpoint for the
current Home authentication screen. Responses carry `Cache-Control: no-store`
and grant no authentication or provider authority. The complete encoded
response is limited to the same 1 MiB receive budget as other public pre-auth
metadata; clients enforce the limit while streaming and do not trust
`Content-Length`. The server returns terminal `unavailable` rather than omitting
executable methods when a complete safe projection cannot fit. The strict
request is:

```json
{ "v": 1, "scope": { "kind": "home" } }
```

Callers may add `"purpose": "account_service"` when deliberately authenticating
to a verified Account Service.

Two further scopes are implemented and require the `teams` server feature bit:

```json
{ "v": 1, "scope": { "kind": "team", "teamId": "..." } }
{ "v": 1, "scope": { "kind": "invitation", "token": "..." } }
```

Both answer `admission_required` with the Team's safe name and logo plus the
projected actions, and both collapse every unavailable case — feature disabled,
unknown, archived, terminal, unreadable policy, or oversized projection — to the
same `unavailable` / `entry_not_available` result, so neither Team existence nor
token validity can be probed. Team scope additionally projects a Team-origin
`connect` row for each `connected` identity connection whose provider instance
currently resolves as enabled and configured, filtered to the exact usable
choices when the Team's authentication policy is restricted. Invitation scope
loads those same current connections and provider descriptors in the deciding
transaction; it never substitutes an empty connection set or widens a restricted
policy to inherit.

Whether a Team or invitation page stays open is one question with one answer:
does the policy currently offer a usable choice? An `inherit` resolution always
does; a `restricted` one does when at least one accepted choice is currently
usable. A successful provider test — activation readiness — is the *policy
writer's* precondition, enforced when the policy is saved, and is deliberately
not a member-entry gate, so an accepted-but-untested choice still appears on the
admission page. `resolveTeamAcceptedChoiceAvailability` in
`apps/server/sources/app/auth/entry/resolveTeamAuthenticationPolicy.ts` is the
single evaluator of that per-choice availability, shared by entry, policy
administration, activation, and credential qualification. It distinguishes an
*unreadable* choice — a read owner reported a failure — from an *unavailable*
one, which is a reference the provider catalog does not currently offer: a
disabled method, a Home-narrowed provider kind, or a disconnected connection.
The qualifier states the result in three words used everywhere downstream:
`satisfied` (the credential proves one accepted reference), `authentication_required`
(at least one accepted reference is offered but unproven — a 403 carrying those
references), and `unavailable` (malformed policy, unreadable fact, or nothing
offered — a 503-class answer).

The endpoint is public but optionally authenticated. When the request carries an
ordinary present-user Home credential, it is verified through the same bearer
verification and login-eligibility owner the authenticating route decorator uses
(`apps/server/sources/app/api/utils/verifyRequestPrincipal.ts`). A Team-scope
request from a caller who already holds an effective membership of an
inherited-policy Team answers `already_member` with a single methodless
`{ "kind": "continue" }` action instead of offering another sign-in. A
restricted-policy Team answers the same way only when the credential carries
evidence matching one currently usable accepted method or connection. Absent,
malformed, ineligible, and restricted credentials without matching evidence resolve anonymously;
API tokens and Account Directory credentials receive the ordinary
`admission_required` projection, so the endpoint cannot disclose membership to
anyone but the member. Matching evidence is server-produced and is never
accepted from the request body.

A ready response returns the exact enabled `authenticate` action rows. Each row
names the method, one `login`, `provision`, or `connect` action, its `keyed`,
`keyless`, or `either` mode, Home origin, and non-secret presentation. Consumers
must use those action/mode pairs as projected rather than reconstructing them
from provider configuration. `autoRedirect`, when present, selects only a
projected `login` or `provision` row. Terminal responses are strict, contain no
actions, and use `denied`, `unavailable`, or `update_required` state.

Two filters narrow that row set, both applied in the one projector
(`projectHomeAuthenticationActions`). A Home `connect` action attaches a method
to the caller's *existing* Account, so a request carrying no authenticated
principal is offered none — its only completion lives in the signed-in Account
Security flow. Team-origin `connect`, which is SSO through a Team connection, is
a different row and is unaffected. Separately, a Home `provision` action is
withheld when the public-signup provisioning policy denies it for the
route-attributed request address; the address reaches the projector as
`requestIp` on the entry context, and without one the catalog is unrestricted.
Home and Team scope carry the address; invitation scope deliberately does not,
because every invitation finalizer already exempts invitation admission.

For `purpose: "account_service"`, a Home without the current Account Directory
capability returns `unavailable` with reason `not_account_service`; it does not
return ordinary Home actions. Account Service clients verify the endpoint
identity and capability before requesting this projection.

The 0.3 clients fall back to the legacy `/v1/features` authentication projection
only when `/v1/auth/entry` is absent: HTTP 404, 405, or 501. A network failure,
another unsuccessful status, invalid JSON, or a schema-incompatible response
fails closed as unavailable or incompatible and never triggers that fallback.

That fallback endpoint publishes the Home's **effective** sign-in service, not
the deployment value. `resolveEffectiveHomeSignInServicePolicy`
(`apps/server/sources/app/auth/methods/signInServicePolicy.ts`) is the one
composition: the deployment policy, narrowed by the persisted Home policy, and
withheld entirely when `self` mode lacks the Account Directory capability a
self-hosted service requires. The synchronous features assembler reads no
database, so it composes that rule with no narrowing and publishes the
deployment recommendation; the `/v1/features` route then replaces it with the
effective value it already resolved for the method catalog, and omits the
service while the Home policy is unreadable — the same fail-closed posture auth
entry takes. Neither side composes the rule a second time.

The server derives core actions from the effective authentication-method owner
and provider actions through the asynchronous identity-provider catalog, which
composes built-in, deployment-configured, and database-managed providers. See
[enterprise-identity.md](enterprise-identity.md) for the managed provider,
Team connection, and directory domain, and for the seams that remain open.

### Native email/password operations (0.3 development source)

Clients discover native login and provisioning through `POST /v1/auth/entry`; they
must not infer availability from a form or a feature flag. The public email
operations are:

- `POST /v1/auth/email/verify/request` and `/preview`
- `POST /v1/auth/password/reset/request`, `/preview`, and `/submit`

Request endpoints intentionally return non-enumerating results. Preview endpoints
validate a one-time bearer without consuming it. Only the explicit provision,
email-change completion, or password-reset submission consumes the capability.
Bearer URLs use `/auth/email/verify/<token>` and `/auth/password/reset/<token>`;
they must be redacted from logs and telemetry and served with a no-referrer policy.

Authenticated Account Security uses the Protocol-owned paths
`/v1/account/security`, `/v1/account/password/enroll/email/request`,
`/v1/account/password/enroll`, `/change`, `/remove`,
`/v1/account/email/change/request`, and `/v1/account/email/change`. E2EE credential
mutations prepare their proof at `/v1/auth/password/mutation/challenge`. The safe
`GET /v1/account/security` projection accepts the currently authenticated Account's
ordinary credential or API token. Every mutation and proof-preparation operation
requires a present-user credential; an API token or autonomous runtime cannot be
silently upgraded to a human security operation.

Email-verification bearers are consumer-qualified in their existing `RepeatKey`
record. Fresh Account, Team invitation, first password enrollment, and sign-in-email
change consumers reject one another's bearers. A transferable Team invitation is
carried into the public verification request so the server can bind the mailed proof
to that exact still-current invitation; invalid invitation requests remain neutral
and create no usable operation.

All request and success response bodies are strict Protocol schemas. Account
Security mutations publish the existing Account change/invalidation and
authentication-change notice; they do not introduce a separate security-event
stream.

### Signed bearer provenance (0.3 development source)

New signed credentials carry a signed top-level provenance marker with a
closed token kind and authority. The server validates that marker before
projecting an authenticated principal; a missing, malformed, unknown, or
future marker never defaults to ordinary Account authority.

The `account_directory` kind is a restricted Account Service credential. It is
accepted only by Account Directory routes that explicitly opt in through the
central route-admission policy. Normal Home APIs, Socket.IO, terminal and API
Token paths, and other direct bearer consumers reject it. Database-backed API
Tokens remain a separate opaque credential format and are never inferred from
signed-token payload fields.

During the 0.3 transition, the named legacy ordinary-Home verifier may read
pre-marker Home credentials on ordinary Home routes. That compatibility reader
cannot authorize Account Directory routes or classify a malformed new token.
String-valued `provenance` emitted as opaque library metadata by released
`privacy-kit@0.0.25` tokens remains part of that pre-marker shape; only the
strict structured V1/V2 union carries current provenance or authentication
evidence.

### Account lifecycle admission (0.3 development source)

`Account.status` is the current admission fact for signed credentials and API
Tokens. Only `active` Accounts may mint or verify either kind. Verification
rereads the Account even when cryptographic verification or external-provider
eligibility is cached. `suspended` and `disabled` both fail credential
verification opaquely. PAT introspection has no "inactive" success shape: a
token whose Account is not `active` fails verification and the route answers
`401 { error: "invalid_token" }`, exactly as it does for an unknown, expired or
revoked token. A success body names the Account, principal, credential, expiry
and authority only.

Home administration displays reversible `suspended` as **Disabled**, while
terminal `disabled` means **Retired**. Re-enable requires fresh authentication:
revoked signed credentials and deleted PATs never become usable again.
Account lifecycle is separate from external identity eligibility and from
Account encryption mode or key readiness.

The lifecycle owner changes status, increments the signed-token epoch, deletes
API Token rows (including optional encryption access), and advances the Account
change cursor in one transaction. User and machine sockets disconnect after
commit. Repeating the same status change does not revoke or advance the cursor
again. Sessions-only sign-out retains API Tokens and their encryption access.

A fresh, valid sign-in proof for an inactive Account returns
`403 { error: 'account-disabled' }`. Invalid proof and issued credentials retain
neutral authentication failures. Encryption transition preparation and
activation recheck active status under the same Account fence as Disable;
cancellation and erasure cleanup remain available to their admitted owners.

For mTLS browser handoff, `/v1/auth/mtls/complete` redirects a valid certificate
for an inactive Account to the allowlisted callback with `error=account-disabled`
and no claim code. The callback retains the Home captured when authentication
started. `/v1/auth/mtls/claim` consumes a valid claim once and returns the same
403 error if its Account became inactive; invalid or consumed codes remain
`401 { error: 'invalid-code' }`.

### Key-challenge login (v2)

The current challenge contract is a server-issued, single-use challenge bound
to the server audience. The client signs the issued facts; it never invents
challenge material:

1. **Issue** — `POST /v1/auth/challenge`
   - Body: `{ "expectedAccountId": "..." }` (optional; required when the login
     must resolve to one exact E2EE Account).
   - Response:
     `{ "challengeId", "nonce", "issuedAt", "expiresAt", "audience": { "origin", "serverIdentityId" } }`.
   - The challenge is valid for 5 minutes, is bound to the canonical server
     origin and the server identity, and can be redeemed exactly once. When
     the server cannot establish its canonical URL or identity it returns
     `503 { "error": "key_challenge_v2_unavailable" }`.

2. **Sign** — the client builds the canonical signing input from the issued
   facts (domain `happier.key-challenge.v2`, `challengeId`, `nonce`,
   `issuedAt`, `expiresAt`, `audience`, plus `expectedAccountId` when used)
   and signs it with the account Ed25519 key. The protocol package owns this
   encoding (`createKeyChallengeV2SigningInput`); clients do not hand-roll it.

3. **Redeem** — `POST /v1/auth`
   - Body: `{ "challengeId", "publicKey", "signature" }` plus the optional
     `contentPublicKey`/`contentPublicKeySig` pair and `expectedAccountId`
     (base64 strings; the content-key fields are only ever supplied together).
   - The server rebuilds the expected signing input from the stored challenge,
     verifies the signature, enforces expiry, audience, and expected-account
     correspondence, consumes the challenge atomically, and returns
     `{ success, token }`. A challenge that was already redeemed, expired, or
     issued for a different audience or account fails with `401`.

**Audience trust model.** The server owns the binding: it stores the challenge
with its own canonical origin and server identity and rebuilds the signing
input from that stored record, so a client can neither widen nor retarget a
proof. What a client refuses depends on what it already knows about the Home:

- **First contact** — no completed authentication with that server identity on
  this device — is address-bound: the issued `audience.origin` must equal an
  address the contacted endpoint could not have supplied in band. That anchor is
  either the address the person selected and this device is contacting, or a
  canonical URL that arrived out of band with a scanned or pasted Home
  descriptor; a canonical URL read back from profile state is not one. At first
  contact the server identity is itself learned through that endpoint, so an
  endpoint that proxies the real Home's `/v1/features` and `/v1/auth/challenge`
  could otherwise collect a signed proof and redeem it at the real Home. A
  difference is not a dead end: the client asks once, naming both addresses, and
  signs only if the person confirms.
- **Established Homes** — this device holds credentials for that server
  identity, written after a completed authentication and never by the pre-auth
  feature probe — are identity-bound: `audience.serverIdentityId` must match and
  any address the Home answers on is accepted, so one Home stays usable over
  LAN, Tailscale, tunnels, port forwards and dev targets.
- A challenge issued by a *different* server identity is always refused.
- Identity pinning itself stays trust-on-first-use in the feature probe, and a
  later identity change for the same address is refused rather than relearned.

The password-credential mutation proof
(`createE2eePasswordMutationChallengeProofV1`) only ever runs inside an
authenticated session for the Account it mutates, that is on an established
Home, so it is identity-bound: it refuses
`password_credential_challenge_identity_mismatch` on a different
`audience.serverIdentityId` and accepts an alternate issued origin. Server-side
verification and every signing input are unchanged — a proof always covers the
issued audience verbatim.

Account Service key login uses the same canonical v2 encoding through the
dedicated `POST /v1/auth/account-directory/challenge` and
`POST /v1/auth/account-directory` endpoints. These routes are always v2-only,
even when ordinary Home compatibility still permits v1, and they mint only the
restricted `account_directory` credential kind.

In 0.3 development source, deliberate Directory-purpose key or OAuth authentication
on a deployment configured with `HAPPIER_AUTH_SIGN_IN_SERVICE_MODE=self` also ensures
that Account's self Home link and Directory entry. This applies to fresh Accounts
and existing unlinked Accounts. The existing link owner preserves exact retries and
rejects conflicting pinned trust with HTTP 409 and the canonical Directory
`invalid_request` response; replacing trust remains an explicit relink operation.
Ordinary Home authentication does not create Directory entries. Signing capability
alone, disabled policy, or an external recommendation does not activate this effect.
Descriptor discovery occurs before the write transaction; the transaction rechecks
policy, Account status and existing trust through their canonical owners. Responses
remain purpose-specific: the restricted credential is never bundled with a Home token.

Bearerless Home assertion redemption verifies proof and the exact credential
destination before consuming `enforceLoginEligibility`, and rechecks disabled status
through `Account.status` under the issuance transaction's Account fence. Existing authenticated
assertion/approval routes continue to use shared authenticated admission. A redeemed
Home bearer alone does not prove E2EE material readiness: clients must read the exact
Home Account's encryption mode and recover missing material before opening encrypted
content.

Clients do not advertise their challenge version. A client uses v2 only after
the ready server capability says `capabilities.auth.keyChallenge.v2` is
present and true. A network, timeout, malformed, or 5xx capability-probe
failure does not trigger a v1 downgrade.

### Terminal and account-link auth

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

### v1 raw-challenge compatibility

The original signed-raw-challenge shape is a supported compatibility
transition, not a permanent contract. `POST /v1/auth` also accepts
`{ publicKey, challenge, signature }` (base64 strings) plus the optional
content-key and expected-account fields; the raw challenge bytes are the
signing input, and the server verifies the signature using the provided public
key, upserts the account by public key, and returns `{ success, token }`.

Unlike v2, this historical shape does not carry a server-issued, one-time,
audience-bound challenge record. It remains only for the supported transition
frontier below; replay-resistance claims apply to v2.

Retain v1 only while a published stable or preview artifact, or the
current `../0.2` predecessor, can still send v1 to a v2-capable server.
Retire v1 only after immutable stable/preview artifact evidence and the current
predecessor show that no supported authenticating client still needs it. This
is a release-frontier decision based on immutable artifact evidence and current
predecessor behavior.

Signed terminal credentials carry a minted `account_automation` floor. In 0.3
development source, their effective authority is present-user when the Account's
`terminalPresentUserPolicy` is `allowed` (the default). A CLI/daemon machine can
force it off with `HAPPIER_CLI_PRESENT_USER=disallowed`; its HTTP
`x-happier-authority-ceiling: account_automation` and socket `authorityCeiling`
can only lower authority. With the effective policy disallowed, present-user
operations return `present_user_required`. Automation worker routes use the
separate machine path: the request must carry a current machine-installation
publisher proof whose machine matches the requested `machineId`.

Protocol's `readAuthTokenProvenance` is the shared signed-provenance reader for
the Home, CLI and app. App/native redemption defaults to an Account credential;
CLI redemption requests the literal `credentialKind: 'terminal'`, and the Home
stamps that narrower kind. Neither a caller-supplied authority nor a UI stamp is
credential provenance. The reader accepts the supported released raw top-level
session and normalized `extras.session` shapes, but malformed or future
structured markers fail closed rather than becoming legacy Account credentials.
The CLI asks for one re-login when an installed stored bearer is Account-kind;
it removes only the selected Home's bearer, preserving local material and other
profiles. Supported pre-marker terminal credentials are not blanket-invalidated.

### API Tokens (development source)

API Tokens are opaque `hap_v1_…` credentials stored server-side as
digest-backed records and shown in plaintext only in the mint response. The
canonical verifier accepts them as `account_automation`; it does not make the
caller a present user. List responses retain only a shortened non-secret
prefix in the same `hap_v1_` form (for example `hap_v1_2c67deea…`), never the
complete bearer or secret. Root-token creation, revocation, revocation of all
tokens, sign-out-everywhere and security/API-policy
controls require `present_user`.

`ApiTokenGrantV1` is the canonical grant (optional only on root creation): Action families/ids,
session/machine targets, opt-in `approve`, origins, models, permission modes and
bound creation placement. A missing persisted grant reads as the full grant,
whose `approve` is false. `evaluateApiTokenGrantV1` applies at HTTP, socket-event
and declared RPC admission, and again in the daemon executor. Approval and
permission decisions use `approve` plus target membership, without requiring
the approved Action itself. Tokens may decide their own requests. Conversational
`session.user_action.answer` instead uses the Action allowlist.

`account.sessions.signOutEverywhere` invalidates
signed sessions but intentionally leaves API Tokens active; revoke API Tokens
through their individual or all-token controls instead. Server-origin
verification sees revocation on its next verification. The daemon has only a
bounded, in-memory positive validation cache: at most 60 seconds and never
extended while server introspection is unavailable.

The direct Account-server routes behind Settings and daemon verification are:

- `POST /v1/auth/api-tokens/create` — requires `present_user` and returns the
  plaintext bearer once with its non-secret summary; accepts optional `grant`
  and `embedConfig`. Its strict optional
  `encryption` arm lets a trusted current device supply one token-bound wrapped
  Account content key in the same atomic insert; a partial arm is rejected and
  never falls back to bearer-only creation.
- `POST /v1/auth/api-tokens/list` — returns non-secret summaries through the
  signed Account credential path, including the required
  `hasEncryptionAccess` fact, grant, embed configuration and `activeChildCount`.
  It lists roots only; an API Token is not accepted as the route
  credential.
- `POST /v1/auth/api-tokens/revoke` — requires `present_user` and revokes the
  exact Account-owned token id.
- `POST /v1/auth/api-tokens/revoke-all` — requires `present_user` and revokes
  every API Token for the authenticated Account.
- `POST /v1/auth/api-tokens/update` — `account.apiTokens.update`, present-user;
  accepts `{tokenId, label?, grant?, embedConfig?}` with at least one changed
  field. Changing the grant revokes children and disconnects their sockets;
  label/configuration-only edits retain them.
- `POST /v1/auth/api-tokens/children/create` — parent API-token bearer; strict
  `{tokenId, label, expiresAt, grant, requireCreatedByChildTokenId?}`. The expiry
  is required, future and no later than the parent's, with no additional TTL
  cap. The grant must monotonically attenuate the parent's. A child cannot
  mint grandchildren and carries no encryption access or authentication evidence.
  The optional creation witness verifies every requested session was created by
  that child of the caller before the explicit-session credential is minted.
- `POST /v1/auth/api-tokens/children/revoke` — parent API-token bearer;
  `{tokenId}` can revoke only its own child.
- `GET /v1/auth/api-tokens/self` — API-token bearer; returns
  `{accountId, credentialId, parentTokenId, expiresAt, grant, embedConfig}`.
  Children receive their parent's embed configuration. No secret or content key
  is returned. Child/self operations are Home-only, independent of the Action
  executor; the SDK reports `unsupported_endpoint` for a daemon-local origin.
- `POST /v1/auth/api-tokens/introspect` — uses the daemon's signed Account
  credential to verify a PAT supplied as the request subject. It returns only
  the Account-bound `account_automation` principal including grant, parent and
  embed configuration, and never returns
  the bearer.
- `POST /v1/auth/api-tokens/encryption-access` — accepts an API Token and returns
  only that exact token's current wrapped Account content key. It cannot select
  another token, initialize or repair Account keys, or return the local
  wrapping secret.

Parent revocation cascades to children. Revocation and grant edits disconnect
token viewer sockets; socket expiry is enforced independently of later traffic.
These unreleased 0.3 authority-bearing carriers require the current 0.3 Home
and daemon together. The upgrade is one-way; mixed 0.2/0.3 running components
are not supported, while retained 0.2 Account and Session data remain readable.
Optional-looking proof fields are authority-bearing and must not be treated as
safely ignorable by older receivers. This is the existing
[0.3 compatibility contract](compatibility.md), not an additional update gate.

API tokens can open only a session-scoped viewer connection, never user/machine
rooms or RPC receivers. Each token-usable socket event and RPC declares an
Action id, and capabilities are intersected with the grant's ceiling.

Requests carrying `Origin` must match `grant.origins` or the configured Happier
web-app origin. The server checks this before JSON parsing and uses the same
rule at socket admission. Missing `Origin` leaves non-browser requests
unaffected. HTTP preflight is handled by server CORS; daemon loopback stays
closed to browsers. This is an origin policy, not isolation from same-user
processes or a defense against callers that can omit the header.

Grant/target denial is `credential_scope_denied`; origin denial is
`credential_origin_denied`. Child widening or invalid expiry is
`api_token_child_invalid`; grandchild creation is `api_token_child_forbidden`.
The daemon enforces effective per-input model/mode restrictions with
`model_not_granted` and `permission_mode_not_granted`, including native/default
selection and inputs without an override. A grant is never stored on a Session.

`GET /v1/account/security` projects the plain `terminalPresentUserPolicy`.
`POST /v1/account/security/terminal-present-user` is the present-user Action
`account.security.terminalPresentUser.set`, accepting and returning `{policy}`.
It disconnects terminal sockets once after commit so reconnect verifies the new
policy. The plain policy has one owner; it is not duplicated in sealed settings.

The trusted creator combines an encryption-capable token locally as `hapc_v1`.
Only its embedded `hap_v1` bearer crosses HTTP authentication; the local
wrapping secret never reaches the Home, Action input, approval artifact, logs,
or a child-process environment. The compound form is accepted by the in-process
SDK and deliberately rejected before CLI tmux/child continuation rather than
being downgraded to its bearer.

An encryption-capable token grants Account-wide content access through its
wrapped content key, not merely Session access. Revocation — including
`revoke-all` and Account disablement — stops future authorization and PAT-self
retrieval, but it cannot recall a content key a client already opened or undo
work already admitted under it. Trusted clients never export the recovery or
signing key, and issuance verifies encryption currentness lazily through the
canonical `aemk1_` Account-content-key fingerprint
(`computeAccountEncryptionMigrateKeyFingerprintV1`); substituting the
Machine-installation fingerprint is a contract violation.

Typed management failures are stable codes, not prose: `403
api_token_required` when a non-token credential calls the PAT-self route; `409
api_token_id_conflict` for a pre-effect UUID collision (an explicit retry
generates a new UUID and never overwrites or rediscloses the conflicting row);
`409 api_token_encryption_not_ready` when encrypted creation runs without valid
current Account material; `409 api_token_encryption_stale` when the authoritative
mode/key binding changed; and `409 api_token_encryption_unavailable` when the row
has no wrapping record. Every known pre-effect refusal returns no recovery token
id.

A lost create response may leave a created token. The client-known UUID captured
before wrapping is the bounded recovery selector: same-Account list/revoke stays
available, a response/selector mismatch is reported as
`api_token_response_mismatch` without revealing a usable credential, and a
genuine post-dispatch acknowledgement loss is reported as
`api_token_creation_outcome_unknown` rather than assumed harmless. There is no
automatic creation retry, response ledger, or cross-Account revoke. The canonical
list is complete rather than paginated: after an uncertain create, a successful
same-Account list settles the retained selector authoritatively. If the exact row
is present, recovery remains limited to inspecting or revoking that row; if it is
absent, including because another client already revoked it, the client clears the
selector and may begin a deliberate new creation. It never adopts or revokes a
different returned row.

Protected whole-Action SDK invocation (complete request and complete
result/error/approval envelope encrypted under the opened content material, no
plaintext fallback) is the one encrypted path for compound credentials; it
does not downgrade to the plaintext External Action relay and it inherits Lane
05's accepted active-Home trust boundary. Direct-daemon admission remains bounded
by the existing non-sliding cache above; revocation and currentness block later
admission within that documented bound. The current source contains this SDK,
Home-relay, and daemon implementation with focused automated coverage. A loaded
end-to-end direct/relay journey has not yet run, so this is development contract
and implementation status rather than activation or release evidence.

Current development source also supports protected delivery to a restricted
Runner by its Machine or exact activated Session. The SDK resolves the Runner's
content key through the canonical signed Machine binding; a Session target also
requires the activation-signed claim for that exact Session, Machine and
activation. A substituted or ambiguous claim fails before Action dispatch.
The Runner uses the canonical receiver with its own content key and refuses
foreign targets before opening their envelope. It receives no Account encryption
material. These source paths do not establish a released or loaded-runtime
certification, and they preserve the same active-Home trust boundary above.

Raw V1 External Action calls made with the ordinary `hap_v1` bearer are
deliberately Home-readable in transit. Use the combined `hapc_v1` credential
with a supported protected SDK call when the request and result must not use
that plaintext relay path.

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
admits Home browser requests under the token origin policy above; daemon-local
delivery does not enable CORS. The server-to-daemon relay accepts a 33 MiB
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
plugin above `account_automation`. Approval decisions require the token's
opt-in `approve` grant and target membership. Token management and
other present-user controls remain discoverable where applicable but return
`present_user_required`.

Installed external plugins and first-party built-in plugins are equal trusted
consumers of the intentionally public Action/SDK surface: the same catalog, the
same settings, and the same `account_automation` ceiling apply to both, and
neither receives a private bypass. Human-secret operations (password,
recovery-key, and sign-in-email mutation) are deliberately absent from the
plugin and API surfaces in V1 because they are not public capabilities — not
because external plugins are less trusted than built-in ones.

### Team credential external Provider API (development only)

Current development source defines a separate resource-scoped external Provider API. It is not a
released Action API extension. Both `teams.credentialResources` and
`teams.credentialResources.externalApi` are on by default, with
`HAPPIER_FEATURE_TEAMS_CREDENTIAL_RESOURCES__ENABLED=0` and
`HAPPIER_FEATURE_TEAMS_CREDENTIAL_RESOURCES_EXTERNAL_API__ENABLED=0` as the operator opt-outs. The
separate external-API bit remains because accepting Provider requests from the public Internet is a
distinct operator and security decision; opting out of it does not disable the parent Team
credential product.

The one-time-reveal Team credential key resolves exactly one resource and API-client identity. The
Home verifies the key, current accountable Account membership, audience, resource/source
currentness, request policy, recorded-usage limits, and exact broker placement before forwarding a
typed Provider request to the broker Machine. Callers cannot choose a Machine, source or Pool
member, internal bearer, loopback port, or credential material. Requests use the same resource
admission and usage owners as in-product brokered calls.

This path is intentionally readable by the configured Home: request headers and Provider payloads
arrive at the Home in plaintext under HTTPS before the Home forwards them to the broker. It is not
direct-to-Machine E2EE and does not reuse the protected whole-Action envelope. Operators and API
clients must treat the Home as part of the trusted request path. CLIProxyAPI remains loopback-only
and is never exposed as a raw tunnel.

Failures are returned through the strict Team credential external error union, including current
authorization, source, broker, policy, and usage-limit failures. A failed or revoked resource never
falls back to a personal Provider connection or a different broker.

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

In development source, a limited API-token grant requires the exact valid
qualified Action id in `grant.actions.ids`; an unrestricted `actions: null`
grant also grants contributed invocation. A native qualified outer Action
id follows the normal exact-identity grant path. For the encrypted
`action.invoke` wrapper, the Home cannot see its inner identity. Its opaque
pre-open check admits the request for opening when the grant is unrestricted or
names at least one valid qualified Action id. The existing daemon then decrypts the
input and checks the exact resolved identity before execution or approval.

The signed frozen grant snapshot fixes the admitted invocation's scope.
Current grants are checked for liveness and attenuation, not used to widen or
replace that snapshot. `readCurrentExternalActionPrincipal` in
`apps/server/sources/app/auth/externalActionExecutionAuthorization.ts` requires
the entire frozen grant to remain within the current grant. Narrowing any part
of it, including an unrelated browser origin, invalidates that authorization and
prevents a deferred approval from executing even if its own Action and target
remain granted. Work whose effects were already admitted is not cancelled.
This uses the existing protected carrier: there is no
plaintext header selector, new carrier or contributed-Action API exclusion.
`contributedActionAdmission: 'pre_open'` is an internal authentication/currentness
stage, never a caller-supplied option.

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

## Live Session client (0.3 development source)

With `client` connected to the Account server, the public SDK root adds
`client.sessions.get(sessionId).live()` for an ordered
transcript, metadata, Agent state, pending requests, connection status and
available actions. Socket and Action adapters consume the same session-core
interpretation; they do not own a second transcript or permission model.
The private `@happier-dev/sync-client` package owns the shared wire-level socket,
RPC, envelope, page and catch-up primitives used by the UI, CLI and SDK.
Protocol owns `SessionMessagesPageV1Schema` and
`SessionPermissionRespondRpcParamsV1Schema`; consumers do not define rival wire
schemas.
Session detail reads use `accessProjectionVersion=1` and the canonical current
stored-content declaration. Availability comes from
`effectiveAccess.capabilities`; answering Agent questions uses Send authority.

Automatic transport selects `action` for an E2EE Session without a content
credential, and otherwise selects a session-scoped viewer socket. Failure to
open socket content is not a reason to silently switch transports. The Action adapter
uses the existing finite transcript Actions with `openedMessagesV1`, preserving
canonical rows, Agent-state versions and recipient-safe shared metadata. The
opened projection carries `sharedMetadata: {version, value} | null`, with the
strict `SessionSharedMetadataV1` value and a caller `sharedMetadataVersion`;
unchanged versions return null. Shared metadata supplies Action confirmations
and public completion facts to the same pending reader, never Account-private
owner metadata. A shared editor receives no owner Agent state.
An unopened row retains its identity and sequence with
`content: {t: 'plain', v: null}` and a typed `openFailure` of
`mode_mismatch` or `corrupt_or_unopenable`; it discloses no stored content.
The controller renders the canonical unsupported-content row and advances past
it. The socket adapter uses a session-scoped viewer socket and the Session-filtered
changes feed to repair reconnect gaps and revised rows. The Action adapter uses
`transcript.follow` with `waitForChanges: true`; its retained daemon lease observes
existing Home Session notifications using the daemon's exact Home connection and
credential. The response carries `changes` (append, revision with message id/seq,
Session change, or reconnect/reset) so repairs use finite Actions on either endpoint.
It opens no SDK viewer socket and makes no idle interval requests. A reconnect/reset
reloads authoritative history. The snapshot and daemon-opened rows refresh on a notification. Inactivity keeps
observation alive so external reactivation is visible.
Permission responses use the existing
permission Action's full protocol vocabulary; `action` has no abort Action.
Daemon-opened Action content crosses the Account server in plaintext; the socket variant
retains E2EE content framing end to end.
Controller cancellation/disposal is scoped to that controller, and root-client
closure also closes its controllers.

The public `followTranscript()` iterator uses that waiting Action at both Home and
daemon-local endpoints, without a polling-interval option. Its existing cursor,
backpressure, final inactive drain and lease-release owner remain authoritative.
The final drain remains finite. Caller abort releases the held wait and Home
notification subscription; the existing lease idle expiry pauses while a read is held.
No separate request duration is imposed.

Execution-run iterators instead use the existing `execution.run.stream.read` Action
with `waitForEvents: true`. The canonical stream owner holds an empty cursor read
until an append or terminal transition, with caller cancellation propagated through
the relay. This also covers detached runs and daemon-local endpoints. Omitting the
option preserves finite reads for other Action callers. A producer that returns an
empty nonterminal page to a waiting SDK read is reported as
`execution_run_stream_update_required`; the SDK starts no polling fallback.
The stream handle remains owned until `execution.run.stream.cancel` releases it,
including after a terminal read. The SDK releases automatically; finite Action
callers must also release their handles. Run/controller retirement removes access
to any remaining stream identities and terminal pages.

The same root uses a Node HTTP adapter or browser Fetch according to package
conditions. Browser use requires an allowed origin and an appropriately scoped
credential; never distribute a broad parent credential. These are development
additions, not a claim that an already published SDK supports them. See the
[SDK usage guide](../packages/sdk/README.md) for caller examples.

`client.sessions.list({ folderIds, tagIds })` uses the existing filtered
Session-list Action: any exact viewer folder assignment AND any viewer tag
assignment, with no descendant expansion. Unknown ids produce an empty match,
and existing cursor/access predicates remain in effect.
`GET /v2/changes?after=...&sessionId=...` provides exact Session/share revision
invalidation through the existing Account feed. Its cursor advances over the
raw page even when no matching rows are visible; `410 cursor-gone` requires a
snapshot rebuild. The separate `sessionAccessSessionId` probe cannot be combined
with `sessionId` (`400 invalid_params`).

## Endpoint catalog
### Sessions
- `GET /v1/sessions`
- `GET /v2/sessions/active?limit=...`
- `GET /v2/sessions?cursor=cursor_v1_<id>&limit=...&changedSince=...`
- `POST /v1/sessions` (create or load by `tag`)
- `GET /v1/sessions/:sessionId/messages`
- `DELETE /v1/sessions/:sessionId`
- `POST /v2/sessions/responsibility/set` (development source) — desired-state assignment of the one
  human Account currently responsible for a Session. Requires the actor's `assignResponsibility`
  capability and a target that already has current read access; it grants no access. Submitting the
  current value again is a true no-op. Returns `{ changed, responsibleAccountId, responsibleAccount }` from the
  committing mutation, including `changed: false` on a repeated value and the safe current summary
  for the authoritative id (`null` when unassigned). Self-assignment applies auto-Follow but sends
  no self notification. Archived Sessions retain responsibility and allow an otherwise-authorized
  manager to assign/clear without unarchiving. Answers `409
  session_responsibility_assignee_unavailable` for an absent, inactive or inaccessible target.
- `POST /v2/sessions/responsibility/candidates` (development source) — bounded, authorized page of
  active Accounts that can currently read the Session, for the responsibility picker and Lane 05
  mention discovery (`purpose: "assignment" | "mention"`). The
  canonical access predicate is applied before profile search and pagination; this operation
  does not enumerate the entire recipient audience. `assignment` requires `assignResponsibility`;
  `mention` requires `submitAgentInput` plus Lane 05 discussion admission and carries neutral
  identity only. Archived candidates use the same readable admission as the mutation. Both responsibility operations require
  the server's `sharing.session` feature and return `404` when it is disabled.

Current Session records expose `responsibleAccountId` as an Account ID or explicit `null`, plus the
paired safe `responsibleAccount` summary (`null` when unassigned, omitted exactly when the id is
omitted). An omitted field means responsibility is unavailable, not that the Session is unassigned.
An omitted field means responsibility is unavailable, not that the Session is unassigned.
Assignment changes only this current fact. Lane 09 owns assignment-triggered Follow and read
tracking; its post-commit Activity/alert integration remains unverified in development.

#### Session access authority (development)

`apps/server/sources/app/session/access/sessionAccess.ts` owns effective Session
capabilities and their supporting grant sources. Owner, direct Account, Team and
Group grants resolve through this policy; permission delegation must occur on the
same grant as the required access level. Public links do not become Account grants.
Unpublished transcripts admit their owner but cannot widen the collaborator audience.

Team and Group access is served wherever the Home's `sharing.session` feature is
enabled (`isSessionCollaborationEnabled()`); there is no separate collaboration bit,
and a disabled `sharing.session` withholds collective sources without affecting
direct Account shares. Only a persisted null Team authentication
policy currently admits evidence-independent membership access. The consumed Team
credential-proof producer is not yet available, so non-null policies cannot authorize
Team or Group access; independently valid owner/direct grants remain usable.

Active non-guest membership admits Team grants. A Group grant requires current Group
membership and active containing-Team membership, including a Team guest. Each grant
uses its own membership's `sessionAccessStartsAt`: null admits existing grants, while
a timestamp requires immutable grant `effectiveAt` strictly after that timestamp.
A Group uses the Group membership cutoff independently of the Team cutoff.

`sessionAccessWhere.ts` compiles that same policy before database pagination, counts,
child reads and conditional mutations. Effective queries resolve membership facts
inside the consuming transaction; callers await the predicate and execute the query
in that transaction. Legacy owner/direct queries retain their explicit mode. Bounded
audience queries and batched capability projections consume this owner, including its
history rules; recipient expansion supplies synchronization targets, not notification
interest or new authority.

Protocol's `sessions/access/sessionEffectiveAccessV1.ts` owns the shared capability
rules and strict wire shape; the server supplies applicable grants and remains the
mutation authority. Current filtered-list records require `effectiveAccess`, while
legacy V2 records may omit it. Layout-one collective recipients may omit `share`
without being treated as owners: only an effective owner may carry owner metadata,
and that projection still requires `share: null`. The legacy owner/direct path keeps
its existing share discriminator and uses the shared capability calculation.
Decisive grant sources are a bounded explanation, not a complete relationship roster;
private Follow preferences consume the server's separate applicable relationship kinds.
The server also projects one `audienceContext` from the viewer's applicable grants:
an exact Group precedes a Team, with immutable IDs deciding presentation ties.
Missing applicable collective grants produce null, including for owners who have no
such membership. Authored `primaryTeamId` is returned to the owner separately and
does not establish audience or access. UI context labels resolve that safe identity
through the exact Home-and-viewer-Account Team directory; unavailable labels remain
unknown. Losing an applicable context refreshes the Session projection even when a
stronger independent grant keeps its capabilities unchanged.

#### Private Session read state (development)

The development read-state implementation keeps one `AccountSessionReadState` row per Account
and Session. `personal/readState.ts` owns cursor changes and the stable `unreadSince` entry time.
Only Session creation for its owner and a new active Follow initialize a row. Access, opening,
direct sharing and pinning do not initialize tracking. An inactive retained Follow cursor stays
quiet, and a new Follow begins at the current readable publication ceiling.

`POST /v2/sessions/:sessionId/read-state` accepts `{ state: "read" | "unread" }`. It requires an
active Account, current `readTranscript` capability and owner-or-active-Follow tracking; edit
capability is not required. An accessible untracked reader receives `409 session_not_tracked`,
with its current `viewer` projection when still available. Success returns `success`, normalized
`state` (`read`, `unread` or `empty`), `lastViewedSessionSeq`, `didChange`, and the current `viewer`
when available. The socket `update-read-cursor` command retains monotonic cursor advances and
explicit `mark-read`/`mark-unread` operations; an explicit operation takes precedence over a
cursor in the same payload.

The public service and released owner metadata `readCursorHintV1` adapter delegate to the same
private cursor owner. Read changes record only the acting Account's change cursor and publish
only to that Account's devices. `viewer.readState` is authoritative for current clients; the
legacy scalar is projected from that same private row. Ordinary unread-producing content keeps
the cursor and stamps the unread-entry time once. Non-unread content advances only caught-up
tracked cursors, preserving deliberate unread state. External imports stamp the entry time when
their readable ceiling advances, not when a hidden tail is stored.

This describes development source, not a released upgrade guarantee. Shared-column migration
contraction, three-provider upgrade proof, effective Team-access integration and loaded
multi-device validation remain required before activation.

#### Session Discussions (development)

Session Discussions are a Session-owned conversation resource behind the
`sessions.conversations` server feature. The current source registers strict list, get, message
page, create, post, rename, archive, restore and private read-cursor routes. The feature bit is an
availability gate, not proof that a particular client, daemon or deployed Home supports the
composed flow; missing or disabled support fails closed as `session_discussions_unavailable`.
This is a 0.3 development contract and has not shipped in a public release.

The Session remains the access owner. Every discussion read and mutation resolves the actor's
current effective Session access in the transaction; a discussion has no independent ACL and
authorship never grants access. Mention targets are reduced to Accounts that can currently read
the Session. Losing the final applicable Session grant therefore removes discussion reachability
without deleting the retained conversation. Named-discussion absence and denial deliberately do
not become an existence oracle.

Discussion titles and messages use the same strict stored-content envelope family as Session
content. A Plain Session accepts only `{ t: 'plain', v }`; an E2EE Session accepts only
`{ t: 'encrypted', c }`. The CLI/daemon host opens or seals the semantic document with the
Session's current data key, while the Home validates mode, stores the envelope and compares
Session-keyed equality evidence without receiving E2EE plaintext. Missing or mismatched key
material fails closed; neither side reinterprets encrypted bytes as plain. List and message-page
projections can be explicitly incomplete when an authorized client cannot open an item.

Each message has one authenticated `authorAccountId`. Human-origin writes have no `producerV1`.
An Agent-origin post is admitted only from the runtime's authenticated execution Account and
carries mandatory host-stamped `producerV1` display provenance for that Session, optionally with
the execution Run and tool call. That provenance never selects the author or supplies authority:
the latest conversational message author, the person who requested the work, or a producer field
cannot lend identity to the runtime principal. Public HTTP callers cannot stamp Agent provenance;
the trusted current-Session publisher carrier is the only Agent-post path.

That separation applies to every autonomous Action, not only Discussion posts.
An authenticated human operation uses that human's admitted authority; an API
or SDK operation uses its credential principal; and an autonomous Agent or
trusted-plugin operation uses the runtime principal admitted by its host.
`requestedBy`, message authorship, and producer metadata are correlation and
display facts only. They cannot confer another Account's authority, change
Action settings, approve an effect, or prove filesystem isolation. Session
access, Action availability and confirmation, runtime/tool policy, and resource
authorization remain independent decisions at their existing owners.

Current deferred Action approvals persist the original admitted principal and
exact Home/Session/Machine/Run target in their strict body. Approval records use
the existing Artifact as the effect-custody owner: after the decision, one
compare-and-set winner advances `approved` to `executing`, performs the effect,
and settles `executed` or `failed`. Readers treat the header as an index and
require it to agree with the validated body. Released V1 records remain readable
history but are not executable; an indeterminate current `executing` record
returns `approval_execution_outcome_unknown` rather than being replayed under
the approving caller.

The Action family projects readable semantic documents after the trusted CLI/daemon host opens
the stored envelopes. Account automation may list, get, read and post within its authenticated
Session/runtime boundary. Discussion creation/management and personal read-state
mutation are also automation operations in current 0.3 source. API-token access
uses the canonical Action grant and target admission; Agent/MCP exposure stays
disabled for these human-discussion operations.

#### Personal relevance and attention from discussions (development)

`discussions/attentionFacts.ts` is the one bounded discussion adapter the personal owner consumes;
`personal/discussionFacts.ts` is the narrow port that turns its facts into relevance and attention
inputs. No second reader of the conversation store exists outside that adapter.

Participation and attention are separate contracts:

- **Human-origin discussion authorship** contributes `authored_by_me`, so a Session appears in
  `involving_me` and `my_work` before pagination. A post is human when `producerV1` is absent; a
  row an Agent produced on its own execution Account, and a "requested by" association that carries
  no author at all, are production facts and never human participation. Archiving a conversation
  does not retract authorship.
- **An existing mention** contributes `mentioned_in_discussion`, which is `my_work` relevance only.
  Being named is not participation, so it never enters `involving_me`.
- **Baseline-derived unread and unread mentions** contribute the `unread_discussion` and `mentioned`
  attention reasons. They require owner-or-active-Follow tracking, current `readTranscript` access
  and an established private discussion cursor, so browsing a shared Session, an absent cursor, an
  archived conversation and a viewer's own posts all stay quiet. An already read mention remains
  list relevance without ongoing attention.

The relational scope predicate, the pure viewer projection and `computeAccountActivityBadgeCounts`
consume the same facts, so the filtered list, the confirmed row and the pushed badge agree. Facts
are loaded once per page beside the owner account modes, never per row, and the adapter resolves a
whole candidate set — access, latest activity, cursors and unread counts — with a bounded number of
reads rather than one round trip per Session.

Badge refresh follows the same tracked relation. A discussion create, post, archive or restore
schedules `refreshTrackedSessionAccountBadgePushes` for the Session's owner-or-active-Follow
Accounts after commit; a rename does not, because a title carries no unread. A private discussion
cursor advance refreshes only the acting Account. Waking current readers through `AccountChange`
stays a separate, broader contract: access alone is never badge fanout.

One-shot `discussion_mention` candidacy remains separate from tracked Follow delivery. After a
discussion create or post commits, the mutation owner submits a content-free
`SessionPersonalEventKindV1` `discussion_mention` fact for the validated mentioned Account IDs
through `scheduleSessionActivityRemoteAlerts`. It also submits `human_message` for a directly
authenticated human post or `message` for a trusted runtime-produced post, while excluding the
same row's mention targets so the specific mention alert remains the single delivery candidate.
The Activity recipient and native clients retain their current access, Follow, privacy, decrypt,
and display decisions; no Discussion content is placed in the server-readable event.

#### Personal Follow (development)

The development server registers the personal Follow resource through
`registerSessionFollowRoutes`; `accountFollowService` owns its transactions and current access
checks. The `sessions.following` server feature controls availability. These endpoints are absent
from the inspected `server-v0.2.11` and `server-v0.2.11-preview.2` contracts; new clients must check
the feature before using them. Source implementation alone does not establish release availability
or completed runtime delivery validation.

- `GET /v2/sessions/:sessionId/follow` returns `{ follow, capabilities: { manageFollow } }`, where
  `follow` is null or `{ sessionId, following, notificationLevel, includeInVoice }` for the
  authenticated Account only.
- `PUT /v2/sessions/:sessionId/follow` accepts exactly `{ notificationLevel, includeInVoice }`
  and returns `{ changed, follow }`. Notification levels are `none`, `important`, and
  `all_messages`. A new Follow starts personal tracking at the current readable publication
  ceiling; updates to an already tracked owner or follower preserve that reader's progress.
- `DELETE /v2/sessions/:sessionId/follow` returns `{ changed }` and records explicit Unfollow.
  The retained suppression prevents a later automatic relationship event from undoing the
  choice. Existing owned state can be unfollowed after read access disappears without disclosing
  Session details.
- `GET` and `PUT /v2/account/session-follow-preferences` read or replace exactly
  `{ assigned, direct, team, group }`, with all four Booleans required on PUT. Defaults are
  `true`, `false`, `false`, `false`. These server-readable Account preferences apply only to future
  qualifying relationship transitions; changing them does not scan historical relationships or
  alter existing Follow choices.

GET and enabling Follow require an active Account and current Session `readTranscript` access.
Failures use `400 invalid_parameters`, `403 account_inactive`, `404 feature_unavailable`,
`404 session_not_found` (also for inaccessible Sessions), or `409 session_archived` when enabling
Follow on a readable archived Session. Successful idempotent writes return HTTP 200.

Follow changes use the existing private `account` AccountChange with entity `session-follows` and
a strict full-refresh hint. Follow rows and human responses contain no titles, transcript content,
or keys. Voice inclusion is independently configurable; its private nullable delivered frontier
means a current snapshot is pending when enabled. Enabling/re-enabling clears that frontier,
while an unchanged enabled preference preserves acknowledgement. Runtime delivery and its
acceptance-bound acknowledgement are separate from these human preference endpoints.
Archive retains Follow choices. A genuine restore clears enabled Account Voice frontiers to their
current-snapshot state and reseeds Session edges only when both endpoints are unarchived, in the
archive transaction. It does not advance a human read cursor or recreate a Follow deleted by access
revocation. Assignment and grant mutations invoke the same Follow service; Team/Group behavior
depends on the canonical effective-access producer, whose integration remains an open development
gate.

The development Home alert submitter composes personal-event eligibility with the recipient's
current settings-version-bound remote policy and enrolled device policy. A `suppress` decision
submits nothing; `silent` submits the generic alert without sound through the shared silent Android
channel. Audible alerts use the shared bundled/system sound and channel mapping; unsupported custom
sounds remain silent. Expo submissions carry `mutableContent: true` so an installed native extension
can enrich the permitted fallback. This flag does not supply that extension or prove native preview
or closed-app display.

Committed ready and assignment transitions currently schedule this Home leg. Ready still excludes
the Session owner unconditionally: authenticated runtime composition has not yet supplied the fact
needed to preserve the rich Account sender while including Runner owners. Permission/user-action
occurrence scheduling also remains unimplemented; opaque Agent-state changes or pending counts
alone are not new-event evidence. These gaps keep the complete remote-alert journey unverified.

#### Session-context Follow authoring (development)

The development Session router also registers
`GET /v2/sessions/:destinationSessionId/follows/sessions` and
`PUT`/`DELETE /v2/sessions/:destinationSessionId/follows/sessions/:sourceSessionId`.
These feature-gated endpoints manage source edges through `sessionFollowEdgeService`.
They do not establish runtime hydration or delivery readiness.

Authoring uses the canonical `mayInjectSessionContextInTx` access decision: the configuring
Account needs source transcript read and destination input access, the destination owner must
be able to read the source, and every current destination reader must be within the source
audience. An unexpired public destination share prevents admission even when its token-issuance
limit is exhausted, because an already issued public token remains readable. Expired shares
do not prevent admission. Saved edges are checked again when updated; key readiness is a
separate runtime concern and is not required to save an otherwise authorized edge.

Runtime source-read admission still requires the verified runtime-principal integration and
current access checks at the runtime boundary. The authoring endpoints are not proof that this
development integration is complete.

#### Widget storage and Action boundaries (0.3 development)

Widgets add no dashboard REST service. The generated
[host Action reference](../apps/docs/content/docs/plugins/api/host-actions.mdx)
owns current catalog, definition, instance, input, area-layout, Refresh and
snapshot operation schemas; [Actions](actions.md#widget-operations-03-development-source)
owns their invocation and approval boundary.

Public `session.presentation.apply` and SDK current-Session presentation DTOs
use the canonical author subset, which arranges readable built-in, Board-item
and pane references. Raw Companion widget-instance records and their mutation
or conditional-removal envelopes remain host-internal. Authors use qualified
`widgets.*` Actions for those operations and public plugin-ui `WidgetSurface`
for declared native page embedding, or declarative `widgetArea` nodes. Hosted
HTML pages do not embed host widget areas and use ordinary widget Actions;
this adds no parallel presentation endpoint or hosted widget-area API.

Account definitions (`widget-definition.v1`), Home layouts and personal
Project/plugin-area layouts (`widget-area-layout.v1`) reuse the existing
mode-aware Account Artifact transport and CAS admission. WorkBoard widget
placements reuse `work-board.v1` rather than a parallel Artifact. Shared Session
instances and inert snapshots use the Session Board writer below; direct
Companion instances remain device-local presentation preferences. Layout
identity is separate from a definition reference and the instance's input
bindings. Persisted Account mode, not key presence, governs every Account
Artifact read/write.

Viewer credentialed reads consume the viewing Account's existing qualified
Resource-consumer/purpose selection. Private selections and credentials are not
shared Board payloads. There is no per-instance viewer override or widget-local
selection setting; missing purpose selection leads to Connect. Pinned Connected
Account references are personal-only instance bindings. Changing the existing
purpose selection retains its normal preference lifetime and can affect other
viewer bindings using the same qualified purpose. Positive Project area operations
await the external portable Project Source producer. These development-source
contracts do not claim released or loaded-platform availability.

#### Session Board (development)

The shared Session Board stores its content as host Session System Records
(`surface/layout.v1/layout` and `surface/item.v1/<itemId>`) and exposes exactly one
mutation endpoint:

```text
PUT /v2/sessions/:sessionId/board
```

`createServerFeatureGatePreHandler("sessions.board")` runs before the handler, so a
Home with the feature off answers `404 { "error": "not_found" }` instead of revealing
the route. The route uses the `session.board` hot-endpoint rate-limit family.

The body is a closed operation union:

- `upsert_item` — `itemId`, `itemContent`, `expectedItemRevision` (`null` creates), and
  an optional `placement` carrying `layoutContent` plus `expectedLayoutRevision`.
  Creation without a placement is rejected, so a new item and its first Board
  placement commit together.
- `remove_item` — `itemId`, `expectedItemRevision`, and the exact replacement
  `layoutContent` with `expectedLayoutRevision`, so removal cannot leave a dangling
  placement.
- `update_layout` — `layoutContent`, `expectedLayoutRevision` (`null` creates), and an
  optional `itemPlacementParticipant` whose `expectedItemRevision` is verified in the
  same transaction when the semantic edit adds an existing item to a view.

Both record contents are the explicit Session stored-content envelope
(`{ t: 'plain', v }` or `{ t: 'encrypted', c }`). Revisions are opaque System Record
row versions and the compare-and-set operand is the exact stored envelope. Storage
mode, envelope correspondence, and retry settlement stay with the Session System
Record rules in [encryption.md](./encryption.md); this route composes them rather than
defining a second persistence contract.

Success returns the operation, its `outcome` (`created`, `updated` or `unchanged` for
upsert and layout; `removed` for removal), and the committed revisions. Protocol's
`isSessionBoardMutationResultCorresponding` is the shared check that a returned
document answers the issued request: a well-formed response is not by itself an
acknowledgement.

Failures use a closed error document — `400 session_board_invalid`,
`403 session_board_forbidden`, `404 session_board_item_not_found`, and `409` for
`session_board_storage_mode_mismatch`, `session_board_source_conflict` and
`session_board_revision_conflict`. A revision conflict may carry `currentItemRevision`
and `currentLayoutRevision` so a client can refresh and retry with current revisions.
Repair is that ordinary retry; there is no second endpoint.

Reads reuse the existing V1 System Record routes with the exact `surface` addresses:
`GET /v2/sessions/:sessionId/system-records` and
`GET /v2/sessions/:sessionId/system-records/record`. No Board-specific GET or cursor
exists. A `surface` read requires current `readTranscript` and separately resolves
`sessions.board`, so a Home with the feature off refuses the read rather than
disclosing the records. The `surface` kinds are typed-only: the record catalog marks
their generic write and delete unavailable, so neither the generic upsert on
`/v2/sessions/:sessionId/system-records` nor the generic delete on
`/v2/sessions/:sessionId/system-records/record` can reach them, and the predecessor host
list, lookup and upsert schemas exclude the namespace entirely. Every Board mutation
rechecks the actor's current `editSessionRecords` capability in the committing
transaction.

The mutating Board Actions — `session.board.item.upsert`, `session.board.item.remove`
and `session.board.layout.update` — declare this route as their `serverTransport`, so
UI, CLI and Agent callers share one writer. `session.board.get` declares no transport
and composes the System Record reads above. Layout placements may carry an optional
`frameStyle: 'card' | 'plain'` override. Editors set it through
`session.board.layout.update` with
`{ op: 'item.frameStyle', tabId, itemId, frameStyle }`; `null` clears the override.
It belongs to that shared placement, survives ordinary layout and item edits, and
wins over each viewer's Appearance default. The same item in another Board view
keeps its own placement style. When a request carries an API Token, the
route additionally requires an authorized external Action execution whose target is
this exact Session and whose root and effect Action id both equal the Board Action
matching the operation; anything else is `session_board_forbidden`. Raw `hap_v1`
bearer Board calls remain Home-readable in transit under the External Action API
boundary described above, including for E2EE Sessions; Session record storage
encryption is unchanged by that choice.

This is 0.3 development source. `sessions.board` is on by default
(`HAPPIER_FEATURE_SESSIONS_BOARD__ENABLED=0` is the operator opt-out, and the bit is
additionally ANDed with the observed Session System Records contract fact). The composed
Plain/E2EE client journeys and provider validation are release checks, separate from that
feature decision and from released availability.

#### Temporary-computer activation (0.3 development)

The development `/v1/ephemeral-runners/activations` routes use the
`sessions.ephemeralRunner` feature gate. Creator-authenticated creation reserves
the final Session and Machine identities against an existing new-Session draft;
it does not create either runtime resource. Exact reads by activation ID and
`GET /v1/ephemeral-runners/activations?draftId=...` recover the creator's activation.
The draft lookup selects only a pre-materialization attempt, including when an
opaque draft rewrite has dropped its activation reference.

Creator reads, claim and replacement creation share observed expiry and creator
currentness checks. Under the same Account fence, they close waiting attempts
whose optional deadline elapsed or whose creator binding was revoked. This
does not add a runtime deadline or a background expiry worker.

`DELETE /v1/ephemeral-runners/activations/:activationId` cancels that exact
creator-owned attempt under the shared Account transaction fence. It returns
the canonical projection: an already materialized or closed attempt retains its
actual state, and cancellation does not delete or restore draft content. Draft
deletion closes its pre-materialization attempts through the same lifecycle
owner.

The public `POST .../:activationId/endpoint/claim` operation requires the strict
signed claim bound to the activation, Home, creator, reserved identities,
artifact, endpoint box key, and Machine installation proof. Claim possession is
not an Account credential or runtime admission. These development routes do not
establish completed review/consent, Session materialization, or Runner runtime
support. Their implementation lives in `apps/server/sources/app/ephemeralRunner`.

`PUT .../:activationId/endpoint/facts` publishes a folder selection signed by
both the activation key and the winning installation key. It accepts explicit
Plain content for Plain Accounts and a sealed box for E2EE Accounts, bound to
the creator recipient captured at activation. Exact retries are idempotent;
the claimed endpoint can correct facts before consent. The eventual review
publisher must freeze facts under the same transaction fence when review begins.

The creator projection reports facts as absent, available signed content, or a
typed unavailable result. A changed Account encryption mode or recipient prevents
facts disclosure while leaving the activation control projection usable for
recovery and cancellation. The ciphertext bound derives from the canonical
folder-path limit, JSON encoding, and box overhead before decoding. Endpoint
facts persistence is implemented in development source; retained-database
deployment and the complete endpoint journey remain unverified.

### Machines
- `POST /v1/machines` (create or load by id)
- `GET /v1/machines`
- `GET /v1/machines/:id`

In 0.3 development, ordinary inventory and selection include only persistent
Machines. Session-bound temporary Machines retain exact authenticated reads and
Machine-scoped updates, but creation does not broadcast the legacy `new-machine`
inventory event. The same Machine-kind policy excludes temporary Machines from
replacement, Automation assignments and claims, and Automation Event watcher
currentness. This does not establish readiness of the complete Runner runtime.

#### Personal Machine Pools (0.3 development)

Machine Pools are Account-owned, Home-local saved groups of the Account's own
persistent Machines. The development contract exposes six strict POST Actions:

- `POST /v1/machines/pools/list` (`machines.pools.list`)
- `POST /v1/machines/pools/get` (`machines.pools.get`)
- `POST /v1/machines/pools/create` (`machines.pools.create`)
- `POST /v1/machines/pools/update` (`machines.pools.update`)
- `POST /v1/machines/pools/delete` (`machines.pools.delete`)
- `POST /v1/machines/pools/resolve` (`machines.pools.resolve`)

Every request and response body is a closed strict schema from
`packages/protocol/src/machines/pools/v1.ts`; unknown properties are rejected
rather than ignored. List returns `{ pools: [...] }` and get returns one entry of
the same shape: `{ pool, availability }`, where the saved definition and the
separately observed availability never merge into one field. `availability` is
either `{ state: 'known', connectedCount, enabledCount }` or `{ state: 'unknown' }`
when the Home could not observe its Machine sockets.

Create accepts a caller-minted UUID plus the name, optional description, and
complete member set. Repeating an identical normalized create at the same ID is
a read-only replay; a different aggregate at that ID conflicts. Update replaces
the complete definition and delete removes it. Deleting an already absent Pool
returns the same settled success. Update and delete always carry
`expectedRevision` in the request body. A differing stale update or stale delete
returns `pool_changed` with the caller's current owned view; an already-settled
update is a read-only success. A create whose ID already belongs to another
Account returns `pool_changed` with no `current` view, so a collision never
discloses that a foreign Pool exists.
Pool names need not be unique. Empty, offline-only, and all-disabled Pools remain
valid saved configurations.

Members carry a Machine ID, nonnegative priority tier, and enabled bit. Membership
does not grant Machine, Session, credential, or cross-Account authority. Foreign,
temporary, revoked, and replaced Machines cannot become newly eligible members;
get and not-found responses do not disclose another Account's Pool.
An existing unavailable member can be reordered, disabled, or removed while the
Pool is edited. Adding or re-enabling a member requires current eligibility;
changing its priority never makes an unavailable Machine selectable.

Resolve accepts `{ poolId, requestKey }`. It selects from enabled, current,
generically available members in the lowest numeric tier, then uses a deterministic
hash of `[requestKey, machineId]` within that tier. Success returns the exact
`machineId` and selected tier. The caller binds the captured Home `serverId` to
form the existing `SessionExecutionTargetV1`; the server does not invent that
client-side Home identity. An unavailable result distinguishes no enabled members
(including an empty or all-disabled Pool), no available Machine, and unavailable
presence observation.

A successfully observed unavailable resolution is still HTTP 200 carrying the
discriminated result, not a transport failure. Failures use four stable domain
codes with a fixed status mapping:

| Code | Status | Meaning |
| --- | --- | --- |
| `invalid_request` | 400 | The body failed the strict schema for that endpoint |
| `member_machine_not_eligible` | 400 | Named Machine IDs cannot be added or re-enabled; only IDs the caller already supplied are echoed |
| `pool_not_found` | 404 | Non-disclosing: a nonexistent Pool and another Account's Pool are indistinguishable |
| `pool_changed` | 409 | Optimistic-concurrency conflict, with the caller's own current view when ownership is established |

The feature gate refuses before any of that: when `machines.pools` is off the six
routes answer `404 { "error": "not_found" }`, which is deliberately
indistinguishable from an unknown route.

This is deterministic spread, not a capacity, fairness, least-load, retry, or
failover promise. There is no pool-shaped daemon target: after resolution, session
creation uses the ordinary exact Machine path. These endpoints are guarded by the
`machines.pools` server feature and are current 0.3 development source rather than
a released API contract.

The six endpoints are also the six public Action intents; they share the existing
Account Action executor and authenticated Home transport rather than defining a
second Pool API. A successful create, update, or delete emits one `machinePool`
`AccountChange` invalidation after commit. Clients refresh the aggregate from that
exact Home; the change event carries no Pool name, description, roster, or
availability snapshot. Homes that do not positively advertise `machines.pools`
must not receive these calls, and ordinary exact-Machine session creation remains
available when Pool support is absent.

This API's Machine Pool is an execution-location preference. It is unrelated to a
Connected Service Pool, which is a credential-source binding in the Connected
Services domain. Current 0.3 source accepts either an exact Machine or a personal
Machine Pool as a credential-broker location. A new Pool-backed open intersects
current generic Pool availability with the source-owning daemons' content-free
eligibility result, applies the canonical Pool selector once, and then continues
through the existing exact-Machine broker admission and usage path. Resource
administration, ordinary Sessions, Resource Test/catalog, and restricted Runner
activation consume this placement. The feature remains development-only, and its
integrated package and loaded-Provider validation is still open.

### Artifacts
- `GET /v1/artifacts?limit=...&cursor=...` lists Artifact headers in
  stable `updatedAt`, `id` order. The optional opaque cursor resumes after the
  last observed row, allowing typed clients to continue through sparse pages
  without loading Artifact bodies or assuming the first page is complete.
  In 0.3 development source, `includeBody=true` adds each row's `body` and
  `bodyVersion` to that same authorized batch. The Artifact access and Account-mode
  owner applies the same content checks as an exact read; E2EE bodies remain
  opaque until the client opens them. Workflow library counts use these opened
  bodies, not persisted count metadata or per-row requests. Omitting the option
  retains the header-only response. This is not a released availability claim.
- `GET /v1/artifacts/:id`
- `POST /v1/artifacts`
- `POST /v1/artifacts/:id` (versioned update)
- `DELETE /v1/artifacts/:id`

The in-progress 0.3 ordinary binary extension uses a strict body reference
`{blobId,mime,sizeBytes,sha256}` within the normal plain/E2EE body envelope.
Private bytes are not public uploaded-file URLs. Its transport contract is
`POST /v1/artifacts/content/binary` for creation and
`POST /v1/artifacts/:id/content/binary` for versioned updates, using the same
Artifact write owner with `blob:{blobId,content}`. Uploaded content is explicitly
`{t:'plain',v:<base64>}` or `{t:'encrypted',c:<base64>}`; same-document retained
bytes may be reused with `blob:{blobId}`. Binary updates accept
`blob:null` with a body and expected body version for intentional file-to-text
replacement, paired with refusal of legacy text body writes to a binary head.
An unaware body write to a binary head returns HTTP 409
`artifact_binary_content_requires_explicit_update` before mutation; the writer
must explicitly retain a blob or send `blob:null` on the binary update route.
Header-only edits remain compatible. A distinct mutation path prevents a
text-only server from ignoring the upload field and accepting a dangling
reference. The authenticated read is
`GET /v1/artifacts/:id/blobs/:blobId`, returning `{blobId,content}` only for
current/retained bytes admitted by the Artifact access and Account-mode owner.
Finite uploads use one `POST /v1/artifacts/content/upload` request with
`Content-Type: application/vnd.happier.artifact-upload-v1`: a strict JSON
metadata line followed by a newline and raw binary bytes. The shared transfer
framing codec validates `ArtifactBlobUploadInitV1` metadata; no inline base64
or cross-request upload-session affinity is required. Cancellation of a
finalized conversion stage uses `DELETE /v1/artifacts/content/uploads/:uploadId`.
The existing request-bound transfer lifecycle
owns chunk order, declared length, integrity and temporary-file cleanup; normal
uploads finalize through the same Artifact mutation owner, not another writer.
An `encryption-conversion` destination instead finalizes to private staging
custody `{t,uploadId,contentSha256}`. The existing signed Account conversion
directive includes that stage with `blobId` and `expectedContentSha256` for each
distinct head/history blob. Only its atomic Account transaction activates the
staged bytes and replaces keys, document/history envelopes and private locators;
the upload alone never changes Account mode or read authority. The signed
request keeps its 8 MiB budget because binary bytes travel separately.
This transport is not yet a deployed or fully validated availability claim;
implementation and lifecycle validation are tracked in ART-B1-BINARY and ART-B2-FINISH.

### Stored-content public links (0.3 development)

Session and ordinary Artifact publications share one owner and the existing
`sharing.public` feature decision. Plugin-owned storage is not public content.

- `POST /v1/public-shares` takes `{subject:{kind:'session'|'artifact',id},lookupId,keyDerivation:'fragment_v1',encryptedDataKey?,expiresAt?,maxUses?,isConsentRequired?}`.
- `GET /v1/public-shares?subjectKind=...&subjectId=...` lists the authorized subject's safe publication settings.
- `DELETE /v1/public-shares/:shareId` revokes the publication.
- `GET /v1/public-shares/:shareId/access-log` returns owner-authorized visit records.
- `GET /v1/public-shares/:lookupId/content` reads admitted stored content without Account credentials on the publication's isolated origin. Consent and Session pagination use the existing publication-use/access-grant policy.
- `GET /s/:lookupId` serves the isolated text viewer; its wrapping secret is carried in `#k=...`, not in an HTTP field.
- `GET /v2/sessions/metadata-upgrades` returns authenticated owner-only Session ids needing the existing privacy-layout upgrade, including archived shared Sessions; it returns no metadata or key material.

The lookup and wrapping secret are independent. E2EE content and its wrapped DEK
remain opaque to the server; plaintext Accounts send no wrapped key. Publication
responses and later get/list Action results cannot recover a link's secret.
An approved create Action returns the complete URL assembled by the trusted UI
or CLI host, including its fragment, without a mounted share sheet or callback.
Diagnostic observations redact that capability URL. The released
`/v1/sessions/:sessionId/public-share` and `/v1/public-share/:token` Session paths
remain compatibility adapters for legacy links, not a second publication owner.
An unupgraded layout-0 legacy Session returns typed
`metadata_privacy_upgrade_required`; the viewer asks its owner to open Happier.
The owner's initial 0.3 sync performs the privacy upgrade through the existing
metadata tuple owner, after which the same retained token can be read safely.
See the [encryption custody contract](encryption.md#session-storage-modes).
These routes describe current development source, not released availability or
completed composed live validation.

### Access keys
- `GET /v1/access-keys/:sessionId/:machineId`
- `POST /v1/access-keys/:sessionId/:machineId`
- `PUT /v1/access-keys/:sessionId/:machineId`

### Key-value store
- `GET /v1/kv/:key`
- `GET /v1/kv?prefix=...&limit=...&afterKey=...`
- `POST /v1/kv/bulk`
- `POST /v1/kv` (batch mutate)

The development `afterKey` query continues the ascending key list after the exact
last key from the previous page. It preserves the prefix, excludes versioned
tombstones, and retains the existing list page-size boundary. Account encryption
migration drains the Todo and Workspace namespaces through this same read owner;
its [encryption contract](encryption.md#key-value-store) requires complete active
inventories before any mode change.

### Account and usage
- `GET /v1/account/profile`
- `GET /v1/account/settings`
- `POST /v1/account/settings`
- `POST /v1/usage/query`

### Authoring memory (0.3 development)

Remembered session-authoring state uses reserved Account KV rows, rather than
replacing the Account Settings document. The schema and response contracts live in
`packages/protocol/src/account/authoringMemory.ts`:

- `GET /v1/account/authoring-memory` returns `{rows:[{key,revision,content}]}`,
  including versioned tombstones with `content:null`.
- `GET /v1/account/authoring-memory/:key` returns `present` with its revision and
  content, `deleted` with its revision, or `absent` for a never-created row.
- `POST /v1/account/authoring-memory/:key` accepts
  `{expectedRevision:number|'absent',content:envelope|null}` and returns `updated`
  with its revision and durable change cursor, or `conflict` with the current
  revision (`-1` when the row has never existed).

Keys are `recentMachinePaths`, `lastUsedProfile`, and
`engineSelection:<canonicalScope>`. The authoring selection owner normalizes scope
identity before transport. Each mutation publishes a content-free AccountChange
hint `{authoringMemory:true,key,revision}` for exactly that row. Account identity
comes from authentication; `/v1/kv` cannot enumerate, read, or mutate the physical
`@happier/account/authoring-memory/v1/` namespace. Unreadable, inconsistent, or
mode-mismatched content returns `503 authoring_memory_storage_unavailable` before
disclosure or mutation. See [Account-mode encryption](encryption.md#account-mode-invariant).

The app reads the inventory once on Account/Home activation. Existing socket
wakes and the durable changes cursor refresh only hinted rows; successful
materialization is required before the cursor advances. Remembered-selection
rows contain `{v:1,selectionsByScope}` so legacy aliases and opaque future
carriers survive while sharing one row per canonical scope. The preference
`rememberLastEngineSelectionsV1` remains in Account Settings.

The materialized values retain the previous device-local read continuity: a
validated projection is persisted through the existing local adapter under the
canonical Account/Home scope and hydrated before transport. This projection is
not a sync writer, pending-write queue, or Account-mode authority.

The one-way 0.2 import reads the authoritative settings envelope under the
persisted Account mode, creates each destination only if absent, then removes
that source key by exact Settings CAS without normalizing or changing unrelated
raw Settings siblings. Its baseline read performs no writeback. Conflicts re-read the winner; interruption
leaves a recoverable source and repeat import cannot replace an existing row or
tombstone. Current consumers never dual-write the old settings keys.
The CLI uses that same destination-first policy for the remembered profile before
reading it, including when the app has not initialized that Account yet.

### Push tokens
- `POST /v1/push-tokens`
- `DELETE /v1/push-tokens/:token`
- `GET /v1/push-tokens`

Remote session alerts (development) negotiate through these existing routes rather than new ones:
`GET /v1/push-tokens?projectionVersion=2` returns `{ v: 2, accountRemoteAlerts: { settingsVersion,
status }, tokens }` with each row's nullable `remoteAlerts` device policy; a Home without that support
answers the released shape and the client then registers no policy. `POST /v1/push-tokens` accepts an
optional `remoteAlerts: { registrationId, policy }`, which updates only that exact existing row
(`404 push_token_not_found` otherwise) and never creates or enrolls a registration.

In v0.3 development, `attentionDeliveryPolicyV1.mutePhoneWhenComputerFocused` is
opt-in and defaults off. Each authenticated Home sync socket publishes `ui-focus`
with `{ computer, focused }`; focused means `document.hasFocus()` **and** visible.
The shared notification-policy decision fails open when focus is unavailable.
CLI/daemon senders request `GET /v1/push-tokens?suppressIfComputerFocused=1` only
for opted-in mobile alert delivery; a focused computer of that Account yields no
tokens. Home delivery reads the same preference from the existing version-bound
Account policy projection, even when Home OS alerts are disabled.

Muted Home tokens still receive the content-free `SessionChangedWakeV1` data wake
with optional `alert: 'muted'`. The device reconciles that wake silently through
`ActivityLocalNotificationRuntime`; ordinary wakes retain existing behavior.
Only reconciliation-produced notifications are muted; independent live socket
alerts are not discarded while that reconciliation is pending.
This qualifier is undeployed v0.3 wire behavior, not a released compatibility shim.

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

In 0.3 development source, external identity persistence is owned by
`apps/server/sources/app/auth/providers/accountIdentityLifecycle.ts`. GitHub,
OIDC, mTLS, visibility changes, eligibility refresh, and provider-reset transfer
call this transaction-aware owner. Provider leaves validate upstream evidence;
the lifecycle checks subject collisions and writes the `AccountIdentity` row.
It records the Account change in the transaction and publishes the linked-identity
update after commit. Whole-Account erasure remains with the Account deletion
owner and its cascades.

In 0.3 development source, `GET /v1/account/profile` keeps each released strict
`LinkedProvider` object unchanged and adds the optional sibling
`linkedIdentityManagementV1`. Each sibling row carries the current non-secret
provider display and source, a viewer-authorized Home or Team management owner,
the active Teams that require the exact identity connection, and independent
`canDisconnect` and `canPublishProfile` decisions with closed reason codes. Team
names appear only for the authenticated Account's active memberships; an
unrelated Team that uses the same provider instance is not projected.

The disconnect and profile-visibility routes recompute those decisions from
current rows in their mutation transaction. A restricted Team policy blocks
disconnect only when its exact `team_connection` reference resolves to this
provider. Disconnect also preserves the Account's last effective Home login
method. Profile publication is evaluated separately, so a required identity can
remain publishable. Unreadable management facts fail the affected action closed
with `409 identity-management-denied`; hiding a client control is never the
enforcement boundary. Disabled or removed deployment runtimes can still remove
an existing linked row when current lifecycle policy permits it. Persisted
identity namespaces declared by native AuthMethods remain owned by their native
routes and are rejected by the external-provider disconnect fallback.

Live authentication-provider resolution is owned by
`apps/server/sources/app/auth/providers/identityProviderCatalog.ts`. Built-in and
deployment-configured modules are composed by the current deployment snapshot in
`providerModules.ts`; there is no parallel runtime registry or provider-instance
cache. The synchronous feature projection reads that same snapshot through
`deploymentProviderFeatures.ts`, while executable OAuth, identity, eligibility,
linked-provider, and presentation paths resolve through the catalog.

Catalog lookups return an opaque provider reference containing the normalized ID,
source, runtime fingerprint, and current Home context. OAuth attempts bind this
reference and re-resolve it before callback or finalization. A removed provider
returns `auth_provider_unavailable`; a different runtime returns
`auth_provider_configuration_changed`, and neither path executes against the newly
resolved provider. The development catalog includes built-in, deployment and
database-managed provider sources. Non-secret descriptor and linked-identity
reads do not enter runtime resolution or decrypt provider credentials; only
execution resolves the selected runtime material.

The provider ID and external subject remain the identity key; email and display
names do not link Accounts. Relinking to a different subject creates a new
identity row, so a refresh that names the old row cannot overwrite the new link.
Restricted Team authentication remains fail-closed until its separate consumed
credential-evidence path is available. The linked-identity management projection
does not activate that unfinished admission path.

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
