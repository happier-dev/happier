# Peer mediation

How Happier decides whether bytes between a device and a machine travel directly or through the
server, and who owns each step. This page is the internal counterpart to the operator guide at
`apps/docs/content/docs/self-hosting/local-service-previews.mdx`.

**Status of this page.** The Iroh Home and machine-carrier contracts were refreshed against the
current 0.3 development source on 2026-09-23. The TCP lifecycle, preview HTTP/WebSocket
transport and signing-readiness contracts below were refreshed against 0.3 development
source on 2026-10-01. Other peer-mediation claims were checked on 2026-08-23.
Where the `PMS-1 … PMS-9` specification packets
(`.project/plans/runtime-unification-v2/stages/stage-A/`) describe behaviour the code does not
implement, this page documents the code and says so. The packets are the design authority; they are
not evidence that anything runs.

Citations name a **file and a symbol**, not a line number. This corridor is under active change and
line-anchored citations in an earlier revision of this page were stale within hours; a symbol
survives the next refactor and a wrong one is caught by a search that returns nothing.

## Home connectivity over Iroh

Native clients and daemons may reach a loopback-only Personal Home through
`happier/home-tunnel/1`. The Home process owns one persistent Iroh endpoint and a fixed loopback
HTTP/Socket.IO destination. The client-side lifecycle publishes an ephemeral `runtimeOrigin` only
after the ordinary Home identity and authenticated ping probes succeed; the canonical Home URL
continues to own credential scope, auth audience, profile identity, and reachability identity.

The public `/v1/features` projection publishes the current Home Iroh descriptor without private
direct-address hints. After Home authentication, `/v1/features/authenticated` returns the exact
descriptor, including trusted direct hints and explicit higher-revision endpoint retirement. CLI
authentication fetches that exact projection before persisting the profile, and the daemon uses the
same authenticated snapshot for refresh. The existing profile owner reconciles newer observations
and rejects an identity mismatch or equal-revision conflict instead of creating a second descriptor
authority. The server persists one outer `{ revision, contentKey }` continuity fact so an
Iroh-to-HTTPS-only transition cannot regress across restart.

Daemon startup also records this authenticated observation for a saved profile with
no descriptor or only advisory authority. The canonical CLI profile owner supplies
the exact binding before target-qualified operations are exposed, independent of
how the credential was provisioned. A public fallback cannot establish that binding;
older URL-only Homes retain standard networking while exact-target operations stay
unavailable.

In 0.3 development, the canonical server publisher
`homeConnectionDescriptorPublication.ts#httpsEndpointFromIngress` publishes an explicit
ingress as a `kind: 'https'` endpoint when it uses HTTPS or loopback HTTP. The Protocol
`HomeApplicationOriginV1Schema` and shared `isLoopbackHostname` own endpoint validation
and loopback classification. LAN/public HTTP and URLs with credentials, queries, or
fragments are rejected. Canonical identity alone never supplies an ingress endpoint.
Loopback HTTP is a same-computer route without TLS confidentiality; it does not establish
cross-device reachability. CLI first-contact trust still requires its exact selected
HTTPS/loopback origin, and public projection never supplies exact descriptor authority.

Transport selection defaults to automatic. The 0.3 client-local Standard-only setting in the UI,
or `HAPPIER_HOME_CARRIER_POLICY=standard_only` in the CLI/daemon process environment, prevents
new Home and finite Machine Iroh acquisitions; descriptor-declared HTTPS remains usable, as do
independently eligible current Standard Machine RPC routes. The mandatory `machine/1` prepared
finite-transfer path has no Standard carrier and is unavailable in this mode; it does not probe an
older daemon or switch to `legacy_machine_rpc`. An Iroh-only Home or Machine with no Standard route
is likewise unavailable. The setting does not change the Home server's published descriptor and
does not cancel a finite transfer already in progress. On the UI, focused Home recovery reselects
and releases its prior Iroh Home carrier. The managed daemon service installer persists an explicit
mode on macOS, Linux, and Windows, and same-owner updates and repair retain it. This
application-carrier decision is distinct from
`HAPPIER_IROH_RELAY_POLICY=disabled`, which still permits direct Iroh contact. Direct-versus-relay
path facts remain native diagnostics and do
not rebuild Home HTTP/Socket.IO clients or appear in routine connection labels. Standard HTTPS
remains available where independently trusted; identity, authentication, integrity, ALPN, preamble,
and stale-target failures remain fail-closed.

The native carrier is active in the current 0.3 development source for Home and Machine traffic.
Its single applied policy is `automatic` or `disabled`: `automatic` uses only the explicitly
configured relay set while allowing Iroh to select direct or relayed reachability, and `disabled`
contacts no relay. The dialer always authenticates the remote peer as the exact EndpointId selected
from the descriptor. Relay URLs and direct-address hints only help reach that endpoint; neither can
stand in for its authenticated identity. Diagnostics may describe a proven native path as `Direct`
or `Secure relay`, while an unproven path stays `unknown`.

Browser Iroh carries **Home HTTP, Socket.IO, and finite Machine transfers in the current development
source**. Finite transfers use `happier/machine/1`, the canonical signed route grant, and no ordinary
user-socket fallback; the production direct-import/direct-export path passed in loaded Chromium
against the stock local relay and real Machine acceptor on 2026-09-03. That current-source result is
not stable/preview availability, multi-browser evidence, target certification, or Lane 09
certification. Browser Mutagen/workspace sync remains excluded. A browser cannot bind the native
loopback listener, so its carrier is *semantic* rather than URL-addressed: no
`runtimeOrigin` exists or is invented for it, and the canonical Home URL keeps describing identity,
auth audience, reachability scope, and logging. The resolved transport therefore names either a
runtime origin (independent HTTPS, or the loopback origin a native lease binds) or a Home carrier
that moves the bytes itself — never both.

In unreleased 0.3 development source, finite workspace Action drivers share
`packages/sync-client/src/machines/finiteTransferHandshake.ts` for the existing
authenticated Account/client grant, ephemeral proof and exact target recheck.
The headless CLI uses the native ephemeral endpoint contract; it does not reuse
the daemon's persistent Machine endpoint identity. Both still use the prepared
`happier/machine/1` carrier and its existing transfer capabilities. Preparation
or export resource release is not proof of successful destination completion.

When the client-local policy permits Iroh, selection is automatic and narrow. The browser carrier is chosen only on a plain browser host
(never Tauri or Electron, which run the same bundle but keep the native direct-or-relay carrier),
and only when the canonical Home descriptor names an exact EndpointId plus at least one explicitly
configured relay and a Home-scoped credential exists. The canonical owners are unchanged:
`apps/ui/sources/sync/runtime/orchestration/serverScopedRpc/resolveServerScopedTransport.ts` and the
focused-Home switch in `connectionManager.ts` resolve the carrier;
`apps/ui/sources/sync/http/client.ts` keeps auth, compatibility, credential invalidation, generation
checks, timeouts, reachability, and error classification, handing the carrier only a composed
request; Engine.IO/Socket.IO keeps lifecycle, authentication, reconnect, and event de-duplication and
merely receives a different underlying socket. An absolute cross-origin URL never uses the carrier,
so a Home bearer cannot leave its Home. The wasm/worker path is loaded lazily behind one dynamic
import, so HTTPS-only public use does not pay for it, and an architecture guard pins the exact
approved consumers.

