# `@happier-dev/channels-protocol`

The public business protocol for Happier Conversation Channels. Use it when
you are authoring a provider plugin that contributes to the Channels core.
The package is deliberately small: it contains the versioned Channels
schemas, role contracts, contribution-point definitions, and public
conformance fixtures. It does not contain a runtime, provider implementation,
registry, UI, polling loop, persistence, or credential materialization.

## Session PR relationship batches (unreleased 0.3)

The existing `session-pull-request-binding-v1` Action accepts `kind: 'attach'`
with one `pullRequest` or `pullRequestUrl`, or a nonempty `pullRequests` or
`pullRequestUrls` array. All PRs must match the Session's accepted repository.
Duplicate operands are linked once; a batch shares Session admission and
repository setup. Singular attach retains its `attached` result; bulk attach
returns the existing `links` projection. Automation trigger targets remain
singular.

For `kind: 'unlink'`, pass the existing `bindingId` and `expectedRevision`, a
nonempty `bindings: [{ bindingId, expectedRevision }]` array, or a nonempty
`states` array. Explicit revisions are checked before any unlink. State selection
uses the freshest retained PR observation, shared with the Session link
projection; absent observations are `unknown`. It does not refresh remote state.
Unlink returns `removed` and removes local relationships, including related
trigger bindings, without deleting or changing a remote PR. A later provider or
concurrent-write failure can leave a batch partially applied; read the current
links before retrying.

Each operand form is closed and mutually exclusive. Matching development
producer and consumer versions are required for the new forms; older strict
readers reject them. Existing singular inputs and results remain valid. This
extends V1 without a new epoch, persisted shape or runtime ABI.

## Provider setup guidance (unreleased 0.3)

The provider descriptor's optional `setupGuidance` exposes static instructions
before setup invocation or Connected Account selection. Telegram declares its
BotFather links and `/newbot` copy value here. It contains no verified account,
bot identity, credential or connection facts. Rendering this pre-credential
guide in the Channels setup surface remains a separate UI integration.

The setup result's optional `setupGuidance` is projected unchanged by
`connection/prepare-v1`, including for independently installed providers.
Alongside `externalUrl` and `requiredPermissionsLabel`, providers may supply
`steps` in display order. Each step has a nonempty `title`, an optional HTTPS
`externalUrl`, and optional `copyableValues: [{ label, value }]`. Copyable
values are public configuration such as scopes, commands or ports; never
include credentials. Credential entry remains in Connected Accounts.

The descriptor, setup result and preparation derive their strict guidance readers and manifest JSON Schema
from the same guidance schema. Steps, copyable values and guidance reject
unknown fields. Providers author their own instructions and official links;
Channels needs no built-in provider identifier branch to consume them.

## Public imports

Import the explicit protocol epoch and testkit paths:

```ts
import {
  ConversationProviderSetupResultV1Schema,
  ConversationProvidersContributionProtocolV1,
} from '@happier-dev/channels-protocol/v1';
import {
  assertConversationProviderContributionV1,
  createConversationProviderSetupResultV1Fixture,
} from '@happier-dev/channels-protocol/testing/v1';
```

The package root is an explicit projection of `/v1`. There are no
`latest`, `current`, `default`, or legacy aliases.
Package versions and the serialized Channels protocol epoch evolve
independently. Compatible separately installed copies interoperate by
serialized protocol id/version and runtime validation, never by JavaScript
object identity.

### Shared CI evidence (development, unreleased)

`/v1` also owns `ForgeCiFailureSummaryV1Schema` and its minimal native
identity, lifecycle-state and annotation closure. The hosted-CI entry point
`@happier-dev/triage-protocol/ci/v1` re-exports these same schemas; Channels PR
updates embed the canonical summary directly. All definitions use public
Plugin SDK builders. Neither feature protocol package imports private
`@happier-dev/protocol`, and there is no reverse Channels-to-Triage dependency.

### Outbound text formatting (development, unreleased)

Channels alone splits outbound text: paragraph, then line, then word, then
grapheme boundaries. A fenced code block that fits stays intact; an oversized
block closes and reopens its original fence and language tag between messages.
Fence overhead counts toward the provider's native limit. A grapheme or fence
header that cannot fit is refused before sending any chunk.

In setup, declare `outboundTextLimit: { maximum, unit,
formatting: 'preservesNativeUnits' }`. The unit is `unicodeCodePoints`,
`utf16CodeUnits` or `utf8Bytes`; the maximum comes from the native API.
Formatting, escaping, entities and mention suppression must preserve that
unit's count, so core measures exactly the eventual native text length.
For example, Telegram and GitHub replace `@` with `＠` while counting code
points; Discord sends unchanged text and disables mentions in native metadata.
A provider must choose a rendering that satisfies its declared measure and
must not split again or expand the text after core splits it. Omitted
`formatting` retains the same measure-preservation obligation. Omit the whole
limit when the provider has no native text ceiling (Email); do not invent one.

## What a Channels provider is

A provider is a trusted plugin that adapts one external conversation service
to Channels. It contributes ordinary plugin Actions and binds those Actions
to the Channels-owned `happier.channels/providers` contribution point. The
binding is the discovery mechanism. Channels never scans a global Action
catalog, derives an Action id from a plugin id, imports provider code, or
expects a registration callback.

