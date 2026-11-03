/** @vitest-environment jsdom */
import React from 'react';
import { z } from 'zod/mini';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { buildQualifiedPluginContributionKey, createRecipientContractDigestV1, createVoiceProviderRecipientContractFromCredentialsV1, PluginProjectionV2Schema, VoiceProviderContributionSchema, tryWriteServerEnabledBitInPlace, type PluginContributionIdentityV1, type PluginProjectionV2, type VoiceProviderContribution, type RecipientContractV1 } from '@happier-dev/protocol';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { DaemonContributionRegistryProjectionDescribeResponseSchema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { ConnectedAccountUiProjectionEntryV1Schema } from '@happier-dev/protocol/connect/connectedAccountUiProjectionV1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { ConnectedAccountCatalogRowMutationV1Schema, ConnectedPurposeCatalogV1Schema, type ConnectedPurposeCatalogV1 } from '@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1';
import { createSecretSettingsTestHarness } from '@/components/settings/secrets/secretSettingsTestHarness';
import { normalizeVoiceSettingsLocalDelta } from '@/sync/domains/settings/voiceSettingsPersistence';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installWebLockManagerMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import { getConnectedAccountAuthentication, getConnectedServiceRegistrySnapshot, subscribeConnectedServiceRegistry } from '@/sync/domains/connectedServices/connectedServiceRegistry';
import { waitForTestEvent } from '@/dev/testkit';
import { installSessionActionRpcBoundary } from '@/dev/testkit/harness/sessionActionRpcBoundary';
import { createMachineFixture, createMachineReadBatchResponseFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { AppShellPluginUiProjectionProvider, useAppShellPluginUiProjection } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { commitExternalVoiceProviderRegistration, resetExternalVoiceProviderRegistrationsForTests } from '@/voice/registry/externalVoiceProviderRegistrations';
import { createVoiceProviderRegistry, projectVoiceProviderAccountCredentialSlot } from '@/voice/registry/providerRegistry';
import { createDefaultVoiceProviderRegistry } from '@/voice/registry/defaultRegistry';
import { createExternalVoiceProviderActivationScope } from '@/voice/registry/externalVoiceProviderActivation.testkit';
import { createBundledConversationRuntimeHostLease } from '@/voice/registry/bundledConversationRuntimeHost';
import { BUNDLED_FIRST_PARTY_VOICE_CONVERSATION_RUNTIME_ENTRIES } from '@/voice/registry/generatedBundledVoiceRuntimeEntries';
import { BUNDLED_FIRST_PARTY_VOICE_CONTRIBUTIONS } from '@/voice/registry/generatedBundledVoiceEntries';
import { createBundledConversationRuntimes } from '@/voice/registry/bundledConversationRuntimes';
import { createBundledVoiceRecipientContract } from '@/voice/credentials/voiceRecipientContract';
import { AccountProfileSchema, type AccountProfile } from '@happier-dev/protocol/account/profile';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock('socket.io-client', async (importOriginal) => (
    await import('@/dev/testkit/harness/serverAccountConnectionHarness')
).createSocketIoClientBoundary(importOriginal));
installDisconnectedServerSocketBoundary();
// Genuine unavailable native/platform boundaries only; Dropdown, Account,
// Sync, purpose loading, normalization and mutation owners stay real.
vi.mock('react-native', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('react-native-web');
  return { ...actual, Platform: { ...(actual.Platform as object), OS: 'web',
    select: (values: Record<string, unknown>) => values.web ?? values.default ?? values.native } };
});
vi.mock('react-native-unistyles', async () => {
  const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
  return createUnistylesMock();
});
vi.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
vi.mock('@hugeicons/react-native', () => ({ HugeiconsIcon: () => null }));
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
// Credential settings never starts the unavailable vendor conversation SDK.
vi.mock('@elevenlabs/client/web', () => ({ Conversation: { startSession: () => { throw new Error('Unexpected ElevenLabs conversation start'); } } }));
vi.mock('@/utils/web/radixCjs', async () => {
  const { createRadixCjsRealModule } = await import('@/dev/testkit/mocks/radixCjs');
  return await createRadixCjsRealModule();
});
await loadSyncSingletonForTests();
const { VoiceCredentialSourceField } = await import('./VoiceCredentialSourceField');
const { storage } = await import('@/sync/domains/state/storage');
const { settingsParse } = await import('@/sync/domains/settings/settings');
const { profileDefaults } = await import('@/sync/domains/profiles/profile');
const { fetchAndApplyProfile } = await import('@/sync/engine/account/syncAccount');
const { refreshConnectedAccountCatalog } = await import('@/sync/engine/settings/connectedAccountCatalogEngine');
const { setRuntimeFetch } = await import('@/utils/system/runtimeFetch');
const gestureDispatch = await import('@/utils/system/fireAndForget');
const { t, getPreferredLanguage, setPreferredLanguageFromSettings } = await import('@/text');
const initialLanguage = getPreferredLanguage();
afterAll(() => { setPreferredLanguageFromSettings(initialLanguage); });

const contribution = Object.freeze({
  pluginId: 'acme.credential-source-fixture',
  localId: 'realtime-openai',
});
// Variable daemon authentication belongs to an external fixture. Bundled services
// use their admitted manifest declaration even when an older daemon reports another one.
const descriptorService: PluginContributionIdentityV1 = Object.freeze({ pluginId: 'acme.credential-account', localId: 'openai-codex' });
const declaration = VoiceProviderContributionSchema.parse({
  id: contribution.localId,
  title: 'OpenAI realtime',
  kind: 'conversation',
  roles: ['realtime_conversation'],
  platforms: ['web'],
  capabilities: { turn: { cancelResponse: false, bargeIn: false } },
  credentials: {
  slot: {
    id: 'api_key',
    purpose: 'voice.client-auth',
    title: 'OpenAI credential',
  },
  requirement: { kind: 'always' },
  sources: [
    {
      kind: 'savedSecret',
      secretKinds: ['apiKey'],
      rawGrants: [{
        realm: 'web',
        phase: 'prepare',
        request: {
          kind: 'httpHeaders',
          origin: 'https://api.openai.com',
          headerNames: ['authorization'],
        },
      }],
    },
    {
      kind: 'connectedAccount',
      service: { pluginId: 'happier.voice.openai', localId: 'openai' },
      rawGrants: [{
        realm: 'web',
        phase: 'prepare',
        request: {
          kind: 'httpHeaders',
          origin: 'https://api.openai.com',
          headerNames: ['authorization'],
        },
      }],
    },
    {
      kind: 'connectedAccount',
      service: descriptorService,
      rawGrants: [{
        realm: 'web',
        phase: 'prepare',
        request: {
          kind: 'httpHeaders',
          origin: 'https://api.openai.com',
          headerNames: ['authorization'],
        },
      }],
    },
  ],
  hostMediated: {
    operations: [{
      id: 'client-auth',
      purpose: 'voice.client-auth',
      credentialSlotId: 'api_key',
      effect: 'read',
      request: {
        origin: 'https://api.openai.com',
        pathTemplate: '/v1/realtime/client_secrets',
        queryTemplate: [],
        headerTemplate: [],
        bodyTemplate: { kind: 'json', value: {} },
        method: 'POST',
        credential: { kind: 'httpHeader', name: 'authorization', format: 'bearer' },
        redirect: 'error',
        maxBodyBytes: 65_536,
        contentTypes: ['application/json'],
      },
      parameters: {
        schema: { type: 'object', properties: {}, additionalProperties: false },
        mapping: [],
      },
      response: { maxBytes: 65_536, contentTypes: ['application/json'] },
    }],
  },
  },
  client: {
    artifactId: 'web-runtime',
    exportName: 'activate',
  },
});
const credentials = declaration.credentials!;

function installCurrentDeclaration(currentDeclaration: VoiceProviderContribution, recipientContract?: RecipientContractV1) {
  projectedDeclaration = currentDeclaration;
  projectedRecipientContract = recipientContract ?? null;
  const providerId = buildQualifiedPluginContributionKey({
    pluginId: contribution.pluginId,
    localId: currentDeclaration.id,
  });
  const registry = createVoiceProviderRegistry({
    bundledContributions: [{ pluginId: contribution.pluginId, providerId, declaration: currentDeclaration }],
    bundledPresentations: [{ providerId, settingsSectionId: 'voice-credential-source-test' }],
  });
  const descriptor = registry.get(providerId);
  if (!descriptor) throw new Error('expected current Voice contribution');
  commitExternalVoiceProviderRegistration({
    token: contribution,
    pluginId: contribution.pluginId,
    localId: currentDeclaration.id,
    providerId,
    occurrenceId: declarationOccurrenceId,
    descriptor: recipientContract ? { ...descriptor, accountCredentialSlot:
      projectVoiceProviderAccountCredentialSlot(currentDeclaration, recipientContract) ?? undefined } : descriptor,
    adapter: null,
  });
}

async function installCodexDescriptor(options: Readonly<{
  requiresAccountConfiguration?: boolean;
  includeOpenAi?: boolean;
  available?: boolean;
}> = {}) {
  // Authored daemon reply bytes, validated again by the whole Socket DTO.
  // The CLI projector is explicitly outside this downstream UI suite.
  descriptorReplies = options.available === false ? [] : z.array(ConnectedAccountUiProjectionEntryV1Schema).parse([{
      id: 'openai-codex',
      serviceId: 'openai-codex',
      pluginId: descriptorService.pluginId,
      provenance: 'external',
      sourceKind: 'bundled',
      title: 'Codex',
      authentication: {
        defaultModeId: 'oauth',
        modes: [{
          id: 'oauth',
          kind: 'oauthAuthorizationCode',
          callbackUrl: 'http://127.0.0.1:4000/auth/callback',
          scopes: ['openid', 'profile', 'email', 'offline_access'],
          pkce: 'required',
          outcomeReconciliation: 'none',
          ...(options.requiresAccountConfiguration ? {
            configuration: {
              scope: 'account' as const,
              changeBehavior: 'reconnect' as const,
              fields: [{
                id: 'organization',
                title: 'Organization',
                schema: { type: 'string' as const, minLength: 1 },
                required: true,
                secret: false,
              }],
            },
          } : {}),
        }],
      },
      capabilities: [],
      availability: { state: 'available', reason: 'resolved' },
      diagnostics: [],
    }, ...(options.includeOpenAi ? [{
      id: 'openai',
      serviceId: 'openai',
      pluginId: 'happier.voice.openai',
      provenance: 'first_party' as const,
      sourceKind: 'bundled' as const,
      title: 'OpenAI',
      authentication: {
        defaultModeId: 'api-key',
        modes: [{
          id: 'api-key',
          kind: 'manual' as const,
          outcomeReconciliation: 'none' as const,
          fields: [{
            id: 'api-key',
            title: 'API key',
            schema: { type: 'string' as const, minLength: 1 },
            secret: true,
          }],
        }],
      },
      capabilities: [],
      availability: { state: 'available' as const, reason: 'resolved' as const },
      diagnostics: [],
    }] : [])]);
  if (reloadProjection) {
    await act(async () => { reloadProjection?.(); });
    await waitForDescriptorReply();
  }
}

const declarationOccurrenceId = 'credential-source-declaration';
const descriptorMachineId = 'credential-descriptor-machine';
let projectedDeclaration = declaration;
let projectedRecipientContract: RecipientContractV1 | null = null;
let descriptorReplies: Array<ReturnType<typeof ConnectedAccountUiProjectionEntryV1Schema.parse>> = [];
let reloadProjection: (() => void) | undefined;
let runtimeLease: ReturnType<typeof createBundledConversationRuntimeHostLease> | undefined;
let bundledRuntimes: Awaited<ReturnType<typeof createBundledConversationRuntimes>> = [];
function ProjectionReader() {
  reloadProjection = useAppShellPluginUiProjection().reloadConnectedAccountProjection;
  return null;
}
async function waitForDescriptorReply() {
  const expected = descriptorReplies.find(entry => entry.id === descriptorService.localId)?.authentication ?? null;
  await act(async () => {
    await waitForTestEvent(subscribeConnectedServiceRegistry, () => ({
      status: getConnectedServiceRegistrySnapshot().status,
      authentication: getConnectedAccountAuthentication(descriptorService),
    }), snapshot => snapshot.status === 'ready'
      && JSON.stringify(snapshot.authentication) === JSON.stringify(expected));
  });
  expect(getConnectedAccountAuthentication(descriptorService)).toEqual(expected);
}
const projectionRequests = installSessionActionRpcBoundary(request => {
  if (!request.method.endsWith(`:${RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE}`)) {
    return { error: 'unavailable' };
  }
  const entries = BUNDLED_FIRST_PARTY_VOICE_CONTRIBUTIONS.map(entry => {
    const recipientContract = createBundledVoiceRecipientContract(entry);
    return { id: entry.providerId, contributionKey: entry.providerId, pluginId: entry.pluginId,
      occurrenceId: 'credential-bundled-daemon-occurrence', definition: entry.declaration,
      ...(recipientContract ? { recipientContract,
        recipientContractDigest: createRecipientContractDigestV1(recipientContract) } : {}),
    } satisfies NonNullable<PluginProjectionV2['familiesById']['voiceProviders']>['entriesById'][string];
  });
  const providerId = buildQualifiedPluginContributionKey({ pluginId: contribution.pluginId, localId: projectedDeclaration.id });
  return DaemonContributionRegistryProjectionDescribeResponseSchema.parse({ protocolVersion: 1,
    projection: PluginProjectionV2Schema.parse({ v: 2, generation: 1, installedPackagesById: {},
      agentsById: {}, actionsById: {},   resourcesById: {}, settingsById: {},
      familiesById: {
        connectedAccounts: { family: 'connectedAccounts', entriesById: Object.fromEntries(descriptorReplies.map(entry => [
          buildQualifiedPluginContributionKey({ pluginId: entry.pluginId!, localId: entry.id }), entry,
        ])) },
        voiceProviders: { family: 'voiceProviders', entriesById: Object.fromEntries([
          ...entries.map(entry => [entry.id, entry] as const),
          [providerId, { id: providerId, contributionKey: providerId, pluginId: contribution.pluginId,
            occurrenceId: declarationOccurrenceId, definition: projectedDeclaration,
            ...(projectedRecipientContract ? { recipientContract: projectedRecipientContract,
              recipientContractDigest: createRecipientContractDigestV1(projectedRecipientContract) } : {}),
          }],
        ]) },
      },
    }),
  });
});


const PURPOSES_PATH = '/v1/account/entity-rows/connected-accounts/purposes';
const codexTarget = { kind: 'account' as const, account: {
  service: descriptorService, accountId: 'codex-work',
} };
const apiTarget = { kind: 'account' as const, account: {
  service: { pluginId: 'happier.voice.openai', localId: 'openai' }, accountId: 'api-work',
} };
const codexAccount = {
  ref: codexTarget.account, status: 'connected' as const, configurationReady: false,
  authenticationModeId: 'oauth', revisionSemantics: 'revisioned' as const,
  credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa', configurationRevision: null, displayName: 'Work Codex', scopes: [],
};
let account: Awaited<ReturnType<typeof createSecretSettingsTestHarness>> | undefined;
let mounted: { root: Root; container: HTMLElement } | undefined;
let locks: ReturnType<typeof installWebLockManagerMock> | undefined;
let purposes: ConnectedPurposeCatalogV1;
let revision: number;
let writes: Array<ReturnType<typeof ConnectedAccountCatalogRowMutationV1Schema.parse>>;
let beforePurposeRead: (() => void) | undefined;
let afterAcknowledgement: (() => void) | undefined;
let omitSettingsReceipt: boolean;
// Observation only: the real dispatcher still attaches its genuine error sink.
// Awaiting its actual promise keeps refusal checks from passing before admission.
const gestureListeners = new Set<() => void>();
function observeGesture() {
  const dispatch = gestureDispatch.fireAndForget;
  return vi.spyOn(gestureDispatch, 'fireAndForget').mockImplementation((...args) => {
    dispatch(...args);
    for (const notify of gestureListeners) notify();
  });
}
let gestureObservation: ReturnType<typeof observeGesture>;
async function selectionReceipt() {
  await waitForTestEvent(notify => {
    gestureListeners.add(notify);
    return () => { gestureListeners.delete(notify); };
  }, () => expect(gestureObservation.mock.calls.some(([, options]) =>
    options?.tag?.startsWith('VoiceCredentialSourceField.'))).toBe(true));
  const call = gestureObservation.mock.calls.find(([, options]) =>
    options?.tag?.startsWith('VoiceCredentialSourceField.'));
  if (!call?.[0]) throw new Error('Missing real Voice gesture promise');
  let receipt: unknown;
  await act(async () => { receipt = await call[0]; });
  return receipt;
}

function binding() { return account!.persistedSettings.voiceSettingsV1.credentialBindings[0]; }
function assertAccountSelection(target = codexTarget, consumer: Readonly<{ pluginId: string; localId: string }> = contribution, purpose = credentials.slot.purpose) {
  expect(binding()).toMatchObject({
    contribution: consumer, credentialSlotId: 'api_key', credentialSource: { kind: 'connectedAccount' },
  });
  expect(purposes.bindings).toEqual([{ purpose: { consumer, purpose }, target }]);
  expect(Object.hasOwn(account!.persistedSettings, 'connectedAccountPurposeBindingsV1')).toBe(false);
}
function requireNode(testID: string): HTMLElement {
  const node = [...document.querySelectorAll<HTMLElement>('[data-testid]')]
    .find(candidate => candidate.dataset.testid === testID);
  if (!node) throw new Error(`Missing actual DOM row ${testID}`);
  return node;
}
function pointerPress(node: HTMLElement) {
  const event = { bubbles: true, cancelable: true, button: 0, clientX: 4, clientY: 4 };
  node.dispatchEvent(new MouseEvent('mousedown', { ...event, buttons: 1 }));
  node.dispatchEvent(new MouseEvent('mouseup', { ...event, buttons: 0 }));
  node.dispatchEvent(new MouseEvent('click', { ...event, buttons: 0 }));
}
async function flush() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); }); }
function optionId(target: typeof codexTarget | typeof apiTarget) {
  // SelectableMenuResults publishes DOM-safe testIDs for the qualified row id.
  return JSON.stringify(['account', target.account.service.pluginId, target.account.service.localId, target.account.accountId])
    .replace(/[^a-zA-Z0-9_-]/g, '_');
}
async function open() {
  const row = requireNode('voice-credential-source-api_key');
  const trigger = row.querySelector<HTMLElement>('[tabindex="0"],[role="button"],button');
  if (!trigger) throw new Error('Missing actual source dropdown trigger');
  await act(async () => { pointerPress(trigger); });
  await vi.waitFor(async () => { await flush(); expect(requireNode('dropdown-option-none')).toBeTruthy(); });
}
async function choose(id: string, admitted = true) {
  gestureObservation.mockClear();
  await open();
  await act(async () => { pointerPress(requireNode(`dropdown-option-${id}`)); });
  await flush();
  return admitted ? await selectionReceipt() : undefined;
}
async function renderField(currentDeclaration = declaration, isCurrent?: () => boolean, content?: React.ReactNode) {
  const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
  const { ModalProvider } = await import('@/modal');
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted = { root, container };
  const element = () => <InjectedAuthProvider credentials={account!.credentials}><ModalProvider>
    <AppShellPluginUiProjectionProvider><ProjectionReader />
      {content ?? <VoiceCredentialSourceField contribution={{ pluginId: contribution.pluginId, localId: currentDeclaration.id }}
        declaration={currentDeclaration} credentials={currentDeclaration.credentials!} isCurrent={isCurrent} />}
    </AppShellPluginUiProjectionProvider>
  </ModalProvider></InjectedAuthProvider>;
  await act(async () => { root.render(element()); });
  await waitForDescriptorReply();
  expect(projectionRequests.some(request => request.method.endsWith(
    `:${RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE}`,
  )), 'Actual AppShell daemon description admission').toBe(true);
  return async () => { await act(async () => { root.render(element()); }); };
}
async function publishProfile(accounts: AccountProfile['connectedAccountsV4'] = [codexAccount]) {
  const profile = AccountProfileSchema.parse({ ...profileDefaults, id: 'account-a', timestamp: 1, connectedAccountsV4: accounts });
  await fetchAndApplyProfile({
    credentials: account!.credentials, applyProfile: storage.getState().applyProfile,
    request: async () => Response.json(profile),
  });
}
beforeEach(async () => {
  setPreferredLanguageFromSettings('en');
  locks = installWebLockManagerMock();
  reloadProjection = undefined;
  projectionRequests.length = 0;
  resetExternalVoiceProviderRegistrationsForTests();
  installCurrentDeclaration(declaration);
  await installCodexDescriptor();
  runtimeLease = createBundledConversationRuntimeHostLease();
  bundledRuntimes = (await createBundledConversationRuntimes({
    bundledEntries: BUNDLED_FIRST_PARTY_VOICE_CONVERSATION_RUNTIME_ENTRIES, host: runtimeLease.host,
  }));
  purposes = { v: 1, bindings: [] };
  revision = 9;
  writes = [];
  beforePurposeRead = undefined;
  afterAcknowledgement = undefined;
  omitSettingsReceipt = false;
  const features = createRootLayoutFeaturesResponse({ features: { connectedServices: { enabled: true } } });
  if (!tryWriteServerEnabledBitInPlace(features, 'connectedServices.accountGroups', true)) throw new Error('Missing Connected Services feature fixture');
  account = await createSecretSettingsTestHarness({ features, voiceEnabled: true, settings: settingsParse({
    schemaVersion: 7, secrets: [], voiceSettingsV1: { credentialBindings: [] },
  }) });
  account.catalogRows.set(PURPOSES_PATH, {
    status: 'present', revision, content: { t: 'plain', v: { key: 'purposes', value: purposes } },
  });
  // Extend the existing HTTP fixture for the composite row+Settings transaction;
  // parse the real DTO and exercise its Settings CAS rather than stubbing Sync.
  setRuntimeFetch(async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (path === '/v1/auth/ping') return Response.json({});
    const machine = createPlainMachineRowFixture({
      id: descriptorMachineId, accountId: account!.scope.accountId,
    });
    if (path === '/v1/machines') return Response.json([machine]);
    if (path === '/v1/machines/read-batch' && init?.method === 'POST') return createMachineReadBatchResponseFixture(init.body,
      id => id === machine.id ? machine : null);
    // The real scoped RPC owner must confirm this exact Home machine envelope
    // before it can emit a daemon request; a list row alone is not that authority.
    if (path === `/v1/machines/${descriptorMachineId}`) return Response.json({ machine });
    if (path === `/v1/machines/${descriptorMachineId}/access`) return Response.json({
      machineId: machine.id, custodian: machine.access!.custodian, access: machine.access,
      canManage: true, grants: [], ownDirectGrant: false, ownAccessSources: [],
    });
    if (path !== PURPOSES_PATH) return account!.request(url, init);
    if (init?.method !== 'POST') {
      const callback = beforePurposeRead;
      beforePurposeRead = undefined;
      callback?.();
      return Response.json({ status: 'present', revision, content: { t: 'plain', v: { key: 'purposes', value: purposes } } });
    }
    const input = ConnectedAccountCatalogRowMutationV1Schema.parse(JSON.parse(String(init.body)));
    writes.push(input);
    if (input.expectedRevision !== revision) return Response.json({ status: 'conflict', revision }, { status: 409 });
    if (input.content?.t !== 'plain') throw new Error('Expected Plain purpose row');
    let settingsVersion: number | undefined;
    if (input.settingsMutation) {
      const response = await account!.request(new URL('/v2/account/settings', String(url)), {
        method: 'POST', body: JSON.stringify({ expectedVersion: input.settingsMutation.expectedSettingsVersion, content: input.settingsMutation.content }),
      });
      const receipt = await response.json() as { success: boolean; version?: number; currentVersion?: number };
      if (!receipt.success) return Response.json({ status: 'settings-conflict', revision: receipt.currentVersion });
      settingsVersion = receipt.version;
    }
    if (input.content.v.key !== 'purposes') throw new Error('Wrong catalog identity');
    purposes = ConnectedPurposeCatalogV1Schema.parse(input.content.v.value);
    revision += 1;
    account!.catalogRows.set(PURPOSES_PATH, { status: 'present', revision, content: input.content });
    const callback = afterAcknowledgement;
    afterAcknowledgement = undefined;
    callback?.();
    return Response.json({ status: 'updated', revision, cursor: revision,
      ...(!omitSettingsReceipt && settingsVersion !== undefined ? { settingsVersion } : {}) });
  });
  await refreshConnectedAccountCatalog(account.scope, 'purposes');
  await publishProfile();
  storage.getState().applyMachines([createMachineFixture({ id: descriptorMachineId,
    active: true, activeAt: Date.now(), daemonStateVersion: 1,
  })], true, { sourceServerId: account.scope.serverId });
  gestureObservation = observeGesture();
});
afterEach(async () => {
  if (mounted) {
    await act(async () => { mounted!.root.unmount(); });
    mounted.container.remove();
    mounted = undefined;
  }
  reloadProjection = undefined;
  await Promise.all(bundledRuntimes.map(runtime => runtime.dispose()));
  bundledRuntimes = [];
  runtimeLease?.revoke();
  runtimeLease = undefined;
  resetExternalVoiceProviderRegistrationsForTests();
  gestureObservation?.mockRestore();
  await account?.dispose();
  account = undefined;
  locks?.restore();
  locks = undefined;
});

