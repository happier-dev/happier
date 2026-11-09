/**
 * @vitest-environment jsdom
 */
import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildQualifiedPluginContributionKey} from '@happier-dev/protocol/plugins/contribution-key';
import {
  createPluginContributionIdentity} from '@happier-dev/protocol/plugins/contribution-identity';
import {
  createRecipientContractDigestV1,
} from '@happier-dev/protocol/plugins/recipientContractV1';
import {
  settingsParse,
  type Settings,
} from '@/sync/domains/settings/settings';
import { voiceSettingsParse } from '@/sync/domains/settings/voiceSettings';
import { createBundledVoiceRecipientContract } from '@/voice/credentials/voiceRecipientContract';
import { BUNDLED_FIRST_PARTY_VOICE_CONVERSATION_RUNTIME_ENTRIES } from '@/voice/registry/generatedBundledVoiceRuntimeEntries';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createElevenLabsSettingsRuntimeTestHarness, createVoiceSettingsAccountTestHarness, withVoiceSettingsCredentialResource } from './voiceSettingsAccountTestHarness';
import 'fake-indexeddb/auto';
import { installWebLockManagerMock } from '@/auth/storage/tokenStorage.web.testHelpers';

import { BundledConversationSettingsSection } from './BundledConversationSettingsSection';
import { ModalProvider } from '@/modal';
import { setPreferredLanguageFromSettings } from '@/text';
import { refreshSavedSecretCatalog } from '@/sync/engine/settings/savedSecretCatalogEngine';
import { waitForTestEvent } from '@/dev/testkit';

function subscribeDom(notify: () => void) {
  const observer = new MutationObserver(notify);
  observer.observe(document.body, { childList: true, subtree: true, attributes: true });
  return () => observer.disconnect();
}

vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
vi.mock('socket.io-client', async (importOriginal) => (
    await import('@/dev/testkit/harness/serverAccountConnectionHarness')
).createSocketIoClientBoundary(importOriginal));
installDisconnectedServerSocketBoundary();