The browser HTTP parser uses the worker's existing per-operation byte budget
for stream reads and the single request-head write. That operation boundary is
not an aggregate response-header, line or trailer quota: a valid response head
may span several reads. Framing errors still fail explicitly; unsupported
64 KiB/1 MiB aggregate response quotas are not imposed. Retained response data
and parsed `Headers` remain subject to the browser's actual allocation limits.

Browser Iroh is relay-only: its UI says `Secure relay`, never `Direct`, and an unproven path stays
`unknown`. It introduces no gateway, no fake loopback origin, no JavaScript relay, no second
HTTP/Socket.IO owner, and no browser Mutagen / workspace-sync engine. Independently trusted HTTPS
ingress remains eligible before the fail-closed identity/auth boundary; after a carrier is selected
and its EndpointId proven, failure never retargets the request.

The shared managed relay is the pinned stock `iroh-relay` with forwarding and QAD enabled. It
authenticates Iroh EndpointIds and forwards opaque encrypted transport; Home authentication and V2
Machine grants remain the application authority at the endpoints. Happier does not add a shared
relay endpoint registry. A private callback is available only to a custom composition that already
owns one complete allowlist for every endpoint class it intends to carry.

Endpoint identity continuity follows the authority that depends on it. A Home endpoint is durable
first-contact descriptor authority, so lost or changed Home key material fails closed through the
canonical descriptor continuity record and requires an explicit descriptor recovery/update. A
Machine may replace wholly absent key material only by publishing its new EndpointId through its
existing authenticated Machine connection; fresh grants bind that current publication and old
grants do not migrate. A native Account client likewise receives no authority from a previous
EndpointId: every new finite-transfer grant binds its current identity. Browser identity remains
ephemeral per live SharedWorker. Corrupt, unreadable, or partially retained native key material
fails explicitly rather than being overwritten. These role-specific rules avoid a second endpoint
registry or universal pairing ledger.

Finite CLI authentication helpers borrow a Home tunnel lease from the daemon's
existing process publication only when its descriptor exactly matches. Releasing
that lease never shuts down the daemon endpoint or replaces its HTTP/Socket.IO
publication. A helper outside that matching process publication creates a fresh,
keyless Account-client endpoint through the same native session owner; it does
not reuse the Machine's persisted key across processes.

In the current 0.3 development source, the authenticated Machine capability projection carries
the current Machine EndpointId and optional bounded relay URLs and direct-address hints under
`irohMachineEndpoint`. Its server-assigned projection revision establishes currentness; the hints
only help a client reach the authenticated EndpointId. The daemon publishes these facts from its
Iroh runtime state, while a restricted Session Runner publishes them from its own native endpoint
in the same complete capability projection as its Session services. A Runner has no daemon state
for browser clients to inspect, so its relay hints must travel with that Machine projection.
Workspace openers read this same current capability authority both before grant
minting and before dialing, not the diagnostic daemon-state endpoint. A withdrawn
or replaced target is refused; current hints may be refreshed without changing
the EndpointId already bound into the signed grant.

### Workspace inspection and reviewed resolution

The 0.3 development Workspace Sync extension uses the existing authenticated Machine RPC
composition to reach the relationship's actual controller, including a request originating on
a linked spoke. The controller derives the linked set from current Account settings; each
target resolves its own WorkspaceRef and retained root authority. A reachable Machine, a cached
endpoint label, or membership in the set does not itself authorize another root read or write.

Inspection returns current entry observations and separately requested bounded previews.
Reviewed resolution captures exact approved content into file-backed, operation-owned material
and uses the existing finite peer transfer to stage it. The target still checks the executing
Action receipt and the explicit destination expectation before applying it. This adds no
preview-sized file-transfer limit, browser synchronization engine, new carrier, or server-side
conflict-content store. Private stage/apply/release operations retain their explicit classifications
in `packages/protocol/src/machines/peer/mediation/rpc/routePolicyV1.ts`; transport reachability is
not a replacement for approval or root authority.

Before starting or resuming the engine, the existing controller settles confined
entry-replacement recovery through `workspaceSyncTargetAuthority.ts`. Initial
relationship preparation keeps its durable graph disabled until commit. Settings
reconciliation retains the live definition admitted by successful
transient engine preparation; an unchanged disabled row remains restart intent,
not a request to revoke that live transaction's fences. A cold controller without
the live preparation marker still treats the disabled row as paused. Recovery
may consume that disabled definition only with the current controller's exact
retained member fence or the target's exact retained transient bootstrap and root
identity. A remote controller proves its local member custody before routing; the
receiver independently proves the selected target's custody. Even an empty
recovery journal does not waive that proof. A paused row without custody, a changed
definition or a replaced root cannot acquire recovery authority from its path.
This development-source rule neither enables the relationship nor changes
committed-READY cleanup into rollback.

## 1. The model

Every mediated session is a **flow kind** (what the bytes mean) crossed with a **route kind** (how
they physically travel).

| Axis | Members | Declared at |
| --- | --- | --- |
| Flow kind | `bounded_transfer`, `tcp_tunnel`, `live_stream`, `machine_rpc`, `voice_media` | `packages/protocol/src/machines/peer/mediation/**` |
| Route kind | `loopback_direct`, `lan_direct`, `tailscale_serve_direct`, `server_relay`, `iroh_peer` | same |

The five moving parts and their canonical owners:

| Part | Owner |
| --- | --- |
| Route decision (pure fold of feature bits, account preferences, daemon policy, grant state → a route or a typed refusal) | `packages/peer-mediation/src/route/**`, `.../flows/**` |
| Route grants (Ed25519, bound to account + machine + flow + route + destination + expiry) | `packages/protocol/src/machines/peer/mediation/**`; minted at `apps/server/sources/app/machines/peer/mediation/**` |
| `iroh_peer` machine/1 grant binding | `IrohPeerInitiatorV2Schema`, `IrohPeerTargetV2Schema`, and `SignedDirectRouteGrantV2Schema` in `packages/protocol/src/machines/peer/mediation/directRouteGrantV2.ts`; minted by `mintDirectRouteGrantV2` and verified by `verifyDirectRouteGrantV2`. Finite-transfer grants bind an authenticated Account/client or Machine initiator EndpointId to one target Machine + EndpointId and the `finite_transfer` carrier purpose for a bounded lifetime; the prepared-transfer capability remains the exact operation and byte authority. Workspace-sync grants retain the signed operation identity consumed by rooted workspace ingress. The authenticated Iroh transport EndpointId and ephemeral proof are checked before fixed-target ingress. A V1 grant cannot authorize `happier/machine/1` |
| Direct transport (daemon loopback HTTP server, signed grant + ephemeral caller proof) | `apps/cli/src/daemon/peer/mediation/**`; `verifyDirectRouteGrant.ts` is the shared verification owner |
| Relay transport (framed envelopes over the existing Socket.IO connection) | `apps/server/sources/app/api/socket/peer/mediation/**` |
| Observability (retained flow aggregates and sequenced event details, with metadata redaction) | **One** engine: `createPeerMediationObservabilityFlowStore` in `packages/protocol/src/machines/peer/mediation/observability/`. The daemon and server modules named `observability/store.ts` only adapt their own call signature to it (DEC-8) — they are not second owners. Aggregates use the shared `flowSnapshotFold`, preserve original start/counters/terminal state when details are evicted, and expire when the flow leaves the existing retained-event scope. The UI keeps its own read-side store for subscriptions and selectors. |

