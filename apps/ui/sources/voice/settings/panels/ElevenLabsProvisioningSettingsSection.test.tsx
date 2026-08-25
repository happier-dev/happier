/**
 * @vitest-environment jsdom
 */
import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildQualifiedPluginContributionKey,
  createPluginContributionIdentity,
  createRecipientContractDigestV1,
} from '@happier-dev/protocol';
import type { PluginApi } from '@happier-dev/plugin-sdk';
import {
  settingsDefaults,
  settingsParse,
  type Settings,
} from '@/sync/domains/settings/settings';
import { voiceSettingsParse } from '@/sync/domains/settings/voiceSettings';
import { upsertAccountVoiceCredential } from '@/voice/credentials/accountVoiceCredential';
import { createBundledVoiceRecipientContract } from '@/voice/credentials/voiceRecipientContract';
import {
  bindVoiceProviderSettingsActions,
  bindVoiceProviderSettingsOperations,
} from '@/voice/registry/externalVoiceProviderActivation';
import {
  commitExternalVoiceProviderRegistration,
  removeExternalVoiceProviderRegistration,
} from '@/voice/registry/externalVoiceProviderRegistrations';
import { BUNDLED_FIRST_PARTY_VOICE_CONVERSATION_RUNTIME_ENTRIES } from '@/voice/registry/generatedBundledVoiceRuntimeEntries';

import { BundledConversationSettingsSection } from './BundledConversationSettingsSection';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const fixtureState = vi.hoisted(() => ({
  settings: null as unknown as Settings,
  settingsVersion: 4,
}));

vi.mock('react-native', async () => {
  const actual: typeof import('react-native-web') = await vi.importActual('react-native-web');
  return {
    ...actual,
    Platform: {
      ...actual.Platform,
      OS: 'web',
      select: <T,>(values: Readonly<{ web?: T; default?: T }>) =>
        values.web ?? values.default,
    },
  };
});

vi.mock('@expo/vector-icons', () => ({
  Ionicons: () => null,
}));

vi.mock('@/components/ui/icons/Icon', async (importOriginal) => ({
  ...await importOriginal(),
  // This DOM integration test exercises the provider action leaf, not icon rendering.
  Icon: () => null,
}));

vi.mock('react-native-unistyles', async () => {
  const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
  return createUnistylesMock();
});

vi.mock('@/text', async () => {
  const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
  return createTextModuleMock({ translate: (key: string) => key });
});

vi.mock('@/modal', async () => {
  const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
  return createModalModuleMock({ confirmResult: true }).module;
});

vi.mock('@/sync/domains/state/storage', async () => {
  const {
    createLiveStorageStoreMock,
    createStorageModuleStub,
  } = await import('@/dev/testkit/mocks/storage');
  const storage = createLiveStorageStoreMock(() => ({
    settings: fixtureState.settings,
    settingsVersion: fixtureState.settingsVersion,
    artifacts: {},
    updateArtifact: () => {},
  }));
  return createStorageModuleStub({
    storage,
    useSettings: () => fixtureState.settings,
  });
});

vi.mock('@/sync/runtime/getSyncSingleton', () => ({
  getSyncSingleton: () => ({
    prepareAccountSettingsForDaemonSpawn: vi.fn(async () => ({
      accountSettingsVersionHint: fixtureState.settingsVersion,
    })),
    mutateAccountSettingsOnce: vi.fn(async (input: Readonly<{
      expectedSettingsVersion: number;
      mutate(raw: Readonly<Record<string, unknown>>): Readonly<{
        settings: Record<string, unknown>;
        value: unknown;
      }>;
    }>) => {
      if (input.expectedSettingsVersion !== fixtureState.settingsVersion) {
        return { status: 'conflict', currentSettingsVersion: fixtureState.settingsVersion };
      }
      const result = input.mutate({ voiceSettingsV1: fixtureState.settings.voice });
      fixtureState.settings = { ...fixtureState.settings, voice: result.settings.voiceSettingsV1 } as Settings;
      fixtureState.settingsVersion += 1;
      return { status: 'applied', settingsVersion: fixtureState.settingsVersion, value: result.value };
    }),
  }),
}));