describe('VoiceCredentialSourceField → admitted Account purpose transaction', () => {
  it('does not commit for unrelated Account preference revisions', async () => {
    let commits = 0;
    await renderField(declaration, undefined, <React.Profiler id="credential-source" onRender={() => { commits += 1; }}>
      <VoiceCredentialSourceField contribution={contribution} declaration={declaration} credentials={declaration.credentials!} />
    </React.Profiler>);
    const initial = commits;
    for (let index = 0; index < 20; index += 1) {
      await act(async () => { account!.replaceSettings({ ...storage.getState().settings,
        analyticsOptOut: !storage.getState().settings.analyticsOptOut,
      }, { version: (storage.getState().settingsVersion ?? 0) + 1 }); });
    }
    expect(commits - initial).toBe(0);
    expect(await choose(optionId(codexTarget))).toMatchObject({ status: 'applied' });
    assertAccountSelection();
  });
  it('selects an existing Codex account or pool in provider configuration, rejects missing references and preserves Account defaults', async () => {
    await renderField();
    account!.replaceSettings(settingsParse({ ...account!.persistedSettings, featureToggles: {
      ...account!.persistedSettings.featureToggles, connectedServices: true, 'connectedServices.accountGroups': true,
    } }));
    const serviceId = 'happier.agent.codex/openai-codex';
    const profile = AccountProfileSchema.parse({ ...storage.getState().profile, connectedServicesV2: [{ serviceId: 'openai-codex',
      profiles: [{ profileId: 'work', status: 'connected', kind: 'oauth' }],
      groups: [{ groupId: 'pool', displayName: 'Work pool', activeProfileId: 'work', memberProfileIds: ['work'] }],
    }] });
    storage.getState().applyProfile(profile);
    const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
    const { SettingsDeclarationActionOutputSchemasV1 } = await import('@happier-dev/protocol/actions/settingsDeclarationActionFamily');
    const executor = createDefaultActionExecutor();
    const context = { surface: 'agent' as const, authority: 'account_automation' as const,
      serverId: account!.scope.serverId, expectedAccountId: account!.scope.accountId, actionCaller: { kind: 'host' as const } };
    const providerId = 'happier.agent.codex/realtime-codex';
    const anchor = `voiceConversations.provider.${providerId}.globalConnectedServices`;
    const defaults = account!.persistedSettings.connectedServicesDefaultProfileByServiceId;
    const originalPurposes = structuredClone(purposes);
    const invoke = async (value: unknown) => {
      const result = await executor.execute('settings.invoke', { anchor,
        input: { kind: 'voice_connected_services', expectedSettingsVersion: storage.getState().settingsVersion, value } }, context);
      expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
      if (!result.ok) throw new Error('Expected typed Connected Services result');
      return SettingsDeclarationActionOutputSchemasV1['settings.invoke'].parse(result.result);
    };
    for (const selection of [
      { source: 'connected', selection: 'profile', profileId: 'work' },
      { source: 'connected', selection: 'group', groupId: 'pool' },
    ]) {
      const value = { v: 1, bindingsByServiceId: { [serviceId]: selection } };
      expect(await invoke(value)).toMatchObject({ status: 'completed', value: { status: 'applied' } });
      expect(account!.persistedSettings.voice.providers[providerId]?.config).toMatchObject({ globalConnectedServices: value });
    }
    const before = account!.persistedSettings;
    expect(await invoke({ v: 1, bindingsByServiceId: { [serviceId]: { source: 'connected', profileId: 'missing' } } }))
      .toMatchObject({ status: 'unavailable', reason: 'credential_source_unavailable' });
    expect(account!.persistedSettings).toEqual(before);
    const voiceBeforeMismatch = storage.getState().settings.voice;
    const selected = voiceBeforeMismatch.providers[providerId];
    if (!selected) throw new Error('Expected selected provider settings');
    account!.replaceSettings(settingsParse({ ...account!.persistedSettings, voiceSettingsV1: {
      ...account!.persistedSettings.voiceSettingsV1, providers: { ...account!.persistedSettings.voiceSettingsV1.providers,
        [providerId]: { ...selected, schemaVersion: 1 },
      },
    } }));
    expect(await invoke(null)).toMatchObject({ status: 'unavailable', reason: 'credential_source_unavailable' });
    account!.replaceSettings(before);
    expect(await invoke(null)).toMatchObject({ status: 'completed', value: { status: 'applied' } });
    expect(account!.persistedSettings.voice.providers[providerId]?.config).toMatchObject({ globalConnectedServices: null });
    expect(account!.persistedSettings.connectedServicesDefaultProfileByServiceId).toEqual(defaults);
    expect(purposes).toEqual(originalPurposes);
  });
  it.each(['ui', 'agent'] as const)('binds an exact Saved Secret for an API-key-only service, reviews and removes it through the Action owner on %s', async surface => {
    const { SavedSecretResourceMaterialV1Schema, formatSavedSecretCatalogReferenceV1 } = await import('@happier-dev/protocol/account/settings/savedSecretCatalogV1');
    const { sealSavedSecretResourceStoredContentV1 } = await import('@happier-dev/protocol/account/settings/savedSecretResourceContentV1');
    const { refreshSavedSecretCatalog } = await import('@/sync/engine/settings/savedSecretCatalogEngine');
    const { Modal } = await import('@/modal');
    // Substitute only the person's confirmation; the Action, catalog, CAS and reducers stay real.
    const confirmation = vi.spyOn(Modal, 'confirm').mockResolvedValue(true);
    onTestFinished(() => confirmation.mockRestore());
    const apiOnly = VoiceProviderContributionSchema.parse({ ...declaration, credentials: {
      ...credentials, sources: credentials.sources.filter(source => source.kind === 'savedSecret'),
    } });
    if (!apiOnly.credentials?.hostMediated) throw new Error('Expected mediated credential fixture');
    const contract = createVoiceProviderRecipientContractFromCredentialsV1({
      package: { pluginId: contribution.pluginId, source: { kind: 'package', locator: '@acme/voice' } },
      publisher: { trust: 'verified', identity: 'fixture:acme' }, contribution,
      credentials: { slot: apiOnly.credentials.slot, hostMediated: apiOnly.credentials.hostMediated },
    });
    installCurrentDeclaration(apiOnly, contract);
    const resourceId = 'voice-selection-existing';
    const secretId = formatSavedSecretCatalogReferenceV1({ kind: 'shared_resource', id: resourceId });
    account!.resources.push(SavedSecretResourceMaterialV1Schema.parse({ resourceId, encryptionMode: 'plain', recipientEnvelope: null,
      storedContent: sealSavedSecretResourceStoredContentV1({ resourceId, mode: 'plain',
        content: { v: 1, name: 'Existing Voice key', kind: 'apiKey', value: 'private-fixture-material' } }),
      entry: { ref: secretId, source: 'shared_resource', relationship: 'owner', ownerAccountId: account!.scope.accountId,
        name: 'Existing Voice key', kind: 'apiKey', encryptionMode: 'plain', revision: 1, materialStatus: 'ready',
        capabilities: { use: true, rename: true, rotate: true, manageAccess: true, delete: true } },
    }));
    await refreshSavedSecretCatalog(account!.scope);
    await renderField(apiOnly);
    const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
    const { SettingsDeclarationActionOutputSchemasV1 } = await import('@happier-dev/protocol/actions/settingsDeclarationActionFamily');
    const context = { surface, authority: surface === 'ui' ? 'present_user' as const : 'account_automation' as const,
      serverId: account!.scope.serverId, expectedAccountId: account!.scope.accountId,
      ...(surface === 'agent' ? { defaultSessionId: 'background-agent-session' } : { actionCaller: { kind: 'host' as const } }) };
    let executor: Pick<ReturnType<typeof createDefaultActionExecutor>, 'execute'> = createDefaultActionExecutor();
    if (surface === 'agent') {
      // Explicit Account policy admits this automation. Recipient consent, CAS,
      // reference reducers and both executors stay real below the Socket boundary.
      account!.replaceSettings(settingsParse({ ...account!.persistedSettings, actionsSettingsV1: {
        v: 1, approvalWaivedSurfaces: { 'settings.invoke': ['agent'] },
      } }));
      const { createActionExecutor } = await import('@happier-dev/protocol/actions/actionExecutor');
      const { loadBrowserDaemonRuntimeForTests } = await import('@/dev/testkit/harness/browserDaemonRuntime');
      const { createClientActionReverseDispatcher, createUnavailableActionTransportDeps } = await loadBrowserDaemonRuntimeForTests();
      const { createUiClientActionReverseHandler } = await import('@/sync/ops/actions/clientActionReverseDispatch');
      const receive = createUiClientActionReverseHandler({ ...account!.scope, isCurrent: () => true });
      executor = createActionExecutor({
        ...createUnavailableActionTransportDeps(),
        clientActionExecute: createClientActionReverseDispatcher(() => ({
          hasConnectedClientRpcHandler: method => method === RPC_METHODS.UI_ACTION_EXECUTE,
          callConnectedClientRpc: async (method, payload, options) => {
            if (method !== RPC_METHODS.UI_ACTION_EXECUTE) return { ok: false, errorCode: 'RPC_CLIENT_NOT_AVAILABLE' };
            options?.onIssued?.();
            return { ok: true, result: await receive(payload, { signal: options?.signal ?? new AbortController().signal }) };
          },
        })),
      });
    }
    const anchor = `voiceConversations.provider.${buildQualifiedPluginContributionKey(contribution)}.credential`;
    const invoke = async (operation: 'bind' | 'inspect' | 'review' | 'remove', expectedSecretId: string | null,
      version = storage.getState().settingsVersion, expectedRecipientContractDigest?: string, machineId?: string) => {
      const result = await executor.execute('settings.invoke', { anchor, input: {
        kind: 'voice_saved_secret', operation, credentialSlotId: credentials.slot.id,
        expectedSettingsVersion: version, expectedSecretId, expectedSecretUpdatedAt: expectedSecretId ? 1 : null,
        ...(operation === 'bind' ? { secretId } : {}),
        ...(expectedRecipientContractDigest ? { expectedRecipientContractDigest } : {}),
        ...(machineId ? { machineId } : {}),
      } }, { ...context, actionsSettings: storage.getState().settings.actionsSettingsV1 });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('Expected typed credential operation result');
      const receipt = SettingsDeclarationActionOutputSchemasV1['settings.invoke'].parse(result.result);
      expect(JSON.stringify(receipt)).not.toContain('private-fixture-material');
      return receipt;
    };
    const initialVersion = storage.getState().settingsVersion;
    confirmation.mockResolvedValueOnce(false);
    expect(await invoke('bind', null)).toMatchObject({ status: 'cancelled' });
    expect(binding()).toBeUndefined();
    expect(await invoke('bind', null)).toMatchObject({ status: 'completed', value: { status: 'applied' } });
    expect(binding()).toMatchObject({ credentialSource: { kind: 'savedSecret' }, credentialBindings: { account: { api_key: secretId } } });
    const writesAfterBinding = writes.length;
    const settingsWritesAfterBinding = account!.settingsWrites.length;
    expect(await invoke('bind', null, initialVersion)).toMatchObject({ value: { status: 'conflict' } });
    expect(writes).toHaveLength(writesAfterBinding);
    expect(await invoke('review', secretId, initialVersion)).toMatchObject({ value: { status: 'conflict' } });
    expect(account!.settingsWrites).toHaveLength(settingsWritesAfterBinding);
    expect(await invoke('review', secretId, undefined, `sha256:${'0'.repeat(64)}`))
      .toMatchObject({ status: 'unavailable', reason: 'credential_contract_changed' });
    expect(account!.settingsWrites).toHaveLength(settingsWritesAfterBinding);
    await act(async () => { await refreshSavedSecretCatalog(account!.scope); });
    await flush();
    const materialInventoryReads = () => account!.request.mock.calls.filter(([input]) => new URL(
      input instanceof Request ? input.url : String(input),
    ).pathname === '/v1/account/saved-secrets/resources/materials').length;
    const readsBeforeInspect = materialInventoryReads();
    expect(await invoke('inspect', secretId)).toMatchObject({ status: 'completed', value: { secretId } });
    expect(materialInventoryReads()).toBe(readsBeforeInspect);
    const approvedDigest = binding()?.approvedRecipientContractDigest;
    expect(approvedDigest).toMatch(/^sha256:/);
    account!.replaceSettings(settingsParse({ ...account!.persistedSettings, voiceSettingsV1: {
      ...account!.persistedSettings.voiceSettingsV1, credentialBindings: account!.persistedSettings.voiceSettingsV1.credentialBindings.map(
        ({ approvedRecipientContractDigest: _oldApproval, ...rest }) => rest),
    } }), { version: (storage.getState().settingsVersion ?? 0) + 1 });
    expect(await invoke('review', secretId)).toMatchObject({ status: 'completed', value: { status: 'applied' } });
    expect(binding()?.approvedRecipientContractDigest).toBe(approvedDigest);
    expect(await invoke('bind', null, undefined, undefined, 'machine-a')).toMatchObject({ value: { status: 'applied' } });
    expect(binding()?.credentialBindings).toMatchObject({ account: { api_key: secretId }, byMachineId: {
      'machine-a': { api_key: secretId },
    } });
    expect(await invoke('remove', secretId, undefined, undefined, 'machine-a')).toMatchObject({ value: { status: 'applied' } });
    expect(binding()?.credentialBindings.account?.api_key).toBe(secretId);
    expect(binding()?.credentialBindings.byMachineId?.['machine-a']?.api_key).toBeUndefined();
    expect(await invoke('remove', secretId)).toMatchObject({ status: 'completed', value: { status: 'applied' } });
    expect(binding()?.credentialBindings.account?.api_key).toBeUndefined();
    expect(account!.resources).toHaveLength(1);
    expect(confirmation).toHaveBeenCalled();
  });
  it('refuses the exact source operation before either write while adjacent Settings writes remain allowed', async () => {
    account!.replaceSettings(settingsParse({ ...account!.persistedSettings, actionsSettingsV1: {
      v: 1, actions: { 'settings.invoke': { disabledSurfaces: ['ui'] } },
    } }));
    await renderField();
    const receipt = await choose(optionId(codexTarget));
    expect(account!.settingsWrites).toEqual([]);
    expect(writes).toEqual([]);
    expect(binding()).toBeUndefined();
    expect(purposes.bindings).toEqual([]);
    expect(revision).toBe(9);
    expect(receipt).toMatchObject({ ok: false, errorCode: 'action_disabled' });
    const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
    const { PROMPTS_CONTEXT_SETTINGS } = await import('@/components/settings/prompts/context/promptsContextSettings');
    const adjacent = await createDefaultActionExecutor().execute('settings.set', {
      anchor: PROMPTS_CONTEXT_SETTINGS.settings.memoryUseInNewSessions.anchor, value: false,
    }, { surface: 'ui', authority: 'present_user', serverId: account!.scope.serverId,
      expectedAccountId: account!.scope.accountId, actionCaller: { kind: 'host' } });
    expect(adjacent.ok).toBe(true);
    expect(account!.persistedSettings.memoryUseInNewSessions).toBe(false);
  });
  it('lets an Agent select and clear sources through the public declaration and versioned Settings read', async () => {
    await renderField();
    const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
    const { SettingsDeclarationActionOutputSchemasV1 } = await import('@happier-dev/protocol/actions/settingsDeclarationActionFamily');
    const { PROMPTS_CONTEXT_SETTINGS } = await import('@/components/settings/prompts/context/promptsContextSettings');
    const executor = createDefaultActionExecutor();
    const context = { surface: 'agent' as const, authority: 'account_automation' as const,
      serverId: account!.scope.serverId, expectedAccountId: account!.scope.accountId,
      actionCaller: { kind: 'host' as const } };
    const missingTarget = await executor.execute('settings.invoke', {
      anchor: `voiceConversations.provider.${buildQualifiedPluginContributionKey(contribution)}.credentialSource`,
      input: { kind: 'voice_credential_source', credentialSlotId: credentials.slot.id,
        expectedSettingsVersion: storage.getState().settingsVersion,
        selection: { kind: 'connectedAccount', target: { ...codexTarget,
          account: { ...codexTarget.account, accountId: 'missing-account' } } },
      },
    }, context);
    expect(missingTarget.ok).toBe(true);
    expect(account!.settingsWrites).toEqual([]);
    expect(writes).toEqual([]);
    if (!missingTarget.ok) throw new Error('Expected typed source unavailability');
    expect(SettingsDeclarationActionOutputSchemasV1['settings.invoke'].parse(missingTarget.result))
      .toMatchObject({ status: 'unavailable', reason: 'credential_source_unavailable' });
    for (const selection of [{ kind: 'connectedAccount', target: codexTarget }, { kind: 'savedSecret' }, { kind: 'none' }] as const) {
      const version = await executor.execute('settings.get', {
        anchor: PROMPTS_CONTEXT_SETTINGS.settings.memoryUseInNewSessions.anchor, includeVersion: true,
      }, context);
      expect(version.ok).toBe(true);
      if (!version.ok) throw new Error('Expected public versioned Settings read');
      const snapshot = SettingsDeclarationActionOutputSchemasV1['settings.get'].parse(version.result);
      const result = await executor.execute('settings.invoke', {
        anchor: `voiceConversations.provider.${buildQualifiedPluginContributionKey(contribution)}.credentialSource`,
        input: { kind: 'voice_credential_source', credentialSlotId: credentials.slot.id,
          expectedSettingsVersion: snapshot.settingsVersion, selection },
      }, context);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('Expected public source selection');
      expect(SettingsDeclarationActionOutputSchemasV1['settings.invoke'].parse(result.result))
        .toMatchObject({ status: 'completed', value: { status: 'applied', selection } });
      expect(binding()).toMatchObject({ credentialSource: { kind: selection.kind } });
      if (selection.kind === 'connectedAccount') assertAccountSelection();
      else expect(purposes.bindings).toEqual([]);
    }
    expect(writes.map(write => write.expectedRevision)).toEqual([9, 10, 11]);
  });
  it('renders only the canonical source selector for a Connected Account-only declared conversation and persists its exact binding', async () => {
    const connectedOnly = VoiceProviderContributionSchema.parse({ ...declaration,
      credentials: { ...credentials, sources: credentials.sources.filter(source => source.kind === 'connectedAccount') },
      settings: { schemaVersion: 1, fields: [{ id: 'model', title: 'Model',
        schema: { type: 'string', minLength: 1, maxLength: 64 }, default: 'voice-fixture',
        presentation: { control: 'text' },
      }] },
    });
    if (connectedOnly.kind !== 'conversation') throw new Error('Expected conversation declaration');
    const runtime = BUNDLED_FIRST_PARTY_VOICE_CONVERSATION_RUNTIME_ENTRIES.find(entry => entry.declaration.id === 'realtime-openai');
    if (!runtime) throw new Error('Expected shipped OpenAI runtime');
    projectedDeclaration = connectedOnly;
    const scope = createExternalVoiceProviderActivationScope({ pluginId: contribution.pluginId,
      occurrenceId: declarationOccurrenceId, declarations: [connectedOnly], hostPlatform: 'web' });
    onTestFinished(async () => { await scope.unwind(); });
    const { loadBundledVoiceRuntimeActivate } = await import('@/dev/testkit/harness/builtinVoiceAdapters');
    (await loadBundledVoiceRuntimeActivate(runtime))(scope.api);
    await scope.commit();
    const providerId = buildQualifiedPluginContributionKey({ pluginId: contribution.pluginId, localId: connectedOnly.id });
    const activated = createDefaultVoiceProviderRegistry().get(providerId);
    if (!activated?.providerSettings) throw new Error('Expected activated provider settings defaults');
    const currentSettings = storage.getState().settings;
    account!.replaceSettings(settingsParse({ ...currentSettings, ...normalizeVoiceSettingsLocalDelta({
      voice: { ...currentSettings.voice, providerId, providers: { ...currentSettings.voice.providers,
        [providerId]: { schemaVersion: activated.providerSettings.schemaVersion,
          config: activated.providerSettings.defaultConfig } } },
    }, currentSettings) }));
    const { VoiceProviderSection } = await import('../VoiceProviderSection');
    await renderField(connectedOnly, undefined, <VoiceProviderSection voice={storage.getState().settings.voice}
      setVoice={vi.fn()} happierVoiceSupported={true} platformOs="web" />);
    expect(document.querySelectorAll('[data-testid="voice-credential-source-api_key"]')).toHaveLength(1);
    expect(document.querySelectorAll('[data-testid^="settings.voice.externalCredential."]')).toHaveLength(0);
    await open();
    expect(document.querySelector('[data-testid="dropdown-option-savedSecret"]')).toBeNull();
    gestureObservation.mockClear();
    await act(async () => { pointerPress(requireNode(`dropdown-option-${optionId(codexTarget)}`)); });
    expect(await selectionReceipt()).toMatchObject({ status: 'applied' });
    assertAccountSelection();
    expect(writes.map(write => write.expectedRevision)).toEqual([9]);
  });
  it('selects the exact declared account and presents its service without exposing its id', async () => {
    await renderField();
    await open();
    const row = requireNode(`dropdown-option-${optionId(codexTarget)}`);
    expect(row.textContent).toContain('Work Codex');
    expect(row.textContent).not.toContain('codex-work');
    expect(row.getAttribute('aria-label')).toBe('Codex · Work Codex');
    await act(async () => { pointerPress(row); });
    expect(await selectionReceipt()).toMatchObject({ status: 'applied' });
    assertAccountSelection();
    expect(requireNode('voice-credential-source-api_key').textContent).toContain('Work Codex');
  });
  it('keeps an acknowledged but uncertain selection visible without replaying the composite mutation', async () => {
    omitSettingsReceipt = true;
    await renderField();
    expect(await choose(optionId(codexTarget))).toMatchObject({ status: 'outcomeUnknown' });
    expect(requireNode('voice-credential-source-api_key').textContent)
      .toContain(t('settingsProviders.errors.mutationOutcomeUnknownDescription'));
    expect(requireNode('voice-credential-source-api_key').textContent).toContain('Work Codex');
    assertAccountSelection();
    expect(revision).toBe(10);
    expect(writes.map(write => write.expectedRevision)).toEqual([9]);
  });
  it('selects an Account for a speech declaration through the same mutation owner', async () => {
    const speech = VoiceProviderContributionSchema.parse({
      id: 'speech', title: 'OpenAI speech', kind: 'speech', roles: ['dictation_stt'], platforms: ['web'],
      credentials: { slot: { id: 'api_key', purpose: 'voice.speech.transcribe', title: 'OpenAI credential' },
        requirement: { kind: 'always' }, sources: [{
          kind: 'connectedAccount', service: codexTarget.account.service, rawGrants: [{
            realm: 'daemon', phase: 'speech', request: { kind: 'environment', keys: ['OPENAI_API_KEY'] },
          }],
        }] },
      settings: { schemaVersion: 1, fields: [{
        id: 'model', title: 'Model', schema: { type: 'string', minLength: 1, maxLength: 64 },
        default: 'whisper-1', presentation: { control: 'text' },
      }] },
    });
    installCurrentDeclaration(speech);
    await renderField(speech);
    await choose(optionId(codexTarget));
    assertAccountSelection(codexTarget,
      { pluginId: contribution.pluginId, localId: speech.id }, 'voice.speech.transcribe');
  });
  it('refuses an account whose mode still needs Account configuration', async () => {
    await installCodexDescriptor({ requiresAccountConfiguration: true });
    await renderField();
    await open();
    const row = requireNode(`dropdown-option-${optionId(codexTarget)}`);
    expect(row.getAttribute('aria-disabled')).toBe('true');
    await act(async () => { pointerPress(row); });
    await flush();
    expect(purposes.bindings).toEqual([]);
    expect(binding()).toBeUndefined();
    expect(revision).toBe(9);
  });
  it('updates eligibility when the projected authentication configuration changes', async () => {
    await installCodexDescriptor({ requiresAccountConfiguration: true });
    const rerender = await renderField();
    await open();
    expect(requireNode(`dropdown-option-${optionId(codexTarget)}`).getAttribute('aria-disabled')).toBe('true');
    await installCodexDescriptor();
    await rerender();
    expect(requireNode(`dropdown-option-${optionId(codexTarget)}`).getAttribute('aria-disabled')).not.toBe('true');
    await act(async () => { pointerPress(requireNode(`dropdown-option-${optionId(codexTarget)}`)); });
    expect(await selectionReceipt()).toMatchObject({ status: 'applied' });
    assertAccountSelection();
  });
  it('selects a bundled account without a Machine descriptor supplier', async () => {
    const bundledService = { pluginId: 'happier.agent.codex', localId: 'openai-codex' };
    const bundledTarget = { ...codexTarget, account: { ...codexTarget.account, service: bundledService } };
    const bundledDeclaration = VoiceProviderContributionSchema.parse({ ...declaration, credentials: {
      ...credentials, sources: credentials.sources.map(source => source.kind === 'connectedAccount'
        && typeof source.service !== 'string' && source.service.pluginId === descriptorService.pluginId
        ? { ...source, service: bundledService } : source),
    } });
    installCurrentDeclaration(bundledDeclaration);
    await publishProfile([{ ...codexAccount, ref: bundledTarget.account }]);
    await installCodexDescriptor({ available: false });
    await renderField(bundledDeclaration);
    await choose(optionId(bundledTarget));
    assertAccountSelection(bundledTarget);
  });
  it('offers none, SavedSecret and only manifest-declared service accounts', async () => {
    await installCodexDescriptor({ includeOpenAi: true });
    await publishProfile([codexAccount, { ...codexAccount, ref: apiTarget.account,
      authenticationModeId: 'api-key', configurationReady: true, displayName: 'Work API key' },
      { ...codexAccount, ref: { service: { pluginId: 'unrelated.plugin', localId: 'other' }, accountId: 'other-account' },
        displayName: 'Unrelated account' }]);
    await renderField();
    await open();
    const options = [...document.querySelectorAll<HTMLElement>('[data-testid^="dropdown-option-"]')]
      .filter(option => !option.dataset.testid?.endsWith(':scroll-frame'));
    expect(options.map(option => option.dataset.testid)).toEqual([
      'dropdown-option-none', 'dropdown-option-savedSecret',
      `dropdown-option-${optionId(codexTarget)}`, `dropdown-option-${optionId(apiTarget)}`,
    ]);
    expect(options.map(option => option.textContent).join()).not.toContain('Unrelated account');
  });
  it('presents an orphaned purpose as unavailable and allows explicit none to repair it', async () => {
    purposes = { v: 1, bindings: [{ purpose: { consumer: contribution, purpose: credentials.slot.purpose }, target: codexTarget }] };
    await refreshConnectedAccountCatalog(account!.scope, 'purposes');
    await renderField();
    expect(requireNode('voice-credential-source-api_key').textContent).toContain(t('common.unavailable'));
    await choose('none');
    expect(binding()).toMatchObject({ credentialSource: { kind: 'none' } });
    expect(purposes.bindings).toEqual([]);
  });
  it('replaces the single purpose between accounts and clears it for none', async () => {
    await installCodexDescriptor({ includeOpenAi: true });
    await publishProfile([codexAccount, { ...codexAccount, ref: apiTarget.account,
      authenticationModeId: 'api-key', configurationReady: true, displayName: 'Work API key' }]);
    await renderField();
    expect(await choose(optionId(codexTarget))).toMatchObject({ status: 'applied' });
    assertAccountSelection();
    await choose(optionId(apiTarget));
    assertAccountSelection(apiTarget);
    await choose('none');
    expect(binding()).toMatchObject({ credentialSource: { kind: 'none' } });
    expect(purposes.bindings).toEqual([]);
    expect(writes.map(write => write.expectedRevision)).toEqual([9, 10, 11]);
  });
  it('does not admit a gesture from a retired provider', async () => {
    await renderField(declaration, () => false);
    await choose(optionId(codexTarget), false);
    await flush();
    expect(binding()).toBeUndefined();
    expect(purposes.bindings).toEqual([]);
    expect(revision).toBe(9);
  });
  it('admits an equivalent rehydrated declaration', async () => {
    installCurrentDeclaration(VoiceProviderContributionSchema.parse(structuredClone(declaration)));
    await renderField();
    await choose(optionId(codexTarget));
    assertAccountSelection();
  });
  it('admits reordered raw grants and header-name sets', async () => {
    const expected = VoiceProviderContributionSchema.parse({
      ...declaration, credentials: { ...credentials, sources: credentials.sources.map(source =>
        source.kind === 'connectedAccount' && typeof source.service !== 'string'
          && source.service.localId === 'openai-codex' ? { ...source, rawGrants: [
            { realm: 'web', phase: 'prepare', request: { kind: 'httpHeaders', origin: 'https://api.openai.com', headerNames: ['authorization', 'openai-organization'] } },
            { realm: 'web', phase: 'connection', request: { kind: 'httpHeaders', origin: 'https://api.openai.com', headerNames: ['authorization'] } },
          ] } : source) },
    });
    installCurrentDeclaration(VoiceProviderContributionSchema.parse({
      ...expected, credentials: { ...expected.credentials!, sources: expected.credentials!.sources.map(source =>
        source.kind === 'connectedAccount' && typeof source.service !== 'string'
          && source.service.localId === 'openai-codex' ? { ...source, rawGrants: [...source.rawGrants!].reverse().map(grant =>
            grant.request.kind === 'httpHeaders' ? { ...grant, request: { ...grant.request, headerNames: [...grant.request.headerNames].reverse() } } : grant) } : source) },
    }));
    await renderField(expected);
    await choose(optionId(codexTarget));
    assertAccountSelection();
  });
  it.each([
    ['slot', { credentials: { ...credentials, slot: { ...credentials.slot, id: 'replacement_key' },
      hostMediated: { operations: credentials.hostMediated!.operations.map(operation => ({ ...operation, credentialSlotId: 'replacement_key' })) } } }],
    ['purpose', { credentials: { ...credentials, slot: { ...credentials.slot, purpose: 'voice.replacement' } } }],
    ['service', { credentials: { ...credentials, sources: credentials.sources.map(source =>
      source.kind === 'connectedAccount' && typeof source.service !== 'string' && source.service.localId === 'openai-codex'
        ? { ...source, service: { pluginId: 'replacement.plugin', localId: 'replacement' } } : source) } }],
    ['access contract', { credentials: { ...credentials, sources: credentials.sources.map(source =>
      source.kind === 'connectedAccount' && typeof source.service !== 'string' && source.service.localId === 'openai-codex'
        ? { ...source, rawGrants: [{ realm: 'web', phase: 'prepare', request: { kind: 'httpHeaders',
          origin: 'https://replacement.example.com', headerNames: ['authorization'] } }] } : source) } }],
  ])('refuses manifest %s drift after the gesture before admission', async (_kind, patch) => {
    const drifted = VoiceProviderContributionSchema.parse({ ...declaration, ...patch });
    await renderField();
    beforePurposeRead = () => installCurrentDeclaration(drifted);
    expect(await choose(optionId(codexTarget))).toMatchObject({ status: 'conflict' });
    expect(beforePurposeRead).toBeUndefined();
    await flush();
    expect(binding()).toBeUndefined();
    expect(purposes.bindings).toEqual([]);
    expect(revision).toBe(9);
  });
  it.each([
    ['path', { request: { pathTemplate: '/v1/realtime/replacement' } }],
    ['method', { request: { method: 'PATCH' } }],
    ['purpose', { purpose: 'voice.client-auth.revised' }],
    ['bounds', { request: { maxBodyBytes: 32_768 }, response: { maxBytes: 32_768 } }],
  ])('refuses host-mediated %s drift at admission', async (_kind, patch) => {
    const operation = credentials.hostMediated!.operations[0]!;
    const operationPatch = patch as Readonly<{ purpose?: string; request?: Partial<typeof operation.request>; response?: Partial<typeof operation.response> }>;
    installCurrentDeclaration(VoiceProviderContributionSchema.parse({
      ...declaration, credentials: { ...credentials, hostMediated: { operations: [{
        ...operation, ...operationPatch, request: { ...operation.request, ...operationPatch.request },
        response: { ...operation.response, ...operationPatch.response },
      }] } },
    }));
    await renderField();
    expect(await choose(optionId(codexTarget))).toMatchObject({ status: 'conflict' });
    await flush();
    expect(binding()).toBeUndefined();
    expect(purposes.bindings).toEqual([]);
    expect(revision).toBe(9);
  });
  it('keeps the applied receipt when the operation changes after acknowledged commit', async () => {
    const operation = credentials.hostMediated!.operations[0]!;
    const changed = VoiceProviderContributionSchema.parse({
      ...declaration, credentials: { ...credentials, hostMediated: { operations: [{
        ...operation, request: { ...operation.request, pathTemplate: '/v1/realtime/replacement' },
      }] } },
    });
    afterAcknowledgement = () => installCurrentDeclaration(changed);
    await renderField();
    expect(await choose(optionId(codexTarget))).toMatchObject({ status: 'applied' });
    assertAccountSelection();
    expect(requireNode('voice-credential-source-api_key').textContent).toContain('Work Codex');
    expect(requireNode('voice-credential-source-api_key').textContent).not.toContain(t('settingsProviders.errors.mutationOutcomeUnknownDescription'));
    expect(revision).toBe(10);
  });
});
