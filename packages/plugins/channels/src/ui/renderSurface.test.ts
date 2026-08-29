// @vitest-environment jsdom

import { cloneElement, type ReactElement } from 'react';
import { PluginError, type JsonValue } from '@happier-dev/plugin-sdk';
import type { RenderContext, ResourceContent } from '@happier-dev/plugin-sdk/ui';
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
    immutableGenerationId: 'provider-generation-a',
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
  code: 'providerPermissionMissing' | 'providerConfigurationInvalid';
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
        immutableGenerationId: 'channels-target-generation-a',
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
        immutableGenerationId: 'channels-target-generation-a',
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
        immutableGenerationId: 'channels-target-generation-a',
      },
      points: [{
        pointId: CONVERSATION_PROVIDERS_CONTRIBUTION_POINT_ID_V1,
        protocols: [{
          protocol: providerProtocol(),
          contributions: [{
            contributor: {
              pluginId: 'com.example.alt-conversation-provider',
              contributionId: 'conversation-setup',
              immutableGenerationId: 'other-provider-generation-a',
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
                immutableGenerationId: 'other-provider-generation-a',
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
): PluginUiSemanticSurfaceAdapter<typeof renderSurface> {
  const rnwAdapter = createPluginUiRnwSemanticSurfaceAdapter();
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
        immutableGenerationId: 'provider-generation-1',
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

function offlineBindingRow(): OfflineChannelStateRow {
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
  };
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
      identity: {
        pluginId: 'happier.channels',
        pluginVersion: '0.0.0',
        viewId: 'channels-account',
        generation: 'channels-provider-setup-none',
        sessionId: 'session-1',
      },
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
          immutableGenerationId: 'channels-target-generation-a',
        },
        point: providerSetupOperation.point,
        contributor: providerSetupOperation.contributor,
      },
      connectedAccount: { kind: 'none' as const },
    };
    const submittedRemediation = {
      kind: 'submitted' as const,
      action: providerSetupRemediationOperation.action,
      input: { installation: 'external-provider-a' },
      selection: {
        target: {
          pluginId: 'happier.channels',
          immutableGenerationId: 'channels-target-generation-a',
        },
        point: providerSetupRemediationOperation.point,
        contributor: providerSetupRemediationOperation.contributor,
      },
      connectedAccount: { kind: 'none' as const },
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
      identity: {
        pluginId: 'happier.channels',
        pluginVersion: '0.0.0',
        viewId: 'channels-account',
        generation: 'channels-provider-remediation',
        sessionId: 'session-1',
      },
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
          immutableGenerationId: 'channels-target-generation-a',
        },
        point: providerSetupOperation.point,
        contributor: providerSetupOperation.contributor,
      },
      connectedAccount: { kind: 'none' as const },
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
      identity: {
        pluginId: 'happier.channels',
        pluginVersion: '0.0.0',
        viewId: 'channels-account',
        generation: 'channels-provider-remediation-cancel',
        sessionId: 'session-1',
      },
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
          immutableGenerationId: 'channels-target-generation-a',
        },
        point: providerSetupOperation.point,
        contributor: providerSetupOperation.contributor,
      },
      connectedAccount: { kind: 'none' as const },
    };
    const submittedRemediation = {
      kind: 'submitted' as const,
      action: providerSetupRemediationOperation.action,
      input: { installation: 'external-provider-a' },
      selection: {
        target: {
          pluginId: 'happier.channels',
          immutableGenerationId: 'channels-target-generation-a',
        },
        point: providerSetupRemediationOperation.point,
        contributor: providerSetupRemediationOperation.contributor,
      },
      connectedAccount: { kind: 'none' as const },
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
      identity: {
        pluginId: 'happier.channels',
        pluginVersion: '0.0.0',
        viewId: 'channels-account',
        generation: 'channels-provider-remediation-unknown',
        sessionId: 'session-1',
      },
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
          immutableGenerationId: 'channels-target-generation-a',
        },
        point: providerSetupOperation.point,
        contributor: providerSetupOperation.contributor,
      },
      connectedAccount: { kind: 'none' as const },
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
      identity: {
        pluginId: 'happier.channels',
        pluginVersion: '0.0.0',
        viewId: 'channels-account',
        generation: 'channels-provider-setup-draft-recovery',
        sessionId: 'session-1',
      },
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
          immutableGenerationId: 'channels-target-generation-a',
        },
        point: providerSetupOperation.point,
        contributor: providerSetupOperation.contributor,
      },
      connectedAccount: { kind: 'selected' as const, fieldPath: 'credentialRef', ref: credentialRef },
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
      identity: {
        pluginId: 'happier.channels',
        pluginVersion: '0.0.0',
        viewId: 'channels-account',
        generation: 'channels-provider-setup-selected-relay',
        sessionId: 'session-1',
      },
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
          immutableGenerationId: 'channels-target-generation-a',
        },
        point: providerSetupOperation.point,
        contributor: providerSetupOperation.contributor,
      },
      connectedAccount: { kind: 'selected' as const, fieldPath: 'credentialRef', ref: credentialRef },
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
      identity: {
        pluginId: 'happier.channels',
        pluginVersion: '0.0.0',
        viewId: 'channels-account',
        generation: 'channels-provider-setup-durable-push',
        sessionId: 'session-1',
      },
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

      // Only the first outer relay consumes the host retention; the
      // continuation is a plain dispatch of the same management Action.
      const createCalls = executeAction.mock.calls
        .map(([request]) => request)
        .filter((request) => request.action === CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionCreate);
      expect(createCalls).toHaveLength(3);
      expect((createCalls[0] as unknown as Readonly<{ consumeSelectedActionInput?: unknown }>)
        .consumeSelectedActionInput).toBe(true);
      expect((createCalls[1] as unknown as Readonly<{ consumeSelectedActionInput?: unknown }>)
        .consumeSelectedActionInput).toBeUndefined();
      expect(createCalls[1]?.selectedActionInput).toBeUndefined();
      expect(createCalls[2]?.input).toEqual(createCalls[1]?.input);
      expect(createCalls[2]?.selectedActionInput).toBeUndefined();
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
          immutableGenerationId: 'channels-target-generation-a',
        },
        point: providerSetupOperation.point,
        contributor: providerSetupOperation.contributor,
      },
      connectedAccount: { kind: 'selected' as const, fieldPath: 'credentialRef', ref: credentialRef },
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
          immutableGenerationId: 'channels-target-generation-a',
        },
        point: providerSetupOperation.point,
        contributor: providerSetupOperation.contributor,
      },
      connectedAccount: { kind: 'none' as const },
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
      identity: {
        pluginId: 'happier.channels',
        pluginVersion: '0.0.0',
        viewId: 'channels-account',
        generation: 'channels-provider-setup-currentness',
        sessionId: 'session-1',
      },
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
          immutableGenerationId: 'channels-target-generation-a',
        },
        point: providerSetupOperation.point,
        contributor: providerSetupOperation.contributor,
      },
      connectedAccount: { kind: 'none' as const },
    }));
    const executeAction = vi.fn(async ({ action }: PluginUiTestkitExecuteActionInput) => {
      if (action === CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionPrepare) {
        throw new PluginError({ code: 'timeout', message: 'The setup request timed out.' });
      }
      throw new Error(`Unexpected mounted Action: ${String(action)}`);
    });
    const surfaceContext = createChannelsSurfaceContext();
    const fixture = await createPluginUiTestkit({
      identity: {
        pluginId: 'happier.channels',
        pluginVersion: '0.0.0',
        viewId: 'channels-account',
        generation: 'channels-provider-setup-recovery',
        sessionId: 'session-1',
      },
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
      identity: {
        pluginId: 'happier.channels',
        pluginVersion: '0.0.0',
        viewId: 'channels-account',
        generation: 'channels-ingress-occurrence-conflict',
        sessionId: 'session-1',
      },
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
      identity: {
        pluginId: 'happier.channels',
        pluginVersion: '0.0.0',
        viewId: 'channels-account',
        generation: 'channels-ingress-attention-reread',
        sessionId: 'session-1',
      },
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
      identity: {
        pluginId: 'happier.channels',
        pluginVersion: '0.0.0',
        viewId: 'channels-account',
        generation: `channels-binding-create-${accountEncryptionMode}-privacy-disclosure`,
        sessionId: 'session-1',
      },
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
      identity: {
        pluginId: 'happier.channels',
        pluginVersion: '0.0.0',
        viewId: 'channels-account',
        generation: 'channels-binding-create-input-mode-capability',
        sessionId: 'session-1',
      },
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
      identity: {
        pluginId: 'happier.channels',
        pluginVersion: '0.0.0',
        viewId: 'channels-account',
        generation: 'channels-binding-create-step-navigation',
        sessionId: 'session-1',
      },
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
      identity: {
        pluginId: 'happier.channels',
        pluginVersion: '0.0.0',
        viewId: 'channels-account',
        generation: 'channels-binding-create-logical-focus',
        sessionId: 'session-1',
      },
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
      identity: {
        pluginId: 'happier.channels',
        pluginVersion: '0.0.0',
        viewId: 'channels-account',
        generation: 'channels-binding-create-existing-session',
        sessionId: 'session-1',
      },
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
                approvals: { kind: 'off' },
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
      identity: {
        pluginId: 'happier.channels',
        pluginVersion: '0.0.0',
        viewId: 'channels-account',
        generation: 'channels-binding-pairing-expiry',
        sessionId: 'session-1',
      },
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
      if (action === CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionPairingFinalize) {
        finalizeAttempts += 1;
        if (finalizeAttempts === 1) {
          throw new PluginError({ code: 'timeout', message: 'The pairing finalization timed out.' });
        }
        return {
          kind: 'created',
          binding: {
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
          },
        };
      }
      throw new Error(`Unexpected mounted Action: ${String(action)}`);
    });
    const fixture = await createPluginUiTestkit({
      identity: {
        pluginId: 'happier.channels',
        pluginVersion: '0.0.0',
        viewId: 'channels-account',
        generation: 'channels-binding-pairing-fallback',
        sessionId: 'session-1',
      },
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
      adapter: createChannelsSemanticAdapter(),
      handlers: {
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
      await fixture.press(await fixture.getByRole('button', { name: 'Copy pairing token' }));
      await fixture.press(await fixture.getByRole('button', { name: 'Open pairing link' }));
      expect(copiedValues).toEqual(['ABCDEFGH']);
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
      await expect(fixture.getByText('Pairing completed')).resolves.toBeDefined();
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
      identity: {
        pluginId: 'happier.channels',
        pluginVersion: '0.0.0',
        viewId: 'channels-account',
        generation: 'channels-pairing-create-unknown',
        sessionId: 'session-1',
      },
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
      identity: {
        pluginId: 'happier.channels',
        pluginVersion: '0.0.0',
        viewId: 'channels-account',
        generation: 'channels-pairing-create-unknown-exact',
        sessionId: 'session-1',
      },
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
        identity: {
          pluginId: 'happier.channels',
          pluginVersion: '0.0.0',
          viewId: 'channels-account',
          generation: `channels-pairing-cancel-${fixtureCase.name}`,
          sessionId: 'session-1',
        },
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
        identity: {
          pluginId: 'happier.channels',
          pluginVersion: '0.0.0',
          viewId: 'channels-account',
          generation: `channels-binding-not-pairing-${settlement.result.kind}`,
          sessionId: 'session-1',
        },
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
      identity: {
        pluginId: 'happier.channels',
        pluginVersion: '0.0.0',
        viewId: 'channels-account',
        generation: 'channels-binding-new-session-cancelled',
        sessionId: 'session-1',
      },
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
              execution: { targetType: 'existing_session', enabled: true },
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
      identity: {
        pluginId: 'happier.channels',
        pluginVersion: '0.0.0',
        viewId: 'channels-account',
        generation: 'channels-binding-automation-target',
        sessionId: 'session-1',
      },
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
        'A message from the allowed sender starts this Automation, which sends work into the existing Session it targets.',
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
      identity: {
        pluginId: 'happier.channels',
        pluginVersion: '0.0.0',
        viewId: 'channels-account',
        generation: 'channels-binding-target-pages',
        sessionId: 'session-1',
      },
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
      identity: {
        pluginId: 'happier.channels',
        pluginVersion: '0.0.0',
        viewId: 'channels-account',
        generation: 'channels-binding-editor-automation-retarget-delivery',
        sessionId: 'session-1',
      },
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
      identity: {
        pluginId: 'happier.channels',
        pluginVersion: '0.0.0',
        viewId: 'channels-account',
        generation: 'channels-binding-editor-direct-session-retarget',
        sessionId: 'session-1',
      },
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
      identity: {
        pluginId: 'happier.channels',
        pluginVersion: '0.0.0',
        viewId: 'channels-account',
        generation: 'channels-binding-create-outcome-unknown',
        sessionId: 'session-1',
      },
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
      identity: {
        pluginId: 'happier.channels',
        pluginVersion: '0.0.0',
        viewId: 'channels-account',
        generation: 'channels-binding-editor-private-read-and-reread',
        sessionId: 'session-1',
      },
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
      identity: {
        pluginId: 'happier.channels',
        pluginVersion: '0.0.0',
        viewId: 'channels-account',
        generation: 'channels-binding-editor-foreign-provider-reselection',
        sessionId: 'session-1',
      },
      surface: renderSurface,
      surfaceContext: createChannelsSurfaceContextWithForeignProvider(),
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
      identity: {
        pluginId: 'happier.channels',
        pluginVersion: '0.0.0',
        viewId: 'channels-account',
        generation: 'channels-binding-editor-complete-guarded-save',
        sessionId: 'session-1',
      },
      surface: renderSurface,
      surfaceContext: createChannelsSurfaceContext(),
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
      await enterTextByAccessibleLabel('Inbound debounce (ms)', '750');
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
      identity: {
        pluginId: 'happier.channels',
        pluginVersion: '0.0.0',
        viewId: 'channels-account',
        generation: 'channels-binding-editor-approvals',
        sessionId: 'session-1',
      },
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
      identity: {
        pluginId: 'happier.channels',
        pluginVersion: '0.0.0',
        viewId: 'channels-account',
        generation: 'channels-binding-editor-authoritative-clamp',
        sessionId: 'session-1',
      },
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
      identity: {
        pluginId: 'happier.channels',
        pluginVersion: '0.0.0',
        viewId: 'channels-account',
        generation: 'channels-binding-editor-collection-quota-incompatible',
        sessionId: 'session-1',
      },
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
      identity: {
        pluginId: 'happier.channels',
        pluginVersion: '0.0.0',
        viewId: 'channels-account',
        generation: 'channels-binding-editor-summary-currentness',
        sessionId: 'session-1',
      },
      surface: renderSurface,
      surfaceContext: createChannelsSurfaceContext(),
      adapter: createChannelsSemanticAdapter(),
      handlers: {
        selectActionInput: async () => ({ kind: 'cancelled' as const }),
        executeAction,
        readResource: bindingResourceReader(() => {
          bindingsReadCount += 1;
          return bindingsReadCount === 1 ? bindingsResource : updatedSummaryResource;
        }),
      },
    });

    try {
      await fixture.press(await fixture.getByRole('button', { name: 'Edit binding' }));
      await expect(fixture.getByRole('heading', { name: 'Edit binding' })).resolves.toBeDefined();
      await fixture.press(await fixture.getByRole('switch', {
        name: 'Enable this binding',
        state: { checked: true },
      }));
      await pressButtonWithAccessibleLabelFragment('Refresh');
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
      identity: {
        pluginId: 'happier.channels',
        pluginVersion: '0.0.0',
        viewId: 'channels-account',
        generation: 'channels-binding-editor-unknown-outcome',
        sessionId: 'session-1',
      },
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
      identity: {
        pluginId: 'happier.channels',
        pluginVersion: '0.0.0',
        viewId: 'channels-account',
        generation: 'channels-binding-editor-cancel-focus',
        sessionId: 'session-1',
      },
      surface: renderSurface,
      surfaceContext: createChannelsSurfaceContext(),
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
      identity: {
        pluginId: 'happier.channels',
        pluginVersion: '0.0.0',
        viewId: 'channels-account',
        generation: 'channels-binding-enable-quota-incompatible',
        sessionId: 'session-1',
      },
      surface: renderSurface,
      surfaceContext: createChannelsSurfaceContext(),
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
      await fixture.press(await fixture.getByRole('switch', {
        name: 'Binding enabled',
        state: { checked: true },
      }));

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
      identity: {
        pluginId: 'happier.channels',
        pluginVersion: '0.0.0',
        viewId: 'channels-account',
        generation: 'channels-binding-enable-localized-failure',
        sessionId: 'session-1',
      },
      surface: renderSurface,
      surfaceContext: {
        ...createChannelsSurfaceContext(),
        translations: {
          'plugins.channels.surface.bindingEnableFailedDescription': 'Aktualisiere die Bindungsdetails und versuche es erneut.',
        },
      },
      adapter: createChannelsSemanticAdapter(),
      handlers: {
        selectActionInput: async () => ({ kind: 'cancelled' as const }),
        executeAction,
        readResource: bindingResourceReader(),
      },
    });

    try {
      await fixture.press(await fixture.getByRole('switch', {
        name: 'Binding enabled',
        state: { checked: true },
      }));
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
      identity: {
        pluginId: 'happier.channels',
        pluginVersion: '0.0.0',
        viewId: 'channels-account',
        generation: 'channels-binding-delete',
        sessionId: 'session-1',
      },
      surface: renderSurface,
      surfaceContext: createChannelsSurfaceContext(),
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
      await fixture.press(await fixture.getByRole('button', { name: 'Delete binding' }));
      expect(executeAction).not.toHaveBeenCalled();
      await expect(fixture.getByText('Delete this binding?')).resolves.toBeDefined();
      await fixture.press(await fixture.getByRole('button', { name: 'Confirm deletion' }));

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
      identity: {
        pluginId: 'happier.channels',
        pluginVersion: '0.0.0',
        viewId: 'channels-account',
        generation: 'channels-binding-delete-outcome-unknown',
        sessionId: 'session-1',
      },
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
      await fixture.press(await fixture.getByRole('button', { name: 'Delete binding' }));
      expect(executeAction).not.toHaveBeenCalled();
      await expect(fixture.getByText('Delete this binding?')).resolves.toBeDefined();
      await fixture.press(await fixture.getByRole('button', { name: 'Confirm deletion' }));
      await expect(fixture.getByText('Could not confirm binding deletion')).resolves.toBeDefined();
      await expect(fixture.findByRole('button', {
        name: 'Delete binding',
        state: { disabled: true },
      })).resolves.toBeDefined();

      await pressByTestId('channels-binding-delete-outcome-unknown-reconcile-binding-1');
      await vi.waitFor(() => {
        expect(bindingsReadCount).toBe(2);
        expect(resolveBindingsRefresh).toBeTypeOf('function');
      });
      await expect(fixture.findByRole('button', {
        name: 'Delete binding',
        state: { disabled: true },
      })).resolves.toBeDefined();

      await act(async () => {
        resolveBindingsRefresh?.(bindingsResource);
      });
      await vi.waitFor(async () => {
        const deleteBinding = await fixture.getByRole('button', { name: 'Delete binding' });
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
      identity: {
        pluginId: 'happier.channels',
        pluginVersion: '0.0.0',
        viewId: 'channels-account',
        generation: 'channels-binding-delete-finalizing',
        sessionId: 'session-1',
      },
      surface: renderSurface,
      surfaceContext: createChannelsSurfaceContext(),
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
        expect(document.querySelector('[data-testid="channels-binding-binding-1"]')?.getAttribute('aria-label'))
          .toContain('Deletion cleanup in progress');
      });
      await expect(fixture.getByRole('switch', {
        name: 'Binding enabled',
        state: { checked: false, disabled: true },
      })).resolves.toBeDefined();
      await expect(fixture.queryByRole('button', { name: 'Edit binding' })).resolves.toBeUndefined();
      expect(executeAction).not.toHaveBeenCalled();
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
      identity: {
        pluginId: 'happier.channels',
        pluginVersion: '0.0.0',
        viewId: 'channels-account',
        generation: 'channels-ingress-conflict-terminal-status',
        sessionId: 'session-1',
      },
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
      identity: {
        pluginId: 'happier.channels',
        pluginVersion: '0.0.0',
        viewId: 'channels-account',
        generation: 'channels-provider-readiness',
        sessionId: 'session-1',
      },
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
      identity: {
        pluginId: 'happier.channels',
        pluginVersion: '0.0.0',
        viewId: 'channels-account',
        generation: 'channels-connection-retest',
        sessionId: 'session-1',
      },
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
      identity: {
        pluginId: 'happier.channels',
        pluginVersion: '0.0.0',
        viewId: 'channels-account',
        generation: 'channels-connection-sibling-identity',
        sessionId: 'session-1',
      },
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
          immutableGenerationId: 'channels-target-generation-a',
        },
        point: providerSetupOperation.point,
        contributor: providerSetupOperation.contributor,
      },
      connectedAccount: { kind: 'selected' as const, fieldPath: 'credentialRef', ref: credentialRef },
    };
    const selectedActionInput = {
      operation: providerSetupOperation,
      result: submittedProviderSetup,
    } as const;
    const selectActionInput = vi.fn(async () => submittedProviderSetup);
    const executeAction = vi.fn(async (request: PluginUiTestkitExecuteActionInput) => {
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
        .consumeSelectedActionInput).toBe(true);
      return {
        kind: 'transferred',
        connectionId: 'connection-1',
        revision: 2,
        authorityEpoch: 2,
      };
    });
    const fixture = await createPluginUiTestkit({
      identity: {
        pluginId: 'happier.channels',
        pluginVersion: '0.0.0',
        viewId: 'channels-account',
        generation: 'channels-connection-transfer',
        sessionId: 'session-1',
      },
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
      await fixture.press(await fixture.getByRole('radio', {
        name: 'Live socket',
        state: { checked: false },
      }));
      await fixture.press(await fixture.getByRole('button', { name: 'Back' }));
      await expect(fixture.queryByRole('button', { name: 'Confirm transfer' })).resolves.toBeUndefined();
      await fixture.press(await fixture.getByRole('button', { name: 'Transfer with Integration provider' }));
      await expect(fixture.getByRole('radio', {
        name: 'Live socket',
        state: { checked: true },
      })).resolves.toBeDefined();
      await fixture.press(await fixture.getByRole('button', { name: 'Confirm transfer' }));

      await vi.waitFor(() => {
        expect(selectActionInput).toHaveBeenCalledTimes(2);
        expect(selectActionInput).toHaveBeenCalledWith({
          request: { operation: providerSetupOperation },
          signal: expect.anything(),
        });
        expect(executeAction).toHaveBeenCalledTimes(1);
        expect(connectionsReadCount).toBeGreaterThanOrEqual(2);
      });
      expect(executeAction.mock.calls.map(([request]) => request.action)).not.toContain(
        CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionPrepare,
      );
      expect(executeAction.mock.calls.map(([request]) => request.action)).not.toContain(
        CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionCreate,
      );
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
      identity: {
        pluginId: 'happier.channels',
        pluginVersion: '0.0.0',
        viewId: 'channels-account',
        generation: 'channels-connection-transfer-provider-identity',
        sessionId: 'session-1',
      },
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
      identity: {
        pluginId: 'happier.channels',
        pluginVersion: '0.0.0',
        viewId: 'channels-account',
        generation: 'channels-connection-delete',
        sessionId: 'session-1',
      },
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
      identity: {
        pluginId: 'happier.channels',
        pluginVersion: '0.0.0',
        viewId: 'channels-account',
        generation: 'channels-history-gap-baseline-confirm',
        sessionId: 'session-1',
      },
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
      identity: {
        pluginId: 'happier.channels',
        pluginVersion: '0.0.0',
        viewId: 'channels-account',
        generation: 'channels-history-gap-baseline-currentness',
        sessionId: 'session-1',
      },
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
      identity: {
        pluginId: 'happier.channels',
        pluginVersion: '0.0.0',
        viewId: 'channels-account',
        generation: 'channels-history-gap-baseline-unknown',
        sessionId: 'session-1',
      },
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
      identity: {
        pluginId: 'happier.channels',
        pluginVersion: '0.0.0',
        viewId: 'channels-account',
        generation: 'channels-connection-abandon',
        sessionId: 'session-1',
      },
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
      identity: {
        pluginId: 'happier.channels',
        pluginVersion: '0.0.0',
        viewId: 'channels-account',
        generation: 'channels-connection-accepted-loss',
        sessionId: 'session-1',
      },
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
      identity: {
        pluginId: 'happier.channels',
        pluginVersion: '0.0.0',
        viewId: 'channels-account',
        generation: 'channels-binding-delete-confirmation-focus',
        sessionId: 'session-1',
      },
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
      await fixture.press(await fixture.getByRole('button', { name: 'Delete binding' }));
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
      identity: {
        pluginId: 'happier.channels',
        pluginVersion: '0.0.0',
        viewId: 'channels-account',
        generation: 'channels-connection-delete-confirmation-focus',
        sessionId: 'session-1',
      },
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
      identity: {
        pluginId: 'happier.channels',
        pluginVersion: '0.0.0',
        viewId: 'channels-account',
        generation: 'channels-offline-binding-policy',
        sessionId: 'session-1',
      },
      surface: renderSurface,
      surfaceContext: createChannelsSurfaceContext(),
      adapter: createChannelsSemanticAdapter(account.dataClient),
      handlers: {
        selectActionInput: async () => ({ kind: 'cancelled' as const }),
      },
    });

    try {
      // Proves the cold-offline read path reached the canonical Account rows
      // before any assertion about what the surface offers to edit.
      await expect(fixture.getByRole('switch', {
        name: 'Binding enabled',
        state: { checked: false },
      })).resolves.toBeDefined();
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
      identity: {
        pluginId: 'happier.channels',
        pluginVersion: '0.0.0',
        viewId: 'channels-account',
        generation: 'channels-offline-delivery-resolution',
        sessionId: 'session-1',
      },
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
      identity: {
        pluginId: 'happier.channels',
        pluginVersion: '0.0.0',
        viewId: 'channels-account',
        generation: 'channels-offline-archive-recovery',
        sessionId: 'session-1',
      },
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
      identity: {
        pluginId: 'happier.channels',
        pluginVersion: '0.0.0',
        viewId: 'channels-account',
        generation: 'channels-offline-binding-policy-boundary',
        sessionId: 'session-1',
      },
      surface: renderSurface,
      surfaceContext: createChannelsSurfaceContext(),
      adapter: createChannelsSemanticAdapter(account.dataClient),
      handlers: {
        selectActionInput: async () => ({ kind: 'cancelled' as const }),
      },
    });

    try {
      // Proves the cold-offline read path reached the canonical Account rows
      // before any assertion about what the surface offers to edit.
      await expect(fixture.getByRole('switch', {
        name: 'Binding enabled',
        state: { checked: false },
      })).resolves.toBeDefined();
      await fixture.press(await fixture.getByRole('button', { name: 'Edit binding' }));
      await expect(fixture.queryByRole('button', {
        name: 'Re-resolve conversation and allowed senders',
      })).resolves.toBeUndefined();
      await expect(fixture.queryByRole('button', { name: 'Change target' })).resolves.toBeUndefined();
      await expect(fixture.queryByRole('button', { name: 'Delete binding' })).resolves.toBeUndefined();
      expect(account.collection.batches).toHaveLength(0);
    } finally {
      await fixture.dispose();
    }
  });

  it('offers and saves the Account-decidable Session target policy from the offline binding editor', async () => {
    const account = createOfflineChannelStateFixture();
    const fixture = await createPluginUiTestkit({
      identity: {
        pluginId: 'happier.channels',
        pluginVersion: '0.0.0',
        viewId: 'channels-account',
        generation: 'channels-offline-binding-target-policy',
        sessionId: 'session-1',
      },
      surface: renderSurface,
      surfaceContext: createChannelsSurfaceContext(),
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

  it('keeps an ambiguous offline binding write locked until an explicit reread reconciles it', async () => {
    const account = createOfflineChannelStateFixture();
    const fixture = await createPluginUiTestkit({
      identity: {
        pluginId: 'happier.channels',
        pluginVersion: '0.0.0',
        viewId: 'channels-account',
        generation: 'channels-offline-binding-policy-outcome-unknown',
        sessionId: 'session-1',
      },
      surface: renderSurface,
      surfaceContext: createChannelsSurfaceContext(),
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
      identity: {
        pluginId: 'happier.channels',
        pluginVersion: '0.0.0',
        viewId: 'channels-account',
        generation: 'channels-offline-binding-policy-unknown-reread-unavailable',
        sessionId: 'session-1',
      },
      surface: renderSurface,
      surfaceContext: createChannelsSurfaceContext(),
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
      identity: {
        pluginId: 'happier.channels',
        pluginVersion: '0.0.0',
        viewId: 'channels-account',
        generation: 'channels-offline-binding-revocation',
        sessionId: 'session-1',
      },
      surface: renderSurface,
      surfaceContext: createChannelsSurfaceContext(),
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
      expect(mount.container.textContent).toContain('Mirror Session');
      expect(mount.container.textContent).toContain('Direct mentions only');
      // The Settings vertical is a different destination of the same artifact.
      // Mounting it here would offer Account-wide binding mutation on a Session.
      expect(mount.container.textContent).not.toContain('Conversation connections');
      expect(mount.container.querySelector('[data-testid="channels-session-conversations"]')).not.toBeNull();
    } finally {
      mount.unmount();
    }
  });

  it('names the affected conversation, its reason, and the one Settings owner that can repair it', async () => {
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
      const manage = mount.container.querySelector<HTMLElement>(
        '[data-testid="channels-session-conversations-manage"]',
      );
      expect(manage).not.toBeNull();
      await act(async () => { manage?.click(); });
      // Recovery keeps exactly one owner: this routes to the Settings page and
      // performs no Account mutation of its own.
      expect(openSurface).toHaveBeenCalledWith({
        pluginId: 'happier.channels',
        localId: 'connections',
      });
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
