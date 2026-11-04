# API

This document covers the HTTP API surface and authentication flows. For WebSocket updates and event payloads, see `protocol.md`. For encryption boundaries and encoding details, see `encryption.md`.

## Method conventions
- **GET** is used for reads.
- **POST** is used for mutations or actions, even when the operation doesn't map cleanly to a single entity.
- **DELETE** is used when intent is unambiguous (e.g., removing a token or deleting a session/artifact).

We intentionally avoid the full REST verb palette because many operations span multiple entities or have non-CRUD semantics.

## Account usernames (0.3 development source)

An Account has one service-scoped username, also used by Friends. Authenticated
username operations use the request-effective Home policy. Friends must be
enabled, and either username-based identity must be allowed or the Account must
have the required identity-provider connection. These identity operations do not
publish an anonymous profile or enable Friends.

`POST /v1/account/username` retains the strict `{ username: string }` request and
`{ username: string }` success response. The server trims and lowercases input.
The legacy errors remain HTTP 400 `invalid-username`, `username-disabled` or
`friends-disabled`, and HTTP 409 `username-taken`. New reserved spellings use
`invalid-username`; an active released-name hold uses `username-taken`. An
existing holder may retain the same name even when current new-claim policy
would refuse it.

`POST /v1/account/username/check` accepts the same strict request and returns
`{ username, availability, suggestions }`. Availability is `available`,
`unavailable`, `invalid` or `reserved`. The normalized username and any
suggestions come from the same policy and admission owner used by mutations.
Suggestions are advisory: the two candidate spellings may produce fewer than
two results when policy or existing claims exclude them. No result identifies
another holder or reserves a name; the final set can still conflict.

`POST /v1/account/username/release` accepts the strict empty object `{}` and
returns `{ username: null, released: boolean, reservedUntilMs: number | null }`.
A successful release atomically clears the current name and holds it for
30 days against every claimant, including its former holder and provider
auto-fill. Repeating release after the name is cleared returns
`{ username: null, released: false, reservedUntilMs: null }`, keeps auto-fill
disabled and does not extend the hold. Renaming is distinct from release and
creates no hold.