In unreleased 0.3 source, each V1 provider also declares
`descriptor: { v: 1, displayName: 'Acme Chat' }` in its `.contribute()` input.
Channels uses this admitted provider name throughout its UI; the plugin's own
display name can describe the broader plugin. The descriptor is presentation
only, uses the existing SDK descriptor mechanism, and drops unknown properties.

Provider authors stay on public package seams: use
`@happier-dev/channels-protocol/v1` together with public Plugin SDK entrypoints.
Do not import `@happier-dev/protocol`, a Channels implementation path, or any
CLI, server, or UI internals.

The core plugin declares the point once:

```ts
import { definePlugin } from '@happier-dev/plugin-sdk';
import { ConversationProvidersContributionProtocolV1 } from
  '@happier-dev/channels-protocol/v1';

export const { manifest, activate } = definePlugin({
  id: 'happier.channels',
  version: '0.1.0',
  contributionPoints: {
    providers: ConversationProvidersContributionProtocolV1.point(),
  },
});
```

`.point()` creates the target declaration. It is not a registry and it has no
`.contribute()` method. V1 sets
`maxContributionsPerContributor` to `1`: one contributor plugin can provide
at most one admitted provider contribution. A second contribution is a
generic admission diagnostic; Channels does not pick one locally.

The contributor recreates or imports the same serialized protocol identity,
declares ordinary Actions, and binds arbitrary same-plugin local ids. Derive
each Action's result schema, surface, and danger level from the role's
`.declaration`; only `setup` input is contributor-defined. This minimal,
complete socket provider declaration uses only public packages:

```ts
import { definePlugin } from '@happier-dev/plugin-sdk';
import {
  ConversationProviderMessageDeliverInputV1Schema,
  ConversationProviderSetupResultV1Schema,
  ConversationProvidersContributionProtocolV1,
} from
  '@happier-dev/channels-protocol/v1';

const roles = ConversationProvidersContributionProtocolV1.operations;
const actionIds = {
  setup: 'acme/connect',
  connectionTest: 'acme/check-connection',
  messageDeliver: 'acme/send-message',
  connectionStop: 'acme/stop-socket',
} as const;

export const { manifest, activate } = definePlugin({
  id: 'com.example.acme-chat',
  version: '0.1.0',
  actions: {
    [actionIds.setup]: {
      title: 'Connect Acme Chat',
      scopes: ['global'],
      inputSchema: { type: 'object', additionalProperties: false },
      resultSchema: roles.setup.declaration.resultSchema.jsonSchema,
      surfaces: roles.setup.declaration.surfaces,
      dangerLevel: roles.setup.declaration.dangerLevel,
      run: async () => ConversationProviderSetupResultV1Schema.parse({
        v: 1,
        credentialRef: null,
        providerConnectionKey: 'acme:example-bot',
        providerConfigVersion: 1,
        providerConfig: {},
        integrationPrincipal: { id: 'acme:example-bot' },
        supportedTransports: ['socket'],
        recommendedTransport: 'socket',
        overlapSafety: 'safe',
        replayContinuity: 'sessionBound',
        outboundTextLimit: { maximum: 4_000, unit: 'unicodeCodePoints', formatting: 'preservesNativeUnits' },
      }),
    },
    [actionIds.connectionTest]: {
      title: 'Check Acme Chat',
      scopes: ['global'],
      inputSchema: roles.connectionTest.declaration.input.schema.jsonSchema,
      resultSchema: roles.connectionTest.declaration.resultSchema.jsonSchema,
      surfaces: roles.connectionTest.declaration.surfaces,
      dangerLevel: roles.connectionTest.declaration.dangerLevel,
      run: async () => ({
        kind: 'ready',
        integrationPrincipal: { id: 'acme:example-bot' },
        providerConnectionKey: 'acme:example-bot',
      }),
    },
    [actionIds.messageDeliver]: {
      title: 'Send Acme Chat message',
      scopes: ['global'],
      inputSchema: roles.messageDeliver.declaration.input.schema.jsonSchema,
      resultSchema: roles.messageDeliver.declaration.resultSchema.jsonSchema,
      surfaces: roles.messageDeliver.declaration.surfaces,
      dangerLevel: roles.messageDeliver.declaration.dangerLevel,
      run: async (input) => {
        const request = ConversationProviderMessageDeliverInputV1Schema.parse(input);
        return request.newThread === undefined
          ? { kind: 'delivered', providerMessageIds: [] }
          : { kind: 'notReady', reason: 'unsupported' };
      },
    },
    [actionIds.connectionStop]: {
      title: 'Stop Acme Chat socket',
      scopes: ['global'],
      inputSchema: roles.connectionStop.declaration.input.schema.jsonSchema,
      resultSchema: roles.connectionStop.declaration.resultSchema.jsonSchema,
      surfaces: roles.connectionStop.declaration.surfaces,
      dangerLevel: roles.connectionStop.declaration.dangerLevel,
      run: async () => ({ kind: 'stopped' }),
    },
  },
  contributesTo: {
    'happier.channels': {
      providers: {
        acme: ConversationProvidersContributionProtocolV1.contribute({
          descriptor: { v: 1, displayName: 'Acme Chat' },
          operations: {
            setup: roles.setup.bind(actionIds.setup),
            connectionTest: roles.connectionTest.bind(actionIds.connectionTest),
            messageDeliver: roles.messageDeliver.bind(actionIds.messageDeliver),
            connectionStop: roles.connectionStop.bind(actionIds.connectionStop),
          },
        }),
      },
    },
  },
});
```

