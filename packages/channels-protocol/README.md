# `@happier-dev/channels-protocol`

The public business protocol for Happier Conversation Channels. Use it when
you are authoring a provider plugin that contributes to the Channels core.
The package is deliberately small: it contains the versioned Channels
schemas, role contracts, contribution-point definitions, and public
conformance fixtures. It does not contain a runtime, provider implementation,
registry, UI, polling loop, persistence, or credential materialization.

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

## What a Channels provider is

A provider is a trusted plugin that adapts one external conversation service
to Channels. It contributes ordinary plugin Actions and binds those Actions
to the Channels-owned `happier.channels/providers` contribution point. The
binding is the discovery mechanism. Channels never scans a global Action
catalog, derives an Action id from a plugin id, imports provider code, or
expects a registration callback.

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
        outboundTextLimit: { maximum: 4_000, unit: 'unicodeCodePoints' },
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
      run: async () => ({ kind: 'delivered', providerMessageIds: [] }),
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
package entrypoint, build, test, and pack loop. Add the role Actions and this
one `contributesTo` value to that generated `definePlugin(...)` source. There
is intentionally no Channels-specific scaffold, provider base class, or
registration callback. When the SDK and this protocol are available from an
approved registry, use the released package ranges named there. A workspace
link or a locally packed archive can exercise source mechanics, but it cannot
prove that an outside author can install the public packages.

`ConversationProviderSetupResultV1Schema` is the Channels result validator.
The `setup` Action's input is contributor-defined; all other role inputs and
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

When `supportedTransports` includes `durablePush`, the setup result must carry
exactly one same-provider `webhookContributionRef`. That reference is
correspondence evidence for the generic Webhook endpoint owner, not a
`webhookReceive` provider role. A result that omits it, returns one for
another plugin, or claims durable push without the required reference is
invalid before endpoint creation or persistence.

The current V1 connection create and transfer contracts can select only
`checkpointedPull` or `socket`; Account-endpoint `durablePush` creation remains
held at the generic Webhook ensure/correspondence boundary. `connection/prepare-v1`
therefore projects only those selectable transports and rejects a
durable-push-only setup result before a later create-input parse could fail.

## V1 role contract

Every role is an ordinary Action. The contribution protocol owns the role map;
Actions do not carry copied role metadata or a second protocol id.

| Role | Cardinality | Input | Result | Action facts |
| --- | --- | --- | --- | --- |
| `setup` | required | contributor-defined | Channels setup result/remediation | `surface: plugin`, `danger: safe` |
| `setupRemediation` | optional; usable only after `setup` returns `requiresRemediation` | contributor-defined | Channels remediation effect evidence | `surface: plugin`, `danger: writesRemote`, host confirmation required |
| `connectionTest` | required | Channels | Channels | `surface: plugin`, `danger: safe` |
| `endpointResolve` | optional | Channels | Channels | `surface: plugin`, `danger: safe` |
| `principalResolve` | optional | Channels | Channels | `surface: plugin`, `danger: safe` |
| `observationsPoll` | optional; required when setup selects `checkpointedPull` | Channels | Channels | `surface: plugin`, `danger: safe` |
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
optional `setupRemediation` Action owns the equivalent remediation presentation
and its required host-rendered confirmation. Channels does not add a provider
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
Action-input field. A minimal guard uses only the public SDK:

```ts
import { PluginError, type PluginInvocationContext } from '@happier-dev/plugin-sdk';

function requireChannelsCoreCaller(context: PluginInvocationContext): void {
  if (
    context.surface !== 'plugin'
    || context.caller?.kind !== 'plugin'
    || context.caller.pluginId !== 'happier.channels'
  ) {
    throw new PluginError({
      code: 'channels_core_caller_required',
      message: 'This Channel provider Action must be invoked by the Channels core.',
    });
  }
}
```

Call this at the start of every bound role handler, including `setup`, delivery,
and stop. A background service has the opposite direction: it calls the core
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

Provider delivery returns strict evidence such as `delivered`, `partial`,
`notDelivered`, `endpointArchived`, or `outcomeUnknown`. A provider must not
collapse remote acceptance, local custody settlement, and user-visible
completion into one unqualified success. Once a remote effect may have
started, cancellation cannot erase it and Channels will not blindly retry an
ambiguous effect. Optional `deliveryReconcile` can prove presence or absence;
without it the core settles honestly as unknown when it cannot prove the
effect.

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
does not silently select another provider, reconstruct a local Action id, or
recreate a connection around unfinished cleanup.

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
`happier.channels/providers` V1 contribution, the required and optional role
bindings, arbitrary same-plugin local Action ids, and each bound Action's
input/result schema, surface, and danger level against the public role
declarations. It is a source-level conformance check, not host admission: it
does not install or activate a plugin, resolve target availability, establish
generation currentness, or perform provider I/O. Those lifecycle checks remain
with the host and packed external-provider gate.

For a source package, run the repository-managed checks from the workspace
root:

```sh
yarn workspace @happier-dev/channels-protocol test
yarn workspace @happier-dev/channels-protocol typecheck
yarn workspace @happier-dev/channels-protocol build
```

For a provider plugin, run its normal managed author checks and the public
fixture/import boundary. Workspace links and a local tarball do not establish
official publication availability; that claim requires a clean external
workspace resolving the published SDK and Channels protocol from the approved
origin, then building, packing, installing, admitting, invoking, updating, and
uninstalling the provider. If either published package is unavailable from that
origin, report that external-install proof as blocked rather than substituting
a workspace link, locally built package, candidate tarball, or registry stand-in.
