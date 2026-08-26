import React from 'react';
import { act } from 'react-test-renderer';
import {
  PluginContributesV2Schema,
  createRecipientContractDigestV1,
  createVoiceProviderRecipientContractFromCredentialsV1,
  type VoiceProviderContribution,
} from '@happier-dev/protocol';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import { renderSettingsView, standardCleanup } from '@/dev/testkit';
import { settingsParse, type Settings } from '@/sync/domains/settings/settings';
import type { VoiceSettings } from '@/sync/domains/settings/voiceSettings';

import { installVoiceSettingsRouteModuleMocks } from './voiceSettingsRouteTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const routeState = vi.hoisted(() => ({
  settings: null as Settings | null,
  voice: null as VoiceSettings | null,
}));

vi.mock('react-native', async () =>
  (await import('@/dev/testkit/mocks/reactNative')).installReactNativeWebMock()());

installVoiceSettingsRouteModuleMocks({
  storageModule: async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    const { settingsDefaults } = await import('@/sync/domains/settings/settings');
    return createStorageModuleStub({
      useSettings: () => routeState.settings ?? settingsDefaults,
    });
  },
});

vi.mock('@/voice/settings/useVoiceSettingsMutable', () => ({
  useVoiceSettingsMutable: () => [routeState.voice, vi.fn()],
}));

vi.mock('@/hooks/server/useHappierVoiceSupport', () => ({
  useHappierVoiceSupport: () => true,
}));

vi.mock('@/constants/Languages', () => ({
  LANGUAGES: [],
}));

vi.mock('@/voice/credentials/CredentialItem', () => ({
  VoiceCredentialItem: (props: object) => React.createElement('VoiceCredentialItem', props),
}));

vi.mock('@/voice/settings/panels/VoicePrivacySection', () => ({
  VoicePrivacySection: () => null,
}));

vi.mock('@/voice/settings/panels/VoiceUiSection', () => ({
  VoiceUiSection: () => null,
}));

vi.mock('@/voice/settings/panels/BundledConversationSettingsSection', () => ({
  BundledConversationSettingsSection: () => null,
}));

vi.mock('@/voice/settings/panels/VoiceExecutionMachineSection', () => ({
  VoiceExecutionMachineSection: () => null,
}));

vi.mock('@/voice/settings/panels/LocalDirectSection', () => ({
  LocalDirectSection: () => null,
}));

vi.mock('@/voice/settings/panels/LocalConversationSection', () => ({
  LocalConversationSection: () => null,
}));

vi.mock('@/voice/diagnostics/VoiceDiagnosticsSettingsSection', () => ({
  VoiceDiagnosticsSettingsSection: () => null,
}));

vi.mock('@/voice/settings/panels/modelCatalog/useDaemonVoiceModelCatalogState', () => ({
  useDaemonVoiceModelCatalogState: () => ({
    state: {
      statuses: [],
      errorCode: null,
      loading: false,
      actionPackId: null,
      actionError: null,
    },
    refresh: vi.fn(),
    install: vi.fn(),
    remove: vi.fn(),
  }),
}));

vi.mock('@/voice/credentials/useExecutionMachinePresentation', () => ({
  useVoiceExecutionMachinePresentation: () => ({
    machineId: 'selected-daemon-that-must-not-own-client-credentials',
    machineLabel: 'Selected daemon',
  }),
}));

vi.mock('@/voice/settings/voiceProviderLocalAvailability', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/voice/settings/voiceProviderLocalAvailability')>();
  return {
    ...actual,
    useVoiceProviderLocalAvailability: () => ({
      browserSpeech: { support: 'unavailable', onDevice: 'unsupported' },
      daemon: {
        featureEnabled: false,
        route: 'unavailable',
        modelState: 'unknown',
        runtimeState: 'unknown',
        pcmCapture: 'unavailable',
      },
      nativeDevice: { requested: false },
    }),
  };
});

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
      modulePath: './voiceRuntime',
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
const recipientContractDigest = createRecipientContractDigestV1(recipientContract);

