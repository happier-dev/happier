// @vitest-environment jsdom

import { cloneElement, type ReactElement } from 'react';
import { PluginError, type JsonValue } from '@happier-dev/plugin-sdk';
import type { PluginActionResultById } from '@happier-dev/plugin-sdk/actions';
import type { PluginUiHostApi, PluginUiResourceReference, RenderContext, ResourceContent, ResourceSubscriptionEvent, SelectActionInputResult, SessionStateV1 } from '@happier-dev/plugin-sdk/ui';
import {
  CONVERSATION_MANAGEMENT_ACTION_IDS_V1,
  CONVERSATION_PROVIDERS_CONTRIBUTION_POINT_ID_V1,
  CONVERSATION_PROVIDERS_CONTRIBUTION_PROTOCOL_ID_V1,
  CONVERSATION_PROVIDERS_CONTRIBUTION_PROTOCOL_VERSION_V1,
  ConversationBindingReadResultV1Schema,
} from '@happier-dev/channels-protocol/v1';
import {
  createPluginUiTestkit,
  createSurfaceContextFixture,
  type PluginUiSemanticSurfaceAdapter,
  type PluginUiTestkit,
  type PluginUiTestkitExecuteActionInput,
  type PluginUiTestkitSelectActionInputInput,
  type PluginUiTestkitHostHandlers,
} from '@happier-dev/plugin-sdk/testing';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';

import type {
  PluginUiAccountCollectionForDefinition,
  PluginUiDataClient,
} from '@happier-dev/plugin-ui/data';
import type { PluginAccountCollectionDefinition } from '@happier-dev/plugin-sdk/collections';
// First-party in-tree RNW integration only: these package-private Plugin UI
// imports exercise the actual host composition. They are not an out-of-tree
// author proof, which remains limited to public SDK entrypoints.
import type { PluginUiPresentationHost } from '../../../../plugin-ui/src/presentationHost/context.js';
import { mountThroughReactNativeWebAsync } from '../../../../plugin-ui/src/rnwMount.testSupport.js';
import { createHostApiStub } from '../../../../plugin-ui/src/surfaceFixture.testSupport.js';
import { createUnavailablePluginUiAccountKv } from '../../../../plugin-ui/src/data/accountKv.js';
import {
  CHANNEL_DELIVERIES_INDEX_ID,
  CHANNEL_STATE_COLLECTION,
} from '../collections.js';
import {
  createCurrentConversationConnectionFixture,
  type ConversationConnectionFixtureAuthority,
} from '../testkit/currentConnectionFixture.js';
import { renderSurface } from './renderSurface.js';
import { formatConversationTime } from './conversationRows.js';
import { PLUGIN_MANIFEST } from '../manifest.js';
import { createSessionCandidatePageFixture } from '../testkit/sessionCandidatePageFixture.js';
import { MemoryCollection } from '../testkit/memoryCollection.js';
import { withChannelStateSessionIdentity } from '../collectionMigrations.js';

import { assertChannelsTestCollectionQueryLimit } from '../testkit/collectionQueryBound.js';
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CONNECTIONS_RESOURCE = {
  pluginId: 'happier.channels',
  localId: 'connections-v1',
} as const;

const BINDINGS_RESOURCE = {
  pluginId: 'happier.channels',
  localId: 'bindings-v1',
} as const;

const PAIRING_RESOURCE = {
  pluginId: 'happier.channels',
  localId: 'pairing-v1',
} as const;

function resourceFixtureLocalId(resource: PluginUiResourceReference | Parameters<PluginUiHostApi['watchResource']>[0]): string {
  if (typeof resource === 'string') return resource;
  if (!('localId' in resource)) throw new Error('Expected a plugin Resource reference');
  return resource.localId;
}

function providerProtocol() {
  return {
    id: CONVERSATION_PROVIDERS_CONTRIBUTION_PROTOCOL_ID_V1,
    version: CONVERSATION_PROVIDERS_CONTRIBUTION_PROTOCOL_VERSION_V1,
  } as const;
}

function providerContributor() {
  return {
    pluginId: 'com.example.conversation-provider',
    contributionId: 'conversation-setup',
    occurrenceId: 'provider-occurrence-a',
    sourceCustody: {
      kind: 'managed',
      immutableGenerationId: 'provider-generation-a',
      installSource: 'npm',
    },
  } as const;
}

function providerPortableContributor() {
  return {
    pluginId: 'com.example.conversation-provider',
    contributionId: 'conversation-setup',
    sourceCustody: { kind: 'managed', immutableGenerationId: 'provider-generation-a', installSource: 'npm' },
  } as const;
}

function providerSetupOperationSnapshot() {
  return {
    point: {
      pointId: CONVERSATION_PROVIDERS_CONTRIBUTION_POINT_ID_V1,
      protocol: providerProtocol(),
    },
    contributor: providerContributor(),
    role: 'setup',
    action: {
      pluginId: 'com.example.conversation-provider',
      localId: 'connection-setup',
    },
  } as const;
}

const providerSetupOperation = providerSetupOperationSnapshot();

function providerSetupRemediationOperationSnapshot() {
  return {
    point: {
      pointId: CONVERSATION_PROVIDERS_CONTRIBUTION_POINT_ID_V1,
      protocol: providerProtocol(),
    },
    contributor: providerContributor(),
    role: 'setupRemediation',
    action: {
      pluginId: 'com.example.conversation-provider',
      localId: 'connection-resolve-setup',
    },
  } as const;
}

const providerSetupRemediationOperation = providerSetupRemediationOperationSnapshot();

function jsonResource(value: unknown, digestDigit: string): ResourceContent {
  return {
    contentType: 'application/json',
    digest: `sha256:${digestDigit.repeat(64)}`,
    // Browser-environment suites encode UTF-8 bytes directly; `node:buffer` is
    // externalized under jsdom and its named imports are undefined.
    bytes: new TextEncoder().encode(JSON.stringify(value)),
  };
}

const bindingsResource = jsonResource({
  bindings: [{
    bindingId: 'binding-1',
    revision: 1,
    connectionId: 'connection-1',
    endpoint: { audience: 'direct', label: 'Example conversation' },
    target: { kind: 'session', summary: 'Example session' },
    inputMode: 'directMentionsOnly',
    deliveryMode: 'repliesOnly',
    approval: { kind: 'off' },
    enabled: true,
    deletionState: 'none',
  }],
}, 'a');

const finalizingBindingsResource = jsonResource({
  bindings: [{
    bindingId: 'binding-1',
    revision: 2,
    connectionId: 'connection-1',
    endpoint: { audience: 'direct', label: 'Example conversation' },
    target: { kind: 'session', summary: 'Example session' },
    inputMode: 'directMentionsOnly',
    deliveryMode: 'repliesOnly',
    approval: { kind: 'off' },
    enabled: false,
    deletionState: 'finalizingDelete',
  }],
}, 'f');

function connectionsResourceForTransport(selectedTransport: 'checkpointedPull' | 'durablePush'): ResourceContent {
  return jsonResource({
    connections: [{
      connectionId: 'connection-1',
      revision: 1,
      authorityEpoch: 1,
      providerPluginId: providerSetupOperation.contributor.pluginId,
      selectedMachineId: 'machine-1',
      selectedTransport,
      integrationPrincipalLabel: 'Example conversation',
      enabled: true,
      deletionState: 'none',
      attention: {
        historyGap: null,
        pollFailure: null,
        bestEffortBeforeDurableAdmission: false,
        oldTransportStopUnconfirmed: false,
        endpointRetargetOwed: false,
        acceptedPossibleLoss: false,
        outwardDelivery: {
          retryDue: false,
          notDelivered: false,
          partial: false,
          outcomeUnknown: false,
        },
      },
    }],
  }, selectedTransport === 'checkpointedPull' ? 'b' : 'd');
}

const connectionsResource = connectionsResourceForTransport('checkpointedPull');

/**
 * A connection whose provider authenticated, during setup, that its platform
 * withholds ordinary shared-conversation messages — a Telegram bot with group
 * privacy enabled is the real case.
 */
const connectionsResourceWithoutSharedAllMessages: ResourceContent = jsonResource({
  connections: [{
    connectionId: 'connection-1',
    revision: 1,
    authorityEpoch: 1,
    providerPluginId: providerSetupOperation.contributor.pluginId,
    selectedMachineId: 'machine-1',
    selectedTransport: 'checkpointedPull',
    integrationPrincipalLabel: 'Example conversation',
    sharedEndpointInputModes: ['directMentionsOnly', 'addressedMessages'],
    enabled: true,
    deletionState: 'none',
    attention: {
      historyGap: null,
      pollFailure: null,
      bestEffortBeforeDurableAdmission: false,
      oldTransportStopUnconfirmed: false,
      endpointRetargetOwed: false,
      acceptedPossibleLoss: false,
      outwardDelivery: {
        retryDue: false,
        notDelivered: false,
        partial: false,
        outcomeUnknown: false,
      },
    },
  }],
}, '3');

function connectionsResourceWithProviderReadiness(input: Readonly<{
  code: 'providerPermissionMissing' | 'providerConfigurationInvalid' | 'providerCredentialInvalid';
  diagnostic?: string;
}>): ResourceContent {
  return jsonResource({
    connections: [{
      connectionId: 'connection-1',
      revision: 1,
      authorityEpoch: 1,
      providerPluginId: providerSetupOperation.contributor.pluginId,
      selectedMachineId: 'machine-1',
      selectedTransport: 'checkpointedPull',
      integrationPrincipalLabel: 'Example conversation',
      enabled: true,
      deletionState: 'none',
      attention: {
        historyGap: null,
        providerReadiness: {
          code: input.code,
          ...(input.diagnostic === undefined ? {} : { diagnostic: input.diagnostic }),
        },
        pollFailure: null,
        bestEffortBeforeDurableAdmission: false,
        oldTransportStopUnconfirmed: false,
        endpointRetargetOwed: false,
        acceptedPossibleLoss: false,
        outwardDelivery: {
          retryDue: false,
          notDelivered: false,
          partial: false,
          outcomeUnknown: false,
        },
      },
    }],
  }, 'f');
}

function connectionsResourceWithIngressConflict(): ResourceContent {
  return jsonResource({
    connections: [{
      connectionId: 'connection-1',
      revision: 1,
      authorityEpoch: 1,
      providerPluginId: providerSetupOperation.contributor.pluginId,
      selectedMachineId: 'machine-1',
      selectedTransport: 'checkpointedPull',
      integrationPrincipalLabel: 'Example conversation',
      enabled: true,
      deletionState: 'none',
      attention: {
        historyGap: null,
        providerReadiness: null,
        ingressConflict: { kind: 'occurrenceEvidenceMismatch' },
        pollFailure: {
          phase: 'blocked',
          attemptCount: 1,
          retryNotBeforeMs: null,
          evidence: { kind: 'provider', reason: 'credentialInvalid' },
        },
        bestEffortBeforeDurableAdmission: false,
        oldTransportStopUnconfirmed: false,
        endpointRetargetOwed: false,
        acceptedPossibleLoss: false,
        outwardDelivery: {
          retryDue: false,
          notDelivered: false,
          partial: false,
          outcomeUnknown: false,
        },
      },
    }],
  }, '9');
}

function connectionsResourceWithHistoryGap(input: Readonly<{
  revision: number;
  authorityEpoch: number;
  reportedAt: number;
  reason: 'providerHistoryUnavailable' | 'applicationAdmissionLost';
  digestDigit: string;
}>): ResourceContent {
  return jsonResource({
    connections: [{
      connectionId: 'connection-1',
      revision: input.revision,
      authorityEpoch: input.authorityEpoch,
      providerPluginId: providerSetupOperation.contributor.pluginId,
      selectedMachineId: 'machine-1',
      selectedTransport: 'checkpointedPull',
      integrationPrincipalLabel: 'Example conversation',
      enabled: true,
      deletionState: 'none',
      attention: {
        historyGap: {
          reportedAt: input.reportedAt,
          reason: input.reason,
        },
        pollFailure: null,
        bestEffortBeforeDurableAdmission: false,
        oldTransportStopUnconfirmed: false,
        endpointRetargetOwed: false,
        acceptedPossibleLoss: false,
        outwardDelivery: {
          retryDue: false,
          notDelivered: false,
          partial: false,
          outcomeUnknown: false,
        },
      },
    }],
  }, input.digestDigit);
}

/**
 * A connection an owner deliberately paused whose selected machine is also not
 * receiving messages. Saved enablement and runtime placement are two different
 * facts, and this row is the case where presenting only one of them hides the
 * other.
 */
const pausedAndPollBlockedConnectionsResource = jsonResource({
  connections: [{
    connectionId: 'connection-1',
    revision: 1,
    authorityEpoch: 1,
    providerPluginId: providerSetupOperation.contributor.pluginId,
    selectedMachineId: 'machine-1',
    selectedTransport: 'checkpointedPull',
    integrationPrincipalLabel: 'Example conversation',
    enabled: false,
    deletionState: 'none',
    attention: {
      historyGap: null,
      providerReadiness: null,
      ingressConflict: null,
      pollFailure: {
        phase: 'blocked',
        attemptCount: 1,
        retryNotBeforeMs: null,
        evidence: { kind: 'provider', reason: 'credentialInvalid' },
      },
      bestEffortBeforeDurableAdmission: false,
      oldTransportStopUnconfirmed: false,
      endpointRetargetOwed: false,
      acceptedPossibleLoss: false,
      outwardDelivery: {
        retryDue: false,
        notDelivered: false,
        partial: false,
        outcomeUnknown: false,
      },
    },
  }],
}, '2');

/** The same paused policy with a completely healthy runtime placement. */
const pausedHealthyConnectionsResource = jsonResource({
  connections: [{
    connectionId: 'connection-1',
    revision: 1,
    authorityEpoch: 1,
    providerPluginId: providerSetupOperation.contributor.pluginId,
    selectedMachineId: 'machine-1',
    selectedTransport: 'checkpointedPull',
    integrationPrincipalLabel: 'Example conversation',
    enabled: false,
    deletionState: 'none',
    attention: {
      historyGap: null,
      providerReadiness: null,
      ingressConflict: null,
      pollFailure: null,
      bestEffortBeforeDurableAdmission: false,
      oldTransportStopUnconfirmed: false,
      endpointRetargetOwed: false,
      acceptedPossibleLoss: false,
      outwardDelivery: {
        retryDue: false,
        notDelivered: false,
        partial: false,
        outcomeUnknown: false,
      },
    },
  }],
}, '5');

const oldTransportStopUnconfirmedConnectionsResource = jsonResource({
  connections: [{
    connectionId: 'connection-1',
    revision: 1,
    authorityEpoch: 1,
    providerPluginId: providerSetupOperation.contributor.pluginId,
    selectedMachineId: 'machine-1',
    selectedTransport: 'checkpointedPull',
    integrationPrincipalLabel: 'Example conversation',
    enabled: true,
    deletionState: 'none',
    attention: {
      historyGap: null,
      pollFailure: null,
      bestEffortBeforeDurableAdmission: false,
      oldTransportStopUnconfirmed: true,
      endpointRetargetOwed: false,
      acceptedPossibleLoss: false,
      outwardDelivery: {
        retryDue: false,
        notDelivered: false,
        partial: false,
        outcomeUnknown: false,
      },
    },
  }],
}, 'c');

const endpointRetargetOwedConnectionsResource = jsonResource({
  connections: [{
    connectionId: 'connection-1',
    revision: 1,
    authorityEpoch: 1,
    providerPluginId: providerSetupOperation.contributor.pluginId,
    selectedMachineId: 'machine-1',
    selectedTransport: 'durablePush',
    integrationPrincipalLabel: 'Example conversation',
    enabled: true,
    deletionState: 'none',
    attention: {
      historyGap: null,
      pollFailure: null,
      bestEffortBeforeDurableAdmission: false,
      oldTransportStopUnconfirmed: true,
      endpointRetargetOwed: true,
      acceptedPossibleLoss: false,
      outwardDelivery: {
        retryDue: false,
        notDelivered: false,
        partial: false,
        outcomeUnknown: false,
      },
    },
  }],
}, 'f');

const acceptedPossibleLossConnectionsResource = jsonResource({
  connections: [{
    connectionId: 'connection-1',
    revision: 2,
    authorityEpoch: 2,
    providerPluginId: providerSetupOperation.contributor.pluginId,
    selectedMachineId: 'machine-1',
    selectedTransport: 'checkpointedPull',
    integrationPrincipalLabel: 'Example conversation',
    enabled: true,
    deletionState: 'none',
    attention: {
      historyGap: null,
      pollFailure: null,
      bestEffortBeforeDurableAdmission: false,
      oldTransportStopUnconfirmed: true,
      endpointRetargetOwed: false,
      acceptedPossibleLoss: true,
      outwardDelivery: {
        retryDue: false,
        notDelivered: false,
        partial: false,
        outcomeUnknown: false,
      },
    },
  }],
}, 'e');

function createChannelsSurfaceContext(
  accountEncryptionMode?: 'plain' | 'e2ee',
  includeSetupRemediation = false,
) {
  return createSurfaceContextFixture({
    mount: {
      kind: 'destination',
      destination: { pluginId: 'happier.channels', localId: 'channels-account' },
      container: 'rightSidebarTab',
    },
    targetedContributions: {
      target: {
        pluginId: 'happier.channels',
        occurrenceId: 'channels-target-occurrence-a',
        sourceCustody: { kind: 'development', registeredRootId: 'channels-target-root-a' },
      },
      points: [{
        pointId: CONVERSATION_PROVIDERS_CONTRIBUTION_POINT_ID_V1,
        protocols: [{
          protocol: providerProtocol(),
          contributions: [{
            contributor: providerContributor(),
            protocol: providerProtocol(),
            operations: [
              providerSetupOperationSnapshot(),
              ...(includeSetupRemediation ? [providerSetupRemediationOperationSnapshot()] : []),
            ],
            surfaces: [],
          }],
        }],
      }],
    },
    ...(accountEncryptionMode === undefined ? {} : { accountEncryptionMode }),
  });
}

/**
 * The Channels page mount: the one owner of conversation bindings. Its
 * location is the open binding id (`subPath`).
 */
function createChannelsPageSurfaceContext(
  accountEncryptionMode?: 'plain' | 'e2ee',
) {
  return {
    ...createChannelsSurfaceContext(accountEncryptionMode),
    mount: {
      kind: 'destination',
      destination: { pluginId: 'happier.channels', localId: 'conversations' },
      container: 'appPage',
    },
    target: { kind: 'app' },
  } as const satisfies ReturnType<typeof createChannelsSurfaceContext>;
}

/** A reachable Account state: nothing on this machine contributes a provider. */
function createChannelsSurfaceContextWithoutProviders() {
  return createSurfaceContextFixture({
    mount: {
      kind: 'destination',
      destination: { pluginId: 'happier.channels', localId: 'channels-account' },
      container: 'rightSidebarTab',
    },
    targetedContributions: {
      target: {
        pluginId: 'happier.channels',
        occurrenceId: 'channels-target-occurrence-a',
        sourceCustody: { kind: 'development', registeredRootId: 'channels-target-root-a' },
      },
      points: [{
        pointId: CONVERSATION_PROVIDERS_CONTRIBUTION_POINT_ID_V1,
        protocols: [{ protocol: providerProtocol(), contributions: [] }],
      }],
    },
  });
}

function createChannelsSurfaceContextWithForeignProvider() {
  return createSurfaceContextFixture({
    mount: {
      kind: 'destination',
      destination: { pluginId: 'happier.channels', localId: 'channels-account' },
      container: 'rightSidebarTab',
    },
    targetedContributions: {
      target: {
        pluginId: 'happier.channels',
        occurrenceId: 'channels-target-occurrence-a',
        sourceCustody: { kind: 'development', registeredRootId: 'channels-target-root-a' },
      },
      points: [{
        pointId: CONVERSATION_PROVIDERS_CONTRIBUTION_POINT_ID_V1,
        protocols: [{
          protocol: providerProtocol(),
          contributions: [{
            contributor: {
              pluginId: 'com.example.alt-conversation-provider',
              contributionId: 'conversation-setup',
              occurrenceId: 'other-provider-occurrence-a',
              sourceCustody: {
                kind: 'managed',
                immutableGenerationId: 'other-provider-generation-a',
                installSource: 'npm',
              },
            },
            protocol: providerProtocol(),
            operations: [{
              point: {
                pointId: CONVERSATION_PROVIDERS_CONTRIBUTION_POINT_ID_V1,
                protocol: providerProtocol(),
              },
              contributor: {
                pluginId: 'com.example.alt-conversation-provider',
                contributionId: 'conversation-setup',
                occurrenceId: 'other-provider-occurrence-a',
                sourceCustody: {
                  kind: 'managed',
                  immutableGenerationId: 'other-provider-generation-a',
                  installSource: 'npm',
                },
              },
              role: 'setup',
              action: {
                pluginId: 'com.example.alt-conversation-provider',
                localId: 'connection-setup',
              },
            }],
            surfaces: [],
          }, {
            contributor: providerContributor(),
            protocol: providerProtocol(),
            operations: [providerSetupOperationSnapshot()],
            surfaces: [],
          }],
        }],
      }],
    },
  });
}

// First-party mounted-surface coverage installs the same private Data client
// capability that a host adds after `renderSurface` returns. This bounded
// boundary fake models an empty direct Account attention page; the tested
// provider setup still reaches only the public host Action/Resource seam.
const emptyDataClient: PluginUiDataClient = {
  collection: <TDefinition extends PluginAccountCollectionDefinition>() => (({
    get: async () => null,
    put: async () => { throw new Error('This mounted provider-setup test does not write Account data.'); },
    delete: async () => { throw new Error('This mounted provider-setup test does not delete Account data.'); },
    query: async (request?: Readonly<{ limit?: number }>) => {
      assertChannelsTestCollectionQueryLimit(request?.limit);
      return { rows: [], nextCursor: undefined, changeCursor: 0 };
    },
    batch: async () => { throw new Error('This mounted provider-setup test does not batch Account data.'); },
    // The Data boundary is generic over the caller's definition; this fixture
    // supplies the one Channel state Collection the surface reads.
  }) as unknown as PluginUiAccountCollectionForDefinition<TDefinition>),
  openCollectionQuery: async () => {
    throw new Error('This mounted provider-setup test does not open generic Account queries.');
  },
  // This surface never reaches Account KV or Settings; the truthful
  // unavailable scope fails loudly if that ever changes.
  accountKv: createUnavailablePluginUiAccountKv(),
};

/** Mirrors the host's post-render private Data binding without widening author context. */
function createChannelsSemanticAdapter(
  dataClient: PluginUiDataClient = emptyDataClient,
  presentationHost?: PluginUiPresentationHost,
  adapterOptions?: Parameters<typeof createPluginUiRnwSemanticSurfaceAdapter>[0],
): PluginUiSemanticSurfaceAdapter<typeof renderSurface> {
  const rnwAdapter = createPluginUiRnwSemanticSurfaceAdapter(adapterOptions);
  return {
    async mount(input) {
      return await rnwAdapter.mount({
        ...input,
        surface: (context: RenderContext): ReactElement => cloneElement(
          input.surface(context) as ReactElement<{
            dataClient?: PluginUiDataClient;
            presentationHost?: PluginUiPresentationHost;
          }>,
          {
            dataClient,
            ...(presentationHost === undefined ? {} : { presentationHost }),
          },
        ),
      });
    },
  };
}

async function pressByTestId(testID: string): Promise<void> {
  // The public semantic fixture intentionally omits renderer-private test ids.
  // This one selector identifies the specific recovery action among several
  // correctly named Refresh buttons; all behavioral assertions remain through
  // the mounted semantic boundary below.
  const element = document.querySelector<HTMLElement>(`[data-testid="${testID}"]`);
  expect(element, `Expected mounted control ${testID}`).not.toBeNull();
  await act(async () => { element?.click(); });
}

/** A delivery decision is folded under its custody row until the owner opens it. */
async function openDeliveryDecision(custodyId: string): Promise<void> {
  const header = `channels-delivery-resolution-${custodyId}.header`;
  await vi.waitFor(() => {
    expect(document.querySelector(`[data-testid="${header}"]`), `Expected delivery row ${custodyId}`).not.toBeNull();
  });
  await pressByTestId(header);
}

async function pressButtonWithAccessibleLabelFragment(fragment: string): Promise<void> {
  const element = Array.from(document.querySelectorAll<HTMLElement>('[role="button"]')).find((candidate) => (
    candidate.getAttribute('aria-label')?.includes(fragment)
  ));
  expect(element, `Expected mounted button whose accessible label includes ${JSON.stringify(fragment)}`).not.toBeNull();
  await act(async () => { element?.click(); });
}

/** Choose one option of a field Select through the shared menu it opens. */
async function chooseFieldOption(fieldLabel: string, optionLabel: string): Promise<void> {
  const findOption = () => Array.from(document.querySelectorAll<HTMLElement>('[role="menuitemradio"]'))
    .find((item) => item.textContent?.includes(optionLabel));
  // A live reread can remount the row while the menu opens; open it again until its options are there.
  const option = await vi.waitFor(async () => {
    if (findOption() === undefined) {
      const trigger = Array.from(document.querySelectorAll<HTMLElement>('[aria-haspopup="menu"]')).find((candidate) => (
        candidate.getAttribute('aria-label')?.includes(fieldLabel)
      ));
      expect(trigger, `Expected a ${JSON.stringify(fieldLabel)} field menu trigger`).toBeDefined();
      await act(async () => { trigger?.click(); });
    }
    const candidate = findOption();
    expect(candidate, `Expected a ${JSON.stringify(optionLabel)} option in the ${fieldLabel} menu`).toBeDefined();
    return candidate!;
  });
  await act(async () => { option.click(); });
}

/** The current value a closed field Select states on its trigger. */
function expectFieldValue(fieldLabel: string, optionLabel: string): void {
  const trigger = Array.from(document.querySelectorAll<HTMLElement>('[role="button"]')).find((candidate) => (
    candidate.getAttribute('aria-label')?.includes(fieldLabel)
  ));
  expect(trigger?.textContent ?? trigger?.getAttribute('aria-label')).toContain(optionLabel);
}

/** Exercise the mounted RNW field through its real browser input event. */
async function enterTextByTestId(testID: string, value: string): Promise<void> {
  const input = document.querySelector<HTMLInputElement>(`[data-testid="${testID}"]`);
  expect(input, `Expected mounted input ${testID}`).not.toBeNull();
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  expect(setter, 'Expected the mounted input value setter.').toBeTypeOf('function');
  await act(async () => {
    setter?.call(input, value);
    input?.dispatchEvent(new Event('input', { bubbles: true }));
    input?.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

/** Exercise a mounted field by its public accessible label, never a renderer id. */
async function enterTextByAccessibleLabel(label: string, value: string): Promise<void> {
  const input = Array.from(document.querySelectorAll<HTMLInputElement>('input')).find((candidate) => (
    candidate.getAttribute('aria-label') === label
  ));
  expect(input, `Expected mounted input labelled ${JSON.stringify(label)}`).not.toBeNull();
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  expect(setter, 'Expected the mounted input value setter.').toBeTypeOf('function');
  await act(async () => {
    setter?.call(input, value);
    input?.dispatchEvent(new Event('input', { bubbles: true }));
    input?.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

const bindingEndpointCandidate = {
  kind: 'shared' as const,
  audience: 'shared' as const,
  id: 'room-project',
  label: 'Project room',
};

const bindingEndpointSelection = {
  query: 'project-room',
  selected: {
    kind: 'shared' as const,
    audience: 'shared' as const,
    id: 'room-project',
  },
};

/** The shared destination as the pairing writer freezes it for shared proof. */
const bindingSharedProofEndpoint = {
  kind: 'shared' as const,
  audience: 'shared' as const,
  id: 'room-project',
  label: 'Project room',
};

/** A direct conversation keeps the private proof path and its link. */
const bindingDirectEndpointCandidate = {
  kind: 'direct' as const,
  audience: 'direct' as const,
  id: 'chat-ada',
  label: 'Ada',
};

const bindingDirectEndpointSelection = {
  query: 'project-room',
  selected: {
    kind: 'direct' as const,
    audience: 'direct' as const,
    id: 'chat-ada',
  },
};

const bindingPrincipalCandidate = {
  id: 'principal-ada',
  kind: 'human' as const,
  label: 'Ada',
};

const bindingPrincipalSelection = {
  query: 'ada',
  selected: [{
    id: 'principal-ada',
    kind: 'human' as const,
  }],
};

async function openBindingEndpointSelection(
  fixture: PluginUiTestkit,
  candidateLabel: string = bindingEndpointCandidate.label,
): Promise<void> {
  await fixture.press(await fixture.getByRole('button', { name: 'Add binding' }));
  await enterTextByTestId('channels-binding-create-endpoint-query', bindingEndpointSelection.query);
  await fixture.press(await fixture.getByRole('button', { name: 'Search endpoints' }));
  await fixture.press(await fixture.getByRole('button', { name: candidateLabel }));
}

async function searchBindingPrincipal(fixture: PluginUiTestkit): Promise<void> {
  await enterTextByTestId('channels-binding-create-principal-query', bindingPrincipalSelection.query);
  await fixture.press(await fixture.getByRole('button', { name: 'Search people' }));
}

async function selectPrincipalAndOpenTarget(fixture: PluginUiTestkit): Promise<void> {
  await searchBindingPrincipal(fixture);
  await fixture.press(await fixture.getByRole('checkbox', {
    name: `${bindingPrincipalCandidate.label}: ${bindingPrincipalCandidate.id}`,
    state: { checked: false },
  }));
  await fixture.press(await fixture.getByRole('button', { name: 'Continue' }));
}

async function expectBindingCreateStage(
  fixture: PluginUiTestkit,
  input: Readonly<{
    title: string;
    hasBack: boolean;
  }>,
): Promise<void> {
  // The step is named once, by its heading; no second "Current step" line repeats it.
  await expect(fixture.getByRole('heading', { name: input.title })).resolves.toBeDefined();
  expect(document.body.textContent).not.toContain('Current step');
  const actions = document.querySelector<HTMLElement>('[data-testid="channels-binding-create-step-actions"]');
  expect(actions, 'Expected one action row for the step.').not.toBeNull();

  await expect(fixture.getByRole('button', { name: 'Cancel' })).resolves.toBeDefined();
  if (input.hasBack) {
    await expect(fixture.getByRole('button', { name: 'Back' })).resolves.toBeDefined();
  } else {
    await expect(fixture.queryByRole('button', { name: 'Back' })).resolves.toBeUndefined();
  }
}

function bindingResourceReader(
  readBindings: () => ResourceContent | Promise<ResourceContent> = () => bindingsResource,
): NonNullable<PluginUiTestkitHostHandlers['readResource']> {
  return async ({ resource }) => {
    const localId = resourceFixtureLocalId(resource);
    if (localId === BINDINGS_RESOURCE.localId) return await readBindings();
    if (localId === CONNECTIONS_RESOURCE.localId) return connectionsResource;
    throw new Error(`Unexpected Resource: ${localId}`);
  };
}

/** The mounted presentation host every focus-transfer assertion below shares. */
function focusTransferPresentationHost(): PluginUiPresentationHost {
  return {
    focusTarget: (target: unknown): boolean => {
      const focus = (target as Readonly<{ focus?: () => void }> | null)?.focus;
      if (typeof focus !== 'function') return false;
      focus.call(target);
      return true;
    },
    renderMarkdown: () => null,
    renderCodeBlock: () => null,
    renderPopover: () => null,
    renderIcon: () => null,
  } satisfies PluginUiPresentationHost;
}

type OfflineChannelStateRow = Readonly<{
  rowId: string;
  revision: number;
  value: Record<string, unknown>;
}>;

const offlineMaterialization = {
  pluginId: 'happier.channel.example',
  machineId: 'machine-1',
  materializationId: 'materialization-1',
} as const;

function offlineConnectionRow(): OfflineChannelStateRow {
  const connection = createCurrentConversationConnectionFixture({
    connectionId: 'connection-1',
    authority: {
      providerPluginId: offlineMaterialization.pluginId,
      providerContributionSelection: {
        contributionId: 'test-provider',
      },
      providerSetupInput: { source: 'test' },
      credentialRef: null,
      transportOrigin: { serverIdentityId: 'srv_account_one', materializationRef: offlineMaterialization },
      providerConnectionKey: 'connection-key-1',
      providerConfig: {},
      routingIdentityKey: 'r'.repeat(43),
      integrationPrincipal: { id: 'bot-1', label: 'Example conversation' },
      authorityEpoch: 1,
    } satisfies ConversationConnectionFixtureAuthority,
    createdAt: 1_000,
    updatedAt: 1_000,
    transport: { kind: 'socket' },
    overlapSafety: 'safe',
    replayContinuity: 'none',
    outboundTextLimit: { maximum: 4_000, unit: 'unicodeCodePoints' },
  });
  return { rowId: 'connection-1', revision: 4, value: { ...connection } };
}

function offlineBindingRow() {
  return {
    rowId: 'binding-1',
    revision: 5,
    value: {
      id: 'binding-1',
      'record-kind': 'binding',
      v: 1,
      'connection-id': 'connection-1',
      'binding-id': 'binding-1',
      'session-id': 'session-1',
      'created-at': 1_000,
      'updated-at': 1_000,
      payload: {
        endpoint: { kind: 'direct', audience: 'direct', id: 'chat-1', label: 'Example conversation' },
        target: {
          kind: 'session',
          sessionId: 'session-1',
          policy: {
            deliveryMode: 'repliesOnly',
            permissionCeiling: 'read-only',
            approvals: { kind: 'off' },
            newSession: { kind: 'off' },
          },
        },
        allowedPrincipalIds: ['person-1'],
        allowBotSenders: false,
        inputMode: 'allAllowedMessages',
        inboundDebounceMs: 750,
        linkPreviewPolicy: 'suppress',
        senderFeedback: 'off',
        authorityEpoch: 1,
        enabled: false,
        deletionState: 'none',
      },
    },
  } satisfies OfflineChannelStateRow;
}

/**
 * The cold-offline mount has no Resource method at all, so this bounded Account
 * Data fake is the only state authority the surface can reach. It models the
 * canonical `channelState` rows and the generic CAS batch contract; every
 * Channels decision under test still runs through the real plugin owners.
 */
/** One canonical ambiguous outward-custody row the shared parser accepts. */
const OFFLINE_AMBIGUOUS_CUSTODY_ID = 'c'.repeat(43);

function offlineArchiveRecoverableDeliveryRow() {
  const row = offlineAmbiguousDeliveryRow();
  return {
    ...row,
    value: {
      ...row.value,
      payload: {
        ...row.value.payload,
        state: 'notDelivered',
        archiveRecovery: 'unarchiveAndRetry',
      },
    },
  };
}

function offlineAmbiguousDeliveryRow() {
  return {
    rowId: OFFLINE_AMBIGUOUS_CUSTODY_ID,
    revision: 3,
    value: {
      id: OFFLINE_AMBIGUOUS_CUSTODY_ID,
      'record-kind': 'outward-delivery',
      v: 1,
      'connection-id': 'connection-1',
      'binding-id': 'binding-1',
      terminal: true,
      attention: true,
      'created-at': 1_000,
      'updated-at': 2_000,
      payload: {
        source: { kind: 'controlResponse', controlId: 'control-1', controlKind: 'recovery' },
        endpoint: { kind: 'direct', audience: 'direct', id: 'chat-1' },
        routeAuthority: {
          connectionAuthorityEpoch: 1,
          bindingRevision: 1,
          bindingAuthorityEpoch: 1,
        },
        content: { text: 'Ambiguous delivery body.' },
        deliveryKey: 'delivery-offline-ambiguous',

        linkPreviewPolicy: 'default',
        replyContext: null,
        state: 'outcomeUnknown',
        attemptCount: 1,
        attemptId: null,

        providerMessageIds: [],
        failedChunk: null,
        archiveRecovery: null,
      },
    },
  };
}

function createOfflineChannelStateFixture() {
  const collection = new MemoryCollection<OfflineChannelStateRow['value']>();
  const rows = collection.rows;
  for (const row of [offlineConnectionRow(), offlineBindingRow()]) rows.set(row.rowId, row);
  const batches: readonly Readonly<Record<string, unknown>>[][] = [];
  const mutableBatches = batches as Readonly<Record<string, unknown>>[][];
  const stateCollection = {
    rows,
    batches,
    async get(rowId: string) {
      const failedGet = stateCollection.failNextGetWith;
      if (failedGet !== undefined) {
        stateCollection.failNextGetWith = undefined;
        throw failedGet;
      }
      return rows.get(rowId) ?? null;
    },
    async query(request: Readonly<{ index: string; prefix?: readonly string[]; limit: number }>) {
      return collection.query(request);
    },
    /** Set to make exactly the next single-row read throw, then clear. */
    failNextGetWith: undefined as PluginError | undefined,
    /** Set to make exactly the next batch settle ambiguously, then clear. */
    failNextBatchWith: undefined as PluginError | undefined,
    async batch(operations: readonly Readonly<Record<string, unknown>>[]) {
      mutableBatches.push([...operations]);
      const ambiguous = stateCollection.failNextBatchWith;
      if (ambiguous !== undefined) {
        stateCollection.failNextBatchWith = undefined;
        throw ambiguous;
      }
      for (const operation of operations) {
        const value = operation.value as Readonly<{ id: string }> | undefined;
        const rowId = operation.kind === 'put' ? value?.id ?? '' : String(operation.rowId);
        const current = rows.get(rowId);
        if (current?.revision !== operation.expectedRevision) {
          return { status: 'conflict' as const, conflicts: [] };
        }
      }
      const results = operations.flatMap((operation) => {
        if (operation.kind !== 'put') return [];
        const value = operation.value as Record<string, unknown> & Readonly<{ id: string }>;
        const revision = (rows.get(value.id)?.revision ?? 0) + 1;
        rows.set(value.id, { rowId: value.id, revision, value });
        return [{ rowId: value.id, revision, deleted: false as const }];
      });
      return { status: 'updated' as const, results };
    },
    watch: () => ({ dispose() { /* no host invalidation in this fixture */ } }),
  };
  const deliveryRows = new Map<string, OfflineChannelStateRow>();
  const emptyCollection = {
    rows: deliveryRows,
    async get(rowId: string) {
      return deliveryRows.get(rowId) ?? null;
    },
    async query(request: Readonly<{
      index: string;
      prefix?: readonly unknown[];
      prefixes?: readonly (readonly unknown[])[];
      range?: Readonly<{ lower?: unknown; upper?: unknown }>;
      limit?: number;
    }>) {
      assertChannelsTestCollectionQueryLimit(request.limit);
      if (request.index !== CHANNEL_DELIVERIES_INDEX_ID.byConnectionAttention
        && request.index !== CHANNEL_DELIVERIES_INDEX_ID.byOwnerAttention) {
        return { rows: [], changeCursor: 1 };
      }
      const matching = [...deliveryRows.values()]
        .filter((row) => (request.prefixes ?? [request.prefix]).some(prefix => row.value['connection-id'] === prefix?.[0]
          && (request.index === CHANNEL_DELIVERIES_INDEX_ID.byOwnerAttention
            || (row.value.attention === true
              // The attention owner uses a full prefix; the resolution page
              // selects the same scalar with an equality range.
              && (prefix?.[1] === true
                || (request.range?.lower === true && request.range?.upper === true))))))
        .sort((left, right) => left.rowId.localeCompare(right.rowId));
      return { rows: matching, changeCursor: 1 };
    },
    async put(value: Record<string, unknown>, request: Readonly<{ expectedRevision: number | 'absent' }>) {
      const rowId = String(value.id);
      const current = deliveryRows.get(rowId);
      if (current?.revision !== request.expectedRevision) {
        throw Object.assign(new Error('conflict'), { code: 'plugin_collection_conflict' });
      }
      const row = { rowId, revision: current.revision + 1, value } as OfflineChannelStateRow;
      deliveryRows.set(rowId, row);
      return row;
    },
    async batch() {
      throw new Error('The offline Channels fixture does not batch deliveries.');
    },
    watch: () => ({ dispose() { /* no host invalidation in this fixture */ } }),
  };
  // Boundary fixture only: the private Data client is a host capability with no
  // public constructor, so the fake is asserted at this one seam.
  const dataClient = {
    collection: (definition: Readonly<{ id: string }>) => (
      definition.id === CHANNEL_STATE_COLLECTION.id ? stateCollection : emptyCollection
    ),
    openCollectionQuery: async () => {
      throw new Error('The offline Channels fixture does not open generic Account queries.');
    },
  } as unknown as PluginUiDataClient;
  return { collection: stateCollection, deliveries: emptyCollection, dataClient };
}

describe('Channels mounted provider setup recovery', () => {
  describe.each(['setup', 'transfer'] as const)('%s selector', (journey) => {
  it.each([
    { code: 'stale_surface', diagnostic: 'action_retired', state: 'stale', message: undefined },
    { code: 'stale_surface', diagnostic: 'host_retired', state: 'stale', message: undefined },
    { code: 'unavailable', diagnostic: 'host_unavailable', state: 'unavailable', message: 'The provider input schema could not be read.' },
    { code: 'unavailable', diagnostic: 'connected_account_ambiguous', state: 'unavailable', message: 'Choose a Connected Account for this provider.' },
    { code: 'invalid_payload', diagnostic: 'invalid_draft', state: 'invalid', message: 'The provider setup input is invalid.' },
    { code: 'invalid_payload', diagnostic: 'select_action_input_result_invalid', state: 'invalid', message: undefined },
    { code: 'ui_host_unavailable', diagnostic: 'host_unavailable', state: 'unavailable', message: undefined },
  ] as const)('preserves the setup selector refusal $code / $diagnostic as $state, with explicit recovery', async ({ code, diagnostic, state, message }) => {
    const selectActionInput = vi.fn(async () => {
      if (selectActionInput.mock.calls.length === 1) {
        throw new PluginError({ code, ...(message === undefined ? {} : { message }),
          diagnostics: [{ code: diagnostic, severity: 'error' }] });
      }
      return { kind: 'cancelled' as const };
    });
    const executeAction = vi.fn(async () => {
      throw new Error('A refused input selection must not prepare or create a connection.');
    });
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'selector-refusal', mountNonce: 'selector-refusal' },
      authorPlugin: { id: 'happier.channels', version: '0.0.0' },
      surface: renderSurface,
      surfaceContext: createChannelsSurfaceContext(),
      adapter: createChannelsSemanticAdapter(),
      handlers: { selectActionInput, executeAction, readResource: bindingResourceReader() },
    });
    try {
      if (journey === 'transfer') {
        await pressButtonWithAccessibleLabelFragment('Example conversation');
        await fixture.press(await fixture.getByRole('button', { name: 'Transfer connection' }));
      }
      await fixture.press(await fixture.getByRole('button', { name: journey === 'setup'
        ? 'Set up Integration provider' : 'Transfer with Integration provider' }));
      const selector = `[data-testid="channels-${journey === 'setup' ? 'provider-setup' : 'connection-transfer'}-selection-${state}"]`;
      await vi.waitFor(() => expect(document.querySelector(selector)).not.toBeNull());
      expect(document.querySelector(selector)?.textContent?.includes('no longer current')).toBe(state === 'stale' && journey === 'setup');
      if (message !== undefined) expect(document.querySelector(selector)?.textContent).toContain(message);
      await fixture.press(await fixture.getByRole('button', { name: 'Details' }));
      expect(document.querySelector(selector)?.textContent).toContain(code);
      expect(document.querySelector(selector)?.textContent).toContain(diagnostic);
      expect(selectActionInput).toHaveBeenCalledTimes(1);
      expect(executeAction).not.toHaveBeenCalled();
      if (state !== 'stale') {
        await fixture.press(await fixture.getByRole('button', { name: 'Retry' }));
        await vi.waitFor(() => expect(selectActionInput).toHaveBeenCalledTimes(2));
        expect(document.querySelector(selector)).toBeNull();
        expect(executeAction).not.toHaveBeenCalled();
      }
    } finally { await fixture.dispose(); }
  });
  });

  it.each([
    { code: 'plugin_resource_context_unavailable', diagnostic: 'plugin_resource_context_unavailable', message: 'Resource context is unavailable.' },
    { code: 'unavailable', diagnostic: 'host_unavailable', message: 'The selected machine could not read connections.' },
    { code: 'invalid_payload', diagnostic: 'plugin_resource_result_invalid', message: 'The connection Resource returned invalid data.' },
  ])('preserves the connection Resource refusal $code / $diagnostic and retries the read', async ({ code, diagnostic, message }) => {
    let refused = true;
    const readResource = bindingResourceReader();
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'connection-refusal', mountNonce: 'connection-refusal' },
      authorPlugin: { id: 'happier.channels', version: '0.0.0' },
      surface: renderSurface,
      surfaceContext: createChannelsSurfaceContext(),
      adapter: createChannelsSemanticAdapter(),
      handlers: { readResource: async (input) => {
        if (resourceFixtureLocalId(input.resource) === CONNECTIONS_RESOURCE.localId && refused) {
          throw new PluginError({ code, message, diagnostics: [{ code: diagnostic, severity: 'error' }] });
        }
        return readResource(input);
      } },
    });
    try {
      const selector = '[data-testid="channels-connections-error"]';
      await vi.waitFor(() => expect(document.querySelector(selector)?.textContent).toContain(message));
      await fixture.press(await fixture.getByRole('button', { name: 'Details' }));
      expect(document.querySelector(selector)?.textContent).toContain(code);
      expect(document.querySelector(selector)?.textContent).toContain(diagnostic);
      expect(document.querySelector(selector)?.textContent).not.toContain('no longer current');
      refused = false;
      await pressByTestId('channels-connections-retry');
      await vi.waitFor(() => expect(document.querySelector(selector)).toBeNull());
      expect(document.querySelector('[data-testid="channels-connections-list"]')).not.toBeNull();
    } finally { await fixture.dispose(); }
  });

  it('presents an invalid connection Resource by its parser reason, not a transport refusal', async () => {
    const readResource = bindingResourceReader();
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'connection-invalid', mountNonce: 'connection-invalid' },
      authorPlugin: { id: 'happier.channels', version: '0.0.0' },
      surface: renderSurface,
      surfaceContext: createChannelsSurfaceContext(),
      adapter: createChannelsSemanticAdapter(),
      handlers: { readResource: async (input) => resourceFixtureLocalId(input.resource) === CONNECTIONS_RESOURCE.localId
        ? jsonResource({ connections: [{}] }, 'f') : readResource(input) },
    });
    try {
      await vi.waitFor(() => expect(document.querySelector('[data-testid="channels-connections-error"]')?.textContent)
        .toContain('The connection Resource contains an invalid connection.'));
    } finally { await fixture.dispose(); }
  });

  it('names an installed provider by its admitted descriptor in the setup picker', async () => {
    const surfaceContext = createChannelsSurfaceContext();
    Object.assign(surfaceContext.targetedContributions!.points[0]!.protocols[0]!.contributions[0]!, {
      descriptor: { v: 1, displayName: 'Comet Chat' },
    });
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'provider-name-instance', mountNonce: 'provider-name-mount' },
      authorPlugin: { id: 'happier.channels', version: '0.0.0' },
      surface: renderSurface,
      surfaceContext,
      adapter: createChannelsSemanticAdapter(),
      handlers: {
        selectActionInput: async () => ({ kind: 'cancelled' as const }),
        readResource: bindingResourceReader(),
      },
    });
    try {
      const picker = document.querySelector('[data-testid="channels-provider-setup-picker"]');
      expect(picker?.textContent).toContain('Comet Chat');
      await expect(fixture.getByRole('button', { name: 'Set up Comet Chat' })).resolves.toBeDefined();
      await vi.waitFor(() => {
        const connection = document.querySelector('[data-testid="channels-connection-connection-1"]');
        expect(connection?.textContent).toContain('Comet Chat');
      });
    } finally {
      await fixture.dispose();
    }
  });

  it.each(['empty provider snapshot', 'Account presentation without an occurrence'] as const)(
    'offers a next step instead of an empty surface with %s', async (scope) => {
    // A fresh Account, or a machine with no conversation integration enabled,
    // reaches this state. Rendering nothing left the person with no way to
    // learn why the page is empty or what to do about it.
    const surfaceContext = createChannelsSurfaceContextWithoutProviders();
    if (scope === 'Account presentation without an occurrence') {
      surfaceContext.target = { kind: 'app' };
      delete surfaceContext.targetedContributions;
    }
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'fixture-instance-72', mountNonce: 'fixture-mount-72' },
      authorPlugin: { id: 'happier.channels', version: '0.0.0' },
      surface: renderSurface,
      surfaceContext,
      adapter: createChannelsSemanticAdapter(),
      handlers: {
        selectActionInput: async () => ({ kind: 'cancelled' as const }),
        executeAction: async () => { throw new Error('No provider is admitted, so nothing may be executed.'); },
        readResource: bindingResourceReader(),
      },
    });

    try {
      const remediation = document.querySelector<HTMLElement>(
        '[data-testid="channels-provider-setup-none-available"]',
      );
      expect(remediation, 'Expected provider discovery guidance when nothing contributes a provider.')
        .not.toBeNull();
      expect(remediation?.textContent).toContain('No conversation providers are available');
      expect(remediation?.textContent).toContain('Install and enable a conversation integration plugin');
      // The next step is actionable, not just words.
      expect(document.querySelector('[data-testid="channels-provider-setup-none-refresh"]')).not.toBeNull();
      expect(document.querySelector('[data-testid="channels-provider-setup-picker"]')).toBeNull();
    } finally {
      await fixture.dispose();
    }
  });

  it('runs an arbitrary provider remediation through its exact current role, then re-runs canonical prepare', async () => {
    const submittedProviderSetup = {
      kind: 'submitted' as const,
      action: providerSetupOperation.action,
      input: { installation: 'external-provider-a' },
      selection: {
        target: {
          pluginId: 'happier.channels',
          sourceCustody: { kind: 'development', registeredRootId: 'channels-target-root-a' } as const,
        },
        point: providerSetupOperation.point,
        contributor: providerPortableContributor(),
      },
      connectedAccount: { kind: 'none' as const },
      presentation: { connectedAccountLabel: null, machineDisplayName: null },
    };
    const submittedRemediation = {
      kind: 'submitted' as const,
      action: providerSetupRemediationOperation.action,
      input: { installation: 'external-provider-a' },
      selection: {
        target: {
          pluginId: 'happier.channels',
          sourceCustody: { kind: 'development', registeredRootId: 'channels-target-root-a' } as const,
        },
        point: providerSetupRemediationOperation.point,
        contributor: providerPortableContributor(),
      },
      connectedAccount: { kind: 'none' as const },
      presentation: { connectedAccountLabel: null, machineDisplayName: null },
    };
    let prepareCount = 0;
    let remediationInput: unknown;
    const selectActionInput = vi.fn(async (_input: PluginUiTestkitSelectActionInputInput) => (
      selectActionInput.mock.calls.length === 1
        ? submittedProviderSetup
        : submittedRemediation
    ));
    const executeAction = vi.fn(async (request: PluginUiTestkitExecuteActionInput): Promise<JsonValue> => {
      if (request.action === CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionPrepare) {
        prepareCount += 1;
        return prepareCount === 1
          ? { kind: 'requiresRemediation' }
          : {
              kind: 'ready',
              supportedTransports: ['checkpointedPull'],
              recommendedTransport: 'checkpointedPull',
              overlapSafety: 'safe',
              replayContinuity: 'none',
              outboundTextLimit: { maximum: 4_000, unit: 'unicodeCodePoints' },
            };
      }
      if (request.action === 'connection/setup-remediate-v1') {
        remediationInput = request.input;
        expect(request.selectedActionInput).toEqual({ operation: providerSetupRemediationOperation, result: submittedRemediation });
        return { kind: 'remediated' };
      }
      throw new Error(`Unexpected mounted Action: ${String(request.action)}`);
    });
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'fixture-instance-73', mountNonce: 'fixture-mount-73' },
      authorPlugin: { id: 'happier.channels', version: '0.0.0' },
      surface: renderSurface,
      surfaceContext: createChannelsSurfaceContext(undefined, true),
      adapter: createChannelsSemanticAdapter(),
      handlers: {
        selectActionInput,
        executeAction,
        readResource: bindingResourceReader(),
      },
    });

    try {
      await fixture.press(await fixture.getByRole('button', { name: 'Set up Integration provider' }));
      await expect(fixture.getByRole('button', { name: 'Resolve provider setup' })).resolves.toBeDefined();
      await fixture.press(await fixture.getByRole('button', { name: 'Resolve provider setup' }));

      await vi.waitFor(() => {
        expect(executeAction.mock.calls.map(([request]) => request.action)).toEqual([
          CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionPrepare,
          'connection/setup-remediate-v1',
          CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionPrepare,
        ]);
      });
      expect(selectActionInput).toHaveBeenCalledTimes(2);
      expect(selectActionInput.mock.calls[1]?.[0].request).toEqual({
        operation: providerSetupRemediationOperation,
      });
      expect(remediationInput).toEqual({ providerSelection: submittedRemediation.selection,
        providerRemediationInput: submittedRemediation.input, credentialRef: null });
      await expect(fixture.getByRole('button', { name: 'Create connection' })).resolves.toBeDefined();
    } finally {
      await fixture.dispose();
    }
  });

  it('leaves provider remediation untouched when its host input selection is cancelled', async () => {
    const submittedProviderSetup = {
      kind: 'submitted' as const,
      action: providerSetupOperation.action,
      input: { installation: 'external-provider-a' },
      selection: {
        target: {
          pluginId: 'happier.channels',
          sourceCustody: { kind: 'development', registeredRootId: 'channels-target-root-a' } as const,
        },
        point: providerSetupOperation.point,
        contributor: providerPortableContributor(),
      },
      connectedAccount: { kind: 'none' as const },
      presentation: { connectedAccountLabel: null, machineDisplayName: null },
    };
    let selectionCount = 0;
    const selectActionInput = vi.fn(async (_input: PluginUiTestkitSelectActionInputInput) => {
      selectionCount += 1;
      return selectionCount === 1 ? submittedProviderSetup : { kind: 'cancelled' as const };
    });
    const executeAction = vi.fn(async ({ action }: PluginUiTestkitExecuteActionInput) => {
      if (action === CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionPrepare) {
        return { kind: 'requiresRemediation' };
      }
      throw new Error('A cancelled remediation selection must not execute the provider Action.');
    });
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'fixture-instance-74', mountNonce: 'fixture-mount-74' },
      authorPlugin: { id: 'happier.channels', version: '0.0.0' },
      surface: renderSurface,
      surfaceContext: createChannelsSurfaceContext(undefined, true),
      adapter: createChannelsSemanticAdapter(),
      handlers: {
        selectActionInput,
        executeAction,
        readResource: bindingResourceReader(),
      },
    });

    try {
      await fixture.press(await fixture.getByRole('button', { name: 'Set up Integration provider' }));
      await fixture.press(await fixture.getByRole('button', { name: 'Resolve provider setup' }));
      await vi.waitFor(() => { expect(selectActionInput).toHaveBeenCalledTimes(2); });
      expect(executeAction).toHaveBeenCalledTimes(1);
      await expect(fixture.getByRole('button', { name: 'Resolve provider setup' })).resolves.toBeDefined();
    } finally {
      await fixture.dispose();
    }
  });

  it('does not retry a provider remediation after an unknown host execution outcome', async () => {
    const submittedProviderSetup = {
      kind: 'submitted' as const,
      action: providerSetupOperation.action,
      input: { installation: 'external-provider-a' },
      selection: {
        target: {
          pluginId: 'happier.channels',
          sourceCustody: { kind: 'development', registeredRootId: 'channels-target-root-a' } as const,
        },
        point: providerSetupOperation.point,
        contributor: providerPortableContributor(),
      },
      connectedAccount: { kind: 'none' as const },
      presentation: { connectedAccountLabel: null, machineDisplayName: null },
    };
    const submittedRemediation = {
      kind: 'submitted' as const,
      action: providerSetupRemediationOperation.action,
      input: { installation: 'external-provider-a' },
      selection: {
        target: {
          pluginId: 'happier.channels',
          sourceCustody: { kind: 'development', registeredRootId: 'channels-target-root-a' } as const,
        },
        point: providerSetupRemediationOperation.point,
        contributor: providerPortableContributor(),
      },
      connectedAccount: { kind: 'none' as const },
      presentation: { connectedAccountLabel: null, machineDisplayName: null },
    };
    let selectionCount = 0;
    const selectActionInput = vi.fn(async (_input: PluginUiTestkitSelectActionInputInput) => {
      selectionCount += 1;
      return selectionCount === 1 ? submittedProviderSetup : submittedRemediation;
    });
    const executeAction = vi.fn(async ({ action }: PluginUiTestkitExecuteActionInput) => {
      if (action === CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionPrepare) {
        return { kind: 'requiresRemediation' };
      }
      if (action === CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionSetupRemediate) {
        throw new PluginError({ code: 'timeout', message: 'provider mutation timed out' });
      }
      throw new Error(`Unexpected mounted Action: ${String(action)}`);
    });
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'fixture-instance-75', mountNonce: 'fixture-mount-75' },
      authorPlugin: { id: 'happier.channels', version: '0.0.0' },
      surface: renderSurface,
      surfaceContext: createChannelsSurfaceContext(undefined, true),
      adapter: createChannelsSemanticAdapter(),
      handlers: {
        selectActionInput,
        executeAction,
        readResource: bindingResourceReader(),
      },
    });

    try {
      await fixture.press(await fixture.getByRole('button', { name: 'Set up Integration provider' }));
      await fixture.press(await fixture.getByRole('button', { name: 'Resolve provider setup' }));
      await vi.waitFor(async () => {
        await expect(fixture.getByText('Could not confirm provider setup remediation')).resolves.toBeDefined();
      });
      expect(executeAction.mock.calls.map(([request]) => request.action)).toEqual([
        CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionPrepare,
        CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionSetupRemediate,
      ]);
      expect(selectActionInput).toHaveBeenCalledTimes(2);
    } finally {
      await fixture.dispose();
    }
  });

  it('returns safe provider setup input to the generic form after a definite preparation failure', async () => {
    const safeProviderSetupInput = { channel: 'example' };
    const submittedProviderSetup = {
      kind: 'submitted' as const,
      action: providerSetupOperation.action,
      input: safeProviderSetupInput,
      selection: {
        target: {
          pluginId: 'happier.channels',
          sourceCustody: { kind: 'development', registeredRootId: 'channels-target-root-a' } as const,
        },
        point: providerSetupOperation.point,
        contributor: providerPortableContributor(),
      },
      connectedAccount: { kind: 'none' as const },
      presentation: { connectedAccountLabel: null, machineDisplayName: null },
    };
    let selectionCount = 0;
    const selectActionInput = vi.fn(async (_input: PluginUiTestkitSelectActionInputInput) => {
      selectionCount += 1;
      return selectionCount === 1 ? submittedProviderSetup : { kind: 'cancelled' as const };
    });
    // The surface catches a rejected Action, so an assertion inside this mock could
    // never fail the test. The dispatched Action is asserted from the recorded call.
    const executeAction = vi.fn(async (_request: PluginUiTestkitExecuteActionInput) => {
      // This is a definite malformed response, not a transport ambiguity. The
      // safe generic form input should still be available for correction.
      return { kind: 'unsupported-provider-prepare-result' };
    });
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'fixture-instance-76', mountNonce: 'fixture-mount-76' },
      authorPlugin: { id: 'happier.channels', version: '0.0.0' },
      surface: renderSurface,
      surfaceContext: createChannelsSurfaceContext(),
      adapter: createChannelsSemanticAdapter(),
      handlers: {
        selectActionInput,
        executeAction,
        readResource: async ({ resource }) => {
          const localId = resourceFixtureLocalId(resource);
          if (localId === BINDINGS_RESOURCE.localId) return bindingsResource;
          if (localId === CONNECTIONS_RESOURCE.localId) return connectionsResource;
          throw new Error(`Unexpected Resource: ${localId}`);
        },
      },
    });

    try {
      const setup = await fixture.getByRole('button', { name: 'Set up Integration provider' });
      await fixture.press(setup);
      await expect(fixture.getByText('Could not prepare the provider')).resolves.toBeDefined();

      await fixture.press(await fixture.getByRole('button', { name: 'Set up Integration provider' }));
      await vi.waitFor(() => {
        expect(selectActionInput).toHaveBeenCalledTimes(2);
      });
      expect(selectActionInput.mock.calls[1]?.[0].request).toEqual({
        operation: providerSetupOperation,
        draft: safeProviderSetupInput,
      });
      expect(executeAction).toHaveBeenCalledTimes(1);
      expect(executeAction.mock.calls[0]?.[0].action)
        .toBe(CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionPrepare);
    } finally {
      await fixture.dispose();
    }
  });

  it('relays one exact selected provider settlement through prepare and create without adding it to either outer Action input', async () => {
    const setupGuidanceUrl = 'https://provider.example.test/install';
    const openedLinks: string[] = [];
    const copied: string[] = [];
    const credentialRef = {
      service: {
        pluginId: 'com.example.conversation-provider',
        localId: 'provider-account',
      },
      accountId: 'provider-account-a',
    } as const;
    const submittedProviderSetup = {
      kind: 'submitted' as const,
      action: providerSetupOperation.action,
      input: { repository: 'happier-dev/happier' },
      selection: {
        target: {
          pluginId: 'happier.channels',
          sourceCustody: { kind: 'development', registeredRootId: 'channels-target-root-a' } as const,
        },
        point: providerSetupOperation.point,
        contributor: providerPortableContributor(),
      },
      connectedAccount: { kind: 'selected' as const, fieldPath: 'credentialRef', ref: credentialRef },
      presentation: {
        connectedAccountLabel: 'Work account',
        machineDisplayName: 'Development Mac',
      },
    };
    const selectedActionInput = {
      operation: providerSetupOperation,
      result: submittedProviderSetup,
    } as const;
    const executeAction = vi.fn(async (request: PluginUiTestkitExecuteActionInput): Promise<JsonValue> => {
      if (request.action === CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionPrepare) {
        expect(request.input).toEqual({
          providerSelection: submittedProviderSetup.selection,
          providerSetupInput: submittedProviderSetup.input,
          credentialRef,
        });
        expect(request.selectedActionInput).toEqual(selectedActionInput);
        expect((request as unknown as Readonly<{ consumeSelectedActionInput?: unknown }>)
          .consumeSelectedActionInput).toBeUndefined();
        return {
          kind: 'ready',
          supportedTransports: ['checkpointedPull', 'socket'],
          recommendedTransport: 'socket',
          overlapSafety: 'safe',
          replayContinuity: 'none',
          outboundTextLimit: { maximum: 4_000, unit: 'unicodeCodePoints' },
          destinationLabel: '#engineering',
          setupGuidance: {
            externalUrl: setupGuidanceUrl,
            requiredPermissionsLabel: 'Read messages, Send messages',
          },
        };
      }
      if (request.action === CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionCreate) {
        return { kind: 'created', connectionId: 'connection-from-selected-account' };
      }
      throw new Error(`Unexpected mounted Action: ${String(request.action)}`);
    });
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'fixture-instance-77', mountNonce: 'fixture-mount-77' },
      authorPlugin: { id: 'happier.channels', version: '0.0.0' },
      surface: renderSurface,
      surfaceContext: createChannelsSurfaceContext(),
      adapter: createChannelsSemanticAdapter(),
      handlers: {
        selectActionInput: async () => submittedProviderSetup,
        executeAction,
        readResource: bindingResourceReader(),
        openExternalLink: async ({ url }) => { openedLinks.push(url); },
        writeClipboard: async ({ value }) => { copied.push(value); },
      },
    });

    try {
      await fixture.press(await fixture.getByRole('button', { name: 'Set up Integration provider' }));
      await expect(fixture.getByText('Work account')).resolves.toBeDefined();
      await expect(fixture.getByText('Development Mac')).resolves.toBeDefined();
      await expect(fixture.getByText('#engineering')).resolves.toBeDefined();
      expect(document.body.textContent).toContain('Messages sent during an interruption may not be recoverable.');
      await expect(fixture.getByText('Read messages, Send messages')).resolves.toBeDefined();
      // Guided setup: open the provider, copy what is pasted elsewhere, then create and test.
      const guidance = document.querySelector('[data-testid="channels-provider-setup-guidance"]')?.textContent ?? '';
      expect(guidance).toContain('Grant what it asks for');
      expect(guidance).toContain('Create and test the connection');
      await fixture.press(await fixture.getByRole('link', { name: 'Open Integration provider' }));
      expect(openedLinks).toEqual([setupGuidanceUrl]);
      await fixture.press(await fixture.getByRole('button', { name: 'Copy link' }));
      await fixture.press(await fixture.getByRole('button', { name: 'Copy permissions' }));
      await vi.waitFor(() => {
        expect(copied).toEqual([setupGuidanceUrl, 'Read messages, Send messages']);
      });
      await expect(fixture.getByRole('button', { name: 'Create connection' })).resolves.toBeDefined();
      await fixture.press(await fixture.getByRole('button', { name: 'Create connection' }));
      await vi.waitFor(() => {
        expect(executeAction.mock.calls.map(([request]) => request.action)).toEqual([
          CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionPrepare,
          CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionCreate,
        ]);
      });
      expect(executeAction.mock.calls.every(([request]) => (
        !Object.hasOwn(request.input as object, 'selectedActionInput')
      ))).toBe(true);
      // Asserted here rather than inside the mock: the surface catches an
      // Action rejection and only renders setup feedback, so an expectation
      // that throws inside `executeAction` cannot fail this test.
      const createRequest = executeAction.mock.calls
        .map(([request]) => request)
        .find((request) => request.action === CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionCreate);
      expect(createRequest?.input).toEqual({
        providerSelection: submittedProviderSetup.selection,
        providerSetupInput: submittedProviderSetup.input,
        credentialRef,
        selectedTransport: 'socket',
      });
      expect(createRequest?.selectedActionInput).toEqual(selectedActionInput);
      // Prepare may reuse the exact selected settlement. Create is the one
      // terminal mounted dispatch, so only it consumes the host retention.
      expect((createRequest as unknown as Readonly<{ consumeSelectedActionInput?: unknown }>)
        .consumeSelectedActionInput).toBe(true);
    } finally {
      await fixture.dispose();
    }
  });

  it('walks the provider-authored setup steps in order, with their official links and copyable values', async () => {
    const openedLinks: string[] = [];
    const copied: string[] = [];
    const submittedProviderSetup = {
      kind: 'submitted' as const,
      action: providerSetupOperation.action,
      input: { repository: 'happier-dev/happier' },
      selection: {
        target: {
          pluginId: 'happier.channels',
          sourceCustody: { kind: 'development', registeredRootId: 'channels-target-root-a' } as const,
        },
        point: providerSetupOperation.point,
        contributor: providerPortableContributor(),
      },
      connectedAccount: { kind: 'none' as const },
      presentation: { connectedAccountLabel: null, machineDisplayName: 'Development Mac' },
    };
    const executeAction = vi.fn(async (request: PluginUiTestkitExecuteActionInput): Promise<JsonValue> => {
      if (request.action === CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionPrepare) {
        return {
          kind: 'ready',
          supportedTransports: ['socket'],
          recommendedTransport: 'socket',
          overlapSafety: 'safe',
          replayContinuity: 'none',
          outboundTextLimit: { maximum: 4_000, unit: 'unicodeCodePoints' },
          setupGuidance: {
            externalUrl: 'https://provider.example.test/apps',
            requiredPermissionsLabel: 'Read messages, Send messages',
            steps: [
              { title: 'Create an app for this workspace', externalUrl: 'https://provider.example.test/apps' },
              {
                title: 'Configure bot scopes and events',
                copyableValues: [
                  { label: 'Bot scopes', value: 'chat:write, channels:history' },
                  { label: 'Bot events', value: 'message.channels' },
                ],
              },
              { title: 'Install the app and save its token in Connected Accounts' },
            ],
          },
        };
      }
      throw new Error(`Unexpected mounted Action: ${String(request.action)}`);
    });
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'fixture-instance-77s', mountNonce: 'fixture-mount-77s' },
      authorPlugin: { id: 'happier.channels', version: '0.0.0' },
      surface: renderSurface,
      surfaceContext: createChannelsSurfaceContext(),
      adapter: createChannelsSemanticAdapter(),
      handlers: {
        selectActionInput: async () => submittedProviderSetup,
        executeAction,
        readResource: bindingResourceReader(),
        openExternalLink: async ({ url }) => { openedLinks.push(url); },
        writeClipboard: async ({ value }) => { copied.push(value); },
      },
    });

    try {
      await fixture.press(await fixture.getByRole('button', { name: 'Set up Integration provider' }));
      await vi.waitFor(() => {
        expect(document.querySelector('[data-testid="channels-provider-setup-guidance"]')).not.toBeNull();
      });
      const guidance = document.querySelector('[data-testid="channels-provider-setup-guidance"]')?.textContent ?? '';
      const order = [
        'Create an app for this workspace',
        'Configure bot scopes and events',
        'Install the app and save its token in Connected Accounts',
        'Create and test the connection',
      ].map((title) => guidance.indexOf(title));
      expect(order.every((position) => position >= 0)).toBe(true);
      expect([...order].sort((a, b) => a - b)).toEqual(order);
      // The provider's steps replace the generic summary.
      expect(guidance).not.toContain('Grant what it asks for');
      await fixture.press(await fixture.getByRole('link', { name: 'Open provider.example.test' }));
      expect(openedLinks).toEqual(['https://provider.example.test/apps']);
      await fixture.press(await fixture.getByRole('button', { name: 'Copy Bot scopes' }));
      await fixture.press(await fixture.getByRole('button', { name: 'Copy Bot events' }));
      await vi.waitFor(() => {
        expect(copied).toEqual(['chat:write, channels:history', 'message.channels']);
      });
    } finally {
      await fixture.dispose();
    }
  });

  it('retries the exact durablePush ensure and continuation after distinct response-loss outcomes', async () => {
    const credentialRef = {
      service: {
        pluginId: 'com.example.conversation-provider',
        localId: 'provider-account',
      },
      accountId: 'provider-account-a',
    } as const;
    const submittedProviderSetup = {
      kind: 'submitted' as const,
      action: providerSetupOperation.action,
      input: { repository: 'happier-dev/happier' },
      selection: {
        target: {
          pluginId: 'happier.channels',
          sourceCustody: { kind: 'development', registeredRootId: 'channels-target-root-a' } as const,
        },
        point: providerSetupOperation.point,
        contributor: providerPortableContributor(),
      },
      connectedAccount: { kind: 'selected' as const, fieldPath: 'credentialRef', ref: credentialRef },
      presentation: { connectedAccountLabel: 'Work account', machineDisplayName: 'Development Mac' },
    };
    const selectedActionInput = {
      operation: providerSetupOperation,
      result: submittedProviderSetup,
    } as const;
    const endpointRequiredResult = {
      kind: 'endpointRequired',
      connectionId: 'connection-durable-1',
      webhookContribution: {
        pluginId: 'com.example.conversation-provider',
        localId: 'webhook',
      },
      targetMaterialization: {
        pluginId: 'com.example.conversation-provider',
        machineId: 'machine-1',
        materializationId: 'materialization-1',
      },
      sourceInstanceId: 'channels.connection.connection-durable-1',
      webhookEndpointSetup: {
        kind: 'accountEndpointV1',
        credential: 'serverGenerated',
      },
      webhookEndpointIdempotencyKey: 'endpoint-attempt-0123456789abcdef',
    };
    let endpointEnsureCalls = 0;
    let endpointContinuationCalls = 0;
    const executeAction = vi.fn(async (request: PluginUiTestkitExecuteActionInput): Promise<JsonValue> => {
      if (request.action === CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionPrepare) {
        return {
          kind: 'ready',
          supportedTransports: ['checkpointedPull', 'durablePush'],
          recommendedTransport: 'durablePush',
          overlapSafety: 'safe',
          replayContinuity: 'none',
          outboundTextLimit: { maximum: 4_000, unit: 'unicodeCodePoints' },
        };
      }
      if (request.action === CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionCreate) {
        const input = request.input as Readonly<{
          endpointContinuation?: Readonly<{
            connectionId: string;
            webhookEndpointId: string;
          }>;
        }>;
        if (input.endpointContinuation === undefined) {
          return endpointRequiredResult;
        }
        expect(input.endpointContinuation).toEqual({
          connectionId: 'connection-durable-1',
          webhookEndpointId: 'wh_ep_AAECAwQFBgcICQoLDA0ODw',
        });
        endpointContinuationCalls += 1;
        if (endpointContinuationCalls === 1) {
          throw new PluginError({
            code: 'timeout',
            message: 'The connection continuation response was lost.',
          });
        }
        return { kind: 'created', connectionId: 'connection-durable-1' };
      }
      if (request.action === 'plugin.webhook.endpoint.ensure') {
        expect(request.input).toEqual({
          webhookContribution: {
            pluginId: 'com.example.conversation-provider',
            localId: 'webhook',
          },
          targetMaterialization: {
            pluginId: 'com.example.conversation-provider',
            machineId: 'machine-1',
            materializationId: 'materialization-1',
          },
          sourceInstanceId: 'channels.connection.connection-durable-1',
          setup: { kind: 'accountEndpointV1', credential: 'serverGenerated' },
          idempotencyKey: 'endpoint-attempt-0123456789abcdef',
        });
        endpointEnsureCalls += 1;
        if (endpointEnsureCalls === 1) {
          throw new PluginError({
            code: 'timeout',
            message: 'The endpoint ensure response was lost.',
            });
        }
        if (endpointEnsureCalls === 2) {
          return {
            webhookEndpointId: 'wh_ep_AAECAwQFBgcICQoLDA0ODw',
            revision: 3,
            publicUrl: 'https://webhooks.example.test/wh_ep_AAECAwQFBgcICQoLDA0ODw',
            readiness: 'providerConfirmationRequired',
            oneTimeGeneratedSecret: 'secret-shown-once',
          };
        }
        return {
          webhookEndpointId: 'wh_ep_AAECAwQFBgcICQoLDA0ODw',
          revision: 3,
          publicUrl: 'https://webhooks.example.test/wh_ep_AAECAwQFBgcICQoLDA0ODw',
          readiness: 'ready',
        };
      }
      throw new Error(`Unexpected mounted Action: ${String(request.action)}`);
    });
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'fixture-instance-78', mountNonce: 'fixture-mount-78' },
      authorPlugin: { id: 'happier.channels', version: '0.0.0' },
      surface: renderSurface,
      surfaceContext: createChannelsSurfaceContext(),
      adapter: createChannelsSemanticAdapter(),
      handlers: {
        selectActionInput: async () => submittedProviderSetup,
        executeAction,
        readResource: bindingResourceReader(),
      },
    });

    try {
      await fixture.press(await fixture.getByRole('button', { name: 'Set up Integration provider' }));
      await expect(fixture.getByRole('button', { name: 'Create connection' })).resolves.toBeDefined();
      await fixture.press(await fixture.getByRole('button', { name: 'Create connection' }));
      await vi.waitFor(() => {
        expect(executeAction.mock.calls.map(([request]) => request.action)).toEqual([
          CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionPrepare,
          CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionCreate,
          'plugin.webhook.endpoint.ensure',
        ]);
      });
      expect(document.querySelector(
        '[data-testid="channels-provider-setup-endpoint-ensure-outcome-unknown"]',
      )).not.toBeNull();

      // Retry the exact retained generic ensure input. It rejoins the endpoint,
      // surfaces the provider URL/one-time secret, and persists the connection
      // identity even while provider confirmation remains setup attention.
      await fixture.press(await fixture.getByRole('button', { name: 'Create connection' }));
      await vi.waitFor(() => {
        expect(executeAction.mock.calls.map(([request]) => request.action)).toEqual([
          CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionPrepare,
          CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionCreate,
          'plugin.webhook.endpoint.ensure',
          'plugin.webhook.endpoint.ensure',
          CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionCreate,
        ]);
      });
      expect(document.querySelector('[data-testid="channels-provider-setup-webhook-required"]')).not.toBeNull();
      expect(document.body.textContent).toContain('https://webhooks.example.test/wh_ep_AAECAwQFBgcICQoLDA0ODw');
      expect(document.body.textContent).toContain('secret-shown-once');
      await expect(fixture.getByRole('button', { name: 'Copy webhook URL' })).resolves.toBeDefined();
      await expect(fixture.getByRole('button', { name: 'Copy webhook secret' })).resolves.toBeDefined();

      // Once the provider has been configured, the same ensure input is
      // rechecked and the first connection continuation response is lost.
      await fixture.press(await fixture.getByRole('button', { name: 'Create connection' }));
      await vi.waitFor(() => {
        expect(executeAction.mock.calls.map(([request]) => request.action)).toEqual([
          CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionPrepare,
          CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionCreate,
          'plugin.webhook.endpoint.ensure',
          'plugin.webhook.endpoint.ensure',
          CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionCreate,
          'plugin.webhook.endpoint.ensure',
          CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionCreate,
        ]);
      });
      // The continuation may surface either the generic unknown or a definite
      // retryable failure depending on the mounted Action adapter; in both
      // cases the exact continuation remains available for the next press.

      // Durable setup is one selected-input lifetime. Every create/rejoin
      // relay carries the exact host selection, and the surface retires that
      // selection only after the connection definitely succeeds.
      const createCalls = executeAction.mock.calls
        .map(([request]) => request)
        .filter((request) => request.action === CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionCreate);
      expect(createCalls).toHaveLength(3);
      const successfulContinuation = createCalls[2];
      if (successfulContinuation === undefined) throw new Error('Expected the successful continuation request.');
      expect((createCalls[0] as unknown as Readonly<{ consumeSelectedActionInput?: unknown }>)
        .consumeSelectedActionInput).toBeUndefined();
      expect(createCalls[0]?.selectedActionInput).toEqual(selectedActionInput);
      expect(createCalls[1]?.selectedActionInput).toEqual(selectedActionInput);
      expect(successfulContinuation.input).toEqual(createCalls[1]?.input);
      expect(successfulContinuation.selectedActionInput).toEqual(selectedActionInput);
      await expect(fixture.context.hostApi.executeAction(
        CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionCreate,
        successfulContinuation.input,
        { selectedActionInput },
      )).rejects.toMatchObject({ code: 'invalid_payload' });
      const ensureCalls = executeAction.mock.calls
        .map(([request]) => request)
        .filter((request) => request.action === 'plugin.webhook.endpoint.ensure');
      expect(ensureCalls).toHaveLength(3);
      expect(ensureCalls[1]?.input).toEqual(ensureCalls[0]?.input);
    } finally {
      await fixture.dispose();
    }
  });

  it('cancels both selected outer relays when their Account lifetime retires before create reaches provider setup', async () => {
    const credentialRef = {
      service: {
        pluginId: 'com.example.conversation-provider',
        localId: 'provider-account',
      },
      accountId: 'provider-account-a',
    } as const;
    const submittedProviderSetup = {
      kind: 'submitted' as const,
      action: providerSetupOperation.action,
      input: { repository: 'happier-dev/happier' },
      selection: {
        target: {
          pluginId: 'happier.channels',
          sourceCustody: { kind: 'development', registeredRootId: 'channels-target-root-a' } as const,
        },
        point: providerSetupOperation.point,
        contributor: providerPortableContributor(),
      },
      connectedAccount: { kind: 'selected' as const, fieldPath: 'credentialRef', ref: credentialRef },
      presentation: { connectedAccountLabel: 'Work account', machineDisplayName: 'Development Mac' },
    };
    const accountLifetime = new AbortController();
    let releaseCreateBeforeProvider: (() => void) | undefined;
    const createBeforeProvider = new Promise<void>((resolve) => {
      releaseCreateBeforeProvider = resolve;
    });
    let resolveCreateSettled: (() => void) | undefined;
    const createSettled = new Promise<void>((resolve) => {
      resolveCreateSettled = resolve;
    });
    let prepareSignal: AbortSignal | undefined;
    let createSignal: AbortSignal | undefined;
    const providerSetup = vi.fn();
    const surface = createChannelsSurfaceContext();
    const baseHostApi = createHostApiStub(surface);
    const hostApi = createHostApiStub(surface, {
      version: () => ({
        ...baseHostApi.version(),
        methods: ['readResource', 'selectActionInput', 'executeAction'],
      }),
      selectActionInput: async () => submittedProviderSetup,
      // The stub's result type is generic over the caller's Action reference.
      // This fixture answers the two concrete mounted Actions the surface
      // dispatches, so the generic edge is resolved here.
      executeAction: (async (action, _input, options) => {
        if (action === CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionPrepare) {
          prepareSignal = options?.signal;
          return {
            kind: 'ready',
            supportedTransports: ['checkpointedPull', 'socket'],
            recommendedTransport: 'socket',
            overlapSafety: 'safe',
            replayContinuity: 'none',
            outboundTextLimit: { maximum: 4_000, unit: 'unicodeCodePoints' },
          };
        }
        if (action === CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionCreate) {
          createSignal = options?.signal;
          await createBeforeProvider;
          if (!options?.signal?.aborted) providerSetup();
          resolveCreateSettled?.();
          return { kind: 'created', connectionId: 'connection-after-retirement' };
        }
        throw new Error(`Unexpected mounted Action: ${String(action)}`);
      }) as NonNullable<Parameters<typeof createHostApiStub>[1]>['executeAction'],
      readResource: async (resource) => {
        const localId = resourceFixtureLocalId(resource);
        if (localId === BINDINGS_RESOURCE.localId) return bindingsResource;
        if (localId === CONNECTIONS_RESOURCE.localId) return connectionsResource;
        throw new Error(`Unexpected Resource: ${localId}`);
      },
    });
    const context = Object.freeze({
      plugin: Object.freeze({ id: 'happier.channels', version: '0.0.0' }),
      surface,
      hostApi,
      signal: accountLifetime.signal,
    } satisfies RenderContext);
    const entry = renderSurface(context) as ReactElement<{ dataClient?: PluginUiDataClient }>;
    const mount = await mountThroughReactNativeWebAsync(cloneElement(entry, { dataClient: emptyDataClient }));

    try {
      await vi.waitFor(() => {
        expect(Array.from(mount.container.querySelectorAll<HTMLElement>('[role="button"]')).some((element) => (
          element.getAttribute('aria-label')?.includes('Set up Integration provider')
        ))).toBe(true);
      });
      const setup = Array.from(mount.container.querySelectorAll<HTMLElement>('[role="button"]')).find((element) => (
        element.getAttribute('aria-label')?.includes('Set up Integration provider')
      ));
      if (!setup) throw new Error('Expected the mounted provider setup button.');
      await act(async () => { setup.click(); });
      await vi.waitFor(() => {
        expect(Array.from(mount.container.querySelectorAll<HTMLElement>('[role="button"]')).some((element) => (
          element.getAttribute('aria-label')?.includes('Create connection')
        ))).toBe(true);
      });
      const create = Array.from(mount.container.querySelectorAll<HTMLElement>('[role="button"]')).find((element) => (
        element.getAttribute('aria-label')?.includes('Create connection')
      ));
      if (!create) throw new Error('Expected the mounted create connection button.');
      await act(async () => { create.click(); });
      await vi.waitFor(() => { expect(createSignal).toBeDefined(); });

      accountLifetime.abort('account_lifetime_retired');
      expect(prepareSignal).toBe(accountLifetime.signal);
      expect(createSignal).toBe(accountLifetime.signal);
      expect(createSignal?.aborted).toBe(true);
      releaseCreateBeforeProvider?.();
      await createSettled;
      expect(providerSetup).not.toHaveBeenCalled();
    } finally {
      releaseCreateBeforeProvider?.();
      mount.unmount();
    }
  });

  it('does not create from a stale prepared selection while a replacement provider selection is pending', async () => {
    let selectionCount = 0;
    const selectedProviderSetup = {
      kind: 'submitted' as const,
      action: providerSetupOperation.action,
      input: { channel: 'example' },
      selection: {
        target: {
          pluginId: 'happier.channels',
          sourceCustody: { kind: 'development', registeredRootId: 'channels-target-root-a' } as const,
        },
        point: providerSetupOperation.point,
        contributor: providerPortableContributor(),
      },
      connectedAccount: { kind: 'none' as const },
      presentation: { connectedAccountLabel: null, machineDisplayName: null },
    };
    const selectActionInput = vi.fn(async (_input: PluginUiTestkitSelectActionInputInput) => {
      selectionCount += 1;
      if (selectionCount === 1) return selectedProviderSetup;
      return { kind: 'cancelled' as const };
    });
    const executeAction = vi.fn(async ({ action }: PluginUiTestkitExecuteActionInput): Promise<JsonValue> => {
      if (action === CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionPrepare) {
        return {
          kind: 'ready',
          supportedTransports: ['checkpointedPull', 'socket'],
          recommendedTransport: 'socket',
          overlapSafety: 'safe',
          replayContinuity: 'none',
          outboundTextLimit: { maximum: 4_000, unit: 'unicodeCodePoints' },
        };
      }
      if (action === CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionCreate) {
        return { kind: 'created', connectionId: 'connection-created-from-stale-selection' };
      }
      throw new Error(`Unexpected mounted Action: ${String(action)}`);
    });
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'fixture-instance-79', mountNonce: 'fixture-mount-79' },
      authorPlugin: { id: 'happier.channels', version: '0.0.0' },
      surface: renderSurface,
      surfaceContext: createChannelsSurfaceContext(),
      adapter: createChannelsSemanticAdapter(),
      handlers: {
        selectActionInput,
        executeAction,
        readResource: async ({ resource }) => {
          const localId = resourceFixtureLocalId(resource);
          if (localId === BINDINGS_RESOURCE.localId) return bindingsResource;
          if (localId === CONNECTIONS_RESOURCE.localId) return connectionsResource;
          throw new Error(`Unexpected Resource: ${localId}`);
        },
      },
    });

    try {
      await fixture.press(await fixture.getByRole('button', { name: 'Set up Integration provider' }));
      await expect(fixture.getByRole('button', { name: 'Create connection' })).resolves.toBeDefined();

      const setup = document.querySelector<HTMLElement>(
        '[data-testid="channels-provider-setup-com.example.conversation-provider-conversation-setup"]',
      );
      const create = document.querySelector<HTMLElement>(
        '[data-testid="channels-provider-setup-create"]',
      );
      expect(setup).not.toBeNull();
      expect(create).not.toBeNull();

      await act(async () => {
        setup?.click();
        create?.click();
      });
      await vi.waitFor(() => {
        expect(selectActionInput).toHaveBeenCalledTimes(2);
      });
      expect(executeAction.mock.calls.map(([request]) => request.action)).toEqual([
        CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionPrepare,
      ]);
    } finally {
      await fixture.dispose();
    }
  });

  it('keeps a timed-out setup selection disabled until the canonical connection Resource reread settles fresh', async () => {
    let connectionReadCount = 0;
    let resolveConnectionRefresh: ((value: ResourceContent) => void) | undefined;
    const selectActionInput = vi.fn(async (_input: PluginUiTestkitSelectActionInputInput) => ({
      kind: 'submitted' as const,
      action: providerSetupOperation.action,
      input: { channel: 'example' },
      selection: {
        target: {
          pluginId: 'happier.channels',
          sourceCustody: { kind: 'development', registeredRootId: 'channels-target-root-a' } as const,
        },
        point: providerSetupOperation.point,
        contributor: providerPortableContributor(),
      },
      connectedAccount: { kind: 'none' as const },
      presentation: { connectedAccountLabel: null, machineDisplayName: null },
    }));
    const executeAction = vi.fn(async ({ action }: PluginUiTestkitExecuteActionInput) => {
      if (action === CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionPrepare) {
        throw new PluginError({ code: 'timeout', message: 'The setup request timed out.' });
      }
      throw new Error(`Unexpected mounted Action: ${String(action)}`);
    });
    const surfaceContext = createChannelsSurfaceContext();
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'fixture-instance-80', mountNonce: 'fixture-mount-80' },
      authorPlugin: { id: 'happier.channels', version: '0.0.0' },
      surface: renderSurface,
      surfaceContext,
      adapter: createChannelsSemanticAdapter(),
      handlers: {
        selectActionInput,
        executeAction,
        readResource: async ({ resource }) => {
          const localId = resourceFixtureLocalId(resource);
          if (localId === BINDINGS_RESOURCE.localId) return bindingsResource;
          if (localId !== CONNECTIONS_RESOURCE.localId) {
            throw new Error(`Unexpected Resource: ${localId}`);
          }
          connectionReadCount += 1;
          if (connectionReadCount === 1) return connectionsResource;
          return await new Promise<ResourceContent>((resolve) => {
            resolveConnectionRefresh = resolve;
          });
        },
      },
    });

    try {
      const setup = await fixture.findByRole('button', { name: 'Set up Integration provider' });
      await fixture.press(setup);

      await vi.waitFor(async () => {
        expect(selectActionInput).toHaveBeenCalledWith(expect.objectContaining({
          request: { operation: providerSetupOperation },
        }));
        expect(executeAction).toHaveBeenCalledWith(expect.objectContaining({
          action: CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionPrepare,
        }));
      });
      await expect(fixture.getByText('Could not confirm provider setup')).resolves.toBeDefined();
      await expect(fixture.findByRole('button', {
        name: 'Set up Integration provider',
        state: { disabled: true },
      })).resolves.toBeDefined();

      await pressByTestId('channels-provider-setup-outcome-unknown-reconcile');
      await vi.waitFor(() => {
        expect(connectionReadCount).toBe(2);
        expect(resolveConnectionRefresh).toBeTypeOf('function');
      });
      await expect(fixture.findByRole('button', {
        name: 'Set up Integration provider',
        state: { disabled: true },
      })).resolves.toBeDefined();

      await act(async () => {
        resolveConnectionRefresh?.(connectionsResource);
      });
      await vi.waitFor(async () => {
        const recoveredSetup = await fixture.getByRole('button', { name: 'Set up Integration provider' });
        expect(recoveredSetup.state?.disabled).not.toBe(true);
      });
      await expect(fixture.queryByText('Could not confirm provider setup')).resolves.toBeUndefined();
      expect(executeAction.mock.calls.map(([request]) => request.action)).toEqual([
        CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionPrepare,
      ]);
    } finally {
      await fixture.dispose();
    }
  });
});

describe('Channels mounted ingress attention recovery', () => {
  it('omits retained occurrence conflict attention without exposing a retry action', async () => {
    const censusId = 'C'.repeat(43);
    const attentionQuery = vi.fn(async () => ({
      changeCursor: 0,
      rows: [{
        rowId: censusId,
        revision: 9,
        value: {
          id: censusId,
          'record-kind': 'ingress-census',
          v: 1,
          'connection-id': 'connection-1',
          attention: true,
          'created-at': 10,
          'updated-at': 20,
          payload: { conflict: { kind: 'occurrenceEvidenceMismatch' } },
        },
      }],
      nextCursor: undefined,
    }));
    const attentionDataClient: PluginUiDataClient = {
      collection: <TDefinition extends PluginAccountCollectionDefinition>() => (({
        get: async () => null,
        put: async () => { throw new Error('This mounted ingress-conflict test does not write Account data.'); },
        delete: async () => { throw new Error('This mounted ingress-conflict test does not delete Account data.'); },
        query: attentionQuery,
        batch: async () => { throw new Error('This mounted ingress-conflict test does not batch Account data.'); },
        // The Data boundary is generic over the caller's definition; this fixture
        // supplies the one Channel state Collection the surface reads.
      }) as unknown as PluginUiAccountCollectionForDefinition<TDefinition>),
      openCollectionQuery: async () => {
        throw new Error('This mounted ingress-conflict test does not open generic Account queries.');
      },
      // This surface never reaches Account KV or Settings; the truthful
      // unavailable scope fails loudly if that ever changes.
      accountKv: createUnavailablePluginUiAccountKv(),
    };
    const executeAction = vi.fn(async () => {
      throw new Error('An occurrence conflict must not expose a recovery Action.');
    });
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'fixture-instance-81', mountNonce: 'fixture-mount-81' },
      authorPlugin: { id: 'happier.channels', version: '0.0.0' },
      surface: renderSurface,
      surfaceContext: createChannelsSurfaceContext(),
      adapter: createChannelsSemanticAdapter(attentionDataClient),
      handlers: {
        selectActionInput: async () => ({ kind: 'cancelled' as const }),
        executeAction,
        readResource: bindingResourceReader(),
      },
    });

    try {
      await expect(fixture.queryByText('An incoming occurrence has contradictory evidence.')).resolves.toBeUndefined();
      expect(document.querySelector(`[data-testid="channels-ingress-attention-retry-${censusId}"]`)).toBeNull();
      expect(executeAction).not.toHaveBeenCalled();
    } finally {
      await fixture.dispose();
    }
  });

  it('retries one exact blocked obligation, rereads its bounded Account page, and renders the settled empty state', async () => {
    const blockedObligationId = 'A'.repeat(43);
    const terminalObligationId = 'T'.repeat(43);
    const recoverableObligationId = 'R'.repeat(43);
    const attentionQuery = vi.fn(async () => {
      const page = attentionQuery.mock.calls.length;
      if (page > 1) return { rows: [], nextCursor: undefined };
      return {
        rows: [
          {
            rowId: blockedObligationId,
            revision: 7,
            value: {
              id: blockedObligationId,
              'record-kind': 'ingress-obligation',
              v: 1,
              'connection-id': 'connection-1',
              'binding-id': 'binding-1',
              terminal: false,
              attention: true,
              'created-at': 10,
              'updated-at': 20,
              payload: {
                occurrenceIds: ['occurrence-1'],
                censusId: 'B'.repeat(43),
                target: { kind: 'session' },
                sourceAuthority: {
                  connectionAuthorityEpoch: 1,
                  bindingRevision: 2,
                  bindingAuthorityEpoch: 3,
                },
                lifecycle: { phase: 'blocked', attemptCount: 5, dueAt: null },
                disposition: null,
                nonAdmission: null,
              },
            },
          },
          {
            rowId: terminalObligationId,
            revision: 8,
            value: {
              id: terminalObligationId,
              'record-kind': 'ingress-obligation',
              v: 1,
              'connection-id': 'connection-1',
              'binding-id': 'binding-1',
              terminal: true,
              attention: true,
              'created-at': 10,
              'updated-at': 21,
              payload: {
                occurrenceIds: ['occurrence-1'],
                censusId: 'B'.repeat(43),
                target: null,
                sourceAuthority: {
                  connectionAuthorityEpoch: 1,
                  bindingRevision: 2,
                  bindingAuthorityEpoch: 3,
                },
                lifecycle: { phase: 'terminal', attemptCount: 0, dueAt: null },
                disposition: 'rejected',
                nonAdmission: { reason: 'messageTooLarge', senderFeedbackEligible: true },
              },
            },
          },
          {
            rowId: recoverableObligationId,
            revision: 9,
            value: {
              id: recoverableObligationId,
              'record-kind': 'ingress-obligation',
              v: 1,
              'connection-id': 'connection-1',
              'binding-id': 'binding-1',
              terminal: true,
              attention: true,
              'created-at': 10,
              'updated-at': 22,
              payload: {
                occurrenceIds: ['occurrence-1'],
                censusId: 'B'.repeat(43),
                target: null,
                sourceAuthority: {
                  connectionAuthorityEpoch: 1,
                  bindingRevision: 2,
                  bindingAuthorityEpoch: 3,
                },
                lifecycle: { phase: 'terminal', attemptCount: 1, dueAt: null },
                disposition: 'rejected',
                nonAdmission: { reason: 'targetUnavailable', senderFeedbackEligible: false },
              },
            },
          },
          ...(['actorUnattributable', 'actorNotAllowed', 'botSenderDisabled'] as const).map((reason, index) => {
            const id = String(index).repeat(43);
            return { rowId: id, revision: 1, value: {
              id, 'record-kind': 'ingress-obligation', v: 1,
              'connection-id': 'connection-1', 'binding-id': 'binding-1',
              terminal: true, attention: true, 'created-at': 10, 'updated-at': 22,
              payload: {
                occurrenceIds: ['private-occurrence'], censusId: 'B'.repeat(43), target: null,
                sourceAuthority: { connectionAuthorityEpoch: 1, bindingRevision: 2, bindingAuthorityEpoch: 3 },
                lifecycle: { phase: 'terminal', attemptCount: 0, dueAt: null }, disposition: 'rejected',
                nonAdmission: { reason, senderFeedbackEligible: false },
              },
            } };
          }),
        ],
        nextCursor: undefined,
        changeCursor: 0,
      };
    });
    const attentionDataClient: PluginUiDataClient = {
      collection: <TDefinition extends PluginAccountCollectionDefinition>() => (({
        get: async () => null,
        put: async () => { throw new Error('This mounted ingress-attention test does not write Account data.'); },
        delete: async () => { throw new Error('This mounted ingress-attention test does not delete Account data.'); },
        query: attentionQuery,
        batch: async () => { throw new Error('This mounted ingress-attention test does not batch Account data.'); },
        // The Data boundary is generic over the caller's definition; this fixture
        // supplies the one Channel state Collection the surface reads.
      }) as unknown as PluginUiAccountCollectionForDefinition<TDefinition>),
      openCollectionQuery: async () => {
        throw new Error('This mounted ingress-attention test does not open generic Account queries.');
      },
      // This surface never reaches Account KV or Settings; the truthful
      // unavailable scope fails loudly if that ever changes.
      accountKv: createUnavailablePluginUiAccountKv(),
    };
    const executeAction = vi.fn(async ({ action }: PluginUiTestkitExecuteActionInput) => {
      if (action !== CONVERSATION_MANAGEMENT_ACTION_IDS_V1.ingressRetry) {
        throw new Error(`Unexpected mounted Action: ${String(action)}`);
      }
      return {
        kind: 'retryScheduled',
        obligationId: blockedObligationId,
        revision: 8,
      };
    });
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'fixture-instance-82', mountNonce: 'fixture-mount-82' },
      authorPlugin: { id: 'happier.channels', version: '0.0.0' },
      surface: renderSurface,
      surfaceContext: createChannelsSurfaceContext(),
      adapter: createChannelsSemanticAdapter(attentionDataClient),
      handlers: {
        selectActionInput: async () => ({ kind: 'cancelled' as const }),
        executeAction,
        readResource: bindingResourceReader(),
      },
    });

    try {
      // The retry names the row it acts on, so two rows' identical buttons stay distinguishable.
      await vi.waitFor(() => {
        expect(document.querySelector(`[data-testid="channels-ingress-attention-retry-${blockedObligationId}"]`)
          ?.getAttribute('aria-label')).toMatch(/^Retry saved input \(.+\)$/);
      });
      // Each row names its conversation, says what happened and when, and never shows an id.
      const blockedRow = document.querySelector(`[data-testid="channels-ingress-attention-${blockedObligationId}"]`);
      const at = (atMs: number) => new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })
        .format(new Date(atMs));
      expect(blockedRow?.textContent).toContain('Example conversation');
      expect(blockedRow?.textContent).toContain('Retry stopped after 5 attempts');
      expect(blockedRow?.textContent).toContain(at(20));
      expect(document.body.textContent).not.toContain(blockedObligationId);
      await expect(fixture.getByText('Dropped because the sender could not be verified.')).resolves.toBeDefined();
      await expect(fixture.getByText('Dropped because the sender is not allowed.')).resolves.toBeDefined();
      await expect(fixture.getByText('Dropped because automated senders are not allowed.')).resolves.toBeDefined();
      await expect(fixture.getByText('An incoming message was not accepted.')).resolves.toBeDefined();
      expect(document.body.textContent).not.toContain('private-occurrence');
      await expect(fixture.getByText(
        'An incoming message is waiting for its connection or target to be reachable again.',
      )).resolves.toBeDefined();
      expect(attentionQuery).toHaveBeenCalledWith({
        index: 'by-attention',
        prefix: [true],
        order: 'asc',
        limit: 50,
      }, expect.anything());
      expect(document.querySelector(`[data-testid="channels-ingress-attention-retry-${terminalObligationId}"]`))
        .toBeNull();

      await pressByTestId(`channels-ingress-attention-retry-${blockedObligationId}`);

      await vi.waitFor(() => {
        expect(executeAction).toHaveBeenCalledWith(expect.objectContaining({
          action: CONVERSATION_MANAGEMENT_ACTION_IDS_V1.ingressRetry,
          input: {
            obligationId: blockedObligationId,
            expectedRevision: 7,
          },
        }));
      });
      await vi.waitFor(() => {
        expect(attentionQuery).toHaveBeenCalledTimes(2);
        expect(document.querySelector(`[data-testid="channels-ingress-attention-retry-${blockedObligationId}"]`))
          .toBeNull();
      });
    } finally {
      await fixture.dispose();
    }
  });
});

describe('Channels mounted binding creation', () => {
  it.each([
    {
      accountEncryptionMode: 'plain' as const,
      expected: 'documented server, database, and backup visibility of their canonical plain Account/Session owners.',
      unexpected: 'canonical encrypted envelopes',
    },
    {
      accountEncryptionMode: 'e2ee' as const,
      expected: 'in persisted Happier Account data, private fields remain inside canonical encrypted envelopes and only the bounded routing/index projection is server-readable.',
      unexpected: 'server, database, and backup visibility',
    },
  ])('states the $accountEncryptionMode Account storage boundary before confirmation', async ({
    accountEncryptionMode,
    expected,
    unexpected,
  }) => {
    const executeAction = vi.fn(async ({ action, input }: PluginUiTestkitExecuteActionInput): Promise<JsonValue> => {
      if (action === CONVERSATION_MANAGEMENT_ACTION_IDS_V1.bindingResolve) {
        return (input as Readonly<{ kind?: unknown }>).kind === 'endpoint'
          ? { kind: 'endpointCandidates', candidates: [bindingEndpointCandidate] }
          : { kind: 'principalCandidates', candidates: [bindingPrincipalCandidate] };
      }
      if (action === 'session.list') {
        return createSessionCandidatePageFixture({ sessions: [{ id: 'session-1', title: 'Project review' }], nextCursor: null });
      }
      throw new Error(`Unexpected mounted Action: ${String(action)}`);
    });
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'fixture-instance-83', mountNonce: 'fixture-mount-83' },
      authorPlugin: { id: 'happier.channels', version: '0.0.0' },
      surface: renderSurface,
      surfaceContext: createChannelsSurfaceContext(accountEncryptionMode),
      adapter: createChannelsSemanticAdapter(),
      handlers: {
        selectActionInput: async () => ({ kind: 'cancelled' as const }),
        executeAction,
        readResource: bindingResourceReader(),
      },
    });

    try {
      await openBindingEndpointSelection(fixture);
      await selectPrincipalAndOpenTarget(fixture);
      await fixture.press(await fixture.getByRole('button', { name: 'Project review' }));
      await fixture.press(await fixture.getByRole('button', { name: 'Review binding' }));

      const disclosure = document.querySelector<HTMLElement>('[data-testid="channels-binding-create-privacy-disclosure"]');
      expect(disclosure, 'Expected the final binding confirmation to disclose the mounted Account storage boundary.')
        .not.toBeNull();
      expect(disclosure?.textContent).toContain('Storage and privacy');
      expect(disclosure?.textContent).toContain(expected);
      expect(disclosure?.textContent).not.toContain(unexpected);
      // Neither Account mode may present Happier storage encryption as
      // provider or hosted-webhook transit blindness.
      expect(
        disclosure?.textContent,
        'Expected the confirmation to disclose that the connected provider sees this conversation.',
      ).toContain('The connected provider always sees this conversation');
      expect(
        disclosure?.textContent,
        'Expected the confirmation to disclose hosted-webhook server transit custody.',
      ).toContain('pass through the Happier server, which reads and verifies the raw provider request before sealing it');
    } finally {
      await fixture.dispose();
    }
  });

  it('offers only the incoming message policies the integration can deliver in a shared conversation', async () => {
    // The create writer rejects a policy the platform will not honour, so the
    // policies step must not offer one either.
    const executeAction = vi.fn(async ({ action, input }: PluginUiTestkitExecuteActionInput): Promise<JsonValue> => {
      if (action === CONVERSATION_MANAGEMENT_ACTION_IDS_V1.bindingResolve) {
        return (input as Readonly<{ kind?: unknown }>).kind === 'endpoint'
          ? { kind: 'endpointCandidates', candidates: [bindingEndpointCandidate] }
          : { kind: 'principalCandidates', candidates: [bindingPrincipalCandidate] };
      }
      if (action === 'session.list') {
        return createSessionCandidatePageFixture({ sessions: [{ id: 'session-1', title: 'Project review' }], nextCursor: null });
      }
      throw new Error(`Unexpected mounted Action: ${String(action)}`);
    });
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'fixture-instance-84', mountNonce: 'fixture-mount-84' },
      authorPlugin: { id: 'happier.channels', version: '0.0.0' },
      surface: renderSurface,
      surfaceContext: createChannelsSurfaceContext(),
      adapter: createChannelsSemanticAdapter(),
      handlers: {
        selectActionInput: async () => ({ kind: 'cancelled' as const }),
        executeAction,
        readResource: async ({ resource }) => {
          const localId = resourceFixtureLocalId(resource);
          if (localId === BINDINGS_RESOURCE.localId) return bindingsResource;
          if (localId === CONNECTIONS_RESOURCE.localId) return connectionsResourceWithoutSharedAllMessages;
          throw new Error(`Unexpected Resource: ${localId}`);
        },
      },
    });

    try {
      // `bindingEndpointCandidate` is a shared conversation.
      await openBindingEndpointSelection(fixture);
      await selectPrincipalAndOpenTarget(fixture);
      await fixture.press(await fixture.getByRole('button', { name: 'Project review' }));

      const select = document.querySelector<HTMLElement>('[data-testid="channels-binding-create-input-mode"]');
      expect(select, 'Expected the policies step to offer an incoming message policy.').not.toBeNull();
      // The retained binding in this fixture is `directMentionsOnly`, so the
      // only place "All allowed messages" could appear is this chooser.
      expect(document.body.textContent).toContain('Direct mentions only');
      expect(document.body.textContent).toContain('Addressed messages');
      expect(document.body.textContent).not.toContain('All allowed messages');
      const capability = document.querySelector<HTMLElement>(
        '[data-testid="channels-binding-create-input-mode-capability"]',
      );
      expect(capability?.textContent).toContain('only delivers messages that address it');
    } finally {
      await fixture.dispose();
    }
  });

  it('keeps the binding draft on Back, announces each step, and discards it only on Cancel', async () => {
    const executeAction = vi.fn(async ({ action, input }: PluginUiTestkitExecuteActionInput): Promise<JsonValue> => {
      if (action === CONVERSATION_MANAGEMENT_ACTION_IDS_V1.bindingResolve) {
        return (input as Readonly<{ kind?: unknown }>).kind === 'endpoint'
          ? { kind: 'endpointCandidates', candidates: [bindingEndpointCandidate] }
          : { kind: 'principalCandidates', candidates: [bindingPrincipalCandidate] };
      }
      if (action === 'session.list') {
        return createSessionCandidatePageFixture({ sessions: [{ id: 'session-1', title: 'Project review' }], nextCursor: null });
      }
      throw new Error(`Unexpected mounted Action: ${String(action)}`);
    });
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'fixture-instance-85', mountNonce: 'fixture-mount-85' },
      authorPlugin: { id: 'happier.channels', version: '0.0.0' },
      surface: renderSurface,
      surfaceContext: createChannelsSurfaceContext(),
      adapter: createChannelsSemanticAdapter(),
      handlers: {
        selectActionInput: async () => ({ kind: 'cancelled' as const }),
        executeAction,
        readResource: bindingResourceReader(),
      },
    });

    try {
      await fixture.press(await fixture.getByRole('button', { name: 'Add binding' }));
      await expectBindingCreateStage(fixture, { title: 'Choose a conversation', hasBack: false });
      await enterTextByTestId('channels-binding-create-endpoint-query', bindingEndpointSelection.query);
      await fixture.press(await fixture.getByRole('button', { name: 'Search endpoints' }));
      await fixture.press(await fixture.getByRole('button', { name: bindingEndpointCandidate.label }));
      await expectBindingCreateStage(fixture, { title: 'Choose an allowed sender', hasBack: true });

      await fixture.press(await fixture.getByRole('button', { name: 'Back' }));
      await expectBindingCreateStage(fixture, { title: 'Choose a conversation', hasBack: false });
      expect(document.querySelector<HTMLInputElement>('[data-testid="channels-binding-create-endpoint-query"]')?.value)
        .toBe(bindingEndpointSelection.query);

      await fixture.press(await fixture.getByRole('button', { name: bindingEndpointCandidate.label }));
      await searchBindingPrincipal(fixture);
      await fixture.press(await fixture.getByRole('checkbox', {
        name: `${bindingPrincipalCandidate.label}: ${bindingPrincipalCandidate.id}`,
        state: { checked: false },
      }));
      await fixture.press(await fixture.getByRole('button', { name: 'Continue' }));
      await expectBindingCreateStage(fixture, { title: 'Choose a target', hasBack: true });

      await fixture.press(await fixture.getByRole('button', { name: 'Back' }));
      await expectBindingCreateStage(fixture, { title: 'Choose an allowed sender', hasBack: true });
      expect(document.querySelector<HTMLInputElement>('[data-testid="channels-binding-create-principal-query"]')?.value)
        .toBe(bindingPrincipalSelection.query);

      await fixture.press(await fixture.getByRole('button', { name: 'Continue' }));
      await fixture.press(await fixture.getByRole('button', { name: 'Project review' }));
      await expectBindingCreateStage(fixture, { title: 'Policies', hasBack: true });
      await fixture.press(await fixture.getByRole('switch', {
        name: 'Allow bot senders',
        state: { checked: false },
      }));
      await fixture.press(await fixture.getByRole('button', { name: 'Review binding' }));
      await expectBindingCreateStage(fixture, { title: 'Review binding', hasBack: true });

      await fixture.press(await fixture.getByRole('button', { name: 'Back' }));
      await expectBindingCreateStage(fixture, { title: 'Policies', hasBack: true });
      await expect(fixture.getByRole('switch', {
        name: 'Allow bot senders',
        state: { checked: true },
      })).resolves.toBeDefined();

      await fixture.press(await fixture.getByRole('button', { name: 'Review binding' }));
      await fixture.press(await fixture.getByRole('button', { name: 'Cancel' }));
      await expect(fixture.getByRole('button', { name: 'Add binding' })).resolves.toBeDefined();
      await expect(fixture.queryByText('Review binding')).resolves.toBeUndefined();

      await fixture.press(await fixture.getByRole('button', { name: 'Add binding' }));
      expect(document.querySelector<HTMLInputElement>('[data-testid="channels-binding-create-endpoint-query"]')?.value)
        .toBe('');
    } finally {
      await fixture.dispose();
    }
  });

  it('moves logical focus to the current wizard step through the mounted presentation host', async () => {
    const executeAction = vi.fn(async ({ action, input }: PluginUiTestkitExecuteActionInput) => {
      if (action === CONVERSATION_MANAGEMENT_ACTION_IDS_V1.bindingResolve) {
        return (input as Readonly<{ kind?: unknown }>).kind === 'endpoint'
          ? { kind: 'endpointCandidates', candidates: [bindingEndpointCandidate] }
          : { kind: 'principalCandidates', candidates: [bindingPrincipalCandidate] };
      }
      throw new Error(`Unexpected mounted Action: ${String(action)}`);
    });
    const focusTarget = vi.fn((target: unknown): boolean => {
      const focus = (target as Readonly<{ focus?: () => void }> | null)?.focus;
      if (typeof focus !== 'function') return false;
      focus.call(target);
      return true;
    });
    const presentationHost = {
      focusTarget,
      renderMarkdown: () => null,
      renderCodeBlock: () => null,
      renderPopover: () => null,
      renderIcon: () => null,
    } satisfies PluginUiPresentationHost;
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'fixture-instance-86', mountNonce: 'fixture-mount-86' },
      authorPlugin: { id: 'happier.channels', version: '0.0.0' },
      surface: renderSurface,
      surfaceContext: createChannelsSurfaceContext(),
      adapter: createChannelsSemanticAdapter(emptyDataClient, presentationHost),
      handlers: {
        selectActionInput: async () => ({ kind: 'cancelled' as const }),
        executeAction,
        readResource: bindingResourceReader(),
      },
    });

    const headingFor = (title: string): HTMLElement | undefined => (
      Array.from(document.querySelectorAll<HTMLElement>('[role="heading"]')).find((node) => node.textContent === title)
    );

    try {
      await fixture.press(await fixture.getByRole('button', { name: 'Add binding' }));
      const endpointHeading = headingFor('Choose a conversation');
      expect(endpointHeading).toBeDefined();
      expect(document.activeElement).toBe(endpointHeading);
      expect(focusTarget).toHaveBeenCalledTimes(1);
      // The opener has done its job: an open journey does not repeat it beside its own first step.
      expect(document.querySelector('[data-testid="channels-binding-create-open"]')).toBeNull();

      await enterTextByTestId('channels-binding-create-endpoint-query', bindingEndpointSelection.query);
      await fixture.press(await fixture.getByRole('button', { name: 'Search endpoints' }));
      await fixture.press(await fixture.getByRole('button', { name: bindingEndpointCandidate.label }));
      const principalHeading = headingFor('Choose an allowed sender');
      expect(principalHeading).toBeDefined();
      expect(document.activeElement).toBe(principalHeading);
      expect(focusTarget).toHaveBeenCalledTimes(2);

      await fixture.press(await fixture.getByRole('button', { name: 'Cancel' }));
      const opener = document.querySelector<HTMLElement>('[data-testid="channels-binding-create-open"]');
      expect(opener).not.toBeNull();
      expect(document.activeElement).toBe(opener);
      expect(focusTarget).toHaveBeenCalledTimes(3);
    } finally {
      await fixture.dispose();
    }
  });

  it('uses the core direct-message default without a UI override and confirms its complete existing-Session binding', async () => {
    const durablePushConnectionsResource = connectionsResourceForTransport('durablePush');
    const endpointCandidate = {
      kind: 'direct' as const,
      audience: 'direct' as const,
      id: 'direct-ada',
      label: 'Ada direct',
    };
    const endpointSelection = {
      query: 'ada-direct',
      selected: {
        kind: 'direct' as const,
        audience: 'direct' as const,
        id: 'direct-ada',
      },
    };
    const principalCandidate = {
      id: 'principal-ada',
      kind: 'human' as const,
      label: 'Ada',
    };
    const principalCandidates = [
      principalCandidate,
      {
        id: 'principal-grace',
        kind: 'human' as const,
        label: 'Grace',
      },
    ];
    const principalSelection = {
      query: 'ada',
      selected: [{
        id: 'principal-ada',
        kind: 'human' as const,
      }],
    };
    const createdBinding = {
      v: 1,
      id: 'binding-created',
      connectionId: 'connection-1',
      endpoint: endpointCandidate,
      target: {
        kind: 'session' as const,
        sessionId: 'session-1',
        policy: {
          deliveryMode: 'mirrorSession' as const,
          permissionCeiling: 'read-only',
          approvals: { kind: 'off' as const },
          newSession: { kind: 'off' as const },
        },
      },
      allowedPrincipalIds: ['principal-ada'],
      allowBotSenders: false,
      inputMode: 'allAllowedMessages' as const,
      inboundDebounceMs: 750,
      linkPreviewPolicy: 'suppress' as const,
      senderFeedback: 'off' as const,
      authorityEpoch: 2,
      enabled: true,
      deletionState: 'none' as const,
      createdAt: 1,
      updatedAt: 1,
    };
    const executeAction = vi.fn(async ({ action, input }: PluginUiTestkitExecuteActionInput): Promise<JsonValue> => {
      if (action === 'binding/resolve-v1') {
        if ((input as { kind?: unknown }).kind === 'endpoint') {
          return { kind: 'endpointCandidates', candidates: [endpointCandidate] };
        }
        return { kind: 'principalCandidates', candidates: principalCandidates };
      }
      if (action === 'session.list') {
        return createSessionCandidatePageFixture({
          sessions: [{
            id: 'session-1',
            title: 'Project review',
          }],
          nextCursor: null,
        });
      }
      if (action === CONVERSATION_MANAGEMENT_ACTION_IDS_V1.bindingCreate) {
        return { kind: 'created', binding: createdBinding };
      }
      throw new Error(`Unexpected mounted Action: ${String(action)}`);
    });
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'fixture-instance-87', mountNonce: 'fixture-mount-87' },
      authorPlugin: { id: 'happier.channels', version: '0.0.0' },
      surface: renderSurface,
      surfaceContext: createChannelsSurfaceContext(),
      adapter: createChannelsSemanticAdapter(),
      handlers: {
        selectActionInput: async () => ({ kind: 'cancelled' as const }),
        executeAction,
        readResource: async ({ resource }) => {
          const localId = resourceFixtureLocalId(resource);
          if (localId === BINDINGS_RESOURCE.localId) return bindingsResource;
          if (localId === CONNECTIONS_RESOURCE.localId) return durablePushConnectionsResource;
          throw new Error(`Unexpected Resource: ${localId}`);
        },
      },
    });

    try {
      await fixture.press(await fixture.getByRole('button', { name: 'Add binding' }));
      await enterTextByTestId('channels-binding-create-endpoint-query', endpointSelection.query);
      await fixture.press(await fixture.getByRole('button', { name: 'Search endpoints' }));
      await vi.waitFor(() => {
        expect(executeAction).toHaveBeenCalledWith(expect.objectContaining({
          action: 'binding/resolve-v1',
          input: {
            kind: 'endpoint',
            connectionId: 'connection-1',
            expectedConnectionRevision: 1,
            query: endpointSelection.query,
          },
        }));
      });
      await fixture.press(await fixture.getByRole('button', { name: 'Ada direct' }));

      await enterTextByTestId('channels-binding-create-principal-query', principalSelection.query);
      await fixture.press(await fixture.getByRole('button', { name: 'Search people' }));
      await vi.waitFor(() => {
        expect(executeAction).toHaveBeenCalledWith(expect.objectContaining({
          action: 'binding/resolve-v1',
          input: {
            kind: 'principal',
            connectionId: 'connection-1',
            expectedConnectionRevision: 1,
            endpointSelection,
            query: principalSelection.query,
          },
        }));
      });
      await expect(fixture.getByRole('group', { name: 'Allowed sender candidates' })).resolves.toBeDefined();
      await expect(fixture.getByRole('checkbox', {
        name: 'Ada: principal-ada',
        state: { checked: false },
      })).resolves.toBeDefined();
      await expect(fixture.getByRole('checkbox', {
        name: 'Grace: principal-grace',
        state: { checked: false },
      })).resolves.toBeDefined();
      await fixture.press(await fixture.getByRole('checkbox', { name: 'Ada: principal-ada', state: { checked: false } }));
      expect(document.querySelectorAll('[role="checkbox"][aria-checked="true"]')).toHaveLength(1);
      await expect(fixture.getByRole('checkbox', {
        name: 'Ada: principal-ada',
        state: { checked: true },
      })).resolves.toBeDefined();
      await fixture.press(await fixture.getByRole('button', { name: 'Continue' }));

      await vi.waitFor(() => {
        expect(executeAction).toHaveBeenCalledWith(expect.objectContaining({
          action: 'session.list',
          input: { view: 'awareness', limit: 100 },
        }));
      });
      expect(document.body.textContent).not.toContain('private preview');
      await fixture.press(await fixture.getByRole('button', { name: 'Back' }));
      expect(document.querySelectorAll('[role="checkbox"][aria-checked="true"]')).toHaveLength(1);
      await expect(fixture.getByRole('checkbox', {
        name: 'Ada: principal-ada',
        state: { checked: true },
      })).resolves.toBeDefined();
      await fixture.press(await fixture.getByRole('button', { name: 'Continue' }));
      await fixture.press(await fixture.getByRole('button', { name: 'Project review' }));
      await expect(fixture.getByRole('radio', {
        name: 'All allowed messages',
        state: { checked: true },
      })).resolves.toBeDefined();
      await fixture.press(await fixture.getByRole('switch', {
        name: 'Approvals',
        state: { checked: false },
      }));
      await fixture.press(await fixture.getByRole('radio', {
        name: 'Selected admitted principals',
        state: { checked: false },
      }));
      await expect(fixture.getByRole('switch', {
        name: 'principal-ada',
        state: { checked: true },
      })).resolves.toBeDefined();
      await fixture.press(await fixture.getByRole('button', { name: 'Review binding' }));

      const summary = document.querySelector<HTMLElement>('[data-testid="channels-binding-create-summary"]');
      expect(summary).not.toBeNull();
      expect(summary?.textContent).toContain('Integration provider');
      expect(summary?.textContent).toContain('machine-1');
      expect(summary?.textContent).toContain('Ada');
      expect(summary?.textContent).toContain('principal-ada');
      expect(summary?.textContent).toContain('All allowed messages');
      // A direct conversation defaults to mirroring the Session; the shared-room
      // create paths in this file keep proving the opposite default.
      expect(summary?.textContent).toContain('Mirror Session');
      expect(summary?.textContent).toContain('Read only');
      expect(summary?.textContent).toContain('Selected admitted principals: principal-ada');
      expect(summary?.textContent).toContain('Do not create a new Session');
      expect(summary?.textContent).toContain('Durable push');
      expect(summary?.textContent).toContain('Uses this connection’s host-verified webhook endpoint.');

      await fixture.press(await fixture.getByRole('button', { name: 'Link conversation' }));

      await vi.waitFor(() => {
        expect(executeAction).toHaveBeenCalledWith(expect.objectContaining({
          action: CONVERSATION_MANAGEMENT_ACTION_IDS_V1.bindingCreate,
          input: {
            connectionId: 'connection-1',
            expectedConnectionRevision: 1,
            endpointSelection,
            principalSelection,
            target: {
              kind: 'session',
              sessionId: 'session-1',
              policy: {
                deliveryMode: 'mirrorSession',
                permissionCeiling: 'read-only',
                approvals: {
                  kind: 'enabled',
                  maximumScope: 'request',
                  principalIds: ['principal-ada'],
                },
                newSession: { kind: 'off' },
              },
            },
            allowBotSenders: false,
            linkPreviewPolicy: 'suppress',
            senderFeedback: 'off',
            enabled: true,
          },
        }));
      });
      const createCall = executeAction.mock.calls.find(([request]) => (
        (request as { action?: unknown }).action === CONVERSATION_MANAGEMENT_ACTION_IDS_V1.bindingCreate
      ));
      const createInput = (createCall?.[0] as { input?: Record<string, unknown> } | undefined)?.input;
      expect(createInput).not.toHaveProperty('endpoint');
      expect(createInput).not.toHaveProperty('allowedPrincipalIds');
      expect(createInput).not.toHaveProperty('inputMode');
      expect(createInput).not.toHaveProperty('inboundDebounceMs');
      await expect(fixture.getByText('Binding created')).resolves.toBeDefined();
      await expect(fixture.getByRole('button', {
        name: 'Link conversation',
        state: { disabled: true },
      })).resolves.toBeDefined();
      await expect(fixture.getByRole('button', {
        name: 'Back',
        state: { disabled: true },
      })).resolves.toBeDefined();
      await pressByTestId('channels-binding-create-submit');
      expect(executeAction.mock.calls.filter(([request]) => (
        request.action === CONVERSATION_MANAGEMENT_ACTION_IDS_V1.bindingCreate
      ))).toHaveLength(1);
      await fixture.press(await fixture.getByRole('button', { name: 'Cancel' }));
      await expect(fixture.getByRole('button', { name: 'Add binding' })).resolves.toBeDefined();
    } finally {
      await fixture.dispose();
    }
  });

  it('creates a thread router from a mailbox endpoint with its allowed senders as the first group (REV-C-01)', async () => {
    const durablePushConnectionsResource = connectionsResourceForTransport('durablePush');
    const endpointCandidate = {
      kind: 'direct' as const,
      audience: 'direct' as const,
      id: 'direct-ada',
      label: 'Ada direct',
    };
    const endpointSelection = {
      query: 'ada-direct',
      selected: {
        kind: 'direct' as const,
        audience: 'direct' as const,
        id: 'direct-ada',
      },
    };
    const principalCandidate = {
      id: 'principal-ada',
      kind: 'human' as const,
      label: 'Ada',
    };
    const principalCandidates = [
      principalCandidate,
      {
        id: 'principal-grace',
        kind: 'human' as const,
        label: 'Grace',
      },
    ];
    const principalSelection = {
      query: 'ada',
      selected: [{
        id: 'principal-ada',
        kind: 'human' as const,
      }],
    };
    const createdBinding = {
      v: 1,
      id: 'binding-created',
      connectionId: 'connection-1',
      endpoint: endpointCandidate,
      target: {
        kind: 'session' as const,
        sessionId: 'session-1',
        policy: {
          deliveryMode: 'mirrorSession' as const,
          permissionCeiling: 'read-only',
          approvals: { kind: 'off' as const },
          newSession: { kind: 'off' as const },
        },
      },
      allowedPrincipalIds: ['principal-ada'],
      allowBotSenders: false,
      inputMode: 'allAllowedMessages' as const,
      inboundDebounceMs: 750,
      linkPreviewPolicy: 'suppress' as const,
      senderFeedback: 'off' as const,
      authorityEpoch: 2,
      enabled: true,
      deletionState: 'none' as const,
      createdAt: 1,
      updatedAt: 1,
    };
    const executeAction = vi.fn(async ({ action, input }: PluginUiTestkitExecuteActionInput): Promise<JsonValue> => {
      if (action === 'binding/resolve-v1') {
        if ((input as { kind?: unknown }).kind === 'endpoint') {
          return { kind: 'endpointCandidates', candidates: [endpointCandidate] };
        }
        return { kind: 'principalCandidates', candidates: principalCandidates };
      }
      if (action === 'session.list') {
        return createSessionCandidatePageFixture({
          sessions: [{
            id: 'session-1',
            title: 'Project review',
          }],
          nextCursor: null,
        });
      }
      if (action === CONVERSATION_MANAGEMENT_ACTION_IDS_V1.bindingCreate) {
        return { kind: 'created', binding: createdBinding };
      }
      throw new Error(`Unexpected mounted Action: ${String(action)}`);
    });
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'fixture-instance-87r', mountNonce: 'fixture-mount-87r' },
      authorPlugin: { id: 'happier.channels', version: '0.0.0' },
      surface: renderSurface,
      surfaceContext: createChannelsSurfaceContext(),
      adapter: createChannelsSemanticAdapter(),
      handlers: {
        selectActionInput: async () => ({ kind: 'cancelled' as const }),
        executeAction,
        readResource: async ({ resource }) => {
          const localId = resourceFixtureLocalId(resource);
          if (localId === BINDINGS_RESOURCE.localId) return bindingsResource;
          if (localId === CONNECTIONS_RESOURCE.localId) return durablePushConnectionsResource;
          throw new Error(`Unexpected Resource: ${localId}`);
        },
      },
    });

    try {
      await fixture.press(await fixture.getByRole('button', { name: 'Add binding' }));
      await enterTextByTestId('channels-binding-create-endpoint-query', endpointSelection.query);
      await fixture.press(await fixture.getByRole('button', { name: 'Search endpoints' }));
      await vi.waitFor(() => {
        expect(executeAction).toHaveBeenCalledWith(expect.objectContaining({
          action: 'binding/resolve-v1',
          input: {
            kind: 'endpoint',
            connectionId: 'connection-1',
            expectedConnectionRevision: 1,
            query: endpointSelection.query,
          },
        }));
      });
      await fixture.press(await fixture.getByRole('button', { name: 'Ada direct' }));

      await enterTextByTestId('channels-binding-create-principal-query', principalSelection.query);
      await fixture.press(await fixture.getByRole('button', { name: 'Search people' }));
      await vi.waitFor(() => {
        expect(executeAction).toHaveBeenCalledWith(expect.objectContaining({
          action: 'binding/resolve-v1',
          input: {
            kind: 'principal',
            connectionId: 'connection-1',
            expectedConnectionRevision: 1,
            endpointSelection,
            query: principalSelection.query,
          },
        }));
      });
      await expect(fixture.getByRole('group', { name: 'Allowed sender candidates' })).resolves.toBeDefined();
      await expect(fixture.getByRole('checkbox', {
        name: 'Ada: principal-ada',
        state: { checked: false },
      })).resolves.toBeDefined();
      await expect(fixture.getByRole('checkbox', {
        name: 'Grace: principal-grace',
        state: { checked: false },
      })).resolves.toBeDefined();
      await fixture.press(await fixture.getByRole('checkbox', { name: 'Ada: principal-ada', state: { checked: false } }));
      expect(document.querySelectorAll('[role="checkbox"][aria-checked="true"]')).toHaveLength(1);
      await expect(fixture.getByRole('checkbox', {
        name: 'Ada: principal-ada',
        state: { checked: true },
      })).resolves.toBeDefined();
      await fixture.press(await fixture.getByRole('button', { name: 'Continue' }));

      await vi.waitFor(() => {
        expect(executeAction).toHaveBeenCalledWith(expect.objectContaining({
          action: 'session.list',
          input: { view: 'awareness', limit: 100 },
        }));
      });
      expect(document.body.textContent).not.toContain('private preview');
      await fixture.press(await fixture.getByRole('button', { name: 'Back' }));
      expect(document.querySelectorAll('[role="checkbox"][aria-checked="true"]')).toHaveLength(1);
      await expect(fixture.getByRole('checkbox', {
        name: 'Ada: principal-ada',
        state: { checked: true },
      })).resolves.toBeDefined();
      // Exact-address providers return a separate candidate page per sender.
      // Retain the earlier verified selection when searching for another one.
      await enterTextByTestId('channels-binding-create-principal-query', 'grace');
      await fixture.press(await fixture.getByRole('button', { name: 'Search people' }));
      await fixture.press(await fixture.getByRole('checkbox', { name: 'Grace: principal-grace', state: { checked: false } }));
      await fixture.press(await fixture.getByRole('button', { name: 'Continue' }));
      await vi.waitFor(() => {
        expect(document.querySelector('[data-testid="channels-binding-target-router"]')).not.toBeNull();
      });
      await pressByTestId('channels-binding-target-router');
      await expect(fixture.findByRole('heading', { name: 'Routes' })).resolves.toBeDefined();
      await fixture.press(await fixture.getByRole('button', { name: 'Review binding' }));
      const summary = document.querySelector<HTMLElement>('[data-testid="channels-binding-create-summary"]');
      expect(summary?.textContent).toContain('senders (2)');
      expect(summary?.textContent).toContain('No routes yet');
      await fixture.press(await fixture.getByRole('button', { name: 'Link conversation' }));
      await vi.waitFor(() => {
        expect(executeAction).toHaveBeenCalledWith(expect.objectContaining({
          action: CONVERSATION_MANAGEMENT_ACTION_IDS_V1.bindingCreate,
          input: expect.objectContaining({
            endpointSelection,
            principalSelection: {
              ...principalSelection,
              selected: [...principalSelection.selected, { id: 'principal-grace', kind: 'human', query: 'grace' }],
            },
            target: {
              kind: 'threadRouter',
              principalGroups: [{ id: 'senders', principalIds: ['principal-ada', 'principal-grace'] }],
              routes: [],
            },
          }),
        }));
      });
    } finally {
      await fixture.dispose();
    }
  });

  it('requires an explicit retry after a Session candidate page fails during pairing', async () => {
    let sessionReads = 0;
    let finishUnexpectedRead: ((value: JsonValue) => void) | undefined;
    const executeAction = vi.fn(async ({ action, input }: PluginUiTestkitExecuteActionInput): Promise<JsonValue> => {
      if (action === CONVERSATION_MANAGEMENT_ACTION_IDS_V1.bindingResolve) {
        return (input as Readonly<{ kind?: unknown }>).kind === 'endpoint'
          ? { kind: 'endpointCandidates', candidates: [bindingEndpointCandidate] }
          : { kind: 'unavailable', reason: 'principalResolveUnsupported' };
      }
      if (action === 'session.list') {
        sessionReads += 1;
        if (sessionReads === 1) throw new PluginError({ code: 'plugin_service_unavailable', message: 'Session listing unavailable' });
        return new Promise((resolve) => { finishUnexpectedRead = resolve; });
      }
      throw new Error(`Unexpected mounted Action: ${String(action)}`);
    });
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'session-page-retry', mountNonce: 'session-page-retry-mount' },
      authorPlugin: { id: 'happier.channels', version: '0.0.0' },
      surface: renderSurface,
      surfaceContext: createChannelsSurfaceContext(),
      adapter: createChannelsSemanticAdapter(),
      handlers: {
        selectActionInput: async () => ({ kind: 'cancelled' as const }),
        executeAction,
        readResource: bindingResourceReader(),
      },
    });
    try {
      await openBindingEndpointSelection(fixture);
      await searchBindingPrincipal(fixture);
      await vi.waitFor(() => {
        expect(sessionReads).toBeGreaterThan(0);
      });
      await act(async () => { await Promise.resolve(); });
      expect(sessionReads).toBe(1);
      await fixture.press(await fixture.getByRole('button', { name: 'Reload Sessions' }));
      await vi.waitFor(() => { expect(sessionReads).toBe(2); });
      await act(async () => {
        finishUnexpectedRead?.(createSessionCandidatePageFixture({ sessions: [{ id: 'recovered-session', title: 'Recovered Session' }], nextCursor: null }));
      });
      await expect(fixture.getByRole('button', { name: 'Recovered Session' })).resolves.toBeDefined();
    } finally {
      await fixture.dispose();
      finishUnexpectedRead?.(createSessionCandidatePageFixture({ sessions: [], nextCursor: null }));
    }
  });

  it('expires a pairing challenge locally and announces the transition exactly once', async () => {
    // The daemon owns real expiry, but nothing rereads the pairing Resource on
    // its own. Without a local transition the token, link, and deep link stay
    // on screen forever behind a countdown frozen at 0m 00s.
    const expiringPairingResource = jsonResource({
      generationId: 'pairing-generation',
      observedAt: 1_040,
      challenges: [{
        challengeId: 'pairing-challenge',
        connectionId: 'connection-1',

        pairingRequestId: 'pairing-request-fixture',
        expiresAt: 1_040,

        destinationLabel: 'Project room',
        proofEndpoint: bindingSharedProofEndpoint,
        manualToken: 'ABCDEFGH',
        deepLinkUrl: null,
      }],
      proposals: [],
    }, 'e');
    const executeAction = vi.fn(async ({ action, input }: PluginUiTestkitExecuteActionInput): Promise<JsonValue> => {
      if (action === CONVERSATION_MANAGEMENT_ACTION_IDS_V1.bindingResolve) {
        return (input as Readonly<{ kind?: unknown }>).kind === 'endpoint'
          ? { kind: 'endpointCandidates', candidates: [bindingEndpointCandidate] }
          : { kind: 'unavailable', reason: 'principalResolveUnsupported' };
      }
      if (action === 'session.list') {
        return createSessionCandidatePageFixture({ sessions: [{ id: 'session-pairing', title: 'Pairing Session' }], nextCursor: null });
      }
      if (action === CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionPairingCreate) {
        return {
          kind: 'created',
          generationId: 'pairing-generation',
          challengeId: 'pairing-challenge',
          expiresAt: 1_040,

          destinationLabel: 'Project room',
          proofEndpoint: bindingSharedProofEndpoint,
          manualToken: 'ABCDEFGH',
          deepLinkUrl: null,
        };
      }
      throw new Error(`Unexpected mounted Action: ${String(action)}`);
    });
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'fixture-instance-88', mountNonce: 'fixture-mount-88' },
      authorPlugin: { id: 'happier.channels', version: '0.0.0' },
      surface: renderSurface,
      surfaceContext: createChannelsSurfaceContext(),
      adapter: createChannelsSemanticAdapter(),
      handlers: {
        selectActionInput: async () => ({ kind: 'cancelled' as const }),
        executeAction,
        readResource: async ({ resource }) => {
          const localId = resourceFixtureLocalId(resource);
          if (localId === PAIRING_RESOURCE.localId) return expiringPairingResource;
          if (localId === BINDINGS_RESOURCE.localId) return bindingsResource;
          if (localId === CONNECTIONS_RESOURCE.localId) return connectionsResource;
          throw new Error(`Unexpected Resource: ${localId}`);
        },
      },
    });

    try {
      await openBindingEndpointSelection(fixture);
      await searchBindingPrincipal(fixture);
      await expect(fixture.getByText('Pairing is required')).resolves.toBeDefined();
      await vi.waitFor(() => {
        expect(executeAction).toHaveBeenCalledWith(expect.objectContaining({ action: 'session.list' }));
      });
      await fixture.press(await fixture.getByRole('button', { name: 'Pairing Session' }));
      await fixture.press(await fixture.getByRole('button', { name: 'Review binding' }));
      await fixture.press(await fixture.getByRole('button', { name: 'Create pairing challenge' }));
      await vi.waitFor(() => {
        // The person chose a shared conversation. The challenge carries that
        // conversation as the destination and, by default, as the one place
        // the code is accepted, so it can never bind wherever proof arrived.
        expect(executeAction).toHaveBeenCalledWith(expect.objectContaining({
          action: CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionPairingCreate,
          input: expect.objectContaining({
            endpointSelection: bindingEndpointSelection,
            proofEndpointSelection: bindingEndpointSelection,
          }),
        }));
      });

      await vi.waitFor(() => {
        expect(document.body.textContent).toContain('Pairing expired');
      }, { timeout: 3_000, interval: 25 });
      // The challenge presentation is gone: no token, no link, no countdown.
      expect(document.body.textContent).not.toContain('ABCDEFGH');
      expect(document.body.textContent).not.toContain('Expires in');
      expect(document.querySelector('[data-testid="channels-binding-create-pairing-countdown"]')).toBeNull();

      // Exactly one live region carries the transition, so it announces once
      // rather than once per countdown tick.
      const announcements = document.querySelectorAll<HTMLElement>(
        '[data-testid="channels-binding-create-pairing-expired"]',
      );
      expect(announcements).toHaveLength(1);
      const announcement = announcements[0]!;
      expect(announcement.getAttribute('aria-live')).not.toBeNull();
      expect(announcement.textContent).toContain('Pairing expired');
    } finally {
      await fixture.dispose();
    }
  });

  it.each([false, true])('uses pairing only when principal resolution is explicitly unsupported and reports enabled=%s', async (enabled) => {
    const copiedValues: string[] = [];
    const openedLinks: string[] = [];
    let pairingReads = 0;
    let finalizeAttempts = 0;
    let outcomeRefreshRequested = false;
    let outcomeRefreshReads = 0;
    const pairingCreatedBinding = {
      v: 1,
      id: 'binding-pairing',
      connectionId: 'connection-1',
      endpoint: { kind: 'direct', audience: 'direct', id: 'chat-ada' },
      target: {
        kind: 'session',
        sessionId: 'session-pairing',
        policy: {
          deliveryMode: 'mirrorSession',
          permissionCeiling: 'read-only',
          approvals: { kind: 'off' },
          newSession: { kind: 'off' },
        },
      },
      allowedPrincipalIds: ['principal-ada'],
      allowBotSenders: false,
      inputMode: 'allAllowedMessages',
      inboundDebounceMs: 750,
      linkPreviewPolicy: 'suppress',
      senderFeedback: 'off',
      authorityEpoch: 1,
      enabled,
      deletionState: 'none',
      createdAt: 1,
      updatedAt: 1,
    };
    const bindingReadIds: Array<string | undefined> = [];
    const pairingChallengeResource = jsonResource({
      generationId: 'pairing-generation',
      observedAt: 1,
      challenges: [{
        challengeId: 'pairing-challenge',
        connectionId: 'connection-1',

        pairingRequestId: 'pairing-request-fixture',
        expiresAt: 601_000,

        destinationLabel: 'Project room',
        manualToken: 'ABCDEFGH',
        deepLinkUrl: 'https://example.test/pair?token=ABCDEFGH',
      }],
      proposals: [],
    }, '8');
    const pairingProposalResource = jsonResource({
      generationId: 'pairing-generation',
      observedAt: 2,
      challenges: [],
      proposals: [{
        challengeId: 'pairing-challenge',
        proposalId: 'pairing-proposal',
        connectionId: 'connection-1',

        expiresAt: 601_000,
        endpointLabel: 'Ada',
        proofEndpoint: bindingDirectEndpointCandidate,
        principalId: 'principal-ada',
        state: 'proposed',
      }],
    }, '9');
    const pairingProposalRefreshResource = jsonResource({
      generationId: 'pairing-generation',
      observedAt: 3,
      challenges: [],
      proposals: [{
        challengeId: 'pairing-challenge',
        proposalId: 'pairing-proposal',
        connectionId: 'connection-1',

        expiresAt: 601_000,
        endpointLabel: 'Ada',
        proofEndpoint: bindingDirectEndpointCandidate,
        principalId: 'principal-ada',
        state: 'proposed',
      }],
    }, 'a');
    const executeAction = vi.fn(async ({ action, input }: PluginUiTestkitExecuteActionInput): Promise<JsonValue> => {
      if (action === CONVERSATION_MANAGEMENT_ACTION_IDS_V1.bindingResolve) {
        return (input as Readonly<{ kind?: unknown }>).kind === 'endpoint'
          ? { kind: 'endpointCandidates', candidates: [bindingDirectEndpointCandidate] }
          : { kind: 'unavailable', reason: 'principalResolveUnsupported' };
      }
      if (action === 'session.list') {
        return createSessionCandidatePageFixture({
          sessions: [{ id: 'session-pairing', title: 'Pairing Session' }],
          nextCursor: null,
        });
      }
      if (action === CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionPairingCreate) {
        return {
          kind: 'created',
          generationId: 'pairing-generation',
          challengeId: 'pairing-challenge',
          expiresAt: 601_000,

          destinationLabel: 'Project room',
          manualToken: 'ABCDEFGH',
          deepLinkUrl: 'https://example.test/pair?token=ABCDEFGH',
        };
      }
      if (action === CONVERSATION_MANAGEMENT_ACTION_IDS_V1.bindingRead) {
        // The binding editor opened from the pairing completion reads the exact
        // finalize-returned row.
        bindingReadIds.push((input as Readonly<{ bindingId?: string }>).bindingId);
        return { kind: 'ready', revision: 1, binding: pairingCreatedBinding };
      }
      if (action === CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionPairingFinalize) {
        finalizeAttempts += 1;
        if (finalizeAttempts === 1) {
          throw new PluginError({ code: 'timeout', message: 'The pairing finalization timed out.' });
        }
        return {
          kind: 'created',
          binding: pairingCreatedBinding,
        };
      }
      throw new Error(`Unexpected mounted Action: ${String(action)}`);
    });
    // The QR is drawn by the incumbent host renderer, never by this plugin, so
    // the only thing this surface can be held to is the exact payload it hands
    // that seam.
    const renderedQrPayloads: string[] = [];
    const presentationHost = {
      renderMarkdown: () => null,
      renderCodeBlock: () => null,
      renderPopover: () => null,
      renderIcon: () => null,
      renderQRCode: ({ data }) => {
        renderedQrPayloads.push(data);
        return null;
      },
    } satisfies PluginUiPresentationHost;
    const openedSurfaces: (readonly [string, string])[] = [];
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'fixture-instance-89', mountNonce: 'fixture-mount-89' },
      authorPlugin: { id: 'happier.channels', version: '0.0.0' },
      surface: renderSurface,
      // The countdown's unit abbreviations must come from the catalog. A
      // locale that spells them differently is what discriminates a
      // translated pattern from a hardcoded `${minutes}m ${seconds}s`.
      surfaceContext: {
        ...createChannelsSurfaceContext(),
        translations: {
          'plugins.channels.surface.bindingCreatePairingCountdown': '{minutes} хв {seconds} с',
        },
      },
      adapter: createChannelsSemanticAdapter(emptyDataClient, presentationHost),
      handlers: {
        openSurface: ({ view, subPath }) => {
          openedSurfaces.push([typeof view === 'string' ? view : view.localId, subPath ?? '']);
        },
        selectActionInput: async () => ({ kind: 'cancelled' as const }),
        executeAction,
        readResource: async ({ resource }) => {
          const localId = resourceFixtureLocalId(resource);
          if (localId === PAIRING_RESOURCE.localId) {
            if (outcomeRefreshRequested) {
              outcomeRefreshReads += 1;
              return pairingProposalRefreshResource;
            }
            pairingReads += 1;
            return pairingReads === 1 ? pairingChallengeResource : pairingProposalResource;
          }
          if (localId === BINDINGS_RESOURCE.localId) return bindingsResource;
          if (localId === CONNECTIONS_RESOURCE.localId) return connectionsResource;
          throw new Error(`Unexpected Resource: ${localId}`);
        },
        writeClipboard: async ({ value }) => { copiedValues.push(value); },
        openExternalLink: async ({ url }) => { openedLinks.push(url); },
      },
    });

    try {
      // A direct conversation is proved privately: the challenge offers its
      // deep link and QR, and sends no shared proof location.
      await openBindingEndpointSelection(fixture, bindingDirectEndpointCandidate.label);
      await searchBindingPrincipal(fixture);

      await expect(fixture.getByText('Pairing is required')).resolves.toBeDefined();
      await vi.waitFor(() => {
        expect(executeAction).toHaveBeenCalledWith(expect.objectContaining({
          action: 'session.list',
          input: { view: 'awareness', limit: 100 },
        }));
      });
      expect(executeAction.mock.calls.map(([request]) => request.action)).not.toContain(
        CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionPairingCreate,
      );

      await fixture.press(await fixture.getByRole('button', { name: 'Pairing Session' }));
      await fixture.press(await fixture.getByRole('button', { name: 'Review binding' }));
      await fixture.press(await fixture.getByRole('button', { name: 'Create pairing challenge' }));

      await vi.waitFor(() => {
        expect(executeAction).toHaveBeenCalledWith(expect.objectContaining({
          action: CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionPairingCreate,
          input: {
            connectionId: 'connection-1',
            expectedConnectionRevision: 1,
            pairingRequestId: expect.stringMatching(/\S/u),
            endpointSelection: bindingDirectEndpointSelection,
            target: {
              kind: 'session',
              sessionId: 'session-pairing',
              policy: {
                // A direct conversation mirrors its Session by default.
                deliveryMode: 'mirrorSession',
                permissionCeiling: 'read-only',
                approvals: { kind: 'off' },
                newSession: { kind: 'off' },
              },
            },
          },
        }));
      });
      expect(executeAction.mock.calls.map(([request]) => request.action)).not.toContain(
        CONVERSATION_MANAGEMENT_ACTION_IDS_V1.bindingCreate,
      );
      await expect(fixture.getByText('ABCDEFGH')).resolves.toBeDefined();
      await vi.waitFor(() => {
        expect(document.body.textContent).toContain('Expires in');
      });
      const countdown = document.querySelector<HTMLElement>('[data-testid="channels-binding-create-pairing-countdown"]');
      expect(countdown).not.toBeNull();
      expect(countdown?.textContent).toContain(' хв ');
      expect(countdown?.textContent).toMatch(/\d+ хв \d{2} с/);
      expect(countdown?.textContent).not.toContain('m ');
      expect(countdown?.getAttribute('role')).not.toBe('status');
      expect(countdown?.getAttribute('aria-live')).toBeNull();
      // The QR carries the exact Action-issued deep link and nothing derived
      // from it, and it is offered through the incumbent host presentation
      // seam rather than any Channels-local encoder.
      // The live countdown re-renders this challenge every second, so the
      // stable contract is WHICH payload reaches the host renderer, never how
      // many times React asked it to draw the same one.
      await vi.waitFor(() => {
        expect(renderedQrPayloads.length).toBeGreaterThan(0);
      });
      expect([...new Set(renderedQrPayloads)]).toEqual(['https://example.test/pair?token=ABCDEFGH']);
      // A QR is never the only representation of the payload: the token and
      // link stay copyable and openable, so a host without the QR renderer
      // loses no pairing capability.
      await fixture.press(await fixture.getByRole('button', { name: 'Copy pairing token' }));
      await fixture.press(await fixture.getByRole('button', { name: 'Copy pairing link' }));
      await fixture.press(await fixture.getByRole('button', { name: 'Open pairing link' }));
      expect(copiedValues).toEqual(['ABCDEFGH', 'https://example.test/pair?token=ABCDEFGH']);
      expect(openedLinks).toEqual(['https://example.test/pair?token=ABCDEFGH']);

      const pairingRefreshActions = await fixture.getAllByRole('button', { name: 'Refresh pairing status' });
      await fixture.press(pairingRefreshActions[0]!);
      await expect(fixture.getByText('Pairing request received')).resolves.toBeDefined();
      // Review names the person who actually sent the code and where.
      await expect(fixture.getByText('Ada (principal-ada)')).resolves.toBeDefined();
      await expect(fixture.getByText('A private message')).resolves.toBeDefined();
      await fixture.press(await fixture.getByRole('button', { name: 'Finalize pairing' }));
      await vi.waitFor(() => {
        expect(executeAction).toHaveBeenCalledWith(expect.objectContaining({
          action: CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionPairingFinalize,
          input: {
            generationId: 'pairing-generation',
            proposalId: 'pairing-proposal',
            connectionId: 'connection-1',

            finalizeIdempotencyKey: 'pairing-proposal',
          },
        }));
      });
      await expect(fixture.getByText('Could not confirm the pairing change')).resolves.toBeDefined();
      outcomeRefreshRequested = true;
      const unknownOutcomeRefreshActions = await fixture.getAllByRole('button', { name: 'Refresh pairing status' });
      await fixture.press(unknownOutcomeRefreshActions[0]!);
      await vi.waitFor(() => {
        expect(outcomeRefreshReads).toBeGreaterThanOrEqual(1);
        expect(document.body.textContent).not.toContain('Could not confirm the pairing change');
      });
      await fixture.press(await fixture.getByRole('button', { name: 'Finalize pairing' }));
      await vi.waitFor(() => {
        expect(finalizeAttempts).toBe(2);
      });
      // Completion consumes the binding returned by the mutation owner; a
      // retained paused result and a newly enabled private DM stay distinct.
      await expect(fixture.getByText(
        enabled
          ? 'Conversation paired and enabled.'
          : 'Conversation paired. The binding is saved paused until you review and enable it.',
      )).resolves.toBeDefined();
      expect(document.body.textContent).not.toContain('Pairing completed');
      const reviewLabel = enabled ? 'Review conversation' : 'Review and enable';
      await expect(
        fixture.getByRole('button', { name: reviewLabel }),
      ).resolves.toBeDefined();

      // Reviewing continues in the existing binding editor on the Channels
      // page — the single owner of reviewing and enabling a saved binding —
      // opened for the exact binding id the finalize Action returned, and
      // marked just linked so the page then ends on its first message.
      await fixture.press(await fixture.getByRole('button', { name: reviewLabel }));
      await vi.waitFor(() => {
        expect(openedSurfaces).toEqual([['conversations', 'binding-pairing/edit/new']]);
      });
      expect(bindingReadIds).toEqual([]);
    } finally {
      await fixture.dispose();
    }
  });

  it('recovers an unknown pairing create only through the exact request id it sent', async () => {
    let bindingsReads = 0;
    let pairingReads = 0;
    let sentPairingRequestId: string | undefined;
    let resolvePairingRefresh: ((value: ResourceContent) => void) | undefined;
    const pairingEmptyResource = jsonResource({
      generationId: 'pairing-generation',
      observedAt: 1,
      challenges: [],
      proposals: [],
    }, '4');
    const pairingChallengeResourceFor = (pairingRequestId: string) => jsonResource({
      generationId: 'pairing-generation',
      observedAt: 1,
      challenges: [{
        challengeId: 'pairing-challenge',
        connectionId: 'connection-1',

        pairingRequestId,
        expiresAt: 601_000,

        destinationLabel: 'Project room',
        manualToken: 'ABCDEFGH',
        deepLinkUrl: null,
      }],
      proposals: [],
    }, '7');
    const executeAction = vi.fn(async ({ action, input }: PluginUiTestkitExecuteActionInput): Promise<JsonValue> => {
      if (action === CONVERSATION_MANAGEMENT_ACTION_IDS_V1.bindingResolve) {
        return (input as Readonly<{ kind?: unknown }>).kind === 'endpoint'
          ? { kind: 'endpointCandidates', candidates: [bindingEndpointCandidate] }
          : { kind: 'unavailable', reason: 'principalResolveUnsupported' };
      }
      if (action === 'session.list') {
        return createSessionCandidatePageFixture({ sessions: [{ id: 'session-pairing', title: 'Pairing Session' }], nextCursor: null });
      }
      if (action === CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionPairingCreate) {
        sentPairingRequestId = (input as Readonly<{ pairingRequestId?: string }>).pairingRequestId;
        throw new PluginError({ code: 'timeout', message: 'The pairing request timed out.' });
      }
      throw new Error(`Unexpected mounted Action: ${String(action)}`);
    });
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'fixture-instance-90', mountNonce: 'fixture-mount-90' },
      authorPlugin: { id: 'happier.channels', version: '0.0.0' },
      surface: renderSurface,
      surfaceContext: createChannelsSurfaceContext(),
      adapter: createChannelsSemanticAdapter(),
      handlers: {
        selectActionInput: async () => ({ kind: 'cancelled' as const }),
        executeAction,
        readResource: async ({ resource }) => {
          const localId = resourceFixtureLocalId(resource);
          if (localId === BINDINGS_RESOURCE.localId) {
            bindingsReads += 1;
            return bindingsResource;
          }
          if (localId === CONNECTIONS_RESOURCE.localId) return connectionsResource;
          if (localId === PAIRING_RESOURCE.localId) {
            pairingReads += 1;
            if (pairingReads === 1) return pairingEmptyResource;
            return await new Promise<ResourceContent>((resolve) => {
              resolvePairingRefresh = resolve;
            });
          }
          throw new Error(`Unexpected Resource: ${localId}`);
        },
      },
    });

    try {
      await openBindingEndpointSelection(fixture);
      await searchBindingPrincipal(fixture);
      await fixture.press(await fixture.getByRole('button', { name: 'Pairing Session' }));
      await fixture.press(await fixture.getByRole('button', { name: 'Review binding' }));
      await fixture.press(await fixture.getByRole('button', { name: 'Create pairing challenge' }));

      await vi.waitFor(() => {
        expect(pairingReads).toBe(2);
        expect(resolvePairingRefresh).toBeTypeOf('function');
        expect(sentPairingRequestId).toEqual(expect.any(String));
      });
      await expect(fixture.queryByText('ABCDEFGH')).resolves.toBeUndefined();

      // A challenge created by another request — a second device's superseding
      // create on the same connection and revision — is never adopted: the
      // exact request id this create sent is the only recovery match.
      await act(async () => {
        resolvePairingRefresh?.(pairingChallengeResourceFor('another-device-request'));
      });
      await expect(fixture.queryByText('ABCDEFGH')).resolves.toBeUndefined();
      await expect(fixture.getByText('Pairing status is unavailable')).resolves.toBeDefined();
      expect(bindingsReads).toBe(1);
      expect(executeAction.mock.calls.filter(([request]) => (
        request.action === CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionPairingCreate
      ))).toHaveLength(1);
    } finally {
      await fixture.dispose();
    }
  });

  it.each(['success', 'failedThenRetry'] as const)('recovers an unknown pairing create through the challenge carrying its own request id (%s)', async (refreshOutcome) => {
    let pairingReads = 0;
    let sentPairingRequestId: string | undefined;
    let resolvePairingRefresh: ((value: ResourceContent) => void) | undefined;
    let rejectPairingRefresh: ((error: Error) => void) | undefined;
    const pairingEmptyResource = jsonResource({
      generationId: 'pairing-generation',
      observedAt: 1,
      challenges: [],
      proposals: [],
    }, 'b');
    const pairingChallengeResourceFor = (pairingRequestId: string) => jsonResource({
      generationId: 'pairing-generation',
      observedAt: 1,
      challenges: [{
        challengeId: 'pairing-challenge',
        connectionId: 'connection-1',

        pairingRequestId,
        expiresAt: 601_000,

        destinationLabel: 'Project room',
        manualToken: 'ABCDEFGH',
        deepLinkUrl: null,
      }],
      proposals: [],
    }, 'c');
    const executeAction = vi.fn(async ({ action, input }: PluginUiTestkitExecuteActionInput): Promise<JsonValue> => {
      if (action === CONVERSATION_MANAGEMENT_ACTION_IDS_V1.bindingResolve) {
        return (input as Readonly<{ kind?: unknown }>).kind === 'endpoint'
          ? { kind: 'endpointCandidates', candidates: [bindingEndpointCandidate] }
          : { kind: 'unavailable', reason: 'principalResolveUnsupported' };
      }
      if (action === 'session.list') {
        return createSessionCandidatePageFixture({ sessions: [{ id: 'session-pairing', title: 'Pairing Session' }], nextCursor: null });
      }
      if (action === CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionPairingCreate) {
        sentPairingRequestId = (input as Readonly<{ pairingRequestId?: string }>).pairingRequestId;
        throw new PluginError({ code: 'timeout', message: 'The pairing request timed out.' });
      }
      throw new Error(`Unexpected mounted Action: ${String(action)}`);
    });
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'fixture-instance-91', mountNonce: 'fixture-mount-91' },
      authorPlugin: { id: 'happier.channels', version: '0.0.0' },
      surface: renderSurface,
      surfaceContext: createChannelsSurfaceContext(),
      adapter: createChannelsSemanticAdapter(),
      handlers: {
        selectActionInput: async () => ({ kind: 'cancelled' as const }),
        executeAction,
        readResource: async ({ resource }) => {
          const localId = resourceFixtureLocalId(resource);
          if (localId === BINDINGS_RESOURCE.localId) return bindingsResource;
          if (localId === CONNECTIONS_RESOURCE.localId) return connectionsResource;
          if (localId === PAIRING_RESOURCE.localId) {
            pairingReads += 1;
            if (pairingReads === 1) return pairingEmptyResource;
            return await new Promise<ResourceContent>((resolve, reject) => {
              resolvePairingRefresh = resolve;
              rejectPairingRefresh = reject;
            });
          }
          throw new Error(`Unexpected Resource: ${localId}`);
        },
      },
    });

    try {
      await openBindingEndpointSelection(fixture);
      await searchBindingPrincipal(fixture);
      await fixture.press(await fixture.getByRole('button', { name: 'Pairing Session' }));
      await fixture.press(await fixture.getByRole('button', { name: 'Review binding' }));
      await fixture.press(await fixture.getByRole('button', { name: 'Create pairing challenge' }));

      await vi.waitFor(() => {
        expect(pairingReads).toBe(2);
        expect(resolvePairingRefresh).toBeTypeOf('function');
        if (sentPairingRequestId === undefined) throw new Error('The create request id was not captured yet.');
      });
      await expect(fixture.getByText('Could not confirm the pairing change')).resolves.toBeDefined();
      await expect(fixture.queryByText('ABCDEFGH')).resolves.toBeUndefined();
      if (refreshOutcome === 'failedThenRetry') {
        await act(async () => {
          rejectPairingRefresh?.(new PluginError({ code: 'unavailable', message: 'Pairing refresh is unavailable.' }));
        });
        await expect(fixture.getByText('Could not confirm the pairing change')).resolves.toBeDefined();
        await expect(fixture.queryByText('ABCDEFGH')).resolves.toBeUndefined();
        await fixture.press(await fixture.getByRole('button', { name: 'Refresh pairing status' }));
        await vi.waitFor(() => expect(pairingReads).toBe(3));
      }
      await act(async () => {
        resolvePairingRefresh?.(pairingChallengeResourceFor(sentPairingRequestId!));
      });
      await expect(fixture.getByText('ABCDEFGH')).resolves.toBeDefined();
      await expect(fixture.queryByText('Could not confirm the pairing change')).resolves.toBeUndefined();
    } finally {
      await fixture.dispose();
    }
  });

  it('cancels the current pairing challenge or authenticated proposal through the canonical Action', async () => {
    for (const fixtureCase of [
      {
        name: 'challenge',
        resource: jsonResource({
          generationId: 'pairing-generation',
          observedAt: 1,
          challenges: [{
            challengeId: 'pairing-challenge',
            connectionId: 'connection-1',

            pairingRequestId: 'pairing-request-fixture',
            expiresAt: 601_000,

            destinationLabel: 'Project room',
            proofEndpoint: bindingSharedProofEndpoint,
            manualToken: 'ABCDEFGH',
            deepLinkUrl: null,
          }],
          proposals: [],
        }, '5'),
        expectedInput: { generationId: 'pairing-generation', challengeId: 'pairing-challenge' },
      },
      {
        name: 'proposal',
        resource: jsonResource({
          generationId: 'pairing-generation',
          observedAt: 1,
          challenges: [],
          proposals: [{
            challengeId: 'pairing-challenge',
            proposalId: 'pairing-proposal',
            connectionId: 'connection-1',

            expiresAt: 601_000,
            endpointLabel: 'Project room',
            proofEndpoint: bindingSharedProofEndpoint,
            principalId: 'principal-ada',
            state: 'proposed',
          }],
        }, '6'),
        expectedInput: { generationId: 'pairing-generation', proposalId: 'pairing-proposal' },
      },
    ] as const) {
      const executeAction = vi.fn(async ({ action, input }: PluginUiTestkitExecuteActionInput): Promise<JsonValue> => {
        if (action === CONVERSATION_MANAGEMENT_ACTION_IDS_V1.bindingResolve) {
          return (input as Readonly<{ kind?: unknown }>).kind === 'endpoint'
            ? { kind: 'endpointCandidates', candidates: [bindingEndpointCandidate] }
            : { kind: 'unavailable', reason: 'principalResolveUnsupported' };
        }
        if (action === 'session.list') {
          return createSessionCandidatePageFixture({ sessions: [{ id: 'session-pairing', title: 'Pairing Session' }], nextCursor: null });
        }
        if (action === CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionPairingCreate) {
          return {
            kind: 'created',
            generationId: 'pairing-generation',
            challengeId: 'pairing-challenge',
            expiresAt: 601_000,

            destinationLabel: 'Project room',
            proofEndpoint: bindingSharedProofEndpoint,
            manualToken: 'ABCDEFGH',
            deepLinkUrl: null,
          };
        }
        if (action === CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionPairingCancel) {
          return { kind: 'cancelled' };
        }
        throw new Error(`Unexpected mounted Action: ${String(action)}`);
      });
      const fixture = await createPluginUiTestkit({
        identity: { instanceId: 'fixture-instance-92', mountNonce: 'fixture-mount-92' },
        authorPlugin: { id: 'happier.channels', version: '0.0.0' },
        surface: renderSurface,
        surfaceContext: createChannelsSurfaceContext(),
        adapter: createChannelsSemanticAdapter(),
        handlers: {
          selectActionInput: async () => ({ kind: 'cancelled' as const }),
          executeAction,
          readResource: async ({ resource }) => {
            const localId = resourceFixtureLocalId(resource);
            if (localId === BINDINGS_RESOURCE.localId) return bindingsResource;
            if (localId === CONNECTIONS_RESOURCE.localId) return connectionsResource;
            if (localId === PAIRING_RESOURCE.localId) return fixtureCase.resource;
            throw new Error(`Unexpected Resource: ${localId}`);
          },
        },
      });

      try {
        await openBindingEndpointSelection(fixture);
        await searchBindingPrincipal(fixture);
        await fixture.press(await fixture.getByRole('button', { name: 'Pairing Session' }));
        await fixture.press(await fixture.getByRole('button', { name: 'Review binding' }));
        await fixture.press(await fixture.getByRole('button', { name: 'Create pairing challenge' }));
        await fixture.press(await fixture.getByRole('button', { name: 'Cancel pairing' }));

        await vi.waitFor(() => {
          expect(executeAction).toHaveBeenCalledWith(expect.objectContaining({
            action: CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionPairingCancel,
            input: fixtureCase.expectedInput,
          }));
        });
        await expect(fixture.getByRole('button', { name: 'Add binding' })).resolves.toBeDefined();
      } finally {
        await fixture.dispose();
      }
    }
  });

  it('sets up a shared router parent through pairing with an empty named group and an optional topic for the code', async () => {
    const topicCandidate = {
      kind: 'thread' as const,
      audience: 'shared' as const,
      id: 'room-project:7',
      parentId: 'room-project',
      parentLabel: 'Project room',
    };
    // The resolver may return threads of other parents; only the selected
    // parent's own threads are proof locations the writer accepts.
    const siblingParentTopic = {
      kind: 'thread' as const,
      audience: 'shared' as const,
      id: 'room-other:3',
      parentId: 'room-other',
      parentLabel: 'Other room',
    };
    const copiedValues: string[] = [];
    const renderedQrPayloads: string[] = [];
    const sharedChallenge = {
      expiresAt: 601_000,

      destinationLabel: 'Project room',
      proofEndpoint: topicCandidate,
      manualToken: 'ABCDEFGH',
      deepLinkUrl: null,
    };
    const executeAction = vi.fn(async ({ action, input }: PluginUiTestkitExecuteActionInput): Promise<JsonValue> => {
      if (action === CONVERSATION_MANAGEMENT_ACTION_IDS_V1.bindingResolve) {
        const request = input as Readonly<{ kind?: unknown; kinds?: readonly string[] }>;
        if (request.kind === 'endpoint') {
          return request.kinds?.includes('thread') === true
            ? { kind: 'endpointCandidates', candidates: [topicCandidate, siblingParentTopic] }
            : { kind: 'endpointCandidates', candidates: [bindingEndpointCandidate] };
        }
        return { kind: 'unavailable', reason: 'principalResolveUnsupported' };
      }
      if (action === 'session.list') {
        return createSessionCandidatePageFixture({ sessions: [{ id: 'session-pairing', title: 'Pairing Session' }], nextCursor: null });
      }
      if (action === CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionPairingCreate) {
        return { kind: 'created', generationId: 'pairing-generation', challengeId: 'pairing-challenge', ...sharedChallenge };
      }
      throw new Error(`Unexpected mounted Action: ${String(action)}`);
    });
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'fixture-instance-93', mountNonce: 'fixture-mount-93' },
      authorPlugin: { id: 'happier.channels', version: '0.0.0' },
      surface: renderSurface,
      surfaceContext: createChannelsSurfaceContext(),
      adapter: createChannelsSemanticAdapter(emptyDataClient, {
        renderMarkdown: () => null,
        renderCodeBlock: () => null,
        renderPopover: () => null,
        renderIcon: () => null,
        renderQRCode: ({ data }) => {
          renderedQrPayloads.push(data);
          return null;
        },
      } satisfies PluginUiPresentationHost),
      handlers: {
        selectActionInput: async () => ({ kind: 'cancelled' as const }),
        executeAction,
        readResource: async ({ resource }) => {
          const localId = resourceFixtureLocalId(resource);
          if (localId === PAIRING_RESOURCE.localId) {
            return jsonResource({
              generationId: 'pairing-generation',
              observedAt: 1,
              challenges: [{
                challengeId: 'pairing-challenge',
                connectionId: 'connection-1',

                pairingRequestId: 'pairing-request-fixture',
                ...sharedChallenge,
              }],
              proposals: [],
            }, 'b');
          }
          if (localId === BINDINGS_RESOURCE.localId) return bindingsResource;
          if (localId === CONNECTIONS_RESOURCE.localId) return connectionsResource;
          throw new Error(`Unexpected Resource: ${localId}`);
        },
        writeClipboard: async ({ value }) => { copiedValues.push(value); },
      },
    });

    try {
      await openBindingEndpointSelection(fixture);
      await searchBindingPrincipal(fixture);
      await expect(fixture.getByText('Pairing is required')).resolves.toBeDefined();
      // A shared parent whose people are proved by pairing can still route
      // each new thread to its own session.
      await vi.waitFor(() => {
        expect(document.querySelector('[data-testid="channels-binding-target-router"]')).not.toBeNull();
      });
      expect(document.body.textContent).toContain('The person who pairs starts in one sender group');
      await pressByTestId('channels-binding-target-router');

      // The one group is named by the owner and has no typed members.
      await expect(fixture.findByRole('heading', { name: 'Routes' })).resolves.toBeDefined();
      expect(document.body.textContent).toContain('Whoever sends the pairing code');
      await expect(fixture.getByRole('button', { name: 'Add group' })).rejects.toThrow();
      await enterTextByTestId('channels-router-pairing-group-name', 'owners');
      await fixture.press(await fixture.getByRole('button', { name: 'Review binding' }));

      // The destination and the place the code is posted are separate facts.
      const proof = document.querySelector<HTMLElement>('[data-testid="channels-binding-create-proof-location"]');
      expect(proof?.textContent).toContain('Connecting Project room');
      expect(proof?.textContent).toContain('not a reply');
      await expect(fixture.getByRole('radio', { name: 'This conversation', state: { checked: true } })).resolves.toBeDefined();
      await expect(fixture.getByRole('radio', { name: 'A private message to the bot', state: { checked: false } })).resolves.toBeDefined();

      // Choosing a topic is optional; once chosen, nothing is created until a
      // topic of this parent is picked.
      await fixture.press(await fixture.getByRole('radio', { name: 'One of its topics', state: { checked: false } }));
      await expect(fixture.getByRole('button', {
        name: 'Create pairing challenge',
        state: { disabled: true },
      })).resolves.toBeDefined();
      await enterTextByTestId('channels-binding-create-proof-thread-query', topicCandidate.id);
      await fixture.press(await fixture.getByRole('button', { name: 'Find' }));
      await vi.waitFor(() => {
        expect(executeAction).toHaveBeenCalledWith(expect.objectContaining({
          action: CONVERSATION_MANAGEMENT_ACTION_IDS_V1.bindingResolve,
          input: {
            kind: 'endpoint',
            connectionId: 'connection-1',
            expectedConnectionRevision: 1,
            query: topicCandidate.id,
            kinds: ['thread'],
          },
        }));
      });
      await vi.waitFor(() => {
        expect(document.querySelector('[data-testid="channels-binding-create-proof-thread:room-project:7"]')?.textContent)
          .toContain('A topic in Project room');
      });
      expect(document.body.textContent).not.toContain('Other room');
      await pressByTestId('channels-binding-create-proof-thread:room-project:7');
      await fixture.press(await fixture.getByRole('button', { name: 'Create pairing challenge' }));
      await vi.waitFor(() => {
        expect(executeAction).toHaveBeenCalledWith(expect.objectContaining({
          action: CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionPairingCreate,
          input: {
            connectionId: 'connection-1',
            expectedConnectionRevision: 1,
            pairingRequestId: expect.stringMatching(/\S/u),
            endpointSelection: bindingEndpointSelection,
            proofEndpointSelection: {
              query: topicCandidate.id,
              kinds: ['thread'],
              selected: { kind: 'thread', audience: 'shared', id: 'room-project:7', parentId: 'room-project' },
            },
            target: {
              kind: 'threadRouter',
              principalGroups: [{ id: 'owners', principalIds: [] }],
              routes: [],
            },
          },
        }));
      });

      // The shared challenge offers the manual command at its place, never a
      // private link or QR that would move the proof elsewhere.
      await vi.waitFor(() => {
        expect(document.querySelector('[data-testid="channels-binding-create-pairing-command"]')?.textContent)
          .toBe('/pair ABCDEFGH');
      });
      expect(document.body.textContent).toContain('Send the code in A topic in Project room');
      expect(document.body.textContent).toContain('Anyone in A topic in Project room can see this code');
      await expect(fixture.getByRole('button', { name: 'Open pairing link' })).rejects.toThrow();
      expect(renderedQrPayloads).toEqual([]);
      await fixture.press(await fixture.getByRole('button', { name: 'Copy command' }));
      expect(copiedValues).toEqual(['/pair ABCDEFGH']);
    } finally {
      await fixture.dispose();
    }
  });

  it('lets the owner prove a shared conversation by a private message to the bot instead', async () => {
    const executeAction = vi.fn(async ({ action, input }: PluginUiTestkitExecuteActionInput): Promise<JsonValue> => {
      if (action === CONVERSATION_MANAGEMENT_ACTION_IDS_V1.bindingResolve) {
        return (input as Readonly<{ kind?: unknown }>).kind === 'endpoint'
          ? { kind: 'endpointCandidates', candidates: [bindingEndpointCandidate] }
          : { kind: 'unavailable', reason: 'principalResolveUnsupported' };
      }
      if (action === 'session.list') {
        return createSessionCandidatePageFixture({ sessions: [{ id: 'session-pairing', title: 'Pairing Session' }], nextCursor: null });
      }
      if (action === CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionPairingCreate) {
        return {
          kind: 'created',
          generationId: 'pairing-generation',
          challengeId: 'pairing-challenge',
          expiresAt: 601_000,

          destinationLabel: 'Project room',
          manualToken: 'ABCDEFGH',
          deepLinkUrl: 'https://example.test/pair?token=ABCDEFGH',
        };
      }
      throw new Error(`Unexpected mounted Action: ${String(action)}`);
    });
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'fixture-instance-92', mountNonce: 'fixture-mount-92' },
      authorPlugin: { id: 'happier.channels', version: '0.0.0' },
      surface: renderSurface,
      surfaceContext: createChannelsSurfaceContext(),
      adapter: createChannelsSemanticAdapter(),
      handlers: {
        selectActionInput: async () => ({ kind: 'cancelled' as const }),
        executeAction,
        readResource: async ({ resource }) => {
          const localId = resourceFixtureLocalId(resource);
          if (localId === PAIRING_RESOURCE.localId) {
            return jsonResource({
              generationId: 'pairing-generation',
              observedAt: 2,
              challenges: [{
                challengeId: 'pairing-challenge',
                connectionId: 'connection-1',

                pairingRequestId: 'pairing-request-fixture',
                expiresAt: 601_000,

                destinationLabel: 'Project room',
                manualToken: 'ABCDEFGH',
                deepLinkUrl: 'https://example.test/pair?token=ABCDEFGH',
              }],
              proposals: [],
            }, 'c');
          }
          if (localId === BINDINGS_RESOURCE.localId) return bindingsResource;
          if (localId === CONNECTIONS_RESOURCE.localId) return connectionsResource;
          throw new Error(`Unexpected Resource: ${localId}`);
        },
      },
    });

    try {
      await openBindingEndpointSelection(fixture);
      await searchBindingPrincipal(fixture);
      await vi.waitFor(() => {
        expect(executeAction).toHaveBeenCalledWith(expect.objectContaining({ action: 'session.list' }));
      });
      await fixture.press(await fixture.getByRole('button', { name: 'Pairing Session' }));
      await fixture.press(await fixture.getByRole('button', { name: 'Review binding' }));

      // A flat shared conversation offers the conversation itself (default)
      // or a private message; topics belong to router parents only.
      await expect(fixture.getByRole('radio', { name: 'This conversation', state: { checked: true } })).resolves.toBeDefined();
      await expect(fixture.getByRole('radio', { name: 'One of its topics' })).rejects.toThrow();
      expect(document.querySelector('[data-testid="channels-binding-create-proof-race"]')).not.toBeNull();
      await fixture.press(await fixture.getByRole('radio', { name: 'A private message to the bot', state: { checked: false } }));
      // Only the person who opens the private chat sees the code, so the
      // shared race disclosure no longer applies.
      await vi.waitFor(() => {
        expect(document.querySelector('[data-testid="channels-binding-create-proof-race"]')).toBeNull();
      });
      await fixture.press(await fixture.getByRole('button', { name: 'Create pairing challenge' }));
      await vi.waitFor(() => {
        expect(executeAction).toHaveBeenCalledWith(expect.objectContaining({
          action: CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionPairingCreate,
        }));
      });
      const createCall = executeAction.mock.calls.find(([request]) => (
        request.action === CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionPairingCreate
      ));
      expect(createCall?.[0].input).toMatchObject({ endpointSelection: bindingEndpointSelection });
      expect(createCall?.[0].input).not.toHaveProperty('proofEndpointSelection');
      // The existing private challenge: link and token, no shared command.
      await expect(fixture.findByRole('button', { name: 'Copy pairing link' })).resolves.toBeDefined();
      expect(document.querySelector('[data-testid="channels-binding-create-pairing-command"]')).toBeNull();
    } finally {
      await fixture.dispose();
    }
  });

  it('names the repair for each typed shared-pairing refusal', async () => {
    for (const refusal of [
      { code: 'channels_pairing_router_bootstrap_invalid', title: 'Pairing needs one empty sender group' },
      { code: 'channels_pairing_proof_endpoint_mismatch', title: 'The code can’t be accepted there' },
      { code: 'channels_pairing_proof_endpoint_unavailable', title: 'Couldn’t check where to send the code' },
    ] as const) {
      const executeAction = vi.fn(async ({ action, input }: PluginUiTestkitExecuteActionInput): Promise<JsonValue> => {
        if (action === CONVERSATION_MANAGEMENT_ACTION_IDS_V1.bindingResolve) {
          return (input as Readonly<{ kind?: unknown }>).kind === 'endpoint'
            ? { kind: 'endpointCandidates', candidates: [bindingEndpointCandidate] }
            : { kind: 'unavailable', reason: 'principalResolveUnsupported' };
        }
        if (action === 'session.list') {
          return createSessionCandidatePageFixture({ sessions: [{ id: 'session-pairing', title: 'Pairing Session' }], nextCursor: null });
        }
        if (action === CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionPairingCreate) {
          throw new PluginError({ code: refusal.code, message: 'Refused by the pairing writer.' });
        }
        throw new Error(`Unexpected mounted Action: ${String(action)}`);
      });
      const fixture = await createPluginUiTestkit({
        identity: { instanceId: `fixture-instance-94-${refusal.code}`, mountNonce: `fixture-mount-94-${refusal.code}` },
        authorPlugin: { id: 'happier.channels', version: '0.0.0' },
        surface: renderSurface,
        surfaceContext: createChannelsSurfaceContext(),
        adapter: createChannelsSemanticAdapter(),
        handlers: {
          selectActionInput: async () => ({ kind: 'cancelled' as const }),
          executeAction,
          readResource: async ({ resource }) => {
            const localId = resourceFixtureLocalId(resource);
            if (localId === BINDINGS_RESOURCE.localId) return bindingsResource;
            if (localId === CONNECTIONS_RESOURCE.localId) return connectionsResource;
            throw new Error(`Unexpected Resource: ${localId}`);
          },
        },
      });

      try {
        await openBindingEndpointSelection(fixture);
        await searchBindingPrincipal(fixture);
        await fixture.press(await fixture.getByRole('button', { name: 'Pairing Session' }));
        await fixture.press(await fixture.getByRole('button', { name: 'Review binding' }));
        await fixture.press(await fixture.getByRole('button', { name: 'Create pairing challenge' }));
        await expect(fixture.getByText(refusal.title)).resolves.toBeDefined();
        expect(document.body.textContent).not.toContain('Could not create the binding');
      } finally {
        await fixture.dispose();
      }
    }
  });

  it('does not turn other principal resolver settlements into pairing', async () => {
    const settlements = [
      {
        result: { kind: 'unavailable', reason: 'providerUnavailable' } as const,
        expectedTitle: 'Binding setup is unavailable',
      },
      {
        result: { kind: 'stale' } as const,
        expectedTitle: 'The selected connection changed',
      },
    ] as const;

    for (const settlement of settlements) {
      const executeAction = vi.fn(async ({ action, input }: PluginUiTestkitExecuteActionInput) => {
        if (action !== CONVERSATION_MANAGEMENT_ACTION_IDS_V1.bindingResolve) {
          throw new Error(`Unexpected mounted Action: ${String(action)}`);
        }
        return (input as Readonly<{ kind?: unknown }>).kind === 'endpoint'
          ? { kind: 'endpointCandidates', candidates: [bindingEndpointCandidate] }
          : settlement.result;
      });
      const fixture = await createPluginUiTestkit({
        identity: { instanceId: 'fixture-instance-93', mountNonce: 'fixture-mount-93' },
        authorPlugin: { id: 'happier.channels', version: '0.0.0' },
        surface: renderSurface,
        surfaceContext: createChannelsSurfaceContext(),
        adapter: createChannelsSemanticAdapter(),
        handlers: {
          selectActionInput: async () => ({ kind: 'cancelled' as const }),
          executeAction,
          readResource: bindingResourceReader(),
        },
      });

      try {
        await openBindingEndpointSelection(fixture);
        await searchBindingPrincipal(fixture);

        await expect(fixture.getByText(settlement.expectedTitle)).resolves.toBeDefined();
        await expect(fixture.queryByText('Pairing is required')).resolves.toBeUndefined();
        expect(executeAction.mock.calls.map(([request]) => request.action)).not.toContain(
          CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionPairingCreate,
        );
      } finally {
        await fixture.dispose();
      }
    }
  });

  it('says why an endpoint search was refused and keeps the waiting copy for transient provider states', async () => {
    const diagnostic = 'Telegram cannot search chats by name. Enter a numeric chat ID, a public @username, or chatId:topicId for a topic.';
    const settlements = [
      {
        result: { kind: 'notReady', reason: 'unsupported', diagnostic } as const,
        expected: [diagnostic],
        absent: 'Wait for the provider to become ready',
      },
      {
        result: { kind: 'notReady', reason: 'invalidConfiguration' } as const,
        expected: ['The provider reports that its remote configuration is not valid for this connection.'],
        absent: 'Wait for the provider to become ready',
      },
      {
        result: { kind: 'notReady', reason: 'network' } as const,
        expected: ['Wait for the provider to become ready, then search again.'],
        absent: 'cannot search chats by name',
      },
    ] as const;

    for (const [index, settlement] of settlements.entries()) {
      const executeAction = vi.fn(async ({ action }: PluginUiTestkitExecuteActionInput) => {
        if (action !== CONVERSATION_MANAGEMENT_ACTION_IDS_V1.bindingResolve) {
          throw new Error(`Unexpected mounted Action: ${String(action)}`);
        }
        return settlement.result;
      });
      const fixture = await createPluginUiTestkit({
        identity: { instanceId: `fixture-instance-93r-${index}`, mountNonce: `fixture-mount-93r-${index}` },
        authorPlugin: { id: 'happier.channels', version: '0.0.0' },
        surface: renderSurface,
        surfaceContext: createChannelsSurfaceContext(),
        adapter: createChannelsSemanticAdapter(),
        handlers: {
          selectActionInput: async () => ({ kind: 'cancelled' as const }),
          executeAction,
          readResource: bindingResourceReader(),
        },
      });

      try {
        await fixture.press(await fixture.getByRole('button', { name: 'Add binding' }));
        await enterTextByTestId('channels-binding-create-endpoint-query', 'Project room');
        await fixture.press(await fixture.getByRole('button', { name: 'Search endpoints' }));
        await vi.waitFor(() => {
          for (const text of settlement.expected) expect(document.body.textContent).toContain(text);
        });
        expect(document.body.textContent).not.toContain(settlement.absent);
      } finally {
        await fixture.dispose();
      }
    }
  });

  it('uses only the no-invoke new-Session selector and leaves cancellation without a create', async () => {
    const selectActionInput = vi.fn(async (_input: PluginUiTestkitSelectActionInputInput) => ({ kind: 'cancelled' as const }));
    const executeAction = vi.fn(async ({ action, input }: PluginUiTestkitExecuteActionInput): Promise<JsonValue> => {
      if (action === CONVERSATION_MANAGEMENT_ACTION_IDS_V1.bindingResolve) {
        return (input as Readonly<{ kind?: unknown }>).kind === 'endpoint'
          ? { kind: 'endpointCandidates', candidates: [bindingEndpointCandidate] }
          : { kind: 'principalCandidates', candidates: [bindingPrincipalCandidate] };
      }
      if (action === 'session.list') {
        return createSessionCandidatePageFixture({ sessions: [{ id: 'session-1', title: 'Project review' }], nextCursor: null });
      }
      throw new Error(`Unexpected mounted Action: ${String(action)}`);
    });
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'fixture-instance-94', mountNonce: 'fixture-mount-94' },
      authorPlugin: { id: 'happier.channels', version: '0.0.0' },
      surface: renderSurface,
      surfaceContext: createChannelsSurfaceContext(),
      adapter: createChannelsSemanticAdapter(),
      handlers: {
        selectActionInput,
        executeAction,
        readResource: bindingResourceReader(),
      },
    });

    try {
      await openBindingEndpointSelection(fixture);
      await selectPrincipalAndOpenTarget(fixture);
      await fixture.press(await fixture.getByRole('button', { name: 'Project review' }));

      const newSession = await fixture.getByRole('switch', {
        name: 'Allow /new',
        state: { checked: false },
      });
      await fixture.press(newSession);

      await vi.waitFor(() => {
        expect(selectActionInput).toHaveBeenCalledWith(expect.objectContaining({
          request: {
            hostAction: { action: 'session.spawn_new', projection: 'serverStartDraft' },
          },
        }));
      });
      await expect(fixture.getByRole('switch', {
        name: 'Allow /new',
        state: { checked: false },
      })).resolves.toBeDefined();
      expect(executeAction.mock.calls.map(([request]) => request.action)).not.toContain('session.spawn_new');
      expect(executeAction.mock.calls.map(([request]) => request.action)).not.toContain(
        CONVERSATION_MANAGEMENT_ACTION_IDS_V1.bindingCreate,
      );
    } finally {
      await fixture.dispose();
    }
  });

  it('submits the selected generic result delivery for an Automation target without a client-side verifier', async () => {
    const executeAction = vi.fn(async ({ action, input }: PluginUiTestkitExecuteActionInput): Promise<JsonValue> => {
      if (action === CONVERSATION_MANAGEMENT_ACTION_IDS_V1.bindingResolve) {
        return (input as Readonly<{ kind?: unknown }>).kind === 'endpoint'
          ? { kind: 'endpointCandidates', candidates: [bindingEndpointCandidate] }
          : { kind: 'principalCandidates', candidates: [bindingPrincipalCandidate] };
      }
      if (action === 'session.list') {
        return createSessionCandidatePageFixture({ sessions: [{ id: 'session-1', title: 'Project review' }], nextCursor: null });
      }
      if (action === 'automation.conversation.targets.list') {
        if ((input as Readonly<{ cursor?: unknown }>).cursor === undefined) {
          return {
            items: [{
              automationId: 'automation-1',
              label: 'Initial report',
              execution: { targetType: 'new_session', enabled: true },
            }],
            nextCursor: 'automation-1',
          };
        }
        if ((input as Readonly<{ cursor?: unknown }>).cursor === 'automation-1') {
          return {
            items: [{
              automationId: 'automation-2',
              label: 'Build report',
              execution: { targetType: null, enabled: true },
            }],
            nextCursor: null,
          };
        }
        return {
          items: [],
          nextCursor: null,
        };
      }
      if (action === CONVERSATION_MANAGEMENT_ACTION_IDS_V1.bindingCreate) {
        return { kind: 'notVerified', reason: 'resultDeliveryUnsupported' };
      }
      throw new Error(`Unexpected mounted Action: ${String(action)}`);
    });
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'fixture-instance-95', mountNonce: 'fixture-mount-95' },
      authorPlugin: { id: 'happier.channels', version: '0.0.0' },
      surface: renderSurface,
      surfaceContext: createChannelsSurfaceContext(),
      adapter: createChannelsSemanticAdapter(),
      handlers: {
        selectActionInput: async () => ({ kind: 'cancelled' as const }),
        executeAction,
        readResource: bindingResourceReader(),
      },
    });

    try {
      await openBindingEndpointSelection(fixture);
      await selectPrincipalAndOpenTarget(fixture);
      await vi.waitFor(() => {
        expect(executeAction).toHaveBeenCalledWith(expect.objectContaining({
          action: 'session.list',
          input: { view: 'awareness', limit: 100 },
        }));
      });
      await fixture.press(await fixture.getByRole('button', { name: 'Show Workflows' }));
      await vi.waitFor(() => {
        expect(executeAction).toHaveBeenCalledWith(expect.objectContaining({
          action: 'automation.conversation.targets.list',
          input: { limit: 100 },
        }));
      });
      await fixture.press(await fixture.getByRole('button', { name: 'Show more Workflows' }));
      await vi.waitFor(() => {
        expect(executeAction).toHaveBeenCalledWith(expect.objectContaining({
          action: 'automation.conversation.targets.list',
          input: { limit: 100, cursor: 'automation-1' },
        }));
      });
      await fixture.press(await fixture.getByRole('button', { name: 'Build report' }));
      await expect(fixture.getByRole('radio', {
        name: 'No external result',
        state: { checked: true },
      })).resolves.toBeDefined();
      await fixture.press(await fixture.getByRole('radio', {
        name: 'Final result',
        state: { checked: false },
      }));
      await fixture.press(await fixture.getByRole('button', { name: 'Review binding' }));

      // Binding an Automation delegates unattended execution to an external
      // sender; the final confirmation must name that effect, not only the
      // Automation label and the reply choice.
      const summary = document.querySelector<HTMLElement>('[data-testid="channels-binding-create-summary"]');
      expect(summary?.textContent).toContain('What an allowed sender starts');
      expect(summary?.textContent).toContain(
        'A message from the allowed sender starts this Workflow, which runs its configured workflow.',
      );
      expect(summary?.textContent).toContain('Delegated authority');
      expect(summary?.textContent).toContain(
        'The Workflow runs unattended with the permissions, tools, and outward effects its own definition grants.',
      );

      await fixture.press(await fixture.getByRole('button', { name: 'Link conversation' }));

      await vi.waitFor(() => {
        expect(executeAction).toHaveBeenCalledWith(expect.objectContaining({
          action: CONVERSATION_MANAGEMENT_ACTION_IDS_V1.bindingCreate,
          input: expect.objectContaining({
            connectionId: 'connection-1',
            expectedConnectionRevision: 1,
            target: {
              kind: 'automation',
              automationId: 'automation-2',
              policy: { resultDelivery: 'finalResult' },
            },
          }),
        }));
      });
      await expect(fixture.getByText('This Workflow cannot return a final result')).resolves.toBeDefined();
      expect(document.body.textContent).not.toContain('The selected target is no longer available');
      expect(executeAction.mock.calls.map(([request]) => request.action)).not.toContain(
        'automation.conversation.target.verify',
      );
    } finally {
      await fixture.dispose();
    }
  });

  it('keeps the mounted target-row tree bounded across accumulated Automation pages', async () => {
    const pageAutomation = (page: number, index: number) => ({
      automationId: `automation-p${page}-${index}`,
      label: `Report ${page}-${index}`,
      execution: { targetType: 'existing_session', enabled: true },
    });
    const executeAction = vi.fn(async ({ action, input }: PluginUiTestkitExecuteActionInput): Promise<JsonValue> => {
      if (action === CONVERSATION_MANAGEMENT_ACTION_IDS_V1.bindingResolve) {
        return (input as Readonly<{ kind?: unknown }>).kind === 'endpoint'
          ? { kind: 'endpointCandidates', candidates: [bindingEndpointCandidate] }
          : { kind: 'principalCandidates', candidates: [bindingPrincipalCandidate] };
      }
      if (action === 'session.list') {
        const cursor = (input as Readonly<{ cursor?: unknown }>).cursor;
        if (cursor === undefined) {
          return createSessionCandidatePageFixture({
            sessions: Array.from({ length: 100 }, (_unused, index) => ({
              id: `session-p1-${index}`,
              title: `Session 1-${index}`,
            })),
            nextCursor: 'session-page-2',
          });
        }
        if (cursor === 'session-page-2') {
          return createSessionCandidatePageFixture({
            sessions: Array.from({ length: 100 }, (_unused, index) => ({
              id: `session-p2-${index}`,
              title: `Session 2-${index}`,
            })),
            nextCursor: null,
          });
        }
        return createSessionCandidatePageFixture({ sessions: [], nextCursor: null });
      }
      if (action === 'automation.conversation.targets.list') {
        const cursor = (input as Readonly<{ cursor?: unknown }>).cursor;
        if (cursor === undefined) {
          return {
            items: Array.from({ length: 100 }, (_unused, index) => pageAutomation(1, index)),
            nextCursor: 'page-1',
          };
        }
        if (cursor === 'page-1') {
          return {
            items: Array.from({ length: 100 }, (_unused, index) => pageAutomation(2, index)),
            nextCursor: null,
          };
        }
        return { items: [], nextCursor: null };
      }
      throw new Error(`Unexpected mounted Action: ${String(action)}`);
    });
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'fixture-instance-96', mountNonce: 'fixture-mount-96' },
      authorPlugin: { id: 'happier.channels', version: '0.0.0' },
      surface: renderSurface,
      surfaceContext: createChannelsSurfaceContext(),
      adapter: createChannelsSemanticAdapter(),
      handlers: {
        selectActionInput: async () => ({ kind: 'cancelled' as const }),
        executeAction,
        readResource: bindingResourceReader(),
      },
    });

    try {
      await openBindingEndpointSelection(fixture);
      await selectPrincipalAndOpenTarget(fixture);
      await vi.waitFor(() => {
        expect(executeAction).toHaveBeenCalledWith(expect.objectContaining({
          action: 'session.list',
          input: { view: 'awareness', limit: 100 },
        }));
      });
      await fixture.press(await fixture.getByRole('button', { name: 'Show more Sessions' }));
      await vi.waitFor(() => {
        expect(executeAction).toHaveBeenCalledWith(expect.objectContaining({
          action: 'session.list',
          input: { view: 'awareness', limit: 100, cursor: 'session-page-2' },
        }));
      });
      await enterTextByTestId('channels-binding-target-search', 'Session 2-99');
      await expect(fixture.getByRole('button', { name: 'Session 2-99' })).resolves.toBeDefined();
      await enterTextByTestId('channels-binding-target-search', '');
      await fixture.press(await fixture.getByRole('button', { name: 'Show Workflows' }));
      await vi.waitFor(() => {
        expect(executeAction).toHaveBeenCalledWith(expect.objectContaining({
          action: 'automation.conversation.targets.list',
          input: { limit: 100 },
        }));
      });
      await fixture.press(await fixture.getByRole('button', { name: 'Show more Workflows' }));
      await vi.waitFor(() => {
        expect(executeAction).toHaveBeenCalledWith(expect.objectContaining({
          action: 'automation.conversation.targets.list',
          input: { limit: 100, cursor: 'page-1' },
        }));
      });

      await enterTextByTestId('channels-binding-target-search', 'Report 2-99');
      await expect(fixture.getByRole('button', { name: 'Report 2-99' })).resolves.toBeDefined();

      // Every accumulated candidate stays reachable through the one virtualized
      // target owner, but the mounted row tree stays bounded instead of growing
      // one static row per candidate across pages.
      const mountedTargetRows = document.querySelectorAll(
        '[data-testid^="channels-binding-target-session:"], [data-testid^="channels-binding-target-automation:"]',
      );
      expect(mountedTargetRows.length).toBeGreaterThan(0);
      expect(mountedTargetRows.length).toBeLessThan(100);
    } finally {
      await fixture.dispose();
    }
  });

  it('keeps the selected Automation result delivery through an editor retarget', async () => {
    const initialBinding = {
      v: 1,
      id: 'binding-1',
      connectionId: 'connection-1',
      endpoint: {
        kind: 'shared' as const,
        audience: 'shared' as const,
        id: 'provider-private-room-9',
        label: 'Private project room',
      },
      target: {
        kind: 'automation' as const,
        automationId: 'automation-1',
        policy: { resultDelivery: 'none' as const },
      },
      allowedPrincipalIds: ['provider-principal-private-4'],
      allowBotSenders: false,
      inputMode: 'directMentionsOnly' as const,
      inboundDebounceMs: 0,
      linkPreviewPolicy: 'suppress' as const,
      senderFeedback: 'off' as const,
      authorityEpoch: 4,
      enabled: true,
      deletionState: 'none' as const,
      createdAt: 1,
      updatedAt: 1,
    };
    const savedBinding = {
      ...initialBinding,
      target: {
        kind: 'automation' as const,
        automationId: 'automation-2',
        policy: { resultDelivery: 'finalResult' as const },
      },
      updatedAt: 2,
    };
    let bindingReadCount = 0;
    const updateInputs: unknown[] = [];
    const executeAction = vi.fn(async ({ action, input }: PluginUiTestkitExecuteActionInput): Promise<JsonValue> => {
      if (action === CONVERSATION_MANAGEMENT_ACTION_IDS_V1.bindingRead) {
        bindingReadCount += 1;
        return bindingReadCount === 1
          ? { kind: 'ready', revision: 1, binding: initialBinding }
          : { kind: 'ready', revision: 2, binding: savedBinding };
      }
      if (action === 'session.list') {
        return createSessionCandidatePageFixture({ sessions: [{ id: 'session-1', title: 'Project review' }], nextCursor: null });
      }
      if (action === 'automation.conversation.targets.list') {
        return {
          items: [{
            automationId: 'automation-2',
            label: 'Build report',
            execution: { targetType: 'existing_session', enabled: true },
          }],
          nextCursor: null,
        };
      }
      if (action === CONVERSATION_MANAGEMENT_ACTION_IDS_V1.bindingUpdate) {
        updateInputs.push(input);
        return { kind: 'updated', bindingId: 'binding-1', revision: 2, authorityEpoch: 4 };
      }
      throw new Error(`Unexpected mounted Action: ${String(action)}`);
    });
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'fixture-instance-97', mountNonce: 'fixture-mount-97' },
      authorPlugin: { id: 'happier.channels', version: '0.0.0' },
      surface: renderSurface,
      surfaceContext: createChannelsPageSurfaceContext(),
      subPath: 'binding-1',
      adapter: createChannelsSemanticAdapter(),
      handlers: {
        selectActionInput: async () => ({ kind: 'cancelled' as const }),
        executeAction,
        readResource: bindingResourceReader(),
      },
    });

    try {
      await expect(fixture.getByRole('button', { name: 'Pause' })).resolves.toBeDefined();
      await fixture.press(await fixture.getByRole('button', { name: 'Edit binding' }));
      await expect(fixture.getByRole('heading', { name: 'Edit conversation' })).resolves.toBeDefined();
      // Editing is a focused state of the page: the bot and the stop operations leave while it lasts.
      await expect(fixture.queryByRole('button', { name: 'Pause' })).resolves.toBeUndefined();
      await expect(fixture.queryByRole('button', { name: 'Manage bot' })).resolves.toBeUndefined();
      await expect(fixture.getByRole('radio', {
        name: 'No external result',
        state: { checked: true },
      })).resolves.toBeDefined();
      await fixture.press(await fixture.getByRole('radio', {
        name: 'Final result',
        state: { checked: false },
      }));
      await fixture.press(await fixture.getByRole('button', { name: 'Change target' }));
      await vi.waitFor(() => {
        expect(executeAction).toHaveBeenCalledWith(expect.objectContaining({
          action: 'session.list',
          input: { view: 'awareness', limit: 100 },
        }));
      });
      await fixture.press(await fixture.getByRole('button', { name: 'Show Workflows' }));
      await fixture.press(await fixture.getByRole('button', { name: 'Build report' }));
      await expect(fixture.getByRole('radio', {
        name: 'Final result',
        state: { checked: true },
      })).resolves.toBeDefined();
      await fixture.press(await fixture.getByRole('button', { name: 'Review changes' }));
      await fixture.press(await fixture.getByRole('button', { name: 'Save binding' }));

      await vi.waitFor(() => {
        expect(updateInputs).toEqual([expect.objectContaining({
          bindingId: 'binding-1',
          expectedRevision: 1,
          target: {
            kind: 'automation',
            automationId: 'automation-2',
            policy: { resultDelivery: 'finalResult' },
          },
        })]);
      });
      expect(executeAction.mock.calls.map(([request]) => request.action)).not.toContain(
        'automation.conversation.target.verify',
      );
      expect(executeAction.mock.calls.map(([request]) => request.action)).not.toContain(
        'binding/target-rotate-v1',
      );
    } finally {
      await fixture.dispose();
    }
  });

  it('retargets a direct binding onto a Session with the audience-derived delivery default', async () => {
    // Retargeting an Automation binding onto a Session has to name a delivery
    // mode before the owner has chosen one. A direct conversation asks for the
    // mirrored Session; the shared-room paths in this file keep proving the
    // opposite default, so a constant here fails one of the two.
    const initialBinding = {
      v: 1,
      id: 'binding-1',
      connectionId: 'connection-1',
      endpoint: {
        kind: 'direct' as const,
        audience: 'direct' as const,
        id: 'provider-direct-ada',
        label: 'Ada direct',
      },
      target: {
        kind: 'automation' as const,
        automationId: 'automation-1',
        policy: { resultDelivery: 'none' as const },
      },
      allowedPrincipalIds: ['provider-principal-private-4'],
      allowBotSenders: false,
      inputMode: 'allAllowedMessages' as const,
      inboundDebounceMs: 0,
      linkPreviewPolicy: 'suppress' as const,
      senderFeedback: 'off' as const,
      authorityEpoch: 4,
      enabled: true,
      deletionState: 'none' as const,
      createdAt: 1,
      updatedAt: 1,
    };
    const savedBinding = {
      ...initialBinding,
      target: {
        kind: 'session' as const,
        sessionId: 'session-1',
        policy: {
          deliveryMode: 'mirrorSession' as const,
          permissionCeiling: 'read-only',
          approvals: { kind: 'off' as const },
          newSession: { kind: 'off' as const },
        },
      },
      updatedAt: 2,
    };
    let bindingReadCount = 0;
    const updateInputs: unknown[] = [];
    const executeAction = vi.fn(async ({ action, input }: PluginUiTestkitExecuteActionInput): Promise<JsonValue> => {
      if (action === CONVERSATION_MANAGEMENT_ACTION_IDS_V1.bindingRead) {
        bindingReadCount += 1;
        return bindingReadCount === 1
          ? { kind: 'ready', revision: 1, binding: initialBinding }
          : { kind: 'ready', revision: 2, binding: savedBinding };
      }
      if (action === 'session.list') {
        return createSessionCandidatePageFixture({ sessions: [{ id: 'session-1', title: 'Project review' }], nextCursor: null });
      }
      if (action === CONVERSATION_MANAGEMENT_ACTION_IDS_V1.bindingUpdate) {
        updateInputs.push(input);
        return { kind: 'updated', bindingId: 'binding-1', revision: 2, authorityEpoch: 4 };
      }
      throw new Error(`Unexpected mounted Action: ${String(action)}`);
    });
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'fixture-instance-98', mountNonce: 'fixture-mount-98' },
      authorPlugin: { id: 'happier.channels', version: '0.0.0' },
      surface: renderSurface,
      surfaceContext: createChannelsPageSurfaceContext(),
      subPath: 'binding-1',
      adapter: createChannelsSemanticAdapter(),
      handlers: {
        selectActionInput: async () => ({ kind: 'cancelled' as const }),
        executeAction,
        readResource: bindingResourceReader(),
      },
    });

    try {
      await fixture.press(await fixture.getByRole('button', { name: 'Edit binding' }));
      await expect(fixture.getByRole('heading', { name: 'Edit conversation' })).resolves.toBeDefined();
      await fixture.press(await fixture.getByRole('button', { name: 'Change target' }));
      await vi.waitFor(() => {
        expect(executeAction).toHaveBeenCalledWith(expect.objectContaining({
          action: 'session.list',
        }));
      });
      await fixture.press(await fixture.getByRole('button', { name: 'Project review' }));
      await fixture.press(await fixture.getByRole('button', { name: 'Review changes' }));
      await fixture.press(await fixture.getByRole('button', { name: 'Save binding' }));

      await vi.waitFor(() => {
        expect(updateInputs).toEqual([expect.objectContaining({
          bindingId: 'binding-1',
          expectedRevision: 1,
          target: {
            kind: 'session',
            sessionId: 'session-1',
            policy: {
              deliveryMode: 'mirrorSession',
              permissionCeiling: 'read-only',
              approvals: { kind: 'off' },
              newSession: { kind: 'off' },
            },
          },
        })]);
      });
    } finally {
      await fixture.dispose();
    }
  });

  it('locks an unknown create outcome until an authoritative bindings Resource reread makes a new decision possible', async () => {
    let bindingsReadCount = 0;
    let resolveBindingsRefresh: ((value: ResourceContent) => void) | undefined;
    const executeAction = vi.fn(async ({ action, input }: PluginUiTestkitExecuteActionInput): Promise<JsonValue> => {
      if (action === CONVERSATION_MANAGEMENT_ACTION_IDS_V1.bindingResolve) {
        return (input as Readonly<{ kind?: unknown }>).kind === 'endpoint'
          ? { kind: 'endpointCandidates', candidates: [bindingEndpointCandidate] }
          : { kind: 'principalCandidates', candidates: [bindingPrincipalCandidate] };
      }
      if (action === 'session.list') {
        return createSessionCandidatePageFixture({ sessions: [{ id: 'session-1', title: 'Project review' }], nextCursor: null });
      }
      if (action === CONVERSATION_MANAGEMENT_ACTION_IDS_V1.bindingCreate) {
        throw new PluginError({ code: 'timeout', message: 'The binding create request timed out.' });
      }
      throw new Error(`Unexpected mounted Action: ${String(action)}`);
    });
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'fixture-instance-99', mountNonce: 'fixture-mount-99' },
      authorPlugin: { id: 'happier.channels', version: '0.0.0' },
      surface: renderSurface,
      surfaceContext: createChannelsSurfaceContext(),
      adapter: createChannelsSemanticAdapter(),
      handlers: {
        selectActionInput: async () => ({ kind: 'cancelled' as const }),
        executeAction,
        readResource: bindingResourceReader(async () => {
          bindingsReadCount += 1;
          if (bindingsReadCount === 1) return bindingsResource;
          return await new Promise<ResourceContent>((resolve) => {
            resolveBindingsRefresh = resolve;
          });
        }),
      },
    });

    try {
      await openBindingEndpointSelection(fixture);
      await selectPrincipalAndOpenTarget(fixture);
      await fixture.press(await fixture.getByRole('button', { name: 'Project review' }));
      await fixture.press(await fixture.getByRole('button', { name: 'Review binding' }));
      await fixture.press(await fixture.getByRole('button', { name: 'Link conversation' }));

      await expect(fixture.getByText('Could not confirm binding creation')).resolves.toBeDefined();
      // The open journey carries the lock: its confirm stays disabled and no second opener appears.
      await expect(fixture.findByRole('button', {
        name: 'Link conversation',
        state: { disabled: true },
      })).resolves.toBeDefined();
      expect(executeAction.mock.calls.filter(([request]) => (
        request.action === CONVERSATION_MANAGEMENT_ACTION_IDS_V1.bindingCreate
      ))).toHaveLength(1);

      await pressByTestId('channels-binding-create-outcome-unknown-refresh');
      await vi.waitFor(() => {
        expect(bindingsReadCount).toBe(2);
        expect(resolveBindingsRefresh).toBeTypeOf('function');
      });
      // The open journey carries the lock: its confirm stays disabled and no second opener appears.
      await expect(fixture.findByRole('button', {
        name: 'Link conversation',
        state: { disabled: true },
      })).resolves.toBeDefined();

      await act(async () => {
        resolveBindingsRefresh?.(bindingsResource);
      });
      await vi.waitFor(async () => {
        const addBinding = await fixture.getByRole('button', { name: 'Add binding' });
        expect(addBinding.state?.disabled).not.toBe(true);
      });
      await expect(fixture.queryByText('Review binding')).resolves.toBeUndefined();
      expect(executeAction.mock.calls.filter(([request]) => (
        request.action === CONVERSATION_MANAGEMENT_ACTION_IDS_V1.bindingCreate
      ))).toHaveLength(1);
    } finally {
      await fixture.dispose();
    }
  });
});

describe('Channels mounted binding editor', () => {
  it.each(['create', 'retarget'] as const)('selects a paged Discussion and confirms its exact replies-only target (%s)', async flow => {
    const discussion = {
      id: 'discussion-selected', ownerAccountId: 'account-owner', encryptionMode: 'plain',
      anchor: null, access: 'owner', keyReadiness: true, dataEncryptionKey: null, creationLocalId: null,
      title: 'Release decisions', latestMessage: {
        id: 'message-1', localId: null, seq: 1, authorAccountId: null, accountActor: null, producerV1: null, createdAt: 1,
      },
      messageSeq: 1, lastReadSeq: null, unreadCount: 0, unreadMentionCount: 0,
      recentAuthorAccountIds: [], archivedAt: null,
      capabilities: { postMessages: true, rename: true, archive: true, restore: false,
        askAgent: true, sendToSession: true, manageAccess: true, leave: false },
    } satisfies PluginActionResultById['discussion.list']['discussions'][number];
    const retained = offlineBindingRow();
    const mutationInputs: unknown[] = [];
    const executeAction = vi.fn(async ({ action, input }: PluginUiTestkitExecuteActionInput): Promise<JsonValue> => {
      if (action === CONVERSATION_MANAGEMENT_ACTION_IDS_V1.bindingRead) return {
        kind: 'ready', revision: 1, binding: {
          ...retained.value.payload, v: 1, id: 'binding-1', connectionId: 'connection-1',
          createdAt: retained.value['created-at'], updatedAt: retained.value['updated-at'],
        },
      };
      if (action === CONVERSATION_MANAGEMENT_ACTION_IDS_V1.bindingResolve) return (input as Readonly<{ kind?: unknown }>).kind === 'endpoint'
        ? { kind: 'endpointCandidates', candidates: [bindingEndpointCandidate] }
        : { kind: 'principalCandidates', candidates: [bindingPrincipalCandidate] };
      if (action === 'session.list') return createSessionCandidatePageFixture({ sessions: [], nextCursor: null });
      if (action === 'discussion.list') {
        const cursor = (input as Readonly<{ cursor?: string }>).cursor;
        expect(input).toEqual(cursor === undefined ? { state: 'active' } : { state: 'active', cursor: 'more-discussions' });
        return { v: 1, serverId: 'home', discussions: cursor === undefined ? [] : [discussion],
          nextCursor: cursor === undefined ? 'more-discussions' : null, incomplete: false };
      }
      if (action === CONVERSATION_MANAGEMENT_ACTION_IDS_V1.bindingCreate || action === CONVERSATION_MANAGEMENT_ACTION_IDS_V1.bindingUpdate) {
        mutationInputs.push(input);
        return { kind: action === CONVERSATION_MANAGEMENT_ACTION_IDS_V1.bindingCreate ? 'created' : 'updated',
          bindingId: 'binding-1', revision: 2, authorityEpoch: 4 };
      }
      throw new Error(`Unexpected Action ${String(action)}`);
    });
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: `discussion-selection-${flow}`, mountNonce: `discussion-selection-${flow}` },
      authorPlugin: { id: 'happier.channels', version: '0.0.0' }, surface: renderSurface,
      surfaceContext: flow === 'create' ? createChannelsSurfaceContext() : createChannelsPageSurfaceContext(),
      ...(flow === 'retarget' ? { subPath: 'binding-1/edit' } : {}),
      adapter: createChannelsSemanticAdapter(),
      handlers: { executeAction, readResource: bindingResourceReader() },
    });
    try {
      if (flow === 'create') {
        await openBindingEndpointSelection(fixture);
        await selectPrincipalAndOpenTarget(fixture);
      } else {
        await fixture.press(await fixture.getByRole('button', { name: 'Change target' }));
      }
      await fixture.press(await fixture.getByRole('button', { name: 'Show Discussions' }));
      await fixture.press(await fixture.findByRole('button', { name: 'Show more Discussions' }));
      await fixture.press(await fixture.findByRole('button', { name: 'Release decisions' }));
      await expect(fixture.queryByText('Workflow result delivery')).resolves.toBeUndefined();
      await fixture.press(await fixture.getByRole('button', { name: flow === 'create' ? 'Review binding' : 'Review changes' }));
      await expect(fixture.getByText('Replies only')).resolves.toBeDefined();
      await fixture.press(await fixture.getByRole('button', { name: flow === 'create' ? 'Link conversation' : 'Save binding' }));
      await vi.waitFor(() => expect(mutationInputs).toEqual([expect.objectContaining({ target: {
        kind: 'discussion', discussionId: 'discussion-selected', policy: { deliveryMode: 'repliesOnly' },
      } })]));
      expect(mutationInputs[0]).not.toHaveProperty('audienceSelection');
    } finally { await fixture.dispose(); }
  });

  it.each(['online', 'offline'] as const)('reads and saves a Discussion policy without changing its target or sender audience (%s)', async mode => {
    const account = createOfflineChannelStateFixture();
    const retained = offlineBindingRow();
    const target = { kind: 'discussion' as const, discussionId: 'discussion-1', policy: { deliveryMode: 'repliesOnly' as const } };
    account.collection.rows.set('binding-1', { ...retained, value: withChannelStateSessionIdentity({
      ...retained.value, payload: { ...retained.value.payload, target, enabled: true },
    }, target) });
    const detail = ConversationBindingReadResultV1Schema.parse({ kind: 'ready', revision: mode === 'online' ? 1 : retained.revision, binding: {
      ...retained.value.payload, target, enabled: true, v: 1, id: 'binding-1', connectionId: 'connection-1',
      createdAt: retained.value['created-at'], updatedAt: retained.value['updated-at'],
    } });
    const executeAction = vi.fn(async ({ action }: PluginUiTestkitExecuteActionInput): Promise<JsonValue> => {
      if (action === CONVERSATION_MANAGEMENT_ACTION_IDS_V1.bindingRead) return detail;
      if (action === CONVERSATION_MANAGEMENT_ACTION_IDS_V1.bindingUpdate) {
        return { kind: 'updated', bindingId: 'binding-1', revision: 2, authorityEpoch: 4 };
      }
      throw new Error(`Unexpected Action ${String(action)}`);
    });
    // Every offline policy write crosses host admission, including narrowing.
    // Its IPC settlement is the boundary; host policy tests own the decision.
    const admitAction = vi.fn(async () => true);
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: `discussion-editor-${mode}`, mountNonce: `discussion-editor-${mode}` },
      authorPlugin: { id: 'happier.channels', version: '0.0.0' }, surface: renderSurface,
      surfaceContext: createChannelsPageSurfaceContext(), subPath: 'binding-1/edit',
      adapter: createChannelsSemanticAdapter(mode === 'offline' ? account.dataClient : emptyDataClient),
      handlers: mode === 'online' ? { executeAction, readResource: bindingResourceReader() } : { admitAction },
    });
    try {
      // The offline page names this target in both its retained overview and
      // editor summary; the online editor has one exact-detail target label.
      if (mode === 'online') await expect(fixture.getByText('Discussion: discussion-1')).resolves.toBeDefined();
      await expect(fixture.queryByText('Workflow result delivery')).resolves.toBeUndefined();
      await expect(fixture.queryByText('Workflow target changes need your selected machine')).resolves.toBeUndefined();
      await fixture.press(await fixture.getByRole('switch', { name: 'Enable this binding' }));
      if (mode === 'online') await fixture.press(await fixture.getByRole('button', { name: 'Review changes' }));
      await fixture.press(await fixture.getByRole('button', { name: 'Save binding' }));
      if (mode === 'online') {
        await vi.waitFor(() => expect(executeAction).toHaveBeenCalledWith(expect.objectContaining({
          action: CONVERSATION_MANAGEMENT_ACTION_IDS_V1.bindingUpdate,
          input: expect.objectContaining({ bindingId: 'binding-1', enabled: false }),
        })));
        const update = executeAction.mock.calls.find(([request]) => request.action === CONVERSATION_MANAGEMENT_ACTION_IDS_V1.bindingUpdate)?.[0].input;
        expect(update).not.toHaveProperty('target');
        expect(update).not.toHaveProperty('audienceSelection');
      } else {
        await vi.waitFor(() => expect(account.collection.batches).toHaveLength(1));
        expect(admitAction).toHaveBeenCalledWith(expect.objectContaining({
          action: CONVERSATION_MANAGEMENT_ACTION_IDS_V1.bindingUpdate,
          input: expect.objectContaining({ bindingId: 'binding-1', expectedRevision: retained.revision, enabled: false }),
        }));
        expect(account.collection.rows.get('binding-1')?.value.payload).toEqual(expect.objectContaining({
          target, enabled: false, allowedPrincipalIds: retained.value.payload.allowedPrincipalIds,
        }));
        expect(executeAction).not.toHaveBeenCalled();
      }
    } finally { await fixture.dispose(); }
  });

  it('keeps automation-association results out of the binding editor', async () => {
    const executeAction = vi.fn(async ({ action, input }: PluginUiTestkitExecuteActionInput): Promise<JsonValue> => {
      if (action !== CONVERSATION_MANAGEMENT_ACTION_IDS_V1.bindingRead) {
        throw new Error(`Unexpected mounted Action: ${String(action)}`);
      }
      expect(input).toEqual({ bindingId: 'binding-1' });
      return { kind: 'automationAssociation', automationId: 'automation-1', association: 'bound' };
    });
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'fixture-binding-editor-association', mountNonce: 'fixture-binding-editor-association' },
      authorPlugin: { id: 'happier.channels', version: '0.0.0' },
      surface: renderSurface,
      surfaceContext: createChannelsPageSurfaceContext(),
      subPath: 'binding-1/edit',
      adapter: createChannelsSemanticAdapter(),
      handlers: {
        selectActionInput: async () => ({ kind: 'cancelled' as const }),
        executeAction,
        readResource: bindingResourceReader(),
      },
    });

    try {
      await expect(fixture.findByRole('status', {
        name: 'Binding detail is unavailable. Reload to read the current private binding policy before editing it.',
      })).resolves.toBeDefined();
      await expect(fixture.queryByRole('button', { name: 'Review changes' })).resolves.toBeUndefined();
      await expect(fixture.queryByRole('button', { name: 'Save binding' })).resolves.toBeUndefined();
    } finally {
      await fixture.dispose();
    }
  });

  it('reads exact private detail, keeps its draft out of the summary, and confirms only after the guarded update rereads', async () => {
    const privateBinding = {
      v: 1,
      id: 'binding-1',
      connectionId: 'connection-1',
      endpoint: {
        kind: 'shared' as const,
        audience: 'shared' as const,
        id: 'provider-private-room-9',
        label: 'Private project room',
      },
      target: {
        kind: 'session' as const,
        sessionId: 'session-private-7',
        policy: {
          deliveryMode: 'mirrorSession' as const,
          permissionCeiling: 'safe-yolo',
          approvals: { kind: 'off' as const },
          newSession: { kind: 'off' as const },
        },
      },
      allowedPrincipalIds: ['provider-principal-private-4'],
      allowBotSenders: true,
      inputMode: 'addressedMessages' as const,
      inboundDebounceMs: 1_250,
      linkPreviewPolicy: 'providerDefault' as const,
      senderFeedback: 'eligibleRefusals' as const,
      authorityEpoch: 4,
      enabled: true,
      deletionState: 'none' as const,
      createdAt: 1,
      updatedAt: 1,
    };
    let bindingReadCount = 0;
    let resolvePostSaveRead: ((value: JsonValue) => void) | undefined;
    const updateInputs: unknown[] = [];
    const executeAction = vi.fn(async ({ action, input }: PluginUiTestkitExecuteActionInput): Promise<JsonValue> => {
      if (action === CONVERSATION_MANAGEMENT_ACTION_IDS_V1.bindingRead) {
        expect(input).toEqual({ bindingId: 'binding-1' });
        bindingReadCount += 1;
        if (bindingReadCount === 1) {
          return { kind: 'ready', revision: 1, binding: privateBinding };
        }
        return await new Promise<JsonValue>((resolve) => {
          resolvePostSaveRead = resolve;
        });
      }
      if (action === CONVERSATION_MANAGEMENT_ACTION_IDS_V1.bindingUpdate) {
        updateInputs.push(input);
        return {
          kind: 'updated',
          bindingId: 'binding-1',
          revision: 2,
          authorityEpoch: 4,
        };
      }
      throw new Error(`Unexpected mounted Action: ${String(action)}`);
    });
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'fixture-instance-100', mountNonce: 'fixture-mount-100' },
      authorPlugin: { id: 'happier.channels', version: '0.0.0' },
      surface: renderSurface,
      surfaceContext: createChannelsPageSurfaceContext(),
      subPath: 'binding-1',
      adapter: createChannelsSemanticAdapter(),
      handlers: {
        selectActionInput: async () => ({ kind: 'cancelled' as const }),
        executeAction,
        readResource: bindingResourceReader(),
      },
    });

    try {
      expect(await fixture.queryByText('provider-principal-private-4')).toBeUndefined();

      await fixture.press(await fixture.getByRole('button', { name: 'Edit binding' }));
      await vi.waitFor(() => {
        expect(executeAction).toHaveBeenCalledWith(expect.objectContaining({
          action: CONVERSATION_MANAGEMENT_ACTION_IDS_V1.bindingRead,
          input: { bindingId: 'binding-1' },
        }));
      });
      await expect(fixture.getByRole('heading', { name: 'Edit conversation' })).resolves.toBeDefined();
      await expect(fixture.getByText('provider-principal-private-4')).resolves.toBeDefined();
      await expect(fixture.getByRole('switch', {
        name: 'Allow bot senders',
        state: { checked: true },
      })).resolves.toBeDefined();

      await fixture.press(await fixture.getByRole('button', { name: 'Review changes' }));
      await fixture.press(await fixture.getByRole('button', { name: 'Save binding' }));

      await vi.waitFor(() => {
        expect(executeAction).toHaveBeenCalledWith(expect.objectContaining({
          action: CONVERSATION_MANAGEMENT_ACTION_IDS_V1.bindingUpdate,
        }));
        expect(bindingReadCount).toBe(2);
        expect(resolvePostSaveRead).toBeTypeOf('function');
      });
      expect(updateInputs).toEqual([{
        bindingId: 'binding-1',
        expectedRevision: 1,
        allowBotSenders: true,
        inputMode: 'addressedMessages',
        inboundDebounceMs: 1_250,
        linkPreviewPolicy: 'providerDefault',
        senderFeedback: 'eligibleRefusals',
        enabled: true,
      }]);
      await expect(fixture.queryByText('Binding updated')).resolves.toBeUndefined();

      await act(async () => {
        resolvePostSaveRead?.({
          kind: 'ready',
          revision: 2,
          binding: { ...privateBinding, updatedAt: 2 },
        });
      });
      await expect(fixture.getByText('Binding updated')).resolves.toBeDefined();
      expect(executeAction.mock.calls.filter(([request]) => (
        request.action === CONVERSATION_MANAGEMENT_ACTION_IDS_V1.bindingUpdate
      ))).toHaveLength(1);
    } finally {
      await fixture.dispose();
    }
  });

  it('re-resolves arbitrary provider identities through the guarded editor update', async () => {
    const privateBinding = {
      v: 1,
      id: 'binding-1',
      connectionId: 'connection-1',
      endpoint: {
        kind: 'shared' as const,
        audience: 'shared' as const,
        id: 'provider-private-room-9',
        label: 'Private project room',
      },
      target: {
        kind: 'session' as const,
        sessionId: 'session-private-7',
        policy: {
          deliveryMode: 'repliesOnly' as const,
          permissionCeiling: 'read-only',
          approvals: { kind: 'off' as const },
          newSession: { kind: 'off' as const },
        },
      },
      allowedPrincipalIds: ['provider-principal-private-4'],
      allowBotSenders: false,
      inputMode: 'directMentionsOnly' as const,
      inboundDebounceMs: 0,
      linkPreviewPolicy: 'suppress' as const,
      senderFeedback: 'off' as const,
      authorityEpoch: 4,
      enabled: true,
      deletionState: 'none' as const,
      createdAt: 1,
      updatedAt: 1,
    };
    const foreignConnectionsResource = jsonResource({
      connections: [{
        connectionId: 'connection-1',
        revision: 1,
        authorityEpoch: 1,
        providerPluginId: 'com.example.alt-conversation-provider',
        selectedMachineId: 'machine-1',
        selectedTransport: 'checkpointedPull',
        integrationPrincipalLabel: 'Foreign integration',
        enabled: true,
        deletionState: 'none',
        attention: {
          historyGap: null,
          pollFailure: null,
          bestEffortBeforeDurableAdmission: false,
          oldTransportStopUnconfirmed: false,
          endpointRetargetOwed: false,
          acceptedPossibleLoss: false,
          outwardDelivery: {
            retryDue: false,
            notDelivered: false,
            partial: false,
            outcomeUnknown: false,
          },
        },
      }],
    }, 'e');
    const externalEndpoint = {
      kind: 'githubPullRequest' as const,
      audience: 'shared' as const,
      id: 'external-provider/fork#72',
      label: 'External pull request #72',
    };
    const externalPrincipal = {
      id: 'external-reviewer-7',
      kind: 'human' as const,
      label: 'External reviewer',
    };
    const updateInputs: unknown[] = [];
    let bindingReadCount = 0;
    const executeAction = vi.fn(async ({ action, input }: PluginUiTestkitExecuteActionInput): Promise<JsonValue> => {
      if (action === CONVERSATION_MANAGEMENT_ACTION_IDS_V1.bindingRead) {
        bindingReadCount += 1;
        return {
          kind: 'ready',
          revision: bindingReadCount === 1 ? 1 : 2,
          binding: { ...privateBinding, updatedAt: bindingReadCount },
        };
      }
      if (action === CONVERSATION_MANAGEMENT_ACTION_IDS_V1.bindingResolve) {
        return (input as Readonly<{ kind: unknown }>).kind === 'endpoint'
          ? { kind: 'endpointCandidates', candidates: [externalEndpoint] }
          : { kind: 'principalCandidates', candidates: (input as Readonly<{ query: string }>).query === 'another reviewer'
            ? [{ id: 'external-reviewer-8', kind: 'human', label: 'Another reviewer' }] : [externalPrincipal] };
      }
      if (action === CONVERSATION_MANAGEMENT_ACTION_IDS_V1.bindingUpdate) {
        updateInputs.push(input);
        return { kind: 'updated', bindingId: 'binding-1', revision: 2, authorityEpoch: 4 };
      }
      throw new Error(`Unexpected mounted Action: ${String(action)}`);
    });
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'fixture-instance-101', mountNonce: 'fixture-mount-101' },
      authorPlugin: { id: 'happier.channels', version: '0.0.0' },
      surface: renderSurface,
      surfaceContext: { ...createChannelsSurfaceContextWithForeignProvider(), mount: createChannelsPageSurfaceContext().mount, target: { kind: 'app' as const } },
      subPath: 'binding-1',
      adapter: createChannelsSemanticAdapter(),
      handlers: {
        selectActionInput: async () => ({ kind: 'cancelled' as const }),
        executeAction,
        readResource: async ({ resource }) => {
          const localId = resourceFixtureLocalId(resource);
          if (localId === BINDINGS_RESOURCE.localId) return bindingsResource;
          if (localId === CONNECTIONS_RESOURCE.localId) return foreignConnectionsResource;
          throw new Error(`Unexpected Resource: ${localId}`);
        },
      },
    });

    try {
      await fixture.press(await fixture.getByRole('button', { name: 'Edit binding' }));
      await expect(fixture.getByRole('heading', { name: 'Edit conversation' })).resolves.toBeDefined();
      await fixture.press(await fixture.getByRole('button', {
        name: 'Re-resolve conversation and allowed senders',
      }));
      await enterTextByAccessibleLabel('Conversation search', 'fork pull request');
      await fixture.press(await fixture.getByRole('button', { name: 'Search endpoints' }));
      await fixture.press(await fixture.getByRole('button', { name: externalEndpoint.label }));
      await fixture.press(await fixture.getByRole('button', { name: 'Back' }));
      expect(Array.from(document.querySelectorAll<HTMLInputElement>('input')).find((candidate) => (
        candidate.getAttribute('aria-label') === 'Conversation search'
      ))?.value).toBe('fork pull request');
      await fixture.press(await fixture.getByRole('button', { name: externalEndpoint.label }));
      await enterTextByAccessibleLabel('People search', 'reviewer');
      await fixture.press(await fixture.getByRole('button', { name: 'Search people' }));
      await fixture.press(await fixture.getByRole('checkbox', {
        name: `${externalPrincipal.label}: ${externalPrincipal.id}`,
        state: { checked: false },
      }));
      await enterTextByAccessibleLabel('People search', 'another reviewer');
      await fixture.press(await fixture.getByRole('button', { name: 'Search people' }));
      await fixture.press(await fixture.getByRole('checkbox', { name: 'Another reviewer: external-reviewer-8', state: { checked: false } }));
      await fixture.press(await fixture.getByRole('button', {
        name: 'Use selected conversation and senders',
      }));
      await fixture.press(await fixture.getByRole('button', { name: 'Review changes' }));
      await fixture.press(await fixture.getByRole('button', { name: 'Save binding' }));

      await vi.waitFor(() => {
        expect(updateInputs).toEqual([{
          bindingId: 'binding-1',
          expectedRevision: 1,
          audienceSelection: {
            expectedConnectionRevision: 1,
            endpointSelection: {
              query: 'fork pull request',
              selected: {
                kind: 'githubPullRequest',
                audience: 'shared',
                id: 'external-provider/fork#72',
              },
            },
            principalSelection: {
              query: 'reviewer',
              selected: [{ id: 'external-reviewer-7', kind: 'human' }, { id: 'external-reviewer-8', kind: 'human', query: 'another reviewer' }],
            },
          },
          allowBotSenders: false,
          inputMode: 'directMentionsOnly',
          inboundDebounceMs: 0,
          linkPreviewPolicy: 'suppress',
          senderFeedback: 'off',
          enabled: true,
        }]);
      });
      await expect(fixture.getByText('Binding updated')).resolves.toBeDefined();
    } finally {
      await fixture.dispose();
    }
  });

  it('saves one complete endpoint, allowlist, target and policy change under the guarded CAS, refuses to confirm a stale result, and confirms only after the post-save reread', async () => {
    const privateBinding = {
      v: 1,
      id: 'binding-1',
      connectionId: 'connection-1',
      endpoint: {
        kind: 'shared' as const,
        audience: 'shared' as const,
        id: 'provider-private-room-9',
        label: 'Private project room',
      },
      target: {
        kind: 'session' as const,
        sessionId: 'session-private-7',
        policy: {
          deliveryMode: 'repliesOnly' as const,
          permissionCeiling: 'read-only',
          approvals: { kind: 'off' as const },
          newSession: { kind: 'off' as const },
        },
      },
      allowedPrincipalIds: ['provider-principal-private-4'],
      allowBotSenders: false,
      inputMode: 'directMentionsOnly' as const,
      inboundDebounceMs: 0,
      linkPreviewPolicy: 'suppress' as const,
      senderFeedback: 'off' as const,
      authorityEpoch: 4,
      enabled: true,
      deletionState: 'none' as const,
      createdAt: 1,
      updatedAt: 1,
    };
    const externalEndpoint = {
      kind: 'githubPullRequest' as const,
      audience: 'shared' as const,
      id: 'external-provider/fork#72',
      label: 'External pull request #72',
    };
    const externalPrincipal = {
      id: 'external-reviewer-7',
      kind: 'human' as const,
      label: 'External reviewer',
    };
    /**
     * Endpoint, allowlist, target and policy in ONE guarded write. Splitting
     * this into per-facet saves is what the mounted editor must never do: each
     * extra write would consume the CAS revision and make the next facet
     * conflict against the caller's own earlier write.
     */
    const completeUpdateInput = {
      bindingId: 'binding-1',
      expectedRevision: 1,
      target: {
        kind: 'session',
        sessionId: 'session-current-8',
        policy: {
          deliveryMode: 'mirrorSession',
          permissionCeiling: 'read-only',
          approvals: { kind: 'off' },
          newSession: { kind: 'off' },
        },
      },
      audienceSelection: {
        expectedConnectionRevision: 1,
        endpointSelection: {
          query: 'fork pull request',
          selected: {
            kind: 'githubPullRequest',
            audience: 'shared',
            id: 'external-provider/fork#72',
          },
        },
        principalSelection: {
          query: 'reviewer',
          selected: [{ id: 'external-reviewer-7', kind: 'human' }],
        },
      },
      allowBotSenders: false,
      inputMode: 'allAllowedMessages',
      inboundDebounceMs: 750,
      linkPreviewPolicy: 'providerDefault',
      senderFeedback: 'eligibleRefusals',
      enabled: true,
    };
    const updateInputs: unknown[] = [];
    let bindingReadCount = 0;
    let resolvePostSaveRead: ((value: JsonValue) => void) | undefined;
    const executeAction = vi.fn(async ({ action, input }: PluginUiTestkitExecuteActionInput): Promise<JsonValue> => {
      if (action === CONVERSATION_MANAGEMENT_ACTION_IDS_V1.bindingRead) {
        bindingReadCount += 1;
        if (bindingReadCount === 1) return { kind: 'ready', revision: 1, binding: privateBinding };
        return await new Promise<JsonValue>((resolve) => {
          resolvePostSaveRead = resolve;
        });
      }
      if (action === CONVERSATION_MANAGEMENT_ACTION_IDS_V1.bindingResolve) {
        return (input as Readonly<{ kind: unknown }>).kind === 'endpoint'
          ? { kind: 'endpointCandidates', candidates: [externalEndpoint] }
          : { kind: 'principalCandidates', candidates: [externalPrincipal] };
      }
      if (action === 'session.list') {
        return createSessionCandidatePageFixture({ sessions: [{ id: 'session-current-8', title: 'Current session' }], nextCursor: null });
      }
      if (action === CONVERSATION_MANAGEMENT_ACTION_IDS_V1.bindingUpdate) {
        updateInputs.push(input);
        return updateInputs.length === 1
          ? { kind: 'stale' }
          : { kind: 'updated', bindingId: 'binding-1', revision: 2, authorityEpoch: 4 };
      }
      throw new Error(`Unexpected mounted Action: ${String(action)}`);
    });
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'fixture-instance-102', mountNonce: 'fixture-mount-102' },
      authorPlugin: { id: 'happier.channels', version: '0.0.0' },
      surface: renderSurface,
      surfaceContext: createChannelsPageSurfaceContext(),
      subPath: 'binding-1',
      adapter: createChannelsSemanticAdapter(emptyDataClient, undefined, { overlays: true }),
      handlers: {
        selectActionInput: async () => ({ kind: 'cancelled' as const }),
        executeAction,
        readResource: bindingResourceReader(),
      },
    });

    const reresolveAudience = async (): Promise<void> => {
      await fixture.press(await fixture.getByRole('button', {
        name: 'Re-resolve conversation and allowed senders',
      }));
      await enterTextByAccessibleLabel('Conversation search', 'fork pull request');
      await fixture.press(await fixture.getByRole('button', { name: 'Search endpoints' }));
      await fixture.press(await fixture.getByRole('button', { name: externalEndpoint.label }));
      await enterTextByAccessibleLabel('People search', 'reviewer');
      await fixture.press(await fixture.getByRole('button', { name: 'Search people' }));
      await fixture.press(await fixture.getByRole('checkbox', {
        name: `${externalPrincipal.label}: ${externalPrincipal.id}`,
        state: { checked: false },
      }));
      await fixture.press(await fixture.getByRole('button', {
        name: 'Use selected conversation and senders',
      }));
    };

    try {
      await fixture.press(await fixture.getByRole('button', { name: 'Edit binding' }));
      await expect(fixture.getByRole('heading', { name: 'Edit conversation' })).resolves.toBeDefined();

      // Target first: re-resolving the audience afterwards must not discard it.
      await fixture.press(await fixture.getByRole('button', { name: 'Change target' }));
      await vi.waitFor(() => {
        expect(executeAction).toHaveBeenCalledWith(expect.objectContaining({
          action: 'session.list',
          input: { view: 'awareness', limit: 100 },
        }));
      });
      await fixture.press(await fixture.getByRole('button', { name: 'Current session' }));
      await reresolveAudience();
      await fixture.press(await fixture.getByRole('radio', {
        name: 'Mirror Session',
        state: { checked: false },
      }));
      await chooseFieldOption('Incoming messages', 'All allowed messages');
      // Seven durations are a field that opens the shared menu.
      await pressButtonWithAccessibleLabelFragment('Message grouping delay');
      const delayOption = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitemradio"]'))
        .find((candidate) => candidate.textContent?.includes('0.75 seconds'));
      expect(delayOption).toBeDefined();
      await act(async () => { delayOption?.click(); });
      await fixture.press(await fixture.getByRole('radio', {
        name: 'Provider default',
        state: { checked: false },
      }));
      await fixture.press(await fixture.getByRole('radio', {
        name: 'Eligible refusals',
        state: { checked: false },
      }));

      await fixture.press(await fixture.getByRole('button', { name: 'Review changes' }));
      await fixture.press(await fixture.getByRole('button', { name: 'Save binding' }));

      await vi.waitFor(() => {
        expect(updateInputs).toEqual([completeUpdateInput]);
      });
      // A stale resolver verdict is not a save: no reread, no confirmation, and
      // Save stays locked until the audience is resolved against current facts.
      await expect(fixture.getByText('The provider connection changed')).resolves.toBeDefined();
      expect(bindingReadCount).toBe(1);
      await expect(fixture.queryByText('Binding updated')).resolves.toBeUndefined();
      await expect(fixture.findByRole('button', {
        name: 'Save binding',
        state: { disabled: true },
      })).resolves.toBeDefined();

      await fixture.press(await fixture.getByRole('button', { name: 'Back' }));
      await reresolveAudience();
      await fixture.press(await fixture.getByRole('button', { name: 'Review changes' }));
      await fixture.press(await fixture.getByRole('button', { name: 'Save binding' }));

      // The second write repeats the SAME complete draft against the SAME
      // expected revision: the stale round trip retained every facet.
      await vi.waitFor(() => {
        expect(updateInputs).toEqual([completeUpdateInput, completeUpdateInput]);
        expect(bindingReadCount).toBe(2);
        expect(resolvePostSaveRead).toBeTypeOf('function');
      });
      await expect(fixture.queryByText('Binding updated')).resolves.toBeUndefined();

      await act(async () => {
        resolvePostSaveRead?.({
          kind: 'ready',
          revision: 2,
          binding: {
            ...privateBinding,
            endpoint: { ...externalEndpoint },
            target: {
              kind: 'session' as const,
              sessionId: 'session-current-8',
              policy: { ...privateBinding.target.policy, deliveryMode: 'mirrorSession' as const },
            },
            allowedPrincipalIds: [externalPrincipal.id],
            inputMode: 'allAllowedMessages' as const,
            inboundDebounceMs: 750,
            linkPreviewPolicy: 'providerDefault' as const,
            senderFeedback: 'eligibleRefusals' as const,
            updatedAt: 2,
          },
        });
      });
      await expect(fixture.getByText('Binding updated')).resolves.toBeDefined();
      expect(executeAction.mock.calls.filter(([request]) => (
        request.action === CONVERSATION_MANAGEMENT_ACTION_IDS_V1.bindingUpdate
      ))).toHaveLength(2);
    } finally {
      await fixture.dispose();
    }
  });

  it('persists an owner-enabled chat-approval policy from the binding editor', async () => {
    const approvalOffBinding = {
      v: 1,
      id: 'binding-1',
      connectionId: 'connection-1',
      endpoint: {
        kind: 'direct' as const,
        audience: 'direct' as const,
        id: 'private-direct-9',
        label: 'Private direct conversation',
      },
      target: {
        kind: 'session' as const,
        sessionId: 'session-private-7',
        policy: {
          deliveryMode: 'repliesOnly' as const,
          permissionCeiling: 'read-only',
          approvals: { kind: 'off' as const },
          newSession: { kind: 'off' as const },
        },
      },
      allowedPrincipalIds: ['provider-principal-private-4'],
      allowBotSenders: false,
      inputMode: 'directMentionsOnly' as const,
      inboundDebounceMs: 0,
      linkPreviewPolicy: 'suppress' as const,
      senderFeedback: 'off' as const,
      authorityEpoch: 4,
      enabled: true,
      deletionState: 'none' as const,
      createdAt: 1,
      updatedAt: 1,
    };
    const updateInputs: unknown[] = [];
    const executeAction = vi.fn(async ({ action, input }: PluginUiTestkitExecuteActionInput): Promise<JsonValue> => {
      if (action === CONVERSATION_MANAGEMENT_ACTION_IDS_V1.bindingRead) {
        return { kind: 'ready', revision: 1, binding: approvalOffBinding };
      }
      if (action === CONVERSATION_MANAGEMENT_ACTION_IDS_V1.bindingUpdate) {
        updateInputs.push(input);
        return { kind: 'updated', bindingId: 'binding-1', revision: 2, authorityEpoch: 5 };
      }
      throw new Error(`Unexpected mounted Action: ${String(action)}`);
    });
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'fixture-instance-103', mountNonce: 'fixture-mount-103' },
      authorPlugin: { id: 'happier.channels', version: '0.0.0' },
      surface: renderSurface,
      surfaceContext: createChannelsPageSurfaceContext(),
      subPath: 'binding-1',
      adapter: createChannelsSemanticAdapter(),
      handlers: {
        selectActionInput: async () => ({ kind: 'cancelled' as const }),
        executeAction,
        readResource: bindingResourceReader(),
      },
    });

    try {
      await fixture.press(await fixture.getByRole('button', { name: 'Edit binding' }));
      await expect(fixture.getByRole('heading', { name: 'Edit conversation' })).resolves.toBeDefined();

      // The scope selector only exists once the owner turns approvals on, so
      // its absence here proves the toggle is the control, not decoration.
      expect(await fixture.queryByRole('radio', { name: 'This Session' })).toBeUndefined();
      await fixture.press(await fixture.getByRole('switch', {
        name: 'Approvals',
        state: { checked: false },
      }));
      await fixture.press(await fixture.getByRole('radio', { name: 'This Session' }));
      await fixture.press(await fixture.getByRole('button', { name: 'Review changes' }));
      await expect(fixture.getByText('All admitted principals')).resolves.toBeDefined();
      // The confirmation boundary for a widening change states the execution
      // machine and the permission scope (delivery + ceiling) alongside the
      // destination and admitted principals.
      expect(document.body.textContent).toContain('machine-1');
      expect(document.body.textContent).toContain('Permission ceiling');
      expect(document.body.textContent).toContain('Session delivery');
      await fixture.press(await fixture.getByRole('button', { name: 'Save binding' }));

      await vi.waitFor(() => {
        expect(updateInputs).toEqual([expect.objectContaining({
          bindingId: 'binding-1',
          expectedRevision: 1,
          target: {
            kind: 'session',
            sessionId: 'session-private-7',
            policy: {
              deliveryMode: 'repliesOnly',
              permissionCeiling: 'read-only',
              approvals: { kind: 'enabled', maximumScope: 'session' },
              newSession: { kind: 'off' },
            },
          },
        })]);
      });
    } finally {
      await fixture.dispose();
    }
  });

  it('retains the owner-selected Session permission ceiling across a target change and authoritative reread', async () => {
    const initialBinding = {
      v: 1,
      id: 'binding-1',
      connectionId: 'connection-1',
      endpoint: {
        kind: 'direct' as const,
        audience: 'direct' as const,
        id: 'private-direct-9',
        label: 'Private direct conversation',
      },
      target: {
        kind: 'session' as const,
        sessionId: 'session-private-7',
        policy: {
          deliveryMode: 'mirrorSession' as const,
          permissionCeiling: 'safe-yolo',
          approvals: { kind: 'off' as const },
          newSession: { kind: 'off' as const },
        },
      },
      allowedPrincipalIds: ['provider-principal-private-4'],
      allowBotSenders: false,
      inputMode: 'directMentionsOnly' as const,
      inboundDebounceMs: 0,
      linkPreviewPolicy: 'suppress' as const,
      senderFeedback: 'off' as const,
      authorityEpoch: 4,
      enabled: true,
      deletionState: 'none' as const,
      createdAt: 1,
      updatedAt: 1,
    };
    const savedBinding = {
      ...initialBinding,
      target: {
        kind: 'session' as const,
        sessionId: 'session-current-8',
        policy: {
          deliveryMode: 'mirrorSession' as const,
          permissionCeiling: 'safe-yolo',
          approvals: { kind: 'off' as const },
          newSession: { kind: 'off' as const },
        },
      },
      updatedAt: 2,
    };
    let bindingReadCount = 0;
    const updateInputs: unknown[] = [];
    const executeAction = vi.fn(async ({ action, input }: PluginUiTestkitExecuteActionInput): Promise<JsonValue> => {
      if (action === CONVERSATION_MANAGEMENT_ACTION_IDS_V1.bindingRead) {
        bindingReadCount += 1;
        return bindingReadCount === 1
          ? { kind: 'ready', revision: 1, binding: initialBinding }
          : { kind: 'ready', revision: 2, binding: savedBinding };
      }
      if (action === 'session.list') {
        return createSessionCandidatePageFixture({ sessions: [{ id: 'session-current-8', title: 'Current session' }], nextCursor: null });
      }
      if (action === CONVERSATION_MANAGEMENT_ACTION_IDS_V1.bindingUpdate) {
        updateInputs.push(input);
        return { kind: 'updated', bindingId: 'binding-1', revision: 2, authorityEpoch: 5 };
      }
      throw new Error(`Unexpected mounted Action: ${String(action)}`);
    });
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'fixture-instance-104', mountNonce: 'fixture-mount-104' },
      authorPlugin: { id: 'happier.channels', version: '0.0.0' },
      surface: renderSurface,
      surfaceContext: createChannelsPageSurfaceContext(),
      subPath: 'binding-1',
      adapter: createChannelsSemanticAdapter(),
      handlers: {
        selectActionInput: async () => ({ kind: 'cancelled' as const }),
        executeAction,
        readResource: bindingResourceReader(),
      },
    });

    try {
      await fixture.press(await fixture.getByRole('button', { name: 'Edit binding' }));
      await expect(fixture.getByRole('heading', { name: 'Edit conversation' })).resolves.toBeDefined();
      await fixture.press(await fixture.getByRole('button', { name: 'Change target' }));
      await fixture.press(await fixture.getByRole('button', { name: 'Current session' }));
      await fixture.press(await fixture.getByRole('button', { name: 'Review changes' }));
      await fixture.press(await fixture.getByRole('button', { name: 'Save binding' }));

      await vi.waitFor(() => {
        expect(updateInputs).toEqual([expect.objectContaining({
          bindingId: 'binding-1',
          expectedRevision: 1,
          target: {
            kind: 'session',
            sessionId: 'session-current-8',
            policy: {
              deliveryMode: 'mirrorSession',
              permissionCeiling: 'safe-yolo',
              approvals: { kind: 'off' },
              newSession: { kind: 'off' },
            },
          },
        })]);
      });
      expect(bindingReadCount).toBeGreaterThan(1);
      expect(document.body.textContent).not.toContain('Saved policy was clamped');
    } finally {
      await fixture.dispose();
    }
  });

  it('shows collection_quota_incompatible from the guarded update without a capacity preflight', async () => {
    const privateBinding = {
      v: 1,
      id: 'binding-1',
      connectionId: 'connection-1',
      endpoint: {
        kind: 'direct' as const,
        audience: 'direct' as const,
        id: 'private-direct-9',
        label: 'Private direct conversation',
      },
      target: {
        kind: 'session' as const,
        sessionId: 'session-private-7',
        policy: {
          deliveryMode: 'repliesOnly' as const,
          permissionCeiling: 'read-only',
          approvals: { kind: 'off' as const },
          newSession: { kind: 'off' as const },
        },
      },
      allowedPrincipalIds: ['provider-principal-private-4'],
      allowBotSenders: false,
      inputMode: 'directMentionsOnly' as const,
      inboundDebounceMs: 0,
      linkPreviewPolicy: 'suppress' as const,
      senderFeedback: 'off' as const,
      authorityEpoch: 4,
      enabled: true,
      deletionState: 'none' as const,
      createdAt: 1,
      updatedAt: 1,
    };
    const executeAction = vi.fn(async ({ action }: PluginUiTestkitExecuteActionInput) => {
      if (action === CONVERSATION_MANAGEMENT_ACTION_IDS_V1.bindingRead) {
        return { kind: 'ready', revision: 1, binding: privateBinding };
      }
      if (action === CONVERSATION_MANAGEMENT_ACTION_IDS_V1.bindingUpdate) {
        throw new PluginError({
          code: 'collection_quota_incompatible',
          message: 'The Account collection quota is incompatible.',
        });
      }
      throw new Error(`Unexpected mounted Action: ${String(action)}`);
    });
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'fixture-instance-105', mountNonce: 'fixture-mount-105' },
      authorPlugin: { id: 'happier.channels', version: '0.0.0' },
      surface: renderSurface,
      surfaceContext: createChannelsPageSurfaceContext(),
      subPath: 'binding-1',
      adapter: createChannelsSemanticAdapter(),
      handlers: {
        selectActionInput: async () => ({ kind: 'cancelled' as const }),
        executeAction,
        readResource: bindingResourceReader(),
      },
    });

    try {
      await fixture.press(await fixture.getByRole('button', { name: 'Edit binding' }));
      await expect(fixture.getByRole('heading', { name: 'Edit conversation' })).resolves.toBeDefined();
      await fixture.press(await fixture.getByRole('button', { name: 'Review changes' }));
      await fixture.press(await fixture.getByRole('button', { name: 'Save binding' }));

      await expect(fixture.getByText(
        'The Account collection quota is incompatible. Ask an administrator to make the Account collection quota compatible, then reload this binding and try again.',
      )).resolves.toBeDefined();
      expect(document.body.textContent).not.toContain('collection_quota_incompatible');
      expect(executeAction.mock.calls.map(([request]) => request.action)).toEqual([
        CONVERSATION_MANAGEMENT_ACTION_IDS_V1.bindingRead,
        CONVERSATION_MANAGEMENT_ACTION_IDS_V1.bindingUpdate,
      ]);
    } finally {
      await fixture.dispose();
    }
  });

  it('retains an edited draft and locks Save until a stale binding summary and exact detail agree again', async () => {
    const privateBinding = {
      v: 1,
      id: 'binding-1',
      connectionId: 'connection-1',
      endpoint: {
        kind: 'direct' as const,
        audience: 'direct' as const,
        id: 'private-direct-9',
        label: 'Private direct conversation',
      },
      target: {
        kind: 'session' as const,
        sessionId: 'session-private-7',
        policy: {
          deliveryMode: 'repliesOnly' as const,
          permissionCeiling: 'read-only',
          approvals: { kind: 'off' as const },
          newSession: { kind: 'off' as const },
        },
      },
      allowedPrincipalIds: ['provider-principal-private-4'],
      allowBotSenders: false,
      inputMode: 'directMentionsOnly' as const,
      inboundDebounceMs: 0,
      linkPreviewPolicy: 'suppress' as const,
      senderFeedback: 'off' as const,
      authorityEpoch: 4,
      enabled: true,
      deletionState: 'none' as const,
      createdAt: 1,
      updatedAt: 1,
    };
    const updatedSummaryResource = jsonResource({
      bindings: [{
        bindingId: 'binding-1',
        revision: 2,
        connectionId: 'connection-1',
        endpoint: { audience: 'direct', label: 'Example conversation' },
        target: { kind: 'session', summary: 'Example session' },
        inputMode: 'directMentionsOnly',
        deliveryMode: 'repliesOnly',
        approval: { kind: 'off' },
        enabled: true,
        deletionState: 'none',
      }],
    }, 'd');
    let bindingsReadCount = 0;
    let bindingDetailReads = 0;
    const executeAction = vi.fn(async ({ action }: PluginUiTestkitExecuteActionInput) => {
      if (action !== CONVERSATION_MANAGEMENT_ACTION_IDS_V1.bindingRead) {
        throw new Error(`Unexpected mounted Action: ${String(action)}`);
      }
      bindingDetailReads += 1;
      return {
        kind: 'ready',
        revision: bindingDetailReads === 1 ? 1 : 2,
        binding: { ...privateBinding, updatedAt: bindingDetailReads },
      };
    });
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'fixture-instance-106', mountNonce: 'fixture-mount-106' },
      authorPlugin: { id: 'happier.channels', version: '0.0.0' },
      surface: renderSurface,
      surfaceContext: createChannelsPageSurfaceContext(),
      subPath: 'binding-1',
      adapter: createChannelsSemanticAdapter(),
      handlers: {
        selectActionInput: async () => ({ kind: 'cancelled' as const }),
        executeAction,
        readResource: bindingResourceReader(() => {
          bindingsReadCount += 1;
          return bindingsReadCount === 1 ? bindingsResource : updatedSummaryResource;
        }),
        // The bindings list is live: another client's change arrives through
        // the Resource watch, not a button on the page.
        watchResource: () => ({ digest: bindingsResource.digest }),
      },
    });

    try {
      await fixture.press(await fixture.getByRole('button', { name: 'Edit binding' }));
      await expect(fixture.getByRole('heading', { name: 'Edit conversation' })).resolves.toBeDefined();
      await fixture.press(await fixture.getByRole('switch', {
        name: 'Enable this binding',
        state: { checked: true },
      }));
      await act(async () => {
        fixture.invalidateResource(BINDINGS_RESOURCE, updatedSummaryResource.digest);
      });
      await vi.waitFor(() => { expect(bindingsReadCount).toBeGreaterThanOrEqual(2); });
      await expect(fixture.getByText('This binding changed while you were editing')).resolves.toBeDefined();
      await fixture.press(await fixture.getByRole('button', { name: 'Review changes' }));
      await expect(fixture.findByRole('button', {
        name: 'Save binding',
        state: { disabled: true },
      })).resolves.toBeDefined();

      await fixture.press(await fixture.getByRole('button', { name: 'Reload' }));
      await vi.waitFor(async () => {
        expect(bindingDetailReads).toBe(2);
        const saveBinding = await fixture.getByRole('button', { name: 'Save binding' });
        expect(saveBinding.state?.disabled).not.toBe(true);
      });
      await fixture.press(await fixture.getByRole('button', { name: 'Back' }));
      await expect(fixture.getByRole('switch', {
        name: 'Enable this binding',
        state: { checked: false },
      })).resolves.toBeDefined();
    } finally {
      await fixture.dispose();
    }
  });

  it('keeps an unknown update locked until both the binding summary and exact detail are reread', async () => {
    const privateBinding = {
      v: 1,
      id: 'binding-1',
      connectionId: 'connection-1',
      endpoint: {
        kind: 'direct' as const,
        audience: 'direct' as const,
        id: 'private-direct-9',
        label: 'Private direct conversation',
      },
      target: {
        kind: 'session' as const,
        sessionId: 'session-private-7',
        policy: {
          deliveryMode: 'repliesOnly' as const,
          permissionCeiling: 'read-only',
          approvals: { kind: 'off' as const },
          newSession: { kind: 'off' as const },
        },
      },
      allowedPrincipalIds: ['provider-principal-private-4'],
      allowBotSenders: false,
      inputMode: 'directMentionsOnly' as const,
      inboundDebounceMs: 0,
      linkPreviewPolicy: 'suppress' as const,
      senderFeedback: 'off' as const,
      authorityEpoch: 4,
      enabled: true,
      deletionState: 'none' as const,
      createdAt: 1,
      updatedAt: 1,
    };
    let bindingsReadCount = 0;
    let resolveBindingsRefresh: ((value: ResourceContent) => void) | undefined;
    let bindingDetailReads = 0;
    const executeAction = vi.fn(async ({ action }: PluginUiTestkitExecuteActionInput) => {
      if (action === CONVERSATION_MANAGEMENT_ACTION_IDS_V1.bindingRead) {
        bindingDetailReads += 1;
        return { kind: 'ready', revision: 1, binding: privateBinding };
      }
      if (action === CONVERSATION_MANAGEMENT_ACTION_IDS_V1.bindingUpdate) {
        throw new PluginError({ code: 'timeout', message: 'The binding update timed out.' });
      }
      throw new Error(`Unexpected mounted Action: ${String(action)}`);
    });
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'fixture-instance-107', mountNonce: 'fixture-mount-107' },
      authorPlugin: { id: 'happier.channels', version: '0.0.0' },
      surface: renderSurface,
      surfaceContext: createChannelsPageSurfaceContext(),
      subPath: 'binding-1',
      adapter: createChannelsSemanticAdapter(),
      handlers: {
        selectActionInput: async () => ({ kind: 'cancelled' as const }),
        executeAction,
        readResource: bindingResourceReader(async () => {
          bindingsReadCount += 1;
          if (bindingsReadCount === 1) return bindingsResource;
          return await new Promise<ResourceContent>((resolve) => {
            resolveBindingsRefresh = resolve;
          });
        }),
      },
    });

    try {
      await fixture.press(await fixture.getByRole('button', { name: 'Edit binding' }));
      await expect(fixture.getByRole('heading', { name: 'Edit conversation' })).resolves.toBeDefined();
      await fixture.press(await fixture.getByRole('button', { name: 'Review changes' }));
      await fixture.press(await fixture.getByRole('button', { name: 'Save binding' }));

      await expect(fixture.getByText('Could not confirm the binding update')).resolves.toBeDefined();
      await expect(fixture.findByRole('button', {
        name: 'Save binding',
        state: { disabled: true },
      })).resolves.toBeDefined();
      expect(bindingDetailReads).toBe(1);

      await fixture.press(await fixture.getByRole('button', { name: 'Reload' }));
      await vi.waitFor(() => {
        expect(bindingsReadCount).toBe(2);
        expect(resolveBindingsRefresh).toBeTypeOf('function');
      });
      expect(bindingDetailReads).toBe(1);

      await act(async () => {
        resolveBindingsRefresh?.(bindingsResource);
      });
      await vi.waitFor(async () => {
        expect(bindingDetailReads).toBe(2);
        const saveBinding = await fixture.getByRole('button', { name: 'Save binding' });
        expect(saveBinding.state?.disabled).not.toBe(true);
      });
      expect(executeAction.mock.calls.filter(([request]) => (
        request.action === CONVERSATION_MANAGEMENT_ACTION_IDS_V1.bindingUpdate
      ))).toHaveLength(1);
    } finally {
      await fixture.dispose();
    }
  });

  it('returns Cancel focus to Edit after keeping editor stage focus host-owned', async () => {
    const privateBinding = {
      v: 1,
      id: 'binding-1',
      connectionId: 'connection-1',
      endpoint: {
        kind: 'direct' as const,
        audience: 'direct' as const,
        id: 'private-direct-9',
        label: 'Private direct conversation',
      },
      target: {
        kind: 'session' as const,
        sessionId: 'session-private-7',
        policy: {
          deliveryMode: 'repliesOnly' as const,
          permissionCeiling: 'read-only',
          approvals: { kind: 'off' as const },
          newSession: { kind: 'off' as const },
        },
      },
      allowedPrincipalIds: ['provider-principal-private-4'],
      allowBotSenders: false,
      inputMode: 'directMentionsOnly' as const,
      inboundDebounceMs: 0,
      linkPreviewPolicy: 'suppress' as const,
      senderFeedback: 'off' as const,
      authorityEpoch: 4,
      enabled: true,
      deletionState: 'none' as const,
      createdAt: 1,
      updatedAt: 1,
    };
    const focusTarget = vi.fn((target: unknown): boolean => {
      const focus = (target as Readonly<{ focus?: () => void }> | null)?.focus;
      if (typeof focus !== 'function') return false;
      focus.call(target);
      return true;
    });
    const presentationHost = {
      focusTarget,
      renderMarkdown: () => null,
      renderCodeBlock: () => null,
      renderPopover: () => null,
      renderIcon: () => null,
    } satisfies PluginUiPresentationHost;
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'fixture-instance-108', mountNonce: 'fixture-mount-108' },
      authorPlugin: { id: 'happier.channels', version: '0.0.0' },
      surface: renderSurface,
      surfaceContext: createChannelsPageSurfaceContext(),
      subPath: 'binding-1',
      adapter: createChannelsSemanticAdapter(emptyDataClient, presentationHost),
      handlers: {
        selectActionInput: async () => ({ kind: 'cancelled' as const }),
        executeAction: async ({ action }) => {
          if (action === CONVERSATION_MANAGEMENT_ACTION_IDS_V1.bindingRead) {
            return { kind: 'ready', revision: 1, binding: privateBinding };
          }
          throw new Error(`Unexpected mounted Action: ${String(action)}`);
        },
        readResource: bindingResourceReader(),
      },
    });

    try {
      await fixture.press(await fixture.getByRole('button', { name: 'Edit binding' }));
      // The editing state announces itself by its page title.
      const heading = Array.from(document.querySelectorAll<HTMLElement>('[role="heading"]')).find((node) => (
        node.textContent === 'Edit conversation'
      ));
      expect(heading).toBeDefined();
      expect(document.activeElement).toBe(heading);

      await fixture.press(await fixture.getByRole('button', { name: 'Cancel' }));
      const opener = Array.from(document.querySelectorAll<HTMLElement>('[role="button"]')).find((node) => (
        node.getAttribute('aria-label') === 'Edit binding'
      ));
      expect(opener).toBeDefined();
      expect(document.activeElement).toBe(opener);
      expect(focusTarget).toHaveBeenCalledTimes(2);
    } finally {
      await fixture.dispose();
    }
  });
});

describe('Channels thread router conversation', () => {
  const routerBinding = {
    v: 1,
    id: 'router-1',
    connectionId: 'connection-1',
    endpoint: { kind: 'direct' as const, audience: 'direct' as const, id: 'wilson@batiplus.ch', label: 'wilson@batiplus.ch' },
    target: {
      kind: 'threadRouter' as const,
      principalGroups: [
        { id: 'sales', principalIds: ['anna@batiplus.ch', 'marc@batiplus.ch'] },
        { id: 'brief', principalIds: ['leeroy@batiplus.ch'] },
      ],
      routes: [
        {
          id: 'route-intake',
          when: { group: 'sales', forwarded: true as const },
          recipe: {
            agentTarget: { kind: 'agent', identity: { pluginId: 'happier.claude', localId: 'claude' } },
            directory: { kind: 'path', path: '/srv/wilson/intake' },
            unlistedTools: 'deny',
            allowedTools: ['mcp__wilson-intake__*'],
          },
          policy: {
            deliveryMode: 'repliesOnly' as const,
            permissionCeiling: 'read-only',
            approvals: { kind: 'off' as const },
            newSession: { kind: 'off' as const },
          },
        },
        {
          id: 'route-conversation',
          when: { group: 'any', forwarded: 'any' as const },
          recipe: {
            agentTarget: { kind: 'agent', identity: { pluginId: 'happier.claude', localId: 'claude' } },
            directory: { kind: 'path', path: '/srv/wilson/conversation' },
          },
          policy: {
            deliveryMode: 'repliesOnly' as const,
            permissionCeiling: 'read-only',
            approvals: { kind: 'off' as const },
            newSession: { kind: 'off' as const },
          },
        },
      ],
    },
    allowedPrincipalIds: ['anna@batiplus.ch', 'marc@batiplus.ch', 'leeroy@batiplus.ch'],
    allowBotSenders: false,
    inputMode: 'allAllowedMessages' as const,
    inboundDebounceMs: 0,
    linkPreviewPolicy: 'providerDefault' as const,
    senderFeedback: 'off' as const,
    authorityEpoch: 1,
    enabled: true,
    deletionState: 'none' as const,
    createdAt: 1,
    updatedAt: 1,
  };
  const routerBindingsResource = jsonResource({
    bindings: [{
      bindingId: 'router-1',
      revision: 1,
      connectionId: 'connection-1',
      endpoint: { audience: 'direct', label: 'wilson@batiplus.ch' },
      target: { kind: 'threadRouter', summary: 'threadRouter' },
      inputMode: 'allAllowedMessages',
      deliveryMode: 'none',
      approval: { kind: 'notApplicable' },
      enabled: true,
      deletionState: 'none',
    }, {
      bindingId: 'thread-1',
      parentBindingId: 'router-1',
      revision: 1,
      connectionId: 'connection-1',
      endpoint: { audience: 'shared', label: 'Devis chantier Lausanne' },
      target: { kind: 'session', summary: 'session-thread-1', sessionId: 'session-thread-1' },
      inputMode: 'allAllowedMessages',
      deliveryMode: 'repliesOnly',
      approval: { kind: 'off' },
      enabled: true,
      deletionState: 'none',
    }, {
      // A thread started before providers sent a label: its Session title names it.
      bindingId: 'thread-2',
      parentBindingId: 'router-1',
      revision: 1,
      connectionId: 'connection-1',
      endpoint: { audience: 'shared' },
      target: { kind: 'session', summary: 'session-thread-2', sessionId: 'session-thread-2' },
      inputMode: 'allAllowedMessages',
      deliveryMode: 'repliesOnly',
      approval: { kind: 'off' },
      enabled: true,
      deletionState: 'none',
    }],
  }, 'b');
  const routerThreadSessions: Readonly<Record<string, SessionStateV1>> = {
    'session-thread-2': {
      sessionId: 'session-thread-2', title: 'Rendez-vous showroom Morges',
      lifecycle: 'active', runtime: 'working', operational: 'working', pendingPermissions: [],
      workStatus: { state: 'action_required', bucket: 'needs_you', tone: 'attention', attentionType: 'decision', word: 'Needs you' },
    },
  };

  it('shows the routes and started threads, and saves a reordered route list through the guarded update', async () => {
    const readReply = ConversationBindingReadResultV1Schema.parse({
      kind: 'ready', revision: 1, binding: routerBinding,
    });
    // Each started thread's own detail names the person who wrote in.
    const threadReply = (id: string, sender: string) => ConversationBindingReadResultV1Schema.parse({
      kind: 'ready',
      revision: 1,
      binding: {
        ...routerBinding,
        id,
        endpoint: { kind: 'thread' as const, audience: 'shared' as const, id: `${id}@batiplus.ch` },
        target: { kind: 'session' as const, sessionId: `session-${id}`, policy: routerBinding.target.routes[0]!.policy },
        allowedPrincipalIds: [sender],
      },
    });
    const updateInputs: unknown[] = [];
    let readCount = 0;
    const executeAction = vi.fn(async ({ action, input }: PluginUiTestkitExecuteActionInput): Promise<JsonValue> => {
      if (action === CONVERSATION_MANAGEMENT_ACTION_IDS_V1.bindingRead) {
        const bindingId = (input as Readonly<{ bindingId: string }>).bindingId;
        if (bindingId === 'thread-1') return threadReply('thread-1', 'anna@batiplus.ch');
        if (bindingId === 'thread-2') return threadReply('thread-2', 'leeroy@batiplus.ch');
        expect(input).toEqual({ bindingId: 'router-1' });
        readCount += 1;
        return { ...readReply, revision: readCount > 2 ? 2 : 1 };
      }
      if (action === CONVERSATION_MANAGEMENT_ACTION_IDS_V1.bindingUpdate) {
        updateInputs.push(input);
        return { kind: 'updated', bindingId: 'router-1', revision: 2, authorityEpoch: 1 };
      }
      throw new Error(`Unexpected mounted Action: ${String(action)}`);
    });
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'fixture-router', mountNonce: 'fixture-router' },
      authorPlugin: { id: 'happier.channels', version: '0.0.0' },
      surface: renderSurface,
      surfaceContext: createChannelsPageSurfaceContext(),
      subPath: 'router-1',
      adapter: createChannelsSemanticAdapter(),
      handlers: {
        selectActionInput: async () => ({ kind: 'cancelled' as const }),
        executeAction,
        readResource: bindingResourceReader(() => routerBindingsResource),
        readSession: ({ sessionId }) => routerThreadSessions[sessionId] ?? null,
      },
    });

    try {
      await vi.waitFor(async () => {
        await expect(fixture.getByText('1. People in sales, forwarded mail')).resolves.toBeDefined();
      });
      // The recipe is read in the Session spawn shape, not as raw ids.
      expect(document.body.textContent).toContain('intake · Only 1 tool');
      expect(document.body.textContent).not.toContain('listed tools');
      await expect(fixture.getByText('Devis chantier Lausanne')).resolves.toBeDefined();
      // An unlabeled thread is named by its Session and shows its work state.
      await vi.waitFor(async () => {
        await expect(fixture.getByText('Rendez-vous showroom Morges')).resolves.toBeDefined();
      });
      await expect(fixture.getByText('Needs you')).resolves.toBeDefined();
      await expect(fixture.queryByText('External conversation')).resolves.toBeUndefined();
      await expect(fixture.queryByText('threadRouter')).resolves.toBeUndefined();
      // Threads tell apart by who wrote in and by which sender group; the
      // header says who can reach the router instead of "Only you".
      await vi.waitFor(async () => {
        await expect(fixture.getByText('anna@batiplus.ch · sales')).resolves.toBeDefined();
        await expect(fixture.getByText('leeroy@batiplus.ch · brief')).resolves.toBeDefined();
      });
      expect(document.body.textContent).toContain('Senders in sales and brief');
      expect(document.body.textContent).toContain('2 threads');
      expect(document.body.textContent).not.toContain('Only you');

      await fixture.press(await fixture.getByRole('button', { name: 'Edit binding' }));
      await expect(fixture.findByRole('heading', { name: 'Routes' })).resolves.toBeDefined();
      await fixture.press(await fixture.getByRole('button', { name: 'Move route 2 up' }));
      await fixture.press(await fixture.getByRole('button', { name: 'Review changes' }));
      await fixture.press(await fixture.getByRole('button', { name: 'Save binding' }));

      await vi.waitFor(() => {
        expect(updateInputs).toHaveLength(1);
      });
      const update = updateInputs[0] as Readonly<{ target?: typeof routerBinding.target }>;
      expect(update.target?.kind).toBe('threadRouter');
      expect(update.target?.routes.map((route) => route.id)).toEqual(['route-conversation', 'route-intake']);
      expect(update.target?.principalGroups).toEqual(routerBinding.target.principalGroups);
    } finally {
      await fixture.dispose();
    }
  });

  it('tells a failed private routes read apart from loading and an unreachable machine, and retries it (FIX-LIVE58)', async () => {
    const readReply = ConversationBindingReadResultV1Schema.parse({
      kind: 'ready', revision: 1, binding: routerBinding,
    });
    let routerReads = 0;
    const executeAction = vi.fn(async ({ action, input }: PluginUiTestkitExecuteActionInput): Promise<JsonValue> => {
      if (action === CONVERSATION_MANAGEMENT_ACTION_IDS_V1.bindingRead) {
        if ((input as Readonly<{ bindingId: string }>).bindingId !== 'router-1') return { kind: 'notFound' };
        routerReads += 1;
        if (routerReads === 1) throw new PluginError({ code: 'unavailable', message: 'The machine did not answer the read.' });
        return readReply;
      }
      throw new Error(`Unexpected mounted Action: ${String(action)}`);
    });
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'fixture-router-read-error', mountNonce: 'fixture-router-read-error' },
      authorPlugin: { id: 'happier.channels', version: '0.0.0' },
      surface: renderSurface,
      surfaceContext: createChannelsPageSurfaceContext(),
      subPath: 'router-1',
      adapter: createChannelsSemanticAdapter(),
      handlers: {
        selectActionInput: async () => ({ kind: 'cancelled' as const }),
        executeAction,
        readResource: bindingResourceReader(() => routerBindingsResource),
        readSession: ({ sessionId }) => routerThreadSessions[sessionId] ?? null,
      },
    });

    try {
      // A refused read is an error the reader can retry, not a machine that is away.
      await vi.waitFor(async () => {
        await expect(fixture.getByText('Couldn\u2019t read the routes')).resolves.toBeDefined();
      });
      expect(document.body.textContent).toContain('The machine did not answer the read.');
      expect(document.body.textContent).not.toContain('Routes are shown when your selected machine is reachable');
      expect(document.body.textContent).not.toContain('Reading routes');

      await fixture.press(await fixture.getByRole('button', { name: 'Retry' }));
      await vi.waitFor(async () => {
        await expect(fixture.getByText('1. People in sales, forwarded mail')).resolves.toBeDefined();
      });
      expect(routerReads).toBe(2);
      expect(document.body.textContent).not.toContain('Couldn\u2019t read the routes');
    } finally {
      await fixture.dispose();
    }
  });

  it('lists router threads latest first with the full subject, the reply time and the unread or Work state (CH-UI2 r2)', async () => {
    const replyAt = (hour: number) => new Date(2026, 9, 22, hour, 5).getTime();
    const fullSubject = 'Fwd: qa-live13-forwarded-attachment-check from Anna';
    const threadRow = (bindingId: string, label: string | undefined, sessionId: string) => ({
      bindingId,
      parentBindingId: 'router-1',
      revision: 1,
      connectionId: 'connection-1',
      endpoint: { audience: 'shared', ...(label === undefined ? {} : { label }) },
      // The summary is the bounded display projection; the exact Session id is its own field.
      target: { kind: 'session', summary: `${sessionId.slice(0, 27)}…`, sessionId },
      inputMode: 'allAllowedMessages',
      deliveryMode: 'repliesOnly',
      approval: { kind: 'off' },
      enabled: true,
      deletionState: 'none',
    });
    const longId = (name: string) => `${name}-0000-4000-8000-000000000000`;
    const resource = jsonResource({
      bindings: [
        { bindingId: 'router-1', revision: 1, connectionId: 'connection-1', endpoint: { audience: 'direct', label: 'wilson@batiplus.ch' },
          target: { kind: 'threadRouter', summary: 'threadRouter' }, inputMode: 'allAllowedMessages', deliveryMode: 'none',
          approval: { kind: 'notApplicable' }, enabled: true, deletionState: 'none' },
        threadRow('thread-old', 'Fwd: qa-live13-forwarded-at\u2026', longId('session-old')),
        threadRow('thread-new', 'Devis chantier Lausanne', longId('session-new')),
        threadRow('thread-working', 'Rendez-vous showroom Morges', longId('session-working')),
      ],
    }, 'c');
    const base = { lifecycle: 'active' as const, runtime: 'idle' as const, operational: 'none' as const, pendingPermissions: [] };
    const idle = { state: 'waiting', bucket: 'idle' as const, tone: 'neutral' as const, attentionType: null, word: 'Idle' };
    const sessions: Readonly<Record<string, SessionStateV1>> = {
      [longId('session-old')]: { ...base, sessionId: longId('session-old'), workStatus: idle, hasUnreadMessages: false,
        latestActivity: { kind: 'ready', text: 'Pièce jointe reçue', createdAt: replyAt(8) } },
      [longId('session-new')]: { ...base, sessionId: longId('session-new'), workStatus: idle, hasUnreadMessages: true,
        latestActivity: { kind: 'ready', text: 'Le devis est prêt', createdAt: replyAt(11) } },
      [longId('session-working')]: { ...base, sessionId: longId('session-working'), runtime: 'working', operational: 'working',
        workStatus: { state: 'thinking', bucket: 'working', tone: 'neutral', attentionType: null, word: 'Working' }, hasUnreadMessages: false,
        latestActivity: { kind: 'ready', text: 'Je regarde le planning', createdAt: replyAt(10) } },
    };
    const readReply = ConversationBindingReadResultV1Schema.parse({ kind: 'ready', revision: 1, binding: routerBinding });
    const executeAction = vi.fn(async ({ action, input }: PluginUiTestkitExecuteActionInput): Promise<JsonValue> => {
      if (action !== CONVERSATION_MANAGEMENT_ACTION_IDS_V1.bindingRead) throw new Error(`Unexpected mounted Action: ${String(action)}`);
      const bindingId = (input as Readonly<{ bindingId: string }>).bindingId;
      if (bindingId === 'router-1') return readReply;
      const label = bindingId === 'thread-old' ? fullSubject : bindingId === 'thread-new' ? 'Devis chantier Lausanne' : 'Rendez-vous showroom Morges';
      return ConversationBindingReadResultV1Schema.parse({
        kind: 'ready',
        revision: 1,
        binding: {
          ...routerBinding,
          id: bindingId,
          endpoint: { kind: 'thread' as const, audience: 'shared' as const, id: `${bindingId}@batiplus.ch`, label },
          target: { kind: 'session' as const, sessionId: longId(`session-${bindingId.slice('thread-'.length)}`), policy: routerBinding.target.routes[0]!.policy },
          allowedPrincipalIds: ['anna@batiplus.ch'],
        },
      });
    });
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'fixture-router-activity', mountNonce: 'fixture-router-activity' },
      authorPlugin: { id: 'happier.channels', version: '0.0.0' },
      surface: renderSurface,
      surfaceContext: createChannelsPageSurfaceContext(),
      subPath: 'router-1',
      adapter: createChannelsSemanticAdapter(),
      handlers: {
        selectActionInput: async () => ({ kind: 'cancelled' as const }),
        executeAction,
        readResource: bindingResourceReader(() => resource),
        readSession: ({ sessionId }) => sessions[sessionId] ?? null,
      },
    });
    const rowNames = async () => [
      ...await fixture.queryAllByRole('button'),
      ...await fixture.queryAllByRole('option'),
    ].map((target) => target.name ?? '');
    const rowNamed = async (subject: string) => (await rowNames()).find((name) => name.startsWith(subject)) ?? '';
    try {
      const locale = createChannelsPageSurfaceContext().locale;
      await vi.waitFor(async () => {
        // The full subject from the thread's own read, never the bounded summary.
        expect(document.body.textContent).toContain(fullSubject);
        expect(await rowNamed('Devis chantier Lausanne')).toContain(formatConversationTime(replyAt(11), locale));
        expect(await rowNamed(fullSubject)).toContain(formatConversationTime(replyAt(8), locale));
      });
      expect(await rowNamed('Devis chantier Lausanne')).toContain('Unread');
      expect(await rowNamed(fullSubject)).not.toContain('Unread');
      expect(await rowNamed('Rendez-vous showroom Morges')).toContain('Working');
      // Latest reply first: the order the person reads a mailbox in.
      const text = document.body.textContent ?? '';
      const at = (subject: string) => text.indexOf(subject);
      expect(at('Devis chantier Lausanne')).toBeGreaterThan(-1);
      expect(at('Devis chantier Lausanne')).toBeLessThan(at('Rendez-vous showroom Morges'));
      expect(at('Rendez-vous showroom Morges')).toBeLessThan(at(fullSubject));
    } finally {
      await fixture.dispose();
    }
  });

  it('reports a started conversation as queued until its custody says delivered, and pages reply sessions (REV-C-06/07)', async () => {
    const custodyId = 'e'.repeat(43);
    const readReply = ConversationBindingReadResultV1Schema.parse({
      kind: 'ready', revision: 1, binding: routerBinding,
    });
    const startInputs: unknown[] = [];
    const sessionListInputs: unknown[] = [];
    let deliveryOutcome: 'pending' | 'delivered' = 'pending';
    const executeAction = vi.fn(async ({ action, input }: PluginUiTestkitExecuteActionInput): Promise<JsonValue> => {
      if (action === CONVERSATION_MANAGEMENT_ACTION_IDS_V1.bindingRead) return readReply;
      if (action === 'session.list') {
        sessionListInputs.push(input);
        const cursor = (input as Readonly<{ cursor?: string }>).cursor;
        return createSessionCandidatePageFixture(cursor === undefined
          ? { sessions: [{ id: 'session-recent', title: 'Brief du matin' }], nextCursor: 'page-2' }
          : { sessions: [{ id: 'session-older', title: 'Wilson questions' }] });
      }
      if (action === CONVERSATION_MANAGEMENT_ACTION_IDS_V1.conversationStart) {
        startInputs.push(input);
        return { kind: 'accepted', custodyId };
      }
      if (action === CONVERSATION_MANAGEMENT_ACTION_IDS_V1.deliveryRead) {
        expect(input).toEqual({ custodyId });
        return {
          kind: 'ready',
          delivery: {
            custodyId, revision: 1, connectionId: 'connection-1', bindingId: 'router-1',
            state: deliveryOutcome === 'delivered' ? 'delivered' : 'ready',
            projection: { terminal: deliveryOutcome === 'delivered', attention: false },
            lastOutcome: deliveryOutcome,
          },
        };
      }
      throw new Error(`Unexpected mounted Action: ${String(action)}`);
    });
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'fixture-router-start', mountNonce: 'fixture-router-start' },
      authorPlugin: { id: 'happier.channels', version: '0.0.0' },
      surface: renderSurface,
      surfaceContext: createChannelsPageSurfaceContext(),
      subPath: 'router-1',
      adapter: createChannelsSemanticAdapter(),
      handlers: {
        selectActionInput: async () => ({ kind: 'cancelled' as const }),
        executeAction,
        readResource: bindingResourceReader(() => routerBindingsResource),
      },
    });

    try {
      await vi.waitFor(async () => {
        await expect(fixture.getByText('1. People in sales, forwarded mail')).resolves.toBeDefined();
      });
      await fixture.press(await fixture.getByRole('button', { name: 'Start a conversation' }));
      await vi.waitFor(() => {
        expect(document.querySelector('[data-testid="channels-router-start-sessions-more"]')).not.toBeNull();
      });
      await pressByTestId('channels-router-start-sessions-more');
      await vi.waitFor(() => {
        expect(sessionListInputs).toHaveLength(2);
      });
      expect(sessionListInputs[1]).toMatchObject({ cursor: 'page-2' });
      await vi.waitFor(() => {
        expect(document.querySelector('[data-testid="channels-router-start-sessions-more"]')).toBeNull();
      });

      await enterTextByAccessibleLabel('Subject', 'Brief du matin');
      const messageField = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]');
      expect(messageField).not.toBeNull();
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(messageField, 'Voici le brief.');
        messageField?.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await pressByTestId('channels-router-start-send');
      await vi.waitFor(() => {
        expect(startInputs).toHaveLength(1);
      });
      expect(startInputs[0]).toMatchObject({
        routerBindingId: 'router-1', audienceGroupId: 'sales', subject: 'Brief du matin',
        content: { text: 'Voici le brief.' }, sessionId: 'session-recent',
      });
      // Custody acceptance is not delivery.
      await vi.waitFor(async () => {
        await expect(fixture.getByText('Queued. It is sent as soon as the bot can reach the mailbox.')).resolves.toBeDefined();
      });
      await expect(fixture.queryByText('Sent. Replies come back to the session you chose.')).resolves.toBeUndefined();

      deliveryOutcome = 'delivered';
      await pressByTestId('channels-router-start-status-refresh');
      await vi.waitFor(async () => {
        await expect(fixture.getByText('Sent. Replies come back to the session you chose.')).resolves.toBeDefined();
      });
    } finally {
      await fixture.dispose();
    }
  });

  it('shows the typed custody refusal returned by the start Action', async () => {
    const message = 'The conversation start could not enter delivery custody. (invalidRow)';
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'fixture-router-start-refusal', mountNonce: 'fixture-router-start-refusal' },
      authorPlugin: { id: 'happier.channels', version: '0.0.0' }, surface: renderSurface,
      surfaceContext: createChannelsPageSurfaceContext(), subPath: 'router-1', adapter: createChannelsSemanticAdapter(),
      handlers: {
        executeAction: async ({ action }) => {
          if (action === CONVERSATION_MANAGEMENT_ACTION_IDS_V1.bindingRead) return ConversationBindingReadResultV1Schema.parse({ kind: 'ready', revision: 1, binding: routerBinding });
          if (action === 'session.list') return createSessionCandidatePageFixture({ sessions: [{ id: 'session-recent', title: 'Brief du matin' }] });
          if (action === CONVERSATION_MANAGEMENT_ACTION_IDS_V1.conversationStart) throw new PluginError({
            code: 'channels_conversation_start_invalid', message, details: { reason: 'invalidRow' },
          });
          throw new Error(`Unexpected mounted Action: ${String(action)}`);
        },
        readResource: bindingResourceReader(() => routerBindingsResource),
      },
    });
    try {
      await fixture.press(await fixture.findByRole('button', { name: 'Start a conversation' }));
      await enterTextByAccessibleLabel('Subject', 'Brief du matin');
      const field = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]');
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(field, 'Voici le brief.');
        field?.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await vi.waitFor(() => expect(document.querySelector<HTMLButtonElement>('[data-testid="channels-router-start-send"]')?.disabled).toBe(false));
      await pressByTestId('channels-router-start-send');
      await vi.waitFor(async () => { await expect(fixture.getByText(message)).resolves.toBeDefined(); });
      // A post-write decode failure cannot establish that no effect exists.
      await expect(fixture.getByText('It is not yet known whether the message was sent. Check the bot’s delivery attention before sending again.')).resolves.toBeDefined();
    } finally { await fixture.dispose(); }
  });

  it('seeds the current route recipe through the host selector and saves its strict edited settlement', async () => {
    type ServerStartDraft = Extract<SelectActionInputResult, { kind: 'serverStartDraft' }>['draft'];
    const recipe = {
      executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
      directory: { kind: 'path', path: '/srv/wilson/intake' },
      agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
      profileId: 'intake', allowedTools: ['mcp__wilson-intake__*'], unlistedTools: 'deny',
      organizationPlacement: { folderId: 'intake', tagIds: ['email'] },
      capabilitySelection: { mcp: { v: 1, managedServersEnabled: false,
        forceIncludeServerIds: ['wilson-intake'], forceExcludeServerIds: [] } },
    } satisfies ServerStartDraft;
    const editedRecipe = { ...recipe, directory: { kind: 'path', path: '/srv/edited' } } satisfies ServerStartDraft;
    const readReply = ConversationBindingReadResultV1Schema.parse({ kind: 'ready', revision: 1,
      binding: { ...routerBinding, target: { ...routerBinding.target,
        routes: [{ ...routerBinding.target.routes[0], recipe }] } } });
    const updateInputs: unknown[] = [];
    const selectActionInput = vi.fn(async (input: PluginUiTestkitSelectActionInputInput) => {
      expect(input.request).toEqual({
        hostAction: { action: 'session.spawn_new', projection: 'serverStartDraft' },
        draft: { existingDraft: recipe },
      });
      return { kind: 'serverStartDraft' as const, draft: editedRecipe };
    });
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'fixture-router-recipe', mountNonce: 'fixture-router-recipe' },
      authorPlugin: { id: 'happier.channels', version: '0.0.0' }, surface: renderSurface,
      surfaceContext: createChannelsPageSurfaceContext(), subPath: 'router-1', adapter: createChannelsSemanticAdapter(),
      handlers: {
        selectActionInput,
        executeAction: async ({ action, input }) => {
          if (action === CONVERSATION_MANAGEMENT_ACTION_IDS_V1.bindingRead) return readReply;
          if (action === CONVERSATION_MANAGEMENT_ACTION_IDS_V1.bindingUpdate) {
            updateInputs.push(input);
            return { kind: 'updated', bindingId: 'router-1', revision: 2, authorityEpoch: 1 };
          }
          throw new Error(`Unexpected mounted Action: ${String(action)}`);
        },
        readResource: bindingResourceReader(() => routerBindingsResource),
      },
    });
    try {
      await vi.waitFor(async () => {
        await expect(fixture.getByText('1. People in sales, forwarded mail')).resolves.toBeDefined();
      });
      await fixture.press(await fixture.getByRole('button', { name: 'Edit binding' }));
      await vi.waitFor(async () => {
        const choose = await fixture.getByRole('button', { name: 'Choose recipe' });
        expect(choose.state?.disabled).not.toBe(true);
      });
      await fixture.press(await fixture.getByRole('button', { name: 'Choose recipe' }));
      await vi.waitFor(() => expect(selectActionInput).toHaveBeenCalledOnce());
      await fixture.press(await fixture.getByRole('button', { name: 'Review changes' }));
      await fixture.press(await fixture.getByRole('button', { name: 'Save binding' }));
      await vi.waitFor(() => expect(updateInputs).toHaveLength(1));
      expect(updateInputs[0]).toMatchObject({ target: { routes: [{ recipe: editedRecipe }] } });
    } finally {
      await fixture.dispose();
    }
  });
});

describe('Channels binding enablement presentation', () => {
  it('retains actionable collection-quota incompatibility feedback after the authoritative reread', async () => {
    let bindingsReadCount = 0;
    const executeAction = vi.fn(async ({ action }: PluginUiTestkitExecuteActionInput) => {
      if (action === CONVERSATION_MANAGEMENT_ACTION_IDS_V1.bindingSetEnabled) {
        throw new PluginError({
          code: 'collection_quota_incompatible',
          message: 'The Account collection quota is incompatible.',
        });
      }
      throw new Error('Unexpected mounted Action: ' + String(action));
    });
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'fixture-instance-109', mountNonce: 'fixture-mount-109' },
      authorPlugin: { id: 'happier.channels', version: '0.0.0' },
      surface: renderSurface,
      surfaceContext: createChannelsPageSurfaceContext(),
      subPath: 'binding-1',
      adapter: createChannelsSemanticAdapter(),
      handlers: {
        selectActionInput: async () => ({ kind: 'cancelled' as const }),
        executeAction,
        readResource: bindingResourceReader(() => {
          bindingsReadCount += 1;
          return bindingsResource;
        }),
      },
    });

    try {
      await fixture.press(await fixture.getByRole('button', { name: 'Pause' }));

      await vi.waitFor(() => {
        expect(executeAction).toHaveBeenCalledWith(expect.objectContaining({
          action: CONVERSATION_MANAGEMENT_ACTION_IDS_V1.bindingSetEnabled,
          input: {
            bindingId: 'binding-1',
            expectedRevision: 1,
            enabled: false,
          },
        }));
      });
      await expect(fixture.getByText('Could not update binding enablement')).resolves.toBeDefined();
      await expect(fixture.getByText(
        'This binding could not be enabled because the Account collection quota is incompatible. Ask an administrator to make the Account collection quota compatible, then refresh and try again.',
      )).resolves.toBeDefined();
      await vi.waitFor(() => {
        expect(bindingsReadCount).toBeGreaterThanOrEqual(2);
      });
    } finally {
      await fixture.dispose();
    }
  });

  it('keeps raw Action diagnostics out of the primary binding-enablement failure chrome', async () => {
    const executeAction = vi.fn(async ({ action }: PluginUiTestkitExecuteActionInput) => {
      if (action === CONVERSATION_MANAGEMENT_ACTION_IDS_V1.bindingSetEnabled) {
        throw new PluginError({
          code: 'channels_binding_set_enabled_conflict',
          message: 'RAW DAEMON DIAGNOSTIC MUST NOT BECOME USER-FACING COPY',
          retryable: true,
        });
      }
      throw new Error('Unexpected mounted Action: ' + String(action));
    });
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'fixture-instance-110', mountNonce: 'fixture-mount-110' },
      authorPlugin: { id: 'happier.channels', version: '0.0.0' },
      surface: renderSurface,
      surfaceContext: {
        ...createChannelsPageSurfaceContext(),
        translations: {
          'plugins.channels.surface.bindingEnableFailedDescription': 'Aktualisiere die Bindungsdetails und versuche es erneut.',
        },
      },
      subPath: 'binding-1',
      adapter: createChannelsSemanticAdapter(),
      handlers: {
        selectActionInput: async () => ({ kind: 'cancelled' as const }),
        executeAction,
        readResource: bindingResourceReader(),
      },
    });

    try {
      await fixture.press(await fixture.getByRole('button', { name: 'Pause' }));
      await expect(fixture.getByText(
        'Aktualisiere die Bindungsdetails und versuche es erneut.',
      )).resolves.toBeDefined();
      expect(document.body.textContent).not.toContain('RAW DAEMON DIAGNOSTIC');
      expect(document.body.textContent).not.toContain('channels_binding_set_enabled_conflict');
    } finally {
      await fixture.dispose();
    }
  });
});

describe('Channels binding deletion presentation', () => {
  it('deletes a current binding through the canonical mounted Action', async () => {
    let bindingsReadCount = 0;
    const executeAction = vi.fn(async ({ action }: PluginUiTestkitExecuteActionInput) => {
      if (action === CONVERSATION_MANAGEMENT_ACTION_IDS_V1.bindingDelete) {
        return { kind: 'deletionPending' };
      }
      throw new Error(`Unexpected mounted Action: ${String(action)}`);
    });
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'fixture-instance-111', mountNonce: 'fixture-mount-111' },
      authorPlugin: { id: 'happier.channels', version: '0.0.0' },
      surface: renderSurface,
      surfaceContext: createChannelsPageSurfaceContext(),
      subPath: 'binding-1',
      adapter: createChannelsSemanticAdapter(),
      handlers: {
        selectActionInput: async () => ({ kind: 'cancelled' as const }),
        executeAction,
        readResource: bindingResourceReader(() => {
          bindingsReadCount += 1;
          return bindingsResource;
        }),
      },
    });

    try {
      await fixture.press(await fixture.getByRole('button', { name: 'Unlink…' }));

      await vi.waitFor(() => {
        expect(executeAction).toHaveBeenCalledWith(expect.objectContaining({
          action: CONVERSATION_MANAGEMENT_ACTION_IDS_V1.bindingDelete,
          input: {
            bindingId: 'binding-1',
            expectedRevision: 1,
          },
        }));
        expect(bindingsReadCount).toBeGreaterThanOrEqual(2);
      });
    } finally {
      await fixture.dispose();
    }
  });

  it('locks an unknown binding-delete outcome until an authoritative bindings Resource reread completes', async () => {
    let bindingsReadCount = 0;
    let resolveBindingsRefresh: ((value: ResourceContent) => void) | undefined;
    const executeAction = vi.fn(async ({ action }: PluginUiTestkitExecuteActionInput) => {
      if (action === CONVERSATION_MANAGEMENT_ACTION_IDS_V1.bindingDelete) {
        throw new PluginError({ code: 'timeout', message: 'The binding delete request timed out.' });
      }
      throw new Error(`Unexpected mounted Action: ${String(action)}`);
    });
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'fixture-instance-112', mountNonce: 'fixture-mount-112' },
      authorPlugin: { id: 'happier.channels', version: '0.0.0' },
      surface: renderSurface,
      surfaceContext: createChannelsPageSurfaceContext(),
      subPath: 'binding-1',
      adapter: createChannelsSemanticAdapter(),
      handlers: {
        selectActionInput: async () => ({ kind: 'cancelled' as const }),
        executeAction,
        readResource: bindingResourceReader(async () => {
          bindingsReadCount += 1;
          if (bindingsReadCount === 1) return bindingsResource;
          return await new Promise<ResourceContent>((resolve) => {
            resolveBindingsRefresh = resolve;
          });
        }),
      },
    });

    try {
      await fixture.press(await fixture.getByRole('button', { name: 'Unlink…' }));
      await expect(fixture.getByText('Could not confirm binding deletion')).resolves.toBeDefined();
      await expect(fixture.findByRole('button', {
        name: 'Unlink…',
        state: { disabled: true },
      })).resolves.toBeDefined();

      await pressByTestId('channels-binding-delete-outcome-unknown-reconcile-binding-1');
      await vi.waitFor(() => {
        expect(bindingsReadCount).toBe(2);
        expect(resolveBindingsRefresh).toBeTypeOf('function');
      });
      await expect(fixture.findByRole('button', {
        name: 'Unlink…',
        state: { disabled: true },
      })).resolves.toBeDefined();

      await act(async () => {
        resolveBindingsRefresh?.(bindingsResource);
      });
      await vi.waitFor(async () => {
        const deleteBinding = await fixture.getByRole('button', { name: 'Unlink…' });
        expect(deleteBinding.state?.disabled).not.toBe(true);
      });
      expect(executeAction).toHaveBeenCalledTimes(1);
    } finally {
      await fixture.dispose();
    }
  });

  it('shows direct-delete cleanup and does not offer an enablement mutation while it is finalizing', async () => {
    const executeAction = vi.fn(async () => {
      throw new Error('A finalizing binding must not execute an enablement Action.');
    });
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'fixture-instance-113', mountNonce: 'fixture-mount-113' },
      authorPlugin: { id: 'happier.channels', version: '0.0.0' },
      surface: renderSurface,
      surfaceContext: createChannelsPageSurfaceContext(),
      subPath: 'binding-1',
      adapter: createChannelsSemanticAdapter(),
      handlers: {
        selectActionInput: async () => ({ kind: 'cancelled' as const }),
        executeAction,
        readResource: async ({ resource }) => {
          const localId = resourceFixtureLocalId(resource);
          if (localId === BINDINGS_RESOURCE.localId) return finalizingBindingsResource;
          if (localId === CONNECTIONS_RESOURCE.localId) return connectionsResource;
          throw new Error(`Unexpected Resource: ${localId}`);
        },
      },
    });

    try {
      await vi.waitFor(() => {
        expect(document.querySelector('[data-testid="channels-binding-deleting-binding-1"]')?.textContent)
          .toContain('Deletion cleanup in progress');
      });
      // A conversation being unlinked offers no way to turn it on, pause it or edit it.
      await expect(fixture.queryByRole('button', { name: 'Turn on' })).resolves.toBeUndefined();
      await expect(fixture.queryByRole('button', { name: 'Pause' })).resolves.toBeUndefined();
      await expect(fixture.queryByRole('button', { name: 'Edit binding' })).resolves.toBeUndefined();
      expect(executeAction).not.toHaveBeenCalled();
    } finally {
      await fixture.dispose();
    }
  });
});

describe('Channels connection policy editing across a source change', () => {
  function connectionsResourceAtRevision(input: Readonly<{
    revision: number;
    enabled: boolean;
    digestDigit: string;
  }>): ResourceContent {
    return jsonResource({
      connections: [{
        connectionId: 'connection-1',
        revision: input.revision,
        authorityEpoch: 1,
        providerPluginId: providerSetupOperation.contributor.pluginId,
        selectedMachineId: 'machine-1',
        selectedTransport: 'checkpointedPull',
        integrationPrincipalLabel: 'Example conversation',
        enabled: input.enabled,
        deletionState: 'none',
        attention: {
          historyGap: null,
          pollFailure: null,
          bestEffortBeforeDurableAdmission: false,
          oldTransportStopUnconfirmed: false,
          endpointRetargetOwed: false,
          acceptedPossibleLoss: false,
          outwardDelivery: {
            retryDue: false,
            notDelivered: false,
            partial: false,
            outcomeUnknown: false,
          },
        },
      }],
    }, input.digestDigit);
  }

  it('keeps an in-progress policy edit when the connection changes elsewhere and locks saving until an explicit reload', async () => {
    // A background reread used to silently rebase the draft: the edit the
    // person was typing vanished with no notice, and Save would then have
    // written against a revision they never saw.
    let current = connectionsResourceAtRevision({
      revision: 1,
      enabled: true,
      digestDigit: 'b',
    });
    const executeAction = vi.fn(async () => {
      throw new Error('A source-changed policy editor must not submit.');
    });
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'fixture-instance-114', mountNonce: 'fixture-mount-114' },
      authorPlugin: { id: 'happier.channels', version: '0.0.0' },
      surface: renderSurface,
      surfaceContext: createChannelsSurfaceContext(),
      adapter: createChannelsSemanticAdapter(emptyDataClient, undefined, { overlays: true }),
      handlers: {
        selectActionInput: async () => ({ kind: 'cancelled' as const }),
        executeAction,
        readResource: async ({ resource }) => {
          const localId = resourceFixtureLocalId(resource);
          if (localId === BINDINGS_RESOURCE.localId) return bindingsResource;
          if (localId === CONNECTIONS_RESOURCE.localId) return current;
          throw new Error(`Unexpected Resource: ${localId}`);
        },
      },
    });

    try {
      await pressByTestId('channels-connection-connection-1');
      await pressByTestId('channels-connection-enabled');
      expect(document.querySelector('[data-testid="channels-connection-source-changed"]')).toBeNull();

      // Another writer advances the connection while the edit is open.
      current = connectionsResourceAtRevision({
        revision: 2,
        enabled: true,
        digestDigit: 'c',
      });
      await pressByTestId('channels-detail-resource-refresh');

      expect(document.querySelector('[data-testid="channels-connection-enabled"]')?.getAttribute('aria-checked')).toBe('false');
      const notice = document.querySelector<HTMLElement>('[data-testid="channels-connection-source-changed"]');
      expect(notice).not.toBeNull();
      const save = document.querySelector<HTMLElement>('[data-testid="channels-connection-save"]');
      expect(save?.getAttribute('aria-disabled')).toBe('true');
      await act(async () => { save?.click(); });
      expect(executeAction).not.toHaveBeenCalled();

      // Reload is the explicit way out: the draft rebases onto the current
      // policy, the notice clears and saving is admitted again.
      await pressByTestId('channels-connection-source-changed-reload');
      await vi.waitFor(() => {
        expect(document.querySelector('[data-testid="channels-connection-source-changed"]')).toBeNull();
      });
      expect(document.querySelector('[data-testid="channels-connection-enabled"]')?.getAttribute('aria-checked')).toBe('true');
      expect(document.querySelector('[data-testid="channels-connection-save"]')?.getAttribute('aria-disabled'))
        .not.toBe('true');
    } finally {
      await fixture.dispose();
    }
  });

  it('does not report the editor own successful save as a change made elsewhere', async () => {
    // The retained-draft rule must not fire on the revision the person just
    // caused: their edit is what the new policy says, so there is nothing to
    // lose and nothing to warn about.
    let current = connectionsResourceAtRevision({
      revision: 1,
      enabled: true,
      digestDigit: 'b',
    });
    const executeAction = vi.fn(async (_request: PluginUiTestkitExecuteActionInput) => {
      current = connectionsResourceAtRevision({
        revision: 2,
        enabled: false,
        digestDigit: 'c',
      });
      return { kind: 'ready' as const, connectionId: 'connection-1', revision: 2, authorityEpoch: 1 };
    });
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'fixture-instance-115', mountNonce: 'fixture-mount-115' },
      authorPlugin: { id: 'happier.channels', version: '0.0.0' },
      surface: renderSurface,
      surfaceContext: createChannelsSurfaceContext(),
      adapter: createChannelsSemanticAdapter(emptyDataClient, undefined, { overlays: true }),
      handlers: {
        selectActionInput: async () => ({ kind: 'cancelled' as const }),
        executeAction,
        readResource: async ({ resource }) => {
          const localId = resourceFixtureLocalId(resource);
          if (localId === BINDINGS_RESOURCE.localId) return bindingsResource;
          if (localId === CONNECTIONS_RESOURCE.localId) return current;
          throw new Error(`Unexpected Resource: ${localId}`);
        },
      },
    });

    try {
      await pressByTestId('channels-connection-connection-1');
      await pressByTestId('channels-connection-enabled');
      await pressByTestId('channels-connection-save');
      await vi.waitFor(() => {
        expect(executeAction).toHaveBeenCalledTimes(1);
      });
      // Owner ruling 2026-10-29: provider-derived dedupe replaces the connection age policy.
      expect(executeAction.mock.calls[0]?.[0].input).toEqual({
        connectionId: 'connection-1', expectedRevision: 1, enabled: false,
      });

      await vi.waitFor(() => {
        expect(document.querySelector('[data-testid="channels-save-outcome"]')).not.toBeNull();
      });
      expect(document.querySelector('[data-testid="channels-connection-source-changed"]')).toBeNull();
      expect(document.querySelector('[data-testid="channels-connection-save"]')?.getAttribute('aria-disabled'))
        .not.toBe('true');
    } finally {
      await fixture.dispose();
    }
  });

  it('rebases a clean policy editor onto a newer revision without a source-changed notice', async () => {
    // The notice exists for lost work. With nothing edited there is nothing to
    // lose, so a background reread stays invisible.
    let current = connectionsResourceAtRevision({
      revision: 1,
      enabled: true,
      digestDigit: 'b',
    });
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'fixture-instance-116', mountNonce: 'fixture-mount-116' },
      authorPlugin: { id: 'happier.channels', version: '0.0.0' },
      surface: renderSurface,
      surfaceContext: createChannelsSurfaceContext(),
      adapter: createChannelsSemanticAdapter(emptyDataClient, undefined, { overlays: true }),
      handlers: {
        selectActionInput: async () => ({ kind: 'cancelled' as const }),
        executeAction: async () => {
          throw new Error('A clean rebase must not invoke an Action.');
        },
        readResource: async ({ resource }) => {
          const localId = resourceFixtureLocalId(resource);
          if (localId === BINDINGS_RESOURCE.localId) return bindingsResource;
          if (localId === CONNECTIONS_RESOURCE.localId) return current;
          throw new Error(`Unexpected Resource: ${localId}`);
        },
      },
    });

    try {
      await pressByTestId('channels-connection-connection-1');
      current = connectionsResourceAtRevision({
        revision: 2,
        enabled: false,
        digestDigit: 'c',
      });
      await pressByTestId('channels-detail-resource-refresh');

      expect(document.querySelector('[data-testid="channels-connection-source-changed"]')).toBeNull();
      expect(document.querySelector('[data-testid="channels-connection-enabled"]')?.getAttribute('aria-checked')).toBe('false');
      expect(document.querySelector('[data-testid="channels-connection-save"]')?.getAttribute('aria-disabled'))
        .not.toBe('true');
    } finally {
      await fixture.dispose();
    }
  });
});

describe('Channels connection lifecycle actions', () => {
  it('explains a poll caller refusal and preserves the actionable connection-test error', async () => {
    const connectionResource = JSON.parse(new TextDecoder().decode(connectionsResourceForTransport('checkpointedPull').bytes));
    connectionResource.connections[0].attention.pollFailure = {
      phase: 'blocked', attemptCount: 1, retryNotBeforeMs: null,
      evidence: { kind: 'action', code: 'plugin_action_caller_unavailable' },
    };
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'caller-refusal', mountNonce: 'caller-refusal-mount' },
      authorPlugin: { id: 'happier.channels', version: '0.0.0' },
      surface: renderSurface,
      surfaceContext: createChannelsSurfaceContext(),
      adapter: createChannelsSemanticAdapter(),
      handlers: {
        selectActionInput: async () => ({ kind: 'cancelled' as const }),
        executeAction: async () => {
          throw new PluginError({
            code: 'plugin_action_caller_unavailable',
            message: 'Reload the integration on the selected machine, then try again.',
          });
        },
        readResource: async ({ resource }) => resourceFixtureLocalId(resource) === CONNECTIONS_RESOURCE.localId
          ? jsonResource(connectionResource, '4')
          : bindingsResource,
      },
    });
    try {
      await pressByTestId('channels-connection-connection-1');
      expect(document.querySelector('[data-testid="channels-poll-blocked-disclosure"]')?.textContent)
        .toContain('Reload the integration on the selected machine, then retry.');
      await fixture.press(await fixture.getByRole('button', { name: 'Test connection' }));
      await vi.waitFor(() => {
        expect(document.querySelector('[data-testid="channels-connection-retest-error"]')?.textContent)
          .toContain('Reload the integration on the selected machine, then try again.');
      });
      await fixture.press(await fixture.getByRole('button', { name: 'Retry connection' }));
      await vi.waitFor(() => {
        expect(document.querySelector('[data-testid="channels-poll-retry-error"]')?.textContent)
          .toContain('Reload the integration on the selected machine, then try again.');
      });
    } finally {
      await fixture.dispose();
    }
  });

  it('ignores a retained occurrence latch and leaves real blocked-poll recovery available', async () => {
    const resource = connectionsResourceWithIngressConflict();
    const executeAction = vi.fn(async () => {
      throw new Error('This presentation test does not execute the available recovery Action.');
    });
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'fixture-instance-117', mountNonce: 'fixture-mount-117' },
      authorPlugin: { id: 'happier.channels', version: '0.0.0' },
      surface: renderSurface,
      surfaceContext: createChannelsSurfaceContext(),
      adapter: createChannelsSemanticAdapter(),
      handlers: {
        selectActionInput: async () => ({ kind: 'cancelled' as const }),
        executeAction,
        readResource: async ({ resource: requested }) => {
          const localId = resourceFixtureLocalId(requested);
          if (localId === BINDINGS_RESOURCE.localId) return bindingsResource;
          if (localId === CONNECTIONS_RESOURCE.localId) return resource;
          throw new Error(`Unexpected Resource: ${localId}`);
        },
      },
    });

    try {
      await expect(fixture.queryByText('Incoming occurrence conflict needs attention')).resolves.toBeUndefined();
      await pressByTestId('channels-connection-connection-1');
      expect(document.querySelector('[data-testid="channels-ingress-occurrence-conflict-disclosure"]')).toBeNull();
      await expect(fixture.getByRole('button', { name: 'Retry connection' })).resolves.toBeDefined();
      await expect(fixture.getByRole('button', { name: 'Delete connection' })).resolves.toBeDefined();
      expect(executeAction).not.toHaveBeenCalled();
    } finally {
      await fixture.dispose();
    }
  });

  it('renders provider-neutral readiness attention from the canonical connection status projection', async () => {
    const providerReadiness = connectionsResourceWithProviderReadiness({
      code: 'providerPermissionMissing',
      diagnostic: 'Enable the required permission in the provider configuration.',
    });
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'fixture-instance-118', mountNonce: 'fixture-mount-118' },
      authorPlugin: { id: 'happier.channels', version: '0.0.0' },
      surface: renderSurface,
      surfaceContext: createChannelsSurfaceContext(),
      adapter: createChannelsSemanticAdapter(),
      handlers: {
        selectActionInput: async () => ({ kind: 'cancelled' as const }),
        executeAction: async () => {
          throw new Error('Provider readiness disclosure must not invoke an Action.');
        },
        readResource: async ({ resource }) => {
          const localId = resourceFixtureLocalId(resource);
          if (localId === BINDINGS_RESOURCE.localId) return bindingsResource;
          if (localId === CONNECTIONS_RESOURCE.localId) return providerReadiness;
          throw new Error(`Unexpected Resource: ${localId}`);
        },
      },
    });

    try {
      await expect(fixture.getByText('Provider permission needs attention')).resolves.toBeDefined();
      await pressByTestId('channels-connection-connection-1');
      const disclosure = document.querySelector<HTMLElement>('[data-testid="channels-provider-readiness-disclosure"]');
      expect(disclosure).not.toBeNull();
      expect(disclosure?.textContent).toContain('Provider permission needs attention');
      expect(disclosure?.textContent).toContain('Enable the required permission in the provider configuration.');
    } finally {
      await fixture.dispose();
    }
  });

  it('re-probes a failed connection through the canonical retest Action and reports the provider verdict', async () => {
    const providerReadiness = connectionsResourceWithProviderReadiness({
      code: 'providerPermissionMissing',
      diagnostic: 'Enable the required permission in the provider configuration.',
    });
    const executeAction = vi.fn(async () => ({
      kind: 'ready' as const,
      connectionId: 'connection-1',
      revision: 2,
      authorityEpoch: 1,
    }));
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'fixture-instance-119', mountNonce: 'fixture-mount-119' },
      authorPlugin: { id: 'happier.channels', version: '0.0.0' },
      surface: renderSurface,
      surfaceContext: createChannelsSurfaceContext(),
      adapter: createChannelsSemanticAdapter(),
      handlers: {
        selectActionInput: async () => ({ kind: 'cancelled' as const }),
        executeAction,
        readResource: async ({ resource }) => {
          const localId = resourceFixtureLocalId(resource);
          if (localId === BINDINGS_RESOURCE.localId) return bindingsResource;
          if (localId === CONNECTIONS_RESOURCE.localId) return providerReadiness;
          throw new Error(`Unexpected Resource: ${localId}`);
        },
      },
    });

    try {
      await pressByTestId('channels-connection-connection-1');
      // Before this existed the only exit from a failed connection was
      // deleting it, so its presence next to the readiness banner is the
      // contract, not decoration.
      await fixture.press(await fixture.getByRole('button', { name: 'Test connection' }));

      await vi.waitFor(() => {
        expect(executeAction).toHaveBeenCalledTimes(1);
      });
      expect(executeAction).toHaveBeenCalledWith(expect.objectContaining({
        action: CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionRetest,
        input: {
          connectionId: 'connection-1',
        },
      }));
      await vi.waitFor(() => {
        expect(document.querySelector('[data-testid="channels-connection-retest-ready"]')).not.toBeNull();
      });
    } finally {
      await fixture.dispose();
    }
  });

  it('keeps retest and delivery-resolution siblings separately identified when both are offered', async () => {
    // Both controls sit in the SAME expanded-connection child list, so keying
    // both by the connection id made them one identity: React warned that a
    // child could be duplicated or omitted, and a status transition could hand
    // one control's mounted state to the other in a recovery surface.
    const ambiguousDelivery = jsonResource({
      connections: [{
        connectionId: 'connection-1',
        revision: 1,
        authorityEpoch: 1,
        providerPluginId: providerSetupOperation.contributor.pluginId,
        selectedMachineId: 'machine-1',
        selectedTransport: 'checkpointedPull',
        integrationPrincipalLabel: 'Example conversation',
        enabled: true,
        deletionState: 'none',
        attention: {
          historyGap: null,
          pollFailure: null,
          bestEffortBeforeDurableAdmission: false,
          oldTransportStopUnconfirmed: false,
          endpointRetargetOwed: false,
          acceptedPossibleLoss: false,
          outwardDelivery: {
            retryDue: false,
            notDelivered: false,
            partial: false,
            outcomeUnknown: true,
          },
        },
      }],
    }, '5');
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'fixture-instance-120', mountNonce: 'fixture-mount-120' },
      authorPlugin: { id: 'happier.channels', version: '0.0.0' },
      surface: renderSurface,
      surfaceContext: createChannelsSurfaceContext(),
      adapter: createChannelsSemanticAdapter(),
      handlers: {
        selectActionInput: async () => ({ kind: 'cancelled' as const }),
        executeAction: async () => {
          throw new Error('Rendering both recovery controls must not invoke an Action.');
        },
        readResource: async ({ resource }) => {
          const localId = resourceFixtureLocalId(resource);
          if (localId === BINDINGS_RESOURCE.localId) return bindingsResource;
          if (localId === CONNECTIONS_RESOURCE.localId) return ambiguousDelivery;
          throw new Error(`Unexpected Resource: ${localId}`);
        },
      },
    });

    try {
      await pressByTestId('channels-connection-connection-1');
      await vi.waitFor(() => {
        expect(document.querySelector('[data-testid="channels-connection-retest-controls"]')).not.toBeNull();
      });
      expect(document.querySelector('[data-testid="channels-delivery-resolution-controls"]')).not.toBeNull();
      const duplicateKeyReports = consoleError.mock.calls.filter((call) => (
        call.some((argument) => typeof argument === 'string' && argument.includes('two children with the same key'))
      ));
      expect(duplicateKeyReports).toEqual([]);
    } finally {
      await fixture.dispose();
      consoleError.mockRestore();
    }
  });

  it('transfers a current connection through the selected provider setup and canonical mounted Action', async () => {
    let connectionsReadCount = 0;
    const credentialRef = {
      service: {
        pluginId: 'com.example.conversation-provider',
        localId: 'provider-account',
      },
      accountId: 'provider-account-a',
    } as const;
    const submittedProviderSetup = {
      kind: 'submitted' as const,
      action: providerSetupOperation.action,
      input: { repository: 'happier-dev/happier' },
      selection: {
        target: {
          pluginId: 'happier.channels',
          sourceCustody: { kind: 'development', registeredRootId: 'channels-target-root-a' } as const,
        },
        point: providerSetupOperation.point,
        contributor: providerPortableContributor(),
      },
      connectedAccount: { kind: 'selected' as const, fieldPath: 'credentialRef', ref: credentialRef },
      presentation: {
        connectedAccountLabel: 'Operations account',
        machineDisplayName: 'Office workstation',
      },
    };
    const selectedActionInput = {
      operation: providerSetupOperation,
      result: submittedProviderSetup,
    } as const;
    const selectActionInput = vi.fn(async () => submittedProviderSetup);
    const executeAction = vi.fn(async (request: PluginUiTestkitExecuteActionInput): Promise<JsonValue> => {
      if (request.action === CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionPrepare) {
        return {
          kind: 'ready',
          supportedTransports: ['checkpointedPull', 'socket'],
          recommendedTransport: 'socket',
          overlapSafety: 'safe',
          replayContinuity: 'checkpointed',
          outboundTextLimit: { maximum: 4_000, unit: 'unicodeCodePoints' },
          destinationLabel: '#operations',
        };
      }
      if (request.action !== CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionTransfer) {
        throw new Error(`Unexpected mounted Action: ${String(request.action)}`);
      }
      expect(request.input).toEqual({
        connectionId: 'connection-1',
        expectedRevision: 1,
        providerSelection: submittedProviderSetup.selection,
        providerSetupInput: submittedProviderSetup.input,
        credentialRef,
        selectedTransport: 'socket',
      });
      expect(request.selectedActionInput).toEqual(selectedActionInput);
      expect((request as unknown as Readonly<{ consumeSelectedActionInput?: unknown }>)
        .consumeSelectedActionInput).toBeUndefined();
      return {
        kind: 'transferred',
        connectionId: 'connection-1',
        revision: 2,
        authorityEpoch: 2,
      };
    });
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'fixture-instance-121', mountNonce: 'fixture-mount-121' },
      authorPlugin: { id: 'happier.channels', version: '0.0.0' },
      surface: renderSurface,
      surfaceContext: createChannelsSurfaceContext(),
      adapter: createChannelsSemanticAdapter(),
      handlers: {
        selectActionInput,
        executeAction,
        readResource: async ({ resource }) => {
          const localId = resourceFixtureLocalId(resource);
          if (localId === BINDINGS_RESOURCE.localId) return bindingsResource;
          if (localId === CONNECTIONS_RESOURCE.localId) {
            connectionsReadCount += 1;
            return connectionsResource;
          }
          throw new Error(`Unexpected Resource: ${localId}`);
        },
      },
    });

    try {
      await pressButtonWithAccessibleLabelFragment('Example conversation');
      await fixture.press(await fixture.getByRole('button', { name: 'Transfer connection' }));
      await expect(fixture.getByRole('button', { name: 'Cancel transfer' })).resolves.toBeDefined();
      await fixture.press(await fixture.getByRole('button', { name: 'Cancel transfer' }));
      expect(document.querySelector('[data-testid="channels-connection-transfer-form"]')).toBeNull();
      expect(executeAction).not.toHaveBeenCalled();

      await fixture.press(await fixture.getByRole('button', { name: 'Transfer connection' }));
      await fixture.press(await fixture.getByRole('button', { name: 'Transfer with Integration provider' }));
      await expect(fixture.getByText('Operations account')).resolves.toBeDefined();
      await expect(fixture.getByText('Office workstation')).resolves.toBeDefined();
      await expect(fixture.getByText('#operations')).resolves.toBeDefined();
      await expect(fixture.getByRole('radio', {
        name: 'Receives messages even while this machine is offline',
        state: { checked: false },
      })).resolves.toBeDefined();
      await fixture.press(await fixture.getByRole('radio', {
        name: 'Receives messages while this machine is online',
        state: { checked: false },
      }));
      await fixture.press(await fixture.getByRole('button', { name: 'Back' }));
      await expect(fixture.queryByRole('button', { name: 'Confirm transfer' })).resolves.toBeUndefined();
      await fixture.press(await fixture.getByRole('button', { name: 'Transfer with Integration provider' }));
      await expect(fixture.getByRole('radio', {
        name: 'Receives messages while this machine is online',
        state: { checked: true },
      })).resolves.toBeDefined();
      await fixture.press(await fixture.getByRole('button', { name: 'Confirm transfer' }));

      await vi.waitFor(() => {
        expect(selectActionInput).toHaveBeenCalledTimes(2);
        expect(selectActionInput).toHaveBeenCalledWith({
          request: { operation: providerSetupOperation },
          signal: expect.anything(),
        });
        expect(executeAction).toHaveBeenCalledTimes(3);
        expect(connectionsReadCount).toBeGreaterThanOrEqual(2);
      });
      expect(executeAction.mock.calls.map(([request]) => request.action)).not.toContain(
        CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionCreate,
      );
    } finally {
      await fixture.dispose();
    }
  });

  it('announces each transfer phase through the mounted focus owner', async () => {
    const submittedProviderSetup = {
      kind: 'submitted' as const,
      action: providerSetupOperation.action,
      input: { repository: 'happier-dev/happier' },
      selection: {
        target: {
          pluginId: 'happier.channels',
          sourceCustody: { kind: 'development', registeredRootId: 'channels-target-root-a' } as const,
        },
        point: providerSetupOperation.point,
        contributor: providerPortableContributor(),
      },
      connectedAccount: { kind: 'none' as const },
      presentation: { connectedAccountLabel: null, machineDisplayName: null },
    };
    const executeAction = vi.fn(async ({ action }: PluginUiTestkitExecuteActionInput): Promise<JsonValue> => {
      if (action === CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionPrepare) {
        return {
          kind: 'ready', supportedTransports: ['checkpointedPull', 'socket'],
          recommendedTransport: 'checkpointedPull', overlapSafety: 'safe',
          replayContinuity: 'checkpointed', outboundTextLimit: { maximum: 4_000, unit: 'unicodeCodePoints' },
        };
      }
      if (action !== CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionTransfer) {
        throw new Error(`Unexpected mounted Action: ${String(action)}`);
      }
      return {
        kind: 'transferred',
        connectionId: 'connection-1',
        revision: 2,
        authorityEpoch: 2,
      };
    });
    const focusTarget = vi.fn((target: unknown): boolean => {
      const focus = (target as Readonly<{ focus?: () => void }> | null)?.focus;
      if (typeof focus !== 'function') return false;
      focus.call(target);
      return true;
    });
    const presentationHost = {
      focusTarget,
      renderMarkdown: () => null,
      renderCodeBlock: () => null,
      renderPopover: () => null,
      renderIcon: () => null,
    } satisfies PluginUiPresentationHost;
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'fixture-instance-122', mountNonce: 'fixture-mount-122' },
      authorPlugin: { id: 'happier.channels', version: '0.0.0' },
      surface: renderSurface,
      surfaceContext: createChannelsSurfaceContext(),
      adapter: createChannelsSemanticAdapter(emptyDataClient, presentationHost),
      handlers: {
        selectActionInput: async () => submittedProviderSetup,
        executeAction,
        readResource: async ({ resource }) => {
          const localId = resourceFixtureLocalId(resource);
          if (localId === BINDINGS_RESOURCE.localId) return bindingsResource;
          if (localId === CONNECTIONS_RESOURCE.localId) return connectionsResource;
          throw new Error(`Unexpected Resource: ${localId}`);
        },
      },
    });

    const headingFor = (title: string): HTMLElement | undefined => (
      Array.from(document.querySelectorAll<HTMLElement>('[role="heading"]')).find((node) => node.textContent === title)
    );

    try {
      await pressButtonWithAccessibleLabelFragment('Example conversation');
      await fixture.press(await fixture.getByRole('button', { name: 'Transfer connection' }));
      // Opening the form announces the provider-selection phase.
      await vi.waitFor(() => {
        expect(focusTarget).toHaveBeenCalledTimes(1);
        expect(document.activeElement).toBe(headingFor('Transfer connection'));
      });

      // Choosing a provider advances the transport phase and moves logical
      // focus to its first control.
      await fixture.press(await fixture.getByRole('button', { name: 'Transfer with Integration provider' }));
      await vi.waitFor(() => {
        expect(focusTarget).toHaveBeenCalledTimes(2);
        const transportField = document.querySelector<HTMLElement>('[data-testid="channels-connection-transfer-transport"]');
        expect(transportField).not.toBeNull();
        expect(transportField?.contains(document.activeElement) || document.activeElement === transportField).toBe(true);
      });

      // Back returns to provider selection and announces it the same way.
      await fixture.press(await fixture.getByRole('button', { name: 'Back' }));
      await vi.waitFor(() => {
        expect(focusTarget).toHaveBeenCalledTimes(3);
        expect(document.activeElement).toBe(headingFor('Transfer connection'));
      });
    } finally {
      await fixture.dispose();
    }
  });

  it('ensures and continues a durable-push transfer with the same selected provider input', async () => {
    const submittedProviderSetup = {
      kind: 'submitted' as const,
      action: providerSetupOperation.action,
      input: { repository: 'happier-dev/happier' },
      selection: {
        target: {
          pluginId: 'happier.channels',
          sourceCustody: { kind: 'development', registeredRootId: 'channels-target-root-a' } as const,
        },
        point: providerSetupOperation.point,
        contributor: providerPortableContributor(),
      },
      connectedAccount: { kind: 'none' as const },
      presentation: { connectedAccountLabel: null, machineDisplayName: null },
    };
    const selectedActionInput = { operation: providerSetupOperation, result: submittedProviderSetup } as const;
    // Requests are recorded rather than asserted inside the boundary mock: a
    // failed expectation there surfaces only as a rejected Action, which this
    // surface presents as an ordinary transfer failure.
    const transferRequests: PluginUiTestkitExecuteActionInput[] = [];
    const executeAction = vi.fn(async (
      request: PluginUiTestkitExecuteActionInput,
    ): Promise<JsonValue> => {
      if (request.action === CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionPrepare) {
        return {
          kind: 'ready', supportedTransports: ['checkpointedPull', 'durablePush'],
          recommendedTransport: 'checkpointedPull', overlapSafety: 'safe',
          replayContinuity: 'checkpointed', outboundTextLimit: { maximum: 4_000, unit: 'unicodeCodePoints' },
        };
      }
      if (request.action === 'plugin.webhook.endpoint.ensure') {
        expect(request.selectedActionInput).toBeUndefined();
        return {
          webhookEndpointId: 'wh_ep_AAECAwQFBgcICQoLDA0ODw',
          publicUrl: 'https://example.test/webhooks/channels',
          readiness: 'ready',
          revision: 1,
        };
      }
      if (request.action !== CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionTransfer) {
        throw new Error(`Unexpected mounted Action: ${String(request.action)}`);
      }
      transferRequests.push(request);
      const input = request.input as Readonly<{ endpointContinuation?: unknown }>;
      if (input.endpointContinuation === undefined) {
        return {
          kind: 'endpointRequired',
          connectionId: 'connection-1',
          webhookContribution: {
            pluginId: 'com.example.conversation-provider',
            localId: 'webhook',
          },
          targetMaterialization: {
            pluginId: 'com.example.conversation-provider',
            machineId: 'machine-example',
            materializationId: 'materialization-example',
          },
          sourceInstanceId: 'channels.connection.connection-1',
          webhookEndpointSetup: { kind: 'accountEndpointV1', credential: 'serverGenerated' },
          webhookEndpointIdempotencyKey: 'channels-transfer-endpoint-1',
        };
      }
      return {
        kind: 'transferPendingOldStop',
        connectionId: 'connection-1',
        revision: 2,
        authorityEpoch: 2,
      };
    });
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'fixture-instance-123', mountNonce: 'fixture-mount-123' },
      authorPlugin: { id: 'happier.channels', version: '0.0.0' },
      surface: renderSurface,
      surfaceContext: createChannelsSurfaceContext(),
      adapter: createChannelsSemanticAdapter(),
      handlers: {
        selectActionInput: async () => submittedProviderSetup,
        executeAction,
        readResource: bindingResourceReader(),
      },
    });

    try {
      await pressButtonWithAccessibleLabelFragment('Example conversation');
      await fixture.press(await fixture.getByRole('button', { name: 'Transfer connection' }));
      await fixture.press(await fixture.getByRole('button', { name: 'Transfer with Integration provider' }));
      await fixture.press(await fixture.getByRole('radio', {
        name: 'Receives messages even while this machine is offline',
        state: { checked: false },
      }));
      await fixture.press(await fixture.getByRole('button', { name: 'Confirm transfer' }));
      await vi.waitFor(() => expect(executeAction.mock.calls.map(([request]) => request.action)).toEqual([
        CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionPrepare,
        CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionTransfer,
        'plugin.webhook.endpoint.ensure',
        CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionTransfer,
      ]));
      // A terminal transfer retires the purpose-bound selection, so the
      // transport step collapses and no failure is presented.
      await vi.waitFor(() => {
        expect(document.querySelector('[data-testid="channels-connection-transfer-submit"]')).toBeNull();
      });
      expect(document.querySelector('[data-testid="channels-connection-transfer-result-failed"]')).toBeNull();
      // Both halves of the one visible attempt carried the same selection.
      expect(transferRequests.map((request) => (
        request.input as Readonly<{ endpointContinuation?: unknown }>
      ).endpointContinuation)).toEqual([
        undefined,
        { connectionId: 'connection-1', webhookEndpointId: 'wh_ep_AAECAwQFBgcICQoLDA0ODw' },
      ]);
      expect(transferRequests.map((request) => request.selectedActionInput))
        .toEqual([selectedActionInput, selectedActionInput]);
    } finally {
      await fixture.dispose();
    }
  });

  it('rejoins the exact retained durable-push ensure after an ambiguous ensure on a deliberate second press', async () => {
    const submittedProviderSetup = {
      kind: 'submitted' as const,
      action: providerSetupOperation.action,
      input: { repository: 'happier-dev/happier' },
      selection: {
        target: {
          pluginId: 'happier.channels',
          sourceCustody: { kind: 'development', registeredRootId: 'channels-target-root-a' } as const,
        },
        point: providerSetupOperation.point,
        contributor: providerPortableContributor(),
      },
      connectedAccount: { kind: 'none' as const },
      presentation: { connectedAccountLabel: null, machineDisplayName: null },
    };
    const selectedActionInput = { operation: providerSetupOperation, result: submittedProviderSetup } as const;
    const endpointRequiredResult = {
      kind: 'endpointRequired',
      connectionId: 'connection-1',
      webhookContribution: {
        pluginId: 'com.example.conversation-provider',
        localId: 'webhook',
      },
      targetMaterialization: {
        pluginId: 'com.example.conversation-provider',
        machineId: 'machine-example',
        materializationId: 'materialization-example',
      },
      sourceInstanceId: 'channels.connection.connection-1',
      webhookEndpointSetup: { kind: 'accountEndpointV1', credential: 'serverGenerated' },
      webhookEndpointIdempotencyKey: 'channels-transfer-endpoint-1',
    };
    const endpointEnsureInput = {
      webhookContribution: endpointRequiredResult.webhookContribution,
      targetMaterialization: endpointRequiredResult.targetMaterialization,
      sourceInstanceId: endpointRequiredResult.sourceInstanceId,
      setup: endpointRequiredResult.webhookEndpointSetup,
      idempotencyKey: endpointRequiredResult.webhookEndpointIdempotencyKey,
    };
    let endpointEnsureCalls = 0;
    // The core mints a fresh endpoint idempotency key on every no-continuation
    // transfer. Handing back a stable key would let a surface that silently
    // re-ran the first transfer still look like an exact rejoin, so the
    // producer varies it and the assertion below can tell the two apart.
    let mintedEndpointKeys = 0;
    const ensureInputs: unknown[] = [];
    const executeAction = vi.fn(async (
      request: PluginUiTestkitExecuteActionInput,
    ): Promise<JsonValue> => {
      if (request.action === CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionPrepare) {
        return {
          kind: 'ready', supportedTransports: ['checkpointedPull', 'durablePush'],
          recommendedTransport: 'checkpointedPull', overlapSafety: 'safe',
          replayContinuity: 'checkpointed', outboundTextLimit: { maximum: 4_000, unit: 'unicodeCodePoints' },
        };
      }
      if (request.action === 'plugin.webhook.endpoint.ensure') {
        ensureInputs.push(request.input);
        endpointEnsureCalls += 1;
        if (endpointEnsureCalls === 1) {
          throw new PluginError({
            code: 'timeout',
            message: 'The endpoint ensure response was lost.',
          });
        }
        return {
          webhookEndpointId: 'wh_ep_AAECAwQFBgcICQoLDA0ODw',
          publicUrl: 'https://example.test/webhooks/channels',
          readiness: 'ready',
          revision: 1,
        };
      }
      if (request.action !== CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionTransfer) {
        throw new Error(`Unexpected mounted Action: ${String(request.action)}`);
      }
      expect(request.selectedActionInput).toEqual(selectedActionInput);
      const input = request.input as Readonly<{ endpointContinuation?: unknown }>;
      if (input.endpointContinuation === undefined) {
        mintedEndpointKeys += 1;
        return {
          ...endpointRequiredResult,
          webhookEndpointIdempotencyKey: `channels-transfer-endpoint-${mintedEndpointKeys}`,
        };
      }
      expect(input.endpointContinuation).toEqual({
        connectionId: 'connection-1',
        webhookEndpointId: 'wh_ep_AAECAwQFBgcICQoLDA0ODw',
      });
      return {
        kind: 'transferPendingOldStop',
        connectionId: 'connection-1',
        revision: 2,
        authorityEpoch: 2,
      };
    });
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'fixture-instance-124', mountNonce: 'fixture-mount-124' },
      authorPlugin: { id: 'happier.channels', version: '0.0.0' },
      surface: renderSurface,
      surfaceContext: createChannelsSurfaceContext(),
      adapter: createChannelsSemanticAdapter(),
      handlers: {
        selectActionInput: async () => submittedProviderSetup,
        executeAction,
        readResource: bindingResourceReader(),
      },
    });

    try {
      await pressButtonWithAccessibleLabelFragment('Example conversation');
      await fixture.press(await fixture.getByRole('button', { name: 'Transfer connection' }));
      await fixture.press(await fixture.getByRole('button', { name: 'Transfer with Integration provider' }));
      await fixture.press(await fixture.getByRole('radio', {
        name: 'Receives messages even while this machine is offline',
        state: { checked: false },
      }));
      await fixture.press(await fixture.getByRole('button', { name: 'Confirm transfer' }));
      await vi.waitFor(() => {
        expect(executeAction.mock.calls.map(([request]) => request.action)).toEqual([
          CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionPrepare,
          CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionTransfer,
          'plugin.webhook.endpoint.ensure',
        ]);
      });
      // The ambiguity is presented truthfully: no definite provider-failure
      // banner replaces the unknown outcome, and the retained attempt stays
      // visible so the deliberate second press can rejoin it.
      await vi.waitFor(() => {
        expect(document.querySelector(
          '[data-testid="channels-connection-transfer-endpoint-ensure-outcome-unknown"]',
        )).not.toBeNull();
      });
      expect(document.querySelector(
        '[data-testid="channels-connection-transfer-result-failed"]',
      )).toBeNull();
      await expect(fixture.getByRole('button', {
        name: 'Transfer with Integration provider',
        state: { disabled: true },
      })).resolves.toBeDefined();
      await expect(fixture.getByRole('radio', {
        name: 'Receives messages even while this machine is offline',
        state: { checked: true, disabled: true },
      })).resolves.toBeDefined();
      await expect(fixture.getByRole('button', {
        name: 'Confirm transfer',
      })).resolves.toBeDefined();

      await fixture.press(await fixture.getByRole('button', { name: 'Confirm transfer' }));
      // The deliberate second press skips the no-continuation transfer: it
      // rejoins the retained ensure directly, then runs only the final
      // continuation transfer.
      await vi.waitFor(() => expect(executeAction.mock.calls.map(([request]) => request.action)).toEqual([
        CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionPrepare,
        CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionTransfer,
        'plugin.webhook.endpoint.ensure',
        'plugin.webhook.endpoint.ensure',
        CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionTransfer,
      ]));
      // Exactly one endpoint key was ever minted, and both ensure dispatches
      // carry those same retained bytes, so the rejoin addresses the original
      // endpoint effect rather than a second attempt.
      expect(mintedEndpointKeys).toBe(1);
      expect(ensureInputs).toHaveLength(2);
      expect(ensureInputs[0]).toEqual(endpointEnsureInput);
      expect(ensureInputs[1]).toEqual(endpointEnsureInput);
      await vi.waitFor(() => {
        expect(document.querySelector(
          '[data-testid="channels-connection-transfer-endpoint-ensure-outcome-unknown"]',
        )).toBeNull();
      });
    } finally {
      await fixture.dispose();
    }
  });

  it('offers transfer only through the current connection provider contribution', async () => {
    const selectActionInput = vi.fn(async (_input: PluginUiTestkitSelectActionInputInput) => ({ kind: 'cancelled' as const }));
    const executeAction = vi.fn(async () => {
      throw new Error('A cancelled provider selection must not execute a transfer Action.');
    });
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'fixture-instance-125', mountNonce: 'fixture-mount-125' },
      authorPlugin: { id: 'happier.channels', version: '0.0.0' },
      surface: renderSurface,
      surfaceContext: createChannelsSurfaceContextWithForeignProvider(),
      adapter: createChannelsSemanticAdapter(),
      handlers: {
        selectActionInput,
        executeAction,
        readResource: bindingResourceReader(),
      },
    });

    try {
      await pressButtonWithAccessibleLabelFragment('Example conversation');
      await fixture.press(await fixture.getByRole('button', { name: 'Transfer connection' }));

      expect(document.querySelectorAll('[data-testid^="channels-connection-transfer-provider-"]')).toHaveLength(1);
      await fixture.press(await fixture.getByRole('button', { name: 'Transfer with Integration provider' }));
      await vi.waitFor(() => {
        expect(selectActionInput).toHaveBeenCalledWith({
          request: { operation: providerSetupOperation },
          signal: expect.anything(),
        });
      });
      expect(executeAction).not.toHaveBeenCalled();
    } finally {
      await fixture.dispose();
    }
  });

  it('offers a durable-push connection transfer that preserves its transport', async () => {
    const submittedProviderSetup = {
      kind: 'submitted' as const,
      action: providerSetupOperation.action,
      input: { repository: 'happier-dev/happier' },
      selection: {
        target: {
          pluginId: 'happier.channels',
          sourceCustody: { kind: 'development', registeredRootId: 'channels-target-root-a' } as const,
        },
        point: providerSetupOperation.point,
        contributor: providerPortableContributor(),
      },
      connectedAccount: { kind: 'none' as const },
      presentation: { connectedAccountLabel: null, machineDisplayName: null },
    };
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'fixture-instance-126', mountNonce: 'fixture-mount-126' },
      authorPlugin: { id: 'happier.channels', version: '0.0.0' },
      surface: renderSurface,
      surfaceContext: createChannelsSurfaceContext(),
      adapter: createChannelsSemanticAdapter(),
      handlers: {
        selectActionInput: async () => submittedProviderSetup,
        executeAction: async ({ action }) => {
          if (action === CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionPrepare) {
            return {
              kind: 'ready', supportedTransports: ['checkpointedPull', 'durablePush'],
              recommendedTransport: 'durablePush', overlapSafety: 'safe',
              replayContinuity: 'checkpointed', outboundTextLimit: { maximum: 4_000, unit: 'unicodeCodePoints' },
            };
          }
          throw new Error('No transfer confirmation was pressed.');
        },
        readResource: async ({ resource }) => {
          const localId = resourceFixtureLocalId(resource);
          if (localId === BINDINGS_RESOURCE.localId) return bindingsResource;
          if (localId === CONNECTIONS_RESOURCE.localId) return connectionsResourceForTransport('durablePush');
          throw new Error(`Unexpected Resource: ${localId}`);
        },
      },
    });

    try {
      await pressButtonWithAccessibleLabelFragment('Example conversation');
      await expect(fixture.getByRole('button', { name: 'Transfer connection' })).resolves.toBeDefined();
      await fixture.press(await fixture.getByRole('button', { name: 'Transfer connection' }));
      await fixture.press(await fixture.getByRole('button', { name: 'Transfer with Integration provider' }));
      await vi.waitFor(() => {
        expect(document.querySelector('[data-testid="channels-connection-transfer-transport"]'))
          .not.toBeNull();
      });
      await expect(fixture.getByRole('radio', {
        name: 'Receives messages even while this machine is offline',
        state: { checked: true },
      })).resolves.toBeDefined();
    } finally {
      await fixture.dispose();
    }
  });

  it('deletes a current connection through the canonical mounted Action', async () => {
    const executeAction = vi.fn(async ({ action }: PluginUiTestkitExecuteActionInput) => {
      if (action === CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionDelete) {
        return {
          kind: 'deletePending',
          connectionId: 'connection-1',
          revision: 2,
          authorityEpoch: 2,
        };
      }
      throw new Error(`Unexpected mounted Action: ${String(action)}`);
    });
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'fixture-instance-127', mountNonce: 'fixture-mount-127' },
      authorPlugin: { id: 'happier.channels', version: '0.0.0' },
      surface: renderSurface,
      surfaceContext: createChannelsSurfaceContext(),
      adapter: createChannelsSemanticAdapter(),
      handlers: {
        selectActionInput: async () => ({ kind: 'cancelled' as const }),
        executeAction,
        readResource: async ({ resource }) => {
          const localId = resourceFixtureLocalId(resource);
          if (localId === BINDINGS_RESOURCE.localId) return bindingsResource;
          if (localId === CONNECTIONS_RESOURCE.localId) return connectionsResource;
          throw new Error(`Unexpected Resource: ${localId}`);
        },
      },
    });

    try {
      await pressButtonWithAccessibleLabelFragment('Example conversation');

      await pressByTestId('channels-connection-delete');

      await vi.waitFor(() => {
        expect(executeAction).toHaveBeenCalledWith(expect.objectContaining({
          action: CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionDelete,
          input: {
            connectionId: 'connection-1',
            expectedRevision: 1,
          },
        }));
      });
    } finally {
      await fixture.dispose();
    }
  });

  it.each(['connection', 'conversation'] as const)('dismisses an informational history notice on the %s through the shared Action and rereads the cleared gap', async (surface) => {
    const firstGap = connectionsResourceWithHistoryGap({
      revision: 4,
      authorityEpoch: 2,
      reportedAt: 1_700_000_000_000,
      reason: 'providerHistoryUnavailable',
      digestDigit: 'e',
    });
    let connectionReads = 0;
    let noticeDismissed = false;
    const focusTarget = vi.fn((target: unknown): boolean => {
      const focus = (target as Readonly<{ focus?: () => void }> | null)?.focus;
      if (typeof focus !== 'function') return false;
      focus.call(target);
      return true;
    });
    const presentationHost = {
      focusTarget,
      renderMarkdown: () => null,
      renderCodeBlock: () => null,
      renderPopover: () => null,
      renderIcon: () => null,
    } satisfies PluginUiPresentationHost;
    const executeAction = vi.fn(async (request: PluginUiTestkitExecuteActionInput) => {
      expect(request.action).toBe(CONVERSATION_MANAGEMENT_ACTION_IDS_V1.streamNoticeDismiss);
      expect(request.input).toEqual({ connectionId: 'connection-1', expectedRevision: 4 });
      noticeDismissed = true;
      return {
        kind: 'noticeDismissed',
        connectionId: 'connection-1',
        revision: 5,
        authorityEpoch: 2,
      };
    });
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'fixture-instance-128', mountNonce: 'fixture-mount-128' },
      authorPlugin: { id: 'happier.channels', version: '0.0.0' },
      surface: renderSurface,
      surfaceContext: surface === 'conversation' ? createChannelsPageSurfaceContext() : createChannelsSurfaceContext(),
      ...(surface === 'conversation' ? { subPath: 'binding-1' } : {}),
      adapter: createChannelsSemanticAdapter(emptyDataClient, presentationHost),
      handlers: {
        selectActionInput: async () => ({ kind: 'cancelled' as const }),
        executeAction,
        readResource: async ({ resource }) => {
          const localId = resourceFixtureLocalId(resource);
          if (localId === BINDINGS_RESOURCE.localId) return bindingsResource;
          if (localId === CONNECTIONS_RESOURCE.localId) {
            connectionReads += 1;
            return noticeDismissed ? connectionsResource : firstGap;
          }
          throw new Error(`Unexpected Resource: ${localId}`);
        },
      },
    });

    try {
      if (surface === 'connection') await pressButtonWithAccessibleLabelFragment('Example conversation');
      expect(document.querySelector('[data-testid="channels-history-gap-disclosure"]')?.getAttribute('role')).toBe('status');
      expect(document.querySelectorAll('[data-testid="channels-history-gap-disclosure"]')).toHaveLength(1);
      expect(document.querySelector('[data-testid="channels-history-gap-disclosure"]')?.textContent)
        .toContain('Older messages may not have been imported');
      await pressByTestId('channels-history-gap-notice-dismiss');
      await vi.waitFor(() => {
        expect(executeAction).toHaveBeenCalledTimes(1);
        expect(connectionReads).toBeGreaterThanOrEqual(2);
      });
      expect(document.querySelector('[data-testid="channels-history-gap-notice-dismiss"]')).toBeNull();
      expect(document.querySelector('[data-testid="channels-history-gap-disclosure"]')).toBeNull();
    } finally {
      await fixture.dispose();
    }
  });

  it('uses the refreshed history-gap Resource revision for the next shared Action', async () => {
    let current = connectionsResourceWithHistoryGap({
      revision: 4,
      authorityEpoch: 2,
      reportedAt: 1_700_000_000_000,
      reason: 'providerHistoryUnavailable',
      digestDigit: 'e',
    });
    // The surface catches a rejected Action, so an assertion inside this mock could
    // never fail the test. The dispatched revision is asserted from the recorded call.
    const executeAction = vi.fn(async (_request: PluginUiTestkitExecuteActionInput) => (
      { kind: 'noticeDismissed', connectionId: 'connection-1', revision: 6, authorityEpoch: 3 }
    ));
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'fixture-instance-129', mountNonce: 'fixture-mount-129' },
      authorPlugin: { id: 'happier.channels', version: '0.0.0' },
      surface: renderSurface,
      surfaceContext: createChannelsSurfaceContext(),
      adapter: createChannelsSemanticAdapter(),
      handlers: {
        selectActionInput: async () => ({ kind: 'cancelled' as const }),
        executeAction,
        readResource: async ({ resource }) => {
          const localId = resourceFixtureLocalId(resource);
          if (localId === BINDINGS_RESOURCE.localId) return bindingsResource;
          if (localId === CONNECTIONS_RESOURCE.localId) return current;
          throw new Error(`Unexpected Resource: ${localId}`);
        },
      },
    });

    try {
      await pressButtonWithAccessibleLabelFragment('Example conversation');
      current = connectionsResourceWithHistoryGap({
        revision: 5,
        authorityEpoch: 3,
        reportedAt: 1_700_000_001_000,
        reason: 'applicationAdmissionLost',
        digestDigit: 'f',
      });
      await pressByTestId('channels-detail-resource-refresh');
      expect(executeAction).not.toHaveBeenCalled();

      await pressByTestId('channels-history-gap-notice-dismiss');
      await vi.waitFor(() => expect(executeAction).toHaveBeenCalledTimes(1));
      expect(executeAction.mock.calls[0]?.[0].action)
        .toBe(CONVERSATION_MANAGEMENT_ACTION_IDS_V1.streamNoticeDismiss);
      expect(executeAction.mock.calls[0]?.[0].input)
        .toEqual({ connectionId: 'connection-1', expectedRevision: 5 });
    } finally {
      await fixture.dispose();
    }
  });

  it('locks an unknown notice-dismissal outcome until a fresh Resource reread clears the observed gap', async () => {
    const firstGap = connectionsResourceWithHistoryGap({
      revision: 4,
      authorityEpoch: 2,
      reportedAt: 1_700_000_000_000,
      reason: 'providerHistoryUnavailable',
      digestDigit: 'e',
    });
    let connectionReads = 0;
    let dismissalOutcomeUnknown = false;
    let resolveReread: ((value: ResourceContent) => void) | undefined;
    const executeAction = vi.fn(async () => {
      dismissalOutcomeUnknown = true;
      throw new PluginError({ code: 'timeout', message: 'The notice dismissal may have reached the owner.' });
    });
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'fixture-instance-130', mountNonce: 'fixture-mount-130' },
      authorPlugin: { id: 'happier.channels', version: '0.0.0' },
      surface: renderSurface,
      surfaceContext: createChannelsSurfaceContext(),
      adapter: createChannelsSemanticAdapter(),
      handlers: {
        selectActionInput: async () => ({ kind: 'cancelled' as const }),
        executeAction,
        readResource: async ({ resource }) => {
          const localId = resourceFixtureLocalId(resource);
          if (localId === BINDINGS_RESOURCE.localId) return bindingsResource;
          if (localId === CONNECTIONS_RESOURCE.localId) {
            connectionReads += 1;
            if (!dismissalOutcomeUnknown) return firstGap;
            return await new Promise<ResourceContent>((resolve) => {
              resolveReread = resolve;
            });
          }
          throw new Error(`Unexpected Resource: ${localId}`);
        },
      },
    });

    try {
      await pressButtonWithAccessibleLabelFragment('Example conversation');
      await pressByTestId('channels-history-gap-notice-dismiss');
      await vi.waitFor(() => expect(document.querySelector('[data-testid="channels-history-gap-notice-outcome-unknown"]')).not.toBeNull());
      await expect(fixture.findByRole('button', {
        name: 'Dismiss notice',
        state: { disabled: true },
      })).resolves.toBeDefined();

      const readsBeforeReconcile = connectionReads;
      await pressByTestId('channels-history-gap-notice-outcome-unknown-reconcile');
      await vi.waitFor(() => {
        expect(connectionReads).toBeGreaterThan(readsBeforeReconcile);
        expect(resolveReread).toBeTypeOf('function');
      });
      expect(executeAction).toHaveBeenCalledTimes(1);

      await act(async () => {
        resolveReread?.(connectionsResource);
      });
      expect(document.querySelector('[data-testid="channels-history-gap-notice-dismiss"]')).toBeNull();
      expect(document.querySelector('[data-testid="channels-history-gap-disclosure"]')).toBeNull();
      expect(executeAction).toHaveBeenCalledTimes(1);
    } finally {
      await fixture.dispose();
    }
  });

  it.each([
    [oldTransportStopUnconfirmedConnectionsResource, 1],
    [endpointRetargetOwedConnectionsResource, 1],
    [acceptedPossibleLossConnectionsResource, 2],
  ])('allows direct deletion without a stop-custody or accept-loss journey (%#)', async (connections, expectedRevision) => {
    const executeAction = vi.fn(async ({ action }: PluginUiTestkitExecuteActionInput) => {
      if (action === CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionDelete) {
        return {
          kind: 'deleteFinalizing',
          connectionId: 'connection-1',
          revision: 2,
          authorityEpoch: 2,
          acceptedPossibleLoss: false,
        };
      }
      throw new Error(`Unexpected mounted Action: ${String(action)}`);
    });
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'fixture-instance-131', mountNonce: 'fixture-mount-131' },
      authorPlugin: { id: 'happier.channels', version: '0.0.0' },
      surface: renderSurface,
      surfaceContext: createChannelsSurfaceContext(),
      adapter: createChannelsSemanticAdapter(),
      handlers: {
        selectActionInput: async () => ({ kind: 'cancelled' as const }),
        executeAction,
        readResource: async ({ resource }) => {
          const localId = resourceFixtureLocalId(resource);
          if (localId === BINDINGS_RESOURCE.localId) return bindingsResource;
          if (localId === CONNECTIONS_RESOURCE.localId) return connections;
          throw new Error(`Unexpected Resource: ${localId}`);
        },
      },
    });

    try {
      await pressButtonWithAccessibleLabelFragment('Example conversation');

      expect(document.querySelector('[data-testid="channels-old-transport-stop-unconfirmed"]')).toBeNull();
      expect(document.querySelector('[data-testid="channels-connection-endpoint-retarget-owed"]')).toBeNull();
      expect(document.querySelector('[data-testid="channels-connection-repair-endpoint"]')).toBeNull();
      expect(document.querySelector('[data-testid="channels-connection-accept-loss"]')).toBeNull();
      expect(document.querySelector('[data-testid="channels-connection-delete"]')).not.toBeNull();
      await pressByTestId('channels-connection-delete');

      await vi.waitFor(() => {
        expect(executeAction).toHaveBeenCalledWith(expect.objectContaining({
          action: CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionDelete,
          input: {
            connectionId: 'connection-1',
            expectedRevision,
          },
        }));
      });
    } finally {
      await fixture.dispose();
    }
  });


});

describe('Channels offline Account-local binding policy', () => {
  describe.each([
    { operation: 'connection', action: CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionUpdate },
    { operation: 'binding', action: CONVERSATION_MANAGEMENT_ACTION_IDS_V1.bindingSetEnabled },
    { operation: 'accept', action: CONVERSATION_MANAGEMENT_ACTION_IDS_V1.deliveryResolve },
    { operation: 'discard', action: CONVERSATION_MANAGEMENT_ACTION_IDS_V1.deliveryResolve },
  ] as const)('$operation admission', ({ operation, action }) => {
    it.each(['Off', 'Ask', 'Allow'] as const)('honors the host %s decision before an offline Collection write', async policy => {
      const account = createOfflineChannelStateFixture();
      const ambiguous = offlineAmbiguousDeliveryRow();
      if (operation === 'accept' || operation === 'discard') account.deliveries.rows.set(ambiguous.rowId, ambiguous);
      let answer: ((admitted: boolean) => void) | undefined;
      // Admission crosses the host IPC boundary. Saved-policy evaluation stays
      // with the real host; this surface consumes its refusal/approval result.
      const admitAction = vi.fn<NonNullable<PluginUiTestkitHostHandlers['admitAction']>>(async () => {
        if (policy === 'Off') throw new PluginError({ code: 'action_disabled' });
        if (policy === 'Ask') return await new Promise<boolean>(resolve => { answer = resolve; });
        return true;
      });
      const fixture = await createPluginUiTestkit({
        identity: { instanceId: 'channels-offline-admission', mountNonce: 'channels-offline-admission' },
        authorPlugin: { id: 'happier.channels', version: '0.0.0' },
        surface: renderSurface,
        surfaceContext: operation === 'binding' ? createChannelsPageSurfaceContext() : createChannelsSurfaceContext(),
        ...(operation === 'binding' ? { subPath: 'binding-1' } : {}),
        adapter: createChannelsSemanticAdapter(account.dataClient),
        handlers: { admitAction },
      });
      const row = () => operation === 'connection'
        ? account.collection.rows.get('connection-1')
        : operation === 'binding'
          ? account.collection.rows.get('binding-1')
          : account.deliveries.rows.get(ambiguous.rowId);
      const originalRevision = row()?.revision;
      const submit = async () => {
        if (operation === 'connection') {
          await pressByTestId('channels-connection-save');
        } else if (operation === 'binding') {
          await fixture.press(await fixture.findByRole('button', { name: 'Turn on' }));
        } else {
          await pressByTestId(`channels-delivery-resolution-${operation}-${OFFLINE_AMBIGUOUS_CUSTODY_ID}`);
        }
      };
      try {
        if (operation === 'connection') {
          await vi.waitFor(() => expect(document.querySelector('[data-testid="channels-connection-connection-1"]')).not.toBeNull());
          await pressByTestId('channels-connection-connection-1');
          await pressByTestId('channels-connection-enabled');
        } else if (operation !== 'binding') {
          await pressButtonWithAccessibleLabelFragment('Example conversation');
          await vi.waitFor(() => expect(document.querySelector('[data-testid="channels-delivery-resolution-controls"]')).not.toBeNull());
          await openDeliveryDecision(OFFLINE_AMBIGUOUS_CUSTODY_ID);
        }
        await submit();
        if (policy !== 'Allow') {
          expect(row()?.revision).toBe(originalRevision);
          expect(account.collection.batches).toHaveLength(0);
        }
        await vi.waitFor(() => expect(admitAction).toHaveBeenCalledWith(expect.objectContaining({ action })));
        if (policy === 'Ask') {
          await act(async () => { answer?.(false); });
          expect(row()?.revision).toBe(originalRevision);
          await submit();
          await vi.waitFor(() => expect(admitAction).toHaveBeenCalledTimes(2));
          expect(row()?.revision).toBe(originalRevision);
          await act(async () => { answer?.(true); });
        }
        if (policy !== 'Off') {
          await vi.waitFor(() => expect(row()?.revision).toBe((originalRevision ?? 0) + 1));
          expect(row()?.value.payload).toMatchObject(operation === 'connection'
            ? { enabled: false }
            : operation === 'binding'
              ? { enabled: true }
              : { state: 'resolved', outcome: operation === 'accept' ? 'accepted' : 'discarded' });
        }
      } finally { await fixture.dispose(); }
    });
  });

  it('does not present an unread Resource as retained binding details after its first read fails', async () => {
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'channels-unread', mountNonce: 'channels-unread' },
      authorPlugin: { id: 'happier.channels', version: '0.0.0' },
      surface: renderSurface,
      surfaceContext: createChannelsPageSurfaceContext(),
      adapter: createChannelsSemanticAdapter(emptyDataClient),
      handlers: { readResource: async () => {
        throw new PluginError({ code: 'unavailable', message: 'Resource transport is unavailable' });
      } },
    });
    try {
      await vi.waitFor(() => expect(document.querySelector('[data-testid="channels-bindings-error"]')).not.toBeNull());
      expect(document.querySelector('[data-testid="channels-bindings-resource-stale"]')).toBeNull();
    } finally { await fixture.dispose(); }
  });
  it.each([false, true])('explains unavailable linking and keeps Account conversations reachable (Resource method installed: %s)', async (resourceMethodInstalled) => {
    const account = createOfflineChannelStateFixture();
    const openedSurfaces: string[] = [];
    const unavailableMessage = 'NLDW6-3-11-20 · f759 is unavailable for this operation.';
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'channels-offline-link', mountNonce: 'channels-offline-link' },
      authorPlugin: { id: 'happier.channels', version: '0.0.0' },
      surface: renderSurface,
      surfaceContext: createChannelsPageSurfaceContext(),
      subPath: 'link',
      adapter: createChannelsSemanticAdapter(account.dataClient),
      handlers: {
        ...(resourceMethodInstalled ? { readResource: async () => {
          throw new PluginError({ code: 'unavailable', message: unavailableMessage, retryable: false,
            diagnostics: [{ code: 'host_api_method_unavailable:readResource', severity: 'error' }] });
        } } : {}),
        openSurface: ({ subPath }) => { openedSurfaces.push(subPath ?? ''); },
      },
    });
    try {
      await vi.waitFor(() => expect(document.querySelector('[data-testid="channels-link-unavailable"]')).not.toBeNull());
      if (resourceMethodInstalled) await expect(fixture.getByText(unavailableMessage)).resolves.toBeDefined();
      await fixture.press(await fixture.getByRole('button', { name: 'Show all conversations' }));
      expect(openedSurfaces).toEqual(['']);
      expect(account.collection.batches).toHaveLength(0);
    } finally { await fixture.dispose(); }
  });

  it.each([
    { enabled: false, narrowing: false },
    { enabled: true, narrowing: false },
    { enabled: true, narrowing: true },
  ])('saves host-admitted Account policy without a second local confirmation (enabled: $enabled, narrowing: $narrowing)', async ({ enabled, narrowing }) => {
    const account = createOfflineChannelStateFixture();
    const retained = offlineBindingRow();
    account.collection.rows.set('binding-1', {
      ...retained,
      value: { ...retained.value, payload: { ...retained.value.payload, enabled } },
    });
    // Host admission is the IPC boundary. This fixture supplies its settled
    // answer; the host owner's tests decide whether that answer needs a dialog.
    const admitAction = vi.fn(async () => true);
    const confirm = vi.fn(async () => false);
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'channels-local-policy-admission', mountNonce: 'channels-local-policy-admission' },
      authorPlugin: { id: 'happier.channels', version: '0.0.0' },
      surface: renderSurface,
      surfaceContext: createChannelsPageSurfaceContext(),
      subPath: 'binding-1',
      adapter: createChannelsSemanticAdapter(account.dataClient, undefined, { overlays: true }),
      handlers: { admitAction, confirm },
    });
    try {
      await fixture.press(await fixture.getByRole('button', { name: 'Edit binding' }));
      if (narrowing) await chooseFieldOption('Incoming messages', 'Direct mentions only');
      else await fixture.press(await fixture.getByRole('radio', {
        name: 'Eligible refusals', state: { checked: false },
      }));
      await fixture.press(await fixture.getByRole('button', { name: 'Save binding' }));
      await vi.waitFor(() => expect(account.collection.rows.get('binding-1')?.revision).toBe(6));
      expect(confirm).not.toHaveBeenCalled();
      expect(admitAction).toHaveBeenCalledWith(expect.objectContaining({
        action: CONVERSATION_MANAGEMENT_ACTION_IDS_V1.bindingUpdate,
        input: expect.objectContaining({
          bindingId: 'binding-1', expectedRevision: 5, enabled,
          inputMode: narrowing ? 'directMentionsOnly' : 'allAllowedMessages',
          senderFeedback: narrowing ? 'off' : 'eligibleRefusals',
        }),
      }));
      expect(account.collection.batches).toHaveLength(1);
    } finally { await fixture.dispose(); }
  });

  it('admits widening Account-local policy through the host before the shared transition and CAS owner', async () => {
    const account = createOfflineChannelStateFixture();
    const retained = offlineBindingRow();
    account.collection.rows.set('binding-1', {
      ...retained,
      value: { ...retained.value, payload: { ...retained.value.payload, enabled: true } },
    });
    const decisions: unknown[] = [];
    let answer: ((accepted: boolean) => void) | undefined;
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'fixture-instance-136', mountNonce: 'fixture-mount-136' },
      authorPlugin: { id: 'happier.channels', version: '0.0.0' },
      surface: renderSurface,
      surfaceContext: createChannelsPageSurfaceContext(),
      subPath: 'binding-1',
      adapter: createChannelsSemanticAdapter(account.dataClient, undefined, { overlays: true }),
      handlers: {
        admitAction: async request => {
          decisions.push(request);
          return await new Promise<boolean>(resolve => { answer = resolve; });
        },
        selectActionInput: async () => ({ kind: 'cancelled' as const }),
      },
    });

    try {
      // Proves the cold-offline read path reached the canonical Account rows
      // before any assertion about what the surface offers to edit.
      await expect(fixture.getByRole('button', { name: 'Edit binding' })).resolves.toBeDefined();
      await fixture.press(await fixture.getByRole('button', { name: 'Edit binding' }));
      await chooseFieldOption('Incoming messages', 'Direct mentions only');
      await fixture.press(await fixture.getByRole('radio', {
        name: 'Eligible refusals',
        state: { checked: false },
      }));
      await fixture.press(await fixture.getByRole('switch', {
        name: 'Allow bot senders',
        state: { checked: false },
      }));
      await fixture.press(await fixture.getByRole('button', { name: 'Save binding' }));
      await vi.waitFor(() => expect(decisions).toHaveLength(1));
      expect(decisions[0]).toMatchObject({
        action: CONVERSATION_MANAGEMENT_ACTION_IDS_V1.bindingUpdate,
        input: { bindingId: 'binding-1', expectedRevision: 5, enabled: true, allowBotSenders: true },
      });
      expect(account.collection.batches).toHaveLength(0);
      await act(async () => { answer?.(false); });
      expect(account.collection.batches).toHaveLength(0);
      await fixture.press(await fixture.getByRole('button', { name: 'Save binding' }));
      await vi.waitFor(() => expect(decisions).toHaveLength(2));
      await act(async () => { answer?.(true); });

      await vi.waitFor(() => {
        expect(account.collection.batches).toHaveLength(1);
      });
      expect(account.collection.rows.get('binding-1')?.value.payload).toMatchObject({
        inputMode: 'directMentionsOnly',
        senderFeedback: 'eligibleRefusals',
        allowBotSenders: true,
        // The shared transition owns the epoch: sender feedback alone never
        // advances it, the input-mode and bot-sender changes do exactly once.
        authorityEpoch: 2,
        enabled: true,
      });
      expect(document.querySelector('[data-testid="channels-binding-saved-pending-machine-reconciliation"]'))
        .not.toBeNull();
      // The saved confirmation must survive the authoritative Account reread
      // that follows it, not be cleared by that reread.
      await vi.waitFor(() => {
        expect(document.querySelector('[data-testid="channels-account-local-binding-updated"]')).not.toBeNull();
      });
      expect(account.collection.rows.get('binding-1')?.revision).toBe(6);
    } finally {
      await fixture.dispose();
    }
  });

  it('settles never-expiring delivery ambiguity offline through the provider-independent custody owner', async () => {
    const account = createOfflineChannelStateFixture();
    const ambiguous = offlineAmbiguousDeliveryRow();
    account.deliveries.rows.set(ambiguous.rowId, ambiguous);
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'fixture-instance-137', mountNonce: 'fixture-mount-137' },
      authorPlugin: { id: 'happier.channels', version: '0.0.0' },
      surface: renderSurface,
      surfaceContext: createChannelsSurfaceContext(),
      adapter: createChannelsSemanticAdapter(account.dataClient),
      handlers: {
        admitAction: async () => true,
        selectActionInput: async () => ({ kind: 'cancelled' as const }),
      },
    });

    try {
      await pressButtonWithAccessibleLabelFragment('Example conversation');
      await vi.waitFor(() => {
        expect(document.querySelector('[data-testid="channels-delivery-resolution-controls"]')).not.toBeNull();
      });
      await openDeliveryDecision(OFFLINE_AMBIGUOUS_CUSTODY_ID);
      await pressByTestId(`channels-delivery-resolution-discard-${OFFLINE_AMBIGUOUS_CUSTODY_ID}`);

      await vi.waitFor(() => {
        expect(account.deliveries.rows.get(OFFLINE_AMBIGUOUS_CUSTODY_ID)?.value.payload)
          .toMatchObject({ state: 'resolved', outcome: 'discarded' });
      });
      expect(account.deliveries.rows.get(OFFLINE_AMBIGUOUS_CUSTODY_ID)?.revision).toBe(4);
    } finally {
      await fixture.dispose();
    }
  });

  it('shows the archived destination without offering to resend retained delivery', async () => {
    const account = createOfflineChannelStateFixture();
    const recoverable = offlineArchiveRecoverableDeliveryRow();
    account.deliveries.rows.set(recoverable.rowId, recoverable);
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'fixture-instance-138', mountNonce: 'fixture-mount-138' },
      authorPlugin: { id: 'happier.channels', version: '0.0.0' },
      surface: renderSurface,
      surfaceContext: createChannelsSurfaceContext(),
      adapter: createChannelsSemanticAdapter(account.dataClient),
      handlers: {
        selectActionInput: async () => ({ kind: 'cancelled' as const }),
      },
    });

    try {
      await pressButtonWithAccessibleLabelFragment('Example conversation');
      await openDeliveryDecision(OFFLINE_AMBIGUOUS_CUSTODY_ID);
      await vi.waitFor(() => {
        expect(document.querySelector(
          `[data-testid="channels-delivery-resolution-retry-${OFFLINE_AMBIGUOUS_CUSTODY_ID}"]`,
        )).toBeNull();
      });
      // The two terminal settlements are for a possible external effect; an
      // authoritative no-effect refusal must not offer them.
      expect(document.querySelector(
        `[data-testid="channels-delivery-resolution-accept-${OFFLINE_AMBIGUOUS_CUSTODY_ID}"]`,
      )).toBeNull();
      expect(account.deliveries.rows.get(OFFLINE_AMBIGUOUS_CUSTODY_ID)).toEqual(recoverable);
    } finally {
      await fixture.dispose();
    }
  });

  it('does not offer provider resolution, target changes, or deletion from the offline binding editor', async () => {
    const account = createOfflineChannelStateFixture();
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'fixture-instance-139', mountNonce: 'fixture-mount-139' },
      authorPlugin: { id: 'happier.channels', version: '0.0.0' },
      surface: renderSurface,
      surfaceContext: createChannelsPageSurfaceContext(),
      subPath: 'binding-1',
      adapter: createChannelsSemanticAdapter(account.dataClient),
      handlers: {
        selectActionInput: async () => ({ kind: 'cancelled' as const }),
      },
    });

    try {
      // Proves the cold-offline read path reached the canonical Account rows
      // before any assertion about what the surface offers to edit.
      await expect(fixture.getByRole('button', { name: 'Turn on' })).resolves.toBeDefined();
      await fixture.press(await fixture.getByRole('button', { name: 'Edit binding' }));
      await expect(fixture.queryByRole('button', {
        name: 'Re-resolve conversation and allowed senders',
      })).resolves.toBeUndefined();
      await expect(fixture.queryByRole('button', { name: 'Change target' })).resolves.toBeUndefined();
      await expect(fixture.queryByRole('button', { name: 'Unlink…' })).resolves.toBeUndefined();
      expect(account.collection.batches).toHaveLength(0);
    } finally {
      await fixture.dispose();
    }
  });

  it('offers and saves the Account-decidable Session target policy from the offline binding editor', async () => {
    const account = createOfflineChannelStateFixture();
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'fixture-instance-140', mountNonce: 'fixture-mount-140' },
      authorPlugin: { id: 'happier.channels', version: '0.0.0' },
      surface: renderSurface,
      surfaceContext: createChannelsPageSurfaceContext(),
      subPath: 'binding-1',
      adapter: createChannelsSemanticAdapter(account.dataClient),
      handlers: {
        admitAction: async () => true,
        selectActionInput: async () => ({ kind: 'cancelled' as const }),
      },
    });

    try {
      await fixture.press(await fixture.getByRole('button', { name: 'Edit binding' }));
      // Rotating to a DIFFERENT target still needs the machine's Session and
      // Automation catalogs, so the identity chooser stays absent.
      await expect(fixture.queryByRole('button', { name: 'Change target' })).resolves.toBeUndefined();

      // The Session target POLICY is decided entirely from the Account, so it
      // is offered here exactly as the daemon-backed editor offers it.
      await fixture.press(await fixture.getByRole('radio', {
        name: 'Mirror Session',
        state: { checked: false },
      }));
      // Consequences stay visible in the editor; the Action policy admits Save.
      expect(document.body.textContent).toContain('machine-1');
      expect(document.body.textContent).toContain('Session delivery');
      await fixture.press(await fixture.getByRole('button', { name: 'Save binding' }));

      await vi.waitFor(() => {
        expect(account.collection.batches).toHaveLength(1);
      });
      expect(account.collection.rows.get('binding-1')?.value.payload).toMatchObject({
        target: {
          kind: 'session',
          sessionId: 'session-1',
          policy: { deliveryMode: 'mirrorSession', permissionCeiling: 'read-only' },
        },
        // A target-only edit carries the rest of the retained policy forward.
        inputMode: 'allAllowedMessages',
        inboundDebounceMs: 750,
      });
    } finally {
      await fixture.dispose();
    }
  });

  it('preserves named approval principals when approvals are disabled and re-enabled', async () => {
    const account = createOfflineChannelStateFixture();
    const retained = offlineBindingRow();
    account.collection.rows.set(retained.rowId, {
      ...retained,
      value: {
        ...retained.value,
        payload: {
          ...retained.value.payload,
          target: {
            ...retained.value.payload.target,
            policy: {
              ...retained.value.payload.target.policy,
              approvals: {
                kind: 'enabled',
                maximumScope: 'request',
                principalIds: ['person-1'],
              },
            },
          },
        },
      },
    });
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'fixture-instance-141', mountNonce: 'fixture-mount-141' },
      authorPlugin: { id: 'happier.channels', version: '0.0.0' },
      surface: renderSurface,
      surfaceContext: createChannelsPageSurfaceContext(),
      subPath: 'binding-1',
      adapter: createChannelsSemanticAdapter(account.dataClient),
      handlers: {
        admitAction: async () => true,
        selectActionInput: async () => ({ kind: 'cancelled' as const }),
      },
    });

    try {
      await fixture.press(await fixture.getByRole('button', { name: 'Edit binding' }));
      await fixture.press(await fixture.getByRole('switch', {
        name: 'Approvals',
        state: { checked: true },
      }));
      await fixture.press(await fixture.getByRole('switch', {
        name: 'Approvals',
        state: { checked: false },
      }));
      await expect(fixture.getByRole('switch', {
        name: 'Approvals',
        state: { checked: true },
      })).resolves.toBeDefined();
      await fixture.press(await fixture.getByRole('button', { name: 'Save binding' }));

      // The final policy is byte-for-byte the retained policy. The canonical
      // Account transition suppresses the no-op rather than writing merely
      // because the editor temporarily visited the disabled state.
      expect(account.collection.batches).toHaveLength(0);
      expect(account.collection.rows.get('binding-1')?.value.payload).toMatchObject({
        target: {
          policy: {
            approvals: {
              kind: 'enabled',
              maximumScope: 'request',
              principalIds: ['person-1'],
            },
          },
        },
      });
    } finally {
      await fixture.dispose();
    }
  });

  it('keeps an ambiguous offline binding write locked until an explicit reread reconciles it', async () => {
    const account = createOfflineChannelStateFixture();
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'fixture-instance-142', mountNonce: 'fixture-mount-142' },
      authorPlugin: { id: 'happier.channels', version: '0.0.0' },
      surface: renderSurface,
      surfaceContext: createChannelsPageSurfaceContext(),
      subPath: 'binding-1',
      adapter: createChannelsSemanticAdapter(account.dataClient, undefined, { overlays: true }),
      handlers: {
        admitAction: async () => true,
        selectActionInput: async () => ({ kind: 'cancelled' as const }),
      },
    });

    try {
      await fixture.press(await fixture.getByRole('button', { name: 'Edit binding' }));
      account.collection.failNextBatchWith = new PluginError({
        code: 'plugin_collection_cancelled',
        message: 'The binding policy write was cancelled after it crossed the mutation boundary.',
      });
      await chooseFieldOption('Incoming messages', 'Direct mentions only');
      await fixture.press(await fixture.getByRole('button', { name: 'Save binding' }));

      await vi.waitFor(() => {
        expect(document.querySelector('[data-testid="channels-account-local-binding-outcome-unknown"]'))
          .not.toBeNull();
      });
      // The write is ambiguous, so no second write may be admitted from here.
      expect(account.collection.batches).toHaveLength(1);
      expect(account.collection.rows.get('binding-1')?.revision).toBe(5);

      await fixture.press(await fixture.getByRole('button', { name: 'Reload' }));
      await vi.waitFor(() => {
        expect(document.querySelector('[data-testid="channels-account-local-binding-outcome-unknown"]'))
          .toBeNull();
      });
      // The draft survives the reconciling reread, exactly as the daemon-backed
      // editor promises, and the next write is admitted against the reread row.
      expectFieldValue('Incoming messages', 'Direct mentions only');

      await fixture.press(await fixture.getByRole('button', { name: 'Save binding' }));
      await vi.waitFor(() => {
        expect(account.collection.batches).toHaveLength(2);
      });
      expect(account.collection.rows.get('binding-1')?.value.payload).toMatchObject({
        inputMode: 'directMentionsOnly',
        authorityEpoch: 2,
      });
    } finally {
      await fixture.dispose();
    }
  });

  it('keeps the ambiguous write locked when the reconciling reread itself fails', async () => {
    const account = createOfflineChannelStateFixture();
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'fixture-instance-143', mountNonce: 'fixture-mount-143' },
      authorPlugin: { id: 'happier.channels', version: '0.0.0' },
      surface: renderSurface,
      surfaceContext: createChannelsPageSurfaceContext(),
      subPath: 'binding-1',
      adapter: createChannelsSemanticAdapter(account.dataClient, undefined, { overlays: true }),
      handlers: {
        admitAction: async () => true,
        selectActionInput: async () => ({ kind: 'cancelled' as const }),
      },
    });

    try {
      await fixture.press(await fixture.getByRole('button', { name: 'Edit binding' }));
      account.collection.failNextBatchWith = new PluginError({
        code: 'plugin_collection_cancelled',
        message: 'The binding policy write was cancelled after it crossed the mutation boundary.',
      });
      await chooseFieldOption('Incoming messages', 'Direct mentions only');
      await fixture.press(await fixture.getByRole('button', { name: 'Save binding' }));

      await vi.waitFor(() => {
        expect(document.querySelector('[data-testid="channels-account-local-binding-outcome-unknown"]'))
          .not.toBeNull();
      });
      expect(account.collection.batches).toHaveLength(1);

      // The reconciling reread is also cancelled: the exact reread never proved
      // the write's outcome, so the ambiguous-write lock must stay latched and
      // no second write may be admitted from the retained bytes.
      account.collection.failNextGetWith = new PluginError({
        code: 'plugin_collection_cancelled',
        message: 'The reconciling reread was cancelled after it crossed the read boundary.',
      });
      await fixture.press(await fixture.getByRole('button', { name: 'Reload' }));

      await vi.waitFor(() => {
        expect(account.collection.batches).toHaveLength(1);
        expect(document.querySelector('[data-testid="channels-account-local-binding-outcome-unknown"]'))
          .not.toBeNull();
        expect(account.collection.failNextGetWith).toBeUndefined();
      });
      const retainedSave = document.querySelector<HTMLButtonElement>(
        '[data-testid="channels-account-local-binding-save"]',
      );
      expect(retainedSave).not.toBeNull();
      expect(retainedSave?.disabled).toBe(true);
      expect(document.querySelector('[data-testid="channels-account-local-binding-outcome-unknown"]'))
        .not.toBeNull();

      // A later reread that reaches the owner still reconciles the latch.
      await fixture.press(await fixture.getByRole('button', { name: 'Reload' }));
      await vi.waitFor(() => {
        expect(document.querySelector('[data-testid="channels-account-local-binding-outcome-unknown"]'))
          .toBeNull();
      });
      expectFieldValue('Incoming messages', 'Direct mentions only');
    } finally {
      await fixture.dispose();
    }
  });
});

describe('Channels offline Account-local sender revocation', () => {
  /** The retained binding, with a second sender that also holds `/new` authority. */
  function offlineSharedBindingRowWithTwoSenders(): OfflineChannelStateRow {
    const retained = offlineBindingRow();
    return {
      ...retained,
      value: {
        ...retained.value,
        payload: {
          endpoint: { kind: 'shared', audience: 'shared', id: 'chat-1', label: 'Example conversation' },
          target: {
            kind: 'session',
            sessionId: 'session-1',
            policy: {
              deliveryMode: 'repliesOnly',
              permissionCeiling: 'read-only',
              approvals: { kind: 'off' },
              newSession: { kind: 'enabled', principalIds: ['person-2'], recipe: {} },
            },
          },
          allowedPrincipalIds: ['person-1', 'person-2'],
          allowBotSenders: false,
          inputMode: 'directMentionsOnly',
          inboundDebounceMs: 750,
          linkPreviewPolicy: 'suppress',
          senderFeedback: 'off',
          authorityEpoch: 1,
          enabled: true,
          deletionState: 'none',
        },
      },
    };
  }

  it('revokes a retained sender offline and withdraws the authority that named them', async () => {
    const account = createOfflineChannelStateFixture();
    account.collection.rows.set('binding-1', offlineSharedBindingRowWithTwoSenders());
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'fixture-instance-144', mountNonce: 'fixture-mount-144' },
      authorPlugin: { id: 'happier.channels', version: '0.0.0' },
      surface: renderSurface,
      surfaceContext: createChannelsPageSurfaceContext(),
      subPath: 'binding-1',
      adapter: createChannelsSemanticAdapter(account.dataClient),
      handlers: {
        admitAction: async () => true,
        selectActionInput: async () => ({ kind: 'cancelled' as const }),
      },
    });

    try {
      await fixture.press(await fixture.getByRole('button', { name: 'Edit binding' }));
      // Admitting a sender needs the provider resolver, so only the withdrawal
      // half of the audience is offered here.
      await expect(fixture.queryByRole('button', {
        name: 'Re-resolve conversation and allowed senders',
      })).resolves.toBeUndefined();

      await fixture.press(await fixture.getByRole('button', { name: 'Revoke person-2' }));
      // A binding with no audience cannot persist, so the last remaining sender
      // is not revocable from here at all.
      await expect(fixture.getByRole('button', {
        name: 'Revoke person-1',
        state: { disabled: true },
      })).resolves.toBeDefined();
      await fixture.press(await fixture.getByRole('button', { name: 'Save binding' }));

      await vi.waitFor(() => {
        expect(account.collection.batches).toHaveLength(1);
      });
      expect(account.collection.rows.get('binding-1')?.value.payload).toMatchObject({
        allowedPrincipalIds: ['person-1'],
        // Leaving `/new` naming a revoked sender would both keep their
        // authority and make the shared transition owner refuse the write.
        target: { policy: { newSession: { kind: 'off' } } },
        // Audience membership changed, so in-flight authority is superseded.
        authorityEpoch: 2,
      });
    } finally {
      await fixture.dispose();
    }
  });
});

describe('Channels Session destination', () => {
  function createSessionConversationsContext(sessionId: string) {
    return createSurfaceContextFixture({
      mount: {
        kind: 'destination',
        destination: { pluginId: 'happier.channels', localId: 'session-conversations' },
        container: 'rightSidebarTab',
      },
      target: { kind: 'session', sessionId },
    });
  }

  function createSessionConversationsWidgetContext(sessionId: string) {
    return createSurfaceContextFixture({
      mount: {
        kind: 'embedded',
        role: 'widget',
        presentation: 'content',
      },
      target: { kind: 'session', sessionId },
    });
  }

  it('shows the current Session conversations from Account rows without daemon Resources', async () => {
    const account = createOfflineChannelStateFixture();
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'fixture-session-offline', mountNonce: 'fixture-session-offline' },
      authorPlugin: { id: 'happier.channels', version: '0.0.0' },
      surface: renderSurface,
      surfaceContext: createSessionConversationsContext('session-1'),
      adapter: createChannelsSemanticAdapter(account.dataClient),
    });
    try {
      await vi.waitFor(() => {
        expect(document.querySelector('[data-testid="channels-session-conversations"]')).not.toBeNull();
        expect(document.body.textContent).toContain('Example conversation');
      });
      expect(document.querySelector('[data-testid="channels-account-local-bindings"]')).toBeNull();
    } finally {
      await fixture.dispose();
    }
  });

  const sessionConversationsResource = jsonResource({
    bindings: [{
      bindingId: 'binding-session-1',
      revision: 1,
      connectionId: 'connection-1',
      endpoint: { audience: 'direct', label: 'Example conversation' },
      target: { kind: 'session', summary: 'session-under-test' },
      inputMode: 'directMentionsOnly',
      deliveryMode: 'mirrorSession',
      approval: { kind: 'off' },
      enabled: true,
      deletionState: 'none',
    }],
  }, '9');

  async function mountSessionDestination(
    sessionConversations: ResourceContent | 'unavailable',
    openSurface?: (view: unknown) => Promise<void>,
    executeAction?: PluginUiHostApi['executeAction'],
  ) {
    const surface = createSessionConversationsContext('session-under-test');
    const baseHostApi = createHostApiStub(surface);
    const hostApi = createHostApiStub(surface, {
      version: () => ({
        ...baseHostApi.version(),
        methods: ['readResource', 'openSurface', ...(executeAction === undefined ? [] : ['executeAction' as const])],
      }),
      ...(openSurface === undefined ? {} : { openSurface: openSurface as never }),
      ...(executeAction === undefined ? {} : { executeAction }),
      readResource: async (resource) => {
        const localId = resourceFixtureLocalId(resource);
        if (localId === 'session-conversations-v1') {
          if (sessionConversations === 'unavailable') {
            throw new PluginError({
              code: 'channels_session_conversations_resource_delivery_status_unavailable',
              message: 'unavailable',
            });
          }
          return sessionConversations;
        }
        if (localId === CONNECTIONS_RESOURCE.localId) return connectionsResource;
        throw new Error(`Unexpected Resource: ${localId}`);
      },
    });
    const context = Object.freeze({
      plugin: Object.freeze({ id: 'happier.channels', version: '0.0.0' }),
      surface,
      hostApi,
      signal: new AbortController().signal,
    } satisfies RenderContext);
    const entry = renderSurface(context) as ReactElement<{ dataClient?: PluginUiDataClient }>;
    return await mountThroughReactNativeWebAsync(cloneElement(entry, { dataClient: emptyDataClient }));
  }

  it('keeps the Session conversation unchanged and quiet on host confirmation decline, but shows authorization denial', async () => {
    const refusals = [
      Object.assign(new Error('denied'), { code: 'denied', diagnostics: ['plugin_action_current_intent_rejected'] }),
      Object.assign(new Error('denied'), { code: 'denied', diagnostics: ['plugin_action_scope_denied'] }),
    ];
    const executeAction = vi.fn(async () => { throw refusals.shift(); });
    const mount = await mountSessionDestination(sessionConversationsResource, undefined, executeAction);
    try {
      await vi.waitFor(() => expect(mount.container.querySelector('[data-testid="channels-session-conversation:binding-session-1"]')).not.toBeNull());
      await act(async () => { mount.container.querySelector<HTMLElement>('[data-testid="channels-session-conversation:binding-session-1"]')?.click(); });
      await act(async () => { mount.container.querySelector<HTMLElement>('[data-testid="channels-session-conversation-unlink:binding-session-1"]')?.click(); });
      await vi.waitFor(() => expect(executeAction).toHaveBeenCalledTimes(1));
      expect(mount.container.textContent).not.toContain('That didn’t go through');
      expect(mount.container.querySelector('[data-testid="channels-session-conversation:binding-session-1"]')).not.toBeNull();
      await act(async () => { mount.container.querySelector<HTMLElement>('[data-testid="channels-session-conversation-unlink:binding-session-1"]')?.click(); });
      await vi.waitFor(() => expect(mount.container.textContent).toContain('That didn’t go through'));
    } finally { mount.unmount(); }
  });

  it('renders this Session\'s external conversations instead of the Account settings vertical', async () => {
    const mount = await mountSessionDestination(sessionConversationsResource);
    try {
      await vi.waitFor(() => {
        expect(mount.container.textContent).toContain('Example conversation');
      });
      // What the conversation hears and gets is in the row, one press away (round 2, XP).
      const row = mount.container.querySelector<HTMLElement>('[data-testid="channels-session-conversation:binding-session-1"]');
      await act(async () => { row?.click(); });
      await vi.waitFor(() => {
        expect(mount.container.textContent).toContain('Mirror Session');
        expect(mount.container.textContent).toContain('Direct mentions only');
      });
      // The Settings vertical is a different destination of the same artifact.
      // Mounting it here would offer Account-wide binding mutation on a Session.
      expect(mount.container.textContent).not.toContain('Conversation connections');
      expect(mount.container.querySelector('[data-testid="channels-session-conversations"]')).not.toBeNull();
    } finally {
      mount.unmount();
    }
  });

  it('bounds the retained virtualized Session conversations to the measured widget body', async () => {
    const surface = createSessionConversationsWidgetContext('session-under-test');
    const baseHostApi = createHostApiStub(surface);
    const hostApi = createHostApiStub(surface, {
      version: () => ({ ...baseHostApi.version(), methods: ['readResource'] }),
      readResource: async (resource) => {
        const localId = resourceFixtureLocalId(resource);
        if (localId === 'session-conversations-v1') return sessionConversationsResource;
        if (localId === CONNECTIONS_RESOURCE.localId) return connectionsResource;
        throw new Error(`Unexpected Resource: ${localId}`);
      },
    });
    const context = Object.freeze({
      plugin: Object.freeze({ id: 'happier.channels', version: '0.0.0' }),
      surface,
      hostApi,
      signal: new AbortController().signal,
      widgetPresentation: { size: 'medium',
        footprint: { columns: 12, columnSpan: 6, rowSpan: 2, width: 'medium', height: 'regular' },
        geometry: { width: 350, height: 160 } },
    } satisfies RenderContext);
    const entry = renderSurface(context) as ReactElement<{ dataClient?: PluginUiDataClient }>;
    const mount = await mountThroughReactNativeWebAsync(cloneElement(entry, { dataClient: emptyDataClient }));
    try {
      await vi.waitFor(() => expect(mount.container.textContent).toContain('Example conversation'));
      const screen = mount.container.querySelector<HTMLElement>('[data-testid="channels-session-conversations"]');
      const list = mount.container.querySelector('[data-testid="channels-session-conversations-list"]');
      expect(screen).not.toBeNull();
      expect(list).not.toBeNull();
      expect(getComputedStyle(screen!).height).toBe('160px');
      const row = mount.container.querySelector<HTMLElement>('[data-testid="channels-session-conversation:binding-session-1"]');
      await act(async () => { row?.click(); });
      await vi.waitFor(() => expect(mount.container.textContent).toContain('Direct mentions only'));
      const resized = renderSurface({ ...context, widgetPresentation: { ...context.widgetPresentation,
        geometry: { width: 620, height: 384 } } }) as ReactElement<{ dataClient?: PluginUiDataClient }>;
      await mount.render(cloneElement(resized, { dataClient: emptyDataClient }));
      expect(mount.container.querySelector('[data-testid="channels-session-conversations"]')).toBe(screen);
      expect(mount.container.querySelector('[data-testid="channels-session-conversations-list"]')).toBe(list);
      expect(getComputedStyle(screen!).height).toBe('384px');
      expect(mount.container.textContent).toContain('Direct mentions only');
      expect(mount.container.textContent).not.toContain('Conversation connections');
    } finally {
      mount.unmount();
    }
  });

  it('discloses lost live updates and a failed refresh while keeping the last known conversations', async () => {
    // Before this the Session destination showed a hydrated list with no way
    // to tell whether it was still current, and a failed refresh either said
    // nothing at all or replaced a good list with a bare error.
    let deliver: ((event: ResourceSubscriptionEvent) => void) | null = null;
    let failReads = false;
    const surface = createSessionConversationsContext('session-under-test');
    const baseHostApi = createHostApiStub(surface);
    const hostApi = createHostApiStub(surface, {
      version: () => ({
        ...baseHostApi.version(),
        methods: ['readResource', 'watchResource'],
      }),
      readResource: async (resource) => {
        const localId = resourceFixtureLocalId(resource);
        if (localId === 'session-conversations-v1') {
          if (failReads) {
            throw new PluginError({ code: 'unavailable', message: 'The daemon transport is unavailable.' });
          }
          return sessionConversationsResource;
        }
        if (localId === CONNECTIONS_RESOURCE.localId) return connectionsResource;
        throw new Error(`Unexpected Resource: ${localId}`);
      },
      watchResource: async (resource, listener) => {
        const localId = resourceFixtureLocalId(resource);
        if (localId === 'session-conversations-v1') deliver = listener;
        return { dispose: () => {} };
      },
    });
    const context = Object.freeze({
      plugin: Object.freeze({ id: 'happier.channels', version: '0.0.0' }),
      surface,
      hostApi,
      signal: new AbortController().signal,
    } satisfies RenderContext);
    const entry = renderSurface(context) as ReactElement<{ dataClient?: PluginUiDataClient }>;
    const mount = await mountThroughReactNativeWebAsync(cloneElement(entry, { dataClient: emptyDataClient }));

    try {
      await vi.waitFor(() => {
        expect(mount.container.textContent).toContain('Example conversation');
        expect(deliver).not.toBeNull();
      });

      // The subscription retires: the hydrated list is still shown, and the
      // destination says so instead of presenting it as live.
      await act(async () => {
        deliver?.({ version: 1, subscriptionId: 'sub-1', kind: 'complete', diagnostics: [] });
      });
      const ended = await vi.waitFor(() => {
        const element = mount.container.querySelector<HTMLElement>(
          '[data-testid="channels-session-conversations-resource-live-updates-ended"]',
        );
        expect(element).not.toBeNull();
        return element as HTMLElement;
      });
      expect(mount.container.textContent).toContain('Example conversation');

      // Refreshing fails. The last known list is authoritative-until-replaced
      // and stays, with the staleness stated rather than the whole destination
      // collapsing into an error.
      failReads = true;
      const retry = ended.querySelector<HTMLElement>('[role="button"]')
        ?? mount.container.querySelector<HTMLElement>('[role="button"]');
      expect(retry).not.toBeNull();
      await act(async () => { retry?.click(); });

      await vi.waitFor(() => {
        expect(mount.container.querySelector(
          '[data-testid="channels-session-conversations-resource-stale"]',
        )).not.toBeNull();
      });
      expect(mount.container.textContent).toContain('Example conversation');
      expect(mount.container.querySelector('[data-testid="channels-session-conversations-error"]')).toBeNull();
    } finally {
      mount.unmount();
    }
  });

  it('names the affected conversation and its reason, and opens that conversation in Channels', async () => {
    // Before this the Composer warning opened an ordinary metadata list: the
    // person could see that something was wrong and had no way to learn what
    // or to reach the control that fixes it.
    const attentionResource = jsonResource({
      bindings: [{
        bindingId: 'binding-session-1',
        revision: 1,
        connectionId: 'connection-1',
        endpoint: { audience: 'direct', label: 'Example conversation' },
        target: { kind: 'session', summary: 'session-under-test' },
        inputMode: 'directMentionsOnly',
        deliveryMode: 'mirrorSession',
        approval: { kind: 'off' },
        enabled: true,
        deletionState: 'none',
      }],
      attention: [{ bindingId: 'binding-session-1', reason: 'providerCredentialInvalid' }],
    }, '6');
    const openSurface = vi.fn(async () => undefined);
    const mount = await mountSessionDestination(attentionResource, openSurface);
    try {
      await vi.waitFor(() => {
        expect(mount.container.textContent).toContain('Connected Account credential needs attention');
      });
      expect(mount.container.querySelector(
        '[data-testid="channels-session-conversation-attention:binding-session-1"]',
      )).not.toBeNull();
      const open = mount.container.querySelector<HTMLElement>(
        '[data-testid="channels-session-conversation-open:binding-session-1"]',
      );
      expect(open).not.toBeNull();
      await act(async () => { open?.click(); });
      // The tab stays read-only: its one exit opens this exact conversation on
      // the Channels page, the one owner that edits it, and mutates nothing.
      expect(openSurface).toHaveBeenCalledWith(
        { pluginId: 'happier.channels', localId: 'conversations' },
        undefined,
        { subPath: 'binding-session-1' },
      );
    } finally {
      mount.unmount();
    }
  });

  it('shows a deliberately paused binding under Paused, never as an alert', async () => {
    const paused = jsonResource({
      bindings: [{
        bindingId: 'binding-session-1', revision: 1, connectionId: 'connection-1',
        endpoint: { audience: 'direct', label: 'Example conversation' },
        target: { kind: 'session', summary: 'session-under-test' },
        inputMode: 'directMentionsOnly', deliveryMode: 'mirrorSession', approval: { kind: 'off' },
        enabled: false, deletionState: 'none',
      }],
      attention: [{ bindingId: 'binding-session-1', reason: 'bindingDisabled' }],
    }, 'paused');
    const mount = await mountSessionDestination(paused);
    try {
      await vi.waitFor(() => expect(mount.container.textContent).toContain('Paused'));
      expect(mount.container.querySelector('[data-testid="channels-session-conversation-attention:binding-session-1"]')).toBeNull();
      expect(mount.container.querySelector('[role="alert"]')).toBeNull();
      expect(mount.container.textContent).not.toContain('repaired');
    } finally {
      mount.unmount();
    }
  });

  it('decodes one Session conversation Resource once while preserving both its bindings and attention', async () => {
    const attentionResource = jsonResource({
      bindings: [{
        bindingId: 'binding-session-1',
        revision: 1,
        connectionId: 'connection-1',
        endpoint: { audience: 'direct', label: 'Example conversation' },
        target: { kind: 'session', summary: 'session-under-test' },
        inputMode: 'directMentionsOnly',
        deliveryMode: 'mirrorSession',
        approval: { kind: 'off' },
        enabled: true,
        deletionState: 'none',
      }],
      attention: [{ bindingId: 'binding-session-1', reason: 'providerCredentialInvalid' }],
    }, '7');
    const serialized = new TextDecoder().decode(attentionResource.bytes);
    const parse = vi.spyOn(JSON, 'parse');
    const mount = await mountSessionDestination(attentionResource);
    try {
      await vi.waitFor(() => {
        expect(mount.container.textContent).toContain('Example conversation');
        expect(mount.container.textContent).toContain('Connected Account credential needs attention');
      });

      // The surface needs both the visible binding and its attention reason.
      // A split parser decoded the same Resource once for each, so this counts
      // the observable boundary work rather than a helper implementation.
      expect(parse.mock.calls.filter(([value]) => value === serialized)).toHaveLength(1);
    } finally {
      mount.unmount();
      parse.mockRestore();
    }
  });

  it('shows no attention affordance for a healthy Session conversation', async () => {
    const openSurface = vi.fn(async () => undefined);
    const mount = await mountSessionDestination(sessionConversationsResource, openSurface);
    try {
      await vi.waitFor(() => {
        expect(mount.container.textContent).toContain('Example conversation');
      });
      expect(mount.container.querySelector(
        '[data-testid="channels-session-conversation-attention:binding-session-1"]',
      )).toBeNull();
      expect(mount.container.querySelector(
        '[data-testid="channels-session-conversations-manage"]',
      )).toBeNull();
      expect(openSurface).not.toHaveBeenCalled();
    } finally {
      mount.unmount();
    }
  });

  it('reports the Session list as unavailable rather than falling back to the Account-local settings surface', async () => {
    const mount = await mountSessionDestination('unavailable');
    try {
      await vi.waitFor(() => {
        expect(mount.container.textContent).toContain('External conversations are unavailable');
      });
      expect(mount.container.textContent).not.toContain('Conversation connections');
    } finally {
      mount.unmount();
    }
  });
});

/**
 * Plugin tabs round 2 (lab `plugin-tabs` X1 / XP / XL / XE): the session tab groups its conversations by what they
 * are doing, each row opens in place with what it hears and gets and its own actions, and the header "+" links one.
 */
describe('Channels Session tab (round 2)', () => {
  const sessionTabSurface = () => createSurfaceContextFixture({
    mount: {
      kind: 'destination',
      destination: { pluginId: 'happier.channels', localId: 'session-conversations' },
      container: 'rightSidebarTab',
    },
    target: { kind: 'session', sessionId: 'session-under-test' },
  });
  const sessionBinding = (overrides: Readonly<Record<string, unknown>>) => ({
    revision: 3,
    connectionId: 'connection-1',
    target: { kind: 'session', summary: 'session-under-test' },
    inputMode: 'addressedMessages',
    deliveryMode: 'repliesOnly',
    approval: { kind: 'off' },
    enabled: true,
    deletionState: 'none',
    ...overrides,
  });
  const botConnections = (() => {
    const decoded = JSON.parse(new TextDecoder().decode(connectionsResource.bytes)) as { connections: Record<string, unknown>[] };
    return jsonResource({
      connections: decoded.connections.map((connection) => ({ ...connection, integrationPrincipalLabel: '@happier_ops_bot' })),
    }, 'c');
  })();
  const threeConversations = jsonResource({
    bindings: [
      sessionBinding({ bindingId: 'binding-need', endpoint: { audience: 'direct', label: 'Leeroy Brun' } }),
      sessionBinding({ bindingId: 'binding-live', endpoint: { audience: 'shared', label: 'happier-dev' } }),
      sessionBinding({ bindingId: 'binding-paused', endpoint: { audience: 'shared', label: 'Ops on-call' }, enabled: false }),
    ],
    attention: [
      { bindingId: 'binding-need', reason: 'providerCredentialInvalid' },
      { bindingId: 'binding-paused', reason: 'bindingDisabled' },
    ],
  }, 'e');

  async function mountSessionTab(input: Readonly<{
    conversations: ResourceContent;
    executeAction?: (input: PluginUiTestkitExecuteActionInput) => JsonValue | Promise<JsonValue>;
    opened?: (readonly [string, string])[];
    readConversations?: () => ResourceContent | Promise<ResourceContent>;
  }>) {
    return await createPluginUiTestkit({
      identity: { instanceId: 'fixture-session-tab', mountNonce: 'fixture-session-tab' },
      authorPlugin: { id: 'happier.channels', version: '0.0.0' },
      surface: renderSurface,
      surfaceContext: sessionTabSurface(),
      adapter: createChannelsSemanticAdapter(emptyDataClient, undefined, { paneHeader: true, overlays: true }),
      handlers: {
        ...(input.executeAction === undefined ? {} : { executeAction: input.executeAction }),
        openSurface: ({ view, subPath }) => {
          input.opened?.push([typeof view === 'string' ? view : view.localId, subPath ?? '']);
        },
        readResource: async ({ resource }) => {
          const localId = resourceFixtureLocalId(resource);
          if (localId === 'session-conversations-v1') return input.readConversations?.() ?? input.conversations;
          if (localId === CONNECTIONS_RESOURCE.localId) return botConnections;
          throw new Error(`Unexpected Resource: ${localId}`);
        },
      },
    });
  }

  it('groups the conversations as Needs you, Live and Paused, each row naming its bot, and says the cause once', async () => {
    const fixture = await mountSessionTab({ conversations: threeConversations });
    try {
      await expect(fixture.findByRole('button', { name: 'happier-dev' })).resolves.toBeDefined();
      await expect(fixture.getByText('Needs you')).resolves.toBeDefined();
      await expect(fixture.getByText('Live')).resolves.toBeDefined();
      await expect(fixture.getByText('Paused')).resolves.toBeDefined();
      await expect(fixture.getByText('Connected Account credential needs attention')).resolves.toBeDefined();
      // The healthy rows say who they are and nothing else; what they hear and get waits for the row to open.
      expect(document.body.textContent).toContain('@happier_ops_bot');
      expect(document.body.textContent).not.toContain('Addressed messages');
      // Paused is the group, not a banner on the row.
      expect(document.body.textContent).not.toContain('repaired');
    } finally {
      await fixture.dispose();
    }
  });

  it('opens a conversation in place with what it hears and gets, and pauses it from there', async () => {
    const executeAction = vi.fn(async () => ({ bindingId: 'binding-live', revision: 4, enabled: false }) as JsonValue);
    const fixture = await mountSessionTab({ conversations: threeConversations, executeAction });
    try {
      await fixture.press(await fixture.findByRole('button', { name: 'happier-dev' }));
      await expect(fixture.findByRole('button', { name: 'Pause' })).resolves.toBeDefined();
      await expect(fixture.getByText('Hears')).resolves.toBeDefined();
      expect(document.body.textContent).toContain('Addressed messages');
      await fixture.press(await fixture.getByRole('button', { name: 'Pause' }));
      await vi.waitFor(() => {
        expect(executeAction).toHaveBeenCalledWith(expect.objectContaining({
          action: CONVERSATION_MANAGEMENT_ACTION_IDS_V1.bindingSetEnabled,
          input: { bindingId: 'binding-live', expectedRevision: 3, enabled: false },
        }));
      });
    } finally {
      await fixture.dispose();
    }
  });

  it('keeps healthy retained conversations quiet during a refresh after Pause', async () => {
    let reads = 0;
    let finishRead: ((value: ResourceContent) => void) | undefined;
    const readPending = new Promise<ResourceContent>((resolve) => { finishRead = resolve; });
    const fixture = await mountSessionTab({
      conversations: threeConversations,
      executeAction: async () => ({ bindingId: 'binding-live', revision: 4, enabled: false }),
      readConversations: () => ++reads === 1 ? threeConversations : readPending,
    });
    try {
      await fixture.press(await fixture.findByRole('button', { name: 'happier-dev' }));
      await fixture.press(await fixture.findByRole('button', { name: 'Pause' }));
      await vi.waitFor(() => expect(reads).toBeGreaterThan(1));
      expect(document.body.textContent).toContain('happier-dev');
      expect(document.querySelector('[data-testid="channels-session-conversations-resource-refreshing"]')).toBeNull();
    } finally {
      finishRead?.(threeConversations);
      await fixture.dispose();
    }
  });

  it('resumes a paused conversation and submits unlink to the shared Action policy without a local confirm', async () => {
    const executeAction = vi.fn(async () => ({}) as JsonValue);
    const fixture = await mountSessionTab({ conversations: threeConversations, executeAction });
    try {
      await fixture.press(await fixture.findByRole('button', { name: 'Ops on-call' }));
      await fixture.press(await fixture.findByRole('button', { name: 'Resume' }));
      await vi.waitFor(() => {
        expect(executeAction).toHaveBeenCalledWith(expect.objectContaining({
          action: CONVERSATION_MANAGEMENT_ACTION_IDS_V1.bindingSetEnabled,
          input: { bindingId: 'binding-paused', expectedRevision: 3, enabled: true },
        }));
      });

      await fixture.press(await fixture.getByRole('button', { name: 'Unlink Ops on-call' }));
      await vi.waitFor(() => {
        expect(executeAction).toHaveBeenCalledWith(expect.objectContaining({
          action: CONVERSATION_MANAGEMENT_ACTION_IDS_V1.bindingDelete,
          input: { bindingId: 'binding-paused', expectedRevision: 3 },
        }));
      });
    } finally {
      await fixture.dispose();
    }
  });

  it('says when a live conversation last got a reply, from the delivery records (adopted default 1)', async () => {
    const atMs = Date.now() - 5 * 60_000;
    const withDelivery = jsonResource({
      bindings: [sessionBinding({ bindingId: 'binding-live', endpoint: { audience: 'shared', label: 'happier-dev' } })],
      lastDeliveries: [{ bindingId: 'binding-live', atMs, outcome: 'delivered' }],
    }, 'd');
    const fixture = await mountSessionTab({ conversations: withDelivery });
    try {
      await fixture.press(await fixture.findByRole('button', { name: 'happier-dev' }));
      await expect(fixture.getByText('Last reply')).resolves.toBeDefined();
      // The row's time is the conversation time owner's: the locale's own hour form ("9:22", never a padded "09:22").
      const expected = formatConversationTime(atMs, sessionTabSurface().locale);
      expect(document.body.textContent?.match(/Last reply.{0,24}/u)?.[0]).toContain(expected);
    } finally {
      await fixture.dispose();
    }
  });

  it('puts "+" in the pane header, opening Channels\' link journey on the one connected bot', async () => {
    const opened: (readonly [string, string])[] = [];
    const fixture = await mountSessionTab({ conversations: threeConversations, opened });
    try {
      await fixture.press(await fixture.findByRole('button', { name: 'Link a conversation' }));
      // The Session the "+" was pressed in travels with the journey, so it is not chosen twice.
      await vi.waitFor(() => expect(opened).toContainEqual(['conversations', 'link/connection-1/session/session-under-test']));
    } finally {
      await fixture.dispose();
    }
  });

  it('invites linking a conversation when none is linked yet', async () => {
    const opened: (readonly [string, string])[] = [];
    const fixture = await mountSessionTab({ conversations: jsonResource({ bindings: [] }, '0'), opened });
    try {
      await vi.waitFor(() => expect(document.body.textContent).toContain('Talk to this session from your chats'));
      const links = await fixture.getAllByRole('button', { name: 'Link a conversation' });
      // The header "+" and the empty state's primary: the add sits in the same place before and after the first link.
      expect(links.length).toBe(2);
      await fixture.press(links[links.length - 1]!);
      await vi.waitFor(() => expect(opened).toContainEqual(['conversations', 'link/connection-1/session/session-under-test']));
    } finally {
      await fixture.dispose();
    }
  });
});

describe('Channels connection row placement presentation', () => {
  async function mountConnectionRows(connections: ResourceContent): Promise<PluginUiTestkit> {
    return await createPluginUiTestkit({
      identity: { instanceId: 'fixture-instance-145', mountNonce: 'fixture-mount-145' },
      authorPlugin: { id: 'happier.channels', version: '0.0.0' },
      surface: renderSurface,
      surfaceContext: createChannelsSurfaceContext(),
      adapter: createChannelsSemanticAdapter(),
      handlers: {
        selectActionInput: async () => ({ kind: 'cancelled' as const }),
        executeAction: async ({ action }: PluginUiTestkitExecuteActionInput): Promise<JsonValue> => {
          throw new Error(`Unexpected mounted Action: ${String(action)}`);
        },
        readResource: async ({ resource }) => {
          const localId = resourceFixtureLocalId(resource);
          if (localId === BINDINGS_RESOURCE.localId) return bindingsResource;
          if (localId === CONNECTIONS_RESOURCE.localId) return connections;
          throw new Error(`Unexpected Resource: ${localId}`);
        },
      },
    });
  }

  async function collapsedConnectionRow(): Promise<Readonly<{ text: string; accessibleName: string }>> {
    return await vi.waitFor(() => {
      const row = document.querySelector<HTMLElement>('[data-testid="channels-connection-connection-1"]');
      expect(row, 'Expected the collapsed connection row').not.toBeNull();
      const named = row?.closest<HTMLElement>('[aria-label]') ?? row;
      return {
        text: row?.textContent ?? '',
        accessibleName: named?.getAttribute('aria-label') ?? '',
      };
    });
  }

  it('states saved enablement and runtime placement as separate facts on a collapsed row', async () => {
    // A runtime attention takes the single status accessory, so without a
    // policy fact of its own the row silently loses the deliberate pause.
    const fixture = await mountConnectionRows(pausedAndPollBlockedConnectionsResource);
    try {
      const row = await collapsedConnectionRow();
      expect(row.text).toContain('Paused');
      expect(row.text).toContain('Selected machine is not receiving messages');
      expect(row.text).not.toContain('Runs on your selected machine');
      // Both facts must reach a screen reader, not only the sighted detail.
      expect(row.accessibleName).toContain('Paused');
      expect(row.accessibleName).toContain('Selected machine is not receiving messages');
    } finally {
      await fixture.dispose();
    }
  });

  it('does not claim a paused connection is running on its selected machine', async () => {
    const fixture = await mountConnectionRows(pausedHealthyConnectionsResource);
    try {
      const row = await collapsedConnectionRow();
      expect(row.text).toContain('Paused');
      // Placement is where the connection is assigned; only an enabled
      // connection is actually running there.
      expect(row.text).toContain('Assigned to your selected machine');
      expect(row.text).not.toContain('Runs on your selected machine');
    } finally {
      await fixture.dispose();
    }
  });

  it('keeps an enabled healthy connection reading as running without redundant status', async () => {
    const fixture = await mountConnectionRows(connectionsResource);
    try {
      const row = await collapsedConnectionRow();
      expect(row.text).toContain('Runs on your selected machine');
      expect(row.accessibleName).toContain('Runs on your selected machine');
      expect(row.text).not.toContain('Paused');
    } finally {
      await fixture.dispose();
    }
  });
});

describe('Channels collapsed row identity', () => {
  // A provider can serve several accounts and several unlabeled endpoints, so
  // each collapsed row must remain individually addressable: the integration
  // account appears as its own fact, and a row without any human label falls
  // back to its short stable identity instead of a generic word.
  const labeledConnectionConnections = jsonResource({
    connections: [{
      connectionId: 'connection-1',
      revision: 1,
      authorityEpoch: 1,
      providerPluginId: 'com.example.conversation-provider',
      selectedMachineId: 'machine-1',
      selectedTransport: 'checkpointedPull',
      integrationPrincipalLabel: 'Team bot',
      enabled: true,
      deletionState: 'none',
      attention: {
        historyGap: null,
        pollFailure: null,
        bestEffortBeforeDurableAdmission: false,
        oldTransportStopUnconfirmed: false,
        endpointRetargetOwed: false,
        acceptedPossibleLoss: false,
        outwardDelivery: {
          retryDue: false,
          notDelivered: false,
          partial: false,
          outcomeUnknown: false,
        },
      },
    }, {
      connectionId: 'connection-c7tQm2xwAbCdEfGh',
      revision: 1,
      authorityEpoch: 1,
      providerPluginId: 'com.example.conversation-provider',
      selectedMachineId: 'machine-1',
      selectedTransport: 'checkpointedPull',
      enabled: true,
      deletionState: 'none',
      attention: {
        historyGap: null,
        pollFailure: null,
        bestEffortBeforeDurableAdmission: false,
        oldTransportStopUnconfirmed: false,
        endpointRetargetOwed: false,
        acceptedPossibleLoss: false,
        outwardDelivery: {
          retryDue: false,
          notDelivered: false,
          partial: false,
          outcomeUnknown: false,
        },
      },
    }],
  }, '5');
  const identityBindingsResource = jsonResource({
    bindings: [{
      bindingId: 'binding-1',
      revision: 1,
      connectionId: 'connection-1',
      endpoint: { audience: 'direct', label: 'Project room' },
      target: { kind: 'session', summary: 'Example session' },
      inputMode: 'allAllowedMessages',
      deliveryMode: 'repliesOnly',
      approval: { kind: 'off' },
      enabled: true,
      deletionState: 'none',
    }, {
      bindingId: 'binding-Qm2xwAbCdEfGh7k',
      revision: 1,
      connectionId: 'connection-c7tQm2xwAbCdEfGh',
      endpoint: { audience: 'direct' },
      target: { kind: 'session', summary: 'Other session' },
      inputMode: 'directMentionsOnly',
      deliveryMode: 'repliesOnly',
      approval: { kind: 'off' },
      enabled: false,
      deletionState: 'none',
    }],
  }, '6');

  function collapsedRowByIdentity(
    testId: string,
  ): Promise<Readonly<{ text: string; accessibleName: string }>> {
    return vi.waitFor(() => {
      const row = document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
      expect(row, `Expected collapsed row ${testId}`).not.toBeNull();
      const named = row?.closest<HTMLElement>('[aria-label]') ?? row;
      return {
        text: row?.textContent ?? '',
        accessibleName: named?.getAttribute('aria-label') ?? '',
      };
    });
  }

  it('names each linked conversation by its endpoint label or short identity, and its page by its bot', async () => {
    const mountAt = async (subPath: string, instance: string) => await createPluginUiTestkit({
      identity: { instanceId: instance, mountNonce: instance },
      authorPlugin: { id: 'happier.channels', version: '0.0.0' },
      surface: renderSurface,
      surfaceContext: createChannelsPageSurfaceContext(),
      subPath,
      adapter: createChannelsSemanticAdapter(),
      handlers: {
        selectActionInput: async () => ({ kind: 'cancelled' as const }),
        executeAction: async () => {
          throw new Error('Unexpected mounted Action');
        },
        readResource: async ({ resource }) => {
          const localId = resourceFixtureLocalId(resource);
          if (localId === BINDINGS_RESOURCE.localId) return identityBindingsResource;
          if (localId === CONNECTIONS_RESOURCE.localId) return labeledConnectionConnections;
          throw new Error(`Unexpected Resource: ${localId}`);
        },
      },
    });

    // The page's own list (what a phone shows at the root).
    const index = await mountAt('', 'fixture-instance-146');
    try {
      const labeled = await collapsedRowByIdentity('channels-page-row-binding-1');
      expect(labeled.text).toContain('Project room');
      const unlabeled = await collapsedRowByIdentity('channels-page-row-binding-Qm2xwAbCdEfGh7k');
      // Without an endpoint label the row names itself by its short stable
      // identity rather than a generic word shared by every unlabeled row.
      expect(unlabeled.text).toContain('Qm2xwAbC');
      expect(unlabeled.text).not.toContain('External conversation');
    } finally {
      await index.dispose();
    }


    // One conversation: the integration account is its own fact beside the
    // provider and the endpoint.
    const page = await mountAt('binding-1', 'fixture-instance-146b');
    try {
      await vi.waitFor(() => {
        const header = document.querySelector('[data-testid="channels-binding-binding-1"]')?.textContent ?? '';
        expect(header).toContain('Project room');
        expect(header).toContain('Team bot');
      });
    } finally {
      await page.dispose();
    }
  });

  it('shows each Session conversation\'s latest shareable reply, its time and its unread and Work facts, and the router none (c0.73 F3)', async () => {
    const replyAt = new Date(2026, 9, 22, 9, 41).getTime();
    const bindings = jsonResource({
      bindings: [
        { bindingId: 'binding-ready', revision: 1, connectionId: 'connection-1', endpoint: { audience: 'direct', label: 'Chantier Morges' },
          target: { kind: 'session', summary: 'Morges', sessionId: 'session-ready' }, inputMode: 'allAllowedMessages', deliveryMode: 'repliesOnly',
          approval: { kind: 'off' }, enabled: true, deletionState: 'none' },
        { bindingId: 'binding-working', revision: 1, connectionId: 'connection-1', endpoint: { audience: 'direct', label: 'Devis Lausanne' },
          target: { kind: 'session', summary: 'Lausanne', sessionId: 'session-working' }, inputMode: 'allAllowedMessages', deliveryMode: 'repliesOnly',
          approval: { kind: 'off' }, enabled: true, deletionState: 'none' },
        { bindingId: 'binding-hidden', revision: 1, connectionId: 'connection-1', endpoint: { audience: 'direct', label: 'Ressources humaines' },
          target: { kind: 'session', summary: 'RH', sessionId: 'session-hidden' }, inputMode: 'allAllowedMessages', deliveryMode: 'repliesOnly',
          approval: { kind: 'off' }, enabled: true, deletionState: 'none' },
        { bindingId: 'binding-empty', revision: 1, connectionId: 'connection-1', endpoint: { audience: 'direct', label: 'Nouveau client' },
          target: { kind: 'session', summary: 'Client', sessionId: 'session-empty' }, inputMode: 'allAllowedMessages', deliveryMode: 'repliesOnly',
          approval: { kind: 'off' }, enabled: true, deletionState: 'none' },
        { bindingId: 'binding-router', revision: 1, connectionId: 'connection-1', endpoint: { audience: 'direct', label: 'wilson@batiplus.ch' },
          target: { kind: 'threadRouter', summary: 'threadRouter' }, inputMode: 'allAllowedMessages', deliveryMode: 'none',
          approval: { kind: 'notApplicable' }, enabled: true, deletionState: 'none' },
        { bindingId: 'binding-router-thread', parentBindingId: 'binding-router', revision: 1, connectionId: 'connection-1',
          endpoint: { audience: 'shared', label: 'Fwd: facture' }, target: { kind: 'session', summary: 'Thread', sessionId: 'session-thread' },
          inputMode: 'allAllowedMessages', deliveryMode: 'repliesOnly', approval: { kind: 'off' }, enabled: true, deletionState: 'none' },
      ],
    }, '7');
    const idle = { state: 'waiting', bucket: 'idle' as const, tone: 'neutral' as const, attentionType: null, word: 'Idle' };
    const base = { lifecycle: 'active' as const, runtime: 'idle' as const, operational: 'none' as const, pendingPermissions: [] };
    const sessions: Readonly<Record<string, SessionStateV1>> = {
      'session-ready': { ...base, sessionId: 'session-ready', workStatus: idle, hasUnreadMessages: true,
        latestActivity: { kind: 'ready', text: 'Le devis est prêt,\n je l’envoie ce soir.', createdAt: replyAt } },
      'session-working': { ...base, sessionId: 'session-working', runtime: 'working', operational: 'working',
        workStatus: { state: 'action_required', bucket: 'needs_you', tone: 'attention', attentionType: 'decision', word: 'Needs you' }, hasUnreadMessages: false,
        latestActivity: { kind: 'ready', text: 'Puis-je lire le dossier ?', createdAt: replyAt } },
      'session-hidden': { ...base, sessionId: 'session-hidden', title: 'Private title', workStatus: idle, latestActivity: { kind: 'hidden' } },
      'session-empty': { ...base, sessionId: 'session-empty', workStatus: idle, hasUnreadMessages: false, latestActivity: { kind: 'empty' } },
      'session-thread': { ...base, sessionId: 'session-thread', workStatus: { state: 'action_required', bucket: 'needs_you', tone: 'attention', attentionType: 'decision', word: 'Needs you' },
        hasUnreadMessages: true, latestActivity: { kind: 'ready', text: 'Thread reply', createdAt: replyAt } },
    };
    const readSessionIds: string[] = [];
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'fixture-activity-rows', mountNonce: 'fixture-activity-rows' },
      authorPlugin: { id: 'happier.channels', version: '0.0.0' },
      surface: renderSurface,
      surfaceContext: createChannelsPageSurfaceContext(),
      subPath: '',
      adapter: createChannelsSemanticAdapter(),
      handlers: {
        selectActionInput: async () => ({ kind: 'cancelled' as const }),
        // Opening the list reads; it never marks a Session read or runs an Action.
        executeAction: async () => {
          throw new Error('Unexpected mounted Action');
        },
        readResource: bindingResourceReader(() => bindings),
        readSession: ({ sessionId }) => {
          readSessionIds.push(sessionId);
          return sessions[sessionId] ?? null;
        },
      },
    });
    try {
      const ready = await collapsedRowByIdentity('channels-page-row-binding-ready');
      await vi.waitFor(async () => {
        const row = await collapsedRowByIdentity('channels-page-row-binding-ready');
        expect(row.text).toContain('Le devis est prêt, je l’envoie ce soir.');
      });
      expect(ready.text).toContain('Chantier Morges');
      const readyNow = await collapsedRowByIdentity('channels-page-row-binding-ready');
      // The reply's own time, never the Session's update or scan time.
      expect(readyNow.text).toContain(formatConversationTime(replyAt, createChannelsPageSurfaceContext().locale));
      expect(readyNow.accessibleName).toContain('Unread');

      const working = await collapsedRowByIdentity('channels-page-row-binding-working');
      expect(working.text).toContain('Puis-je lire le dossier ?');
      expect(working.text).toContain('Needs you');
      expect(working.accessibleName).not.toContain('Unread');

      const hidden = await collapsedRowByIdentity('channels-page-row-binding-hidden');
      expect(hidden.text).toContain('Preview hidden');
      expect(hidden.text).not.toContain('Private title');
      const empty = await collapsedRowByIdentity('channels-page-row-binding-empty');
      expect(empty.text).toContain('No replies yet');

      // A router is not a Session and never borrows a thread's reply, unread or Work.
      const router = await collapsedRowByIdentity('channels-page-row-binding-router');
      expect(router.text).not.toContain('Thread reply');
      expect(router.text).not.toContain('Needs you');
      expect(readSessionIds).not.toContain('session-thread');
    } finally {
      await fixture.dispose();
    }
  });

  it('names an unlabeled connection by its short identity instead of repeating the provider', async () => {
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'fixture-instance-147', mountNonce: 'fixture-mount-147' },
      authorPlugin: { id: 'happier.channels', version: '0.0.0' },
      surface: renderSurface,
      surfaceContext: createChannelsSurfaceContext(),
      adapter: createChannelsSemanticAdapter(),
      handlers: {
        selectActionInput: async () => ({ kind: 'cancelled' as const }),
        executeAction: async () => {
          throw new Error('Unexpected mounted Action');
        },
        readResource: async ({ resource }) => {
          const localId = resourceFixtureLocalId(resource);
          if (localId === BINDINGS_RESOURCE.localId) return identityBindingsResource;
          if (localId === CONNECTIONS_RESOURCE.localId) return labeledConnectionConnections;
          throw new Error(`Unexpected Resource: ${localId}`);
        },
      },
    });

    try {
      const row = await collapsedRowByIdentity('channels-connection-connection-c7tQm2xwAbCdEfGh');
      expect(row.accessibleName).toContain('c7tQm2xw');
      expect(row.accessibleName).toContain('Provider:');
    } finally {
      await fixture.dispose();
    }
  });

  it('accepts an ambiguous started conversation only with the thread it created (REV-C-04)', async () => {
    const account = createOfflineChannelStateFixture();
    const base = offlineAmbiguousDeliveryRow();
    const started = {
      ...base,
      value: {
        ...base.value,
        payload: {
          ...base.value.payload,
          source: { kind: 'conversationStart', sessionId: 'session-1', requestId: 'start-1' },
          newThread: { recipients: ['principal-1'], subject: 'Brief du matin' },
          threadBindingPending: true,
        },
      },
    };
    account.deliveries.rows.set(started.rowId, started);
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'fixture-instance-148b', mountNonce: 'fixture-mount-148b' },
      authorPlugin: { id: 'happier.channels', version: '0.0.0' },
      surface: renderSurface,
      surfaceContext: createChannelsSurfaceContext(),
      adapter: createChannelsSemanticAdapter(account.dataClient),
      handlers: {
        admitAction: async () => true,
        selectActionInput: async () => ({ kind: 'cancelled' as const }),
      },
    });

    try {
      await pressButtonWithAccessibleLabelFragment('Example conversation');
      const threadField = `channels-delivery-resolution-thread-${OFFLINE_AMBIGUOUS_CUSTODY_ID}`;
      await openDeliveryDecision(OFFLINE_AMBIGUOUS_CUSTODY_ID);
      await vi.waitFor(() => {
        expect(document.querySelector(`[data-testid="${threadField}"]`)).not.toBeNull();
      });
      const accept = () => document.querySelector<HTMLElement>(
        `[data-testid="channels-delivery-resolution-accept-${OFFLINE_AMBIGUOUS_CUSTODY_ID}"]`,
      );
      // Without the created thread, accepting could never restore reply routing.
      expect(accept()?.getAttribute('aria-disabled')).toBe('true');
      await enterTextByTestId(threadField, '<brief-1@batiplus.ch>');
      await vi.waitFor(() => {
        expect(accept()?.getAttribute('aria-disabled')).not.toBe('true');
      });
      await pressByTestId(`channels-delivery-resolution-accept-${OFFLINE_AMBIGUOUS_CUSTODY_ID}`);
      await vi.waitFor(() => {
        expect(account.deliveries.rows.get(OFFLINE_AMBIGUOUS_CUSTODY_ID)?.value.payload).toMatchObject({
          state: 'resolved',
          outcome: 'accepted',
          endpoint: { kind: 'direct', id: 'chat-1' },
        });
      });
      expect(JSON.stringify(account.deliveries.rows.get(OFFLINE_AMBIGUOUS_CUSTODY_ID)?.value.payload))
        .toContain('<brief-1@batiplus.ch>');
    } finally {
      await fixture.dispose();
    }
  });

  it('lists every undecided delivery in one list, each row naming its conversation and when it was sent', async () => {
    const account = createOfflineChannelStateFixture();
    const morges = offlineBindingRow();
    const morgesBinding = {
      ...morges,
      rowId: 'binding-2',
      value: {
        ...morges.value,
        id: 'binding-2',
        'binding-id': 'binding-2',
        payload: {
          ...morges.value.payload,
          endpoint: { kind: 'direct', audience: 'direct', id: 'chat-2', label: 'Chantier Morges' },
        },
      },
    };
    account.collection.rows.set(morgesBinding.rowId, morgesBinding);
    const base = offlineAmbiguousDeliveryRow();
    const deliveryFor = (custodyId: string, bindingId: string | undefined) => {
      const { 'binding-id': _bindingId, ...unbound } = base.value;
      return {
        ...base,
        rowId: custodyId,
        value: bindingId === undefined
          ? {
            ...unbound,
            id: custodyId,
            payload: { ...base.value.payload, routeAuthority: { connectionAuthorityEpoch: 1 } },
          }
          : { ...base.value, id: custodyId, 'binding-id': bindingId },
      };
    };
    const exampleCustodyId = 'c'.repeat(43);
    const exampleSecondCustodyId = 'f'.repeat(43);
    const morgesCustodyId = 'd'.repeat(43);
    const unboundCustodyId = 'e'.repeat(43);
    for (const row of [
      deliveryFor(exampleCustodyId, 'binding-1'),
      deliveryFor(exampleSecondCustodyId, 'binding-1'),
      deliveryFor(morgesCustodyId, 'binding-2'),
      deliveryFor(unboundCustodyId, undefined),
    ]) account.deliveries.rows.set(row.rowId, row);
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'fixture-instance-148g', mountNonce: 'fixture-mount-148g' },
      authorPlugin: { id: 'happier.channels', version: '0.0.0' },
      surface: renderSurface,
      surfaceContext: createChannelsSurfaceContext(),
      adapter: createChannelsSemanticAdapter(account.dataClient),
      handlers: {
        selectActionInput: async () => ({ kind: 'cancelled' as const }),
      },
    });

    try {
      await pressButtonWithAccessibleLabelFragment('Example conversation');
      const list = () => document.querySelector<HTMLElement>('[data-testid="channels-delivery-resolution-list"]');
      const header = (custodyId: string) => document.querySelector<HTMLElement>(
        `[data-testid="channels-delivery-resolution-${custodyId}.header"]`,
      );
      await vi.waitFor(() => {
        expect(header(morgesCustodyId)?.textContent).toContain('Chantier Morges');
      });
      // Every delivery needs the same decision, so its count and what each choice does are said once above.
      const controls = document.querySelector('[data-testid="channels-delivery-resolution-controls"]');
      expect(controls?.textContent).toContain('4 deliveries with an unknown outcome');
      expect(controls?.textContent?.split('Happier lost the answer while sending').length).toBe(2);
      // One list, no per-conversation blocks: each row names its conversation and says when it was sent.
      expect(document.querySelectorAll('[data-testid^="channels-delivery-resolution-group-"]')).toHaveLength(0);
      for (const custodyId of [exampleCustodyId, exampleSecondCustodyId, morgesCustodyId, unboundCustodyId]) {
        expect(list()?.contains(header(custodyId))).toBe(true);
        expect(header(custodyId)?.textContent).toContain('Sent ');
      }
      expect(header(exampleSecondCustodyId)?.textContent).toContain('Example conversation');
      expect(header(unboundCustodyId)?.textContent).toContain('Outside linked conversations');
      // Conversations read by name; the connection-level delivery comes last.
      const order = Array.from(list()?.querySelectorAll('[data-testid$=".header"]') ?? [])
        .map((element) => element.getAttribute('data-testid'));
      expect(order[0]).toBe(`channels-delivery-resolution-${morgesCustodyId}.header`);
      expect(order.at(-1)).toBe(`channels-delivery-resolution-${unboundCustodyId}.header`);
      expect(order).toHaveLength(4);
    } finally {
      await fixture.dispose();
    }
  });

  it('names each ambiguous delivery decision by when it was sent, never by an internal id', async () => {
    const account = createOfflineChannelStateFixture();
    const first = offlineAmbiguousDeliveryRow();
    const secondCustodyId = 'd'.repeat(43);
    const secondCreatedAt = 7_200_000;
    const second = {
      ...offlineAmbiguousDeliveryRow(),
      rowId: secondCustodyId,
      value: {
        ...offlineAmbiguousDeliveryRow().value,
        id: secondCustodyId,
        'created-at': secondCreatedAt,
      },
    };
    const sentAt = (atMs: number) => new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })
      .format(new Date(atMs));
    account.deliveries.rows.set(first.rowId, first);
    account.deliveries.rows.set(second.rowId, second);
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'fixture-instance-148', mountNonce: 'fixture-mount-148' },
      authorPlugin: { id: 'happier.channels', version: '0.0.0' },
      surface: renderSurface,
      surfaceContext: createChannelsSurfaceContext(),
      adapter: createChannelsSemanticAdapter(account.dataClient),
      handlers: {
        selectActionInput: async () => ({ kind: 'cancelled' as const }),
      },
    });

    try {
      await pressButtonWithAccessibleLabelFragment('Example conversation');
      // Undecided deliveries of one kind are one group: its count leads, its cause is said once,
      // and each delivery is one folded row instead of a repeated block.
      await vi.waitFor(() => {
        const controls = document.querySelector('[data-testid="channels-delivery-resolution-controls"]');
        expect(controls?.textContent).toContain('2 deliveries with an unknown outcome');
      });
      expect(document.querySelectorAll('[data-testid^="channels-delivery-resolution-accept-"]').length).toBe(0);
      await openDeliveryDecision('c'.repeat(43));
      await openDeliveryDecision(secondCustodyId);
      await vi.waitFor(() => {
        expect(document.querySelectorAll('[data-testid^="channels-delivery-resolution-accept-"]').length).toBe(2);
      });
      // The privacy-safe projection carries no content: each delivery is named by when it was sent, which
      // also tells the two rows' identical buttons apart. No custody id or revision reaches the reader.
      await expect(fixture.getByRole('button', { name: `Accept as sent (Delivery sent ${sentAt(1_000)})` })).resolves.toBeDefined();
      await expect(fixture.getByRole('button', { name: `Accept as sent (Delivery sent ${sentAt(secondCreatedAt)})` })).resolves.toBeDefined();
      await expect(fixture.getByRole('button', {
        name: `Discard delivery (Delivery sent ${sentAt(secondCreatedAt)})`,
      })).resolves.toBeDefined();
      expect(document.body.textContent).toContain(`Sent ${sentAt(secondCreatedAt)}`);
      expect(document.body.textContent).not.toContain('cccccccc');
      expect(document.body.textContent).not.toContain('revision');
    } finally {
      await fixture.dispose();
    }
  });
});

describe('Channels Connected Services handoff', () => {
  it('sends an invalid Connected Account credential to its canonical owner instead of re-collecting it', async () => {
    const openConnectedAccountsRequests: unknown[] = [];
    const executeAction = vi.fn(async ({ action }: PluginUiTestkitExecuteActionInput): Promise<JsonValue> => {
      throw new Error(`Unexpected mounted Action: ${String(action)}`);
    });
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'fixture-instance-149', mountNonce: 'fixture-mount-149' },
      authorPlugin: { id: 'happier.channels', version: '0.0.0' },
      surface: renderSurface,
      surfaceContext: createChannelsSurfaceContext(),
      adapter: createChannelsSemanticAdapter(),
      handlers: {
        selectActionInput: async () => ({ kind: 'cancelled' as const }),
        executeAction,
        openConnectedAccounts: ({ request }) => { openConnectedAccountsRequests.push(request); },
        readResource: async ({ resource }) => {
          const localId = resourceFixtureLocalId(resource);
          if (localId === BINDINGS_RESOURCE.localId) return bindingsResource;
          if (localId === CONNECTIONS_RESOURCE.localId) {
            return connectionsResourceWithProviderReadiness({ code: 'providerCredentialInvalid' });
          }
          throw new Error(`Unexpected Resource: ${localId}`);
        },
      },
    });

    try {
      await pressButtonWithAccessibleLabelFragment('Example conversation');
      // The collapsed row summarizes the same readiness fact, so this asserts
      // the expanded disclosure by its own identity rather than by a text
      // query that legitimately matches both zoom levels.
      await vi.waitFor(() => {
        const disclosure = document.querySelector<HTMLElement>(
          '[data-testid="channels-provider-readiness-disclosure"]',
        );
        expect(disclosure?.textContent).toContain('Connected Account credential needs attention');
      });

      // The credential owner is Connected Services. This surface names that
      // destination in words and hands over; it never grows a second place to
      // replace or re-enter the credential.
      await fixture.press(await fixture.getByRole('button', { name: 'Open Connected Services' }));
      await vi.waitFor(() => {
        expect(openConnectedAccountsRequests).toHaveLength(1);
      });
      expect(executeAction).not.toHaveBeenCalled();
    } finally {
      await fixture.dispose();
    }
  });
});

describe('Channels first connection continuation', () => {
  it('continues a newly created connection into the incumbent binding journey with that connection selected', async () => {
    const createdConnectionId = 'connection-from-first-setup';
    const submittedProviderSetup = {
      kind: 'submitted' as const,
      action: providerSetupOperation.action,
      input: { repository: 'happier-dev/happier' },
      selection: {
        target: {
          pluginId: 'happier.channels',
          sourceCustody: { kind: 'development', registeredRootId: 'channels-target-root-a' } as const,
        },
        point: providerSetupOperation.point,
        contributor: providerPortableContributor(),
      },
      connectedAccount: { kind: 'none' as const },
      presentation: { connectedAccountLabel: null, machineDisplayName: null },
    };
    let connectionCreated = false;
    const createdConnectionsResource = jsonResource({
      connections: [{
        connectionId: createdConnectionId,
        revision: 1,
        authorityEpoch: 1,
        providerPluginId: providerSetupOperation.contributor.pluginId,
        selectedMachineId: 'machine-1',
        selectedTransport: 'checkpointedPull',
        integrationPrincipalLabel: 'Example conversation',
        enabled: true,
        deletionState: 'none',
        attention: {
          historyGap: null,
          providerReadiness: null,
          ingressConflict: null,
          pollFailure: null,
          bestEffortBeforeDurableAdmission: false,
          oldTransportStopUnconfirmed: false,
          endpointRetargetOwed: false,
          acceptedPossibleLoss: false,
          outwardDelivery: {
            retryDue: false,
            notDelivered: false,
            partial: false,
            outcomeUnknown: false,
          },
        },
      }],
    }, '6');
    const emptyConnectionsResource = jsonResource({ connections: [] }, '7');
    const executeAction = vi.fn(async (request: PluginUiTestkitExecuteActionInput): Promise<JsonValue> => {
      if (request.action === CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionPrepare) {
        return {
          kind: 'ready',
          supportedTransports: ['checkpointedPull'],
          recommendedTransport: 'checkpointedPull',
          overlapSafety: 'safe',
          replayContinuity: 'none',
          outboundTextLimit: { maximum: 4_000, unit: 'unicodeCodePoints' },
        };
      }
      if (request.action === CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionCreate) {
        connectionCreated = true;
        return { kind: 'created', connectionId: createdConnectionId };
      }
      if (request.action === CONVERSATION_MANAGEMENT_ACTION_IDS_V1.bindingResolve) {
        return { kind: 'endpointCandidates', candidates: [bindingEndpointCandidate] };
      }
      throw new Error(`Unexpected mounted Action: ${String(request.action)}`);
    });
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'fixture-instance-150', mountNonce: 'fixture-mount-150' },
      authorPlugin: { id: 'happier.channels', version: '0.0.0' },
      surface: renderSurface,
      surfaceContext: createChannelsSurfaceContext(),
      adapter: createChannelsSemanticAdapter(),
      handlers: {
        selectActionInput: async () => submittedProviderSetup,
        executeAction,
        readResource: async ({ resource }) => {
          const localId = resourceFixtureLocalId(resource);
          if (localId === BINDINGS_RESOURCE.localId) return bindingsResource;
          if (localId === CONNECTIONS_RESOURCE.localId) {
            return connectionCreated ? createdConnectionsResource : emptyConnectionsResource;
          }
          throw new Error(`Unexpected Resource: ${localId}`);
        },
      },
    });

    try {
      await fixture.press(await fixture.getByRole('button', { name: 'Set up Integration provider' }));
      // Creation only becomes offerable once the canonical prepare settles.
      await vi.waitFor(async () => {
        await expect(fixture.getByRole('button', { name: 'Create connection' })).resolves.toBeDefined();
      });
      await fixture.press(await fixture.getByRole('button', { name: 'Create connection' }));
      await vi.waitFor(() => {
        expect(executeAction).toHaveBeenCalledWith(expect.objectContaining({
          action: CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionCreate,
        }));
      });

      // A connection alone delivers nothing. The person must land on one
      // prominent next step rather than an inert list row.
      await vi.waitFor(() => {
        expect(
          document.querySelector('[data-testid="channels-connection-created-continue"]'),
        ).not.toBeNull();
      });
      await pressByTestId('channels-connection-created-continue-open');

      // The two domain Actions stay separate; only their journeys compose, so
      // the incumbent binding journey opens with the new connection selected
      // and no second connection mutation is dispatched.
      await enterTextByTestId('channels-binding-create-endpoint-query', bindingEndpointSelection.query);
      await fixture.press(await fixture.getByRole('button', { name: 'Search endpoints' }));
      await vi.waitFor(() => {
        expect(executeAction).toHaveBeenCalledWith(expect.objectContaining({
          action: CONVERSATION_MANAGEMENT_ACTION_IDS_V1.bindingResolve,
          input: expect.objectContaining({ connectionId: createdConnectionId }),
        }));
      });
      expect(
        executeAction.mock.calls.filter(([request]) => (
          request.action === CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionCreate
        )),
      ).toHaveLength(1);
    } finally {
      await fixture.dispose();
    }
  });
});

describe('Channels page (the one owner of linked conversations)', () => {
  const pausedBindingsResource = jsonResource({
    bindings: [{
      bindingId: 'binding-1',
      revision: 3,
      connectionId: 'connection-1',
      endpoint: { audience: 'shared', label: 'Paired room' },
      target: { kind: 'session', summary: 'session-7' },
      inputMode: 'addressedMessages',
      deliveryMode: 'repliesOnly',
      approval: { kind: 'off' },
      enabled: false,
      deletionState: 'none',
    }],
  }, '4');
  const noBindingsResource = jsonResource({ bindings: [] }, '5');
  const noConnectionsResource = jsonResource({ connections: [] }, '7');
  const readerFor = (
    bindings: ResourceContent,
    connections: ResourceContent = connectionsResource,
  ): NonNullable<PluginUiTestkitHostHandlers['readResource']> => (
    async ({ resource }) => {
      const localId = resourceFixtureLocalId(resource);
      if (localId === BINDINGS_RESOURCE.localId) return bindings;
      if (localId === CONNECTIONS_RESOURCE.localId) return connections;
      throw new Error(`Unexpected Resource: ${localId}`);
    }
  );
  const opened = (calls: readonly (readonly [string, string])[]) => calls.map(([view, subPath]) => `${view}:${subPath}`);

  it('reports the failed bots read before offering a conversation selection', async () => {
    let refuseConnections = true;
    const page = await mountPage({
      subPath: '',
      readResource: async (request) => {
        if (resourceFixtureLocalId(request.resource) === CONNECTIONS_RESOURCE.localId && refuseConnections) {
          throw new PluginError({ code: 'unavailable', message: 'unavailable', retryable: false });
        }
        return readerFor(bindingsResource)(request);
      },
      surfaceContext: { ...createChannelsPageSurfaceContext(), page: { columnVisible: true } },
    });
    try {
      await vi.waitFor(() => expect(document.querySelector('[data-testid="channels-bindings-error"]')).not.toBeNull());
      expect(document.querySelector('[data-testid="channels-page-no-selection"]')).toBeNull();
      expect(document.querySelector('[data-testid="channels-bindings-loading"]')).toBeNull();
      refuseConnections = false;
      await page.fixture.press(await page.fixture.getByRole('button', { name: 'Try again' }));
      await vi.waitFor(() => expect(document.querySelector('[data-testid="channels-page-no-selection"]')).not.toBeNull());
      expect(document.querySelector('[data-testid="channels-bindings-error"]')).toBeNull();
    } finally {
      await page.fixture.dispose();
    }
  });

  it('shows a selection prompt beside its column and the list when the column is hidden', async () => {
    const visible = await mountPage({
      subPath: '',
      surfaceContext: { ...createChannelsPageSurfaceContext(), page: { columnVisible: true } },
    });
    try {
      await vi.waitFor(async () => { await visible.fixture.getByText('Choose a conversation'); });
      await expect(visible.fixture.queryByText('Example conversation')).resolves.toBeUndefined();
    } finally {
      await visible.fixture.dispose();
    }
    const hidden = await mountPage({
      subPath: '',
      surfaceContext: { ...createChannelsPageSurfaceContext(), page: { columnVisible: false } },
    });
    try {
      await vi.waitFor(async () => { await hidden.fixture.getByText('Example conversation'); });
    } finally {
      await hidden.fixture.dispose();
    }
  });

  it('lists conversations only once their bots are known, and says one cause once for a blocked bot', async () => {
    let releaseConnections!: () => void;
    const connectionsGate = new Promise<void>((resolve) => { releaseConnections = resolve; });
    const blocked = JSON.parse(new TextDecoder().decode(connectionsResource.bytes)) as {
      connections: { attention: { pollFailure: unknown } }[];
    };
    blocked.connections[0]!.attention.pollFailure = {
      phase: 'blocked', attemptCount: 1, retryNotBeforeMs: null, evidence: { kind: 'provider', reason: 'providerConflict' },
    };
    const hidden = await mountPage({
      subPath: '',
      connections: jsonResource(blocked, '9'),
      connectionsGate,
      surfaceContext: { ...createChannelsPageSurfaceContext(), page: { columnVisible: false } },
    });
    try {
      // The conversations are in; their bots are not. Nothing is drawn under a placeholder group, and
      // the wait names what it is waiting for rather than how it reads.
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
      expect(document.body.textContent).not.toContain('Example conversation');
      expect(document.body.textContent).not.toContain('Other conversations');
      expect(document.body.textContent).not.toContain('binding policy');
      await act(async () => { releaseConnections(); });
      await vi.waitFor(async () => { await hidden.fixture.getByText('Example conversation'); });
      // The bot's one cause reads as it does beside the column: one label, not the cause's own words.
      expect(document.body.textContent).toContain('Bot needs you');
      expect(document.body.textContent).not.toContain('Connection needs attention');
    } finally {
      await hidden.fixture.dispose();
    }
  });

  async function mountPage(input: Readonly<{
    subPath: string;
    bindings?: ResourceContent;
    connections?: ResourceContent;
    /** Holds the bots' read until it settles, so the bindings arrive first. */
    connectionsGate?: Promise<void>;
    readResource?: NonNullable<PluginUiTestkitHostHandlers['readResource']>;
    executeAction?: (request: PluginUiTestkitExecuteActionInput) => Promise<JsonValue>;
    surfaceContext?: ReturnType<typeof createChannelsSurfaceContext>;
  }>) {
    const openedSurfaces: (readonly [string, string])[] = [];
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: `channels-page-${input.subPath}`, mountNonce: `channels-page-${input.subPath}` },
      authorPlugin: { id: 'happier.channels', version: '0.0.0' },
      surface: renderSurface,
      surfaceContext: input.surfaceContext ?? createChannelsPageSurfaceContext(),
      subPath: input.subPath,
      adapter: createChannelsSemanticAdapter(),
      handlers: {
        selectActionInput: async () => ({ kind: 'cancelled' as const }),
        executeAction: input.executeAction ?? (async ({ action }) => {
          throw new Error(`Unexpected mounted Action: ${String(action)}`);
        }),
        readResource: input.readResource ?? (input.connectionsGate === undefined
          ? readerFor(input.bindings ?? bindingsResource, input.connections)
          : async (request) => {
            if (resourceFixtureLocalId(request.resource) === CONNECTIONS_RESOURCE.localId) await input.connectionsGate;
            return readerFor(input.bindings ?? bindingsResource, input.connections)(request);
          }),
        openSurface: ({ view, subPath }) => {
          openedSurfaces.push([typeof view === 'string' ? view : view.localId, subPath ?? '']);
        },
      },
    });
    return { fixture, openedSurfaces };
  }

  it('keeps bots and linking in Settings and sends every linked conversation to Channels', async () => {
    const { fixture, openedSurfaces } = await mountPage({ subPath: '', surfaceContext: createChannelsSurfaceContext() });
    try {
      await expect(fixture.findByRole('button', { name: 'Open Channels' })).resolves.toBeDefined();
      // Settings no longer carries a second writer for linked conversations.
      await expect(fixture.queryByRole('button', { name: 'Edit binding' })).resolves.toBeUndefined();
      await expect(fixture.queryByRole('button', { name: 'Pause' })).resolves.toBeUndefined();
      await expect(fixture.queryByRole('button', { name: 'Unlink…' })).resolves.toBeUndefined();
      await fixture.press(await fixture.getByRole('button', { name: 'Open Channels' }));
      expect(opened(openedSurfaces)).toEqual(['conversations:']);
    } finally {
      await fixture.dispose();
    }
  });

  it('leads Settings with the connections and offers no link button before a connection exists', async () => {
    const { fixture } = await mountPage({
      subPath: '',
      bindings: noBindingsResource,
      connections: noConnectionsResource,
      surfaceContext: createChannelsSurfaceContext(),
    });
    try {
      await vi.waitFor(async () => {
        await fixture.getByText('Create an active conversation connection before adding a binding.');
      });
      // A link cannot succeed without a connection, so no (disabled) link button is offered.
      expect(document.querySelector('[data-testid="channels-binding-create-open"]')).toBeNull();
      const connections = document.querySelector('[data-testid="channels-connections-section"]');
      const linked = document.querySelector('[data-testid="channels-settings-conversations"]');
      expect(connections).not.toBeNull();
      expect(linked).not.toBeNull();
      // The page's identity (its connections) comes before what depends on them.
      expect(connections!.compareDocumentPosition(linked!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    } finally {
      await fixture.dispose();
    }
  });

  it('asks for a bot first when none is connected', async () => {
    const { fixture, openedSurfaces } = await mountPage({
      subPath: '',
      bindings: noBindingsResource,
      connections: noConnectionsResource,
    });
    try {
      await fixture.press(await fixture.findByRole('button', { name: 'Connect a bot' }));
      expect(opened(openedSurfaces)).toEqual(['connections:']);
    } finally {
      await fixture.dispose();
    }
  });

  it('offers linking a conversation once a bot is connected and nothing is linked', async () => {
    const { fixture, openedSurfaces } = await mountPage({ subPath: '', bindings: noBindingsResource });
    try {
      await vi.waitFor(async () => { await fixture.getByText('Link a conversation to a session'); });
      await fixture.press(await fixture.getByRole('button', { name: 'Link a conversation' }));
      expect(opened(openedSurfaces)).toEqual(['conversations:link']);
    } finally {
      await fixture.dispose();
    }
  });

  it('pauses a conversation and turns a paused one on through the canonical enablement Action', async () => {
    const executeAction = vi.fn(async ({ action }: PluginUiTestkitExecuteActionInput): Promise<JsonValue> => {
      if (action === CONVERSATION_MANAGEMENT_ACTION_IDS_V1.bindingSetEnabled) return { kind: 'updated' };
      throw new Error(`Unexpected mounted Action: ${String(action)}`);
    });
    const live = await mountPage({ subPath: 'binding-1', executeAction });
    try {
      await vi.waitFor(async () => { await live.fixture.getByText('Talks to'); });
      await live.fixture.press(await live.fixture.getByRole('button', { name: 'Pause' }));
      await vi.waitFor(() => {
        expect(executeAction).toHaveBeenLastCalledWith(expect.objectContaining({
          action: CONVERSATION_MANAGEMENT_ACTION_IDS_V1.bindingSetEnabled,
          input: { bindingId: 'binding-1', expectedRevision: 1, enabled: false },
        }));
      });
    } finally {
      await live.fixture.dispose();
    }

    const paused = await mountPage({ subPath: 'binding-1', bindings: pausedBindingsResource, executeAction });
    try {
      // A paused conversation says why and offers one way back; Pause is gone.
      await paused.fixture.press(await paused.fixture.findByRole('button', { name: 'Turn on' }));
      await expect(paused.fixture.queryByRole('button', { name: 'Pause' })).resolves.toBeUndefined();
      await vi.waitFor(() => {
        expect(executeAction).toHaveBeenLastCalledWith(expect.objectContaining({
          action: CONVERSATION_MANAGEMENT_ACTION_IDS_V1.bindingSetEnabled,
          input: { bindingId: 'binding-1', expectedRevision: 3, enabled: true },
        }));
      });
    } finally {
      await paused.fixture.dispose();
    }
  });

  it('names and opens the conversation target by its exact Session id, never the bounded summary (CH-UI2 r2b)', async () => {
    const sessionId = 'session-chantier-morges-0000-4000-8000-000000000000';
    const bindings = jsonResource({
      bindings: [{
        bindingId: 'binding-1', revision: 1, connectionId: 'connection-1',
        endpoint: { audience: 'direct', label: 'Example conversation' },
        // The summary is the bounded display projection: a truncated prefix of the id.
        target: { kind: 'session', summary: `${sessionId.slice(0, 27)}\u2026`, sessionId },
        inputMode: 'directMentionsOnly', deliveryMode: 'repliesOnly', approval: { kind: 'off' }, enabled: true, deletionState: 'none',
      }],
    }, 'd');
    const readSessionIds: string[] = [];
    const opened: unknown[] = [];
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'fixture-target-session', mountNonce: 'fixture-target-session' },
      authorPlugin: { id: 'happier.channels', version: '0.0.0' },
      surface: renderSurface,
      surfaceContext: createChannelsPageSurfaceContext(),
      subPath: 'binding-1',
      adapter: createChannelsSemanticAdapter(),
      handlers: {
        selectActionInput: async () => ({ kind: 'cancelled' as const }),
        executeAction: async ({ action, input }) => {
          if (action === 'session.open') {
            opened.push(input);
            return { kind: 'opened' };
          }
          throw new Error(`Unexpected mounted Action: ${String(action)}`);
        },
        readResource: bindingResourceReader(() => bindings),
        readSession: ({ sessionId: requested }) => {
          readSessionIds.push(requested);
          return requested === sessionId
            ? { sessionId, title: 'Chantier Morges', lifecycle: 'active', runtime: 'idle', operational: 'none', pendingPermissions: [],
              workStatus: { state: 'waiting', bucket: 'idle', tone: 'neutral', attentionType: null, word: 'Idle' } }
            : null;
        },
      },
    });
    try {
      await vi.waitFor(async () => {
        await expect(fixture.getByText('Chantier Morges')).resolves.toBeDefined();
      });
      expect(readSessionIds).toContain(sessionId);
      await fixture.press(await fixture.getByRole('button', { name: 'Open session' }));
      await vi.waitFor(() => {
        expect(opened).toEqual([{ sessionId }]);
      });
    } finally {
      await fixture.dispose();
    }
  });

  it('opens the review editor for a conversation handed over at `<bindingId>/edit`', async () => {
    const readIds: unknown[] = [];
    const { fixture } = await mountPage({
      subPath: 'binding-1/edit',
      executeAction: async ({ action, input }) => {
        if (action === CONVERSATION_MANAGEMENT_ACTION_IDS_V1.bindingRead) {
          readIds.push((input as Readonly<{ bindingId?: string }>).bindingId);
          return { kind: 'notFound' };
        }
        throw new Error(`Unexpected mounted Action: ${String(action)}`);
      },
    });
    try {
      await vi.waitFor(() => { expect(readIds).toEqual(['binding-1']); });
    } finally {
      await fixture.dispose();
    }
  });

  it('connects a bot inside the link journey, keeps the Session it started from, and ends on the first message (CH-FIRST-CONTACT)', async () => {
    const sessionId = 'session-chantier-morges';
    const submittedProviderSetup = {
      kind: 'submitted' as const,
      action: providerSetupOperation.action,
      input: { repository: 'happier-dev/happier' },
      selection: {
        target: {
          pluginId: 'happier.channels',
          sourceCustody: { kind: 'development', registeredRootId: 'channels-target-root-a' } as const,
        },
        point: providerSetupOperation.point,
        contributor: providerPortableContributor(),
      },
      connectedAccount: { kind: 'none' as const },
      presentation: { connectedAccountLabel: null, machineDisplayName: null },
    };
    const endpointCandidate = { kind: 'direct' as const, audience: 'direct' as const, id: 'direct-ada', label: 'Ada direct' };
    const principalSelection = { query: 'ada', selected: [{ id: 'principal-ada', kind: 'human' as const }] };
    const createdBinding = {
      v: 1, id: 'binding-created', connectionId: 'connection-1', endpoint: endpointCandidate,
      target: { kind: 'session' as const, sessionId, policy: {
        deliveryMode: 'mirrorSession' as const, permissionCeiling: 'read-only',
        approvals: { kind: 'off' as const }, newSession: { kind: 'off' as const },
      } },
      allowedPrincipalIds: ['principal-ada'], allowBotSenders: false, inputMode: 'allAllowedMessages' as const,
      inboundDebounceMs: 750, linkPreviewPolicy: 'suppress' as const, senderFeedback: 'off' as const,
      authorityEpoch: 2, enabled: true, deletionState: 'none' as const, createdAt: 1, updatedAt: 1,
    };
    const createdBindingsResource = jsonResource({
      bindings: [{
        bindingId: 'binding-created', revision: 1, connectionId: 'connection-1',
        endpoint: { audience: 'direct', label: 'Ada direct' },
        target: { kind: 'session', summary: 'Chantier Morges', sessionId },
        inputMode: 'allAllowedMessages', deliveryMode: 'mirrorSession', approval: { kind: 'off' },
        enabled: true, deletionState: 'none',
      }],
    }, 'e');
    let connectionCreated = false;
    let bindingCreated = false;
    const replaced: string[] = [];
    const executeAction = vi.fn(async ({ action, input }: PluginUiTestkitExecuteActionInput): Promise<JsonValue> => {
      if (action === CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionPrepare) {
        return {
          kind: 'ready', supportedTransports: ['checkpointedPull'], recommendedTransport: 'checkpointedPull',
          overlapSafety: 'safe', replayContinuity: 'none', outboundTextLimit: { maximum: 4_000, unit: 'unicodeCodePoints' },
        };
      }
      if (action === CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionCreate) {
        connectionCreated = true;
        return { kind: 'created', connectionId: 'connection-1' };
      }
      if (action === CONVERSATION_MANAGEMENT_ACTION_IDS_V1.bindingResolve) {
        return (input as { kind?: unknown }).kind === 'endpoint'
          ? { kind: 'endpointCandidates', candidates: [endpointCandidate] }
          : { kind: 'principalCandidates', candidates: [{ id: 'principal-ada', kind: 'human', label: 'Ada' }] };
      }
      if (action === 'session.list') {
        return createSessionCandidatePageFixture({ sessions: [{ id: 'session-other', title: 'Other work' }], nextCursor: null });
      }
      if (action === CONVERSATION_MANAGEMENT_ACTION_IDS_V1.bindingCreate) {
        bindingCreated = true;
        return { kind: 'created', binding: createdBinding };
      }
      throw new Error(`Unexpected mounted Action: ${String(action)}`);
    });
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'fixture-first-contact', mountNonce: 'fixture-first-contact' },
      authorPlugin: { id: 'happier.channels', version: '0.0.0' },
      surface: renderSurface,
      surfaceContext: createChannelsPageSurfaceContext(),
      subPath: `link/session/${sessionId}`,
      adapter: createChannelsSemanticAdapter(),
      handlers: {
        selectActionInput: async () => submittedProviderSetup,
        executeAction,
        readResource: readerForCreated(),
        readSession: ({ sessionId: requested }) => (requested === sessionId
          ? { sessionId, title: 'Chantier Morges', lifecycle: 'active', runtime: 'idle', operational: 'none', pendingPermissions: [],
            workStatus: { state: 'waiting', bucket: 'idle', tone: 'neutral', attentionType: null, word: 'Idle' } }
          : null),
        replacePageLocation: ({ subPath }) => {
          replaced.push(subPath);
          return subPath;
        },
      },
    });
    function readerForCreated(): NonNullable<PluginUiTestkitHostHandlers['readResource']> {
      return async (request) => readerFor(
        bindingCreated ? createdBindingsResource : noBindingsResource,
        connectionCreated ? connectionsResource : noConnectionsResource,
      )(request);
    }
    try {
      // No bot yet: the link journey itself connects one rather than ending on a sentence.
      await vi.waitFor(async () => { await fixture.getByText('Choose the chat that should talk to Chantier Morges.'); });
      await expect(fixture.queryByText('Create an active conversation connection before adding a binding.')).resolves.toBeUndefined();
      await fixture.press(await fixture.getByRole('button', { name: 'Set up Integration provider' }));
      await fixture.press(await fixture.findByRole('button', { name: 'Create connection' }));

      // The new bot continues straight into choosing the chat, without a second press.
      await vi.waitFor(() => {
        expect(document.querySelector('[data-testid="channels-binding-create-endpoint-query"]')).not.toBeNull();
      });
      await enterTextByTestId('channels-binding-create-endpoint-query', 'ada-direct');
      await fixture.press(await fixture.getByRole('button', { name: 'Search endpoints' }));
      await fixture.press(await fixture.findByRole('button', { name: 'Ada direct' }));
      await enterTextByTestId('channels-binding-create-principal-query', principalSelection.query);
      await fixture.press(await fixture.getByRole('button', { name: 'Search people' }));
      await fixture.press(await fixture.findByRole('checkbox', { name: 'Ada: principal-ada', state: { checked: false } }));
      await fixture.press(await fixture.getByRole('button', { name: 'Continue' }));

      // The Session is kept: the target step is not asked again.
      await fixture.press(await fixture.findByRole('button', { name: 'Review binding' }));
      const summary = document.querySelector<HTMLElement>('[data-testid="channels-binding-create-summary"]');
      expect(summary?.textContent).toContain('Chantier Morges');
      await fixture.press(await fixture.getByRole('button', { name: 'Link conversation' }));
      await vi.waitFor(() => {
        expect(executeAction).toHaveBeenCalledWith(expect.objectContaining({
          action: CONVERSATION_MANAGEMENT_ACTION_IDS_V1.bindingCreate,
          input: expect.objectContaining({ connectionId: 'connection-1', target: expect.objectContaining({ kind: 'session', sessionId }) }),
        }));
      });
      await vi.waitFor(() => { expect(replaced).toContain('binding-created/new'); });

      // The page ends on the one remaining step: a first message, said where it is sent.
      await fixture.updatePageLocation('binding-created/new');
      await vi.waitFor(async () => { await fixture.getByText('Send a first message'); });
      expect(document.body.textContent).toContain('Send Example conversation a message to check that it arrives.');
      await fixture.press(await fixture.getByRole('button', { name: 'Done' }));
      expect(replaced[replaced.length - 1]).toBe('binding-created');
      expect(executeAction.mock.calls.filter(([request]) => (
        request.action === CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionCreate
      ))).toHaveLength(1);
    } finally {
      await fixture.dispose();
    }
  });

  it('says so when the location names a conversation that is no longer linked', async () => {
    const { fixture, openedSurfaces } = await mountPage({ subPath: 'binding-gone' });
    try {
      await vi.waitFor(async () => { await fixture.getByText('This conversation is no longer linked'); });
      await fixture.press(await fixture.getByRole('button', { name: 'Show all conversations' }));
      expect(opened(openedSurfaces)).toEqual(['conversations:']);
    } finally {
      await fixture.dispose();
    }
  });
});