const fixtureState = vi.hoisted(() => ({
  settings: null as unknown as Settings,
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

vi.mock('react-native-unistyles', async () => {
  const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
  return createUnistylesMock();
});

vi.mock('@elevenlabs/client', () => ({
  Conversation: {
    startSession: vi.fn(),
  },
}));
await loadSyncSingletonForTests();

const { storage } = await import('@/sync/domains/state/storage');
const initialStorageState = storage.getState();

describe('ElevenLabs settings provisioning composed path', () => {
  const disposals: Array<() => void | Promise<void>> = [];

  beforeEach(() => {
    disposals.push(installWebLockManagerMock().restore);
    fixtureState.settings = null as unknown as Settings;
    setPreferredLanguageFromSettings('en');
  });

  afterEach(async () => {
    while (disposals.length > 0) {
      await disposals.pop()?.();
    }
    storage.setState(initialStorageState, true);
  });

  it('offers Create until provisioning persists an Agent ID, then offers Update', async () => {
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
      privacy: { currentUiContextMode: 'on_demand', shareDeviceInventory: true },
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
    fixtureState.settings = settingsParse({
      voice, experiments: true, featureToggles: { voice: true },
    });
    const account = await createVoiceSettingsAccountTestHarness(fixtureState.settings);
    account.replaceSettings(await withVoiceSettingsCredentialResource(account, {
      settings: account.settings,
      declaration: entry.declaration,
      pluginId: entry.pluginId,
      resourceId: 'elevenlabs-composed-secret',
      recipientContractDigest: createRecipientContractDigestV1(recipientContract),
    }));
    expect(account.settings.voice.providerId).toBe(providerId);
    disposals.push(account.dispose);
    await refreshSavedSecretCatalog(account.scope);
    expect(account.resources).toHaveLength(1);
    const binding = account.settings.voiceSettingsV1.credentialBindings.find(candidate =>
      candidate.contribution.pluginId === entry.pluginId && candidate.contribution.localId === entry.declaration.id);
    expect(binding?.credentialBindings.account?.api_key).toMatch(/^happier:shared-secret:v1:/u);
    await refreshSavedSecretCatalog(account.scope);
    const provider = createElevenLabsSettingsRuntimeTestHarness();
    await provider.register();
    disposals.push(provider.dispose);
    const vendorFetch = provider.fetch.getMockImplementation()!;
    provider.fetch.mockImplementation(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname === '/v1/convai/agents' && init?.method === 'GET') {
        return provider.response({ agents: [{ agent_id: 'agent_existing', name: 'Happier Voice' }], has_more: false, next_cursor: null });
      }
      return vendorFetch(input, init);
    });
    const httpRequests = () => provider.fetch.mock.calls.map(([input, init]) => ({
      path: new URL(input instanceof Request ? input.url : String(input)).pathname,
      method: init?.method,
    }));

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    disposals.push(async () => {
      await act(async () => root.unmount());
      host.remove();
    });
    await act(async () => {
      root.render(
        <ModalProvider><BundledConversationSettingsSection voice={voice} /></ModalProvider>,
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
    expect(updateRow).toBeNull();

    await act(async () => {
      createRow?.click();
    });
    const findButton = (testID: string) => document.querySelector<HTMLElement>(`[data-testid="${testID}"]`);
    await waitForTestEvent(subscribeDom, () => expect(findButton('app-shell-confirmation-confirm')).toBeInstanceOf(HTMLElement));
    await act(async () => findButton('app-shell-confirmation-confirm')?.click());
    await waitForTestEvent(subscribeDom,
      () => findButton('app-shell-question-existing-agent-action-choice-update-existing-0'), button => button !== null);
    expect(httpRequests()[0]).toEqual({ path: '/v1/convai/agents', method: 'GET' });
    expect(findButton('app-shell-question-existing-agent-action-choice-create-new')?.getAttribute('role')).toBe('radio');
    expect(findButton('app-shell-question-existing-agent-action-choice-update-existing-0')?.getAttribute('role')).toBe('radio');
    await act(async () => findButton('app-shell-question-existing-agent-action-choice-create-new')?.click());
    await act(async () => findButton('app-shell-question-submit')?.click());
    await waitForTestEvent(account.subscribe,
      () => account.persistedSettings.voice.providers[providerId]?.config,
      config => !!config && typeof config === 'object' && !Array.isArray(config) && 'agentId' in config && config.agentId === 'agent_created');
    await waitForTestEvent(storage.subscribe,
      () => account.settings.voice.providers[providerId]?.config,
      config => !!config && typeof config === 'object' && !Array.isArray(config) && 'agentId' in config && config.agentId === 'agent_created');
    expect(httpRequests()[0]).toEqual({ path: '/v1/convai/agents', method: 'GET' });
    expect(httpRequests()).toContainEqual({ path: '/v1/convai/tools', method: 'POST' });
    expect(httpRequests()).toContainEqual({ path: '/v1/convai/agents/create', method: 'POST' });
    expect(httpRequests().at(-1)).toEqual({ path: '/v1/convai/agents/agent_created', method: 'GET' });
    expect(account.settings.voice.providers[providerId]?.config).toEqual(
      expect.objectContaining({ agentId: 'agent_created' }),
    );
    expect(account.writes).toHaveLength(1);
    expect(account.persistedSettings.voice.providerId).toBe(providerId);
    expect(account.persistedSettings.voice.providers[providerId]?.config).toMatchObject({ agentId: 'agent_created' });
    await act(async () => root.render(
      <ModalProvider><BundledConversationSettingsSection voice={account.settings.voice} /></ModalProvider>,
    ));
    expect(host.querySelector('[data-testid="voice-settings-action-create-agent"]')).toBeNull();
    await waitForTestEvent(subscribeDom,
      () => host.querySelector<HTMLElement>('[data-testid="voice-settings-action-update-agent"]'),
      update => update !== null && !update.matches(':disabled, [aria-disabled="true"]'));
    const update = host.querySelector<HTMLElement>('[data-testid="voice-settings-action-update-agent"]');
    expect(update).toBeInstanceOf(HTMLElement);
    expect(update?.matches('button, [role="button"]')).toBe(true);
    expect(update?.matches(':disabled, [aria-disabled="true"]')).toBe(false);

  });

});