async function activateCredentialProvider() {
  const { createExternalVoiceProviderActivationScope } = await import('@/voice/registry/externalVoiceProviderActivation.testkit');
  const { createBundledConversationRuntimeHostLease } = await import('@/voice/registry/bundledConversationRuntimeHost');
  const hostLease = createBundledConversationRuntimeHostLease();
  const scope = createExternalVoiceProviderActivationScope({
    pluginId: 'acme.voice',
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

function setRouteSettings(input: Readonly<{
  secrets?: readonly unknown[];
  credentialBindings?: readonly unknown[];
}>) {
  routeState.settings = settingsParse({
    secrets: input.secrets ?? [],
    voice: {
      providerId,
      providers: {
        [providerId]: { schemaVersion: 1, config: {} },
      },
      credentialBindings: input.credentialBindings ?? [],
    },
  });
  routeState.voice = routeState.settings.voice;
}

afterEach(() => {
  routeState.settings = null;
  routeState.voice = null;
  standardCleanup();
});

describe('VoiceSettingsScreen external provider credentials', () => {
  it('renders an installed provider declared account credential slot through the real settings route', async () => {
    await activateCredentialProvider();
    setRouteSettings({});

    const VoiceSettingsScreen = (await import('@/voice/settings/screens/VoiceConversationsSettingsScreen')).VoiceConversationsSettingsScreen;
    const screen = await renderSettingsView(<VoiceSettingsScreen />);
    await act(async () => undefined);

    const credential = screen.tree.findByType('VoiceCredentialItem' as never);
    expect(credential.props).toMatchObject({
      testID: 'settings.voice.externalCredential.acme.voice%2Fconversation.api_key',
      contribution: { pluginId: 'acme.voice', localId: 'conversation' },
      credentialSlotId: 'api_key',
      disclosePlainStorage: true,
    });
    expect(credential.props).not.toHaveProperty('machineId');
  });

  it('reports ready only for the exact account binding and ignores the selected-daemon override', async () => {
    await activateCredentialProvider();
    const accountSecret = {
      id: 'account-secret',
      name: 'Account key',
      kind: 'apiKey',
      encryptedValue: { _isSecretValue: true, value: 'account-key' },
      createdAt: 1,
      updatedAt: 1,
    };
    const machineSecret = {
      ...accountSecret,
      id: 'machine-secret',
      name: 'Machine key',
      encryptedValue: { _isSecretValue: true, value: 'machine-key' },
    };
    setRouteSettings({
      secrets: [accountSecret, machineSecret],
      credentialBindings: [{
        contribution: { pluginId: 'acme.voice', localId: 'conversation' },
        credentialSlotId: 'api_key',
        credentialSource: { kind: 'savedSecret' },
        approvedRecipientContractDigest: recipientContractDigest,
        credentialBindings: {
          account: { api_key: 'account-secret' },
          byMachineId: {
            'selected-daemon-that-must-not-own-client-credentials': { api_key: 'machine-secret' },
          },
        },
      }],
    });

    const VoiceSettingsScreen = (await import('@/voice/settings/screens/VoiceConversationsSettingsScreen')).VoiceConversationsSettingsScreen;
    const screen = await renderSettingsView(<VoiceSettingsScreen />);
    const providerRowTestId = `settings.voice.provider.${encodeURIComponent(providerId)}.default`;
    expect(screen.findByTestId(providerRowTestId)?.props.detail)
      .toBe('settingsVoice.externalCredentials.ready');

    setRouteSettings({
      secrets: [machineSecret],
      credentialBindings: [{
        contribution: { pluginId: 'acme.voice', localId: 'conversation' },
        credentialSlotId: 'api_key',
        credentialSource: { kind: 'savedSecret' },
        approvedRecipientContractDigest: recipientContractDigest,
        credentialBindings: {
          byMachineId: {
            'selected-daemon-that-must-not-own-client-credentials': { api_key: 'machine-secret' },
          },
        },
      }],
    });
    await act(async () => {
      screen.tree.update(<VoiceSettingsScreen />);
    });

    expect(screen.findByTestId(providerRowTestId)?.props.detail)
      .toContain('settingsVoice.externalCredentials.missing');
    expect(screen.findByTestId(providerRowTestId)?.props.detail)
      .toContain('voice.readiness.credential_missing');
    expect(screen.tree.findByType('VoiceCredentialItem' as never).props)
      .not.toHaveProperty('machineId');
  });

});
