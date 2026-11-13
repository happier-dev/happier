import React from 'react';
import 'fake-indexeddb/auto';
import { act } from 'react-test-renderer';
import {
  PluginContributesV2Schema} from '@happier-dev/protocol/plugins/contributions/v2';
import { createVoiceProviderRecipientContractFromCredentialsV1} from '@happier-dev/protocol/plugins/recipientContractV1';
import { type VoiceProviderContribution,
} from '@happier-dev/protocol/plugins/contributions/voice';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { renderSettingsView, standardCleanup } from '@/dev/testkit';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { settingsParse } from '@/sync/domains/settings/settings';
import { VoiceSettingsPersistenceV1Schema } from '@/sync/domains/settings/voiceSettingsPersistence';
import { formatSavedSecretCatalogReferenceV1 } from '@happier-dev/protocol/account/settings/savedSecretCatalogV1';
import { storage } from '@/sync/domains/state/storage';
import { createVoiceSettingsAccountTestHarness, withVoiceSettingsCredentialResource } from '@/voice/settings/panels/voiceSettingsAccountTestHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { ModalProvider } from '@/modal';
import { t } from '@/text';

vi.mock('socket.io-client', async original =>
  (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(original));
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
// Only third-party renderer/portal leaves are replaced, not approval or modal state.
vi.mock('@/utils/web/radixCjs', async () => (await import('@/dev/testkit/mocks/radixCjs')).createRadixCjsModuleMock());
vi.mock('@/utils/web/reactDomCjs', () => ({ requireReactDOM: () => ({ createPortal: (children: React.ReactNode) => children }) }));
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
installDisconnectedServerSocketBoundary();
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
const originalState = storage.getState();
const { VoiceCredentialItem } = await import('@/voice/credentials/CredentialItem');
const { resolveAccountVoiceCredentialStatus } = await import('@/voice/credentials/accountVoiceCredential');
const { refreshSavedSecretCatalog } = await import('@/sync/engine/settings/savedSecretCatalogEngine');
const { resolveSavedSecretReference } = await import('@/sync/store/settings/savedSecretCatalogSnapshot');
const { VoiceConversationsSettingsScreen } = await import('@/voice/settings/screens/VoiceConversationsSettingsScreen');

function requireConversationDeclaration(
  declaration: VoiceProviderContribution,
) {
  if (declaration.kind !== 'conversation') throw new Error('expected conversation declaration');
  return declaration;
}

function createProviderLeaf() {
  return {
    kind: 'conversation' as const,
    protocol: {
      async prepare() {
        return { kind: 'prepared' as const, session: { config: {}, safeMetadata: null } };
      },
      decodeControl: () => [],
      encodeTurnControl: () => null,
    },
    async createConnection() {
      return {
        kind: 'sdk_handle' as const,
        async connect() {},
        async sendControl() {},
        controlEvents: () => ({ async *[Symbol.asyncIterator]() {} }),
        transportEvents: () => ({ async *[Symbol.asyncIterator]() {} }),
        async close() {},
        state: () => 'closed' as const,
        currentProviderSessionId: () => null,
        playbackCursorMs: () => null,
        beginOutputInterruptionCandidate: () => 'unsupported' as const,
        resolveOutputInterruptionCandidate() {},
      };
    },
    encodeToolResults: () => [],
    encodeToolContinuation: () => null,
    encodeContextUpdate: () => [],
    encodeTextTurn: () => [],
    microphoneMode: 'provider_managed' as const,
    setInputMuted: () => {},
  };
}

const declaration = requireConversationDeclaration(PluginContributesV2Schema.parse({
  voiceProviders: [{
    id: 'conversation',
    title: 'Acme Voice',
    kind: 'conversation',
    roles: ['realtime_conversation'],
    platforms: ['web'],
    capabilities: {
      turn: { cancelResponse: true, bargeIn: false },
    },
    credentials: {
      slot: { id: 'api_key', purpose: 'voice.client-auth', title: 'API key' },
      requirement: { kind: 'always' },
      sources: [{
        kind: 'savedSecret',
        secretKinds: ['apiKey'],
        operationProjections: [{
          kind: 'recipientCredential',
          operation: 'client-auth',
          phase: 'prepare',
          format: 'bearer',
        }],
      }],
      hostMediated: { operations: [{
        id: 'client-auth',
        purpose: 'voice.client-auth',
        credentialSlotId: 'api_key',
        effect: 'read',
        request: {
          origin: 'https://voice.example.test',
          pathTemplate: '/v1/session',
          queryTemplate: [],
          headerTemplate: [],
          bodyTemplate: { kind: 'none' },
          method: 'POST',
          credential: { kind: 'httpHeader', name: 'authorization', format: 'bearer' },
          redirect: 'error',
          maxBodyBytes: 0,
          contentTypes: [],
        },
        parameters: {
          schema: { type: 'object', properties: {}, additionalProperties: false },
          mapping: [],
        },
        response: { maxBytes: 64 * 1024, contentTypes: ['application/json'] },
      }] },
    },
    client: {
      artifactId: 'voice-runtime-web',
      exportName: 'activate',
    },
  }],
}).voiceProviders[0]!);

const recipientContract = createVoiceProviderRecipientContractFromCredentialsV1({
  package: {
    pluginId: 'acme.voice',
    source: { kind: 'package', locator: 'acme.voice' },
  },
  publisher: {
    trust: 'verified',
    identity: 'package:acme.voice',
  },
  contribution: {
    pluginId: 'acme.voice',
    localId: declaration.id,
  },
  credentials: {
    slot: declaration.credentials!.slot,
    hostMediated: declaration.credentials!.hostMediated!,
  },
  presentation: { title: declaration.title },
});

async function activateCredentialProvider() {
  const { createExternalVoiceProviderActivationScope } = await import('@/voice/registry/externalVoiceProviderActivation.testkit');
  const { createBundledConversationRuntimeHostLease } = await import('@/voice/registry/bundledConversationRuntimeHost');
  const hostLease = createBundledConversationRuntimeHostLease();
  const scope = createExternalVoiceProviderActivationScope({
    pluginId: 'acme.voice',
    occurrenceId: 'acme-voice-activation-occurrence',
    declarations: [declaration],
    hostPlatform: 'web',
    recipientContractsByLocalId: {
      [declaration.id]: recipientContract,
    },
  });
  onTestFinished(async () => {
    await scope.unwind();
    hostLease.revoke();
  });
  scope.api.voiceProviders.register(declaration.id, createProviderLeaf());
  await scope.commit();
}

const providerId = 'acme.voice/conversation';

function routeSettings(input: Readonly<{
  secrets?: readonly unknown[];
  credentialBindings?: readonly unknown[];
}>) {
  const settings = settingsParse({
    secrets: input.secrets ?? [],
    voice: {
      providerId,
      executionMachine: { mode: 'fixed', machineId: 'selected-daemon-that-must-not-own-client-credentials' },
      providers: {
        [providerId]: { schemaVersion: 1, config: {} },
      },
      credentialBindings: input.credentialBindings ?? [],
    },
  });
  // Routine Voice preference edits deliberately retain the existing credential
  // owner. This fixture supplies a Home-persisted credential root instead.
  const voiceSettingsV1 = VoiceSettingsPersistenceV1Schema.parse({
    ...settings.voice, credentialBindings: input.credentialBindings ?? [],
  });
  const { voice: _runtimeProjection, ...accountSettings } = settings;
  return settingsParse({ ...accountSettings, voiceSettingsV1 });
}

afterEach(() => {
  storage.setState(originalState, true);
  standardCleanup();
});

describe('VoiceSettingsScreen external provider credentials', () => {
  it('renders an installed provider declared account credential slot through the real settings route', async () => {
    await activateCredentialProvider();
    const account = await createVoiceSettingsAccountTestHarness(routeSettings({}));
    onTestFinished(account.dispose);
    const screen = await renderSettingsView(<InjectedAuthProvider credentials={account.credentials}><ModalProvider><VoiceConversationsSettingsScreen /></ModalProvider></InjectedAuthProvider>);
    await act(async () => undefined);

    const credential = screen.tree.findByType(VoiceCredentialItem);
    expect(credential.props).toMatchObject({
      testID: 'settings.voice.externalCredential.acme.voice%2Fconversation.api_key',
      contribution: { pluginId: 'acme.voice', localId: 'conversation' },
      credentialSlotId: 'api_key',
      disclosePlainStorage: true,
    });
    expect(credential.props).not.toHaveProperty('machineId');
  });

  it('reports an owner-linked account binding ready without another approval and ignores the selected-daemon override', async () => {
    await activateCredentialProvider();
    const account = await createVoiceSettingsAccountTestHarness(routeSettings({}));
    onTestFinished(account.dispose);
    // Serve current material and bind it through the real source mutation owner.
    // Legacy Settings import has its own explicit approval/lifecycle contract.
    const accountBound = await withVoiceSettingsCredentialResource(account, {
      settings: account.settings, declaration, pluginId: 'acme.voice', resourceId: 'account-secret',
    });
    account.replaceSettings(await withVoiceSettingsCredentialResource(account, {
      settings: accountBound, declaration, pluginId: 'acme.voice', resourceId: 'machine-secret',
      machineId: 'selected-daemon-that-must-not-own-client-credentials',
    }));
    const screen = await renderSettingsView(<InjectedAuthProvider credentials={account.credentials}><ModalProvider><VoiceConversationsSettingsScreen /></ModalProvider></InjectedAuthProvider>);
    await act(async () => { await refreshSavedSecretCatalog(account.scope); });
    const accountRef = formatSavedSecretCatalogReferenceV1({ kind: 'shared_resource', id: 'account-secret' });
    const machineRef = formatSavedSecretCatalogReferenceV1({ kind: 'shared_resource', id: 'machine-secret' });
    const accountEntry = account.resources.find(resource => 'ref' in resource.entry && resource.entry.ref === accountRef)?.entry;
    const machineEntry = account.resources.find(resource => 'ref' in resource.entry && resource.entry.ref === machineRef)?.entry;
    if (!accountEntry || !('ref' in accountEntry) || !machineEntry || !('ref' in machineEntry)) {
      throw new Error('Real SavedSecret catalog did not admit both input sources');
    }
    expect(account.settings.voiceSettingsV1.credentialBindings).toMatchObject([{
      credentialBindings: {
        account: { api_key: accountEntry.ref },
        byMachineId: { 'selected-daemon-that-must-not-own-client-credentials': { api_key: machineEntry.ref } },
      },
    }]);
    const credentialStatus = () => resolveAccountVoiceCredentialStatus({
      settings: account.settings,
      contribution: { pluginId: 'acme.voice', localId: 'conversation' },
      credentialSlotId: 'api_key',
      resolveSavedSecret: ref => resolveSavedSecretReference(account.scope, account.settings.secrets, ref),
    });
    // Linking the owner's Saved Secret supplies approval at the canonical
    // credential owner; readiness must not ask for the retired digest review.
    expect(credentialStatus()).toMatchObject({ status: 'ready', reference: { secretId: accountRef, source: 'account' } });
    expect(screen.getTextContent()).toContain(t('settingsVoice.local.voiceCredential.setOnAccount'));
    expect(screen.findHostByTestId('web-modal-confirm')).toBeNull();

    const machineOnlySettings = routeSettings({
      credentialBindings: [{
        contribution: { pluginId: 'acme.voice', localId: 'conversation' },
        credentialSlotId: 'api_key',
        credentialSource: { kind: 'savedSecret' },
        credentialBindings: {
          byMachineId: {
            'selected-daemon-that-must-not-own-client-credentials': { api_key: machineEntry.ref },
          },
        },
      }],
    });
    await act(async () => {
      account.replaceSettings(machineOnlySettings);
    });

    expect(credentialStatus()).toMatchObject({ status: 'missing', reference: null });
    expect(screen.getTextContent()).toContain(t('settingsVoice.local.voiceCredential.notSetOnAccount'));
    expect(screen.tree.findByType(VoiceCredentialItem).props)
      .not.toHaveProperty('machineId');
  });

});
