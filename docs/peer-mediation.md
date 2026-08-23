# Peer mediation

How Happier decides whether bytes between a device and a machine travel directly or through the
server, and who owns each step. This page is the internal counterpart to the operator guide at
`apps/docs/content/docs/self-hosting/local-service-previews.mdx`.

**Status of this page.** Every claim below was checked against implementing code at the cited
`file:line` on 2026-08-23. Where the `PMS-1 … PMS-9` specification packets
(`.project/plans/runtime-unification-v2/stages/stage-A/`) describe behaviour the code does not
implement, this page documents the code and says so. The packets are the design authority; they are
not evidence that anything runs.

## 1. The model

Every mediated session is a **flow kind** (what the bytes mean) crossed with a **route kind** (how
they physically travel).

| Axis | Members | Declared at |
| --- | --- | --- |
| Flow kind | `bounded_transfer`, `tcp_tunnel`, `live_stream`, `machine_rpc`, `voice_media` | `packages/protocol/src/machines/peer/mediation/**` |
| Route kind | `loopback_direct`, `lan_direct`, `tailscale_serve_direct`, `server_relay` | same |

The five moving parts and their canonical owners:

| Part | Owner |
| --- | --- |
| Route decision (pure fold of feature bits, account preferences, daemon policy, grant state → a route or a typed refusal) | `packages/peer-mediation/src/route/**`, `.../flows/**` |
| Route grants (Ed25519, bound to account + machine + flow + route + destination + expiry) | `packages/protocol/src/machines/peer/mediation/**`; minted at `apps/server/sources/app/machines/peer/mediation/**` |
| Direct transport (daemon loopback HTTP server, grant + nonce on every operation) | `apps/cli/src/daemon/peer/mediation/**` |
| Relay transport (framed envelopes over the existing Socket.IO connection) | `apps/server/sources/app/api/socket/peer/mediation/**` |
| Observability (sequenced ring buffer of flow lifecycle events, with metadata redaction) | `packages/protocol/src/.../peer/mediation/observability/**` plus daemon, server and UI stores |

## 2. The enablement contract

This is the part that surprises people: **on a default deployment none of the substrate is
reachable**, and the reason is configuration, not missing code.

### 2.1 Grant signing is the master switch

`resolvePeerMediationGrantSigningConfig` (`apps/server/sources/app/machines/peer/mediation/mintDirectRouteGrantV1.ts:125-160`)
reads four variables and returns a typed refusal when they are absent:

| Variable | Absent → | Notes |
| --- | --- | --- |
| `HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_KEY_ID` | `missing_key_id` | any short label; travels with the grant so machines can select a trust root |
| `HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_PRIVATE_KEY` | `missing_private_key` | 32-byte Ed25519 seed or 64-byte secret key, strict unpadded base64url (`:93-103`) |
| `HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_PUBLIC_KEY` | *(optional)* | cross-checked against the key derived from the seed; mismatch → `invalid_public_key` |
| `HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_EXPIRES_AT` | *(optional)* | epoch **milliseconds** |

Two consequences, both observable:

- `isPeerMediationGrantSigningAdvertisedForRequest` (`apps/server/sources/app/features/catalog/serverFeatureGate.ts:20-23`)
  is `capabilities.machines.peerMediation.grantSigningKeys.length > 0`, and
  `readPeerMediationFeatureEnv` (`readFeatureEnv.ts:550-557`) returns an empty list when signing does
  not resolve. The grant-mint route's pre-handler
  (`registerPeerMediationGrantRoutes.ts:172-181`, wired at `:310`) therefore replies **`404`**.
- The local-service preview tunnel opener throws
  `local_service_preview_tunnel_unavailable:grant_signing_unavailable`
  (`apps/server/sources/app/local/services/preview/tunnel.ts:211-215`). That call
  (`preview/httpAdapter.ts:436`) is not wrapped, so it reaches the global handler
  (`apps/server/sources/app/api/utils/enableErrorHandlers.ts:29-60`) and the client gets a **500**
  with `Internal Server Error`; the reason appears only in the server log.

Machines need no configuration: the daemon takes the public key from the server's own capability
payload and drops expired entries
(`apps/cli/src/daemon/machine/bootstrapMachineSyncRuntime.ts:382-387`,
`apps/cli/src/daemon/peer/mediation/rpc/startLoopback.ts:87-88`).

### 2.2 The relay half adds two more gates

`readMachineTunnelFeatureEnv` (`readFeatureEnv.ts:604-612`):

- `HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__ENABLED` defaults **false** (`:609`).
- `HAPPIER_FEATURE_MACHINES_TUNNEL_ALLOWED_PORTS` defaults **`[]`** — `parsePortList` returns an
  empty array for an unset value (`:337-338`), i.e. a deny-all destination list.
- `HAPPIER_FEATURE_MACHINES_TUNNEL_DIRECT_PEER__ENABLED` defaults **true** (`:608`), but it only
  feeds the `machines.tunnel.directPeer` gate (`machineTunnelFeature.ts:14`). **It does not affect
  local-service previews**, which always construct a relay transport
  (`api/routes/local/services/registerRoutes.ts:185-193` → `preview/tunnel.ts:218`).

Both gates are enforced when the relay authorization is minted
(`apps/server/sources/app/machines/peer/mediation/tunnel/authorization.ts`):