The `acme` key is the contributor's opaque contribution id; it is not a
provider registry key and is not used to derive any Action id.

The example intentionally uses local ids such as
`acme/check-connection`; they are not Channels ids. The host validates
that every bound Action belongs to this contributor, is in the same committed
immutable generation, and has the required surface and danger level. A stale
generation-A handle fails as unavailable instead of invoking replacement
generation B.

Start from the ordinary `happier plugins create` scaffold; it already owns the
package entrypoint, build, test, and managed source-development loop. Add the role Actions and this
one `contributesTo` value to that generated `definePlugin(...)` source. There
is intentionally no Channels-specific scaffold, provider base class, or
registration callback. When the SDK and this protocol are available from an
approved registry, use the released package ranges named there. Current source projections exercise feature mechanics. Outside-author
publication availability is established only by the authorized release workflow
and is not a feature-completion gate.

`ConversationProviderSetupResultV1Schema` is the Channels result validator.
In 0.3 development source, `outboundTextLimit` is optional. Declare it only
when the provider has a real native text ceiling; omission means no native
text ceiling, not a guessed default. Preparation and retained connection facts
preserve that distinction. The finite ceiling in the example above remains valid.
Email omits this field. GitHub declares `{ maximum: 65536, unit:
'unicodeCodePoints' }` for its native comment limit. Both use the same setup
schema; absence does not authorize a caller to invent a default ceiling.

The `setup` and optional `setupRemediation` Action inputs are contributor-defined; other role inputs and
all role results use the final Channels role contract. Setup returns either
that result or the bounded Channels `requiresRemediation` outcome. Setup input is
transient and may collect provider-specific choices or one-time handoffs. It
may include a selected Connected Account reference when the provider's form
needs to pass that choice to its Action, but it cannot create, change, or grant
that selection. The outer `credentialRef` in the Channels create/prepare
request remains authoritative. The setup result must echo that exact reference
(or `null` for a credentialless provider); Channels compares it before testing
or persistence. Setup input must never claim host identity, machine identity,
execution origin, or carry long-lived credential material.

In 0.3 development source, UI, CLI, Agent and MCP callers request a setup repair
through Channels' `connection/setup-remediate-v1` Action. Its closed input carries
the current `providerSelection`, opaque `providerRemediationInput`, and outer
`credentialRef`. Channels resolves that selection's current `setupRemediation`
role and invokes the same provider handler with the exact selected account.
The UI passes the remediation form's fresh selection carrier through this intent;
it then re-runs prepare after a confirmed repair. Off, Ask and Allowed remain
the user's per-Action policy. An unknown repair outcome requires a safe prepare
recheck before another mutation.

When `supportedTransports` includes `durablePush`, the setup result must carry
exactly one same-provider `webhookContributionRef`. That reference is
correspondence evidence for the generic Webhook endpoint owner, not a
`webhookReceive` provider role. A result that omits it, returns one for
another plugin, or claims durable push without the required reference is
invalid before endpoint creation or persistence.

The development V1 connection prepare, create and transfer contracts support
`checkpointedPull`, `socket` and Account-endpoint `durablePush`. Durable-push
creation uses the existing generic Webhook endpoint-ensure continuation and
host-derived correspondence check before saving a connection. Shared GitHub App
`providerInstallation` production is excluded from Preview completion; the
first-party GitHub Channels provider currently selects checkpointed polling.

## Thread routing and conversation starts (development)

The unreleased 0.3 core supports a `threadRouter` binding target on a
provider-supported parent with authenticated direct or shared audience. Its
`principalGroups` supply the sender allowlist and the audiences for new
conversations. Ordered routes match a group (or `any`) and forwarded provenance
(true, false, or `any`); each route uses the existing Session spawn recipe and
Session policy. The core matches a new thread through its endpoint's `parentId`,
then creates an ordinary child binding for the Session and its verified
originating sender, using the Session owner's persisted birth identity even on
rejoin. Children inherit the router's common input and delivery policy at birth.
Author recipes must not contain the host-only `attestedContext` field. `/new`
rotates a single-sender routed child with the current verified sender and command
message identity only when the existing Session confirms attested birth facts.
Started conversations and multi-participant audiences remain unattested.
Unmatched routes produce a content-free `routeNotMatched`
record. Disabling the router stops child admission, projection and new outward
effects through the shared live parent-policy reader; it does not undo provider
I/O already in flight. All Session
bindings restore an archived target through `session.unarchive` before sending
new input to the same Session.

The core Action `happier.channels/actions/conversation/start-v1` accepts a router
binding, an `audienceGroupId`, a subject, `content: { text, html? }`, and the
Session that will receive replies. That Session must be owner-confirmed to have
no attested sender; unavailable identity facts do not authorize a start. It
obtains recipients from the configured
group and enters ordinary delivery custody. A successful delivery creates an
ordinary child binding whose allowlist is that audience. Ambiguous outcomes use
the existing delivery resolution flow; they do not authorize a blind resend.
Agents request the Action through normal approval, and a Workflow `action` leaf
uses the same qualified Action reference. Router and binding editing use the
existing binding management Actions; their editor composition is owned by the
Channels UI.

Binding create and update drafts can accumulate principals from several exact
provider searches. `principalSelection.query` remains the default search; each
`selected` entry may supply its own `query`, alongside its `id` and `kind`.
For example, two exact-address searches can produce:

