# Compatibility and version skew

This document defines when Happier preserves old behavior across UI, CLI, daemon, server, installers, and persisted state. The goal is safe upgrades and mixed-version operation without turning undeployed implementation history into permanent compatibility debt.

## Trigger

Apply this policy when a change affects a cross-component wire shape or semantic, persisted/session/settings data, schema or migration, feature/capability negotiation, installer or service state, upgrade/coexistence, or rollback. Routine internal refactors that leave these seams unchanged do not need a compatibility matrix or shim.

## Baseline classes

### Hard released obligations

- Active stable and preview releases count because both can exist on user machines or deployed infrastructure.
- Resolve each component independently. UI, CLI/daemon, server, desktop/mobile, and stack tags may point to different commits.
- Discover the current channel through rolling tags such as `cli-preview`, then record the immutable component version tag, commit, and relevant artifact/deploy evidence used by the check.
- Older releases count only when explicitly supported by policy or task scope; tag existence alone does not imply indefinite support.

### Moving `../0.2` predecessor frontier

- `../0.2` is expected to ship before this repository. Its real current on-disk code is a prospective compatibility input even when it is uncommitted or not yet released.
- Inspect committed, staged, and unstaged code in the relevant paths. Record `HEAD`, working-tree status, the relevant diff/basis, and what was directly observed versus inferred.
- Never modify or clean the sibling worktree. Dirty changes may be incomplete or concurrently owned; if the externally observable contract is contradictory or unknowable, report that uncertainty rather than inventing multiple speculative adapters.
- Track the latest observable prospective shape, not every superseded internal implementation. When the sibling evolves before deployment, refresh the comparison and remove support that existed only for a replaced, never-released intermediary shape.
- Recheck relevant sibling paths before handoff when they were dirty or advanced during the task. Released stable/preview shapes remain hard obligations regardless of later sibling changes.

### Non-obligations

- `dev`/`*-dev.*` builds, untagged history outside the live predecessor frontier, abandoned experiments, and undeployed internal module paths are not lasting compatibility contracts.
- Do not keep aliases or adapters solely for an atomic internal rename/move whose old path never shipped.
- The predecessor rule preserves observable wire/data/state behavior, not `../0.2`'s internal architecture.

## Map the seam

For the changed concept, identify:

- the canonical domain owner;
- every producer, consumer, reader, writer, serializer, parser, and persisted artifact;
- the old/new component versions that can actually meet during rollout or rollback;
- the wire, semantic, persistence, and operational expectations at that seam;
- any existing split-brain, duplicate decision path, fallback, or compatibility adapter in the touched corridor.

An existing same-concept split-brain in the touched corridor must be consolidated at the canonical owner. A compatibility adapter may translate released or predecessor shapes, but it must not independently decide domain behavior.

## Direction and rollout

- New readers accept supported old shapes; new writes use the canonical current shape.
- Old readers need to accept new writes only when coexistence, independent component rollout, or rollback makes that direction reachable.
- New clients talking to old servers must capability-negotiate or degrade safely instead of assuming the new contract.
- Old clients talking to new servers retain released behavior for ordinary compatible changes and for every operation the new server can still execute safely. A major incompatible server change may require a newer client for the affected operation, but that support boundary is an explicit developer/product decision—not an agent-selected default.
- Persisted-state changes consider both old-writer → new-reader and, when rollback/coexistence is supported, new-writer → old-reader.
- Prefer operation-scoped graceful degradation over connection-wide rejection: admit the old client, keep unaffected reads and writes available, and return a typed upgrade requirement only when the requested operation cannot be performed safely. Reject the whole connection only when no authenticated operation can be made safe. `agent-transition.md` is the current worked example: an old daemon answers `session.agentTransition` with `RPC_METHOD_NOT_AVAILABLE`, the client maps that one code to a no-effect operation-scoped rejection, every other transport failure maps to an indeterminate outcome rather than a false "nothing happened", and Machine presence — not the error — decides whether the reader is told to update the CLI or that the machine is offline.
- For an incompatible transition, prefer prepare/expand → activate/migrate → contract when mixed-version coexistence or rollback is an approved requirement. Do not assume that old clients must read new writes merely because the server is self-hosted.

Before adding dual writers, parallel persisted formats, rollout modes, operator flags, socket-drain protocols, or a mandatory client floor, compare their lifetime cost with the actual user behavior required. If preserving old-client/new-server behavior for a major change would require substantial machinery, stop and obtain an explicit developer/product decision among: operation-scoped degradation, a documented client update requirement, or the heavier compatibility transition. An agent must not silently choose either forced upgrades or heavy compatibility machinery. This exception is for genuinely incompatible, high-cost transitions; routine server changes must remain compatible and must not manufacture client-update requirements.

### Widget and organization stored readers (0.3 development)

Account Settings' retained legacy JSON carriers use the same stored-read owner.
Valid predecessor profiles and SavedSecrets remain readable above current
collection or byte budgets; new-write admission applies those budgets and
returns a typed refusal. Present profile/secret data must not recover to an
empty default merely because it exceeds a new-write budget. Automatic Voice
machine selection and recovery now remember their target in the device's
Account/Home-scoped runtime memory, not in Account Settings. The never-shipped
`executionMachine.autoMachineId` field is dropped by the stored Voice reader;
an explicit fixed machine choice remains an Account preference.

Stored widget definitions, instances and placements, Session/WorkBoard and Home
layouts, Companion preferences, workspace tabs/canvas state, and legacy folder
settings read their known fields and drop unknown object fields recursively.
The Protocol-owned `json/storedReadSchema.ts` derives persistence projections
from the canonical schemas, preserving required identities, domain refinements
and opaque JSON values. UI-local persistence schemas use the same stripping
policy. Organization display envelopes use a stored projection only when opening
database content; HTTP snapshots and mutations remain strict.

Action/request inputs, runtime events and wire results keep their strict
validators. Writers emit the current canonical shape, including when editing
an opened record. This changes additive-field read tolerance, not the persisted
format, storage-mode authority, access policy or supported version frontier.
The generic Artifact header remains an open metadata custodian; kind-owned
readers project its known fields. Artifact body and private-revision readers
drop extras separately while retaining body, Artifact/revision binding and
encryption-mode checks. Source validation is not loaded-runtime certification.

Saved Home profiles read their retained connection descriptor through
`StoredHomeConnectionDescriptorV1Schema`, dropping additive fields recursively
while retaining identity, origin, revision and endpoint validation. Incoming
descriptors and feature responses remain strict. When a signed-in Home moves,
address admission confirms the saved and selected addresses before forwarding
the incumbent credential, then reads its exact authenticated descriptor at the selected
address and commits through the existing credential/profile adoption transaction;
public discovery alone cannot replace a retained descriptor generation.

### Live-stream relay diagnostics (development)

`capabilities.machines.liveStream.serverRouted` is an optional read projection.
Current relay policy caps are optional positive integers: `{}` means the Home
has configured no explicit limits, while `caps: null` means relay policy is
unavailable. Malformed diagnostics normalize at the Protocol capability owner
to `caps: null` and `disabledReason: 'relay_caps_missing'`; they cannot invalidate
Home identity or unrelated feature gates. Relay operations still require their
canonical feature and grant admission, and invalid caps never become an
uncapped policy. Authorization and stream wire schemas remain strict about
their known fields.

The inspected `../0.2` predecessor at
`4651997217a36250e203643f2bd002dbf7a93321` has no live-stream capability producer
or reader. Omission retains the existing disabled default. The earlier 0.3
required-cap reader was development-only; update managed server and daemon
support together rather than inventing policy limits to satisfy stale output.

### SCM status snapshot transport (development)

The current machine `scm.status.snapshot` RPC omits neutral per-entry facts:
zero line counts, false area/binary flags, and null rename origins directly at
the machine producer, before its existing shared request/cache publication. The
canonical working-snapshot schema supplies their defaults for validated reads;
there is no separate transport schema or encoder. UI RPC admission checks the
response envelope through its existing admission owner, and the existing snapshot
mapper restores defaults in its normal entry pass without an additional per-entry
schema parse. A neutral statistics object may be empty. Nonzero counts, rename
paths, both status columns, binary facts,
and explicit statistics-completeness flags remain intact; no changed paths are
truncated. The domain and plugin SDK working snapshot remains fully populated.
File/commit diffs and worktree enrichment keep their existing separate RPCs.

Full status responses remain valid inputs to the same schema and UI mapper. This development
transport changes no persisted repository or Session data. The one-way 0.3
component upgrade does not support an older UI reading sparse responses from a
new daemon; update the producer and its consumers together.

### Local-service Machine summary (development)

The optional `daemonState.localServices` field carries the Protocol-owned strict
`LocalServiceMachineSummaryV1` presentation union. Its V1 epoch is independent of
package SemVer. Each member is closed: `ready` carries the listening user-service
count; `unknown`, `error`, and `disabled` carry no count. Missing or malformed data
is unknown to consumers. The existing Machine content transport and Account-mode
encryption decision remain authoritative.

This safely ignorable optional projection changes neither Machine identity nor
authorization or mutation admission. The inspected `../0.2` predecessor at
`17ba05df68d4d3d4cad1c1241b58e63805db37ed` has no summary producer; old Machine
states remain valid and supply no count. New daemons reconstruct their projection
from the current inventory and republish through the existing Machine lifecycle,
without a persisted format migration or a parallel count writer.

### Encrypted socket RPC binding (v0.3 development)