Development 0.3 direct admission uses current V2 ephemeral proofs for machine RPC,
live-stream start and TCP/Voice tunnel opens. The old account-signed V1 direct
routes and loopback probe are not registered. The listener publishes its base URL;
current clients select their operation's route without probing an older daemon.
Readers still accept both secret and data-key credentials created by 0.2, but
those stored-data formats do not select a transport-proof version or require an
Account signing seed at daemon startup. Current native-machine handshakes,
server-relay envelopes and tunnel response/frame formats retain their own
purpose-specific versions; they are not old-component negotiation adapters.

### 1.1 Machine-RPC route policy, and the restricted Runner's authority

The `machine_rpc` flow has one extra classifier, because "may this method leave the server
path at all" is a per-method decision rather than a per-flow one.
`packages/protocol/src/machines/peer/mediation/rpc/routePolicyV1.ts` is that owner. Each
deployed method carries one row naming its **route class**:

| Route class | Meaning |
| --- | --- |
| `server_required` | Must travel the server path. The row also carries a `serverRequiredReason` — durable or transcript writes, pending-queue and sequence assignment, reconnect catch-up, cross-device fanout, auth, sharing, billing, automation, account change, destructive or recovery mutations, or simply `unclassified`. |
| `direct_ephemeral` | May go direct; nothing durable depends on it. |
| `direct_medium_risk_receipted` | May go direct, but the command receipt is not optional. |

`resolveMachineRpcRoutePolicy` **fails closed for an unknown method**: a method with no
deployed row resolves to `server_required` with reason `unclassified`, so adding an RPC method
without classifying it denies direct routing rather than inheriting a neighbour's answer.
`isMachineRpcDirectRoutePolicy` is the one predicate callers use, and the relay fallback for
`daemon_voice_audio` is declared on the row rather than negotiated per call.

The same module carries the restricted Runner's authority map, and it augments the route
policy rather than replacing it. `resolveEphemeralRunnerMachineRpcAuthority` answers which
Session capability a reusable Machine service installed in a restricted Runner needs —
`readTranscript` for reads (filesystem listing, stat, downloads, terminal stream reads, local
service inventory), `submitAgentInput` for writes (file mutation, uploads, terminal input and
lifecycle, preview open/revoke), `manageAccess` for public-preview create and revoke,
`stopSession`, and `followSourceKeyPreparation`. Two rules follow from the map's shape and are
worth stating plainly: a method **absent** from the map acquires no Runner authority at all,
and a method present in it does **not** thereby become direct — its route class still decides
that. Both the daemon ingress (`apps/cli/src/ephemeralRunner/**`) and the server socket
admission (`apps/server/sources/app/api/socket/**`) consult this single map.

The Runner's own principal is a Session-scoped credential, not a sharing relationship: it
projects as a capped `edit` recipient with no sources, and the server revalidates the
persisted activation, Session, Machine and AccessKey binding on every sensitive operation
through `verifyCurrentMaterializedRunnerPrincipalInTx`, so teardown, Machine replacement, or
AccessKey revocation takes effect without waiting for a reconnect. See
[session-collaboration.md](session-collaboration.md) for the access half.

### 1.2 Direct-route preferences and stored credentials (0.3 development)

`peerMediationPreferencesV1` is the existing Account Settings authority. Protocol exports
`PeerMediationPreferencesV1Schema`, `PeerDirectPreferenceV1Schema`, and
`DEFAULT_PEER_MEDIATION_PREFERENCES_V1` from `account/settings/peerMediationPreferencesV1.ts`.
`flows[flowKind].direct` is the Account default; `byMachineId[machineId].flows[flowKind].direct`
is its per-Machine override. Values are `inherit`, `enabled`, and `disabled`; the persisted flow
keys are `bounded_transfer`, `tcp_tunnel`, `live_stream`, and `machine_rpc`. Voice uses the TCP
tunnel preference. These are one Account document, not a second daemon-owned Settings store.
The definition is registered in Protocol's `ACCOUNT_SETTING_ARTIFACTS`; UI screens read it
through `useSetting('peerMediationPreferencesV1')` and write the existing root through the
scope-captured `useApplySettings` in `sync/store/settingsWriters.ts`.

The UI reads the exact Home/Account scope through `readAccountSettingsForScope` before RPC,
live-stream, or Voice direct admission. The canonical direct-policy fold gives explicit daemon
`false` a hard deny. When no daemon policy is specified, it selects Machine override, Account
default, and product default; a
preference never bypasses server policy or grant/security checks. The unconsumed daemon route,
flow, and global environment-policy resolver has been removed. The native finite-transfer Home
carrier retains its own existing admission owner; these preferences do not create another Iroh
admission policy.

Current RPC, live-stream, and Voice direct authentication uses ephemeral V2 proof regardless of
the credential's encryption format. Readers still accept the secret and data-key credentials
created by 0.2; that stored-data obligation does not require an older-component proof fallback
or advertised proof-version arrays. Preview snapshots likewise use only current `previews`
rows, not an older daemon's `resources` snapshot.

### 1.3 Live-stream lifecycle (0.3 development)

The direct HTTP start endpoint is not a complete live-stream carrier. It verifies signed grants,
proofs and scope, then returns `direct_stream_channel_unavailable` before starting capture or
consuming the grant. Frames, receipts, acknowledgements, control and stop must all have a connected
consumer before a direct carrier can be admitted. The current product viewer uses the server relay.
The direct refusal owner is `registerMachineLiveStreamRoutes` in
`apps/cli/src/daemon/peer/mediation/stream/registerRoutes.ts`.

The daemon relay owns capture lifetime, including pending starts. Stop or disposal closes the exact
pending stream; a capture that finishes opening afterward is stopped rather than orphaned. Signed
renewal preserves stream/source identity, viewer, codecs and admitted caps, changing only grant
expiry. An explicit maximum duration remains anchored to the original start. Idle capture also
expires when its grant expires. These decisions belong to `createMachineLiveStreamRelayTerminator`
in `apps/cli/src/daemon/peer/mediation/stream/relay.ts`, not the capture producer.
Server relay admission rechecks signed expiry after reading Account mode, before retaining stream
state. An authorization that expires during that read cannot open a stream.

Daemon browser views register `sourceKind: 'browser'` and stream family `browser.streamed` in the
same live-stream capture registry. Their exact source id is the protocol `browserViewKey` for the
Happier session and view. `daemon.browser.view.list` projects that session's current views from the
control broker, including navigation events and capture metadata only when the source is actually
registered; CDP handles stay daemon-local. Browser starts require that exact source id, and the
signed relay authorization binds it. A family-only registry lookup refuses ambiguous matches.
The shared viewer ingestion hook carries that source id through both initial admission and renewal.

`apps/cli/src/daemon/browser/capture/cdpScreencast.ts` owns one CDP screencast and one frame ACK per
view. Recording and live viewers subscribe to that producer independently: closing either consumer
does not stop the other, while closing the view retires both. Viewer tap, keyboard and swipe input
uses the existing stream control path and daemon automation/controller owner for human takeover;
it does not acquire a simulator lease. Capture acknowledgement and viewer network credit remain
separate authorities.

Receipts distinguish terminal outcomes explicitly with `terminal: true` and a `stopped` or `error`
outcome. Temporary backpressure is nonterminal. The relay owns network acknowledgement credit;
acknowledgements do not rewrite producer sequence numbers. Pause, resume and keyframe requests
reach the existing capture-producer controls. After dropping dependent H264 deltas, capture waits
for a fresh keyframe instead of forwarding an undecodable chain.