```json
{
  "query": "owner@example.com",
  "selected": [
    { "id": "owner@example.com", "kind": "human" },
    { "id": "sales@example.com", "kind": "human", "query": "sales@example.com" }
  ]
}
```

Both management Actions re-resolve every selected identity against its query
on the current connection and endpoint before saving. Router group members must
belong to that verified union; selecting an address is not a recipient override.
The queries stay in the draft, while the binding stores the existing principal
ids and groups. Providers keep their single-query `principalResolve` contract.

Provider `messageDeliver` inputs now carry `content: { text, html? }`. A reply
continues to use `replyContext`. An optional `newThread: { recipients, subject }`
asks the provider to start a thread; `recipients` are core-resolved principal
ids, not model-selected addresses. Successful starts return the created thread
`endpoint` with their normal delivery outcome. Providers that cannot start
threads return the existing typed unsupported failure. Telegram, Discord and
GitHub currently ignore the HTML alternative and refuse starts.

These contracts are development source, not a claim of published package or
loaded mailbox availability. The router editor and composed live mailbox journey
are integrated separately from this protocol boundary.

## Pairing proof and router bootstrap (unreleased development contract)

`connection/pairing-read-v1` reads one challenge using
`{ connectionId, generationId, challengeId }` on the authenticated `agent`,
`mcp`, `ui` and `cli` surfaces. It returns `ready` with `pairing` in the same
shape as `pairing-v1`: challenge handoff or proposal id, immutable proved
principal, exact proof location, state and expiry. The current Account must
own the connection; absent, expired or superseded challenges are
`unavailable`, and a retired generation is `restarted`. This safe read needs
no confirmation. Create and finalize retain their existing confirmations,
and finalize still creates a paused binding for owner review before enablement.

The Action and watched UI Resource share the pairing manager's projection;
neither creates another store or proof flow. Requester failure accounting
lasts only for its ten-minute challenge, with five valid failures per requester
and no separate requester-count cutoff.

The development pairing extension adds optional
`proofEndpointSelection: ConversationBindingEndpointSelectionV1` to
`ConversationPairingCreateInputV1`. Its existing fields remain `connectionId`,
`expectedConnectionRevision`, `pairingRequestId`, `endpointSelection` and
`target`. With no proof selector, the existing direct-audience, original-human
proof path remains available independently of the selected destination.

With a proof selector, management resolves both endpoints on the same current
connection/provider basis before creating the challenge. The selected proof
must have shared audience and equal the selected destination. For a
`threadRouter` only, it can instead be an authenticated thread whose `parentId`
is the selected parent's id. A Telegram forum router therefore selects the
forum parent as its destination and one exact topic as proof location; a
Discord parent channel can serve both roles.

The pairing owner freezes that endpoint and requires
`areConversationEndpointIdentitiesEqual` at prepare and commit, including kind,
audience, id and parentId. A private endpoint, sibling thread, parent in place
of the selected topic, or different connection cannot redeem the challenge.
Equal create-request retries must also match the proof endpoint. Existing
token entropy, ten-minute deadline, requester accounting, durable ingress
census before token consumption, single use and memory-only unfinished state
remain with their existing owners. Pairing never becomes a Session prompt.

The authenticated challenge presentation projects optional `proofEndpoint`
for shared proof; the authenticated proposal projects the actual
`proofEndpoint` and immutable `principalId`, preserving `endpointLabel` for
presentation. Shared challenges offer the manual `/pair <code>` at that
location, with no private-chat deep link or QR that changes the scope. Original
human proof still requires a non-null authenticated principal and refuses
forwarded, viaBot, bot, integration, integration-self, anonymous and unknown
senders.

A visible shared token can be copied and raced by another human in the same
endpoint. One winner produces one proposal identifying the actual sender, not
an assertion that the sender is the owner or a group administrator. The owner
must review that principal before enabling the paused binding. If the wrong
person wins, cancel the proposal or retain/unlink the paused result and start
a fresh challenge; a consumed challenge is never reopened. Input allowlisting
does not restrict who can read provider-visible replies in a shared endpoint.

For paired router bootstrap, the initial `threadRouter` target contains exactly
one owner-named `principalGroups` entry with `principalIds: []` and the configured
routes. Pairing-create rejects supplied members. Finalize accepts no target or
principal overrides: it fills the sole group from `proposal.principalId`, runs
the existing target, recipe, route-policy and binding validation, and persists
one paused router whose allowlist is derived only from its groups. An empty
audience is never persisted. Existing edits may reorganize proved retained
principals; adding identities still needs current authoritative proof.
Provider-resolved router creation and Automation-target verification retain
their existing owners. The protocol extension adds no store, migration,
transport, feature flag, deadline or retry owner. Setup rendering and loaded
provider validation are integrated separately; this is not published-package
or stable-release availability evidence.

## V1 role contract

Every role is an ordinary Action. The contribution protocol owns the role map;
Actions do not carry copied role metadata or a second protocol id.