The corresponding Actions are `account.username.set`, `account.username.check`
and `account.username.release`. Mutation approval follows the existing Action
policy and per-surface Settings overrides; approval does not bypass server
eligibility or admission. Provider fill/unlink, provisioning and provider-reset
transfer delegate to `app/social/usernameUpdate.ts`, rather than writing another
username namespace. See the [username compatibility contract](compatibility.md#account-username-intent-and-release-03-development).
These additions describe development source, not released availability.

## Public-profile integration status (0.3 development)

Public-profile publication is a development-only 0.3 capability. The source
contains the closed `PublicProfileV1` disclosure contracts, a single policy
projector and an Account-associated publication lifecycle. The canonical
`account.publicProfiles` server producer defaults on, independently of Friends;
`HAPPIER_FEATURE_ACCOUNT_PUBLIC_PROFILES__ENABLED=0` is its live Home-configurable
opt-out. Missing or malformed enabled bits still fail closed on clients. The
eligible-fact builder is bound at authenticated UI/CLI Action hosts. Editor,
visual and loaded-runtime acceptance remain tracked separately; this is not a
released endpoint guarantee.

`account/publicProfile.ts` owns field consent, snapshot facts and tolerant stored
readers; writes reject unknown fields recursively. `projectPublicProfile` masks
facts and identity before compiling symbolic widget bindings into inert data.
Tokens-hidden mixes retain shares while losing absolute token amounts in every
lens. Weekly mixes accept shares only; weekly peaks also require peak-parallel
consent. Stored unknown field ids grant no consent, and malformed known consent
or facts fail closed. Private widget Artifacts remain drafts; the public layout
is an explicitly applied inline copy. Copied built-in Usage presentations consume
the closed declarations at `widgets/builtinWidgetDescriptorV1.ts`, not private
Usage query inputs. Reviewed block titles use the existing widget display-name
contract. External templates remain symbolic inert declarative documents; the
same projector removes hidden columns and dependent labels inside source lenses.
The safe view carries the current indexability bit so output adapters do not
become independent consent readers.

The key-holding preview uses the same projection core and a derived local view
whose appearance contains the retained prepared pixels. Its service and URLs may
be absent before public ingress or Report contact is configured; the local page
omits Report in that case. Publish still requires both prerequisites. Anonymous
views require canonical service/URLs and accept only applied publication
references, never prepared pixels. Preview inputs/results
and prepared publication effects use existing live-only Action custody;
approval Artifacts and observations omit computed snapshots, image content and
the original metadata selection. Resolved consented metadata can still describe
the reviewed effect. Approval dispatches that retained effect rather than
recomputing it from a changed query or draft.

`account/publicProfilePublication.ts` separates reviewed prepared request bodies
from author Action intents. The server lifecycle serializes consent and snapshot
writes in one `AccountPublicProfile` row. A policy hide prunes stored facts even
when Usage is offline; layout-only updates preserve current consent. Refresh
replaces permitted facts only for an already published record and cannot publish,
resume, change policy, apply a draft layout or remove an operator restriction.
Pause retains the owner's edition; unpublish removes it and preserves only an
independent restriction when present. These disclosures do not change Account
encryption mode or keys.

In 0.3 development, Publish's host-private review callback receives the canonical
prepared effect and its captured publication context before approval. The editor
shows that effect in F2, and the existing live approval continuation retains it
through Ask and dispatch without another Usage read. Ask's durable preview omits
the facts and is not a replacement for F2. Cancellation or Account retirement
cannot approve or dispatch the effect. The callback is neither Action input nor
execution authority. An unchanged private-layout reread preserves its reviewed
copy; changed layout, source context or referenced definitions require re-review.

Whole-Account erasure withdraws the edition in its terminal retirement
transaction, before retryable physical object deletion. Failed object cleanup
therefore cannot retain public disclosure. An erasure refused before retirement,
including pending Account-mode transition cleanup, leaves the edition unchanged.

Publication also requires configured public ingress and
`HAPPIER_PUBLIC_PROFILE_REPORT_URL`. The latter is a live, Home-editable optional
string admitting HTTPS or mailto destinations; there is no Cloud default.
Current Account identity and the effective service configuration supply URLs,
including any public path prefix. Request Host and private Artifact/KV references
are not publication authority. Anonymous representation admission must precede
ETag comparison. See
[Actions](actions.md) and the published
[development guide](../apps/docs/content/docs/accounts/public-profiles.mdx).

The development anonymous route owner is independent of an optional UI mount.
Its HTML adapter cold-renders the portable `HappierPublicProfile` with RNW CSS;
badge/card SVG, card PNG and fixed-dark OG PNG use the current projected visitor result,
Brand geometry and in-process Sharp. The SVG glyph layer embeds locally shaped
PNG pixels from packaged Inter/Noto faces, with explicit font selection rather
than system fallback. The runtime build copies those faces and their OFL
licenses. Card PNG rasterizes the same 495×195 scene as card SVG: explicit light
or dark selects that edition, and automatic/default rasterization uses light.
OG remains 1200×630 and dark regardless of query theme. Every representation
reads current admission before comparing its ETag; an unavailable edition has
no reusable validator. An older OG cache-buster never selects historical data.
Asynchronous glyph, image and cold-page painting rechecks the same Account and
complete safe result after materialization. A changed edition discards the
painted bytes (or rendering failure) and returns the generic unavailable edition
without a validator. Cold HTML consumes the shared responsive hero band at its
wide/phone geometry, with 1×/2× Brand or admitted A1 picture pixels and frozen
credit. The HTML references `GET /@:handle/background` with the complete
`theme=light|dark`, `viewport=wide|phone`, `density=1|2` selector rather than
inlining those PNGs. The route paints the selected edition through the same
hero adapter and rechecks current admission before ETag/304. Without selectors,
the route continues to serve only the current admitted raw picture copy.

Reviewed picture Apply uses the existing Account private-file custody owner:
normalize/write before the winning publication transaction, then settle and bind
the new copy while retiring the displaced reference in that transaction. A
rejected candidate is discarded; failed deletion retains its cleanup locator and
cannot resurrect an old public binding. The deliberately public normalized copy
does not acquire client E2EE semantics from its physical private-file backend.

The development Home reclaim transport is
`POST /v1/home/public-profiles/:accountId/handle-reclaim` with strict
`{username,reason,notice}`. It rechecks the actual principal's Home capability
and exact reviewed username, and answers `{username:null,reclaimed}`. A changed
username returns HTTP 409 `username-changed`; an already-cleared Account is an
acknowledged no-op. Reclaim uses the canonical username/withdrawal owners and
retains restriction. Audit and the existing owner text-feed notice commit with
the identity change; `/v1/feed` remains authenticated independently of Friends.

## Workspace execution config (0.3 development source)

Authenticated Account transport exposes the private checkout config at
`/v1/projects/execution/config`. `POST /read` accepts
`{address:{serverId,refId}}` and returns `present` with `revision` and `content`,
`absent`, or `deleted` with the tombstone revision. `POST /mutate` accepts that
address, `expectedRevision` (a nonnegative safe integer or `"absent"`), and
`content` (the explicit plain/encrypted envelope, or `null` for a tombstone).
It returns `updated` with `revision` and Account change `cursor`, or `conflict`
with the current revision. `GET` at the base route returns the complete
`{rows:[{rowId,revision,content}]}` inventory, including tombstones.

Inputs reject unknown fields. An inconsistent Account, invalid stored content
or mode mismatch returns HTTP 503
`{error:"workspace_execution_config_storage_unavailable"}` without exposing the
row. Generic KV cannot address this reserved namespace. The
[encryption contract](encryption.md#workspace-execution-config-03-development-source)
owns envelope admission and conversion behavior. These endpoints describe current
development source, not released availability.

## Private Profile catalog (0.3 development source)

Authenticated Account routes expose private Profile rows at
`/v1/account/entity-rows/profiles`. `GET` accepts optional `cursor` and `limit`
and returns rows (including tombstones), `nextCursor`, `complete`, diagnostics,
the Profile reference-guard revision and transfer-control state. Consumers must
finish paging and recheck the guard/control before treating the inventory as a
complete reference census; a partial or unreadable response is not an empty catalog.

`POST /records/read` accepts the strict `{ id }` body and returns `present`,
`absent` or `deleted`, retaining a deleted row's revision. `POST /records` uses
the strict Profile mutation DTO with the exact body ID and expected revision.
Identity travels in JSON so retained Profile IDs do not depend on URL parameter
length or normalization. Ordinary writes cannot use
the predecessor-transfer `import` operation. `GET /reference-guard` reads the
content-free guard. The separate `/transfer` read/mutation routes own genuine
predecessor preparation and activation; neither control path is a Profile ID.
Provider conversion uses `POST /provider-conversion` under the same base route,
with its captured Settings/control and row/reference census admission.

MySQL preserves the encoded KV key with `utf8mb4_bin` collation. The complete
Account/key unique index admits 577 characters under InnoDB DYNAMIC format with
the default 16-KiB pages: `(191 + 577) × 4 = 3072` indexed bytes. Retained Profile
IDs are unbounded; the physical key is a 29-character namespace followed by
`encodeURIComponent(id)`, so 577 is an encoded-key limit, not a raw-ID limit.
Longer keys raise typed `kv-key-too-long` at the KV owner before any batch write;
they are never truncated or hashed. SQLite/PostgreSQL key storage is unchanged.
The physical index basis is documented in the
[MySQL InnoDB limits](https://dev.mysql.com/doc/refman/8.0/en/innodb-limits.html).

These rows use explicit Account-mode envelopes, not Artifact resource keys or
sharing grants. Published/shared Profile definitions remain Artifacts, while
private bindings and prompt stacks remain Account data. See the
[Profile encryption contract](encryption.md#private-profile-rows-03-development).

Enablement belongs to the private row once a Profile has membership, including
a builtin definition. Only a builtin with no entity keeps enablement in Settings.
The first builtin attachment captures that preference and retires its addressed
key in the same Settings CAS; deleting or transferring an entity does not retain
an old builtin enablement key.

A retained readonly blueprint allows private attachment changes, not logical
definition edits. Moving that same admitted body and identity into an addressed
Artifact is publication, not a new definition; it requires the actual opened body
to match and introduces no Artifact binding defaults. Duplicate and builtin Save As
reuse the existing guided Provider migration for legacy routing, including Azure
and Gemini, then copy the acknowledged current definition and Provider selection.
An unrepresentable MachineLogin definition alone may use `clone-legacy`: its
captured private source revision and any source Artifact grant/revision are admitted
before copying the exact body, enablement, prompt stack and effective bindings with
private null masks. The copy receives a fresh identity, name and timestamps, loses
its builtin marker and is detached from the source Artifact. Arbitrary new legacy definitions and edited
clone bodies remain refused, and a failed save retains the editor draft.

This describes current development source, not released availability or a
completed loaded-runtime validation.

## Connected Account OAuth completion (0.3 development source)

`connectedServices.authentication.completeOAuth` uses the existing admitted
Connected Account Action and daemon attempt owner. Its completion contains
`code`, the descriptor-owned `callbackUrl`, the complete `state`, and optional
`iss`. A callback issuer must equal the issuer sealed at begin exactly; it is
required when the authorization server advertises issuer-response support.
The daemon rejects a missing required or mismatched issuer before token
exchange, without displaying untrusted provider error text.

State has the shape `<attemptId>.<random nonce>`. Clients may use the prefix
to find the owning attempt, but prefix equality does not authorize completion:
the owner compares the complete state with its sealed transaction. The PKCE
verifier never enters the completion request. These are development-source
contracts, not released or loaded-runtime certification.

MCP sign-in uses the host service `happier/mcp-sign-in` and the same attempt
owner. Its stable client metadata URL is
`https://app.happier.dev/oauth/mcp/client-metadata.json`, with callback
`https://app.happier.dev/oauth/mcp/callback`. The app callback controller removes
code/state from the browser URL before handoff, forwards only to its pinned
origin, or completes through an admitted same-Account Machine. The full callback
URL is retained for the paste fallback when no answering app/attempt owner is
available. Registration attempts client metadata first and dynamic registration
second; paste is completion of an existing attempt, not a registration bypass.
Production publication and installed-app return remain release checks. See
[plugin authentication ownership](plugin-platform.md#public-seam-and-authority).

An authentication `read` may request `waitForProviderStart: true` to await the
existing background begin operation; ordinary reads remain nonblocking. This
does not poll or create another deadline. Cancellation and owner disposal
release waiting callers through the incumbent attempt lifecycle. OAuth replies
use the transaction's existing expiry when the authorization server supplies
none, or the earlier transaction/provider expiry when both are present.

## Connected personal metadata (0.3 development source)

Authenticated Account transport exposes two singleton rows at
`/v1/account/entity-rows/connected-metadata/presentation` and
`/v1/account/entity-rows/connected-metadata/acknowledgements`. Each supports `GET`
for `present`, `absent` or revision-retaining `deleted` authority, and strict
`POST` with `expectedRevision` and an explicit Account-mode `content` envelope
(or `null` for deletion). First initialization also requires the captured
`sourceSettingsVersion`, compared under the existing Account transition fence.
Generic user KV cannot address these reserved keys.

Presentation contains personal labels for qualified accounts and groups.
Acknowledgements contain exact qualified adoption subjects and Account- or
Machine-scoped warning identifiers; false remains a saved value. Plain writes
admit newly changed owned subjects, while unchanged orphan entries and exact
removals remain usable for cleanup. E2EE content remains opaque to the server;
the key-holding client admits subjects before writing.

Malformed known entries remain diagnosable without hiding valid neighbors.
Only a complete readable catalog or its retained tombstone can authorize source
and history cleanup or Account-mode conversion. Device-local row disclosure is
not a third Account row. See the [private catalog encryption contract](encryption.md#private-agent-provider-and-connected-account-catalogs-03-development).
These routes describe development source, not released availability or completed
loaded-runtime validation.

## SavedSecret import and retained Settings history (0.3 development source)

`POST /v1/account/saved-secrets/resources/promote` commits an owned credential
resource with its captured Settings CAS and any private Profile rebindings.
The strict input includes the complete Profile/reference-guard census and
captured transfer-control revision; selected Artifacts carry current addressed
header/body proofs. Access, effective bindings and resource revisions are checked
at the same transaction owner. A refusal does not commit partial source cleanup.
`GET /v1/account/saved-secrets/resources/materials` supplies the admitted catalog
and mode-specific resource material through the existing resource access owner.

The legacy importer also recognizes the predecessor's bare `inferenceOpenAIKey`
string. It preserves the exact opened key in an `apiKey` resource under the
canonical `legacy-inference-openai-key` source identity and removes only that raw
Settings root. It does not create a personal SavedSecret wrapper or a replacement
inference consumer.

`POST /v2/account/settings/history/:version/mutate` normalizes one retained
version under exact recorded content, current Settings version, Account encryption
currentness and transfer-control CAS. Its strict `savedSecretTransfers` entries
retain the personal shape `{savedSecretId,resourceId,expectedRevision}` and also
admit `{source:{kind:'legacy-inference-openai-key'},resourceId,expectedRevision}`.
Both require the source's deterministic owned, usable destination at the captured
resource revision. A whole-root removal claim does not authorize credential loss.
Plain normalization checks the actual recorded document; an authorized client
opens and reseals E2EE history without server decryption. Unknown credential shapes
remain cleanup-pending. Fresh invocations can resume cleanup after source removal
through the same admitted-resource proof, without replaying promotion or retaining
an import ledger. Explicit purge addresses only the requested retained version.

Restoring a snapshot uses the ordinary current Settings CAS writer after the
classification-aware merge. Historical preferences first pass through their
canonical stored-read projection, then current strict mutation validation; this
normalizes retained Replay budgets and drops retired Machine target memory while
preserving valid plugin execution origins. Authority-bearing policy roots retain
strict input admission. A malformed policy or a preference that cannot produce a
canonical write fails before mutation; restore does not turn it into defaults.

See the [Account encryption contract](encryption.md#private-profile-rows-03-development)
for source/history authority and cancellation. This describes development source,
not released availability or completed loaded-runtime validation.

## Authentication
Most endpoints require `Authorization: Bearer <token>`.

### UI HTTP request ownership (0.3 development source)

`apps/ui/sources/sync/http/client.ts` owns HTTP admission, authentication,
reachability and cancellation through `requestAtEndpoint`. Account, Artifact,
social and focused-Home push operations capture their focused Home once through
`createServerFetchForActiveServer`, before starting their containing retry or
compatibility-fallback operation. Explicit endpoint transports remain captured
through `createServerFetchAtEndpoint`; supplied scoped requests retain their own
authority. Neither wrapper is another retry or credential owner.

An obsolete focused-Home basis raises `StaleServerGenerationError` with
`retryable: false`; a containing retry must not send its captured bearer to the
newly focused Home. A prepared Account socket write may preserve an empty HTTP
401 after its own conditional removal of the rejected stored token retires the
request configuration. This exception discards the response body and never
retries the mutation. Credential replacement or target replacement still takes
the stale-response path. Session-viewer socket reconnects retain their Session
role and do not register Account presence or Machine RPC handlers.

In 0.3 development, ApiSocket disconnects the focused socket while the canonical
Home supervisor is not online and reconnects it on a fresh online observation.
A refused recovery dial re-enters the existing Home revalidation path; its
fresh online observation can dial the socket again. Retired configuration or
transport callbacks cannot revalidate a replacement connection.

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
  - Response: `{ state: "requested", expiresAt }` or `{ state: "authorized", token, response }`.
  - Development correction for #403: `expiresAt` is Unix time in milliseconds, computed from the persisted request creation time and effective server TTL. Repeating a pending request does not renew it. Older clients ignore this additive field; older servers omit it.
  - Current development CLIs cap pairing crypto validity by this deadline. `auth request --json` reports the effective `expiresAtMs` and `expiryNotice`; if the server omits expiry, `expiresAtMs` is `null` and the notice advises prompt approval and rerunning after failure. The nested `pairing.expiresAtMs` remains the crypto binding deadline, not a promise of server acceptance.

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
bound creation placement. Root creation defaults an omitted grant to an explicit
stored full grant, whose `approve` is false. Missing or malformed persisted grants
refuse authentication as `invalid_token`; they never imply full access.
`evaluateApiTokenGrantV1` applies at HTTP, socket-event
and declared RPC admission, and again in the daemon executor. Approval and
permission decisions use `approve` plus target membership, without requiring
the approved Action itself. Tokens may decide their own requests. Conversational
`session.user_action.answer` instead uses the Action allowlist.

Persisted grants, embed configuration and authentication-evidence snapshots read
known fields recursively and discard unknown fields through the shared stored-read
schema projection. Invalid known fields still fail closed; request admission and
new writes retain their canonical strict schemas. Grant attenuation uses the same
conversational Action admission as execution, including Send's question-answer alias.

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

Mounted Plugin UI calls use the separate Account admission of this same path,
not an API token. The narrowing `pluginInvocation` claim does not make
provenance-only Actions PAT-invocable; see the [plugin carrier
contract](plugin-platform.md#mounted-plugin-account-root-carrier).

Request:

```json
{
  "v": 1,
  "requestId": "optional-correlation-id",
  "target": { "kind": "machine", "machineId": "machine-id" },
  "input": {}
}
```

For a Session, use `"target": { "kind": "session", "sessionId": "session-id" }`.
An Action that takes `sessionId` still receives that field inside `input`; the
envelope target does not replace or widen the Action's operand grant.

`target` may be omitted or use the machine or session form. It is
transport routing metadata, never Action input, caller provenance, approval
state, or host execution context. Daemon-local omission selects that daemon's
current machine. The server origin has no default target: provide an exact
Session target, or use the PAT-enabled `GET /v1/machines` discovery route to
choose an exact Machine target. Omitted targets return `target_required`. A session
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

General public Action origination uses PAT bearer authentication. Development
source also supports narrow signed-credential roots, including the terminal
and managed-machine flows described here.

In 0.3 development source, a current paired terminal bearer can originate
`session.spawn_new` through the execution-authorization and public relay endpoints
for an admitted requester-owned Machine. The exact root binds the terminal
credential epoch, Account encryption mode and request envelope, and retains
`account_automation` authority. This fresh CLI root has no installed Session or
Workflow origin; it neither grants present-user authority nor permits general
ordinary-Account bearer Session spawning. Plain V1 and protected V2 requests use
the existing relay formats and current-row checks.

Development source also accepts a genuine ordinary Account bearer for the managed-machine
Action family, including `POST /v1/actions/machines.managed.acquire` and
`machines.managed.bootstrap.retry`; this does not authorize arbitrary Actions
with an ordinary bearer. The existing envelope names the exact controller in
`target`. Account credential epoch, authentication evidence, encryption mode and
current Machine authority are verified and bound into the existing signed relay.
The managed acquisition row is admitted before daemon forwarding, even when
that known installed controller is offline. In that case a Plain V1 request
returns `{managedId}` without an invented operation; protected V2 returns the
existing HTTP 409 `target_unavailable` with an id-only
`managedAdmission:{managedId}` receipt. A daemon operation is exposed only when
it actually exists. Protected requests carry a strict compute-only
`managedAdmission` projection, which the receiver compares with the opened
input before effects; Agent continuation text stays sealed.

The acquiring Account's creation preference is checked by the shared Action
origination owner before approval or forwarding. An opened
`managedMachineCreationEnabled:false` returns `creation_disabled` for acquire;
retained reads, cleanup and same-resource bootstrap retry remain available.
This preference is not a security grant or a server-readable E2EE settings
replica. Receiving controllers do not substitute their custodian's preference.

Development source exposes the safe `machines.managed.references.get` Action
through the shared requester Action executor. Its `{homeId, managedId}` input
reads the requesting Account's existing board, profile, Machine Pool and
assignment authorities for the enrolled Machine; it neither asks the native
controller for private Account data nor mutates those references. The result
declares `complete` or `partial` coverage and names unavailable authorities, so
an unavailable read is not represented as an empty complete census. This is
requester-side disclosure before reviewed Delete, not an additional public
server Action transport or a deletion authorization check.

An admitted creation's controller may forward its exact enrolled guest's
continuation through the same `session.spawn_new` dispatcher with the signed
creation proof. Current creation correlation and guest authority are checked
again; this is not general ordinary-bearer session spawning or permission to
reuse that proof on unrelated HTTP routes. These managed paths are source-landed,
not yet a verified composed controller/guest journey.

Signed session bearers and `x-happier-daemon-token` remain distinct credentials
for other surfaces. Bearer ingress authenticates in Fastify `onRequest`, before
the JSON body parser; signed Machine proofs are also checked against the parsed
request at their existing boundary. The API does not use SSE, has a 32 MiB
(33,554,432-byte) request-body ceiling, sends `Cache-Control: no-store`, and
admits Home browser requests under the token origin policy above; daemon-local
delivery does not enable CORS. The server-to-daemon relay accepts a 33 MiB
(34,603,008-byte) request carrier, leaving one MiB of framing headroom above
the public body limit. V1 Action content is plaintext to the configured server;
whole-Action V2 protects content and results without a plaintext fallback.
Ordinary PAT V1 is supported for both Plain and E2EE Accounts; it deliberately
exposes the Action request and response to the configured Home. This does not
grant encryption material or bypass the Account-mode checks at content readers
and writers. Signed Account and terminal private origination on an E2EE Account
uses protected V2. Both
relay forms avoid requiring an inbound public daemon address; use daemon-local
transport for direct local delivery. The transport does not
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

For development `workflow.trigger.run_now`, opaque ingress likewise defers only
the unavailable Automation operand. The daemon checks the decoded operand, and
the native run-now route rechecks it against the current grant under original
requester custody. The public envelope's `idempotencyKey` is covered by the signed
root and must match the input; the installed executor also signs the downstream
`Idempotency-Key` header. Keys are not secret. Same-credential retries with the
same key rejoin the existing manual occurrence; without a key, the signed root
requestId supplies that identity. See [the Action contract](actions.md) for the
ownership and ordinary-caller behavior.

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

In 0.3 development, `POST /v2/sessions/read-batch` accepts
`{sessionIds, accessProjectionVersion?: 1, includeSnapshot?: boolean, includeTurns?: boolean, includeMessages?: boolean, underSessionId?: string}`, defaulting
to snapshots enabled and messages disabled. Snapshot demand returns each detail
using the same optional access-projection selection as the single reader, plus
its turns after successful detail admission. Shell/document readers set
`includeTurns: false` to omit that independent demand. Message demand returns the ordinary first page with
`scope=all&roles=user,agent,event` and the message owner's default page size and
cursors. At least one demand must be enabled; the application HTTP body limit
owns request size. Snapshot and message demands can be sent separately so slow
transcripts do not hold an available snapshot.

The response is `{results:[{sessionId, detail?, turns?, messages?}]}`, where each
component is `{status, body}` with the single-read envelope. Access denial and
missing Sessions retain the same non-disclosing result; component failures do
not discard other admitted components. Plain/encrypted framing, publication,
fresh access admission and client opening stay with the existing Session readers.
Unexpected component failures return `503 session_read_unavailable`; database
admission failures retain the canonical database error code. Ordinary Account
clients retain their existing access checks. Restricted credentials require a
verified existing signed snapshot-preparation purpose and captured grants for
every requested operand; a raw PAT is not sufficient. Those reads explicitly
request snapshots with turns and messages disabled.

Optional `underSessionId` bounds snapshot-only demand to the current readable
managed subtree. Every requested ID must be admitted both at capture and before
publication. A Session-runtime principal must bind that root to its own Session;
its returned snapshots contain the shared View projection, never owner-private
metadata or viewer facts. This does not grant descendant exact-detail access or
transcript access. Existing single readers keep their routes. The one-way 0.3
component upgrade boundary requires no 0.2 batch
fallback or negotiation; 0.2-created retained Session data remains readable.
This batches HTTP transport; storage snapshots and database work remain per
Session, with queuing owned by the existing database pool and snapshot reader.

The 0.3 UI's Machine, Session and Artifact acquisition adapters share the
pending-only batch owner in `scopedResolutionSingleFlight.ts`. A caller with
asynchronous preparation reserves its already-captured authority/projection
partition before awaiting, then settles the reservation with its selected IDs
or releases it on failure/cancellation. Ready work dispatches in a microtask
once that partition has no open preparations; unreserved work has no gathering
delay beyond its dispatch microtask. Invalidation separates successor joins
without cancelling incumbents. Reservations retain neither settled results nor
authorization: each borrower still owns currentness, fresh-witness and opening
checks, and only the final physical-read borrower leaving cancels acquisition.

Current 0.3 Session list routes return the separate compact
`V2SessionListRow` contract. `documents: 'omitted'` means the metadata,
owner-metadata and Agent-state documents are absent; the list query does not
select those large columns. Rows retain the admitted scalar projections,
document revisions, metadata layout, storage mode and viewer key envelope.
`metadataAudience` identifies the admitted owner/shared projection;
`agentStateDocument: 'redacted'` preserves the shared recipient's authoritative
Agent-state tombstone without confusing it with an omitted owner document.
Detail, lookup-by-tag and snapshot-batch reads retain the full record contract.

The 0.3 development cold-display extension adds nullable `displayProjectionV1` on
that same Session row: `{v: 1, sourceMetadataVersion, metadataLayoutVersion: 1,
shared, owner?}`. The shared leaf uses the Session's explicit content mode; the
optional owner leaf independently uses the owner's Account content mode. Only
the existing owner-recipient projection returns the owner leaf. Public links,
collaborators and Session-runtime principals receive shared display only, even
when another part of their existing read authority is broader. A missing,
stale, mode-incompatible or unopenable display requires the existing authorized
full-read fallback, not an empty document. Owner display uses Account purpose
separation without Session-ID binding, matching existing owner metadata; shared
display uses the Session key generated before create. The create interface and
ID allocation are unchanged. Fresh-create adapters use the same semantic
projector as tuple updates. After an authorized owner full read, missing display
is repaired through that tuple writer's `ensureDisplayProjection` intent and
existing CAS; refusal preserves the readable full result. CLI status activates
this only for the existing admitted present-user host invocation with the same
captured read/content token; signed, custom, automation and Session/RPC readers
do not borrow broader Account write authority. Ordinary owner sync
gathers retained upgrade IDs after list readiness, reusing full parts already
fetched by that operation. This is development source, not released availability
or completed live acceptance.

An observed list revision is not proof that a client has opened that document.
Warm reuse also requires the same Home, Account/credential, mode, key and
audience. Readers gather changed or missing demanded snapshots into the existing
read-batch transport with turns and messages disabled. A compact refresh never
replaces a full document with an empty value or advances its stored revision.
This is the canonical all-component 0.3 wire contract; historical layout-0 data
continues through the existing full readers and metadata privacy upgrade.
The full-detail HTTP boundary validates the current Protocol record directly;
it does not normalize older component wire shapes into current authority.
Historical stored metadata and Agent-state strings still use their existing
post-read plain/E2EE codecs.

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
invalidation through the existing Account feed. Optional comma-separated `kinds`
selects change domains at the same query owner. A full selected page retains its
last row cursor; a short or empty selected page advances through the captured
Account cursor. `410 cursor-gone` requires a snapshot rebuild. The separate
`sessionAccessSessionId` probe cannot be combined with `sessionId` or `kinds`
(`400 invalid_params`). See the [change-feed contract](protocol.md#session-changes-03-development-source).

## Endpoint catalog
### Automation definitions (0.3 development)

`GET /v3/automations` returns a bounded, cursor-paged public definition list;
private recipes and trigger envelopes require `GET /v3/automations/:id`.
Structured selections use the same query owner through authenticated,
present-user `POST /v3/automations/query`. A managed-target request carries
`{ managedTarget: { homeId, managedId } }`. It selects only Account-owned,
non-deleted definitions for that exact relationship. The temporary
`includeUnindexedManagedTargets: true` option also admits rows whose relationship
is unknown, so the current client can apply the existing private recognizer
during backfill. `managedTargetUnindexed: true` selects only unknown rows for
the one-shot authenticated client startup migration. These selectors cannot be
combined with Workflow, Session or Account-inline scope selectors.
The structured POST is read-only and shares the GET list handler; migration
writes use the separate recipe-only PATCH CAS. UI startup reuses its existing
feature-admitted list response, skips a complete all-known page, and issues the
unknown selector only when that page is incomplete or contains an unknown row.

List/detail `managedTarget` is optional and nullable: omitted means unknown,
`null` means indexed and unrelated, and an id pair identifies a candidate.
Current writers derive the outer recipe field while sealing the private
Workflow; create/update/reconcile persist it through the existing definition CAS.
Older writers that omit it retain the relationship ids but leave its index
unknown. A current authorised client backfills readable recipes automatically,
without an operator step or read-driven write. The strict structured query
requires a matching development Home; unsupported requests remain unavailable
and never fall back to an unrestricted list. See
[the encryption boundary](encryption.md#automation-managed-target-relationship-03-development).

### Sessions
- `GET /v1/sessions`
- `GET /v2/sessions/active?limit=...`
- `GET /v2/sessions?cursor=cursor_v1_<id>&limit=...&changedSince=...`
- `POST /v1/sessions` (create or load by `tag`)
- `POST /v2/sessions/lookup-managed-birth` (0.3 development) — closed
  `{ homeId, managedId }` request; returns `{ sessionId: string | null }` for a
  unique Account-owned birth across active and archived Sessions. It reads only
  relationship ids. Layout-1 creation accepts the optional `managedCreation`
  carrier described in [Encryption](encryption.md#managed-resource-birth-relationship-03-development).
- `POST /v3/automations/runs/workflow-storage` with
  `{ operation: 'managed-birth.lookup', homeId, managedId }` (0.3 development) —
  returns `{ runId: string | null }` for a unique Account-owned durable Workflow
  birth. The exact indexed read returns no Run body. Run admission accepts the
  same optional closed managed-creation carrier as Session birth; Keep writes
  no FIN trigger and clearing a rule preserves the relationship.
- `GET /v1/sessions/:sessionId/messages`
- `DELETE /v1/sessions/:sessionId`
- `POST /v2/sessions/responsibility/set` (development source) — desired-state assignment of the one
  human Account currently responsible for a Session. Requires the actor's `assignResponsibility`
  capability and a target that already has current read access; it grants no access. Submitting the
  current value again is a true no-op. Returns `{ changed, responsibleAccountId, responsibleAccount }` from the
  committing mutation, including `changed: false` on a repeated value and the safe current summary
  for the authoritative id (`null` when unassigned). Assignment creates no Follow row;
  self-assignment sends no self notification. Archived Sessions retain responsibility and allow an otherwise-authorized
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

In 0.3 development, the existing Session messages reader accepts `messageId` to select one
committed row before fetching its body. It retains current transcript access, publication,
chain and role filters; a missing or filtered row returns an empty page with no continuation.
The selector cannot be combined with `beforeSeq`, `afterSeq`, `limit` or a collection
`projection`. The semantic `session.transcript.get` Action exposes the same `messageId`
selection, exclusive with `cursor`, `direction`, `limit` and `projection`, while preserving
its ordinary content opening, role/text projection and requested truncation. External-shareable
plugin reads retain their closed page contract and do not accept the selector. This coordinated
development extension is not support for a new client against a 0.2 Home.

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

#### Home Discussions (development)

Discussions are being refactored into first-class Home resources behind the existing
`sessions.conversations` server feature. Protocol contracts live under
`packages/protocol/src/discussions/**`; the canonical HTTP family is `/v1/discussions`,
with paths declared once in `DISCUSSION_HTTP_PATHS_V1` and consumed by Action specs and routes.
The feature bit is an
availability gate, not proof that a particular client, daemon or deployed Home supports the
composed flow; missing or disabled support fails closed as `discussions_unavailable`.
This is an in-progress 0.3 development contract, not a public release or a claim of completed
package, database-reconciliation or loaded-runtime validation.

Discussion AccountChange hints use the closed shape
`{v:1, discussions:true, changes:{readState?:true, resource?:true}}`, with at least
one flag. Private cursor writes emit `readState`; messages, access, proposal decisions
and other resource writes emit `resource`. The AccountChange publication owner unions
flags when coalescing the same Account/Discussion row. Only a validated readState-only
hint for the captured Account avoids list/attention queries: the client refreshes that
Discussion's summary and prunes read occurrences locally, preserving open decisions.
Mixed, missing or malformed hints retain resource refresh. Because coalesced rows are
retained, an earlier resource flag remains conservative; this is not a guarantee that
every later cursor write can avoid resource refresh.

The development `attachment` content part carries the shared file/folder payload,
with private leaf references and explicit relative paths/empty directories. A byte
upload is an alternate representation of the existing create/post/reply operation:
`POST /v1/discussions/upload`, content type
`application/vnd.happier.discussion-upload-v1`, contains one strict metadata line
followed by exactly its declared ordered byte segments. The ordinary Action guard
and message transaction still own admission and commit. No separate message writer,
upload-reservation Discussion, file ACL or attachment key is created. Metadata exposes
structural IDs, envelope kinds and stored lengths, not names or plaintext hashes.
The per-leaf boundary derives from the existing attachment-upload size preference
and its supported maximum; there is no new Discussion count or aggregate quota.

`GET /v1/discussions/:discussionId/messages/:messageId/attachments/:blobId`
returns the explicit plain/encrypted byte envelope under current exact-message
admission, optionally narrowed by `throughSeq`. The invoking host opens and verifies
length/hash before `discussion.attachment.read` returns its semantic bytes/descriptor
result. It never advances read state. Process-local source handles are private
invocation operands, not public arbitrary-path operands. Existing trusted Agent
publication and signed/delegated mutation transports refuse a leaf-bearing write
when they cannot admit its byte/source representation; they neither drop the file
nor relabel the post as Account-authored.

The Discussion owns its access and lifecycle. An optional Session/message, Doc or Task anchor grants no
source access and imposes no parent archive or deletion cascade. Each read and mutation resolves
current Discussion grants in the transaction through the shared resource-grant policy. Human
invitations use direct grants; Team/Group grants are explicit audience expansion. View may read,
edit may post, and owner/admin may manage. Mentions confer no access. Self-leave removes only the
present person's direct grant; inherited access may remain, and an owner must transfer ownership
or archive. Named-discussion absence and denial do not become an existence oracle.

The existing messages GET and `discussion.read` Action accept either history paging or
one exact `messageId` / `localId` selector. Exact selectors are mutually exclusive with
each other and with `beforeSeq`, `afterSeq` and `limit`; `throughSeq` remains available
and is enforced before message projection. A local ID selects only a message authored
by the authenticated Account. No match returns an empty page; an inaccessible Discussion
or unavailable selected source retains its existing typed refusal. Exact reads use the
same current grant, stored-envelope, source-admission and client key-opening owners as
ordinary reads, and never advance the private read cursor. These closed inputs move
together with their consumers in undeployed 0.3; there is no older-development paging
fallback for an exact lookup.

Mounted Discussion lists refresh the changed id's summary and patch its row and known
placement, retaining hydrated pages. Unknown membership or an order change beyond the
loaded frontier still uses the owning list query. Doc-scoped discovery remains the root
membership authority; an exact root reread or a dropped scoped root rechecks source
admission through the thread's access-loss owner. A source refusal withdraws retained
thread content as well as its list row; a transport outage does not imply revocation.

For an existing Discussion's invitations and prospective grants, physical deletion
of the anchored Session/original message is not an admission failure: no original
source content or source grant is supplied. Live source existence is distinguished
from denied access, unavailable keys and mode mismatch; those live-source cases
retain their current refusal/disclosure checks. Current Discussion access and target
Session admission are unchanged. Fresh source-quoted creation and source-active
operations do not consume this narrow missing-source exception.

In development source, Task anchors and reply targets share `{ kind: 'task', entry }`,
composing `TriageEntryRefV1Schema` from `@happier-dev/protocol/tasks/entryRefV1`.
Task access, configured-source selection and navigation remain Tasks-owned; a private
Discussion reply never invokes a provider-comment Action.

Discussion titles and messages use the same strict stored-content envelope family as Session
content. A Plain Discussion accepts only `{ t: 'plain', v }`; an E2EE Discussion accepts only
`{ t: 'encrypted', c }`. The CLI/daemon host opens or seals the semantic document with the
Discussion's own data key, while the Home validates the persisted resource mode, stores the
envelope and compares resource-keyed equality evidence without receiving E2EE plaintext.
Plain Discussions require no fabricated client encryption key. Missing or mismatched key
material fails closed; neither side reinterprets encrypted bytes as plain. List and message-page
projections can be explicitly incomplete when an authorized client cannot open an item.
The current client resource codec consumes this contract. Earlier Session-owned rows
and drafts are undeployed 0.3 intermediates, preserved without a rekey or draft migration.
Plain rows convert; encrypted legacy rows without recipient envelopes retain their ciphertext
and the existing `keyReadiness: false` unavailable state. The new client does not read the
old Session-addressed draft locations or fall back to the anchor's Session key.

The client captures `{serverId, discussionId}` under its Home/Account scope and retains the
authenticated server identity for replay. Creation and first-message `localId` are distinct
retry identities: a lost response retries the original pair. Later posts retain their own
`localId`; switching the selected Home must not retarget pending work.
Encrypted create reconciliation looks up the authenticated creator's `creationLocalId` in
active and then archived Discussions and opens the original caller envelope before retrying
with the same key and identities. Initial Account grants commit atomically with the resource
and first message; recipient envelopes are prepared through the existing authorized census
and fenced commit. Envelope-delivery uncertainty does not authorize another create.

Initial `participants` also accept concrete `{kind:'session',sessionId}` bindings,
alongside `{kind:'account',accountId}` invitations. The `discussion.create` Action
resolves SessionTarget selections before the HTTP boundary; the server receives concrete
identities and reuses ordinary invitation/control/disclosure admission inside the atomic
create. First-message typed Session mentions and `mentionedSessionIds` address only those
admitted initial participants. The first occurrence has `seq:1` and `throughSeq:1`;
an invitation without addressing does not start an agent. Invalid addressing rolls back
the resource, invitations and first message together; retry rejoins the original occurrence,
not a second post. These are development server contracts; the New Discussion selection
controls and loaded UI journey have their separate implementation/validation boundary.

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

The resource `discussion.*` Actions use Account placement and project semantic
documents through the trusted host's resource codec; it does not infer `current_session`.
Its generated [host Action reference](../apps/docs/content/docs/plugins/api/host-actions.mdx)
owns the operation inventory and surface metadata. API-token and runtime callers still use
normal grant, authority and approval admission; registration alone proves no executable flow.
The Plugin SDK's generated Discussion maps include present-user operations as requests through
the existing deferred approval owner. Its `ActionsService.execute` result must be narrowed
between the domain outcome and an approval-request result. The standalone API-token SDK is
generated from `PUBLIC_ACTION_IDS` instead: present-user create, rename, archive, restore,
read-state, Leave and ownership transfer are excluded. An API token's approval scope does not
expand that operation set or supply present-user authority.
The people-only resource contract includes replies to a message in the same Discussion.
Addressed participant input and correlated return are being integrated through the existing
C1 Follow and C2 original-input owners. `discussion.pass` is Session-placed: it settles the
current protected Discussion request through the existing Session reply operation, rather
than posting arbitrary text or selecting another participant. Atomic Agent create and its
first post use one trusted publisher transaction; there is no human HTTP fallback for Agent
provenance. Automatic final publication, approved replay, native cutoff live proof, model
participants, second opinions and the public composer remain integration work, not proof of
completed executable flows. See [Session collaboration](session-collaboration.md#addressed-participant-input-and-return-development-integration)
for the canonical addressed-input and return boundaries.

#### Personal relevance and attention from discussions (development)

`discussions/attentionFacts.ts` is the one bounded discussion adapter the personal owner consumes;
`personal/discussionFacts.ts` is the narrow port that turns its facts into relevance and attention
inputs. No second reader of the conversation store exists outside that adapter.

Participation and attention are separate contracts:

- **Human-origin discussion authorship**, when a Session anchor exists, contributes `authored_by_me`, so that Session appears in
  `involving_me` and `my_work` before pagination. A post is human when `producerV1` is absent; a
  row an Agent produced on its own execution Account, and a "requested by" association that carries
  no author at all, are production facts and never human participation. Archiving a conversation
  does not retract authorship.
- **An existing mention** contributes `mentioned_in_discussion`, which is `my_work` relevance only.
  Being named is not participation, so it never enters `involving_me`.
- **Baseline-derived unread and unread mentions** contribute the `unread_discussion` and `mentioned`
  attention reasons. They require current Discussion read access
  and an established private Discussion cursor, so browsing a shared Session, an absent cursor, an
  archived conversation and a viewer's own posts all stay quiet. An already read mention remains
  list relevance without ongoing attention.

The relational scope predicate, the pure viewer projection and `computeAccountActivityBadgeCounts`
consume the same facts, so the filtered list, the confirmed row and the pushed badge agree. Facts
are loaded once per page beside the owner account modes, never per row, and the adapter resolves a
whole candidate set — access, latest activity, cursors and unread counts — with a bounded number of
reads rather than one round trip per Session.

The Discussion grant owner establishes private cursor baselines on creation and new grant entry;
Session Follow transitions do not enroll Discussion readers. The optional Session-anchor
projection consumes these facts without making Session access the Discussion's authority.

The development-only `GET /v1/discussions/attention` read supplies cold Inbox demand through
the same `sessions.conversations` gate. It returns a paged batch of original message
envelopes and current Discussion summaries, with source-owned `decision`, `mention` or
`update` classification. Unread selection shares the cursor/self-authorship predicate used
by the aggregate facts above. An open Doc proposal also appears at or before the read cursor when
C5's current present-person and Doc access admission permits this viewer to decide it.
Reading never settles that proposal; its existing accept/decline disposition does.
Independent Doc access is rechecked before returning source-bearing content, and unavailable
coverage is explicit. This endpoint adds neither stored Inbox notices nor a person-request
model; existing approval requests keep their own reader.

For a changed Discussion, the same endpoint accepts optional `discussionId` and
`afterCursor`. The latter requires exact-id selection and is the inclusive oldest
occurrence of the globally loaded window; ordinary `cursor` remains its exclusive
older-page bound. Selection and unavailable-key coverage are narrowed before message
materialization, with the same current grant and source admission. The client replaces
only that Discussion's occurrences and keeps the global continuation cursor and other
loaded entries. An exact response's continuation pages only that id, not the global list.

`discussions/changes.ts` publishes first-class `AccountChange` hints to the current resource
audience after commit. Private cursor changes invalidate and refresh the acting Account only.
Badge refresh delegates to the Account activity owner. These invalidation facts do not establish
agent delivery, push delivery or a second Discussion notification engine; the later addressed
delivery integration consumes the shared Follow/delivery owner.

#### Private Follow rules (development)

The `sessions.following` feature exposes the authenticated Account's private rules
at `/v2/account/session-follow-rules`. `GET` returns the complete `{ rules }`
census for both Account and Session receivers; `GET /:ruleId` returns `{ rule }`,
with `null` for absence. Each rule contains `ruleId`, `receiver`, `content` and
its authoring `version`, server-owned `inception`, and optional `sources` with each source's existing
`delivered` frontier. These private progress cursors let the Account evaluator
read only its remaining source range; they are not historical match snapshots
or native publisher projections. Recovery may demand `GET` with an exact
`destinationSessionId` to obtain `sourceRanges` from the existing Account-change
frontier and original message times. This covers a new rule before any source
has progress, without creating per-source Follow edges. The range starts at rule
creation; editing preserves inception and accepted progress. Millisecond ties are
included because original records have no finer ordering witness. Unavailable
source access or a pruned change frontier remains explicitly incomplete.
An unreadable or mode-inconsistent row fails the read;
it never becomes an empty rule set. Other Accounts cannot read these definitions.
Restricted Session runtimes and scoped API tokens cannot use these private rule routes;
ordinary Account credentials and unrestricted Account API tokens retain access.
`POST /v2/account/session-follow-rules/personal-progress` uses that same private
authority to settle a source owner's personal rule delivery. Its closed body names
the exact source, current publisher generation/Machine installation, matching rule
ids/versions, and either an original message id/seq or the full current request-map
witness with each rule's selected `requestIds`. The owner verifies current source
access, explicit-Unfollow suppression, receiver mute state and rule inception,
and the existing private viewer projection: a message must still be unread and
visible, and requests must still belong to the current state version and an active
request projection. Each rule's selected ids must be present in that map and follow
its inception. The authorized source executor opens encrypted request identities
and supplies the complete map only after evaluating all its current requests;
aggregate Home counters include other sources and cannot prove foreground-map
completeness. The Home never opens private rule definitions or request ciphertext.
Protected self-authored user messages remain excluded from personal acceptance;
the actor comes only from the original authenticated-Account admission receipt.
Machine, legacy or missing author evidence never implies the source owner wrote it.
The response `{ accepted, alreadyRepresented }` reports current Inbox acceptance
and whether an applicable rule already consumed that original. Acceptance advances
the existing rule `sources[].delivered` by physical-row CAS without changing its
authoring version; it never depends on notification-channel success. With no stored
rule witness, owner-implicit Inbox acceptance creates no cursor or enrollment and
reports `alreadyRepresented: false`. This development operation neither acknowledges
a push/Voice send nor changes the original notifier's retry ownership.
For explicit Run and Discussion sources, this same endpoint advances only the
private delivered-original progress. It does not publish a Follow-configuration
invalidation: the relation and policy are unchanged. Actual source changes and
configuration edits retain their existing change-feed publications, so a later
original remains discoverable without re-demanding unrelated unavailable Runs.
The existing `POST /v2/sessions/:sessionId/pending` also admits an Account evaluator's
exact `followSources`, `followRelations` and public `followDeliveryV1` under its
own Account receipt. Private witnesses require the receiver Account's credential;
a shared Machine's custodian credential cannot author them. Existing target placement,
source access, rule version and original-occurrence admission remain mandatory.

Generic `follow.get/set/remove/list` Actions retain their exact signed HTTP purpose:
only rule get/set/list may prepare Account currentness, and only list may read the
private census. The proof validates the actual sealed rule body, not a plaintext
authoring definition. A finite signed Action does not widen the originating
credential's Account authority. Operational Session requests bind the declared
receiver and retain the existing source/receiver resource admission.
`follow.preview` reuses the strict Session-query corpus and its existing
target-wide collection admission. An action-only API token may use that corpus;
its optional private Project-row and named Session-organization assignment snapshots
require unrestricted Account authority, including through approved wrapper Actions.
The assignment phase uses the existing scoped snapshot with Folder, Tag and Label
catalogs disabled; it authorizes neither broader snapshot query flags nor mutations.
Missing private Project or tag-assignment evidence stays unavailable/partial at the preview owner,
not an empty complete result. Preview grants neither arbitrary Account/KV reads
nor Project-row mutations.

`PUT /:ruleId` accepts the closed `{ receiver, content, expectedVersion }` body.
Creation uses `-1`; editing uses the returned authoring version and preserves the
receiver identity and source progress. A Session receiver must currently belong
to the authenticated Account and admit the operation. `DELETE /:ruleId` compares
both the stored receiver and authoring version, then returns
`{ changed: true, version }`. This returned version is the acknowledged tombstone
CAS token for Undo and can jump after progress writes. Restore through the same
PUT using that token; a stale token returns `409 version_conflict`. A retained
definition remains privately readable and removable after its Session is deleted.

Content uses the explicit Account-mode envelope described in the
[encryption contract](encryption.md#key-value-store). The named
`sessionFollowRules` Account-transition participant requires the complete active
census and target-mode content; omission asserts no active rules. It converts
definitions atomically, preserves progress and supports exact read-only replay.
Rule matching uses the source facts currently readable by the authorized evaluator
when it processes the occurrence, not historical Account-private facts. A source
moved between Projects is matched against its current Project; unavailable current
facts remain unavailable rather than becoming a match. The CLI reads demanded
Project rows and exact tag assignments under the captured evaluator Account;
it does not borrow or publish another installed Account's organization snapshot.
The occurrence's original
identity and event are distinct from these current filter inputs. Rule matching
must not retain Account-private event-time facts in transcript metadata, nested
ciphertext or a snapshot history.

Private rule witnesses remain inside the server's existing Pending-to-Message
admission receipt. Shared readers and the native publisher receive only the
public original occurrence and merged delivery intent, never rule identifiers,
versions or private policies. Native observation, source projection, key
preparation and progress acknowledgement refer to the exact destination and
`localInputId`; their owners resolve the retained reasons internally and recheck
current access. Active route/progress mutations also require current rule versions.
An exactly provider-accepted original may still be read after its old rule or
relation is removed, but only through its accepted custody and current source/pair
access; that historical effect cannot authorize another route mutation.
Materialization alone is not provider acceptance.
Runner source projection includes the current opaque `agentState` envelope for the
authorized native request owner to open. A retained request original keeps its
admitted snapshot version when unrelated state advances; native admission must
still prove the exact request id, creation time and optional turn are currently
live. Aggregate request counts are not that proof. Fresh admission remains bound
to the current source snapshot. Both fresh occurrence and input carriers reject
message-backed `needs_you`; questions must name the exact source request rather
than an old permission transcript message.

Current development accepted-input custody projects one original occurrence key
onto its existing Message only when provider acceptance is settled. The indexed
destination/key lookup lets a later admitted route settle its progress without
another native input or changes to the accepted receipt. The key excludes route,
policy, publisher and request-snapshot version. Each new Follow input represents
one original message or request; older development inputs without that proof
remain unproven, with no invented backfill or encrypted-history scan.
Destination intake reads original-backed updates from this admitted custody.
While the host holds queued transcript originals from a source, its optional manager
outcomes wait. They cannot consume the originals' context allowance or advance
manager progress past their represented prefix. Foreground questions retain
their separate exact waiting-Turn witness rule.
Legacy manager intake retains Turn-only lifecycle evidence. Exact terminal
transcript anchors and request-to-waiting-Turn witnesses prevent an admitted
original from returning as another lifecycle update; later transcript ranges
remain available to the original reader.
Native `ready` can be committed after the Turn's transcript anchor closes. Its
existing ready frontier only locates an exact accepted original; the native reader
opens and validates `ready.completedTurnId` against the current completed Turn
before suppressing that overlapping lifecycle update. This accepted-custody rejoin
is correlation evidence only, never another prompt input or acknowledgement candidate.
Follow socket ACKs return `retryable` when the storage owner reports an expired request
budget, unavailable transaction admission or exhausted recovery with confirmed rollback.
Unclassified and ambiguous transaction failures remain `internal`; they are not reported as
proof that an earlier effect did not commit.
These are development contracts; they do not establish completed
source-daemon rule dispatch or released availability.

#### Personal Follow (development)

The development server registers the personal Follow resource through
`registerSessionFollowRoutes`; `accountFollowService` owns its transactions and current access
checks. The `sessions.following` server feature controls availability. These endpoints are absent
from the inspected `server-v0.2.11` and `server-v0.2.11-preview.2` contracts; new clients must check
the feature before using them. Source implementation alone does not establish release availability
or completed runtime delivery validation.

- In 0.3 development, `GET /v2/account/session-follows` and
  `GET /v2/sessions/:destinationSessionId/follows/sessions` accept optional
  `cursor`, positive integer `limit`, `source` (a JSON-encoded existing
  `FollowSourceRefV1`, excluding rules), and `sourceKinds` (a JSON-encoded nonempty
  array of `session`, `discussion`, `execution_run` or `workflow_run`). The public `follow.list` Action uses
  `{ direction: 'following', receiver, source?, sourceKinds?, cursor?, limit? }` and encodes
  that query through its canonical transport. A Session source selects its own
  explicit Follow and execution-run Follows belonging to that exact Session;
  Discussion, execution-run and workflow-run references select only that exact
  source. Kind selection restricts that result before pagination; it is a set,
  so reordering or repeating kinds does not change a cursor's selection.
  Kind-selected reads do not acquire the unrelated private rule census.
  No Session inventory or content matching is involved.
  Selection and candidate paging happen in SQL before source admission and
  projection; every returned row is freshly readmitted. A short or empty page
  can still carry `continuation` when candidates lose access or cannot project.
  Continue until it is absent. A cursor is bound to the authenticated Account,
  receiver and source selection; changing that selection returns
  `400 invalid_parameters`. Forward-list continuations are sealed by the server
  so their candidate position cannot disclose an omitted source identity;
  clients treat them as opaque strings. This uses the existing server key,
  independently of the Account's plain/E2EE mode. Omitting `limit` returns all currently admitted
  matching rows, preserving the unfiltered default when both selectors are omitted.
  The selector extends the undeployed V1 contract and must not be silently
  ignored by an older server.
- `GET /v2/sessions/:sessionId/follow` returns `{ follow, capabilities: { manageFollow } }`, where
  `follow` is null or the authenticated Account's own Follow preferences. Alongside
  `{ sessionId, following, notificationLevel, includeInVoice }`, the development projection
  can carry `policy`, `once`, `onceAfterAgentStateVersion`, `onceDelivery`, and `persistent`.
  `persistent: false` identifies one-shot-only custody, not an explicit Unfollow.
  `includeInVoice` projects effective Voice selection from the explicit policy through
  Protocol's `resolveAccountFollowVoiceSelectionV1`. Voice is additive: an event whose
  delivery is off can reach Voice while remaining absent from Inbox and Session wakes.
  Important and Quiet also keep message delivery off when Voice is selected.
- `PUT /v2/sessions/:sessionId/follow` accepts a nonempty mutation: the legacy pair
  `{ notificationLevel, includeInVoice }`, `policy`, `once`, or a combination, and returns
  `{ changed, follow }`. Legacy notification levels remain `none`, `important`, and
  `all_messages`. `policy` selects Everything, Important, Quiet, or per-event Custom delivery;
  its closed schema and receiver projections belong to `sessionFollowPolicyV1`.
  The scalar pair normalizes immediately into that policy; `notificationLevel` is a
  derived response field, not a persisted decision. The one-way 0.3 migration converts
  retained scalar choices before dropping the column and preserves one-shot custody,
  explicit suppression, and private Voice frontiers. Existing explicit policies win.
  A new Follow starts personal tracking at the current readable publication
  ceiling; updates to an already tracked owner or follower preserve that reader's progress.
- `DELETE /v2/sessions/:sessionId/follow` returns `{ changed }` and records explicit Unfollow.
  The retained suppression prevents an automatic default-rule match from undoing the
  choice. Existing owned state can be unfollowed after read access disappears without disclosing
  Session details.
- In 0.3 development source, `GET` and `PUT /v2/account/session-follow-preferences`
  share the `follow.preferences.get/set` Action owner. All four relationship Booleans
  `{ assigned, direct, team, group }` remain required on PUT. Defaults are
  `true`, `false`, `false`, `false`. The canonical default-rule normalizer applies
  these server-readable Account preferences to later occurrences using current
  authorized assignment/direct/Team/Group facts. Assignment and access mutations
  create no per-Session Follow rows or private read baselines. Changing defaults
  does not enroll or backfill Sessions, rewrite retained Follow choices, or reset
  private read/Voice/one-shot progress. Explicit Unfollow suppresses default rules;
  owner tracking remains implicit.
  Optional `managerPolicy`, `runReportPolicy` and `discussionReceivePolicy` use the
  canonical Follow policy grammar; omitted fields preserve saved choices. GET returns
  each effective creation policy: Important for managers and Run reports, Quiet for
  Discussion participants by default. Manager and Discussion
  attachments capture their policy at creation, so later default edits do not rewrite
  existing attachments. These operational event choices use the existing reserved
  Account KV custody and remain server-readable in both Account modes; private rule
  filters retain their separate mode-aware envelopes. Session-owned Execution Runs
  capture the owning Account's report policy before native creation and retain it
  through restart. Workflow Runs requesting origin reports freeze the same choice
  in accepted `resultDelivery.reportPolicy` during direct or trigger admission;
  event selection and wake use that captured choice without another preferences
  read. An unavailable fresh preferences read refuses reporting Run creation. Older
  retained Runs without a captured policy keep Important behavior. These defaults
  do not change an existing Run's report policy.

Personal Notify me uses `once: { kind: 'turn_finished', sourceTurnId }` or
`once: { kind: 'first_needs_you' }`; `once: null` clears it. This changes neither persistent
Follow nor Voice nor the read cursor. The existing Account Follow row stores the armed source
baseline and, after accepted delivery, the fulfilled source reference. Recipient lookup is
read-only: the delivery owner consumes an exact armed value with a compare-and-swap only after
rechecking current Account/access/archive and the committed turn or request. An accepted Inbox
effect can fulfill the one-shot even when no OS-alert transcript pointer exists; this does not
claim push-provider receipt. Opening/marking read clears fulfilled one-shot attention. A pending
question additionally needs the decrypted request owner's exact live request id; an encrypted
state's pending count is not sufficient evidence that the original request remains actionable.
In 0.3 development source, the modern owner metadata-tuple writer carries newly pending
main-turn request identities in optional `activitySummaryV1.newUserActionRequiredOccurrences`,
using the strict `SessionUserActionRequiredOccurrenceV1` shape. The same tuple CAS accepts
one-shot Inbox custody before commit; legacy socket and modern owner/migration writes share
one request-publication helper. Count-only summaries remain accepted and never fabricate an
occurrence. This is source-level behavior, not a claim of released or loaded-runtime availability.

The development Account receiver reads private sender/source mute scopes through
`GET /v2/account/session-delivery-mutes` (`session.delivery.mute.list`). CLI and UI
delivery use the captured Home/Account credential and the shared scope matcher;
unavailable, malformed or different-Account facts withhold personal delivery.
Activity surface snapshots reuse the existing Account census and its `session-follows`
invalidation. A routing mute does not Unfollow, delete source work or remove Work/Inbox rows.

All four attention adapters consume `resolveAttentionDeliveryPolicyDecision`. Its Follow input
uses the same preset/Custom event policy for people and Session receivers: Important completion
is quiet, a continue-mode question is quiet under Important, and manager-handled questions stay
visible but quiet for the person. Generic Inbox `update` and `mention` items are quiet by default;
source-owned host usage/resource alerts retain their existing configured alert policy. These
development contracts do not establish availability of the later Follow-sheet or Inbox visual
composition.

Committed request occurrences optionally carry a closed, content-free `followEvent` projection
for Home delivery. It carries delivery mode/type and whether a manager is handling the request,
not the assumption, question content, or manager identity. The request owner supplies these facts;
the notification adapters neither elect a handler nor grant answer/approval authority.

In 0.3 development source, committed Goal changes and `session.update.post` reports
also retain their original event kind through the existing personal-message delivery
path. The current source publisher and original message sequence qualify the event;
the Home and live client use the same Follow decision for quiet versus Interrupt.
The existing opaque local-id constructor carries only the allowlisted event category
for encrypted originals, without opening or copying Goal/report content. History,
sidechain output and message replays cannot publish a second original alert.

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
The development Account Voice observer and acceptance-bound ACK now carry the current
per-event policy. A modern policy write retires legacy unfiltered inclusion; the legacy
notification/Voice pair clears explicit policy instead of writing both authorities.
Bulk Voice edits preserve explicit event selections through the shared policy editor,
and use the legacy boolean only for policy-absent rows. Their response and tracked-target
Action results report effective included Sessions; a Custom policy with every event off
does not become included merely because it was requested. Initial inclusion still
provides one bounded current snapshot. Subsequent modern reads select original events
through `resolveFollowDeliveryV1(...).person.voice`, preserving the oldest selected
prefix under the snippet/context allowance. Policy replacement, source mute and
access loss withhold delivery or reject its ACK; only accepted represented context
advances the existing Voice frontier. These are source contracts, not a released or
loaded-runtime Voice certification.
The development personal stalled occurrence is the existing publisher-presence
expiry CAS plus the exact still-in-progress Turn and its committed `lastActiveAt`
fence. It uses the same personal admission/publication and remote-alert owners as
Message/Request originals, with `FollowPolicyV1` event `stalled`. The existing
content-free `source_unavailable` presentation carrier optionally holds that exact
`stalledOccurrence`; it is not a new semantic log, Message, timer or consumption
cursor. Both live and remote dispatch recheck the original projection; recovery,
replacement, completion or archive withdraws pending delivery. An already-published
stalled Inbox/Work item settles through the existing current-state projection on
recovery; a submitted OS alert is not claimed to be recalled. Native readers retain
the exact witness for cross-leg identity and otherwise preserve generic fallback.
Archive retains Follow choices. A genuine restore clears enabled Account Voice frontiers to their
current-snapshot state and reseeds Session edges only when both endpoints are unarchived, in the
archive transaction. It does not advance a human read cursor or recreate a Follow deleted by access
revocation. Assignment and grant mutations invoke the same Follow service; Team/Group behavior
depends on the canonical effective-access producer, whose integration remains an open development
gate.

In current 0.3 source, archive and unarchive acknowledge the committed transaction before
post-commit badge/realtime publication finishes. Publication failures are logged without changing
that receipt. The CLI keeps Archive and Unarchive HTTP requests within the containing caller's
cancellation lifetime, without imposing the generic session-control HTTP cutoff. A lost response
or cancellation after dispatch reports `outcome_unknown`, because either can follow a commit.
The private MCP, ACP, prompt-library and Connected Account catalogs preserve the Home's typed
`database_transaction_conflict_exhausted` response for a confirmed rollback. An unclassified
server failure after a catalog mutation was issued reports `outcome_unknown` rather than
claiming the daemon was unreachable. A confirmed rollback during catalog hydration also
keeps its typed reason. Re-read the canonical resource before retrying an
uncertain mutation.

The same transaction owner recovers a native Prisma missing-transaction error
when it occurs before its callback completes. Under transaction churn, Prisma
can evict an expired transaction's diagnostic and return `P2028` without the
expiry message. The callback has not returned, so the owner has not submitted a
commit; recovery uses the existing attempt budget. A missing-transaction error
after callback completion remains an unknown outcome and never authorizes replay.

Session metadata tuple writes in current 0.3 source also preserve transaction
failures through the global HTTP error handler. A confirmed rollback returns
the same typed 503 response; unexpected failures retain their diagnostic cause
for server logging. The tuple writer translates only its Team credential-binding
domain rejection. It does not collapse database failures into an unclassified 500.
Standalone tuple writes prepare the publication audience before the mutation
attempt, then acquire and recheck its fence before the canonical CAS body.
Composing callers acquire the same fence inside their containing transaction.
Both tuple and legacy `PATCH /v2/sessions/:sessionId` acknowledge the committed
mutation before starting current-view publication or its post-commit row read.
A missing row, rejected projection or failed publication read after commit is
reported in content-free server diagnostics without changing the receipt. The
committed change cursor remains available for ordinary client recovery. A
publication-submitted diagnostic does not attest to realtime fanout delivery.

Account-local writes in current 0.3 source use `inTx`'s ReadCommitted default
after acquiring their existing Account fence, before mutation admission reads.
This includes Connected Account credential, configuration, health and group
mutations. Their row, generation and revision CAS checks remain authoritative.
Session archive/unarchive use the same ReadCommitted default and prepare their full
publication audience before each attempt through `inTx.prepare`. The returned
fence locks and rechecks that audience before authorization and Session reads;
an expanded audience replays with fresh preparation. The same Follow/manager
transition owner and durable publication remain inside the transaction.
Ordinary Layout-1 tag rejoin likewise uses the default behind its
prepared Account audience fence when admission is covered by that audience.
Empty grants, initial triggers and Team credential-binding lists introduce no
additional admission predicate. Restoring an archived tag keeps the same Session
identity; nonempty composed admission retains its explicit isolation choice.
Manager and Session-context Follow writes likewise use the default behind their
ordered Account audience fence; manager changes retain their preceding Home graph fence.
Personal Follow, Voice membership, auto-Follow preferences and viewer read-frontier
writes take the existing single-Account publication fence before admission reads.
Stale manager expectations return `manager_cas_conflict`/409, while a
confirmed exhausted database rollback uses the global typed503 response above.
Read-only Account catalog,
plugin Settings/storage HTTP reads, prompt-library row/list reads, Settings-history
row/list reads, Artifact admission and Connected Account/usage captures
use `inReadSnapshot` for a coherent view without joining PostgreSQL's SSI graph.
The transaction wrapper does not downgrade an explicit Serializable request:
shared-secret grant admission and legacy usage/source mutations retain it where
their predicates are not covered by the Account fence and row CAS alone.
Connected configuration and ACP catalog writes with no Saved Secret references
use the default; writes capturing such references retain Serializable for grants
another Account can change. ACP reads use the same coherent read-snapshot owner.
No retry or deadline policy changes with this selection.

The development MCP catalog mutation takes its existing Account encryption-transition
fence before reading currentness, references or the catalog, using ReadCommitted.
A concurrent Account cursor publisher can therefore finish before the fence is acquired
without invalidating a Serializable snapshot and replaying the catalog mutation.
Catalog revisions still use the same row CAS. Catalog reads use one repeatable read
snapshot so Account mode and stored content remain coherent across a mode transition.
Connected Account credential deletion likewise acquires the existing Account fence
before credential, group and managed-resource admission under ReadCommitted. Its
HTTP adapter preserves confirmed rollback separately from `outcome_unknown` after
a lost deletion acknowledgement, using the existing Connected Services HTTP budget.
Revocation callers must reconcile the qualified Account before repeating an uncertain
deletion; an executed Action envelope alone does not establish revocation.

The development Home alert submitter composes personal-event eligibility with the recipient's
current settings-version-bound remote policy and enrolled device policy. A `suppress` decision
submits nothing; `silent` submits the generic alert without sound through the shared silent Android
channel. Audible alerts use the shared bundled/system sound and channel mapping; unsupported custom
sounds remain silent. Expo submissions carry `mutableContent: true` so an installed native extension
can enrich the permitted fallback. This flag does not supply that extension or prove native preview
or closed-app display.

Committed ready, assignment and source-qualified permission/user-action transitions schedule this Home leg.
Authenticated runtime composition decides whether the rich sender owns an ordinary owner alert;
an exact accepted personal one-shot remains the Home's responsibility. Request scheduling
carries the original committed request identity and the occurrence's captured source Turn,
not opaque Agent-state changes or pending counts alone. Current development Home request events
carry that optional Turn through the existing protocol and native readers. Legs carrying the
same request and Turn share their presentation identity; a reused request id on a different
Turn stays distinct. A turnless request keeps its existing request-only identity and is never
rebound to the latest Turn. Complete loaded and closed-app remote-alert validation remains
separate from the source-level checks.

#### Session-context Follow authoring (development)

In 0.3 development source, `session.update.post` publishes an original update
from the hosting Session without requiring a manager. Its input contains a
summary and optional deliverable references; its successful result names the
source Session and committed local message id with `persisted: true`. The
registered Session Action uses that Session's captured Home. Foreign workspace
references and direct workflow-step publication are refused; workflow steps use
their existing draft/review path. Persistence does not establish follower delivery.

The Session-to-Session Follow hydrator projects protected original human ingress as a notice
with the original source/message reference, without copying its text. Other
Session messages retain their admitted projection. Account Voice uses its own
explicit snippet-disclosure policy. Loaded-runtime validation of the development
publication and delivery journey remains separate from these source contracts.

Receiver catch-up stops a source range when an original's route or admission
cannot be confirmed. Its later originals wait for the next existing reconciliation
boundary, so their accepted progress cannot skip that original.

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

Source projection changes persist a content-free destination Session AccountChange in
the source transaction and schedule its socket hint only after commit. Manager and ordinary
Follow relations share one destination audience resolver; overlapping relations invalidate
that destination once.
The existing Session cursor census fences the complete source and destination audiences
before mutation, including a newly admitted follower audience on transaction replay.
Relation fanout uses the canonical batched AccountChange writer, preserving a distinct
cursor for each Account and destination. Existing unchanged-read and annotation-only paths
retain their publication-free behavior.

The development `POST /v2/sessions/:destinationSessionId/follows/inactive-observations`
read admits Account or terminal credentials only for their own destination's exact committed
Home, Machine and installation target. It rechecks source access, pairwise disclosure and
receiver mute through the existing observer. The response creates no runtime principal,
accepts no provider input and advances no source frontier. Automatic idle wake still needs
the canonical Follow policy and daemon resume composition; this read alone does not
establish that behavior.

#### Widget storage and Action boundaries (0.3 development)

Widgets add no dashboard REST service. The generated
[host Action reference](../apps/docs/content/docs/plugins/api/host-actions.mdx)
owns current catalog, definition, layout-item, group, fragment, input, area-layout, Refresh and
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

Account definitions (`widget-definition.v1`), saved-group fragments
(`widget-layout-fragment.v1`), Home layouts and personal
Project/plugin/core-page area layouts (`widget-area-layout.v1`) reuse the existing
mode-aware Account Artifact transport and CAS admission. WorkBoard widget
placements reuse `work-board.v1` rather than a parallel Artifact. Shared Session
instances and inert snapshots use the Session Board writer below; direct
Companion instances remain device-local presentation preferences. Layout
identity is separate from a definition reference and the instance's input
bindings. Persisted Account mode, not key presence, governs every Account
Artifact read/write.

Home and area bodies persist one `items` array of widgets or non-nesting groups.
The shared placement reducer owns group membership and ordinary item changes;
`widgets.item.*` replaces the unreleased `widgets.instance.*` names in place.
Adding a fragment submits one `group_add` intent with fresh placement ids, so
saved groups are independent copies. WorkBoards and Session Board retain their
existing individual-widget shapes. Project, plugin and core-page areas use one
`layoutId` and the `widgets.area.layout.list/create/select/rename/delete/reorder/reset/undo`
Actions. Host presets and personal views share the same Artifact owner. Create
with `fromSurface` copies the current layout. Missing defaults cause no write;
an explicitly empty saved layout remains empty. Reset requires the current
`expectedRevision`, and Reset/Undo refuse intervening edits.
Saved-group fragments are private Account library content; their canonical
Artifact kind policy excludes generic browser listing, people sharing and public
links. Copying placements retains any child definition references and their
existing edit semantics.

Key-holding WorkBoard updates and retained-body restores also enforce the
canonical widget-content sharing policy for an admitted shared document,
including ordinary Artifact editors. Candidate retagging cannot bypass the
current kind's private-input policy; the existing codec and expected-revision
writer remain authoritative.

Viewer credentialed reads consume the viewing Account's existing qualified
Resource-consumer/purpose selection. Private selections and credentials are not
shared Board payloads. There is no per-instance viewer override or widget-local
selection setting; missing purpose selection leads to Connect. Pinned Connected
Account references are personal-only instance bindings. Changing the existing
purpose selection retains its normal preference lifetime and can affect other
viewer bindings using the same qualified purpose. A declared viewer binding can
be configured without an author selection; reads still require the viewing
Account's selection. Personal Project dashboards use the stable private Project
key without a Source; only Source-dependent inputs await that producer. Named
dashboards contain main and aside in one Artifact. An attached shared document
uses its owner's exact Artifact identity and current actor access, not a copy
under the recipient's private Project key. Generic Artifact Actions exclude
internal dashboard kinds; dedicated widget and access-grant Actions do not
bypass the dashboard owner's validation. These development-source
contracts do not claim released or loaded-platform availability.

#### Session visuals and Board (development)

The shared Session Board stores its content as host Session System Records
(`surface/layout.v1/layout` and `surface/item.v1/<itemId>`) and exposes exactly one
mutation endpoint:

```text
PUT /v2/sessions/:sessionId/board
```

Strict body validation precedes admission. The shared mutation predicate applies
`sessions.board` admission only when an operation writes layout; disabled Board
layout operations answer `404 { "error": "not_found" }`. Placement-free Session
content operations remain available under current Session capabilities. The route
uses the existing `session.board` hot-endpoint rate-limit family.

The body is a closed operation union:

- `upsert_item` — `itemId`, `itemContent`, `expectedItemRevision` (`null` creates), and
  optional `destination: transcript | board | both` and `placement` carrying
  `layoutContent` plus `expectedLayoutRevision`. New content defaults to transcript;
  Board or both creation requires an atomic first placement. Both stores one item,
  not two copies. Omitted destination on updates preserves stored intent; legacy
  items without a stored destination retain Board intent. Plain-envelope intent
  must correspond to the operation's destination.
- `remove_item` — `itemId`, `expectedItemRevision`, and, when removing placements,
  the exact replacement `layoutContent` with `expectedLayoutRevision`. Transcript
  content can be removed without reading or writing layout. Supplied layout
  operands unlink placements atomically; an item-only removal leaves any retained
  Board reference in its existing missing-reference state, not a live body.
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

The existing `session.board.item.upsert` Action defaults new visuals to transcript
and returns a small address/id/revision/outcome/destination acknowledgement, not
the content body. Transcript references use that acknowledgement and the shared
exact-Home Session-record observation owner; no mounted Board controller is
required. After validating the exact issued local transport, a successful Action
acknowledgement uses the host-proved portable Home identity when available.
Response and transcript correspondence compare profile labels through the shared
Home-identity comparator; without identity proof, only exact equality is accepted.
Foreign Homes remain refused, and recovery packets retain the exact local profile
used for the issued request. The incumbent transcript list visibility publisher
drives content
demand. Offscreen references release observation and bodies while retaining their
measured slot; opening a Session does not fetch every visual. Board placements,
including Pin, use `session.board.layout.update` on the same item. Unpin removes
the placement, not the content. Fork creation seeds independent transcript-only
child copies through the same mutation owner; an unavailable copy leaves a stable
not-copied state and never fails the fork or authorizes a parent read.

Failures use a closed error document — `400 session_board_invalid`,
`403 session_board_forbidden`, `404 session_board_item_not_found`, and `409` for
`session_board_storage_mode_mismatch`, `session_board_source_conflict` and
`session_board_revision_conflict`. A revision conflict may carry `currentItemRevision`
and `currentLayoutRevision` so a client can refresh and retry with current revisions.
Repair is that ordinary retry; there is no second endpoint.

Reads reuse the existing V1 System Record routes with the exact `surface` addresses:
`GET /v2/sessions/:sessionId/system-records` and
`GET /v2/sessions/:sessionId/system-records/record`. No Board-specific GET or cursor
exists. All content reads require current `readTranscript`. Exact `item.v1` reads
and typed item inventory do not require Board admission; layout and unqualified
surface inventory do. Board inventory is demanded by an open Board, an actual
visual in Companion, or the open Add picker, not a retained hidden/measurement
surface. Both addressed and inventory readers reuse the same retained records and
opened content. The `surface` kinds are typed-only: the record catalog marks
their generic write and delete unavailable, so neither the generic upsert on
`/v2/sessions/:sessionId/system-records` nor the generic delete on
`/v2/sessions/:sessionId/system-records/record` can reach them, and the predecessor host
list, lookup and upsert schemas exclude the namespace entirely. Every Board mutation
rechecks the actor's current `editSessionRecords` capability in the committing
transaction.

In 0.3 development, actual readable host-record mutations publish an independent
AccountChange `account` entity, `session-record:<physical-record-id>`, with strict
`{v:1,sessionRecords:{sessionId,address}}` routing. Later transcript writes cannot
overwrite that record's retained change. Catalog-owned actor scopes remain
actor-private; Session-owner records use the current Session recipient and
transcript-publication policies. Board mutations have no second broad Session
publisher. The existing content-free Account socket wake optionally carries
`sessionSystemRecords` targets before catch-up, including on secondary Homes:
`[]` explicitly excludes record/access changes, an addressed target refreshes
matching observations, and a target without an address revalidates the Session's
records and access. Missing/unknown routing stays conservative. Closed, known
transcript, metadata, Agent-state, Activity and Turn row-fact hints do not refetch
visual records. The canonical hint parser accepts the HTTP projection's typed
pending-Run targets alongside those facts; pending targets alone and unknown
fields do not establish that records are unchanged. Encryption transitions and
access changes retain full revalidation. The released/predecessor revisionless
workflow reader still refreshes from ordinary Session row changes, independently
of physical-record invalidation. Addressed record Account wakes
do not refresh private Account catalogs; mixed Artifact or Saved Secret changes
retain their ordinary Profile-catalog relevance.

In 0.3 development, the same list route accepts the exclusive query
`owner=host&namespace=surface&kind=item.v1&projection=count` and returns strict
`{count}` after the ordinary current-Session read authorization. One aggregate
counts stored item records, including retained or unavailable items; layout rows
and dangling placements do not contribute. It reads no item bodies and runs no
widget producers. Ordinary queries without `projection` keep their paged result.

`session.board.get` exposes that scalar as the exclusive input
`{sessionId?,projection:'count'}` and strict result
`{v:1,serverId,sessionId,count}`; `itemIds`, cursor and limit are excluded. The
Session rail first reuses a complete authorized held record inventory, otherwise
its existing System Record repository makes at most one scalar read per mounted
Session address. Existing invalidations may make that fact unknown; they do not
trigger another count read, polling or a detail subscription. Unsupported,
malformed or denied count replies stay unknown rather than becoming zero or
falling back to a full inventory. An independently opened Board can establish the
count again from its complete inventory.

Current development System Record CRUD diagnostics report unexpected exceptions
and internal stored-record failures after their owning transaction settles. The
default server error log includes the operation, a fixed failure category, an
allowlisted exception name and a validated Prisma code when available. It omits
record content, identifiers, raw messages, SQL, stacks and exception metadata.
Recovered unique-create races stay silent. These diagnostics identify the next
failure to investigate; they do not repair an underlying database or stored-row
defect, and the public error responses remain unchanged.

Current development `item.v1` reads also expose server-owned `creator` metadata,
separate from the plain/encrypted visual content: `session` (with the original
Session id), `user`, `plugin`, or `unknown`. Only verified transport provenance
can establish a Session creator; caller-authored JSON cannot claim it. Updates
retain the creation fact, including resumed callers of the same Session.
Historical raw records are `unknown`, never inferred from their next editor.
Public reads unwrap the same stored envelope, and fork copies acquire truthful
child creation attribution through the ordinary writer rather than inheriting
the parent's creator. This uses the existing System Record JSON slot, not a
second attribution store or schema migration.

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

`GET /v1/machines` excludes revoked Machines server-side, including owned
Machines; unrevoked offline Machines remain discoverable. History readers opt
into `?includeRevoked=true` to retain owned predecessor rows needed for Session
replacement resolution; revoked nonowned rows remain concealed. UI Machine sync
and the CLI replacement-identity reader use that opt-in, so history sync retains
its existing full inventory rather than receiving the ordinary discovery subset.
Exact owner reads retain revoked rows. Managed Machine listing explicitly
includes revoked owned controllers so retained resources, cleanup, and archived
history remain visible.

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

### Project Sources (0.3 development)

These metadata-only endpoints describe development source, not released
availability. They share the strict request/result schemas in
`packages/protocol/src/projects/sources/projectSourceV1.ts`. Authentication at
the containing HTTP Home supplies the actor; `serverId` is a client address,
not a claim of Account or Home authority.

| Method | Path | Request |
| --- | --- | --- |
| GET | `/v1/projects/sources` | `serverId`, optional `query`, JSON-encoded `audience` PrincipalRef, `cursor`, and positive `limit` query parameters |
| GET | `/v1/projects/sources/:id` | `serverId` query parameter |
| POST | `/v1/projects/sources` | `{serverId,requestKey,name,repository,defaultRef?,subdir?,audience?}` |
| PATCH | `/v1/projects/sources/:id` | `{serverId,sourceId,expectedRevision,patch}` |
| DELETE | `/v1/projects/sources/:id` | `{serverId,sourceId,expectedRevision}` |

PATCH and DELETE require body `sourceId` to equal the path id. Source metadata
uses PATCH for its revision-checked update; unknown fields are rejected.
Repository selection is credential-free SCM metadata, not executable clone
input. `defaultRef:null` or `subdir:null` in a patch clears that field.

The safe, Machine-placed `scm.hostingRepository.resolveAddress` Action accepts
`{address}` with the existing Machine target selector in the Action context.
It uses that Machine's SCM hosting registry and configured Connected Account
deployment bases, without requiring a checkout or probing repository access.
Its strict result is `{success:true,kind:'resolved',selector}` or a typed
`unknown`, `unsupported` or `invalid` classification. The selector is credential-free;
transport credentials, query strings and fragments are refused. The Sources
editor resolves changed addresses on a reachable Machine of the containing Home;
without one, saving that address is disabled. Unchanged retained selectors remain
editable without resolving them again. This is a 0.3 development Action, not a
claim of released availability.

The development `scm.hostingRepository.get` Action observes repository visibility
through that same Machine's hosting contribution and Connected Account boundary.
It requires an explicit Machine but no checkout. Only an observed public result
contains the repository's label and credential-free HTTPS link; private, unknown,
unsupported and failed results disclose neither. A caller's retained selector or
claimed visibility does not authorize a public project link. Older hosts without
this operation remain unavailable rather than substituting a clone or URL guess.

The Sources controller owns the editable creation draft (name, address,
default ref, contained subdirectory and audience). It combines these fields with
the resolved selector at strict Source Action admission; component-local address
parsing or a second creation draft does not determine repository identity.

Create uses one `requestKey` per intent through the incumbent actor-scoped
RepeatKey owner and its retention. An exact replay returns current admitted
metadata; a changed payload or unavailable recorded Source conflicts instead
of creating a second row. This is not an unbounded replay guarantee.

The `patch.attachment` intent attaches one purpose-tagged context entry or
dashboard ref, detaches one context `attachmentId` or exact qualified dashboard
`ref`, reorders one context entry before `beforeId` (or the end with `null`),
or sets/clears one entry's `maxChars`. It never replaces the whole attachment
list. New context attachments require `system_append`; retained placements and
unrelated entries are preserved. Qualified foreign refs are not resolved
against same-id local Artifacts. Canonical client Artifact admission owns their
current read/kind check; local refs also use the server Artifact access owner.
Neither attaching nor Source visibility grants Artifact rights.

List success is `{ok:true,sources,coverage:{complete,nextCursor}}`, with search
and paging over currently authorized metadata. Read/create/update success is
`{ok:true,source,canManage}`; delete acknowledges
`{ok:true,sourceId,revision}`. Reads use current Account, effective Team/Group
membership and qualified Team authentication. Only the creator or current
Team administration manages the Source; Home governance does not supply
content access.

Failures use `{ok:false,error,current?}`: HTTP 400 for `source_invalid` or
`artifact_wrong_kind`, 403 for `source_access_denied`, 404 for
`source_unavailable`, 409 for `source_conflict`, and 503 for
`artifact_unavailable` or `source_backend_unavailable`. An admitted stale
revision returns the current Source for comparison; inaccessible metadata is
not included. Content-free AccountChange invalidation reuses the existing
change stream. Delete removes metadata only, retaining checkout files,
Artifact bytes and grants. See the
[Source storage disclosure](encryption.md#project-source-metadata-03-development).

### Artifacts
- In 0.3 development, the admitted Artifact read projection carries optional
  nullable `ownerDisplayName`. The existing owner Account join and neutral
  display-label resolver supply it; this is presentation beside an authorized
  resource, not authorship asserted by its content. No profile request or
  inventory scan is needed. Older or unnamed projections remain unknown.
- In 0.3 development, `GET /v1/artifacts?kind=skill`
  (accepted kinds are owned by Protocol's `artifacts/artifactKindV1.ts`) returns
  `{items: [...], hasUnclassified: boolean}` with the same authorized header
  projection and paging as the unfiltered list. Exact selection uses
  `kinds=<URL-encoded JSON string array>`, for example the set
  `["account_notice.v1","usage_notice.v1"]`, and the same filtered envelope.
  Selection occurs before pagination; no title, name or content filter is sent.
  `hasUnclassified` covers accessible null-kind rows for coarse selection and
  null/old-coarse rows for exact selection, independently of the current page.
  Page and witness share one read snapshot and final access readmission.
  Derived `coverage` is `{status:'complete',unclassifiedCount:0}` or
  `{status:'partial',unclassifiedCount:N,reason:'unclassified_legacy_rows'}`,
  counted in the current authorized inventory snapshot. Canonical classified
  absence of an exact kind is not an unknown legacy row. Coverage does not
  trigger UI or shared-reader writes. `unclassified=coarse` pages authorized null
  rows; `unclassified=true` pages authorized null/old-coarse rows, including shared
  rows. Optional `ownerAccountId` intersects authorization and scopes both rows
  and the count; the daemon supplies its own Account id. An empty exact-kind set
  returns no rows but still reports the actual scoped classification count.
  Discovery selectors cannot be combined with a coarse or exact filter. One native daemon bootstrap
  pass labels all openable owner legacy headers; the former automatic read-side
  repair was withdrawn. Only while coverage is partial may the canonical reader
  resolve legacy headers through the incumbent coarse/unclassified path; it
  stops executing when coverage is complete. Bodies remain selected-id only.
  Keyholding host results call the classification state `kindCoverage`; their
  separate string `coverage` describes actual readable completeness. A completed
  legacy fallback can therefore return `coverage:'complete'` together with
  partial `kindCoverage`, without hiding a genuinely unreadable source.
  Exact-kind HTTP pages must carry that typed `coverage` witness even when
  `hasUnclassified` is false; a missing witness is invalid, not complete empty
  membership. Already-admitted local projections use the same pure selection
  policy without manufacturing a new server-classification witness.
  An already-complete exact list needs one header query and no repair request.
  Omitting selectors preserves the array response.
  Rows expose coarse nullable `kind` and, when canonically classified,
  `kindHint` (exact string or null). Clients still validate private headers.
- `GET /v1/artifacts?limit=...&cursor=...` lists Artifact headers in
  stable `updatedAt`, `id` order. The optional opaque cursor resumes after the
  last observed row, allowing typed clients to continue through sparse pages
  without loading Artifact bodies or assuming the first page is complete.
  The development `audience=received` selector intersects the existing grant
  predicate with nonownership before paging and coverage counting.
  In 0.3 development source, each header includes its current `bodyVersion`
  and the same authenticated `publicAudience` fact as an exact read, captured
  in the authorized list snapshot; refreshing an unchanged header does not
  replace known exposure with `unknown` merely because it came from a list.
  `includeBody=true` additionally returns the stored `body` for that same authorized
  batch. The Artifact access and Account-mode
  owner applies the same content checks as an exact read; E2EE bodies remain
  opaque until the client opens them. Workflow library counts use these opened
  bodies, not persisted count metadata or per-row requests. Omitting the option
  retains the header-only response. This is not a released availability claim.
- `POST /v1/artifacts/read` is the 0.3 development selected-detail read. Its
  closed V1 input is `{artifactIds: string[]}` with unique identities. It returns
  `items` in request order: `{artifactId,ok:true,artifact,recipientCensus}` or
  `{artifactId,ok:false,error,status,retryable}`. Each successful `artifact` has the exact-read
  shape, including its authenticated public-audience fact. E2EE results include
  the current authorized recipient census; Plain results carry `null` and need
  no client keys. The read uses the existing access, Account-mode and recipient
  owners in a read-only transaction. Key holders still verify bindings and use
  the existing fenced envelope commit when preparation is needed.
  Startup publishes the complete header inventory first, then uses this read
  for missing bodies of open approvals and Account notices. Launch Profiles
  and other document bodies use their own presented or exact-reference demand.
  Missing details are skipped; other refusals and incomplete
  responses fail the refresh. Refusals retain the incumbent read classification:
  an unreadable owner detail has status 500 and remains retryable; a granted
  caller's status 409 detail refusal ends the current retry cycle. Recipient
  preparation refusals retain their existing access-API retry behavior.
  The explicit closed `{artifactIds,projection:'headers'}` request returns
  `{projection:'headers',items}` through the same access and final readmission
  owner. Successful items contain the admitted header, current body revision,
  private revision metadata and public-audience fact, with no body or recipient
  census. The separate strict response schema rejects those extra disclosures.
  Warm inventory catch-up selects only identities named by Artifact changes;
  a missing identity removes its retained row, while any other per-id refusal
  fails catch-up without advancing the persisted cursor. A lost cursor still
  requires the existing complete paged header inventory.
  For `bot_template.v1`, the Artifact kind policy limits full grant inspection
  to the owner.
  Current 0.3 client and server update together;
  this is not a released or mixed-component availability claim.
- `GET /v1/artifacts/:id`, authenticated lists and selected-detail reads return the same
  `publicAudience` fact in 0.3 development source: `retained` when the Artifact has an unexpired,
  undeleted public publication, otherwise `none`. This fact is independent of
  `sharing.public` availability; disabling public-share routes does not make a
  retained publication private. Exhausting its viewer-admission use limit does
  not end that publication. Missing or unavailable audience evidence must not
  be interpreted as `none`. Protocol, UI and CLI read projections normalize a
  missing or unfamiliar value to `unknown`; shared-content and approval admission
  consume this exact-read fact rather than the feature-gated public-link list.
  This is not a released availability claim.
- `POST /v1/artifacts`
- `POST /v1/artifacts/:id` (versioned update)
- `DELETE /v1/artifacts/:id`

The development kind-filtering extension accepts optional `kind` on
Artifact JSON create/update and restore writes (`artifactKind` in the framed binary
upload metadata, whose `kind` already identifies create/update). Writers use
Protocol's `tryDeriveArtifactStoredKindV1` to encode the existing family and exact
header type as `v1:<coarse>:<exact-or-empty>`. Daemon writers negotiate
`artifacts.queryHints`; unsupported servers receive ordinary content without the
optional hint. The existing MySQL column's 191-codepoint boundary applies only
to the optional hint: an unrepresentable private type string omits that hint,
without rejecting or truncating private content. Explicit malformed wire hints
remain invalid. Older
coarse/absent-hint writers remain valid; an opaque header write without kind
clears the previous hint. The existing update
route also accepts `{kind, expectedHeaderVersion}` alone for owner backfill.
It requires header-edit authority and the current header version, and changes no
header/body bytes, content versions, recency timestamp or Artifact row sequence.
Required AccountChange/discovery invalidations remain. The same owner also accepts
`POST /v1/artifacts/query-hints/batch` with
`{items:[{artifactId,kind,expectedHeaderVersion}]}`. It returns ordered
`{items:[{artifactId,success:true}|{artifactId,success:false,error:string}]}`;
failure projections contain no private conflicting header/body. Each item uses
the incumbent independent update transaction, access, mode and CAS, not a new
cross-Artifact transaction. Existing HTTP-byte limits frame batches; there is no
new item-count cap. The two-segment route preserves retained arbitrary Artifact
ids at the existing single-id update route. Hint-only admission, conflict handling and
recipient projection do not select/open body bytes. Equal hints are no-ops.
These changes are development-only: they reuse the existing kind column/index
and add no schema migration. The daemon requires the canonical server enabled
bit `artifacts.queryHints` before new hint writes; missing/malformed support is
typed `unsupported`. It gathers write items across explicitly paged headers and
frames them by the existing HTTP-byte boundary, not the read page size. A batch
failure settles for that bootstrap; it does not retry on reads or timers. The
next attempt is the next bootstrap. Load the matching server before changed
clients; general older-Home compatibility is not implied by this operation gate.

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

Fragment publication also requires an HTTPS `HAPPIER_PUBLIC_SERVER_URL`,
`HAPPIER_FEATURE_LOCAL_SERVICES_PREVIEW__HOST_ORIGIN_DOMAIN` with wildcard DNS/TLS
and ingress to this server, and a usable
`HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__RATE_LIMIT_CHECKER=fixed_window`
with positive `...__RATE_LIMIT_MAX_REQUESTS` and `...__RATE_LIMIT_WINDOW_MS`.
`storedContentPublicShare.ts` enforces these through the shared isolated-origin
and rate-limit owners before writing. An unavailable origin or limiter returns
503 `public_share_isolation_unavailable`; enabling `sharing.public` alone does
not provision them. The deployment operator owns that configuration, including
QA-stack ingress. Neither the API origin nor another resource's origin is a
fallback. These stored-content links do not require enabling public local-service
exposure or its audit/lifetime policy.

- `POST /v1/public-shares` takes `{subject:{kind:'session'|'artifact',id},lookupId,keyDerivation:'fragment_v1',encryptedDataKey?,expiresAt?,maxUses?,isConsentRequired?,networkOff?}`.
- `GET /v1/public-shares?subjectKind=...&subjectId=...` lists the authorized subject's safe publication settings.
- `DELETE /v1/public-shares/:shareId` revokes the publication.
- `GET /v1/public-shares/:shareId/access-log` returns owner-authorized visit records.
- `GET /v1/public-shares/:lookupId/content` reads admitted stored content without Account credentials on the publication's isolated origin. Consent and Session pagination use the existing publication-use/access-grant policy.
- `GET /v1/public-shares/:lookupId/visual/:messageId?referenceIndex=0` lazily reads one member of an admitted message's authenticated visual association collection. The nonnegative index defaults to zero; it selects only an already-admitted member, never a caller-supplied item id. The route requires the existing `x-public-share-messages-access-token` and rechecks consent and the current transcript cutoff. It neither consumes another viewing use nor logs another visit. Expiry, revocation, mode mismatch, a missing member, and a deleted/recreated record refuse the read.
- `GET /s/:lookupId` serves the isolated viewer, including paged Session text and visible acknowledged visuals; its wrapping secret is carried in `#k=...`, not in an HTTP field.
- `GET /v2/sessions/metadata-upgrades` returns authenticated owner-only Session ids needing the existing privacy-layout upgrade, including archived shared Sessions; it returns no metadata or key material.

Unavailable public landings retain HTTP 404 (or 429 for rate limiting) and serve
the same viewer shell so it can render its typed recovery state. The generic
`GET /s/:lookupId/viewer.js` asset contains no subject content and remains
loadable after expiry, viewing-limit exhaustion or revocation. Content reads
still enforce publication admission and isolated-origin checks; credential-bearing
viewer requests remain refused.

The Session share's `networkOff` setting defaults to false and does not rewrite
its visual records. The shared Action transport omits the default false field;
a requested true policy must be acknowledged as true before either trusted host
returns successful link issuance. A 2xx response that omits that promise is
reported through the existing `outcome_unknown` contract. The confirmation
explains that network-enabled visuals can
send their contents elsewhere, reveal a viewer's IP address, and load changing
remote code or assets. Public HTML consumes the shared bundle/document owner and
the visual's stored effective policy: no network, exact HTTPS origins, or open
HTTPS. The guest policy covers fetch and remote script, style, font, image and
media assets; the isolated outer shell permits that policy without making the
guest same-origin with Happier. A missing or malformed policy never implies open
network, and `networkOff: true` narrows the viewer to none without rewriting the
saved item.

In 0.3 development source, the Account setting `agentHtmlNetworkPolicy`
("Network for agent HTML", `allowed | ask | off`) is declared through the existing
`settings.get/set` owner and defaults to `allowed`. For caller-authored HTML
created in its caller's own Session,
allowed admits the declared network, ask requires creation approval, and off
stores no network and returns the typed `agent_html_network_off` notice when a
requested network was removed. Existing-item network changes default to approval
through the canonical Actions policy, honoring explicit per-Action user choices;
changing the Account preference does not rewrite an existing item's effective
policy. The existing Action approval owner also checks immutable host-proved
creator facts: unknown or foreign edits do not receive the own-created exception.
Installed-plugin widgets retain their manifest/grant admission when no instance
override is declared; an explicit override can only narrow that ceiling. Switching
an existing item between inherited and explicit policy also defaults to approval.
Guest Actions and Resources retain per-request admission; replay has no separate
device-local executable-consent decision. Anonymous live widgets without a usable viewer
connection report their unavailability rather than using author credentials.
Imported visual acknowledgements without a child copy show a not-copied state
only when validated fork provenance and the canonical completed acknowledgement
correspond; the placeholder grants no content read. Offscreen visual bodies are
disposed and withdrawn reads cannot mount after visibility demand ends.
These are development-source contracts, not completed loaded-runtime validation.

One native message can acknowledge several visuals without splitting or rewriting
that message. Its existing `surfaceItemReference` JSON field now carries
`{v:1,references:[...]}`. Each current member names the owned item/revision and
the exact original acknowledgement's address, item id and revision. The original
identity is correspondence only: an imported child share still reads only the
child's admitted records. The Protocol read adapter accepts the earlier singleton
without inventing original identity; an originless inherited singleton cannot
prove which parent acknowledgement it represents.
An explicit historical-import retry for an unsettled fork can add newly admitted
members to that same native row through the existing Message revision check.
It preserves the row's content, identity and sequence; an older retry omitting
the association does not erase previously admitted members.

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

In 0.3 development source, `POST /v2/usage-events` publishes numeric accounting
observations and `POST /v2/usage/query` reads the Account's canonical accounting
projection. `usageQueryService` reconciles subject counters and witnessed
inference identity before period, model, source or dimension filters. Pre-range
counters provide baselines, not period activity. Final counters supply only
unattributed residual usage; they do not move earlier inferences to the final
model or date. An unexplained counter reset preserves earlier spend and marks
coverage partial. Account authentication and owned Session checks apply at the
route boundary. Native observations instead carry a strict `subject` with an owned
registered Machine, qualified Agent, opaque source-root and native-session keys,
without creating a Happier Session. The same ingest/write owner verifies any
claimed Session link against admitted runtime evidence. Native publication never
falls back to a legacy Session usage report on an unsupported server.
Numeric accounting remains queryable for E2EE Sessions under
the approved usage disclosure contract, without exposing transcript content.

`POST /v2/usage-events/delete-native-history` deletes only the authenticated
Account's native captures for the owned Machine and opaque source-root key,
optionally within inclusive `startMs`/`endMs` bounds. Runtime captures and other
source roots remain intact; it is not vendor-log cleanup.

Native ingest and deletion reuse the Account-scoped `usage` ephemeral wake with
`id: null` because no Happier Session exists. Session wakes retain string IDs.
These notifications invalidate the captured Home/Account query; their numeric
payload is not a second accounting projection. Older Session-only readers may
ignore the native wake; unchanged Session notifications remain compatible.

Optional `coverage`, `costFacts` and `contributions` extend the existing response
in place. Missing coverage means unknown, not a complete zero. Producer evidence
supplies path status and history completeness; ranked projections disclose
truncation. Original `tokens` preserve vendor counters and `tokens.total` remains
the conservation basis. Optional `tokenCategories` supplies nonoverlapping chart
categories only when overlap semantics are known. Cached input and reasoning
subsets must not be added again to inclusive input/output counters.

Cost facts keep reported, estimated, API-equivalent and invoice amounts separate
by currency and source. Unpriced tokens carry null money, not a fabricated zero.
Repricing preserves each contribution's witnessed event count. Older contributions
without that count retain the single-event fallback but cannot claim complete cost facts.
`costPresentation` is omitted when the selected population has no single honest
monetary basis. API-equivalent pricing is not paid spend; allowance state and
live context-window state are separate domains, not accounting totals.

Development model-price reads use authenticated `GET /v1/account/usage/prices`;
explicit refresh uses `POST /v1/account/usage/prices/refresh` with an empty
object. Both return the standard public LiteLLM catalog with source revision,
as-of time, bundled/fetched/cached origin and ready/disabled/error status.
The server's `HAPPIER_USAGE_MODEL_PRICE_FETCH_ENABLED` configuration can disable
outward fetching; bundled prices are used while the cached catalog is retained
for re-enable. Queries use the
current catalog without fetching. Account settings overrides are applied only
by the authorized client/CLI composition, not opened by an E2EE server.

The supported 0.2 reader direction retains `/v1/usage/query`'s seconds-based
hour/day transport and `/v2/usage-reports`'s cumulative report transport. These
are adapters to the same 0.3 query/ledger owner, not separate accounting
policies. Retained pre-bridge reports remain readable with unknown historical
coverage; the first changed report preserves its prior baseline in the existing
ledger before appending the new delta. An owned Session with native accounting
uses the canonical native population instead of adding its legacy bridge again.

### Memory decision writes (0.3 development)

Semantic memory decision writes use `memory.decision.save` through the existing
Action executor. Source-bearing Artifact writes use
`POST /v1/artifacts/memory-decision/create` and
`POST /v1/artifacts/:id/memory-decision`, with required strict
`memoryDecisionSource: CoordinationMessageRefV1` independently of the opaque
body. Both routes delegate to the existing Artifact write owner. Older Homes
without these operations return explicit unsupported; clients never retry the
ordinary create/update route with authority metadata that an old parser could
discard. Source-bearing blob uploads and ordinary socket updates are unsupported;
semantic decision writes use these HTTP operations. Unmarked Artifact operations
are unchanged. The server rechecks exact committed Session or Discussion source read
access (including a Discussion message's Doc source) and the destination audience
in the same authorized write path. Refusals use
`memory_decision_source_unavailable`, `memory_decision_source_unsupported` or
`memory_decision_disclosure_denied`, without committing the memory mutation.
See [Memory documents](actions.md#memory-documents-03-development) for duplicate
choice, provenance and revision semantics.

### Daemon memory search (0.3 development)

The existing `daemon.memory.search` machine RPC consumes
`MemorySearchQueryV1` and returns `MemorySearchResultV1`; the same schema backs
the `memory.search` Action. Its optional `corpora` selects `sessions`,
`documents`, or both. Omission for global/Session scope retains the legacy transcript-only semantics and
untagged Session hits with sequence ranges. Explicit document queries require a
document-capable daemon path; Home transcript search remains a separate source.

The qualified `scope: {type: 'project', projectRef: {serverId, projectKey}}`
arm requires the selected daemon's explicit `projectSearchSupported: true`
status capability. Missing support returns `memory_project_scope_unsupported`
without sending a broader query. The daemon reads current Project/Source context
independently of Sessions and uses the canonical Project matcher for authenticated
Session membership. Both indexes apply eligibility before ranking, limit and
pagination. Account/Profile attachments do not become Project attachments.
For Project scope only, omitted `corpora` selects documents and Sessions.
Results include `project: {state: 'ready' | 'partial' | 'unavailable'}`;
unreadable membership and native history lacking a Project witness are excluded
and cannot establish complete coverage. Home transcript search rejects Project
scope, while existing global/Session requests keep their contracts.

The implemented document-hit schema uses `type: 'artifact'`,
`ref: {kind: 'doc', serverId, artifactId}`,
`revision: {headerVersion, bodyVersion}`, `summary` and `score`. Their `location`
is `facts`, `archive`, `document`, or `{type: 'topic', title}`; an optional `factId`
identifies a fact. They carry no Session sequence range. Navigation must use the
qualified library reader rather than the transcript-window RPC. Deep indexing
stores the complete memory body, including topic-only and expired facts, without
changing the prompt's index budget.

The result schema permits `documents: {state}` with `ready`, `partial`, `pending`
or `unavailable`. Old responses remain valid without this field; omission means
document coverage is unknown/unavailable to the requesting client, not complete
with zero matches. The memory worker consumes the canonical prompt-stack admitted
inventory and qualified Artifact reader. Deep document queries refresh attachment
context and requalify read access and header/body revision before selecting cached
text. Incomplete context returns pending/unavailable coverage without cached
document hits; only a complete global inventory prunes detached projections.
Light search reports document coverage unavailable. No unqualified document counts
are exposed in memory status. UI and authenticated CLI consumers negotiate
document support with the exact daemon through one shared corpus policy;
unsupported mixed queries retain Session matches with unavailable document
coverage, while unsupported document-only queries return no matches. Credentialless
Session-bound MCP retains only its own Session transcript matches and filters
document hits, with no document authority and unavailable document coverage.
Document-only requests at that boundary return no matches before transport.
Cancellation stays on the existing
Action/RPC path.

Native transcript search additionally uses the `external_transcripts` corpus.
`daemon.memory.status.sources` optionally reports `ready`, `indexing`,
`disabled` or `error` for each configured native Agent/source key and Happier
Session. This read projection comes from the existing Memory worker; missing
entries or an older response without it do not establish native index freshness.
`daemon.memory.get_window` and `memory.get_window` share the native/Session
request union. Native requests use `{source, sourceItemId, cursor?}` and return
`externalSnippets`; Session requests retain `{sessionId, seqFrom, seqTo}`.
The two locator shapes are mutually exclusive. Native access requires the
authenticated exact machine/Home/Account path, not Session-bound MCP authority.

New machine settings enable deep keyword indexing by default without model API
credentials or embeddings. The independent `hints.enabled` schema field defaults
false and is enforced by the worker. Selecting hints enables summarization without
changing a deep indexing choice. Explicit disabled settings and
retained indexing choices keep their intent. Plain Accounts remain keyless for
Account content; E2EE requires its real material. These statements describe 0.3
development, not released availability.

### Authoring memory (0.3 development)

Remembered session-authoring and Project navigation state uses reserved Account KV rows, rather than
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

Keys are `recentMachinePaths`, `lastUsedProfile`,
`engineSelection:<canonicalScope>`, and qualified Project recency
`projectLastOpened:<encodeURIComponent(serverId)>:<encodeURIComponent(projectKey)>`.
The latter uses a finite nonnegative timestamp and the same Account memory cipher,
CAS and change hints; it never advances structural Project/ref revisions.
Personal saved-Workflow placement uses
`workflowProject:<encodeURIComponent(definitionId)>` with the canonical
`{machineId,directory,workspaceRefId?}` target. Explicit Save writes this Account's
target through the same row owner; reopening the definition restores it ahead of
recent Session context. Clearing a retained target writes a tombstone. Shared
Workflow definitions remain portable, and each recipient keeps their own target.
The authoring selection owner normalizes scope
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

In 0.3 development source, `POST /v1/auth/external/:provider/token-exchange` accepts `{ accessToken }` for an explicitly allowlisted deployment-configured OIDC client. The provider validates the complete bearer at UserInfo and binds its configured subject claim. The route signs into an existing linked plain Account only, follows the request Home environment, effective keyless login policy, current provider runtime, Account encryption currentness and login eligibility, and issues the ordinary Account credential with provider authentication evidence. It creates no Account or content key. See [OIDC auth](../apps/docs/content/docs/self-hosting/auth-oidc.mdx#token-exchange-for-headless-machines).

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

### Doc proposal decisions (0.3 development)

The public `doc.read` Action returns the currently authorized prose Artifact and
full revision; an optional revision must match current content. Its open-comment
count traverses the existing `discussion.list` with `state: 'active'` and
`anchorDocArtifactId`. Only this scoped list includes the immutable `firstMessage`
projection, using exact-read source admission and the existing resource codec;
its latest-content envelope is omitted. Known inaccessible roots do not count;
missing, corrupt or failed count evidence produces `null`, not a partial count.
Archive closes a thread, but a proposal decision does not. Neither this read nor
the count marks a Discussion read or repairs recipient keys.
`doc.comment.reply` posts a passage comment or replies to its
committed root; `doc.edit.propose` posts before/after/reason at a full base revision
without editing the Artifact. Both use the existing Discussion create/post/reply
operations and content codec. Plaintext passage routing contains only Doc ref and
revision; quote and proposal text belong to the content envelope.

These three Actions are also available through the existing Voice Action binding.
Voice reads use the same source admission, and comments and proposals retain
their exact passage and edit fields through the normal approval preview and
execution path. Accept and Decline remain unavailable to Voice and require the
authenticated person.

`POST /v1/artifacts/doc-edit-proposals/accept` accepts the qualified proposal
reference, full expected Doc revision and optional host-prepared body encoded
with the existing Artifact codec. `POST /v1/artifacts/doc-edit-proposals/decline`
accepts only the proposal reference. These are authenticated present-person
routes, not an Agent or generic Artifact update alias. Both return the proposal
reference and actual settled disposition; acceptance includes the accepted full
revision. Current grants and key availability are checked even on settled
retries. Body CAS and disposition settle in one existing transaction; conflict
does not partially apply either. Public Action inputs do not expose the internal
prepared-body packet. See [encryption.md](encryption.md) for the sealed payload
boundary. This is unreleased development behavior.

### Requester confirmation and readiness (0.3 development)

Approval `requesterConfirmation` binds the immutable request, requester Account,
admitting Bot Session, execution Account and Action/input digest. The existing
Session decision transport supplies the authenticated deciding person; the
original executor checks current entitlement and executes with its own binding.
Reading the preview is not a decision proof. Require/Waive settings change
confirmation policy, not actor authority or execution credentials. See
[request attribution and readiness](actions.md#request-attribution-and-readiness-03-development).

`session.status.get` accepts `{sessionId,readiness:true}`. The optional `readiness`
result distinguishes saved configuration from `ready`, `unavailable` and `unknown`,
with operation, Machine/Agent evidence, invocation access and cause. Omitted
`operation` means conversation, with credential `not_required`. Requesting
`operation:'credential'` and a qualified `credentialPurpose` reads the existing
personal purpose binding. A Team operation also supplies the existing qualified
`credentialTeamSelection` from its setup owner; the purpose, service and resource
binding are checked against the current declaration and entitled catalog.
Unavailable resources retain the owner's diagnostic and recovery facts. Missing or
inaccessible binding evidence stays unknown, including another Account's private
setup; the viewer's credentials cannot stand in for it. A result without the
requested readiness is not evidence of readiness. This diagnostic performs no
sign-in/repair and grants no outward-write authority. These are development
contracts; the corresponding bylines and People/Bot presentation are still being
integrated.

## Implementation references
- API routes: `apps/server/sources/app/api/routes`
- Auth module: `apps/server/sources/app/auth/auth.ts`