Quality ceilings are optional: omitted bitrate, frame rate, frame bytes, total bytes and duration
leave quality to the source and viewer. The server-routed switch defaults on; an explicit Home
ceiling still constrains the signed grant. `resolveMachineLiveStreamRelayCaps` in
`apps/server/sources/app/machines/peer/mediation/stream/relayCaps.ts` is the shared grant/relay fold.
Relay buffering derives its byte budget from the actual Socket.IO transport budget, including the
serialized envelope; network credit never becomes capture-producer acknowledgement authority.

Simulator input has one controller per physical source, even when several viewer streams watch it.
The existing lease manager in `apps/cli/src/daemon/devices/simulator/lease.ts` binds renewal, reads
and release to the controlling stream and holder. This does not make transport-only test evidence
proof of rendered pixels or a launched daemon/device journey.

## 2. The enablement contract

This is the part that surprises people: on a generic Home the substrate is unavailable until its
grant signer is configured. Managed Personal Homes derive that same signer from their existing
persisted master secret; they do not store or configure a second signing secret.

### 2.1 Grant signing is the master switch

`resolvePeerMediationGrantSigningConfig`
(`apps/server/sources/app/machines/peer/mediation/mintDirectRouteGrantV1.ts`) is the sole signer
owner. Complete explicit operator configuration is authoritative. If any explicit signer field is
present, the resolver parses the same four variables strictly and returns a typed refusal when the
configuration is partial or invalid:

| Variable | Absent → | Notes |
| --- | --- | --- |
| `HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_KEY_ID` | `missing_key_id` | any short label; travels with the grant so machines can select a trust root |
| `HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_PRIVATE_KEY` | `missing_private_key` | 32-byte Ed25519 seed or 64-byte secret key, strict unpadded base64url (`decodeBase64Url` / `normalizeSigningSecretKey`) |
| `HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_PUBLIC_KEY` | *(optional)* | cross-checked against the key derived from the seed; mismatch → `invalid_public_key` |
| `HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_EXPIRES_AT` | *(optional)* | epoch **milliseconds** |

When all four fields are absent and `HAPPIER_MANAGED_RELAY_PURPOSE=personal-home`, the resolver
derives a stable Ed25519 key from `HANDY_MASTER_SECRET` under the distinct
`happier.machine-route-grant.v1` domain. Backup, restore, relocation, and reinstall already preserve
that master secret, so they preserve the derived public key without another archive field. Generic
Homes, Team/shared Homes, and preview runtimes do not receive this fallback merely because they
have a master secret; they continue to require complete explicit signer configuration.

The derived key ID uses the same SHA-256-of-public-key convention as the Account Directory signer,
but the two domains produce different keys. There is no overlapping-key rotation registry: changing
the Personal Home master secret changes the derived authority, while explicit signer configuration
remains the operator-owned rotation and expiry mechanism.

An explicit signing key is usable only while its expiry is in the future. The same resolver
returns `signing_key_expired` at or after that instant; capability publication and preview
`pmsRelayReady` consume that result rather than treating configured key bytes as readiness.

Two consequences, both observable:

- `isPeerMediationGrantSigningAdvertisedForRequest`
  (`apps/server/sources/app/features/catalog/serverFeatureGate.ts`) is
  `capabilities.machines.peerMediation.grantSigningKeys.length > 0`, and
  `readPeerMediationFeatureEnv` (`catalog/readFeatureEnv.ts`) returns an empty list when signing does
  not resolve. The grant-mint route's pre-handler
  (`createPeerMediationGrantSigningGatePreHandler` in
  `apps/server/sources/app/api/routes/machines/peer/mediation/registerPeerMediationGrantRoutes.ts`)
  therefore replies **`404 {"error":"not_found"}`**.
- The local-service preview tunnel opener throws
  `local_service_preview_tunnel_unavailable:grant_signing_unavailable`
  (`createTunnelUnavailableError` in `apps/server/sources/app/local/services/preview/tunnel.ts`).
  `proxyLocalServicePreviewHttpRequest` (`preview/httpAdapter.ts`) classifies that rejection into
  the same typed failure the routes already define for a missing transport — **503**
  `{"error":"preview_transport_unavailable","reasonCode":"pms_tunnel_unavailable"}` — and logs the
  specific prerequisite (`module: local-service-preview`, `level: error`, the tunnel's own
  `reasonCode`). The error carries its reason code as a property, so no caller parses the message.
  Until 2026-08-24 the call was unwrapped and reached the global handler
  (`apps/server/sources/app/api/utils/enableErrorHandlers.ts`) as an untyped **500**
  `An unexpected error occurred` (`F-PREVIEW-1`).
- `capabilities.localServices.preview.pmsRelayReady` **includes this switch**. Before the same fix it
  did not, so a server with the two tunnel variables set and no signing key advertised a ready relay
  whose data path returned 500 on every request. An unmet signing prerequisite now reports
  `peer_mediation_grant_signing_unavailable` on both the `preview` and `publicPreview` nodes — the
  same code `resolvePeerMediationFeature` already emits for the same fact.

Machines need no configuration: the daemon takes public keys from the authenticated, last-known-good
server feature snapshot and drops expired entries. Long-lived Machine openers and target admission
resolve those roots when each operation is verified, so feature readiness and signing-key rotation
do not require rebuilding the workspace runtime (`createWorkspaceMachineCarrierTunnelOpen` and
`maybeStartPeerMediationLoopback` in `apps/cli/src/daemon/**`).

### TCP and preview transport lifetime (0.3 development)

TCP admission creates one signed mux authority, not an unused parent TCP connection.
Each child opens its own connection at the admitted destination. The shared
`createPeerTcpTunnelStreamSession` owner carries native EOF, error and close events: queued
bytes drain before directional EOF, reverse writes remain available, and both completed
halves or a reset release the child. Parent close, abort or carrier loss releases its children.
The Provider broker's consumed application stream remains a distinct, intentional parent path.

TCP tunnels live with their consumer. Grant expiry bounds admission, not the lifetime of an
already admitted tunnel. Frame/message size, concurrent admission and credit-window bounds
protect in-flight resources; elapsed idle/duration, cumulative byte and lifetime child-count
quotas are not TCP tunnel policy. Explicit budgets owned by voice or public-preview application
policy remain enforced at those application boundaries.

Speech transcription grants bind the Account, target Machine, relay socket (for relay),
application attempt and authority digest. They authorize the daemon speech application,
not an arbitrary TCP destination, so TCP destination-port allowlists do not admit or reject
speech. Direct speech follows its application/attempt lifecycle without TCP lifetime quotas.
Server-relayed speech uses the optional duration and total-byte caps advertised by the
canonical voice relay policy; configured server caps are signed even when omitted by the
request. Neither path invents an idle or duration budget when the application owner has none.
Generic TCP opens still require their signed destination and the operator's port allowlist.

Preview HTTP and WebSocket adapters use native HTTP framing over the same PMS-backed Duplex.
HTTPS targets layer native TLS over that Duplex with normal certificate and hostname verification;
there is no insecure certificate fallback. Native HTTP decodes chunked responses before forwarding
body bytes, including SSE. Private and public preview application routes each use an encapsulated
raw stream parser to preserve request bytes and methods; registration, status and revoke control
routes retain ordinary API JSON parsing in their parent scope.

Both adapters use `buildPreviewRequestHeaders` for application credentials and origin policy:
application cookies pass unless the preview explicitly drops them, while Happier authority cookies,
Authorization and caller-supplied forwarding metadata do not. Same-preview Origin/Referer values
map to the upstream authority; unrelated origins remain unchanged. Forwarded host/protocol are
rebuilt from the admitted request boundary. HTTP uses Fastify's request protocol; raw upgrades
use the TLS socket or the canonical configured server URL, not visitor forwarding headers.
Response cookie rewriting keeps cookies within the
preview origin/path and suppresses reserved Happier cookie names.