In development V1, inbound messages may carry `message.attachments` as file
descriptors (`attachmentId`, `name`, `mediaType`, optional `byteLength`). An
attachment-only message uses empty `text` and a nonempty descriptor list.
Observations never contain file bytes or filesystem paths. Providers offering
files bind the optional safe `attachmentFetch` role. Its input carries the
current connection fields plus `messageId` and `attachmentIds`; success is
`{ kind: 'fetched', attachments: [{ attachmentId, base64 }] }`, or the existing
`notReady` failure. Apply `assertConversationChannelsCoreCallerV1` before I/O,
as with every other role. Providers fetch and parse the message once for the
consuming batch and retain no staged files. Channels owns secure temporary
files only until each Session transfer settles, including cancellation.
V1 places files in the Session only when its machine matches the connection's
retained Home/Machine placement. On that machine, the resolver extracts text and PDF
text-layer content from the same live bytes it materializes and includes it
once in the attachment's untrusted context. For a remote Session, the Channels
input owner includes text/PDF content in ordinary message text before
`session.send`; dispatch does not fetch the files again.
For a Session on another machine, the attachment resolver reports
`data.file: { kind: 'unavailable', reason: 'attachmentNotAvailableOnThisMachine' }`
through the existing ready attachment result. The context also tells the Agent
that the attachment is not available on this machine; a provider-local pathname
is never presented as a remote Session file. This keeps the message dispatchable
without promising cross-machine file delivery or storing bytes in Collections.

| Role | Cardinality | Input | Result | Action facts |
| --- | --- | --- | --- | --- |
| `setup` | required | contributor-defined | Channels setup result/remediation | `surface: plugin`, `danger: safe` |
| `setupRemediation` | optional; setup repair after `setup` returns `requiresRemediation` | contributor-defined | Channels remediation effect evidence | `surfaces: plugin, ui`, `danger: writesRemote`, approval follows Action policy |
| `connectionTest` | required | Channels | Channels | `surface: plugin`, `danger: safe` |
| `endpointResolve` | optional | Channels | Channels | `surface: plugin`, `danger: safe` |
| `principalResolve` | optional | Channels | Channels | `surface: plugin`, `danger: safe` |
| `observationsPoll` | optional; required when setup selects `checkpointedPull` | Channels | Channels | `surface: plugin`, `danger: safe` |
| `attachmentFetch` | optional | Channels connection + message/file ids | live byte batch or typed failure | `surface: plugin`, `danger: safe` |
| `messageDeliver` | required | Channels | Channels | `surface: plugin`, `danger: writesRemote` |
| `deliveryReconcile` | optional | Channels | Channels | `surface: plugin`, `danger: safe` |
| `connectionStop` | optional; required when setup selects `socket` | Channels | Channels | `surface: plugin`, `danger: writesRemote` |

V1 has no receive-only provider: `messageDeliver` is always required. An
absent optional role means unsupported; do not bind a no-op Action. A provider
must not bind `webhookReceive`. Webhook receive is owned by the generic
verified Webhook contribution and dispatch path, which normalizes the
delivery and calls the Channels observation-ingest Action.

The setup Action's ordinary static metadata is the setup presentation: title,
description, icon/brand projection, and transient Action input hints. The
optional `setupRemediation` Action owns the equivalent remediation form presentation
and consequence copy. Channels' public repair intent and the provider Action use
the shared approval policy. Channels does not add a provider
descriptor, picker registry, setup-specific metadata bag, or Action search. A
provider that needs a second independently selectable offering needs a
separately approved protocol/cardinality amendment.

## Inputs, results, and reverse Actions

The core calls the admitted provider role handles. Providers call back into
the core only through qualified ordinary Actions and the host-stamped caller;
they do not import Channels runtime code. The provider-facing core Action ids
are:

| Core Action | Purpose |
| --- | --- |
| `provider/observation-ingest-v1` | submit one normalized observation or bodyless refusal shell |
| `provider/connections-list-v1` | read the caller-filtered current connection snapshot |
| `provider/connection-read-v1` | read one caller-filtered connection by id |
| `provider/transport-fact-report-v1` | report a current history gap or stop fact |

These are fixed **core** callback ids, not provider Action ids. Import
`CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1` from `/v1` and execute them as
`{ pluginId: 'happier.channels', localId }` through
`context.services.actions.execute(...)`. Do not declare or bind them in your
provider contribution. Your bound provider Action ids remain arbitrary local
ids; the contribution role map is their only meaning.

Each bound provider role must reject a direct invocation or a caller other than
the Channels core before it parses input, reads credentials, opens a network
connection, or performs remote I/O. The caller is host-stamped, never an
Action-input field. Use the shared provider helper from this protocol:

```ts
import { assertConversationChannelsCoreCallerV1 } from '@happier-dev/channels-protocol/v1';

assertConversationChannelsCoreCallerV1(context);
```

Call this at the start of every bound role handler, including `setup`, delivery,
and stop. Before provider I/O, use
`classifyConversationProviderMaterializationFailureV1(error, context.signal)`
for Connected Account materialization failures: unavailable services and
retryable failures yield `notReady/network`, definite credential denial yields
`credentialInvalid`, and cancellation or generation retirement propagates.
Provider HTTP responses and failures after an outward effect starts remain
provider-owned; never classify an uncertain send as a safe materialization retry.
Use `context.signal.throwIfAborted()` at cancellation fences.
A background service has the opposite direction: it calls the core
Actions above with the host-provided Action service, and never invents a caller
or a second reconciliation authority.

Automation result delivery is a separate core-owned Action
(`automation/result-deliver-v1`) and is not a provider role. Providers do not
write Channel collections, checkpoints, custody rows, or Session provenance.