E2EE socket RPC uses the shared codec's V2 plaintext envelopes: requests bind
the complete target-prefixed method, caller-generated 128-bit call id and request
direction; responses bind that call id and response direction. Unbound encrypted
payloads are never accepted alongside V2. Current readers reject unbound,
malformed or mismatched envelopes with `RPC_UPDATE_REQUIRED`, including unbound
responses from an older daemon. A v0.3 responder refuses a 0.2 request before
handler dispatch; a 0.3 caller cannot trust a 0.2 response. All components must
upgrade together under the one-way 0.3 boundary. This is an intentional wire
epoch change, independent of package versions, and introduces no persisted state,
new key or negotiation. It does not prevent request replay. Plain-mode accounts
and reserved server-origin methods keep their existing contracts. See
[encryption.md](encryption.md#encrypted-socket-rpc-routing-v03-development).

### Machine Session-log diagnostics (v0.3 development)

Machine diagnostics register and call `daemon.session.log.tail`; `session.log.tail`
is Session-only. The Machine operation retains its explicit log path, response and
path-safety rules. The existing `bugreport.getLogTail` has a different diagnostics
allow-list and response contract and is unchanged.

The standing one-way 0.2 → 0.3 ruling requires all components to update together,
with no rollback or 0.2/0.3 cross-component support. Only 0.2-created data must
remain usable. A released 0.2 UI or daemon using Machine-prefixed `session.log.tail`
against a 0.3 server is outside that boundary, so the server retains strict scope
enforcement without a legacy registration or routing exception. This rename changes
no persisted data, log contents or historical log reader.

### Saved agent-start policy (development)

`sessionAgentSpawnPolicyV1` retains the strict 0.2 V1 field set, including
`allowEnvironmentVariables`. Admission refuses explicit environment overrides
when that flag is false, including an empty environment object; omitted
environment overrides remain allowed. Profile-inherited environment remains governed by
profile selection. Settings reads strip unknown keys
and recover malformed fields independently through their field defaults; a bad
field cannot erase another field's deny rule. Durable approval evidence uses
`SessionAgentSpawnPolicyV1StrictSchema` and rejects malformed or unknown fields.
Account bounds failures reject the policy instead of replacing it with open defaults.

The development-only role and Agent-target allow-lists live in the separate Account
setting `sessionAgentStartAllowListsV1`. The host reads it into the admission context;
`admitAgentStartV1` remains the single decision owner. Null means unrestricted and
an empty list allows none in that selection family. The UI writes this setting
independently, so a current V1 policy remains readable by 0.2 strict readers.

### Android file actions native runtime (development)

The development UI's Android Save As, Open With, and Share actions require the
compiled `HappierFileActions` Expo module. The destination uses the fresh
`0.3.0-native` runtime train for non-publicdev lanes; publicdev retains Expo's
fingerprint policy. This train is distinct from the predecessor's native runtime
and must be paired with a new native build before publishing its updates. Do not
use a runtime maintenance override to send this JavaScript to a binary without
the module.

Workspace downloads and previews continue through the canonical prepared transfer
carrier; the port does not restore predecessor bulk-RPC probing or alter encrypted
transfer contracts and daemon-owned limits. Native cache files have independent
storage identities while Android receives the original display name. Failed or
canceled document copies remove the newly created destination; a provider that
refuses deletion produces an error identifying the remaining document. Web and
iOS keep their existing download actions.

### Native date/time picker availability (development)

An OTA update cannot add a compiled native module to an installed app. The
current UI package defaults non-publicdev Expo lanes to its configured
`happierExpoRuntimeVersion` train; publicdev defaults to fingerprint compatibility, and
explicit runtime overrides remain configuration-owned. A runtime match alone is
not evidence that the installed binary contains a newly added native SDK.

The shared `DateTimePickerPopover` native adapter owns the installed-capability
check before lazily loading `@react-native-community/datetimepicker`: the iOS
view registration, or all four Android bindings eagerly required by SDK 9.1.0.
`LocalDateTimeEditor` consumes that same decision and hides unavailable picker
buttons in both Session reminders and Temporary-computer package expiry. Manual
date/time editing and domain validation remain unchanged, including the reminder
modal's saved-reminder/preset-retry flow. Equipped binaries keep their native
picker; web retains its JavaScript picker.

This preserves older-native/new-JavaScript behavior only where the actual OTA
runtime admits that combination. It does not establish that a particular 0.2
binary is eligible for 0.3 updates. Remove the guard only when no supported
eligible binary can lack the SDK; delivering native modules still requires a
native app build.

### Voice duration settings (0.3 development)

The canonical Local conversation and Local direct settings schemas accept
positive integer speech-request timeouts, retaining only the JavaScript timer
maximum of 2,147,483,647 milliseconds. Local conversation accepts positive
integer idle-agent TTLs in seconds without a Happier upper bound. There is no
protocol minimum of sixty seconds for idle TTLs or one thousand milliseconds
for speech requests.

The released `ui-web-v0.2.15` and `ui-mobile-v0.2.15` readers at
`88d45f33a5e5faf3235f621ee168a6f0ca58762d` admit idle TTLs of
60–21,600 seconds and speech-request timeouts of 1,000–60,000 milliseconds.
Their parser rejects an out-of-range Local adapter and retains its defaults.
On 2026-10-08 the maintainer explicitly approved longer values and removal of
unsupported lower bounds, accepting this older-client defaulting consequence.
Current readers still accept settings within the released ranges; current
writes preserve admitted values without a transition, shim or parallel policy.

### Voice presence settings (development)

The device-local `voicePresenceContainer` chooses `top_bar`, `island`, or `orb`.
Missing or malformed values resolve through the existing local-settings parser to
the responsive default: Island on phones, Top bar otherwise. Container selection
does not change the admitted attempt, microphone, transcript, or Account-scoped
conversation settings.

The inspected clean `../0.2` Voice and local-settings owners at
`388915739e64655b454e0bee8198833a54e6eabc` retain Account `voice.ui.surfaceLocation`
(`sidebar`, `session`, `auto`) but have neither of the old orb booleans. Current
ingress still accepts that Account field; it is not the new placement authority.
The replaced `voiceOrbEnabled` and `voiceOrbExpanded` were 0.3-only choices, so
their removal does not create a predecessor-data migration or a second writer.

Private owner Voice bindings retain optional nullable `targetServerId` alongside
`targetSessionId`, matching the current Home-qualified Voice binding writer.
The strict owner envelope preserves that field; the shared projection does not
disclose the binding. The inspected current `../0.2`
`voice/sessionBinding/voiceConversationBindingMetadata.ts` writer omits the
field, and those bindings remain readable through the same current owner.
No new caller authority, persisted format, or old-component rollback path is
introduced.

### Native voice word segmentation (development)

Voice endpoint and client-owned interruption policy share one Unicode text
normalizer and meaningful-word owner. Browser word boundaries use
`Intl.Segmenter`; native boundaries come from the UI-local
`HappierTextSegmentation` module using Apple's `NLTokenizer` and Android ICU
`BreakIterator`. The bindings provide boundaries only: phrase matching, noise
filtering and the measured short-word backchannel gate remain JavaScript-owned.
Native dictionaries can differ around a word-count threshold; release QA checks
CJK and Thai short acknowledgements and multi-word turns on both platforms.

An eligible OTA update cannot add this module to an older installed binary.
Resolve native capability lazily when its word-gated voice path starts and
refuse missing capability through the existing visible
`provider_setup_required` failure, rather than weakening word gating or
failing app startup. Unrelated operations remain usable. This is current
development source, not evidence that a particular older binary admits the OTA
or that native release checks have passed.

### Native mode catalog projection (development)

`sessionModesV2` adds an explicitly unknown accepted current mode independently
of known available options. Its canonical Protocol reader accepts retained strict
`sessionModesV1` and `acpSessionModesV1` records, but a present malformed V2 record
cannot fall back to stale V1 state. One current-authorized publisher writes V2
and projects unchanged strict V1 only when accepted current is known. It does
not write null, sentinels or additional properties into V1, or treat desired mode
intent as accepted. Agent transitions clear all catalog generations together;
forks retain the same canonical facts without inventing a selection.

This is current 0.3 development metadata, not a new 0.2 reader obligation or a
mixed 0.2/0.3 coexistence promise. The supported one-way upgrade retains V1 data
and reads it through the same canonical owner. See [the catalog owner](agents-catalog.md)
for the native source and publication lifecycle.

### Terminal metadata projection (development)

The released `ui-web-v0.2.12` terminal reader at commit
`a357c65536ba89669422977d6f7daf9aa0d17e73` rejects `herdr` in both terminal
enums. Where an existing legacy flat-metadata flow reaches that reader, current
writes project the enum values to `plain` and carry Herdr through additive
`hostKind` and `requestedHostKind` properties. The shared Protocol terminal
owner immediately restores the canonical host and removes those recognized
selectors on read; opaque metadata fields survive the round trip.

This is a bounded terminal-field seam, not support for an older UI opening 0.3
Account-owned envelopes or participating in the all-component upgrade. Layout-1
writes retain their Account encryption and strict owner envelope. Its terminal
schema composes the same canonical known fields with the existing closed,
bounded policy rather than keeping a separate host enum or an unknown-field bag.
The pinned historical terminal reader fixture validates only the flat seam.

### Terminal workspace and RPC attribution (development)

Ensure and Restart use the same terminal launch request schema, including optional
`sessionId` attribution. Current session controllers send it for either operation;
Restart can also retain the previous PTY's attribution when a caller omits it. The
request field supplies attribution after daemon state loss without introducing
durable terminal identity. Session-restricted RPC owners reject a different Session.

The inspected clean `../0.2` terminal RPC and Protocol owners at
`388915739e64655b454e0bee8198833a54e6eabc` accept extra launch-request fields but do
not consume this attribution. Current callers therefore remain accepted there,
without promising Other sessions discovery on that older daemon. The same
predecessor's Details and URL owners create only `terminal:embedded` with a
`{ kind: 'terminal' }` resource. The current workspace reader seeds that member
when predecessor workspace state is absent; an unresolved current instance is
unavailable rather than a request to create another shell.

### Terminal-host account settings (development)

The same released UI at `a357c65536ba89669422977d6f7daf9aa0d17e73`
strips unknown fields inside `sessionTmuxByMachineId` when echoing that map.
Non-tmux machine choices use the additive top-level
`sessionTerminalHostByMachineId` setting, which the legacy raw-baseline writeback
preserves. Protocol owns its schema and retained-shape normalization;
`terminalSettings.ts` owns the effective host for launch and presentation.
Modern edits patch that map and the legacy tmux projection together. None/tmux
choices retain the released boolean, session-name, isolation and temporary-path
semantics.

A released same-machine `useTmux: true` remains authoritative. Its false value
also accompanies non-tmux choices and cannot distinguish a repeated echo from
an intent to disable Herdr; older UIs do not gain Herdr controls. Protocol
normalizes the development-only nested `terminalHost` only when the new map is
absent, so an explicit new-map clear cannot revive it. Remove that development
reader once retained nested settings are no longer encountered. Immutable reset
keeps the canonical root absent and removes only its recognized nested aliases;
tmux options and unknown neighbors remain intact. After a lost write response,
the CLI confirms the reset only when replaying that same canonical mutation on
readback is unchanged. This seam
preserves retained settings shapes, not older-client access to 0.3 Account
envelopes or a mixed-version all-component upgrade.

### Current-Session presentation custody (development)

Current-Session presentation bind, acknowledgement, and retirement are
Session-owner-only RPCs. The Home stamps the authenticated Account and exact
socket connection onto the private forwarded authorization context; public
`clientId`, focus, and acknowledgement fields never establish custody. The
UI issues these connection-affine RPCs only through the active Home's persistent
socket: an active-socket pre-issuance failure is preserved, and an explicit
non-active Home fails closed instead of creating an ephemeral scoped socket. The
daemon accepts an acknowledgement or retirement only from the exact origin that
won the current process-local binding, and the Home retires that origin when its
socket disconnects. A mounted UI also retires the exact binding on unmount or
Account/Session-scope retirement. Rejected binds are read-only and do not clear
an incumbent command.

This contract is development-only and ephemeral: it adds no persisted binding,
lease, timer, generation, or compatibility registry. The inspected prospective
`../0.2` predecessor has no Current-Session presentation RPC, so there is no
older wire shape to retain; new callers fail closed when the method is absent.

### Organization standing snapshot readers (development)

The development `GET /v2/session-organization` accepts `projectionVersion=2`
from current readers and returns every requested attention standing. This changes
neither the persisted standing format nor the snapshot's `schemaVersion: 1`.
Without that declaration, snapshots containing at most 500 standings retain the
released representation. A requested standing snapshot above 500 returns HTTP 426
with `error: 'client-upgrade-required'` and
`requirement: { v: 1, kind: 'session-organization', minimumProtocolVersion: 2 }`.
Only that refresh requires an updated client: writes and reads that do not request
standings remain available. Rows are never truncated or deleted for compatibility.

The bound belongs to the strict reader released as `ui-web-v0.2.11`
(`98ea8fb76733b1dd785d38c31360179cafa84824`), not to current product capacity.
The HTTP adapter owns this projection check; organization queries and mutations
remain the single domain owners. Remove the legacy check only when support for
that released reader is explicitly retired. The inspected released server query
whitelist ignores the new query parameter; this does not expand the supported
old-Home directions of the one-way 0.3 transition.

### Browser request headers and CORS

A new browser request header changes both the endpoint contract and its CORS preflight contract. Before shipping one, test the new client against the exact supported predecessor relay and verify that every value in `Access-Control-Request-Headers` is already accepted by that relay's `Access-Control-Allow-Headers`. Adding the header to only the current relay's allowlist does not preserve new-client/old-relay compatibility: the browser rejects the request before the endpoint can negotiate or degrade it.

Prefer an existing CORS-safelisted header, a query parameter, or the request body for non-sensitive capability negotiation. Use a custom request header only when its semantics require one and supported predecessor relays already allow it or explicitly negotiate that support. Validate the real `OPTIONS` request for every reachable browser-origin/relay direction rather than relying only on same-process route tests. When browser code needs to read a new response header, include and verify the corresponding `Access-Control-Expose-Headers` contract as well.

### Self-hosted relay release checks

The public release profiles treat self-hosted relay upgrades as independent
component upgrades, not as a fleet migration protocol. For a stable release,
prioritize these directions:

- current UI, CLI, and daemon core flows against a supported older
  self-hosted relay;
- bounded core flows from a supported older client or daemon to the current
  relay, preserving unaffected operations and returning a typed update
  requirement only for an unsafe operation;
- persisted state written by the supported prior release read by current
  readers; and
- current-writer to supported old-reader only when rollback or coexistence
  can actually make that direction reachable.

The release agent derives the affected, reachable directions from the actual
diff and supported released baselines while it performs the initial release
inspection, before release-note/version materialization or a release commit.
That single inspection also owns the public-note proposal and validation
selection. After materialization, the agent only confirms that the final delta
contains the approved release inputs and no unexpected runtime-reachable
change; a full second analysis is required only when the source contract
changed. Exact scripts can prove named behaviors
against named artifacts—for example the published-server-v0.2.1 pending-queue
regressions or a `docker-release-assets` published-channel → local-build
upgrade—but none of them issues a general compatibility verdict. The Docker
upgrade suite runs in a normal profile only when the diff affects relay
storage/schema, startup/runtime dependencies, authentication persistence,
encryption storage, or upgrade behavior, the release changes the server, and a
supported published relay predecessor exists. A server version change alone is
insufficient. Broader installer, platform, and
historical-version exploration remains risk-selected deep certification.
Release orchestration does not wait for every
self-hosted process, impose a mandatory client floor, orchestrate a database
migration, or coordinate a global cutover.
If a concrete migration has a writer-drain or maintenance-window requirement,
its dedicated migration procedure owns that external operation.

### Connected Account Pool selection clock (development)

The qualified V4 group row owns the active member and its selection time together.
Every member change writes `state.activeSince: { accountId, atMs }` and the same
`state.lastSwitchAt` in the selection transaction, including automatic switches
and fallback after disabling or removing a member. Re-selecting the same member
keeps its time; runtime status writes cannot replace it. Clearing the active
member clears both timestamp fields.

`useQualifiedConnectedAccountGroups` exposes that identity-bound `activeSince`.
An older row without a matching identity-bound clock remains readable, but its
selection time is unknown: historical `lastSwitchAt` alone cannot label the
current member. This is the Pool selection time, not evidence that an existing
Session has hot-applied that account. The inspected clean `../0.2` group schema
at `17ba05df68d4d3d4cad1c1241b58e63805db37ed` has optional `lastSwitchAt` and no
`activeSince`; those persisted rows need no backfill or invented clock.

### Automatic pool quota-reset opt-in (development)

The shared V1 pool policy accepts optional `autoUseQuotaResetsWhenExhausted`;
absence means false and is not materialized on reads. Current qualified V4 pool
routes mask this field while `connectedServices.autoQuotaReset` or a dependency
is disabled. They preserve the saved choice, and policy edits merge against stored
policy so an edit from a masked reader cannot erase that choice. Re-enabling the
feature makes the stored choice effective on subsequent recovery reads.

The UI offers the opt-in only with the server feature bit and an applied Connected
Account descriptor declaring `recoveryCredits: { supported: true }`. The descriptor
fact is projected with the service; the runtime additionally requires the matching
recovery-credit facet. Missing facts fail closed.

The 0.2 source-line Accept-header adapter protects strict released V3 group readers.
It is not revived on this development line: pools use qualified V4 identities and
the retired V3 group endpoints are not a current transport. This change does not
establish rollback from development V4 storage or plugin descriptors to 0.2.
The locally available stable and preview predecessors `server-v0.2.11`,
`server-v0.2.11-preview.2`, `cli-v0.2.11`, and `cli-v0.2.11-preview.2` all
resolve to `98ea8fb76733b1dd785d38c31360179cafa84824`; their route, API, and
Connected Account schema trees have no qualified V4 group transport.

### Pool quota-limit selection (development)

`quotaLimitSelection` is optional in the shared V1 pool policy; absence and
`mode: 'all'` retain predecessor behavior. Qualified V4 readers and writers use
the same policy owner, and older 0.2 readers reach their released compatibility
projection rather than the V4 transport.

`windowDurationMs` is an optional additive quota-meter fact. Updated readers use
it for presentation and expiry-first pool ranking; older readers ignore it.
Pool-selected display projection filters only meters and
preserves account-, subscription-, freshness-, and recovery-credit fields.

Expiry-first is the development default for new or absent pool policies. Explicit
`least_limited`, `priority`, and `manual` choices remain unchanged. Among eligible
members with fresh headroom above the existing soft-switch threshold, the daemon
prefers the earliest future reset of the longest selected usage allowance or an
independently fresh subscription end with renewal off. Unknown durations use the
effective allowance; stale, missing, renewing, and passed dates add no preference.
Ties and inadequate-headroom recovery retain headroom then member-order ranking.
Healthy active members remain sticky; this does not schedule swaps or restart sessions.

Qualified V4 pools consume the canonical policy directly. The retired V3 routes
remain retired: the 0.2 old-reader strategy projection and authoring-support bit
are not added to V4. Runtime quota-store and Provider Account Usage projections
share one meter normalizer, while policy-specific allowance filtering remains
selector-owned. UI summaries describe the strategy rather than duplicating the
daemon's automatic ranking; explicit manual switch suggestions use member order.

### Provider Account subscription facets (development)

The canonical V1 sealed usage envelope retains the predecessor's optional separate
`subscription: { observedAtMs, ciphertext }` facet. The Protocol opener verifies
its record identity and observation binding; corrupt or wrong-key facets fail
closed, never fall back to plaintext. New E2EE quota writes use the canonical full
envelope sealer, not the base-ciphertext-only helper.

The daemon quota coordinator merges subscriptions through the shared
`mergeProviderAccountSubscription` owner, both after a cold V4 read and before
scalar or qualified writes. A quota-only refresh retains the last valid
subscription; a failed subscription refresh retains it with its refresh error.
Subscription changes participate in the existing material fingerprint so they
are not suppressed as unchanged quota data. Plain writes use the same semantic
merge; opaque server storage preserves the separate E2EE facet without opening
it. No parallel persistence format or subscription reader is introduced.

The development Connected Account SDK quota result now admits optional
`ProviderAccountSubscriptionV1`; its host result owner snapshots the trusted
in-process SDK result before the coordinator consumes it. External quota wire
and persistence readers still validate the shared strict schema.
Plugins omitting the field retain their quota behavior. This is a development
author-surface extension, not a predecessor SDK contract or a promise that an
older host accepts newly authored plugin results.

The inspected clean `../0.2` usage paths at
`17ba05df68d4d3d4cad1c1241b58e63805db37ed` supply the separate-facet input contract;
development V4 qualified account transport is not a promise that older clients
can consume that transport.

### Model-entitlement pool disable opt-in (development)

`autoDisablePlanInvalidAccounts` is another optional V1 policy field whose
absence means false. Qualified V4 routes expose and accept it only while
`connectedServices.autoDisablePlanInvalid` and its fallback dependency are
enabled; masked policy edits preserve any stored choice. No 0.2 Accept-header
adapter is revived on this line.

The Codex plugin emits model-scoped `plan_invalid` evidence for explicit
ChatGPT-account unsupported, unavailable, or not-enabled model responses. The daemon records a 24-hour
per-model exclusion. When the pool opt-in is true it also disables that member;
manual re-enable clears the automatic-disable marker and runtime blockers.
Generic or provider-scoped `plan_invalid` evidence never triggers persistent
disable. Qualified V4 persists the marker, model cooldown, and disabled flag in
one member mutation guarded by both group generation and runtime-state revision.
For a finite Run's rejected initial input, the provider also attests that no
turn work was accepted. The Run's scoped materialization bridge validates the
exact activation, runner, member, generation, credential revision and model
before the existing pool coordinator records the exclusion and selects another
member. These rejected starts do not consume turn or hourly switch limits;
ordinary switches retain those limits. Exhaustion reports
`connected_service_run_model_unavailable` with the requested model. This is an
unreleased 0.3 source contract, not a change to the predecessor's daemon. Detached
Codex's canonical Run host now supplies bounded native-home reads and Run-scoped
refresh through the existing materialization control channel and shared daemon
authority. Focused and composed source checks do not establish loaded-daemon or
released availability.
The projected `ConnectedAccountUiProjectionEntryV1` contract is also absent from
that predecessor; its current strict development schema adds the optional
recovery-credit declaration together with its producer and UI consumer.

### Direct sharing and Account erasure (development)

The development Account-erasure transaction preserves direct grants that the erased
Account authored on somebody else's Session. The canonical grant service reassigns
their non-null `SessionShare.sharedByUserId` to that Session's owner, preserving the
grant identity, access level, permission delegation, key envelope, and creation time.
This field is current compatibility provenance, not immutable audit history or access
authority. Existing direct-share readers continue to receive a real Account profile.
Received grants are removed, and owned Sessions use the ordinary recipient-aware
deletion lifecycle. Direct and public access logs retain their existing policies:
erasure removes logs identifying the erased Account, and deleting a share cascades
its logs; logs for surviving shares and other Accounts remain subject to normal
retention.

### Session access projection normalization (development)

Retained 0.2 public Session links keep their legacy token and wrapped-key
derivation. Flat layout-0 metadata is not recipient-safe: anonymous reads return
typed `metadata_privacy_upgrade_required`, never the raw flat metadata. On the
owner's initial 0.3 visit, authenticated owner-only discovery includes pending
shared Sessions outside the active list, and the existing currentness-checked
metadata tuple writer upgrades them. The same link then reads the recipient-safe
projection. The pending viewer asks the owner to open Happier; it does not treat
the privacy refusal as revocation or silently weaken the projection. This is a
retained-data upgrade direction, not a new old-server fallback or rollback claim.

Current Session readers treat a valid strict `effectiveAccess.v = 1` projection as
the sole access presentation authority. A present but malformed current projection
is unavailable and cannot fall through to released owner/direct inference. Only
true absence of `effectiveAccess` permits the released `share` translation; that
translation never represents Team- or Group-only access.

That rule has one implementation: `readSessionAccessProjectionRoleV1` in
`packages/protocol/src/sessions/access/sessionEffectiveAccessV1.ts`, which maps a Session
record to `owner`, `recipient`, or `unavailable`. It is representation normalization only
and never decides authorization. A record with neither field is treated as released owner
content when `metadataLayoutVersion` is absent or `0`, and as unavailable otherwise, so a
newer layout a reader does not understand fails closed instead of being read as ownership.
Persistence keeps the same separation the projection does: `SessionShare` is the direct
grant table only, while `SessionTeamGrant` and `SessionGroupGrant` hold collective grants
that a released reader never sees — see
[session-collaboration.md](session-collaboration.md).

The UI preserves the same distinction through hydration, access events, Voice,
encryption migration/key resolution, and reconnect state. Its additive warm-cache
field stores the current effective projection, or `null` for malformed-current
unavailability. Older cache entries without that field remain readable through the
released flattened fallback. Released direct-share events may refresh a normalized
legacy projection only when it has no current `sources`; they never replace a
sourced current projection or the fail-closed `null` marker.

Server-side, the released owner/direct seam and the version-qualified current seam
are two presentations of one access decision, not two admissions. Released
unqualified V2 lists and unqualified by-ID detail leave Team and Group grants out
of the answer, but they resolve through the same
`resolveSessionAccessForOperation` owner, so omitting `accessProjectionVersion`
cannot widen a credential: a verified Session-scoped Runner principal stays a
capped `edit` recipient with no owner metadata on both projections, and its
persisted activation/Machine/AccessKey binding is revalidated on both. The
released branch passes the row it already loaded to that owner rather than
projecting access itself.

The prospective `../0.2` predecessor inspected at
`ac30c50856abd2265c14459e77ee3384da1698ad` (branch `dev`, clean) in the relevant CLI/UI
Session-detail consumers:
`apps/cli/src/session/transport/http/sessionsHttp.ts`,
`apps/ui/sources/sync/engine/sessions/sessionById.ts`, and
`apps/ui/sources/sync/runtime/orchestration/serverScopedRpc/fetchSessionByIdWithServerScope.ts`.
The committed Account/client encryption requirements do not change listing
or access-projection behavior. The predecessor still has no `effectiveAccess`
producer or consumer and no ephemeral Runner. Its `V2SessionRecordSchema` and
`SessionSummarySchema` remain `.passthrough()`, so current additive projection
fields are accepted. The former direction "a 0.3 client against a 0.2 Home", which the
server-only `sessions.collaboration` decision and a UI direct-only legacy share adapter
served, is not supported under the one-way 0.3 upgrade (every component updates to 0.3
together, no rollback); that bit, its `HAPPIER_FEATURE_SESSIONS_COLLABORATION__ENABLED`
switch and the adapter were removed on 2026-09-24. Current clients select the
version-qualified projection, Team/Group grants and initial access from the exact Home's
`sharing.session` decision. The surviving obligation is data: direct shares a 0.2 Home
persisted in `SessionShare` remain effective and readable in 0.3 through the same
access evaluator, independently of that decision.

### Session draft rollout

The current development UI stores browser draft repositories and pending-message outboxes in
IndexedDB, outside Web Storage's small synchronous quota. Native clients retain MMKV. Browser
startup prepares drafts before restoring Sync or rendering draft consumers; a failed preparation
uses the existing app recovery boundary rather than treating saved drafts as absent.

The draft repository writes a compact local v2 envelope and reads both v1 and v2. Equal base/local
documents and pending fields are stored once and reconstructed on read; independent conflict
values are retained. This does not change the synchronized draft document or server wire format.
Older UI binaries cannot read this local v2 representation.

Legacy browser values are removed only after their IndexedDB transaction commits. Migration
preserves conflicting copies and reports a failure instead of silently choosing one. Reload older
open tabs when updating the UI so they stop writing the retired Web Storage records. Concurrent
editing from an unupgraded tab during migration is not supported: old Web Storage writers cannot
participate in IndexedDB transactions. Browser
outbox operations await local transaction completion before reporting local custody; enqueue
acknowledgements cannot retire a concurrently recorded cancellation.

Draft autosaves retain failed writes in memory, expose the existing error status, and retry through
the repository's flush owner. Browser draft updates preserve unrelated replicas written by another
tab and reject conflicting changes to the same replica. IndexedDB still has browser/disk limits:
an error is not permission to discard drafts or pending messages, and unsaved in-memory edits must
be preserved before reloading. These device-local stores are not substitutes for server acknowledgement.

Synchronized Session drafts are negotiated through the `sessions.drafts` server feature bit. A new
client fails closed when that bit or the typed routes are unavailable and retains the incumbent
local-only behavior; it does not send draft records through generic Account KV routes. A capable
server reserves the draft KV prefix so old generic-KV clients cannot read or overwrite typed draft
rows.

Development V2 draft operations use the same repository, physical rows and CAS while preserving
strict V1 reads, writes, conflicts, cursors and events. V2-only Run/discussion addresses and
successor new-Session content use the distinct V2 socket and AccountChange hint schemas. Current
clients materialize their exact addresses before advancing the change cursor. Account encryption
transitions opt into the V2 draft directive only when the captured new-Session content needs it;
older strict servers reject that directive before mutation. The
[Account transition contract](./encryption.md#account-mode-transition-status) owns resealing and
replay; Session-bound drafts never participate solely because their address uses V2.

### Automation predecessor data (development)

The 0.3 development line updates server, daemon and clients together, without rollback.
Undeployed 0.3 snapshots and earlier recipe spellings are not compatibility contracts.
Current Automation transports use V3 directly; there is no V2 route, API-epoch probe,
representability adapter or older-component update-required fallback. This does not
remove the canonical Automation feature gate or Account authorization.

The development V3 Run list also serves Account-wide attention at
`GET /v3/automations/runs?attention=required`; the definition-scoped list accepts
the same filter. It includes ordinary failed, dispatch-failed and uncertain Runs,
plus blocked Channel reply handoffs, even when no Session was created. Accepted
managed Workflow Runs remain under their existing attention predicate. The list
returns paged structural summaries, without private execution content or per-Run
history reads. Inbox consumes this membership through the shared Run-window owner
and opens the exact Automation Run route. Existing lifecycle changes clear
membership; this read adds no acknowledgement or permanent-dismissal contract.

The compatibility obligation is data created on 0.2. Its stored manual schedule maps
to zero automatic triggers; retained cron/interval schedules and enabled Machine
assignments remain readable through the current server's stored-row projection.
Reading those rows does not recreate a V2 runtime or old-client API.

In 0.3 development source, retained 0.2 `templateCiphertext` rows use the
Protocol-owned `automationTemplatePayloadV1`/`automationTemplateStoredV1` codec
in the daemon, Account trigger projection and UI read adapters. Explicit plain
and encrypted V1 envelopes, including the predecessor outer Session-id
consistency check and template-only raw-secretbox recovery, remain readable;
the Account host checks persisted Account mode before opening content. On a plain
Account the only encrypted execution exception is the explicit predecessor
existing-Session template, bound to an authenticated retained E2EE Session whose
envelope the device can open. The server validates that exact same-Account Session
binding, not arbitrary ciphertext. A keyless reader projects a locked legacy row
with deletion available. Generic Account crypto does not gain an
untagged-ciphertext fallback.

The Account transition converter owns explicit per-row recovery of predecessor
templates targeting a plain Session or no Session. It uses genuine historical
material, writes canonical plain content through `templateVersion` CAS, and does
not repeat an already-plain write. A failed decrypt stays locked; a CAS conflict
requires a fresh read. Templates bound to retained E2EE Sessions are not rewritten,
and their historical material remains in existing device custody until no longer
needed or explicitly discarded. These are development-source upgrade guarantees,
not evidence that the loaded runtime or a release has been certified.

Retirement also retains material for returned encrypted trigger definitions and
opaque predecessor Run summaries. The 0.2 transition did not convert Run summaries;
current inventory can return their explicit `legacySummaryCiphertext` representation
even on a plain Account. Recovery does not reinterpret or rewrite that history.

The existing V3 PATCH mutation remains closed. Its recovery-only
`templateCiphertext` input is mutually exclusive with `executionRecipe` and is a
direct cut of the undeployed 0.3 request, not an ignorable extension promised to
an older server. The current CRUD owner requires the stored predecessor source,
plain Account mode, unchanged target and revision CAS; ordinary recipe writers
cannot use it to downgrade current content. No reverse 0.3-to-0.2 write or rollback
adapter is introduced.

The trigger projection carries `legacy: { editable: false, reason: 'created_in_0_2', placements }`
alongside the retained prompt, target and schedules. The read-only `placements`
array contains each enabled assignment's `machineId` and template `directory`,
including zero or multiple assignments; those rows do not invent a single
`project`. New trigger writes remain single-project. For an existing-Session
target without a single assignment, the Session owner resolves its actual
machine; unavailable Session authority leaves that target unavailable rather
than choosing an arbitrary assignment. Reading does not migrate a row.
The UI identifies these rows as created in Happier 0.2, not deleted workflows.
Opening the Account trigger popover changes nothing. A reviewed edit uses the
shared trigger form and `workflow.trigger.update`, discloses the Happier 0.3-or-later
execution boundary before Done, and retains the draft when conversion is refused.
Each schedule in a plural set is addressed by its own trigger id; a manual row
keeps the existing Automation Run now and never gains an invented schedule.
Trigger removal needs no conversion; a legacy toggle requires explicit review.
Enabling an individual trigger in a disabled set is one revision-checked
reconciliation: only that trigger becomes effective, not its disabled siblings.
Conversion uses the existing inline representability owner
and one Automation revision-CAS write, with no Artifact creation. Until Channels
supplies an authoritative Account-scoped association/absence observation,
conversion refuses `legacy_conversion_unsupported` with
`channel_association_unknown`; a proven bound row refuses `channel_reply_handoff`.
Unrepresentable settings also refuse without rewriting execution bytes.
Conversion writes the current Workflow recipe for the current daemon. This is
development-source behavior, not released or live-QA evidence.

The retired `/automations/[id]` and `/automations/edit?id=` routes only resolve
the existing direct Automation read, then open the bound workflow's trigger
section or the Account trigger popover in Workflows. A deleted row lands in
Workflows with a not-available line; a transport failure keeps Retry rather than
claiming deletion. The full parallel Automation editor is removed, not the
retained template codec or historical data.

Current development trigger-set projections use the Automation's `templateVersion`
as their revision. Trigger authoring writes advance it in the owner's transaction,
including recipe-free removal and individual trigger CRUD. Current strict recipes
advance their outer `templateVersion` with the row
without opening or resealing private envelopes; retained 0.2 template bytes remain
unchanged. Trigger-local revisions remain independent. A delayed pre-removal list
therefore cannot replace the newer removal result in the shared UI store.

### Workflow Session input admission (development)

Current development Workflow definitions accept declared decisions beyond
`continue | stop`, including strict `{decision, reason?}` results, and input-bound
`until`/`evaluate` round limits. Admission freezes a positive safe integer; inline
Workflow frames retain their resolved inputs in sealed body progress. Loop
closing records add a strict decision/stop-condition/exhaustion outcome; exhaustion
now completes successfully. Existing `continue | stop` and bare-string results
remain accepted, and existing iteration-array result paths remain unchanged.
Current authored references additionally accept a value-only item `path` and
the `last` array result-path segment. Numeric array paths and object properties
retain their meaning. Older development readers reject or misinterpret these
new forms; the current reference schema and input resolver move together.
This is an undeployed Workflow direct cut, not a released-format compatibility
shim. Old development readers cannot execute these new definitions correctly;
use the current admission and coordinator together. No new rollout mode or
dual writer is introduced.

Inline Workflow body progress also retains the selected project workspace as
`frameProjectWorkspace`, including its generated-checkout creation intent.
The frame's separate `workspace` pair owns the child's lazy generated default.
Current readers preserve and verify both pairs on resume; a deleted or mismatched
recorded checkout is unavailable and is never automatically recreated. New
generated frame-project names use a project-slot suffix; the child's default
keeps the invocation-qualified default name. Recorded intents keep their names.
Explicit restoration resolves an unmaterialized child's default through the
canonical frozen ancestry owner. A frame can propagate either slot's failure,
so restoration verifies all its recorded generated pairs before publishing a
replacement attempt; it does not guess the failed slot or recreate a checkout.
This is the same
undeployed direct cut: the strict V1 private progress shape changes with its
coordinator and readers, with no older-development reader or rollback shim.

Workflow child prompts use Session input admission protocol V2 with the invocation
purpose and Workflow Run provenance. Direct final-result delivery no longer writes
a Session Pending input: the origin runtime pulls current Run state into the host's
context-only WorkerUpdate slot. Neither path invents an Automation id or uses
Automation reply handoff. Updated Session readers
accept both V1 and V2 request, provenance and settled-authority records, while
Automation and other incumbent V1 writers retain their existing shape.

Automation workflow definitions use the strict stored recipe epoch `v: 2` in
the existing private Automation definition body. They have no synthetic legacy
target projection (`targetType` is `null`). At occurrence admission, the
incumbent Automation transaction creates the parent Run and attaches its opaque
definition envelope; occurrence evidence remains a separate frozen Automation
envelope. Before root coordination, the assigned daemon binds its canonical
payload to declared inputs exactly once and seals the immutable accepted
workflow snapshot used by origin-neutral Runs. Actual 0.2 one-shot templates and
their retained Run data remain readable by current workers. The current strict
one-shot recipe is not an adapter for obsolete copied Workflow definitions.
Retained 0.2 flat-template prompts stay literal, including brace text, when run
or explicitly converted to a Workflow; native current one-shot input-token rules
do not reinterpret or restrict those historical prompts.

Explicit conversion in 0.3 development requires the Channels binding-read owner
to establish that the exact Automation has no retained binding. Disabled and
deleting bindings still count; unavailable, corrupt or mismatched observations
never become absence. Existing-Session conversion also requires that Session's
current Agent identity and project, with its Machine matching the retained
assignment. The shared trigger owner writes the inline recipe through the existing
Automation revision CAS; unsupported templates remain unchanged with a typed
`legacy_conversion_unsupported` reason.

Predecessor recovery follows the Account-transition and retained-Session paths
described above. The 0.2 transition to plain could leave Automation ciphertext
whose outer template requires genuine historical Account material; its embedded
Session key does not decrypt that outer template. Plain/no-Session-target rows
can be explicitly recovered to canonical plain content through the existing
converter and `templateVersion` CAS. Templates bound to retained E2EE Sessions
stay encrypted and execute through that Session's authenticated envelope on a
key-holding device or daemon. A keyless reader stays locked with deletion
available. Historical material stays in existing custody; discarding it is an
explicit user action, not a generic reader fallback or recreated Account key.
These implemented development paths do not certify a loaded runtime or release.

The current development trigger context replaces the earlier copied-definition
payload in place. It seals workspace, execution target, constant inputs, optional
role overrides and either an inline definition or context for the row's live
`workflowDefinitionId`; the assigned Machine remains in Automation assignments.
`readTriggerTargetV1` rejects missing or ambiguous targets. Library, `builtin:`
and qualified `plugin:` references share one parser; parsing does not establish
catalog availability. This is not a released V1 format change. Direct admission
and Automation claims share the Protocol accepted-snapshot materializer: it
normalizes the program, freezes role overrides and child definitions, derives
the effective permission ceiling, applies ORC policy, checks the assigned
Machine's targets, then seals. Unsupported catalogs fail closed. Frozen
`causeWorkDepth` travels in the Automation claim receipt,
not private trigger input, and scoped conversation causes may carry `triggerId`.

Saved-definition admissions freeze `source.savedBy` for direct and Automation-origin
Runs. The field is required for a saved source; an explicit null records a header
without authorship. It is private display metadata, not execution or authorization
authority. Accepted Runs never re-read the mutable header to recover authorship.

Accepted development snapshots require `workDepth`, `authoredDefinition`,
`materializedLeaves`, `frozenChildren` and explicitly nullable display metadata.
There is no pre-materializer snapshot fallback. Fresh
Session and detached Agent steps receive the accepted depth plus one; protected
Workflow input and provenance depths must agree. `profileId` denotes a Launch
Profile, never a plugin execution-run profile. Detached steps freeze portable
Launch Profile defaults at admission and refuse nonportable profile behavior;
dispatch does not look up execution-profile custody. Loaded-runtime and package
validation of this finalization remains tracked by the implementation lane.

The internal Workflow storage admission operation accepts only a direct origin,
and its authenticated publisher Machine must equal the target Machine. An
Automation occurrence never enters through that route: its canonical Automation
transaction creates the parent and attaches the Workflow body there.

At `accepted-snapshot.resolve`, a scoped Automation freezes its Account-owned
`scopeSessionId` into the Run's `originSessionId`; the server checks both the
current scope and Session ownership. This context does not change the Run's
Automation origin or immutable cause. Explicit originating-Session delivery
initializes the same acknowledgement as direct admission; otherwise it remains
null. An exact acceptance replay uses the frozen scope and delivery choice,
preserves an advanced acknowledgement, and does not reread a later scope edit.

Development Run projections retain a nullable `sourceArtifactId` frozen at
direct admission or Automation accepted-snapshot attachment, plus
`ownerAccountId`. Inline/catalog Runs retain a null source; private snapshots
are not server-decrypted to infer a source.
`workflow.run.list` without a source filter lists the caller's own Runs. A source
filter selects that workflow's caller-visible history. Current development
Team visibility requires the Run's exact frozen Team grant on the source
Artifact and the caller's live effective membership in that Team; personal or
other-Team grants alone do not preserve it. Exact reads, source-filtered history,
summaries and recipient-key census consume the same Run access owner.
Cursors bind both Account and source/filter scope. `workflow.run.summaries`
reads the requested saved-workflow ids in one indexed batch and returns latest,
recent and Needs-you facts with byte-bounded `remainingSourceArtifactIds`.
List, wait and summaries share the server's attention predicate: interrupted
Runs, terminal Runs retaining child custody, or actionable invocation rows.
Failed origin delivery and a settled exhausted result do not add attention.
Lean list rows expose `attentionRequired` from that same membership, including
exact Run reads used by Boards. Other projections may omit it; omission is
unknown, not false. Ordinary child-row wakes refresh this fact without advancing
the parent control revision; aggregate attention-membership changes advance the
existing parent revision as described below.

Workflow Session inputs use the current input-admission owner directly. There is
no older-daemon capability preflight or V1 downgrade before creating or mutating
a Session; the strict input/provenance parser still rejects malformed content.

Each Workflow invocation input has one protocol-derived stable identity including
its exact invocation record. Ordinary Session steps use the existing Pending queue;
`origin_session` steps use the required context-only `workflow_step` input and the
origin's input-admission owner. Originless admission refuses an `origin_session`
leaf with typed `invalid_input`. The producer freezes its rendered text alongside
the admitting correspondence; the origin consumes that exact text without a
second role or result-contract renderer. General authored/recovery input can exist
before rendering, but an origin input cannot be consumed without its frozen text;
this is a current admission phase distinction, not an older-snapshot reader.
Only the input owner decides withdrawal. A positive host
event restores dispatched custody after restart; a missing event does not prove
withdrawal. Permission settlement and the exact-turn transcript observer remain
authoritative. An omitted Workflow timeout selects explicit no-deadline observation;
a supplied timeout starts at the accepted host event and is not restarted on rejoin.

Origin Run delivery stores nullable `originDeliveryAckRevision`: null disables
delivery, and enabled admission initializes it to zero. The origin reads current
snapshots above this acknowledgement and advances it monotonically only after
provider acceptance. Aggregate attention-membership transitions advance that same
Run revision: the first hold above a zero acknowledgement and a later re-entry
after acknowledgement are deliverable, including when the origin reconnects.
Ordinary child facts remain row-local; siblings entering or leaving a hold while
the Run still needs attention do not advance its revision. Fact acknowledgements
include `parentRevision` from the same storage transaction; workers adopt it
monotonically before their next parent CAS. A failed acknowledgement for one Run
remains retryable without stopping delivery for other Runs in the origin Session.
Pull and exact Run reads use the shared attention predicate, so admission
rechecks reject a resolved
or superseded snapshot. There is no second delivery cursor or replay of resolved
holds. Delivery does not hold invocation custody. The retired
`result_delivery` input purpose and `workflow_result_delivery` provenance are not
accepted by current development readers; the distinct Automation/Channels reply
handoff remains unchanged. This is an undeployed Workflow direct cut, not a released
Session V1 removal. Package and loaded-runtime verification remain pending.

Workflow-only `attached_run` execution is retired in current development source
(FIN U5 feature removal). Workflow targets are Session or detached Background run;
the retired target and its private correspondence are rejected, not reinterpreted
as Session execution. Native Session-attached Execution Runs outside Workflows
remain unchanged. Detached starts require the real initial prompt.
The daemon derives the Run identity from the existing
host-stamped Action request id for the exact Workflow input, so a response loss
or failed correspondence write rejoins the already-started Run instead of
starting or sending it again. This is Run-manager idempotency over the existing
Workflow input identity and Run registry, not a second Workflow receipt store.

Boundary Resume's content-free `workflowResumeRequestedRevision` is a nullable
Run column and an optional field on the closed V3 Workflow claim and existing
claim receipt. A successful claim clears the column in the claim transaction
and passes the consumed revision to the current worker; a replay of that same
claim preserves its disposition, while a new claim omits it. Pause or Cancel
supersedes an unclaimed Resume. Null storage means no pending Resume, and absence
from a claim means it consumed no Resume; neither is an old-row compatibility
fallback. Managed Workflows are undeployed and have no released or 0.2 predecessor
seam: current server and worker are refactored in place, with no obsolete
development shapes or guessing from checkpoint pause state. Ordinary current
one-shot Automation claims carry no Workflow Resume request.

Workspace restoration is an explicit development-only `workflow.run.resume`
recovery choice. The server projects only coarse eligibility from public Run
state and the existence of an execution row; the authorized client opens the
selected private progress and qualified frame-owned correspondence and requires
recorded creation intents and Git worktree descriptors before offering Restore
workspace. Execution is routed to the exact Machine frozen in the accepted
snapshot, verifies only those recorded checkout paths through the incumbent
SCM currentness owner, and publishes the new
attempt under the same expected-Run-revision check before any retry work starts.
It never falls back to a suffixed or newly selected checkout. Because managed
Workflow Runs remain development-only, this closed Action/availability addition
updates the current protocol in place and establishes no released mixed-version
compatibility adapter.

Recovery eligibility belongs to the shared Account Run Action owner, which uses
exact input-owner observation and current conversation capability; prepared
continuation content is not eligibility evidence. Missing workspace and a stop
acknowledgement do not prove an input inactive. Replacing proven-stopped input
with uncertain effects additionally requires acknowledgement for that attempt.
Reattach observes the recorded input without starting, sending, or allocating an
attempt. Its signed Machine fact write uses the existing `invocations.fact`
operation with the exact row's `expectedContentRevision`, the observed parent
`expectedRevision` and `resolution: 'observed_terminal_execution'`
instead of a fabricated worker `parentAttempt`. The server requires the exact
assigned interrupted Run with pending custody and the current invocation; it
permits only observed settlement, preserving the parent revision and claim.
The incumbent claimed-worker fact shape remains unchanged. This observation
arm is development-only and changes no persisted format or released contract.

Managed Workflow Runs are origin-neutral `WorkflowRun` rows driven from the frozen
accepted snapshot; observed Claude activity snapshots remain presentation-only and
never drive the coordinator. Schedule and occurrence admission freeze the reviewed
definition plus applicable Artifact revision: later library or Automation edits
affect only future admissions, never admitted Runs. All 0.3 components update
together; older-component interoperability and rollback are unsupported. There is
no reverse migration, dual write, Workflow compatibility mode or rollback-only writer.

The current-development review cut adds invocation and parked-parent
`waiting_for_review`, canonical decimal `contentRevision` on every invocation,
and the outbound `review_required` update kind. Current producers and consumers
move together. Decimal strings are the current lossless JSON representation of
database BigInts, not a historical-format reader. Only a current completed invocation exposes successful result
data; a stored draft alone is not completion. Private Workflow payloads now use
per-run keys and strict owner/Run/purpose bindings. Pre-cut development content
is intentionally unreadable, without a dual-key reader or historical reseal.
The inspected `../0.2` Workflow owners are absent at
`17ba05df68d4d3d4cad1c1241b58e63805db37ed`; ordinary Automation and Session
data remain separate predecessor obligations.

The current Account-transition inventory GET reads the captured Home directly,
without an older-server feature probe or inventory-426 translation. Request failures
remain failures rather than a fabricated empty inventory. This development cut does
not activate dormant V5 or downgrade current requests to predecessor transition wire.

### Same-machine session handoff (development)

Same-machine handoff extends the current V3 operation without another transport or
persisted shape. Path-backed Sessions require an explicit, different local target
before the source stops. Managed Sessions retain their existing private-directory
allocation. The existing local durable bundle path works without a network transfer
carrier; the `sessions.handoff` feature decision still applies.

Source cleanup shares the target job locally, requires completed target commit, and
must not stop the successor by Session id. Abort preserves an already completed job.
Tracked cancellation remains available during preparation and closes before target
launch, which begins publishing the target's canonical Session metadata. The accepted
launch then completes confirmation, commit, and cleanup through its existing nonce
observation owner. This is development behavior, not a released rollback guarantee.
Predecessor request adapters and cross-machine transfer contracts remain seam-owned;
unsupported operation versions fail before execution rather than pretending to move.

### Workspace-sync handoff rollout

Workspace handoff is operation-scoped across UI, daemon, and Machine RPC versions. A current
client may send the canonical `none`, `copy_once`, `create_relationship`, or existing
`relationship`, or `linked_workspace` action only to a daemon that understands that exact action. A predecessor daemon
that cannot execute the requested workspace action returns
`workspace_sync_update_required`; the client keeps the connection and unrelated Machine/session
operations usable and asks for that daemon to be updated. It must not reinterpret the request as a
legacy file-transfer job or report a successful handoff without the workspace result.

The development-line `linked_workspace` choice carries only the target Machine/path in the
public Action. The current daemon resolves the admitted Session's source and the exact target
WorkspaceRefs from its current Account settings, then invokes the controller-owned
`daemon.workspaceSync.prepareBetween.v1` operation. A controller without that exact method
returns `workspace_sync_update_required` for the linked operation; the caller must not silently
fall back to a direct copy or claim that a first completed link prepared the destination.
The result records only the links actually traversed and their observed statuses. A later
retry starts a fresh route check, not a persisted cursor or replay of the second link.

The current daemon remains the sole relationship-settings writer and uses the external Mutagen
sidecar as the sole reconciliation engine. Mutagen session identifiers and private broker details
are daemon-local implementation state, not wire or persistence compatibility contracts. A missing
verified external engine artifact is an `engine_unavailable` failure for the requested workspace
operation; it does not authorize a fallback to the retired replication engine.

The current development Workspace Sync extension retains pairwise relationship persistence and
derives linked sets from their existing WorkspaceRefs and controller roles. It does not persist
a group or rewrite valid beta-controlled two-way relationships. Direct Project creation uses
`workspace.sync.relationship.create` and the same relationship writer and destination approval
owner as handoff; it cannot disguise existing-folder attachment as an older handoff request.

Current status replaces the unmeasured `changedFiles` field with no substitute count and names
the process-local cycle observation `lastCycleObservedAtMs`. Endpoint scan/transition problem
facts come from the matching engine producer. Missing endpoint evidence is unknown, not clean.
The controller's clean-result predicate gates dependent execution and fresh/recovered Copy once;
raw manual Flush remains a diagnostic operation. A completed cycle does not establish immutable
inputs or global convergence.

Reviewed conflict resolution refines the development Action in place: source and explicit
destination entry expectations are required, including complete structural identity for a
directory replacement. Historical approval records remain readable, but an older loser-only
pending request cannot execute by fabricating a reviewed source. Captured bytes use the existing
finite transfer, and target authority rechecks the approved effect. Partial and unknown outcomes
do not authorize automatic replay or unattended application to a later-reconnecting endpoint.
These current-development shapes do not create a second resolver or a compatibility alias for
an unshipped input. Exact operation support must be checked before effect; unrelated operations
remain usable when that support is absent.

The extended compact engine problem/selection contract requires a successor to the currently
pinned `0.18.1-happier.9` artifact. Source-built integration evidence does not activate that contract
in ordinary product runtime. Publication and adoption belong to the existing engine release/pin
owner; consumers must not guess missing fields, accept a second dialect, or silently run a dirty
fork as a fallback. This dependency remains pending until that owner publishes and adopts it.

The first capable client imports the retired local existing-Session text/semantic stores and the
singleton new-Session draft into the canonical draft repository. It removes each legacy value only
after the corresponding canonical record is durably acknowledged, so an interrupted import remains
recoverable. The legacy readers are migration adapters, not parallel writers, and may be removed
when supported persisted local state no longer requires them.

The 0.3 upgrade is one-way: every component updates together, with no supported 0.2/0.3
coexistence or rollback to 0.2. Drafts created on 0.2 remain supported data. The 0.3 reader
validates and preserves the published 0.2 `machineId`, `serverId`, `agentId`, `backendTarget`,
`modelId`, and `codexBackendMode` fields; its UI projects only exact safe equivalents into
canonical execution, Agent, and native-model selections. Canonical 0.3 fields, including
explicit clears, win over predecessor values. Current new-Session authoring writes the
canonical V2 document; an unavailable V2 mutation keeps the local draft and is not retried
as a V1 write. Existing V1 documents remain readable through the current payload union.
Remove historical-data reader bridges only when those persisted drafts are no longer
supported inputs; the absence of old running clients alone is not a removal condition.

Draft documents preserve bounded unknown extension fields as JSON. This lets a client without a
newer composer contribution edit fields it understands without deleting newer semantic data; it
does not authorize that client to execute the unknown contribution. Raw generic-file bytes, local
file handles and URIs, credentials, secret values, and local presentation state remain outside the
compatibility shape. Plugin semantic attachments, mentions, fallback presentation, and opaque
execution-target-bound staged-media handles may round-trip; execution still fails closed when the
owning plugin or target is unavailable.

### Session-owned run input convergence (development)

The development Action contract sends Session-owned run input through
`session.message.send` with an optional strict participant recipient. Main
Session input omits the recipient. `execution.run.send` requires explicit
`sessionId: null` and retains direct delivery only for detached runs; its
`prompt`, `steer_if_supported`, and `interrupt` modes do not become Session
pending actions.

Attached `execution.run.send` calls receive
`session_input_target_update_required` before a direct send. The approved 0.2
compatibility adapter keeps the released request parser for this refusal; it
must not approximate the old delivery modes or retry against the main Session.
Remove that adapter only when the last supported 0.2 UI/CLI-to-current-daemon
attached-send direction closes. Existing run and transcript records remain
readable. Attached chat follows `session.message.send` Action settings, while
detached chat follows `execution.run.send`; settings are not copied between IDs.

Targeted admission requires the exact target Machine's `sessionInputAdmission`
revision 2 and the nested execution-run pending resource
`POST /v2/sessions/:sessionId/execution-runs/:runId/pending`. Released servers do
not match that nested route, so they cannot strip the target and report a
main-Session success. Missing support must fail before relay or mutation, without
dropping the recipient; a target send never becomes a main-Session send, and an
unavailable capability snapshot is withheld rather than published as a false
negative.

The reachable directions are:

| Direction | Required behavior |
|---|---|
| Released client main send → current stack | `required` — unchanged. Main input carries no recipient, takes no target query, and pays for no capability check. |
| Current client main send → supported released server/daemon | `required` — unchanged. The existing no-target path stays usable. |
| Current client targeted send → released or partial stack | `required` — fail closed before mutation with the operation-scoped `session_input_target_update_required`; no row, no relay, no recipient-dropping retry, and unrelated operations stay usable. |
| Released client attached `execution.run.send` → current daemon | `required` — the same operation-scoped refusal through the retained released request parser. Detached `sessionId: null` sends keep working. |
| Current target rows → released-server rollback | `unsupported` after activation. No dual writer, mirror, or rollback-only path exists for target rows; recovery is ordinary Pending state. |
| Released persisted rows → current readers | `required` — old pending rows read as the implicit main target (`targetExecutionRunId IS NULL`); transcripts, sidechains, and markers stay readable. Old terminal transcript rows have no server-private Run binding, so main-message retry remains compatible while a targeted terminal retry that cannot prove its exact target fails closed rather than inventing a match. |

The nested target resource, its strict body, and the plugin-facing recipient
projection are undeployed 0.3 development shapes: refine them in place at the
Action and admission owners rather than adding a reader for a superseded
intermediate. These are operation-specific development contracts; the composed
live target-send and mixed-version gates must pass before the feature is
described as available. The delivery semantics themselves live in
[Pending delivery architecture](pending-delivery.md#execution-run-targets).

### Deferred Action approvals (development)

Released `ApprovalRequestV1` Artifacts remain readable as history using their
released closed status vocabulary. They carry no current replay authority: a
current attempt to execute one fails safely as `approval_stale`. Current
effect-bearing approvals use strict `ApprovalRequestV2`, including the immutable
execution origin admitted before the user is asked to decide.

Approval is not an execution lock by itself. After an approval decision, the
existing Artifact is the durable effect-custody owner:

```text
open -> approved -> executing -> executed | failed
```

The executor must win the Artifact compare-and-set from `approved` to
`executing` before performing the effect. A duplicate caller reads the winner's
state instead of running the Action again. Current policy, credential, Home,
runtime, target, and resource authorization are revalidated against the stored
origin; the approving caller does not become the execution principal. If the
effect may have happened but terminal persistence cannot be proven, the
Artifact remains `executing` and later callers receive
`approval_execution_outcome_unknown`; they do not replay blindly.

The Artifact header is an index, not authority. Current readers hydrate the
body, validate its strict approval-family schema, and require every duplicated
header field to agree before presenting or acting on it. A contradictory or
unknown body/header combination fails closed.

This is an in-place development evolution, not a second approval store or a
backfill requirement. Undeployed target/plugin approval schemas may be refined
in place through the same Artifact owner. Released V1 bytes and readers remain
the historical compatibility boundary.

## Ephemeral Runner release compatibility (development)

`happier-runner` is a 0.3-only release product. Its strict V1 release manifest is
owned by `@happier-dev/release-runtime/releaseManifest`; the publisher validates
what it emits and the server is the only public-release acquisition adapter.
Activations pin product, version, target, and lowercase SHA-256, so an existing
activation never follows a rolling tag. The creator downloads the exact archive,
checksums, and Minisign signature named by that verified projection and applies
the same release-runtime verifier before local package assembly. It also requires
the archive basename to encode that exact product, version, and target before it
performs any network acquisition. An exhausted immutable release-tag `404` means
the version is not published; transport failures, other HTTP statuses, and
malformed publication metadata remain a retryable publication-unavailable result
rather than being reported as positive absence. The signed
checksum envelope carries the Runner archive's exact compressed byte size and
closed entry list (path, kind, expanded size, mode, and link target when
applicable); the release manifest and Home-safe projection must agree with that
signed metadata. Acquisition rejects compressed-byte overrun or underrun, and
assembly rejects any missing, extra, colliding, unsafe, or size-mismatched entry
before the package is usable.

Current 0.2 clients and servers have no Runner activation or runtime contract.
New clients hide Temporary computer against an old server; old clients continue
ordinary Session and persistent-Machine operations against a new server, and a
materialized Runner Session remains readable as an ordinary Session. No dual
Runner manifest, token, activation, or socket shape is retained solely for
unreleased 0.3 work. Existing Machines retain effective `persistent` kind.
Shared V1 manifests for released non-Runner products remain readable without
Runner archive metadata; those products neither emit nor interpret these fields.

The `EphemeralRunnerActivation` table is a 0.3-only Home-owned record with no
predecessor shape to read or write. Its strict V1 lifecycle advances one way —
`pending → claimed → consented → materialized` — and every pre-materialization
state can instead reach `closed` carrying one of `canceled`, `declined`,
`expired`, `revoked`, or `failed`; each closing transition is conditioned on that
pre-materialization set, so a materialized activation is never retroactively
closed. `apps/server/sources/app/ephemeralRunner/activationLifecycle.ts` owns
closure and erasure. Deleting the creator's draft closes that draft's
pre-materialization activations in the same transaction as the draft tombstone,
and Account erasure closes every remaining pre-materialization activation as
`revoked` and then deletes only `closed` rows. A materialized activation is
deliberately left to the Session deletion owner, which removes the row with its
Session (`apps/server/sources/app/session/delete/deleteSessionTree.ts`), so an
orphaned materialized row keeps blocking Account deletion instead of being
hidden by a cascade. Nothing outside 0.3 reads this table, so rolling back to a
build without the Runner contract leaves these rows unread rather than
reinterpreted.

The strict V1 activation-create request may carry the optional literal
`authorizeUnattendedTeamAccess: true`. Omission is the safe compatibility shape:
the activation remains usable for independently authorized personal/direct work
but cannot satisfy a restricted Team's authentication policy. When present, the
Home copies only current evidence from the verified creator credential into the
activation's server-owned snapshot. That intent and snapshot are never written
to the exported activation package or endpoint projection. The exact materialized
Runner token carries the currently valid evidence in signed V2 provenance; every
restricted Team selection, readiness, Session creation, broker open, and broker
effect re-enters the canonical Team-authentication qualifier.

The development-only 0.3 Provider broker grant also carries the exact opening
signed credential's `initiatorTokenEpoch`. Broker open and every subsequent
request or model-catalog admission recheck it through the same Account revocation
owner as bearer authentication. Signing out everywhere therefore ends existing
broker authority without turning the tunnel-opening expiry into a runtime
lifetime. This is a strict direct cut: grants without the epoch are rejected,
not upgraded from current Account state. PAT credential-row revocation remains
independent; ordinary PAT bearers cannot open this broker route.

The published payload is never the bare Bun executable. The pinned Bun 1.3.5
standalone runtime still exposes its embedded CLI dispatcher when `BUN_BE_BUN` is
inherited (`scripts/pipeline/release/bun-runner-hardening.test.mjs`), so the
shipped product is the Rust shell in `apps/cli/runner-native-shell`, which refuses
unknown arguments and clears the environment before spawning the Bun core as a
nested sidecar. Release admission rejects any candidate that reaches the embedded
dispatcher. Per target the archive contains exactly one payload root beside the
adjacent `happier-runner.activation.json` the creator client adds: Linux ships one
AppImage named `happier-runner` that contains the core as a bundled sidecar;
Darwin ships `Happier Runner.app` with the core at
`Contents/MacOS/happier-runner-core`, which the builder asserts before archiving.
`packages/protocol/src/ephemeralRunner/runnerPackageLayout.ts`
owns that layout and the publication-eligibility list;
`scripts/pipeline/release/lib/runner-packaging.mjs` is the release-side mirror the
builder, asset preparer, and admission all consume, pinned to the Protocol source
by `scripts/pipeline/release/runner-native-shell.test.mjs`.

Linux x64 is the first publication-eligible build/publish/smoke target. This
eligibility lets the release owner produce and validate an immutable candidate;
it is not a Home availability claim. The Home projects only exact records from a
verified immutable publication. The `sessions.ephemeralRunner` Home feature is on
by default, with `HAPPIER_FEATURE_SESSIONS_EPHEMERAL_RUNNER__ENABLED=0` as the
operator opt-out; publication eligibility and release checks are separate from
that feature decision. Linux arm64, Darwin x64/arm64, and Windows x64 retain the
same product/manifest target identities, but must not be projected as available
until their immutable native artifact and applicable platform-signing evidence
are published. Building a target does not make it available: the builder can
compose the Darwin shell, but only with a real Developer ID
identity and notarization output, and it fails closed rather than emitting an
unsigned or ad-hoc signed Runner. Darwin trust is owned by
`notarize-standalone-binary.mjs`, which signs the JIT-entitled nested core before
sealing the app, notarizes, staples, and records schema-3 `app-bundle` evidence —
the released schema-2 standalone-payload evidence keeps its own online-ticket
contract and is not reused for a bundle. Windows' two-executable portable,
no-installer shape is approved (Lane 13 A05). It remains unadvertised until the
existing release producer and admission owner implement and verify timestamped
Authenticode for that shape and publish an eligible immutable record. Missing
signing integration is implementation work under that approval, not a request
for another product amendment or permission to bypass admission with a build flag.

The Home feature decision is on by default;
`HAPPIER_FEATURE_SESSIONS_EPHEMERAL_RUNNER__ENABLED=0` is the operator opt-out.
Current source contains the authenticated pre-Session credential selection, Pool
source-eligibility and exact-Machine binding, signed broker-readiness
authorization, and production Runner consumer. Those source paths continue to
fail closed on missing or stale readiness. The composed creator-to-endpoint-to-Session
journey on a loaded runtime and the platform-trust evidence above are release
checks owned by release automation and human QA, separate from the feature
decision and from an availability projection that still requires an exact
artifact in a verified immutable publication.

Runner Follow consumes the ordinary Session Follow preparation contract rather
than defining a Runner protocol. The exact method is
`daemon.sessionFollow.sourceKey.prepare.v1`, with strict Protocol request,
authorization, and `installed` response schemas. Lane 09 owns that contract,
hydration, current-edge reconciliation, and accepted-effect acknowledgement.
The Runner composition owns one exact-Machine receiver, one process-local source
material resolver, edge-removal pruning, reconnect registration, and terminal
disposal. It has no Runner engine, Runner store, durable source-key cache, or
second Follow loop. The prospective `../0.2` source inspected at
`7e1ce993c408c0f634b81267aac2bcd8e7859975` has no observed Runner or preparation
method; new clients therefore fail closed against it instead of negotiating a
parallel format. Refresh that dirty sibling's relevant bytes before activation.

## Plugin Platform direct-cut frontier

The Plugin Platform simplification is a direct cut within the unreleased 0.3
development line. The current working tree was rechecked on 2026-09-24 while
the checkout HEAD was `08b245d0337e7ee6b1bad249cdb79081b809449b`.
The repository-local immutable source tags rechecked at the same time were `cli-v0.2.11`,
`cli-v0.2.11-preview.2`,
`server-v0.2.11`, `server-v0.2.11-preview.2`, `ui-web-v0.2.11`, and
`ui-web-v0.2.11-preview.186` at
`98ea8fb76733b1dd785d38c31360179cafa84824`; `ui-mobile-v0.2.0` at
`e49afc11e8d8c068043bc108722ca2ed90b11d1d`; and `ui-desktop-v0.2.0` at
`ed11a23e45fb18b6ef7a7f13c256ab148c8d50a3`. Their app and package trees
contain none of the current Happier Plugin Availability/materialization,
`.happier-plugin` manifest, Provider-contribution, installed-generation,
occurrence/currentness, or Plugin UI artifact contracts. The release registry
uses `plugin-sdk-v` for the separately published Plugin SDK pair, but the local
tag set contains no such immutable tag. This is repository-local source and
publisher-contract evidence; it does not claim an independently queried
deployment or npm-registry state.

The prospective `../0.2` source was inspected read-only on branch `dev` at
`439125d17582cdfa7534a156737d52559565353b`, including the committed tree,
zero staged changes, four tracked unstaged changes, and no untracked files. Its
dirty paths cover the Codex app-server and request-user-input implementation and
tests, outside the Plugin Platform corridor. Neither the
complete on-disk app/package tree nor the unstaged diff contains the Plugin
Platform identifiers above, Re.Pack/Module Federation runtime identities,
`immutableGenerationId`, `hostUiApiRange`, or a plugin persistence model/file.
Refresh this comparison before activation if that moving predecessor changes.

Consequently there is no released or prospective old/new Plugin Platform wire
or persistence direction to preserve through aliases, dual writers, or
framework-version admission. Managed third-party installation generations are
the current design's immutable package custody, not a predecessor
compatibility shim. Development source is evaluated into a process-local
occurrence; its last accepted occurrence is not persisted for restart
recovery. Current-development `AccountPluginIntent`, `AccountPluginRelease`,
`AccountPluginUiArtifact`, and `PluginMachineMaterialization` rows, managed
third-party generation-store files, and digest-keyed UI artifact caches remain
forward-only current data; they do not create an old-reader or old-writer
direction for `../0.2`.

The repo-local development Stack uses dedicated `mac-host` server placement.
Live-process file-descriptor evidence from server PID 51343 identifies its
active SQLite database as the target-scoped
`/Users/leeroy/.happier/stacks/repo-dev-a1cc5e0671/cli/stack-state/dev-target-mac-host-dfcbfd6a94d90609/server-light/happier-server-light.sqlite`.
A read-only check on 2026-09-23 found all 118 current source migrations applied
with matching checksums, including the `d484…` automations migration and the
`20260920230000_migrate_session_subagent_source_custody` migration applied on
2026-09-21. The current `reporterSourceCustody` schema is present, and SQLite
`quick_check` and foreign-key checks are clean.

The live ledger has 122 applied rows. Its four ledger-only development
identities—`20260810140000_add_event_automations_v1`,
`20260810210000_contract_session_turn_anchor_projection`,
`20260813110000_add_automation_event_source_status_reporter_immutable_generation`,
and `20260815180000_backfill_automation_execution_dispatch_state`—refer to
source directories consolidated away during development. Their presence alone
does not establish a deploy blocker; the canonical deploy result owns that
decision. The parent-level mac-host database and the Linux-local database at
`/home/leeroy.guest/.happier/stacks/repo-dev-a1cc5e0671/server-light/happier-server-light.sqlite`
are inactive files, not the current Stack migration target. None of these
development-only ledger shapes is a released compatibility direction or
justification for a product alias, bridge, or reader.

## SDK protocol evolution

Plugin UI executable compatibility is negotiated only through the artifact's
`hostUiApiRange`. One artifact id names one byte-identical CommonJS bundle on
web, iOS, and Android; React, React Native, Expo, Hermes, and app patch versions
are not artifact admission keys. Artifact bytes are addressed by digest. A
daemon-process-local occurrence establishes contribution currentness, but it
must not become a second byte identity or mount-compatibility gate.

A wire epoch describes compatible semantics, not an exact property census. Every
material object boundary, including nested objects, is classified explicitly as
`closed`, `additive-open/drop`, or `additive-open/preserve`; a parent policy
never silently classifies its children.

- **`closed`** rejects unknown properties. It is mandatory for identities,
  qualified references, Account or credential selection, permissions, routing,
  mutation inputs/outcomes, authoritative lifecycle facts, executable
  declarations, and runtime unions. Stable Host Events are always closed.
- **`additive-open/drop`** may accept bounded optional unknown properties only
  for transient, presentation, or read projections where an older consumer can
  safely ignore them. Normalization removes those properties.
- **`additive-open/preserve`** may retain bounded unknown properties only when
  the component is an explicit round-trip custodian for a persisted document or
  opaque provider configuration. Preserving data never grants identity,
  authority, routing, credential selection, persistence-policy, or trusted
  prompt/transcript/UI power.

Known fields remain strict under every policy: required fields stay required;
invalid values do not coerce; and owner-justified encoded-byte or semantic
cardinality bounds still apply where the actual wire, storage, or operation
contract requires them. Implementation safety guards such as serializer/parser
recursion depth are private fail-safe details, not public semantic JSON quotas.
An accepted unknown is data, not authority.

An optional input is compatible only when an older implementation can ignore it
without falsely reporting success. Otherwise advertise an optional
operation/capability or introduce a new wire epoch. Likewise, a new union member
is compatible only in an explicitly skippable, bounded presentation list.
Identity, presence, permission, pagination, retry, and mutation-outcome unions
need an existing safe `unknown` arm or a new epoch; they are not skippable by
default.

npm package versions and exported wire epochs evolve independently: a later npm
major may still export V1, and a later npm minor may make only V1-compatible
additions. A public cross-plugin business protocol is a separately publishable
package with any valid scoped or unscoped npm name ending in `-protocol` and
explicit `/v1` and `/testing/v1` exports. Its npm scope identifies its author
and grants no additional protocol authority. It contains schemas, types,
helpers, and conformance fixtures only—not host runtime, persistence, provider
implementation, credential materialization, polling, or a private
`@happier-dev/protocol` dependency—and it has no `latest`, `current`, or
`default` aliases. Compatible
package copies interoperate through serialized protocol identity/version and
runtime validation, never JavaScript object identity.

The package README and nearest `AGENTS.md` must name the feature's domain owner
and link here rather than copy this doctrine. New feature-protocol code must use
one synchronous executable validator/normalizer that derives its bounded public
JSON Schema; independently handwritten parser/schema pairs are not allowed.

The approved SDK r0.31 direct cut does not make current `dev` → `../0.2`
rollback a supported direction. Do not add predecessor readers, dual writers,
aliases, writer-floor waits, or rollback-only gates for unpublished author
contracts; forward migration and current-version integrity still apply.

### Notification channel sender source migration (development)

The current development `NotificationSender` request makes `categoryId` optional:
plugin-originated service sends retain the qualified plugin category, while host
Activity sends omit it. This required-to-optional sender change is a development
source-contract cut, not a V1-compatible relaxation for existing senders. Authors
must update and rebuild category-dependent senders before consuming host Activity
notifications; no synthetic category or silent compatibility shim is supplied.
The plugin `notifications.send` service still requires a declared category. See
the [author migration guide](../apps/docs/content/docs/plugins/services/notifications.mdx#channel-sender-source-migration-development).

### Detached Execution Run plugin context (development)

Real Agent Sessions keep the existing Session V1 request, event, context, and
host-service contract. A Session-primary Agent may additionally declare the
versioned `executionRunContext: { versions: [1] }` capability and return the
matching `sessions.executionRunContextV1` runtime facet. Only that facet receives
the host-stamped `execution_run` scope; it has no `context.session` and exposes
only host services whose authority is meaningful without a Happier Session.

The declaration and runtime facet are inseparable. A detached Run fails with the
existing operation-scoped `execution_run_protocol_unsupported` result before a
provider effect when either side is absent. Genuine Session operations remain
available, so older plugins do not need a compatibility adapter and the host must
never substitute the Run id into a Session V1 field. Composer attachment V1 also
remains Session-only; the additive V2 resolve callback carries the same truthful
scope, while SessionMedia continues to reject outside a Session.

The prospective `../0.2` checkout inspected at
`c4deb153e7d4740f06bfeee94b70cfda95d47068` has no observed execution-run context
facet or Composer V2 callback in the relevant SDK, Protocol, and CLI runtime
paths. Those unpublished author contracts therefore create no reverse adapter or
rollback obligation.

## Proportionate matrix

List all affected reachable directions and mark each `required`, `unreachable`, or `unsupported` with a reason. Direct seam tests cover each required direction. End-to-end rows are selected by risk and real deployment order.

Do not run a full Cartesian UI × CLI × daemon × server matrix for an internal or unrelated change. Require broader combinations when a shared protocol, persistence shape, installer/service state, or rollout ordering actually couples those roles.

## Evidence and tests

- Prefer real released/predecessor artifacts, serializers, clients, or provenance-pinned golden vectors.
- A fixture reconstructed from current types is not evidence that the released or predecessor reader/writer behaves that way.
- Use the smallest discriminating test for each material direction, then add risk-selected upgrade, coexistence, rollback, and state-continuity flows.
- Do not multiply shallow permutations. A new test must distinguish a plausible incompatibility, reader/writer mismatch, semantic change, or rollout failure.
- Record the exact tag/commit/artifact or sibling worktree basis, component roles, direction, command, and result.

## Compatibility path lifecycle

Every retained compatibility path records:

- the released or prospective source shape it supports;
- its producer and consumer;
- whether it exists for upgrade, coexistence, rollback, or persisted historical data;
- the canonical owner it delegates to;
- its removal condition.

Remove the path when its support window has ended and evidence shows no supported reader, writer, or stored shape still requires it. Do not remove a released-data reader merely because current writers stopped producing that shape.

### Home profile descriptors (0.3 development)

The UI's existing `server-state-v1` profile owner retains one exact
`homeConnectionDescriptor` for descriptor-backed Homes. Endpoint and revision
decisions read that snapshot; duplicate-profile merges keep its canonical URL and
public ingress together. The active runtime snapshot's revision is a derived,
non-persisted projection. The development-only `irohEndpoint` and
`connectionDescriptorRevision` profile fields are ignored and are not written.

Ordinary URL-only profiles remain readable and usable over standard networking.
Their source shape is present in `ui-web-v0.2.11` and
`ui-web-v0.2.11-preview.186` at
`98ea8fb76733b1dd785d38c31360179cafa84824`, and in the clean prospective profile
owner at `../0.2` commit `9dd9c2580be619b4907257f94174e45ba5517976`.
Those profile shapes contain no Iroh endpoint or descriptor revision fields.
Once a Home has an exact descriptor, a revision-less manual update cannot replace
its connection destination; an exact current Home descriptor is required.
Public privacy-reduced observations do not allocate a revision or erase private
facts from the retained authenticated descriptor.

The separate device-local Account Service endpoint accepts only `source: 'default'`
or `source: 'user'` on both reads and writes. The abandoned `configured` source
is not normalized into a policy choice. It has no endpoint-record producer in
the above stable/preview profile owners or the clean prospective profile owner
at `08e278be495e8f3a1b744bd1d069fc48d2d3276f`; an invalid persisted endpoint is
discarded without changing Home profiles or focus.

### Current finite-transfer admission (0.3 development)

The approved one-way 0.3 transition removes the old-daemon missing-declaration
probe and `legacy_machine_rpc` carrier. An absent, malformed or disabled daemon
transfer declaration is not support. Presentation and execution share the
current declaration reader; ordinary daemons must declare finite import and
export. A restricted Runner has no daemon transfer state and instead declares
`finiteTransferRpc` in its current, server-revisioned operation capability
projection. Endpoint publication alone does not establish finite-transfer
support: the same endpoint also carries workspace and broker traffic.

Iroh selection requires current application support, both
`machines.transfer.directPeer` and `machines.peerMediation`, the canonical current
endpoint descriptor, and a usable host carrier. Browser clients additionally
require the published relay hints. A failure after selecting Iroh does not switch
to an obsolete RPC carrier. Standard-only makes this mandatory prepared
`machine/1` path unavailable; it does not invent another execution carrier.
Current Session-scoped attachment RPC transfers and the general Machine-RPC
route policy remain separate, unchanged paths. Composer media remains independently negotiated.
This contraction changes live component admission, not readers for data created
by 0.2; no persisted transfer format or data migration is introduced.

### Request notification previews (development)

The 0.3 development Notify me Action adds `notify_me` to the webhook topic union
without changing existing topics or payload version. Its optional navigation
uses the existing `sessionId` field or an additive `runId` field. The Activity
owner applies the same attention-policy privacy projection before push, webhook
or plugin delivery. No notification persistence migration or Inbox record is
introduced. Webhook integrations that validate a closed topic enum must accept
this new topic before opting into Notify me delivery.

Request previews use the existing `attentionDeliveryPolicyV1` channel/event privacy
owner. Remote push and Live Activity permission and user-action events default to
`include_preview` unless an explicit event preview policy restricts details; legacy
`requestIncludeMessageText` preferences are translated at the existing settings
adapter. Webhook request content defaults on unless the destination sets
`requestIncludeMessageText: false`. Disabling either disclosure decision omits
request details from the body and `request.toolDetails`.

Device-local ready and request preview overrides are separate fields under the
existing `attentionDeviceOverridesV1.localNotifications` owner. The request
override defaults to `account`, delegating to the shared policy. Notification
routing and permission-response schemas are unchanged; richer content uses the
existing text fields, with no new server operation or migration.

The released 0.2 notification editor at `98ea8fb76733b1dd785d38c31360179cafa84824`
(`ui-mobile-v0.2.11`, `ui-web-v0.2.11-preview.186`) rebuilds nested legacy
notification settings and strips unknown fields. A missing remote request flag
therefore restores previews, following the user-selected default. An older editor
can erase an explicit opt-out; users can disable previews again from an updated client.
Older CLI senders ignore this preference and retain their reduced hints.

### Changed Files attribution (development)

The unreleased Changed Files projection separates content confidence from Session/turn
attribution in the canonical Protocol merger, `sessions/changes/mergeTurnChangeSets.ts`.
An exact checkpoint delta can have only possible attribution when another checkpoint
interval overlapped. Correlated Agent/tool evidence remains independently attributable,
while workspace touched paths supply only best-effort content and possible attribution.
The derived per-file and summary axes do not introduce another persisted change-set document.

The same merger normalizes evidence paths against the resolved repository root and retains
all contributing observations through rename chains; copies remain independent. Consumers
use that projection rather than reconstructing lineage from the final filename. Across
turns, a later tool patch is not a Session-wide diff. Continuous recorded text spans can
produce a best-effort net comparison, but tool text may be only a fragment: equal aggregate
endpoints cannot prove that the file is clean. Missing or discontinuous net evidence remains
unavailable, and scoped review does not substitute the current working-tree diff for it.
The Session's canonical latest-turn identity selects the turn view even when that turn
has no file evidence; older file changes remain available in the Session view. Hosts without
that identity retain the evidence-chronology fallback. Checkpoint capture preserves runtime
sequence ranges before asynchronous publication rather than using transcript arrival order.

Checkpoint overlap is historical, process-local capture evidence. The CLI registry uses
the resolved SCM root, remembers overlap for each interval after peers finish, and closes
the interval when final capture completes, before asynchronous diff projection. An interval
without observed overlap says nothing about writers in other CLI processes, daemons,
editors or shells. Project membership does not establish filesystem authorship or isolation.

Current checkpoint writers use `shared_worktree` when overlap was observed,
`no_happier_checkpoint_overlap_observed` when the process-local registry observed none,
and `unknown` when the observation is unavailable. The former development-only
`exclusive_worktree` value was removed from the strict reader after the inspected 0.2.11
stable/preview CLI and UI tags and the current predecessor corridor showed no producer.
No compatibility adapter reinterprets that unshipped exclusivity claim.

The clean prospective predecessor corridor at
`b23f95ed354e8d49183017e487bdb75f217017de`,
`packages/protocol/src/sessionChanges`, names Agent turn correlation `providerTurnId`.
The current evidence schema normalizes that field to `agentTurnId`, preserving an explicit
current field when both are present. Invalid aliases and unrelated unknown fields remain
rejected. Current writers use `agentTurnId`; remove the reader translation only when
predecessor-produced change sets cease to be supported inputs. These reader provisions
are not certification of mixed-version deployed clients or completed live UI validation.

### Session message authorship in development

The current authenticated transcript adds an optional nullable `accountActor` presentation field. Its Account identity and minimal profile are strict nested schemas; older message envelopes may ignore the additional field. An omitted field preserves previously projected actor metadata during an update, while explicit null clears it. New clients render no inferred author when an older server omits the field. Public/external transcript projection remains separate and omits the Account actor.

The nullable `SessionMessage.authorAccountId` relation is derived from the immutable admission receipt and uses `ON DELETE SET NULL`. Historical rows without a valid human receipt remain unattributed. Deploy current receipt-derived writers, run the [provider-neutral backfill and disagreement audit](pending-delivery.md#human-authorship-in-development), and verify its result before author-based personal Session scopes activate. Additive DDL alone does not establish old-server restart or overlapping-writer support. No JSON-query fallback, repair worker, or second author store participates in this transition.

The Session record also carries an optional `hasOtherNamedCollaborator` audience-existence signal: true when the current authorized human audience contains another Account besides the requesting viewer. It is presentation-only (the transcript self-byline "You" suppression), independent of live presence, and never a roster, authorization input, or grant source. Omitted means the producer did not project it; consumers preserve the last known value instead of asserting a solo Session, and an explicit boolean always replaces it.

### Enterprise identity and directory provisioning (0.3 development)

Managed identity providers, Team identity connections, and directory sources are new
additive tables in 0.3 development source. Nothing about them is released, so the only hard
obligations here are the released `AccountIdentity` and `LinkedProvider` shapes they extend.
The domain itself is described in [enterprise-identity.md](enterprise-identity.md).

| Direction | Required behavior |
|---|---|
| Released UI → new server | Ordinary built-in and deployment authentication remains usable and strict `LinkedProvider` remains parseable. Managed administration is simply absent from an older client, never malformed. |
| New UI → released server | Ordinary Home authentication falls back to the released `/v1/features` projection **only** when `/v1/auth/entry` answers 404, 405, or 501. Team-managed operations are unavailable rather than sent to a permissive generic route. |
| Released database → new server | Migrations are additive and preserve every existing `AccountIdentity.provider` value and profile byte. No environment-provider row is backfilled, and there is no foreign key from `AccountIdentity.provider` to the managed provider table, because built-in and deployment providers intentionally have no row. |
| New schema → old server | Not a supported direction. Additive tables alone do not establish safe old-binary startup. |
| Mixed fleet after activation | Not supported. Every authorize, callback, and finalize handler must resolve managed providers before managed configuration is activated. |
| Old-server rollback after activation | Not supported, and no rollback-only writer or persistence path exists. This does not remove released-client support against a new server. |

The activation sequence is therefore prepare, then all-capable activation: add the tables,
codecs, readers, and catalog with managed providers disabled; replace every server process
that can receive an OAuth start, callback, or finalize; then activate managed configuration
and writes.

One compatibility reader is retained deliberately. `securityBinding` is optional in the
persisted OAuth attempt and pending schemas
(`app/api/routes/connect/oauthExternal/oauthExternalSchemas.ts`), because a server process can
be replaced while attempt rows it authored earlier are still inside their TTL. That reader
carries no managed or Team authority. `hasInvalidOAuthSecurityBinding` exists so a
**malformed** new binding can never be misread as a legitimately absent one. Its removal
condition is the drain of every legacy-writing server process plus the maximum attempt and
pending TTL — a server-authored ephemeral lifetime, which client support windows do not
extend.

Because none of this has shipped, an unreleased intermediate shape carries no obligation:
correct it in place rather than adding a reader for it. Persisted directory projections are
reconstructible from their upstream source, but native memberships and Group contributions
written from them are not — they are ordinary native facts owned by
[teams-membership-and-groups.md](teams-membership-and-groups.md) and follow that owner's
rules.

### Native email/password authentication (0.3 development)

The following describes the current development source, not a released feature.
The method is default-on, with
`HAPPIER_FEATURE_AUTH_EMAIL_PASSWORD__ENABLED` and its provisioning key as the
operator opt-out described in [feature-gating.md](feature-gating.md). Persisted
Home policy and operation-specific mail readiness determine effective actions.
There is no disabled-until-validation activation gate. Current-source tests and
runnable development journeys remain implementation checks; physical-device,
real SMTP and production-like infrastructure evidence remain release checks.

The immutable stable server source tag was rechecked on 2026-09-26 as
`server-v0.2.12` at `a357c65536ba89669422977d6f7daf9aa0d17e73`.
The moving `../0.2` predecessor was inspected read-only at
`9047258b99545a8ce84923789c87945fcaeb1e69` with a clean worktree. Its bounded
auth, credential and schema paths contain no native-password or Account API-token
contract. These are source observations, not artifact/deployment certification.

`AccountEmail`, `AccountPasswordCredential`, and the native email identity are additive
tables and rows in 0.3 development source; the nullable password-mutation purpose/digest
fields extend the unreleased `KeyChallengeV2` migration in place rather than shipping an
add-then-alter history. Nothing here is released, so the released obligations are the
existing Account, identity, and credential shapes the new tables extend.

The incumbent Account-encryption migration request likewise gains only an optional strict
prepared `passwordCredential` participant. Released clients cannot have the unreleased
password row and retain their passwordless transition behavior; current clients with an
enrolled password must supply the participant, and the server fails closed instead of
flipping the mode beside a source-mode credential. No reader or dual writer is retained for
superseded, undeployed development request drafts, and the staged V5 route stays disabled.

The approved 0.3 upgrade is one-way: every component updates together, with no
mixed 0.2/0.3 operation or old-binary rollback. The former old-client-safe
`email_password` omission has therefore been removed. `/v1/features` publishes
the effective method decisions through `toPublishedAuthMethods`, while
`POST /v1/auth/entry` remains the complete contextual Home/Team/invitation
projection. Both consume the same policy owner; neither creates another
availability decision.

| Direction | Required behavior |
|---|---|
| Current 0.3 client → current 0.3 server | Native password actions use the current effective-method and contextual-entry contracts. |
| Mixed 0.2/0.3 client/server | Unsupported under the all-component one-way upgrade; no old-client omission or minimum-client simulation is required. |
| Released database → new server | Migrations are additive and preserve every existing `AccountIdentity` value and uniqueness rule; the native-identity widening is applied forward through the owning unreleased migration, not by a second lookup or digest alias. |
| New schema → old server | Not a supported direction. Additive tables alone do not establish safe old-binary startup. |

A password-only Home is a permitted operator configuration. Governance still
protects currently usable Account login routes and the final active Home
administrator through the canonical auth-domain check; it does not impose a
0.2-client floor. Forward readability of 0.2-created data remains required:
existing credentials, recovery-key bytes and provider identities are preserved,
and released migrations remain immutable. Purpose-bound mutation challenges
must still be rejected by ordinary login redemption. These invariants require
neither a compatibility writer nor a separate rollout protocol.

## Migration history

Migration source has a stricter authoring boundary than ordinary internal code:

- A migration is **local-only** while it has not shipped in a supported stable or preview artifact. Local-only migrations may be edited, renamed, consolidated, or removed before publication.
- Once a migration ships in a supported stable or preview artifact, its name and bytes are immutable. Correct later behavior with a new append-only migration; do not rewrite, rename, or delete the released migration.
- Shared development branches and `*-dev.*` artifacts are evidence that a development database may need explicit reconciliation, but they do not create a lasting product compatibility obligation. Before the next supported release, their migration source may be corrected or consolidated in place when the final transition is still unreleased.

Before publishing a feature, consolidate local-only migration churn into the smallest clear transition from the published schema to the intended final schema. Do not retain add-then-drop columns, temporary tables, renamed draft identities, checksum aliases, or corrective migrations solely because a developer database applied an earlier draft. Retain multiple migrations only when each step serves a real rollout, backfill, transaction, provider, or mixed-version requirement.

If the deterministic repo-local development stack bound to the current checkout applied a local-only or development-exposed draft that is later rewritten, the database must be reconciled in place as part of the same implementation task:

1. resolve the current checkout's deterministic repo-local stack and verify its repository path and managed database ownership;
2. treat its database as retained, non-disposable development data—never delete, reset, recreate, replace, truncate, clean, or discard it;
3. do not ask for separate confirmation and do not create a backup, snapshot, or clone for this narrowly scoped repo-local reconciliation;
4. compare its actual data, complete physical schema, and migration ledger with the intended final schema;
5. quiesce only stack-owned writers when required, apply the exact provider-specific schema/data delta or canonical backfill transactionally, and update only the matching ledger record after the transition succeeds;
6. run the canonical migration deploy twice, then verify current source checksums, the ledger, provider integrity, and foreign keys;
7. restore the stack's prior running state when it was quiesced.

The migration edit and its repo-local reconciliation are one work unit owned by the last editor. Any later edit to the migration invalidates earlier checksum/ledger reconciliation evidence and requires the later editor to repeat reconciliation before handoff.

For `main`, shared, staging, production, external, another checkout's/named QA stack, or otherwise user-owned databases, prepare the provider-specific procedure, back up or snapshot when required, and obtain explicit approval before mutation. If stack identity or database ownership is ambiguous, fail closed without mutating any candidate.

That reconciliation is an operator/development action, not a shipped compatibility path. Do not add runtime checksum exceptions, migration-name aliases, duplicate no-op migrations, or automatic ledger repair merely to preserve unpublished development history.

Keep PostgreSQL, SQLite, and MySQL migrations aligned by intent. Before publication, validate both a clean migration from the published baseline and the executed repo-local reconciliation path when affected; use the approved reconciliation path for other retained databases. After publication, preserve the exact migration history and test upgrades append-only.