vi.mock('@elevenlabs/client', () => ({
  Conversation: {
    startSession: vi.fn(),
  },
}));

describe('ElevenLabs settings provisioning composed path', () => {
  const disposals: Array<() => void | Promise<void>> = [];

  beforeEach(() => {
    fixtureState.settings = null as unknown as Settings;
    fixtureState.settingsVersion = 4;
  });

  afterEach(async () => {
    while (disposals.length > 0) {
      await disposals.pop()?.();
    }
  });

  it('keeps Create available and blocks direct Update until an Agent ID exists', async () => {
    const entry = BUNDLED_FIRST_PARTY_VOICE_CONVERSATION_RUNTIME_ENTRIES.find(
      (candidate) => candidate.declaration.id === 'realtime-elevenlabs',
    );
    if (!entry) throw new Error('realtime_elevenlabs bundled entry missing');
    const recipientContract = createBundledVoiceRecipientContract({
      pluginId: entry.pluginId,
      declaration: entry.declaration,
    });
    if (!recipientContract) throw new Error('realtime_elevenlabs recipient contract missing');
    const providerId = buildQualifiedPluginContributionKey(createPluginContributionIdentity({
      pluginId: entry.pluginId,
      localId: entry.declaration.id,
    }));

    const voice = voiceSettingsParse({
      providerId,
      providers: {
        [providerId]: {
          schemaVersion: 2,
          config: {
            billingMode: 'byo',
            agentId: '',
            tts: {
              voiceId: 'hpp4J3VqNfWAUOO0d1Us',
              modelId: null,
              voiceSettings: {
                stability: null,
                similarityBoost: null,
                speed: null,
              },
            },
          },
        },
      },
    });
    fixtureState.settings = upsertAccountVoiceCredential({
      settings: settingsParse({
        ...settingsDefaults,
        voice,
      }),
      contribution: {
        pluginId: entry.pluginId,
        localId: entry.declaration.id,
      },
      credentialSlotId: recipientContract.credentialSlot.id,
      value: 'test-only-elevenlabs-key',
      generateId: () => 'elevenlabs-composed-secret',
      now: 1,
      expectedSecretId: null,
      expectedSecretUpdatedAt: null,
      approvedRecipientContractDigest:
        createRecipientContractDigestV1(recipientContract),
    }).settings;
    const registeredRuntimes: Parameters<PluginApi['voiceProviders']['register']>[1][] = [];
    entry.activate({
      voiceProviders: {
        register(localId, runtime) {
          expect(localId).toBe(entry.declaration.id);
          registeredRuntimes.push(runtime);
        },
      },
    });
    const registeredRuntime = registeredRuntimes[0];
    if (registeredRuntime?.kind !== 'conversation' || !registeredRuntime.settingsOperations) {
      throw new Error('ElevenLabs settings operations were not registered');
    }

    const operationIds: string[] = [];
    const askQuestions = vi.fn(async () => Object.freeze({
      requestId: 'elevenlabs-provisioning-questions-1',
      kind: 'questions' as const,
      status: 'answered' as const,
      answers: Object.freeze({
        'existing-agent-action': Object.freeze({
          kind: 'singleChoice' as const,
          answer: Object.freeze({ kind: 'choice' as const, choiceId: 'create-new' }),
        }),
      }),
    }));
    let nextToolId = 0;
    const request = vi.fn(async (input: Readonly<{ operationId: string }>) => {
      operationIds.push(input.operationId);
      const body = input.operationId === 'agents'
        ? {
            agents: [{ agent_id: 'agent_existing', name: 'Happier Voice' }],
            has_more: false,
            next_cursor: null,
          }
        : input.operationId === 'voices'
          ? {
              voices: [{
                voice_id: 'hpp4J3VqNfWAUOO0d1Us',
                name: 'Default Happier Voice',
                category: 'premade',
              }],
            }
        : input.operationId === 'tools'
          ? { tools: [], has_more: false, next_cursor: null }
          : input.operationId === 'create-tool'
            ? { id: `tool_${++nextToolId}` }
            : input.operationId === 'create-agent'
              ? { agent_id: 'agent_created_from_rendered_press' }
              : {};
      return Object.freeze({
        status: 200,
        finalUrl: `https://api.elevenlabs.io/${input.operationId}`,
        headers: Object.freeze({ 'content-type': 'application/json' }),
        body: new TextEncoder().encode(JSON.stringify(body)),
      });
    });
    const boundSettingsOperations = bindVoiceProviderSettingsOperations({
      operations: registeredRuntime.settingsOperations,
      createCredentials: () => Object.freeze({
        phase: 'settings' as const,
        mediated: Object.freeze({ request }),
        raw: null,
      }),
      isCurrent: () => true,
    });
    if (!registeredRuntime.settingsActions) throw new Error('ElevenLabs settings actions were not registered');
    const boundSettingsActions = bindVoiceProviderSettingsActions({
      actions: registeredRuntime.settingsActions,
      declaredActions: entry.declaration.settings?.actions ?? [],
      createCredentials: () => Object.freeze({
        phase: 'settings' as const,
        mediated: Object.freeze({ request }),
        raw: null,
      }),
      createInteractions: () => Object.freeze({ askQuestions }),
      getRealtimeClientToolDefinitions: () => [Object.freeze({
        name: 'listMachines',
        description: 'List available machines',
        parameters: Object.freeze({ type: 'object', additionalProperties: false }),
        execute: async () => Object.freeze({ ok: true }),
      })],
      isCurrent: () => true,
    });
    const token = Object.freeze({});
    commitExternalVoiceProviderRegistration(Object.freeze({
      token,
      pluginId: entry.pluginId,
      localId: entry.declaration.id,
      providerId,
      descriptor: null,
      adapter: null,
      settingsOperations: boundSettingsOperations,
      settingsActions: boundSettingsActions,
    }));
    disposals.push(async () => {
      await act(async () => removeExternalVoiceProviderRegistration(token));
    });
    disposals.push(async () => await registeredRuntime?.dispose?.());

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    disposals.push(async () => {
      await act(async () => root.unmount());
      host.remove();
    });
    const setVoice = vi.fn();
    await act(async () => {
      root.render(
        <BundledConversationSettingsSection voice={voice} setVoice={setVoice} />,
      );
    });
    const createRow = host.querySelector<HTMLButtonElement>(
      '[data-testid="voice-settings-action-create-agent"]',
    );
    const updateRow = host.querySelector<HTMLButtonElement>(
      '[data-testid="voice-settings-action-update-agent"]',
    );
    expect(createRow).toBeInstanceOf(HTMLButtonElement);
    expect(createRow?.disabled).toBe(false);
    expect(updateRow).toBeInstanceOf(HTMLButtonElement);
    expect(updateRow?.disabled).toBe(true);

    await act(async () => {
      createRow?.click();
      await vi.waitFor(() => {
        expect(operationIds[0]).toBe('agents');
        expect(askQuestions).toHaveBeenCalledWith(expect.objectContaining({
          kind: 'questions',
          questions: [expect.objectContaining({
            id: 'existing-agent-action',
            type: 'singleChoice',
            choices: expect.arrayContaining([
              expect.objectContaining({ id: 'create-new' }),
              expect.objectContaining({ id: 'update-existing-0' }),
            ]),
          })],
        }), expect.objectContaining({ signal: expect.any(AbortSignal) }));
        expect(operationIds).toContain('create-tool');
        expect(operationIds.at(-1)).toBe('create-agent');
        expect(fixtureState.settings.voice.providers[providerId]?.config).toEqual(
          expect.objectContaining({ agentId: 'agent_created_from_rendered_press' }),
        );
      });
    });
    await act(async () => {
      await vi.waitFor(() => expect(host.querySelector<HTMLButtonElement>(
        '[data-testid="voice-settings-action-create-agent"]',
      )?.disabled).toBe(false));
    });

  });

});