Observation transport (`poll`, `socket`, or `webhook`) is independent of
actor kind (`human`, `integration`, `bot`, or `unknown`). Providers supply
authenticated endpoint, actor, occurrence, message identity/revision,
addressing evidence, and timestamp facts; Channels applies allowlists,
addressing, freshness, command, target, and permission policy. Providers do
not infer addressing from text and do not supply `pluginId`, Account,
binding, Session, or permission authority.

Development-source sender-specific readiness reports may supply
`senderEligibility: { endpoint, principalId }` beside a `providerReadiness`
transport fact. The principal is an unverified diagnostic candidate. The core
checks the current enabled binding audience and router-parent policy before
recording attention, returning `notEligible` without a readiness write for
unconfigured senders. This field never grants message admission and is not
retained in the connection's readiness record.

Development-source poll `bindings` also includes retained ordinary thread
endpoints, alongside the existing linked PR and scoped-trigger context. A
thread entry may carry `excludedMessageIds` for its inbound birth message.
That binding-owned fact preserves first-message shaping if the first census
write fails after child creation.

Providers whose shaping depends on retained thread context can decode the
actual batch's identities, then call the existing
`provider/connection-read-v1` Action with optional
`pollOccurrences: [occurrenceId, ...]`. The caller-filtered connection snapshot
then includes `pollShaping: [{ occurrenceId, endpointWasRetainedAtPoll }]` for
the requested occurrences that have a census. A requested read that cannot
supply its shaping projection is unavailable, not permission to guess. An
occurrence without a retained entry uses the original poll's binding context.
The bound is the existing provider batch bound; an empty poll needs no census
read. Ordinary callers omitting the selector retain the original read result.

The census owner performs exact keyed reads, including compacted censuses;
polling does not enumerate retained history to construct an exception list.
Decode MIME once, resolve this batch's context once, then shape the retained
decoded messages without polling or fetching them again. No separate thread,
shaping store, cache or checkpoint exists. This is an in-place, one-way 0.3
development contract extension, not support for older 0.3 core binaries.