| Condition | Reason code | Line |
| --- | --- | --- |
| `serverRoutedEnabled` false | `blocked_by_server_policy` | `:87-93` |
| destination host not loopback | `destination_host_not_allowed` | `:119-125` |
| port not in both the scope and the server allowlist | `destination_port_not_allowed` | `:126-135` |
| requested caps exceed server caps | `relay_cap_exceeded` | `:137-144` |

### 2.3 Local-service preview gates

`readLocalServicesFeatureEnv` (`readFeatureEnv.ts:692-737`): private `preview` defaults **on**
(`:697`, loopback only, no exposure); `publicPreview` defaults **off** (`:698`, fail-closed).

`resolveLocalServicesFeature` (`apps/server/sources/app/features/localServicesFeature.ts:52-110`)
turns unmet prerequisites into ten reason codes carried on
`capabilities.localServices.preview.disabledReasons` (`:155`) and
`capabilities.localServices.publicPreview.disabledReasons` (`:167`). The client renders them —
see §4.

## 3. Reachability, measured

Counts below come from the 2026-08-18 audit
(`.project/reviews/2026-08-18-21-34-57-ru2-browser-local-services-completion-audit-e62cd7/REPORT-TUNNELS.md`)
and were spot-checked, not re-measured, on 2026-08-23.

| Configuration | What runs |
| --- | --- |
| Defaults | Nothing. The mint route 404s and the preview tunnel throws. |
| + the four signing variables | The loopback-direct half (`directPeerEnabled` is already true). |
| + `…TUNNEL_SERVER_ROUTED__ENABLED` and a non-empty `…TUNNEL_ALLOWED_PORTS` | ~16,000 LOC: voice tunnel, private preview, simulator relay, direct machine RPC. |
| Any configuration | ~5,500 LOC stays dark — see below. |

Unreachable at every configuration, as of this writing:

- **PMS-9 observability (~3,031 LOC across four codebases).** `machines.peerMediation.observability`
  has no resolver in `serverFeatureRegistry.ts`, so no environment can enable it, while the daemon
  still writes on every relay byte. *Owned by lane D1 of the RU2 surfaces finalization plan.*
- **Managed local services (~554 LOC).** No producer for any mutator, and `source:'managed'` is
  structurally impossible on the wire (`packages/protocol/src/local/services/inventory/v1.ts:35` is
  `z.enum(['detected'])`). *Owned by lane B3.*
- **`lan_direct`.** Declared in the route-kind enum with no producer anywhere.
  `tailscale_serve_direct`, by contrast, is live for bounded transfer
  (`machineDaemonTransferState.ts:131`).

## 4. Surfacing: which prerequisite failed

`capabilities.localServices.{preview,publicPreview}.disabledReasons` had **zero** production readers
until 2026-08-23; the client showed one generic sentence for eleven distinct causes. The reader is
now `apps/ui/sources/hooks/server/useLocalServiceCapabilityDisabledReasons.ts`, and the copy owner is
`CAPABILITY_DISABLED_REASON_KEYS` in
`apps/ui/sources/sync/domains/local/services/publicPreview/presentation.ts`.

There are three separate reason vocabularies on this path, and they must not be merged:

| Vocabulary | Producer | Consumed by |
| --- | --- | --- |
| `LocalServicePreviewDiagnosticV1['code']` (closed enum) | daemon and server preview runtimes | `PUBLIC_PREVIEW_DIAGNOSTIC_REASON_KEYS` |
| `diagnostic.details.reasonCode` (free string) | e.g. `public/runtime.ts:599-607` | `PUBLIC_PREVIEW_POLICY_REASON_KEYS` |
| `capabilities.localServices.*.disabledReasons` (free string) | `localServicesFeature.ts:52-110` | `CAPABILITY_DISABLED_REASON_KEYS` |

`disabled_by_server_policy` means "the private preview feature is off" under `preview` and "the
public exposure feature is off" under `publicPreview`, which is why the capability map is keyed by
node.

## 5. Public exposure is gated deliberately

The public-exposure vertical is complete code behind
`HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__ENABLED`, which defaults off. It stays off until its
security work lands **and** an independent security review confirms it — decision **DEC-7** of
`.project/plans/2026-08-23-ru2-surfaces-finalization/PLAN.md`. Do not document it as available, and
do not enable it in any shared environment.

## 6. Known spec/implementation divergences

Recorded here for lane D3, which owns the packet amendments. Each was checked against code:

| Packet claim | Code |
| --- | --- |
| PMS-6 §5.1 requires grant revocation | `grant_revoked` has no producer; grants are TTL-only |
| PMS-9 REQ-9-08 requires subscription gap recovery | `resubscribeRequired` is computed at five UI sites and read by nothing |
| PMS-1 moves endpoint publication into the substrate | the substrate listener hard-codes `routeKind:'loopback_direct'`; the real Tailscale listener still lives at `apps/cli/src/machines/transfer/tailscaleTransferServeLifecycle.ts` |
| The protocol declares five flow kinds | the substrate package models four; `voice_media` is omitted from `activeFlows` |
| PMS acceptance gates | they are `test -f` / `rg` assertions, so they pass while the behaviour they name is skeletal |

## 7. Related

- `apps/docs/content/docs/self-hosting/local-service-previews.mdx` — the operator-facing guide.
- `docs/feature-gating.md` — how server gates and capabilities are resolved and consumed.
- `docs/compatibility.md` — wire and persistence compatibility rules for these seams.