### 2.2 The relay half adds two more gates

`readMachineTunnelFeatureEnv` (`apps/server/sources/app/features/catalog/readFeatureEnv.ts`):

- `HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__ENABLED` defaults **false**.
- `HAPPIER_FEATURE_MACHINES_TUNNEL_ALLOWED_PORTS` defaults **`[]`** — `parsePortList` returns an
  empty array for an unset value, i.e. a deny-all destination list.
- `HAPPIER_FEATURE_MACHINES_TUNNEL_DIRECT_PEER__ENABLED` defaults **true** and feeds the
  `machines.tunnel.directPeer` gate (`resolveMachineTunnelFeature` in
  `apps/server/sources/app/features/machineTunnelFeature.ts`). Native private-preview admission
  uses this same direct TCP decision. The isolated server URL continues to use the relay transport
  (`apps/server/sources/app/api/routes/local/services/registerRoutes.ts` →
  `apps/server/sources/app/local/services/preview/tunnel.ts`).

Both gates are enforced when the relay authorization is minted
(`apps/server/sources/app/machines/peer/mediation/tunnel/authorization.ts`):

| Condition | Reason code |
| --- | --- |
| `serverRoutedEnabled` false | `blocked_by_server_policy` |
| destination host not loopback | `destination_host_not_allowed` |
| port not in both the scope and the server allowlist | `destination_port_not_allowed` |
| requested caps exceed server caps | `relay_cap_exceeded` |

### 2.3 Local-service preview gates

`readLocalServicesFeatureEnv` (`apps/server/sources/app/features/catalog/readFeatureEnv.ts`):
private `preview` defaults **on** (authenticated access to a Machine loopback service);
`publicPreview` defaults **off** under the real Home policy setting. There is no separate
"until review" activation condition in the current 0.3 development contract (AMD-2026-09-30).
Signing, isolated-origin DNS/TLS, audit and abuse-control prerequisites remain fail-closed.

The server preview runtime (`apps/server/sources/app/local/services/preview/runtime.ts`) is the
private access-URL authority. The daemon registers the resource through
`POST /v1/local-services/preview` and publishes the returned URL and token expiry in its preview
row. The daemon does not mint a viewer loopback URL; a remote browser or phone must never interpret
the Machine's `127.0.0.1` as its own service destination. Native clients instead bind their own
guest listener after signed Machine admission, as described below. The same registration is resolved when
creating a public exposure. Requested paths belong to the registration, not to a second launcher
URL builder.

Services and the Browser launchpad use the same Open action. A detected listener first registers
through the daemon preview lifecycle; an already registered preview also requests a fresh URL
admission on Open. Preview snapshot reads only project the current rows and never mint admissions.
A registration failure stays on its own row as a typed diagnostic, so healthy previews remain
visible and usable.

In current 0.3 development, a scoped registration without an isolated private origin is retained
with null `accessUrl`/`expiresAt` and `accessUnavailableReasonCode: preview_private_route_unavailable`.
The web Browser uses that explicit reason for its runs-elsewhere state; native viewers try the
registered direct option first. An absent URL alone does not establish the runs-elsewhere state.
Session-bound Browser previews reuse the Services public-link controls and Action
front door for consent, create, copy and revoke. Signing, malformed URL and HTTPS failures still
fail closed; a retained resource does not by itself establish public-link availability.

Private access URLs require a per-resource HTTPS origin under the configured preview domain.
Current 0.3 development registrations, including hosted plugin assets, declare `originMode: 'host'`;
the strict resource schema rejects retired path mode and the `rewrite_path_mode` policy.
The shared response-header owner keeps same-target redirects on that origin with relative
locations and scopes application cookies to its paths, without API-route prefixes.
The origin resolver refuses path mode on the API origin, and refuses a preview hostname equal to
that origin; native direct access does not weaken this server-origin boundary.
`hostOriginAvailable` is derived from the actual HTTPS/domain resolver; `pathModeAvailable` is false.
One-use URL admissions have a short expiry. An exchanged viewer cookie has no elapsed-time
expiry: the server authorizes it against the live registration until that resource is unregistered.
Opening another viewer preserves existing viewer cookies; unregistering revokes them together.
Hosted static-asset teardown uses the same daemon revoke route: it revokes the server registration
before removing the local preview row, rather than leaving remote viewer access registered.
An exact server 404/`preview_not_found` confirms cleanup is already complete, including when no
viewer ever published the hosted preview. Other revocation failures retain the local row.

