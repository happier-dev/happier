// @vitest-environment jsdom

import { cloneElement, type ReactElement } from 'react';
import { PluginError, type JsonValue } from '@happier-dev/plugin-sdk';
import type { RenderContext, ResourceContent, ResourceSubscriptionEvent } from '@happier-dev/plugin-sdk/ui';
import {
  CONVERSATION_MANAGEMENT_ACTION_IDS_V1,
  CONVERSATION_PROVIDERS_CONTRIBUTION_POINT_ID_V1,
  CONVERSATION_PROVIDERS_CONTRIBUTION_PROTOCOL_ID_V1,
  CONVERSATION_PROVIDERS_CONTRIBUTION_PROTOCOL_VERSION_V1,
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
      maximumObservationAgeMs: 60_000,
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
    maximumObservationAgeMs: 60_000,
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
      maximumObservationAgeMs: 60_000,
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
      maximumObservationAgeMs: 60_000,
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
      maximumObservationAgeMs: 60_000,
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
    maximumObservationAgeMs: 60_000,
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
    maximumObservationAgeMs: 60_000,
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
    maximumObservationAgeMs: 60_000,
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
    maximumObservationAgeMs: 60_000,
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
    maximumObservationAgeMs: 60_000,
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

async function pressButtonWithAccessibleLabelFragment(fragment: string): Promise<void> {
  const element = Array.from(document.querySelectorAll<HTMLElement>('[role="button"]')).find((candidate) => (
    candidate.getAttribute('aria-label')?.includes(fragment)
  ));
  expect(element, `Expected mounted button whose accessible label includes ${JSON.stringify(fragment)}`).not.toBeNull();
  await act(async () => { element?.click(); });
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

async function openBindingEndpointSelection(fixture: PluginUiTestkit): Promise<void> {
  await fixture.press(await fixture.getByRole('button', { name: 'Add binding' }));
  await enterTextByTestId('channels-binding-create-endpoint-query', bindingEndpointSelection.query);
  await fixture.press(await fixture.getByRole('button', { name: 'Search endpoints' }));
  await fixture.press(await fixture.getByRole('button', { name: bindingEndpointCandidate.label }));
}

async function searchBindingPrincipal(fixture: PluginUiTestkit): Promise<void> {
  await enterTextByTestId('channels-binding-create-principal-query', bindingPrincipalSelection.query);
  await fixture.press(await fixture.getByRole('button', { name: 'Search people' }));
}

async function selectPrincipalAndOpenTarget(fixture: PluginUiTestkit): Promise<void> {
  await searchBindingPrincipal(fixture);
  await fixture.press(await fixture.getByRole('radio', {
    name: bindingPrincipalCandidate.label,
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
  const announcement = document.querySelector<HTMLElement>('[data-testid="channels-binding-create-stage"]');
  expect(announcement, 'Expected the current binding-create step to be announced.').not.toBeNull();
  expect(announcement?.getAttribute('role')).toBe('status');
  expect(announcement?.getAttribute('aria-live')).toBe('polite');
  expect(announcement?.textContent).toContain(`Current step: ${input.title}`);

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
    const localId = typeof resource === 'string' ? resource : resource.localId;
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
      transportOrigin: { serverIdentityId: 'server-1', materializationRef: offlineMaterialization },
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
        content: 'Ambiguous delivery body.',
        deliveryKey: 'delivery-offline-ambiguous',
        mentionPolicy: 'none',
        linkPreviewPolicy: 'default',
        replyContext: null,
        state: 'outcomeUnknown',
        attemptCount: 1,
        attemptId: null,
        startedAt: null,
        providerMessageIds: [],
        failedChunk: null,
        archiveRecovery: null,
      },
    },
  };
}

function createOfflineChannelStateFixture() {
  const rows = new Map<string, OfflineChannelStateRow>(
    [offlineConnectionRow(), offlineBindingRow()].map((row) => [row.rowId, row] as const),
  );
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
    async query(request: Readonly<{ index: string; prefix?: readonly string[]; limit?: number }>) {
      assertChannelsTestCollectionQueryLimit(request.limit);
      if (request.index !== 'by-kind') return { rows: [], changeCursor: 1 };
      const matching = [...rows.values()]
        .filter((row) => row.value['record-kind'] === request.prefix?.[0])
        .sort((left, right) => left.rowId.localeCompare(right.rowId));
      return { rows: matching, changeCursor: 1 };
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
      range?: Readonly<{ lower?: unknown; upper?: unknown }>;
      limit?: number;
    }>) {
      assertChannelsTestCollectionQueryLimit(request.limit);
      if (request.index !== CHANNEL_DELIVERIES_INDEX_ID.byConnectionAttention
        && request.index !== CHANNEL_DELIVERIES_INDEX_ID.byOwnerAttention) {
        return { rows: [], changeCursor: 1 };
      }
      const matching = [...deliveryRows.values()]
        .filter((row) => row.value['connection-id'] === request.prefix?.[0]
          && (request.index === CHANNEL_DELIVERIES_INDEX_ID.byOwnerAttention
            || (row.value.attention === true
              && request.range?.lower === true
              && request.range?.upper === true)))
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
  it('offers a next step instead of an empty surface when no provider is admitted', async () => {
    // A fresh Account, or a machine with no conversation integration enabled,
    // reaches this state. Rendering nothing left the person with no way to
    // learn why the page is empty or what to do about it.
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'fixture-instance-72', mountNonce: 'fixture-mount-72' },
      authorPlugin: { id: 'happier.channels', version: '0.0.0' },
      surface: renderSurface,
      surfaceContext: createChannelsSurfaceContextWithoutProviders(),
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
      if (typeof request.action === 'object'
        && request.action !== null
        && request.action.pluginId === providerSetupRemediationOperation.action.pluginId
        && request.action.localId === providerSetupRemediationOperation.action.localId) {
        remediationInput = request.input;
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
          expect.objectContaining(providerSetupRemediationOperation.action),
          CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionPrepare,
        ]);
      });
      expect(selectActionInput).toHaveBeenCalledTimes(2);
      expect(selectActionInput.mock.calls[1]?.[0].request).toEqual({
        operation: providerSetupRemediationOperation,
      });
      expect(remediationInput).toEqual(submittedRemediation.input);
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
      if (typeof action === 'object'
        && action !== null
        && action.pluginId === providerSetupRemediationOperation.action.pluginId
        && action.localId === providerSetupRemediationOperation.action.localId) {
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
        expect.objectContaining(providerSetupRemediationOperation.action),
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
          const localId = typeof resource === 'string' ? resource : resource.localId;
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
      },
    });

    try {
      await fixture.press(await fixture.getByRole('button', { name: 'Set up Integration provider' }));
      await expect(fixture.getByText('Work account')).resolves.toBeDefined();
      await expect(fixture.getByText('Development Mac')).resolves.toBeDefined();
      await expect(fixture.getByText('#engineering')).resolves.toBeDefined();
      expect(document.body.textContent).toContain('Messages sent during an interruption may not be recoverable.');
      await expect(fixture.getByText('Read messages, Send messages')).resolves.toBeDefined();
      await fixture.press(await fixture.getByRole('link', { name: 'Resolve provider setup' }));
      expect(openedLinks).toEqual([setupGuidanceUrl]);
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
        // Setup seeds the Channels domain freshness default, not the smallest
        // value an owner is allowed to configure.
        maximumObservationAgeMs: 86_400_000,
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
        const localId = typeof resource === 'string' ? resource : resource.localId;
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
          const localId = typeof resource === 'string' ? resource : resource.localId;
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
          const localId = typeof resource === 'string' ? resource : resource.localId;
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
  it('renders a redacted occurrence conflict without exposing a retry action', async () => {
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
      await expect(fixture.getByText('An incoming occurrence has contradictory evidence.')).resolves.toBeDefined();
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
      await expect(fixture.findByRole('button', { name: 'Retry saved input' })).resolves.toBeDefined();
      await expect(fixture.getByText('An incoming message was not accepted.')).resolves.toBeDefined();
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
      await vi.waitFor(async () => {
        expect(attentionQuery).toHaveBeenCalledTimes(2);
        await expect(fixture.getByText('No incoming messages need attention')).resolves.toBeDefined();
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
        return { sessions: [{ id: 'session-1', title: 'Project review' }], nextCursor: null };
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
        return { sessions: [{ id: 'session-1', title: 'Project review' }], nextCursor: null };
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
          const localId = typeof resource === 'string' ? resource : resource.localId;
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
        return { sessions: [{ id: 'session-1', title: 'Project review' }], nextCursor: null };
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
      await fixture.press(await fixture.getByRole('radio', {
        name: bindingPrincipalCandidate.label,
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
        return {
          sessions: [{
            id: 'session-1',
            title: 'Project review',
            // The mounted create flow must never render or request previews.
            lastMessagePreview: { role: 'user', text: 'private preview' },
          }],
          nextCursor: null,
        };
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
          const localId = typeof resource === 'string' ? resource : resource.localId;
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
      await expect(fixture.getByRole('radiogroup', { name: 'Allowed sender candidates' })).resolves.toBeDefined();
      await expect(fixture.getByRole('radio', {
        name: 'Ada',
        state: { checked: false },
      })).resolves.toBeDefined();
      await expect(fixture.getByRole('radio', {
        name: 'Grace',
        state: { checked: false },
      })).resolves.toBeDefined();
      await fixture.press(await fixture.getByRole('radio', { name: 'Ada', state: { checked: false } }));
      expect(document.querySelectorAll('[role="radio"][aria-checked="true"]')).toHaveLength(1);
      await expect(fixture.getByRole('radio', {
        name: 'Ada',
        state: { checked: true },
      })).resolves.toBeDefined();
      await fixture.press(await fixture.getByRole('button', { name: 'Continue' }));

      await vi.waitFor(() => {
        expect(executeAction).toHaveBeenCalledWith(expect.objectContaining({
          action: 'session.list',
          input: { limit: 100, includeLastMessagePreview: false },
        }));
      });
      expect(document.body.textContent).not.toContain('private preview');
      await fixture.press(await fixture.getByRole('button', { name: 'Back' }));
      expect(document.querySelectorAll('[role="radio"][aria-checked="true"]')).toHaveLength(1);
      await expect(fixture.getByRole('radio', {
        name: 'Ada',
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

      await fixture.press(await fixture.getByRole('button', { name: 'Create binding' }));

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
        name: 'Create binding',
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
        expectedConnectionRevision: 1,
        pairingRequestId: 'pairing-request-fixture',
        expiresAt: 1_040,
        attemptsRemaining: 5,
        destinationLabel: 'Project room',
        manualToken: 'ABCDEFGH',
        deepLinkUrl: 'https://example.test/pair?token=ABCDEFGH',
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
        return { sessions: [{ id: 'session-pairing', title: 'Pairing Session' }], nextCursor: null };
      }
      if (action === CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionPairingCreate) {
        return {
          kind: 'created',
          generationId: 'pairing-generation',
          challengeId: 'pairing-challenge',
          expiresAt: 1_040,
          attemptsRemaining: 5,
          destinationLabel: 'Project room',
          manualToken: 'ABCDEFGH',
          deepLinkUrl: 'https://example.test/pair?token=ABCDEFGH',
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
          const localId = typeof resource === 'string' ? resource : resource.localId;
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
        // The person chose a shared conversation and then proves themselves in
        // a private message. The challenge must carry the conversation they
        // chose, or pairing silently binds the private message instead.
        expect(executeAction).toHaveBeenCalledWith(expect.objectContaining({
          action: CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionPairingCreate,
          input: expect.objectContaining({ endpointSelection: bindingEndpointSelection }),
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

  it('uses pairing only when principal resolution is explicitly unsupported', async () => {
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
          deliveryMode: 'repliesOnly',
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
      enabled: false,
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
        expectedConnectionRevision: 1,
        pairingRequestId: 'pairing-request-fixture',
        expiresAt: 601_000,
        attemptsRemaining: 5,
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
        expectedConnectionRevision: 1,
        expiresAt: 601_000,
        endpointLabel: 'Ada',
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
        expectedConnectionRevision: 1,
        expiresAt: 601_000,
        endpointLabel: 'Ada',
        state: 'proposed',
      }],
    }, 'a');
    const executeAction = vi.fn(async ({ action, input }: PluginUiTestkitExecuteActionInput): Promise<JsonValue> => {
      if (action === CONVERSATION_MANAGEMENT_ACTION_IDS_V1.bindingResolve) {
        return (input as Readonly<{ kind?: unknown }>).kind === 'endpoint'
          ? { kind: 'endpointCandidates', candidates: [bindingEndpointCandidate] }
          : { kind: 'unavailable', reason: 'principalResolveUnsupported' };
      }
      if (action === 'session.list') {
        return {
          sessions: [{ id: 'session-pairing', title: 'Pairing Session' }],
          nextCursor: null,
        };
      }
      if (action === CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionPairingCreate) {
        return {
          kind: 'created',
          generationId: 'pairing-generation',
          challengeId: 'pairing-challenge',
          expiresAt: 601_000,
          attemptsRemaining: 5,
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
          const localId = typeof resource === 'string' ? resource : resource.localId;
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
      await openBindingEndpointSelection(fixture);
      await searchBindingPrincipal(fixture);

      await expect(fixture.getByText('Pairing is required')).resolves.toBeDefined();
      await vi.waitFor(() => {
        expect(executeAction).toHaveBeenCalledWith(expect.objectContaining({
          action: 'session.list',
          input: { limit: 100, includeLastMessagePreview: false },
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
            endpointSelection: bindingEndpointSelection,
            target: {
              kind: 'session',
              sessionId: 'session-pairing',
              policy: {
                deliveryMode: 'repliesOnly',
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
      await fixture.press(await fixture.getByRole('button', { name: 'Finalize pairing' }));
      await vi.waitFor(() => {
        expect(executeAction).toHaveBeenCalledWith(expect.objectContaining({
          action: CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionPairingFinalize,
          input: {
            generationId: 'pairing-generation',
            proposalId: 'pairing-proposal',
            connectionId: 'connection-1',
            expectedConnectionRevision: 1,
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
      // Finalizing proves the conversation; it does not start delivering. The
      // canonical Action saved this binding disabled, so a bare "Pairing
      // completed" would promise a live conversation that is actually paused.
      await expect(fixture.getByText(
        'Conversation paired. The binding is saved paused until you review and enable it.',
      )).resolves.toBeDefined();
      expect(document.body.textContent).not.toContain('Pairing completed');
      await expect(
        fixture.getByRole('button', { name: 'Review and enable' }),
      ).resolves.toBeDefined();

      // Reviewing continues in the existing binding editor on the Channels
      // page — the single owner of reviewing and enabling a saved binding —
      // opened for the exact binding id the finalize Action returned.
      await fixture.press(await fixture.getByRole('button', { name: 'Review and enable' }));
      await vi.waitFor(() => {
        expect(openedSurfaces).toEqual([['conversations', 'binding-pairing/edit']]);
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
        expectedConnectionRevision: 1,
        pairingRequestId,
        expiresAt: 601_000,
        attemptsRemaining: 5,
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
        return { sessions: [{ id: 'session-pairing', title: 'Pairing Session' }], nextCursor: null };
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
          const localId = typeof resource === 'string' ? resource : resource.localId;
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

  it('recovers an unknown pairing create through the challenge carrying its own request id', async () => {
    let pairingReads = 0;
    let sentPairingRequestId: string | undefined;
    let resolvePairingRefresh: ((value: ResourceContent) => void) | undefined;
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
        expectedConnectionRevision: 1,
        pairingRequestId,
        expiresAt: 601_000,
        attemptsRemaining: 5,
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
        return { sessions: [{ id: 'session-pairing', title: 'Pairing Session' }], nextCursor: null };
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
          const localId = typeof resource === 'string' ? resource : resource.localId;
          if (localId === BINDINGS_RESOURCE.localId) return bindingsResource;
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
        if (sentPairingRequestId === undefined) throw new Error('The create request id was not captured yet.');
      });
      await act(async () => {
        resolvePairingRefresh?.(pairingChallengeResourceFor(sentPairingRequestId!));
      });
      await expect(fixture.getByText('ABCDEFGH')).resolves.toBeDefined();
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
            expectedConnectionRevision: 1,
            pairingRequestId: 'pairing-request-fixture',
            expiresAt: 601_000,
            attemptsRemaining: 5,
            destinationLabel: 'Project room',
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
            expectedConnectionRevision: 1,
            expiresAt: 601_000,
            endpointLabel: 'Ada',
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
          return { sessions: [{ id: 'session-pairing', title: 'Pairing Session' }], nextCursor: null };
        }
        if (action === CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionPairingCreate) {
          return {
            kind: 'created',
            generationId: 'pairing-generation',
            challengeId: 'pairing-challenge',
            expiresAt: 601_000,
            attemptsRemaining: 5,
            destinationLabel: 'Project room',
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
            const localId = typeof resource === 'string' ? resource : resource.localId;
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

  it('uses only the no-invoke new-Session selector and leaves cancellation without a create', async () => {
    const selectActionInput = vi.fn(async (_input: PluginUiTestkitSelectActionInputInput) => ({ kind: 'cancelled' as const }));
    const executeAction = vi.fn(async ({ action, input }: PluginUiTestkitExecuteActionInput): Promise<JsonValue> => {
      if (action === CONVERSATION_MANAGEMENT_ACTION_IDS_V1.bindingResolve) {
        return (input as Readonly<{ kind?: unknown }>).kind === 'endpoint'
          ? { kind: 'endpointCandidates', candidates: [bindingEndpointCandidate] }
          : { kind: 'principalCandidates', candidates: [bindingPrincipalCandidate] };
      }
      if (action === 'session.list') {
        return { sessions: [{ id: 'session-1', title: 'Project review' }], nextCursor: null };
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
        name: 'Configure a new Session',
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
        name: 'Configure a new Session',
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
        return { sessions: [{ id: 'session-1', title: 'Project review' }], nextCursor: null };
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
          input: { limit: 100, includeLastMessagePreview: false },
        }));
      });
      await fixture.press(await fixture.getByRole('button', { name: 'Show Automations' }));
      await vi.waitFor(() => {
        expect(executeAction).toHaveBeenCalledWith(expect.objectContaining({
          action: 'automation.conversation.targets.list',
          input: { limit: 100 },
        }));
      });
      await fixture.press(await fixture.getByRole('button', { name: 'Show more Automations' }));
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
        'A message from the allowed sender starts this Automation, which runs its configured workflow.',
      );
      expect(summary?.textContent).toContain('Delegated authority');
      expect(summary?.textContent).toContain(
        'The Automation runs unattended with the permissions, tools, and outward effects its own definition grants.',
      );

      await fixture.press(await fixture.getByRole('button', { name: 'Create binding' }));

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
      await expect(fixture.getByText('This Automation cannot return a final result')).resolves.toBeDefined();
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
          return {
            sessions: Array.from({ length: 100 }, (_unused, index) => ({
              id: `session-p1-${index}`,
              title: `Session 1-${index}`,
            })),
            nextCursor: 'session-page-2',
          };
        }
        if (cursor === 'session-page-2') {
          return {
            sessions: Array.from({ length: 100 }, (_unused, index) => ({
              id: `session-p2-${index}`,
              title: `Session 2-${index}`,
            })),
            nextCursor: null,
          };
        }
        return { sessions: [], nextCursor: null };
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
          input: { limit: 100, includeLastMessagePreview: false },
        }));
      });
      await fixture.press(await fixture.getByRole('button', { name: 'Show more Sessions' }));
      await vi.waitFor(() => {
        expect(executeAction).toHaveBeenCalledWith(expect.objectContaining({
          action: 'session.list',
          input: { limit: 100, includeLastMessagePreview: false, cursor: 'session-page-2' },
        }));
      });
      await enterTextByTestId('channels-binding-target-search', 'Session 2-99');
      await expect(fixture.getByRole('button', { name: 'Session 2-99' })).resolves.toBeDefined();
      await enterTextByTestId('channels-binding-target-search', '');
      await fixture.press(await fixture.getByRole('button', { name: 'Show Automations' }));
      await vi.waitFor(() => {
        expect(executeAction).toHaveBeenCalledWith(expect.objectContaining({
          action: 'automation.conversation.targets.list',
          input: { limit: 100 },
        }));
      });
      await fixture.press(await fixture.getByRole('button', { name: 'Show more Automations' }));
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
        return { sessions: [{ id: 'session-1', title: 'Project review' }], nextCursor: null };
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
      await fixture.press(await fixture.getByRole('button', { name: 'Edit binding' }));
      await expect(fixture.getByRole('heading', { name: 'Edit binding' })).resolves.toBeDefined();
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
          input: { limit: 100, includeLastMessagePreview: false },
        }));
      });
      await fixture.press(await fixture.getByRole('button', { name: 'Show Automations' }));
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
        return { sessions: [{ id: 'session-1', title: 'Project review' }], nextCursor: null };
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
      await expect(fixture.getByRole('heading', { name: 'Edit binding' })).resolves.toBeDefined();
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
        return { sessions: [{ id: 'session-1', title: 'Project review' }], nextCursor: null };
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
      await fixture.press(await fixture.getByRole('button', { name: 'Create binding' }));

      await expect(fixture.getByText('Could not confirm binding creation')).resolves.toBeDefined();
      await expect(fixture.findByRole('button', {
        name: 'Add binding',
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
      await expect(fixture.findByRole('button', {
        name: 'Add binding',
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
      await expect(fixture.getByRole('heading', { name: 'Edit binding' })).resolves.toBeDefined();
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
        maximumObservationAgeMs: 60_000,
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
          : { kind: 'principalCandidates', candidates: [externalPrincipal] };
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
          const localId = typeof resource === 'string' ? resource : resource.localId;
          if (localId === BINDINGS_RESOURCE.localId) return bindingsResource;
          if (localId === CONNECTIONS_RESOURCE.localId) return foreignConnectionsResource;
          throw new Error(`Unexpected Resource: ${localId}`);
        },
      },
    });

    try {
      await fixture.press(await fixture.getByRole('button', { name: 'Edit binding' }));
      await expect(fixture.getByRole('heading', { name: 'Edit binding' })).resolves.toBeDefined();
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
      await fixture.press(await fixture.getByRole('switch', {
        name: externalPrincipal.label,
        state: { checked: false },
      }));
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
              selected: [{ id: 'external-reviewer-7', kind: 'human' }],
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
        return { sessions: [{ id: 'session-current-8', title: 'Current session' }], nextCursor: null };
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
      adapter: createChannelsSemanticAdapter(),
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
      await fixture.press(await fixture.getByRole('switch', {
        name: externalPrincipal.label,
        state: { checked: false },
      }));
      await fixture.press(await fixture.getByRole('button', {
        name: 'Use selected conversation and senders',
      }));
    };

    try {
      await fixture.press(await fixture.getByRole('button', { name: 'Edit binding' }));
      await expect(fixture.getByRole('heading', { name: 'Edit binding' })).resolves.toBeDefined();

      // Target first: re-resolving the audience afterwards must not discard it.
      await fixture.press(await fixture.getByRole('button', { name: 'Change target' }));
      await vi.waitFor(() => {
        expect(executeAction).toHaveBeenCalledWith(expect.objectContaining({
          action: 'session.list',
          input: { limit: 100, includeLastMessagePreview: false },
        }));
      });
      await fixture.press(await fixture.getByRole('button', { name: 'Current session' }));
      await reresolveAudience();
      await fixture.press(await fixture.getByRole('radio', {
        name: 'Mirror Session',
        state: { checked: false },
      }));
      await fixture.press(await fixture.getByRole('radio', {
        name: 'All allowed messages',
        state: { checked: false },
      }));
      await fixture.press(await fixture.getByRole('radio', {
        name: '0.75 seconds',
        state: { checked: false },
      }));
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
      await expect(fixture.getByRole('heading', { name: 'Edit binding' })).resolves.toBeDefined();

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

  it('reports a Session policy clamp only from the authoritative post-update detail reread', async () => {
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
        return { sessions: [{ id: 'session-current-8', title: 'Current session' }], nextCursor: null };
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
      await expect(fixture.getByRole('heading', { name: 'Edit binding' })).resolves.toBeDefined();
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
      await expect(fixture.getByText('Saved policy was clamped')).resolves.toBeDefined();
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
      await expect(fixture.getByRole('heading', { name: 'Edit binding' })).resolves.toBeDefined();
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
      await expect(fixture.getByRole('heading', { name: 'Edit binding' })).resolves.toBeDefined();
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
      await expect(fixture.getByRole('heading', { name: 'Edit binding' })).resolves.toBeDefined();
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
      const heading = Array.from(document.querySelectorAll<HTMLElement>('[role="heading"]')).find((node) => (
        node.textContent === 'Edit binding'
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
      expect(executeAction).not.toHaveBeenCalled();
      await expect(fixture.getByText('Unlink this conversation?')).resolves.toBeDefined();
      await fixture.press(await fixture.getByRole('button', { name: 'Unlink' }));

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
      expect(executeAction).not.toHaveBeenCalled();
      await expect(fixture.getByText('Unlink this conversation?')).resolves.toBeDefined();
      await fixture.press(await fixture.getByRole('button', { name: 'Unlink' }));
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
          const localId = typeof resource === 'string' ? resource : resource.localId;
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
    maximumObservationAgeMs: number;
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
        maximumObservationAgeMs: input.maximumObservationAgeMs,
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

  const editedObservationAge = '5 minutes';

  it('keeps an in-progress policy edit when the connection changes elsewhere and locks saving until an explicit reload', async () => {
    // A background reread used to silently rebase the draft: the edit the
    // person was typing vanished with no notice, and Save would then have
    // written against a revision they never saw.
    let current = connectionsResourceAtRevision({
      revision: 1,
      enabled: true,
      maximumObservationAgeMs: 60_000,
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
      adapter: createChannelsSemanticAdapter(),
      handlers: {
        selectActionInput: async () => ({ kind: 'cancelled' as const }),
        executeAction,
        readResource: async ({ resource }) => {
          const localId = typeof resource === 'string' ? resource : resource.localId;
          if (localId === BINDINGS_RESOURCE.localId) return bindingsResource;
          if (localId === CONNECTIONS_RESOURCE.localId) return current;
          throw new Error(`Unexpected Resource: ${localId}`);
        },
      },
    });

    try {
      await pressByTestId('channels-connection-connection-1');
      await fixture.press(await fixture.getByRole('radio', {
        name: editedObservationAge,
        state: { checked: false },
      }));
      expect(document.querySelector('[data-testid="channels-connection-source-changed"]')).toBeNull();

      // Another writer advances the connection while the edit is open.
      current = connectionsResourceAtRevision({
        revision: 2,
        enabled: false,
        maximumObservationAgeMs: 120_000,
        digestDigit: 'c',
      });
      await pressByTestId('channels-detail-resource-refresh');

      await expect(fixture.getByRole('radio', {
        name: editedObservationAge,
        state: { checked: true },
      })).resolves.toBeDefined();
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
      await expect(fixture.getByRole('radio', {
        name: '2 minutes',
        state: { checked: true },
      })).resolves.toBeDefined();
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
      maximumObservationAgeMs: 60_000,
      digestDigit: 'b',
    });
    const executeAction = vi.fn(async () => {
      current = connectionsResourceAtRevision({
        revision: 2,
        enabled: true,
        maximumObservationAgeMs: 5 * 60_000,
        digestDigit: 'c',
      });
      return { kind: 'ready' as const, connectionId: 'connection-1', revision: 2, authorityEpoch: 1 };
    });
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'fixture-instance-115', mountNonce: 'fixture-mount-115' },
      authorPlugin: { id: 'happier.channels', version: '0.0.0' },
      surface: renderSurface,
      surfaceContext: createChannelsSurfaceContext(),
      adapter: createChannelsSemanticAdapter(),
      handlers: {
        selectActionInput: async () => ({ kind: 'cancelled' as const }),
        executeAction,
        readResource: async ({ resource }) => {
          const localId = typeof resource === 'string' ? resource : resource.localId;
          if (localId === BINDINGS_RESOURCE.localId) return bindingsResource;
          if (localId === CONNECTIONS_RESOURCE.localId) return current;
          throw new Error(`Unexpected Resource: ${localId}`);
        },
      },
    });

    try {
      await pressByTestId('channels-connection-connection-1');
      await fixture.press(await fixture.getByRole('radio', {
        name: editedObservationAge,
        state: { checked: false },
      }));
      await pressByTestId('channels-connection-save');
      await vi.waitFor(() => {
        expect(executeAction).toHaveBeenCalledTimes(1);
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
      maximumObservationAgeMs: 60_000,
      digestDigit: 'b',
    });
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'fixture-instance-116', mountNonce: 'fixture-mount-116' },
      authorPlugin: { id: 'happier.channels', version: '0.0.0' },
      surface: renderSurface,
      surfaceContext: createChannelsSurfaceContext(),
      adapter: createChannelsSemanticAdapter(),
      handlers: {
        selectActionInput: async () => ({ kind: 'cancelled' as const }),
        executeAction: async () => {
          throw new Error('A clean rebase must not invoke an Action.');
        },
        readResource: async ({ resource }) => {
          const localId = typeof resource === 'string' ? resource : resource.localId;
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
        enabled: true,
        maximumObservationAgeMs: 120_000,
        digestDigit: 'c',
      });
      await pressByTestId('channels-detail-resource-refresh');

      expect(document.querySelector('[data-testid="channels-connection-source-changed"]')).toBeNull();
      await expect(fixture.getByRole('radio', {
        name: '2 minutes',
        state: { checked: true },
      })).resolves.toBeDefined();
      expect(document.querySelector('[data-testid="channels-connection-save"]')?.getAttribute('aria-disabled'))
        .not.toBe('true');
    } finally {
      await fixture.dispose();
    }
  });
});

describe('Channels connection lifecycle actions', () => {
  it('makes an occurrence conflict terminal over an older blocked poll and leaves deletion as the available exit', async () => {
    const resource = connectionsResourceWithIngressConflict();
    const executeAction = vi.fn(async () => {
      throw new Error('A terminal occurrence conflict must not offer a polling recovery Action.');
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
          const localId = typeof requested === 'string' ? requested : requested.localId;
          if (localId === BINDINGS_RESOURCE.localId) return bindingsResource;
          if (localId === CONNECTIONS_RESOURCE.localId) return resource;
          throw new Error(`Unexpected Resource: ${localId}`);
        },
      },
    });

    try {
      await expect(fixture.getByText('Incoming occurrence conflict needs attention')).resolves.toBeDefined();
      await pressByTestId('channels-connection-connection-1');
      expect(document.querySelector('[data-testid="channels-ingress-occurrence-conflict-disclosure"]')).not.toBeNull();
      await expect(fixture.queryByRole('button', { name: 'Retry polling' })).resolves.toBeUndefined();
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
          const localId = typeof resource === 'string' ? resource : resource.localId;
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
          const localId = typeof resource === 'string' ? resource : resource.localId;
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
          expectedRevision: 1,
          authorityEpoch: 1,
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
        maximumObservationAgeMs: 60_000,
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
          const localId = typeof resource === 'string' ? resource : resource.localId;
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
        expectedAuthorityEpoch: 1,
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
          const localId = typeof resource === 'string' ? resource : resource.localId;
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
          const localId = typeof resource === 'string' ? resource : resource.localId;
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
          const localId = typeof resource === 'string' ? resource : resource.localId;
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
          const localId = typeof resource === 'string' ? resource : resource.localId;
          if (localId === BINDINGS_RESOURCE.localId) return bindingsResource;
          if (localId === CONNECTIONS_RESOURCE.localId) return connectionsResource;
          throw new Error(`Unexpected Resource: ${localId}`);
        },
      },
    });

    try {
      await pressButtonWithAccessibleLabelFragment('Example conversation');

      await pressByTestId('channels-connection-delete');
      expect(executeAction).not.toHaveBeenCalled();
      await expect(fixture.getByText('Delete this connection?')).resolves.toBeDefined();
      await fixture.press(await fixture.getByRole('button', { name: 'Confirm deletion' }));

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

  it('requires explicit confirmation to accept a history baseline, returns Cancel focus, and rereads the cleared gap', async () => {
    const firstGap = connectionsResourceWithHistoryGap({
      revision: 4,
      authorityEpoch: 2,
      reportedAt: 1_700_000_000_000,
      reason: 'providerHistoryUnavailable',
      digestDigit: 'e',
    });
    let connectionReads = 0;
    let baselineAccepted = false;
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
      expect(request.action).toBe(CONVERSATION_MANAGEMENT_ACTION_IDS_V1.streamBaselineAccept);
      expect(request.input).toEqual({ connectionId: 'connection-1', expectedRevision: 4 });
      baselineAccepted = true;
      return {
        kind: 'updated',
        connectionId: 'connection-1',
        revision: 5,
        authorityEpoch: 2,
      };
    });
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'fixture-instance-128', mountNonce: 'fixture-mount-128' },
      authorPlugin: { id: 'happier.channels', version: '0.0.0' },
      surface: renderSurface,
      surfaceContext: createChannelsSurfaceContext(),
      adapter: createChannelsSemanticAdapter(emptyDataClient, presentationHost),
      handlers: {
        selectActionInput: async () => ({ kind: 'cancelled' as const }),
        executeAction,
        readResource: async ({ resource }) => {
          const localId = typeof resource === 'string' ? resource : resource.localId;
          if (localId === BINDINGS_RESOURCE.localId) return bindingsResource;
          if (localId === CONNECTIONS_RESOURCE.localId) {
            connectionReads += 1;
            return baselineAccepted ? connectionsResource : firstGap;
          }
          throw new Error(`Unexpected Resource: ${localId}`);
        },
      },
    });

    try {
      await pressButtonWithAccessibleLabelFragment('Example conversation');
      await fixture.press(await fixture.getByRole('button', { name: 'Accept new history baseline' }));
      expect(executeAction).not.toHaveBeenCalled();
      const confirm = document.querySelector<HTMLElement>('[data-testid="channels-history-gap-baseline-confirm"]');
      expect(confirm).not.toBeNull();
      expect(document.activeElement).toBe(confirm);

      await fixture.press(await fixture.getByRole('button', { name: 'Cancel' }));
      const opener = document.querySelector<HTMLElement>('[data-testid="channels-history-gap-baseline-accept"]');
      expect(opener).not.toBeNull();
      expect(document.activeElement).toBe(opener);
      expect(executeAction).not.toHaveBeenCalled();
      expect(focusTarget).toHaveBeenCalledTimes(2);

      await fixture.press(await fixture.getByRole('button', { name: 'Accept new history baseline' }));
      await fixture.press(await fixture.getByRole('button', { name: 'Confirm new history baseline' }));
      await vi.waitFor(() => {
        expect(executeAction).toHaveBeenCalledTimes(1);
        expect(connectionReads).toBeGreaterThanOrEqual(2);
      });
      await expect(fixture.queryByRole('button', { name: 'Accept new history baseline' })).resolves.toBeUndefined();
      expect(document.querySelector('[data-testid="channels-history-gap-disclosure"]')).toBeNull();
      expect(focusTarget).toHaveBeenCalled();
    } finally {
      await fixture.dispose();
    }
  });

  it('replaces a stale history-gap confirmation with the current Resource revision before dispatch', async () => {
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
      { kind: 'updated', connectionId: 'connection-1', revision: 6, authorityEpoch: 3 }
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
          const localId = typeof resource === 'string' ? resource : resource.localId;
          if (localId === BINDINGS_RESOURCE.localId) return bindingsResource;
          if (localId === CONNECTIONS_RESOURCE.localId) return current;
          throw new Error(`Unexpected Resource: ${localId}`);
        },
      },
    });

    try {
      await pressButtonWithAccessibleLabelFragment('Example conversation');
      await fixture.press(await fixture.getByRole('button', { name: 'Accept new history baseline' }));
      expect(executeAction).not.toHaveBeenCalled();
      current = connectionsResourceWithHistoryGap({
        revision: 5,
        authorityEpoch: 3,
        reportedAt: 1_700_000_001_000,
        reason: 'applicationAdmissionLost',
        digestDigit: 'f',
      });
      await pressByTestId('channels-detail-resource-refresh');
      await expect(fixture.queryByRole('button', { name: 'Confirm new history baseline' })).resolves.toBeUndefined();
      expect(executeAction).not.toHaveBeenCalled();

      await fixture.press(await fixture.getByRole('button', { name: 'Accept new history baseline' }));
      await fixture.press(await fixture.getByRole('button', { name: 'Confirm new history baseline' }));
      await vi.waitFor(() => expect(executeAction).toHaveBeenCalledTimes(1));
      expect(executeAction.mock.calls[0]?.[0].action)
        .toBe(CONVERSATION_MANAGEMENT_ACTION_IDS_V1.streamBaselineAccept);
      expect(executeAction.mock.calls[0]?.[0].input)
        .toEqual({ connectionId: 'connection-1', expectedRevision: 5 });
    } finally {
      await fixture.dispose();
    }
  });

  it('locks an unknown history-baseline outcome until a fresh Resource reread clears the observed gap', async () => {
    const firstGap = connectionsResourceWithHistoryGap({
      revision: 4,
      authorityEpoch: 2,
      reportedAt: 1_700_000_000_000,
      reason: 'providerHistoryUnavailable',
      digestDigit: 'e',
    });
    let connectionReads = 0;
    let baselineOutcomeUnknown = false;
    let resolveReread: ((value: ResourceContent) => void) | undefined;
    const executeAction = vi.fn(async () => {
      baselineOutcomeUnknown = true;
      throw new PluginError({ code: 'timeout', message: 'The baseline acceptance may have reached the provider.' });
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
          const localId = typeof resource === 'string' ? resource : resource.localId;
          if (localId === BINDINGS_RESOURCE.localId) return bindingsResource;
          if (localId === CONNECTIONS_RESOURCE.localId) {
            connectionReads += 1;
            if (!baselineOutcomeUnknown) return firstGap;
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
      await fixture.press(await fixture.getByRole('button', { name: 'Accept new history baseline' }));
      await fixture.press(await fixture.getByRole('button', { name: 'Confirm new history baseline' }));
      await expect(fixture.getByText('Could not confirm the history baseline request')).resolves.toBeDefined();
      await expect(fixture.findByRole('button', {
        name: 'Accept new history baseline',
        state: { disabled: true },
      })).resolves.toBeDefined();

      const readsBeforeReconcile = connectionReads;
      await pressByTestId('channels-history-gap-baseline-outcome-unknown-reconcile');
      await vi.waitFor(() => {
        expect(connectionReads).toBeGreaterThan(readsBeforeReconcile);
        expect(resolveReread).toBeTypeOf('function');
      });
      expect(executeAction).toHaveBeenCalledTimes(1);

      await act(async () => {
        resolveReread?.(connectionsResource);
      });
      await expect(fixture.queryByRole('button', { name: 'Accept new history baseline' })).resolves.toBeUndefined();
      expect(document.querySelector('[data-testid="channels-history-gap-disclosure"]')).toBeNull();
      expect(executeAction).toHaveBeenCalledTimes(1);
    } finally {
      await fixture.dispose();
    }
  });

  it('offers explicit accept-loss abandonment while an old transport stop is unconfirmed', async () => {
    const executeAction = vi.fn(async ({ action }: PluginUiTestkitExecuteActionInput) => {
      if (action === CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionAbandon) {
        return {
          kind: 'rejoined',
          connectionId: 'connection-1',
          revision: 2,
          authorityEpoch: 2,
          acceptedPossibleLoss: true,
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
          const localId = typeof resource === 'string' ? resource : resource.localId;
          if (localId === BINDINGS_RESOURCE.localId) return bindingsResource;
          if (localId === CONNECTIONS_RESOURCE.localId) return oldTransportStopUnconfirmedConnectionsResource;
          throw new Error(`Unexpected Resource: ${localId}`);
        },
      },
    });

    try {
      await pressButtonWithAccessibleLabelFragment('Example conversation');

      expect(document.querySelector('[data-testid="channels-old-transport-stop-unconfirmed"]')).not.toBeNull();
      expect(document.querySelector('[data-testid="channels-connection-delete"]')).toBeNull();
      await pressByTestId('channels-connection-accept-loss');
      expect(executeAction).not.toHaveBeenCalled();
      await expect(fixture.getByText('Accept possible loss?')).resolves.toBeDefined();
      await fixture.press(await fixture.getByRole('button', { name: 'Confirm accepting possible loss' }));

      await vi.waitFor(() => {
        expect(executeAction).toHaveBeenCalledWith(expect.objectContaining({
          action: CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionAbandon,
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

  it('offers endpoint repair instead of accept-loss while a durable-push target move is owed', async () => {
    const executeAction = vi.fn(async ({ action }: PluginUiTestkitExecuteActionInput) => {
      if (action === CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionAbandon) {
        return {
          kind: 'rejoined',
          connectionId: 'connection-1',
          revision: 2,
          authorityEpoch: 1,
          acceptedPossibleLoss: false,
        };
      }
      throw new Error(`Unexpected mounted Action: ${String(action)}`);
    });
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'fixture-instance-132', mountNonce: 'fixture-mount-132' },
      authorPlugin: { id: 'happier.channels', version: '0.0.0' },
      surface: renderSurface,
      surfaceContext: createChannelsSurfaceContext(),
      adapter: createChannelsSemanticAdapter(),
      handlers: {
        selectActionInput: async () => ({ kind: 'cancelled' as const }),
        executeAction,
        readResource: async ({ resource }) => {
          const localId = typeof resource === 'string' ? resource : resource.localId;
          if (localId === BINDINGS_RESOURCE.localId) return bindingsResource;
          if (localId === CONNECTIONS_RESOURCE.localId) return endpointRetargetOwedConnectionsResource;
          throw new Error(`Unexpected Resource: ${localId}`);
        },
      },
    });

    try {
      await pressButtonWithAccessibleLabelFragment('Example conversation');

      // Nothing was lost: the Account endpoint is still deliverable and only
      // needs to be moved, so this must not be presented as a stop that may
      // never be confirmed or as a loss the owner has to accept.
      expect(document.querySelector('[data-testid="channels-connection-endpoint-retarget-owed"]')).not.toBeNull();
      expect(document.querySelector('[data-testid="channels-old-transport-stop-unconfirmed"]')).toBeNull();
      expect(document.querySelector('[data-testid="channels-connection-accept-loss"]')).toBeNull();
      // Deleting the connection drops the endpoint reference entirely, so it
      // stays available and this state is never a dead end.
      expect(document.querySelector('[data-testid="channels-connection-delete"]')).not.toBeNull();

      // Repair is not destructive, so it runs without a loss confirmation.
      await pressByTestId('channels-connection-repair-endpoint');
      await vi.waitFor(() => {
        expect(executeAction).toHaveBeenCalledWith(expect.objectContaining({
          action: CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionAbandon,
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

  it('keeps accepted-loss disclosure, hides repeat abandonment, and permits the next delete operation', async () => {
    const executeAction = vi.fn(async ({ action }: PluginUiTestkitExecuteActionInput) => {
      if (action === CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionDelete) {
        return {
          kind: 'deletePending',
          connectionId: 'connection-1',
          revision: 3,
          authorityEpoch: 3,
          acceptedPossibleLoss: false,
        };
      }
      throw new Error(`Unexpected mounted Action: ${String(action)}`);
    });
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'fixture-instance-133', mountNonce: 'fixture-mount-133' },
      authorPlugin: { id: 'happier.channels', version: '0.0.0' },
      surface: renderSurface,
      surfaceContext: createChannelsSurfaceContext(),
      adapter: createChannelsSemanticAdapter(),
      handlers: {
        selectActionInput: async () => ({ kind: 'cancelled' as const }),
        executeAction,
        readResource: async ({ resource }) => {
          const localId = typeof resource === 'string' ? resource : resource.localId;
          if (localId === BINDINGS_RESOURCE.localId) return bindingsResource;
          if (localId === CONNECTIONS_RESOURCE.localId) return acceptedPossibleLossConnectionsResource;
          throw new Error(`Unexpected Resource: ${localId}`);
        },
      },
    });

    try {
      await pressButtonWithAccessibleLabelFragment('Example conversation');

      expect(document.querySelector('[data-testid="channels-old-transport-stop-unconfirmed"]')).not.toBeNull();
      expect(document.querySelector('[data-testid="channels-connection-accept-loss"]')).toBeNull();
      expect(document.querySelector('[data-testid="channels-connection-delete"]')).not.toBeNull();
      await pressByTestId('channels-connection-delete');
      expect(executeAction).not.toHaveBeenCalled();
      await expect(fixture.getByText('Delete this connection?')).resolves.toBeDefined();
      await fixture.press(await fixture.getByRole('button', { name: 'Confirm deletion' }));

      await vi.waitFor(() => {
        expect(executeAction).toHaveBeenCalledWith(expect.objectContaining({
          action: CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionDelete,
          input: {
            connectionId: 'connection-1',
            expectedRevision: 2,
          },
        }));
      });
    } finally {
      await fixture.dispose();
    }
  });
});

describe('Channels destructive confirmation focus', () => {
  it('moves focus into the binding delete confirmation and returns it to the opener on Cancel', async () => {
    const executeAction = vi.fn(async ({ action }: PluginUiTestkitExecuteActionInput) => {
      throw new Error(`Unexpected mounted Action: ${String(action)}`);
    });
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'fixture-instance-134', mountNonce: 'fixture-mount-134' },
      authorPlugin: { id: 'happier.channels', version: '0.0.0' },
      surface: renderSurface,
      surfaceContext: createChannelsPageSurfaceContext(),
      subPath: 'binding-1',
      adapter: createChannelsSemanticAdapter(emptyDataClient, focusTransferPresentationHost()),
      handlers: {
        selectActionInput: async () => ({ kind: 'cancelled' as const }),
        executeAction,
        readResource: bindingResourceReader(),
      },
    });

    try {
      await fixture.press(await fixture.getByRole('button', { name: 'Unlink…' }));
      const confirm = document.querySelector<HTMLElement>('[data-testid="channels-binding-delete-confirm-binding-1"]');
      expect(confirm).not.toBeNull();
      expect(document.activeElement).toBe(confirm);

      await fixture.press(await fixture.getByRole('button', { name: 'Cancel' }));
      const opener = document.querySelector<HTMLElement>('[data-testid="channels-binding-delete-binding-1"]');
      expect(opener).not.toBeNull();
      expect(document.activeElement).toBe(opener);
      expect(executeAction).not.toHaveBeenCalled();
    } finally {
      await fixture.dispose();
    }
  });

  it('moves focus into the connection delete confirmation and returns it to the opener on Cancel', async () => {
    const executeAction = vi.fn(async ({ action }: PluginUiTestkitExecuteActionInput) => {
      throw new Error(`Unexpected mounted Action: ${String(action)}`);
    });
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'fixture-instance-135', mountNonce: 'fixture-mount-135' },
      authorPlugin: { id: 'happier.channels', version: '0.0.0' },
      surface: renderSurface,
      surfaceContext: createChannelsSurfaceContext(),
      adapter: createChannelsSemanticAdapter(emptyDataClient, focusTransferPresentationHost()),
      handlers: {
        selectActionInput: async () => ({ kind: 'cancelled' as const }),
        executeAction,
        readResource: bindingResourceReader(),
      },
    });

    try {
      await pressButtonWithAccessibleLabelFragment('Example conversation');
      await pressByTestId('channels-connection-delete');
      const confirm = document.querySelector<HTMLElement>('[data-testid="channels-connection-delete-confirm"]');
      expect(confirm).not.toBeNull();
      expect(document.activeElement).toBe(confirm);

      await fixture.press(await fixture.getByRole('button', { name: 'Cancel' }));
      const opener = document.querySelector<HTMLElement>('[data-testid="channels-connection-delete"]');
      expect(opener).not.toBeNull();
      expect(document.activeElement).toBe(opener);
      expect(executeAction).not.toHaveBeenCalled();
    } finally {
      await fixture.dispose();
    }
  });
});

describe('Channels offline Account-local binding policy', () => {
  it('edits the Account-decidable binding policy through the shared transition and CAS owner without a daemon', async () => {
    const account = createOfflineChannelStateFixture();
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'fixture-instance-136', mountNonce: 'fixture-mount-136' },
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
      await fixture.press(await fixture.getByRole('radio', {
        name: 'Direct mentions only',
        state: { checked: false },
      }));
      await fixture.press(await fixture.getByRole('radio', {
        name: 'Eligible refusals',
        state: { checked: false },
      }));
      await fixture.press(await fixture.getByRole('switch', {
        name: 'Allow bot senders',
        state: { checked: false },
      }));
      // Admitting bot senders widens the binding's authority, so the shared
      // authority comparison routes the save through the same confirmation
      // boundary the daemon-backed editor uses.
      await fixture.press(await fixture.getByRole('button', { name: 'Review changes' }));
      await fixture.press(await fixture.getByRole('button', { name: 'Save binding' }));

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
        enabled: false,
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
        selectActionInput: async () => ({ kind: 'cancelled' as const }),
      },
    });

    try {
      await pressButtonWithAccessibleLabelFragment('Example conversation');
      await vi.waitFor(() => {
        expect(document.querySelector('[data-testid="channels-delivery-resolution-controls"]')).not.toBeNull();
      });
      await pressByTestId(`channels-delivery-resolution-discard-${OFFLINE_AMBIGUOUS_CUSTODY_ID}`);

      await vi.waitFor(() => {
        expect(account.deliveries.rows.get(OFFLINE_AMBIGUOUS_CUSTODY_ID)?.value.payload)
          .toMatchObject({ state: 'resolvedDiscarded' });
      });
      expect(account.deliveries.rows.get(OFFLINE_AMBIGUOUS_CUSTODY_ID)?.revision).toBe(4);
    } finally {
      await fixture.dispose();
    }
  });

  it('recovers an archived-destination delivery through the retained provider evidence', async () => {
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
      await vi.waitFor(() => {
        expect(document.querySelector(
          `[data-testid="channels-delivery-resolution-retry-${OFFLINE_AMBIGUOUS_CUSTODY_ID}"]`,
        )).not.toBeNull();
      });
      // The two terminal settlements are for a possible external effect; an
      // authoritative no-effect refusal must not offer them.
      expect(document.querySelector(
        `[data-testid="channels-delivery-resolution-accept-${OFFLINE_AMBIGUOUS_CUSTODY_ID}"]`,
      )).toBeNull();
      await pressByTestId(`channels-delivery-resolution-retry-${OFFLINE_AMBIGUOUS_CUSTODY_ID}`);

      await vi.waitFor(() => {
        expect(account.deliveries.rows.get(OFFLINE_AMBIGUOUS_CUSTODY_ID)?.value.payload)
          .toMatchObject({ state: 'ready', attemptCount: 0 });
      });
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
      // Mirroring the whole Session outward widens the binding's authority, so
      // the shared confirmation boundary (with the execution machine fact)
      // comes before the save.
      await fixture.press(await fixture.getByRole('button', { name: 'Review changes' }));
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
      adapter: createChannelsSemanticAdapter(account.dataClient),
      handlers: {
        selectActionInput: async () => ({ kind: 'cancelled' as const }),
      },
    });

    try {
      await fixture.press(await fixture.getByRole('button', { name: 'Edit binding' }));
      account.collection.failNextBatchWith = new PluginError({
        code: 'plugin_collection_cancelled',
        message: 'The binding policy write was cancelled after it crossed the mutation boundary.',
      });
      await fixture.press(await fixture.getByRole('radio', {
        name: 'Direct mentions only',
        state: { checked: false },
      }));
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
      await expect(fixture.getByRole('radio', {
        name: 'Direct mentions only',
        state: { checked: true },
      })).resolves.toBeDefined();

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
      adapter: createChannelsSemanticAdapter(account.dataClient),
      handlers: {
        selectActionInput: async () => ({ kind: 'cancelled' as const }),
      },
    });

    try {
      await fixture.press(await fixture.getByRole('button', { name: 'Edit binding' }));
      account.collection.failNextBatchWith = new PluginError({
        code: 'plugin_collection_cancelled',
        message: 'The binding policy write was cancelled after it crossed the mutation boundary.',
      });
      await fixture.press(await fixture.getByRole('radio', {
        name: 'Direct mentions only',
        state: { checked: false },
      }));
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
      await expect(fixture.getByRole('radio', {
        name: 'Direct mentions only',
        state: { checked: true },
      })).resolves.toBeDefined();
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
  ) {
    const surface = createSessionConversationsContext('session-under-test');
    const baseHostApi = createHostApiStub(surface);
    const hostApi = createHostApiStub(surface, {
      version: () => ({
        ...baseHostApi.version(),
        methods: ['readResource', 'openSurface'],
      }),
      ...(openSurface === undefined ? {} : { openSurface: openSurface as never }),
      readResource: async (resource) => {
        const localId = typeof resource === 'string' ? resource : resource.localId;
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
        const localId = typeof resource === 'string' ? resource : resource.localId;
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
        const localId = typeof resource === 'string' ? resource : resource.localId;
        if (localId === 'session-conversations-v1') {
          if (failReads) {
            throw new PluginError({ code: 'unavailable', message: 'The daemon transport is unavailable.' });
          }
          return sessionConversationsResource;
        }
        if (localId === CONNECTIONS_RESOURCE.localId) return connectionsResource;
        throw new Error(`Unexpected Resource: ${localId}`);
      },
      watchResource: (async (
        resource: unknown,
        listener: (event: ResourceSubscriptionEvent) => void,
      ) => {
        const localId = typeof resource === 'string'
          ? resource
          : (resource as { localId: string }).localId;
        if (localId === 'session-conversations-v1') deliver = listener;
        return { dispose: () => {} };
      }) as never,
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
          const localId = typeof resource === 'string' ? resource : resource.localId;
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

  it('resumes a paused conversation, and unlinks one only after an inline confirm', async () => {
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
      expect(executeAction).toHaveBeenCalledTimes(1);
      await fixture.press(await fixture.findByRole('button', { name: 'Unlink' }));
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
      const expected = new Intl.DateTimeFormat(sessionTabSurface().locale, { hour: '2-digit', minute: '2-digit' }).format(atMs);
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
      await vi.waitFor(() => expect(opened).toContainEqual(['conversations', 'link/connection-1']));
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
      await vi.waitFor(() => expect(opened).toContainEqual(['conversations', 'link/connection-1']));
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
          const localId = typeof resource === 'string' ? resource : resource.localId;
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

  it('keeps an enabled healthy connection reading as enabled and running', async () => {
    const fixture = await mountConnectionRows(connectionsResource);
    try {
      const row = await collapsedConnectionRow();
      expect(row.text).toContain('Enabled');
      expect(row.text).toContain('Runs on your selected machine');
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
      maximumObservationAgeMs: 60_000,
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
      maximumObservationAgeMs: 60_000,
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
          const localId = typeof resource === 'string' ? resource : resource.localId;
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
          const localId = typeof resource === 'string' ? resource : resource.localId;
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

  it('names each ambiguous delivery decision by its short custody identity offline', async () => {
    const account = createOfflineChannelStateFixture();
    const first = offlineAmbiguousDeliveryRow();
    const secondCustodyId = 'd'.repeat(43);
    const second = {
      ...offlineAmbiguousDeliveryRow(),
      rowId: secondCustodyId,
      value: {
        ...offlineAmbiguousDeliveryRow().value,
        id: secondCustodyId,
      },
    };
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
      await vi.waitFor(() => {
        expect(document.querySelectorAll('[data-testid^="channels-delivery-resolution-accept-"]').length).toBe(2);
      });
      // The privacy-safe delivery projection carries no endpoint label, so the
      // two rows' identical buttons are distinguished by their short custody
      // identities in the accessible names.
      const firstName = 'Accept as sent (Resolve delivery outcome — cccccccc)';
      const secondName = 'Accept as sent (Resolve delivery outcome — dddddddd)';
      await expect(fixture.getByRole('button', { name: firstName })).resolves.toBeDefined();
      await expect(fixture.getByRole('button', { name: secondName })).resolves.toBeDefined();
      await expect(fixture.getByRole('button', {
        name: `Discard delivery (Resolve delivery outcome — dddddddd)`,
      })).resolves.toBeDefined();
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
          const localId = typeof resource === 'string' ? resource : resource.localId;
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
        maximumObservationAgeMs: 60_000,
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
          const localId = typeof resource === 'string' ? resource : resource.localId;
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
  const readerFor = (bindings: ResourceContent, connections: ResourceContent = connectionsResource) => (
    async ({ resource }: Readonly<{ resource: string | Readonly<{ localId: string }> }>) => {
      const localId = typeof resource === 'string' ? resource : resource.localId;
      if (localId === BINDINGS_RESOURCE.localId) return bindings;
      if (localId === CONNECTIONS_RESOURCE.localId) return connections;
      throw new Error(`Unexpected Resource: ${localId}`);
    }
  );
  const opened = (calls: readonly (readonly [string, string])[]) => calls.map(([view, subPath]) => `${view}:${subPath}`);

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

  async function mountPage(input: Readonly<{
    subPath: string;
    bindings?: ResourceContent;
    connections?: ResourceContent;
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
        readResource: readerFor(input.bindings ?? bindingsResource, input.connections),
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