In current 0.3 development source, setup may return
`recommendedMaximumObservationAgeMs`. Preparation preserves it and the setup
form seeds that value; a provider without a recommendation uses the existing
30-day suggestion. Freshness values and provider retry hints accept nonnegative
safe-integer milliseconds, without a one-minute floor or 30-day/24-hour ceiling.
Telegram recommends 24 hours because of its
[update retention](https://core.telegram.org/bots/api#getting-updates).
GitHub and Discord recommend 30 days as provider-owned policy, not a retention
promise: GitHub exposes [comment history with `since`](https://docs.github.com/en/rest/issues/comments#list-issue-comments-for-a-repository),
whereas Discord's [Gateway replay is session-bound](https://docs.discord.com/developers/events/gateway#resuming).

The c0.69 limit ruling supersedes the historical Packet 01 §1.4 count/text/
retry/debounce caps. Channels imposes no per-Account connection or binding
count, generic ingress/delivery text ceiling, chunk-count ceiling, five-attempt
delivery budget, or debounce upper policy limit. Enumerators exhaust paged
Collection queries. Collection request, encoded-row and transport envelopes,
safe-integer representation, and verified provider-native bounds still apply.
Channels core owns native message splitting at each provider's declared
`outboundTextLimit`, preserving grapheme boundaries and complete custody text.
It does not multiply a native message size into a whole-answer limit. Providers
receive one chunk per `messageDeliver` invocation; optional `chunkIndex` is the
ephemeral split ordinal (absent or zero means first), so Telegram attaches the
reply reference only to the first chunk while keeping thread addressing on all
chunks. Discord keeps its native reply reference on every chunk. GitHub declares
65,536 Unicode code points per comment and suppresses mentions with the
one-code-point `＠`, without a guessed local byte ceiling or truncation.
This bound is a retained provider setup fact in the current 0.3 development
source. GitHub connections created before it was declared remain without core
splitting if their retained `outboundTextLimit` is absent. Creating a connection
or successfully transferring it runs setup and retains the current bound;
Retest re-observes readiness only and does not refresh this setup fact.

Known-no-effect delivery failures retain `retryDue` custody and attention,
with growing exponential backoff; a positive provider `retryAfterMs` takes
precedence, while a zero wait uses the growing fallback rather than hot retry.
In current 0.3 development source, an unavailable Account/currentness read before
any provider call settles as `notDelivered` with `retry: 'safe'` through this same
backoff owner. The next attempt rechecks currentness. Proven route mismatches or
invalid authority still suppress delivery without calling the provider; historical
suppressed rows stay terminal. Unavailable currentness after an effect was
attempted retains `outcomeUnknown` custody and never authorizes a resend.
Accepted, partial, or unknown effects never auto-resend. A correlated Session
reply freezes its exact external message/thread relation in existing outward
custody; unrelated mirror output has no reply relation. Mirror mode suppresses
only its own user input, not the final assistant answer to it.

In 0.3 development source, an observation actor may carry
`repositoryWriteAccess: true | false | null` as authenticated evidence for
the observation's repository. Only `true` establishes write access; null or
an omitted field means unknown. The GitHub provider reads this for PR comments
with the Channel's selected credential, once per commenter within a poll.
The evidence does not itself admit a scoped PR-comment workflow; that policy
belongs to its scoped admission owner.

Development-only session PR links use retained GitHub Channel bindings. The
`session-pull-request-binding-v1` Action attaches through the existing binding
writer; scoped PR-comment and CI-failure bindings carry the Automation trigger's
identity and revision. Removing a trigger disables its binding and retains the
link. A successful SCM open/reuse with an origin Session writes through the same
owner, while an originless operation creates no Session link.

`resolveSessionPullRequestLinksV1` projects distinct links in binding creation
order as `{ sessionId, pullRequestLinks: [{ provider: 'github', repository,
number, url }] }`. The canonical projector supplies the GitHub PR URL from the
retained repository and number. Disabled retained bindings are included;
bindings being deleted are excluded. `session.trigger.list` returns the requested
Session's projection.
Account readers use the existing `channel-state` Collection query and change
hints, decode all pages with the Account's plain/E2EE codec, and apply this same
projector. In 0.3 development source, the existing SCM GitHub observation poll
also refreshes retained PR endpoints, including links whose message delivery is
disabled. The exact repository/number observation carries `state` (open,
merged, closed or unknown) and `observedAt` into the Session link projection.
An empty open-PR list is never merge evidence. Inbox and `inbox.get` consume
that same projection. When every retained PR for a Session is merged or closed,
Channels settles through the existing read-state and attention-standing Actions;
an open or unknown PR keeps the Session standing. Failed settlement remains
retryable by that poll. SCM continues to own PR publication and native state
interpretation; Channels owns the retained binding and its refresh lifecycle.

Scoped conversation admission accepts only explicit repository write access
with matching binding, sender, Session, trigger kind and revision. It returns
typed refusal for denied, unknown or mismatched evidence. E2EE hosts seal the
private PR selector and message while carrying explicit public correspondence
and permission evidence for the authenticated server admission check.

Provider delivery returns strict evidence such as `delivered`, `partial`,
`notDelivered`, `endpointArchived`, or `outcomeUnknown`. A provider must not
collapse remote acceptance, local custody settlement, and user-visible
completion into one unqualified success. Once a remote effect may have
started, cancellation cannot erase it and Channels will not blindly retry an
ambiguous effect. Optional `deliveryReconcile` can prove presence or absence;
without it the core settles honestly as unknown when it cannot prove the
effect.

In unreleased 0.3 source, `notDelivered` and `outcomeUnknown` may carry an
optional closed `code`. The delivery result schema owns its content-free
vocabulary; raw provider errors, addresses and message identifiers are not
codes. The existing attempt-settlement diagnostic projects it as
`providerResultCode`. Older omitted-code results remain readable. The code is
diagnostic evidence, not retry or recovery authority.

## Credentials, trust, and authority

Provider plugins are trusted arbitrary code. The contribution contract gives
stable identity, Action surface/danger declarations, cancellation, and
generation/currentness checks; it is not a sandbox. Do not add a provider
registry, service locator, task-shaped restricted context, or custom RPC.

Trust does not erase product-visible effect classification. Keep
`messageDeliver` and `connectionStop` at the exact `writesRemote` danger level
from the role declaration: they may cause an external effect even though the
provider is trusted. Caller verification and trusted-code posture do not make
those Actions `safe`.

Credential custody stays in Connected Accounts:

- declare the exact Connected Account service and HostAccess purpose in the
  provider manifest;
- let the present user select the Account through the host;
- materialize a short-lived credential only inside the admitted Action or
  background invocation with
  `context.services.connectedAccounts.materialize(...)`, the invocation
  `context.signal`, and the exact selected reference;
- echo the selected `credentialRef` in setup, or `null` when no credential is
  needed; and
- never persist, log, return, or place long-lived credential material in
  `providerConfig`, setup input, observations, result evidence, or a provider
  cache.

The host stamps caller identity, Account authority, machine/materialization
facts, execution origin, Session/Automation provenance, and permission facts.
Mutable Action input cannot provide or override those identities. `machineId`
alone is not a stable cross-server identity.

In 0.3 development source, a retained connection stores Home/Machine placement
separately from its provider plugin and stable contribution. It follows the
currently admitted implementation of that same provider there, including
same-ID reinstall or source substitution. Bundled, development and managed
custody changes alone require no transfer, setup rerun or authority-epoch bump.
The generic Action executor enforces the closed `expectedExecutionRouting`
precondition before provider handlers; Channels uses the same host-stamped
routing projection/equality for callbacks. Host currentness, credential/config
validation and connection/binding authority checks still apply. The existing
full `expectedExecutionOrigin` contract is unchanged.

Connection management `revision` is the logical configuration revision.
Bindings, pairing, Test, Retry, transfer and recovery guard that subject, so
poll/readiness bookkeeping does not invalidate an approved action or an open
setup form. Configuration edits and changes to history-gap or pending-stop
custody advance it, including observation-age edits that keep `authorityEpoch`
unchanged. Storage CAS and captured poll/stop invocation witnesses still use
physical Collection revisions. The V8→V9 Collection migration seeds each retained
connection from its source row revision; fresh connections start at 1. This is
0.3 development behavior and requires the updated host and plugin to be loaded.

An actual placement, transport, credential or config replacement still uses
the canonical transfer Action and its checkpoint/predecessor-stop recovery.
Generic durable webhook endpoints keep exact materialization targets and
their existing endpoint-convergence recovery; following a current provider does
not automatically repair an endpoint after reinstall. Retained V7 connection,
Event-target and predecessor placements evolve through Data's V7→V8 migration,
which also compacts endpoint-only pending intent while preserving IDs, config,
cursors, epochs and unresolved effects.

## Cancellation, currentness, and lifecycle

Use the invocation `AbortSignal` for every network, credential, and provider
operation. Re-check current Account/connection/binding/plugin generation before
an external effect and before settling its result. A cancellation or generation
retirement before a remote effect is safe to stop; after an effect starts,
return the provider evidence and let Channels custody classify it as delivered,
partial, retryable, or unknown.

Discovery is cold and target-owned. The host admits declarations without
activating a provider merely to discover it. Target absence leaves a
contribution dormant while the contributor's unrelated Actions remain usable.
Installing or updating the target recomputes the admitted snapshot. Updating
or replacing a contributor invalidates its old handles; uninstall/disable
cancels reachable work and makes retained connections unavailable. Channels
uses the current admitted same-ID contribution at the retained Home/Machine
when it becomes available again, including after reinstall. It does not select
another provider or machine, reconstruct a local Action id, or recreate a
connection around unfinished cleanup.

Provider protocol reconnect/resume, polling backoff, and provider-specific
checkpoint mechanics stay in the provider or the Channels core owner named by
the role. There is no provider-local scheduler, persistent registry, or second
checkpoint/custody owner. A socket provider reports only the explicit
history-gap/transport facts it observed; it must not fabricate a replay cursor.

## Errors and recovery

Expected provider unavailability is an in-band strict result:

```ts
{
  kind: 'notReady',
  reason: 'credentialInvalid' | 'permissionMissing' | 'network' |
    'rateLimited' | 'providerConflict' | 'unsupported' | 'invalidConfiguration',
  retryAfterMs?: number,
  diagnostic?: string,
}
```

The retry delay and diagnostic are bounded. Thrown failures crossing the
generic Action boundary expose only the incumbent closed `code`/`message`
failure. Rich `retryable`, remediation, raw-cause, or provider-error-text
metadata is invocation-local and is not a Channels result authority. Do not
invent a second error classifier. Channels owns retry/custody policy and
turns provider evidence into the user-visible status.

In 0.3 development source, poll Action failures retain the known sentence only
after the SDK's canonical `projectPluginFailureText` projection removes
credentials and local paths. Management re-applies that projection to retained
messages before returning optional `evidence.message`; raw provider diagnostics
remain private. The existing attention description shows this sentence, with
the code-based recovery description as the fallback when no sentence exists.

### Delivery attention conversation identity (development, unreleased)

Each `delivery/attention-v1` row includes its existing owning `bindingId` when
the custody is binding-scoped. Join it to `binding/list-v1` for the conversation's
display label. Connection-only custody omits `bindingId`; it does not borrow a
conversation identity. Content, native endpoint IDs and provider message IDs
remain private. The closed result reader validates the optional binding identity
with the same schema used by binding reads.

## Protocol evolution

The `/v1` epoch is a semantic compatibility boundary. Channels core applies the
repository's [SDK protocol-evolution doctrine](../../docs/compatibility.md#sdk-protocol-evolution)
at each owning schema and union; that doctrine is the sole normative owner for
recursive field/union policy, unknown handling, epoch changes, and direct-cut
rules. This README intentionally does not restate it.

## Conformance and local checks

Use the public fixture helper to create a valid setup result, then override
only provider facts that matter to your test:

```ts
import { describe, expect, it } from 'vitest';
import { ConversationProviderSetupResultV1Schema } from
  '@happier-dev/channels-protocol/v1';
import { createConversationProviderSetupResultV1Fixture } from
  '@happier-dev/channels-protocol/testing/v1';

it('returns a Channels-valid setup result', () => {
  const result = createConversationProviderSetupResultV1Fixture({
    providerConnectionKey: 'telegram:example-bot',
    integrationPrincipal: { id: 'telegram:example-bot' },
  });
  expect(ConversationProviderSetupResultV1Schema.parse(result)).toEqual(result);
});
```

After `definePlugin(...)`, assert the complete declared Channels contribution
at the source-package boundary:

```ts
import { assertConversationProviderContributionV1 } from
  '@happier-dev/channels-protocol/testing/v1';

assertConversationProviderContributionV1(manifest);
```

This calls the public SDK manifest parser, then checks exactly one
`happier.channels/providers` V1 contribution, its display-name descriptor, the required and optional role
bindings, arbitrary same-plugin local Action ids, and each bound Action's
input/result schema, surface, and danger level against the public role
declarations. It is a source-level conformance check, not host admission: it
does not install or activate a plugin, resolve target availability, establish
generation currentness, or perform provider I/O. Those lifecycle checks remain
with the host and managed source-development external-provider gate.

For a source package, run the repository-managed checks from the workspace
root:

```sh
pnpm --filter @happier-dev/channels-protocol run test
pnpm --filter @happier-dev/channels-protocol run typecheck
pnpm --filter @happier-dev/channels-protocol run build
```

For a provider plugin, run its normal managed source-author checks, the public
fixture/import boundary, and the loaded development-stack lifecycle. Feature QA
does not create or install local release archives. Official publication
availability is established only by the release workflow after publication; it
is not a feature-completion gate.

## Release posture

This package is part of the Happier Developer Preview. Its V1 protocol epoch is
stable within `V1`, but the package line itself is pre-1.0 and is published only
through the repository's canonical npm release owner
(`node scripts/pipeline/run.mjs npm-release --publish-channels-protocol true`).
Publishing it from a checkout or any other path is not an approved origin.
Release automation alone establishes publication availability.