Web panes opt in to the [cooperative collector bootstrap](./browser-automation-verb-matrix.md#browser-context-and-model-images-development)
on isolated host-origin previews. The server adapter authorizes loader requests through the same
preview access route, strips collector configuration before forwarding upstream, and transforms
only opted-in HTML responses. It decodes supported upstream compression using the preview's
existing response-body budget, preserves CSP, and leaves non-HTML transport bytes streaming.
Same-preview redirects retain the navigation identity; external redirects never receive it.
The loader and UI/native/desktop injection share one collector generator rather than copies.

#### Sessionless managed-Service admission (0.3 development)

Project Service previews reuse this registration and access owner rather than
manufacturing a Session. The strict `serviceTarget` routes to the existing Local
Services managed occurrence, retaining its Machine, workspace, declaration and
cwd. Those caller fields are not authority: the protected
`daemon.localServices.preview.admission` read/wait method verifies the current
starter, exact service instance and current Machine installation through the
same supervisor. Only a proof-attested current daemon can register that method;
ordinary clients and an older installation cannot supply its witness.

Private open/revoke and public-preview Actions keep an explicitly supplied,
strict `serviceTarget` instead of inheriting the invoking Session's scope.
Public status accepts that same qualifier with its registered `previewId`,
checks the current service registration and returns only that occurrence's
exposures. Existing Session-scoped preview requests retain their contextual
defaults and Session-by-id status behavior.

Final effective access loss retires serving authority immediately, even when a
native Stop is unsupported or unconfirmed and custody remains. Another valid
overlapping grant does not trigger retirement. Existing private/public streams
close for the affected viewer, while unrelated viewers remain authorized; loss
of the starter's serving admission retires the resource's exposures. Stop
settlement and serving disclosure are separate facts.

An already registered Browser target can request fresh `server_preview` access
using its preview and Machine ids as routing identity, without a daemon snapshot
or native descriptor. `BrowserViewHost`, `useNativeDirectPreview` and
`nativeDirectAccess.ts#acquireServerPreviewAccess` retain the captured viewer's
Account/Home credential; the server resolves and authorizes the registration.
Web and native server fallback do not replay the custodian's snapshot URL.
Native Iroh still requires the actual matching registration descriptor and its
ordinary signed grant/proof. External navigation does not acquire preview access.

Daemon operations needing requester HTTP credentials fail with
`requester_credentials_unavailable` when a shared actor has no genuine private
credential carrier; the custodian's bearer never substitutes for that actor.
These owner and nonvisual caller contracts are source-tested, not a completed
loaded Project journey, native-device qualification or released availability.

#### Native private-preview access (0.3 development)

This development implementation is not yet verified as a complete native preview flow.
Package validation and loaded Tauri validation remain open. The daemon publishes
`localServicePreviewNativeAccess` through its complete Machine capability projection only after
the Iroh acceptor and TCP preview application are installed, and withdraws it when either
transport owner stops. A failed acknowledgement does not restore retired local readiness;
reconnect republishes the current projection. The server refuses native access without that
declared Machine capability. The current evidence
and remaining work belong to
`.project/plans/2026-08-23-ru2-surfaces-finalization/impl-2026-09-30/lanes/W14-IROH-PREVIEW.md`.

The intended Tauri, iOS and Android flow prefers app → daemon Iroh when the existing Machine
carrier is available and the client-local policy permits it. Web viewers keep the isolated server URL.
The snapshot's optional `nativeDirect` descriptor contains only the preview and Machine ids;
reading a snapshot does not mint authority. The authenticated
`POST /v1/local-services/preview/:previewId/access` route resolves the same registration and
Session access owner, then returns its initial path, exact Machine endpoint and a fresh signed
generic TCP grant. Signing, current Machine capability and the canonical direct TCP gate remain
mandatory; no new preview gate or endpoint registry is introduced.

The grant binds exactly one registered loopback target and its HTTP policy. Only this
preview-bound Iroh TCP scope permits `exp: null`: admission still requires the signed ephemeral
proof and live registration authority. The daemon retains an authenticated
`POST /v1/local-services/preview/:previewId/native-registration` control stream in that server
resource's existing lifetime. Unregister, policy-binding replacement, server shutdown or control
connection loss closes the adapter and its active mux sockets. Viewer release cancels the stream.
There is no independent preview timeout or heartbeat.
The signed grant id keys pending and claimed custody in that registration's existing collection.
Unregistering clears it, so an unused grant cannot revive after the same preview id is registered
again. The pending daemon HTTP carrier owns cleanup until the exact tunnel-id WebSocket attaches;
attachment transfers custody before any guest frame, preserving idle close and revocation.

`NativeHttpLease` in `packages/iroh-native/rust/happier-iroh-core/src/native_http_lease.rs` consumes
the existing Machine handshake and generic binary TCP mux. Its `nativeHttpLease.openJson`
option on `startMachineTunnel` binds a distinct `127.0.0.1:<port>` guest origin per viewer lease.
Native code retains the private Machine-listener capability, grant and proof; none enters guest
headers, URLs or WebSocket protocols. HTTP and WebSocket/HMR bytes reach
`startLocalServicePreviewNativeAdapter` in `apps/cli/src/daemon/local/services/preview/nativeAdapter.ts`.
That adapter uses the same Node-only HTTP/WebSocket policy owner under
`packages/peer-mediation/src/localServices/preview/` as the server's thin adapters, including
credential filtering, allowed methods, safe request-target parsing, cookie and redirect rewriting,
and TLS validation.
It is not a raw destination-port policy bypass.

`useNativeDirectPreview` in `apps/ui/sources/sync/domains/local/services/preview/` retains the lease
across snapshot and navigation updates. The existing Machine native lease custody handles failed
release, runtime suspension and shutdown. Closing or suspending the viewer releases its lease;
hidden/parked views keep it. The viewer renders through the selected native WebView engine, not a
host iframe on Tauri. Native admission reads the captured requester Account's effective Machine
TCP preferences before minting and before dialing. The logical view identity bounds lease custody;
server-only `previewToken` admissions are removed from native navigation.
An unavailable native carrier falls back to the canonical server URL where one exists. A native
viewer obtains a fresh one-use URL through the same access route's strict `server_preview` mode
when it enters active fallback, rather than replaying an expired snapshot admission. This mode
uses current registration authorization (Session READ or the exact current Service witness),
not custodian-only Machine RPC authority. Native and
fallback requests retain the captured requester Account scope; a switched credential cannot
silently admit another Account. Active web viewers acquire fresh server-preview access through
that same captured Account/Home owner; they do not acquire the native carrier.
Without either route, the existing typed runs-elsewhere state remains available.
These are current development-source contracts, not iOS/Android device or release certification.
The current guest listener has no allocated-Origin admission check. Foreign WebSocket Origins
remain visible to the upstream application rather than being rewritten as trusted; upstream
rejection is therefore still effective, but an Origin-permissive application may admit a foreign
browser caller that can reach the listener. Browser-level cross-preview isolation is not verified
by the native byte-transport tests and remains part of the activation review.

The public fixed-window limiter tracks clients within each exposure. Its established 10,000-client
memory boundary and elapsed-window reclamation are retained per exposure; overflowing one share
uses only that share's overflow bucket, never the quota of an unrelated share.

`resolveLocalServicesFeature` (`apps/server/sources/app/features/localServicesFeature.ts`) turns
unmet prerequisites into **ten** reason codes, carried on
`capabilities.localServices.preview.disabledReasons` and
`capabilities.localServices.publicPreview.disabledReasons`. The client renders them — see §4.

| Code | Node | Emitted when |
| --- | --- | --- |
| `disabled_by_server_policy` | `preview` | `…LOCAL_SERVICES_PREVIEW__ENABLED` is false |
| `disabled_by_server_policy` | `publicPreview` | `…LOCAL_SERVICES_PUBLIC_PREVIEW__ENABLED` is false — the default, and short-circuits the rest |
| `pms_server_relay_disabled` | both | `…MACHINES_TUNNEL_SERVER_ROUTED__ENABLED` is false |
| `pms_allowed_ports_empty` | both | `…MACHINES_TUNNEL_ALLOWED_PORTS` is empty |
| `peer_mediation_grant_signing_unavailable` | both | route-grant signing does not resolve (§2.1), so the relay tunnel opener would throw on every request |
| `mode_unconfigured` | `publicPreview` | no allowed exposure mode configured |
| `max_ttl_unconfigured` | `publicPreview` | no maximum link lifetime configured |
| `dns_tls_unavailable` | `publicPreview` | no host-origin base domain, or the canonical server URL is not `https:` |
| `audit_sink_unavailable` | `publicPreview` | no durable audit sink resolved |
| `rate_limit_profile_unconfigured` | `publicPreview` | no rate-limit profile ids configured |
| `rate_limit_checker_unavailable` | `publicPreview` | no rate-limit checker resolved |

`publicPreview.enabled` is `publicPreviewEnabled && publicDisabledReasons.length === 0`, so **every**
public prerequisite is hard. Two of them became hard in the 2026-08-23 hardening pass and are worth
naming because their older behaviour is still described in the packets:

- **DNS/TLS** is now unconditional. A public exposure is minted on its own isolated origin, so the
  runtime refuses with `public_origin_unavailable` without one. It is no longer conditional on the
  `dnsTlsRequired` policy bit (that bit still governs the per-exposure check in
  `apps/server/sources/app/local/services/public/policy.ts`, which is a different decision).
- **The rate-limit checker** is now unconditional. It previously failed *open* behind a helper that
  could not observe the one case that mattered; abuse control is now a prerequisite for the gate,
  matching the runtime's own refusal.

There is no operator switch for the audit requirement. A public exposure always requires a durable
audit sink; the former `auditRequired` knob had exactly one non-default value, it emitted a reason
code that disabled the feature, and it has been removed.

## 3. Reachability, measured

The historical counts and configuration table below come from the 2026-08-18 audit
(`.project/reviews/2026-08-18-21-34-57-ru2-browser-local-services-completion-audit-e62cd7/REPORT-TUNNELS.md`)
and were spot-checked, not re-measured, on 2026-08-23. They are not a current Settings or
enablement catalogue; current Account preferences and signing prerequisites are described above.

| Configuration | What runs |
| --- | --- |
| Defaults | Nothing. The mint route 404s and the preview capability reports `peer_mediation_grant_signing_unavailable`; a request that reaches the data path anyway gets a typed 503. Observability is off (fail-closed). |
| + the four signing variables | The loopback-direct half (`directPeerEnabled` is already true), and the parent gate observability depends on. |
| + `…PEER_MEDIATION_OBSERVABILITY__ENABLED` on top of those | PMS-9 observability, readable through the socket subscription and the daemon snapshot action. |
| + `…TUNNEL_SERVER_ROUTED__ENABLED` and a non-empty `…TUNNEL_ALLOWED_PORTS` | Historical ~16,000 LOC inventory: voice tunnel, private preview, simulator relay, direct machine RPC. This is not the current speech enablement contract. |
| Any configuration | ~5,500 LOC stays dark — see below. |

In 0.3 development, binary speech relay instead consumes the canonical voice relay feature
and application caps plus socket-bound grant signing. It does not require a non-empty TCP
port allowlist; the same empty allowlist still denies generic TCP relay destinations.

Of the three subsystems the audit recorded as permanently dark, **one has been fixed, one is being
deleted, and one is still dark**:

- **PMS-9 observability (~3,031 LOC across four codebases)** — **no longer dark.** It was
  unreachable at every configuration because its gate had no writer. `resolvePeerMediationFeature`
  (`apps/server/sources/app/features/peerMediationFeature.ts`) is now registered in
  `apps/server/sources/app/features/catalog/serverFeatureRegistry.ts` and resolves
  `machines.peerMediation.observability` from
  `HAPPIER_FEATURE_MACHINES_PEER_MEDIATION_OBSERVABILITY__ENABLED`, failing closed when the variable
  is absent or malformed (`readPeerMediationFeatureEnv` in `catalog/readFeatureEnv.ts`).

  It is a **child gate**: grant signing must resolve first, or dependency closure forces it off
  regardless of the variable. Its `disabledReasons` name which half failed —
  `peer_mediation_grant_signing_unavailable` for the parent,
  `observability_disabled_by_server_policy` for the child variable.

  The two engine copies were also consolidated into the single protocol owner under DEC-8, which
  fixed two real drifts: the daemon copy collapsed every non-machine scope into one bucket, and both
  copies summed cumulative byte gauges instead of taking the latest sample.

  In the 0.3 development implementation, daemon collection consults the current cached, parsed Home
  `machines.peerMediation.observability` setting for every publication, using the same availability
  decision as reads. Missing or disabled settings retain no new events. One startup-owned store
  serves the relay writers and snapshot/subscription readers; bootstrap does not create an unread
  fallback store. Changing the setting does not replace that store or orphan existing subscriptions.

  Server collection uses the canonical live Home decision as well, including deployment locks and
  dependency closure. Its current writers emit lifecycle, denial, and HTTP/WebSocket boundary events,
  not an observation for every valid forwarded frame. Home reads and publication are ordered at the
  shared emitter: a delayed start decision must not publish after a terminal event and revive the
  flow projection. An unavailable Home decision drops that observation and logs a warning; the next
  event can recover. Socket subscription admission also reads the live Home setting; unsubscribe or
  disconnect cancels admission while its Home read is pending. Published deltas use the collector's
  Home decision and keep their synchronous principal/scope authorization, without a second Home read
  per subscriber. Existing scope and redaction adapters remain in place.

  **Honest limit:** the state is now reachable and readable, but **no first-party UI renders it**.
  Reaching it means the socket subscription (`peer:observability:subscribe:v1`) or the
  `peerMediation.observability.snapshot` daemon action — not a screen.
- **Managed local services (~554 LOC)** had no producer for any mutator, and `source:'managed'` is
  structurally impossible on the wire (`LocalServiceInventorySourceV1Schema` in
  `packages/protocol/src/local/services/inventory/v1.ts` is `z.enum(['detected'])`). The spine is
  being removed under DEC-6; the UI half
  (`apps/ui/sources/sync/domains/local/services/managed/**`) is gone — verified absent 2026-08-23.
- **`lan_direct`** is still declared in the route-kind enum with no producer anywhere.
  `tailscale_serve_direct`, by contrast, is live for bounded transfer
  (`apps/ui/sources/sync/domains/transfers/runtime/transferRuntime/availability/machineDaemonTransferState.ts`).

## 4. Surfacing: which prerequisite failed

`capabilities.localServices.{preview,publicPreview}.disabledReasons` had **zero** production readers
until 2026-08-23; the client showed one generic sentence for ten distinct causes (nine codes, with
`disabled_by_server_policy` meaning a different thing under each node). The reader is
now `useLocalServiceCapabilityDisabledReasons` in
`apps/ui/sources/components/sessions/localServices/useLocalServicePublicPreviewFeature.ts`, called
once by `LocalServicesSurfaceHost` and passed down to the rows; the copy owner is
`CAPABILITY_DISABLED_REASON_KEYS` in
`apps/ui/sources/sync/domains/local/services/publicPreview/presentation.ts`.

There are three separate reason vocabularies on this path, and they must not be merged:

| Vocabulary | Producer | Consumed by |
| --- | --- | --- |
| `LocalServicePreviewDiagnosticV1['code']` (closed enum) | daemon and server preview runtimes | `PUBLIC_PREVIEW_DIAGNOSTIC_REASON_KEYS` |
| `diagnostic.details.reasonCode` (free string) | e.g. `apps/server/sources/app/local/services/public/runtime.ts` | `PUBLIC_PREVIEW_POLICY_REASON_KEYS` |
| `capabilities.localServices.*.disabledReasons` (free string) | `resolveLocalServicesFeature` | `CAPABILITY_DISABLED_REASON_KEYS` |

The capability field is `z.array(z.string())` on the wire
(`packages/protocol/src/features/payload/capabilities/localServiceCapabilities.ts`), so a code from a
newer server is expected: the client drops what it does not recognise and falls back to its generic
sentence rather than rendering a raw identifier. The cost of that graceful degradation is that a
code added on the server and not mapped in the client is **silent**, which is what the
"covers every reason code the server can emit" test in `presentation.test.ts` exists to catch.

`disabled_by_server_policy` means "the private preview feature is off" under `preview` and "the
public exposure feature is off" under `publicPreview`, which is why the capability map is keyed by
node.

### Machine-local service annotations (0.3 development)

The daemon inventory registry owns Label and Forget. It publishes the complete
annotation file through the existing atomic JSON writer before acknowledging a
mutation or publishing its in-memory result. Write failures propagate without
changing the current annotations. Forget is scoped to the endpoint's address and
process run: elapsed time or the number of other forgotten entries does not undo
the user's choice. A proven different process run makes the endpoint visible again.
The persisted V1 annotation shape is unchanged.

Successful Forget returns the suppression key through the existing Forget action.
The Services surface offers Undo in the existing presentation notice; it sends that
key back to the same machine's action owner, even after the row disappears. Undo
uses that suppression key as its target identity, and mismatched keys are refused.
It persists removal of the suppression before publishing the latest scan, rather than
reviving the old row. A failed Undo remains visible through the notice owner.

Services Open uses the existing browser workspace binding's typed outcome. An
admitted target reports success to the shared service-action runner; an unmappable
target reports refusal without navigating. Admission is not a claim that the
preview page has loaded. Null or missing action results still fail in the shared
classifier.

## 5. Team Provider broker application path (development only)

The Team credential broker reuses the exact-Machine transport substrate, but it is not a generic
peer-mediation route and must never enter the same-Account peer control plane. The Home's Team
credential admission owner first binds the current resource, accountable Account, Session or
execution run, broker Machine, request facts, and one application target. The transport carries
that typed application request to the exact Machine; the broker handler may reach only the managed
Provider endpoint access selected by the binding. It cannot select an arbitrary loopback port,
open SVC09 directly, or reinterpret the request as a peer-mediation operation.

The Home broker-open response carries the target's complete canonical endpoint
descriptor, including its relay URLs and direct-address hints. The strict
response requires its descriptor identity to equal the target EndpointId; the
shared ordinary-daemon/Runner opener also checks that target against the signed
broker authority. Hints select contact paths, never a different identity or
application authority.

Native `machine/1` ingress keeps same-Account grants, Team broker authority and
activation-readiness authorization distinct. After verification, one admission
owner validates the fixed application target, creates or retains its first-bytes
capability, tracks proxy custody and returns the bodyless authenticated endpoint
echo. Request cancellation covers proxy binding through the admission reply, so
an aborted, unclaimed stream cannot leave a listener behind. Prepared finite
transfers retain their own listener admission rather than acquiring a second
capability.

Authority is request-scoped, not captured once when a connection factory is constructed. Each
admitted stream/request rechecks its authenticated transport context, route grant, resource and
source currentness, grant lifetime, placement, Session/run binding, policy, and accountable Account.
Reusing or multiplexing a connection must not exchange headers, identity, or usage attribution
between streams. An already admitted upstream request may finish after later revocation; a new
request must pass current admission again, and it does so before the broker starts or joins any
managed source custody, so a refused request materializes nothing. A Home refusal that means the
operation itself lost its authority (`resource_forbidden`, or an ended/unknown execution run)
retires that operation's custody; a reached limit, turn boundary or unreachable Home does not.

The route grant signs the operation's identity only: resource, source revision, application,
initiator, consumer and target Machine. The model, reasoning effort and resource revision are
request facts, not signed identity: one open serves every model the resource currently allows, and
the broker's single request-policy owner evaluates each request's model against the resource policy
at the revision the Home confirms is current, so a model dropped from the allowlist is refused on
the next request. An execution run's operation is authorized on the provider-model selection its
own Run owner attests with its currentness, or on its parent Session's accepted selection when the
Run selected nothing and inherits it; the resource an open names never substitutes for either.

The route grant's expiry bounds new work, not the operation. A stream admitted after the grant
expired can only release the exact Session/run claim that grant names (the carrier's DELETE close);
every other request on it is refused with `grant_expired` before policy, admission or source
custody. A live operation that needs a new inference stream obtains a fresh grant from the Home.

Broker readiness is a content-free, non-inference activation exchange. It can establish only that
the exact application handler for the selected target is installed and eligible; it does not grant
resource access or prove a Provider request will succeed. Current 0.3 source still requires the
composed exact-Machine request, cancellation, recovery, and live UI gates before this development
path may be described as available.

The current Temporary-computer readiness carrier is a distinct
`provider_broker_readiness` arm of the strict `happier/machine/1` admission union. Its dual-signed
request is the exact broker-open witness: it binds the Home and activation, sealed launch-manifest
commitment, resource, Agent target and protocol, Runner installation plus native initiator EndpointId,
and broker Machine plus native target EndpointId. Native Iroh supplies the authenticated remote
EndpointId independently; target admission compares that observed identity and its own current
EndpointId with the signed witness before selecting the fixed readiness application. The readiness
arm cannot be passed to the inference handler.

The application forwards only that strict signed envelope to the Home's currentness owner and
returns content-free readiness. It does not carry a prompt, model request, credential, local bearer,
or arbitrary destination. Closing it retains no tunnel or service lease for later Session use. Final
materialization consumes the same signed witness and independently rereads the current resource,
selection binding, broker endpoint, source revision, consent, and installation facts before
committing the Machine and Session. A later Provider open still performs its own current admission;
readiness is not a retained authorization for that effect.

## 6. Public exposure Settings and prerequisites

Public exposure follows the canonical Home Settings decision represented by
`localServices.publicPreview`; its transport, signing, origin, authorization and abuse-control
prerequisites still apply (§2). Access-time authorization and the dedicated public origin remain
runtime requirements, not optional review controls.

PLAN §9.3 AMD-2026-09-30 supersedes DEC-7's additional “off until independent review” availability
condition. Review and composed live validation provide evidence; they are not another runtime gate.
This page describes development-only 0.3 source, not a released availability claim.

## 7. Known spec/implementation divergences

Recorded here for lane D3, which owns the packet amendments. Each was checked against code:

| Packet claim | Code |
| --- | --- |
| PMS-6 §5.1 requires grant revocation | **Withdrawn.** The revocation registry and daemon revocation-id threading are removed. Direct admission uses the current `verifyDirectRouteGrantV2` owner in `verifyDirectRouteGrant.ts`, with signed scope, expiry, ephemeral possession and the existing consumption owner. `grant_revoked` remains passive reason vocabulary; it does not create a revocation mechanism or justify old-component negotiation. Amendment and reinstatement condition: the S-4 block in `PMS-6.md`. |
| PMS-9 REQ-9-08 requires subscription gap recovery | The UI subscription marks a sequence gap stale and requests a new snapshot through the existing `peer:observability:subscribe:v1` event. Further deltas wait for that snapshot; contiguous deltas then resume. Duplicate receipts are ignored. No recovery wire field or retry timer is added. |
| PMS-1 moves endpoint publication into the substrate | the substrate listener hard-codes `routeKind:'loopback_direct'`; the real Tailscale listener still lives at `apps/cli/src/machines/transfer/tailscaleTransferServeLifecycle.ts` |
| The protocol declares five flow kinds | the substrate package models four; `voice_media` is omitted from `activeFlows` |
| PMS acceptance gates | they are `test -f` / `rg` assertions, so they pass while the behaviour they name is skeletal |

## Live-stream payload privacy (0.3 development)

The `machines.liveStream.v1` socket carries explicit mode-bound payloads. Frames use
`payload: { t: 'plain', v: <base64> }` or `payload: { t: 'encrypted', c: <ciphertext> }`;
input sidebands use the same envelope with the complete typed input object inside the
plain branch or ciphertext. Raw `payloadBase64` and raw sideband input are process-local,
not accepted relay wire shapes.

Protocol's `stream/payloadV1.ts` is the sole framing and authenticated-binding owner.
The daemon seals before socket emission with its verified Machine content codec; active
and scoped viewers share `stream/socketTransport.ts` and the existing Machine encryption
owner. E2EE opening verifies the authenticated routing, viewer, stream and frame headers
before dispatching decoded content, including the optional typed `codecId` carried by capture.
Wrong mode, unavailable material, failed authentication
or substituted scope produces a typed failure and no frame/input delivery; a valid stream
scope receives a terminal stop rather than silently remaining frozen.

The relay reads persisted Account mode at stream admission, rejects mode/content
mismatches, routes opaque ciphertext and meters its actual decoded transport byte length.
It has no content key or frame/input decoder. Plain Accounts need no encryption material.
This is current development wire behavior, not a claim of released availability or completed
loaded-runtime certification. See [Encryption](encryption.md) for key ownership and framing.

## 8. Related

- `apps/docs/content/docs/self-hosting/local-service-previews.mdx` — the operator-facing guide.
- `docs/feature-gating.md` — how server gates and capabilities are resolved and consumed.
- `docs/compatibility.md` — wire and persistence compatibility rules for these seams.
