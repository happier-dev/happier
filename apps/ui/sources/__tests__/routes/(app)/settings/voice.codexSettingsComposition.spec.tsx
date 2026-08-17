import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderSettingsView, standardCleanup } from '@/dev/testkit';
import {
  voiceSettingsParse,
  type VoiceSettings,
} from '@/sync/domains/settings/voiceSettings';

import { installVoiceSettingsRouteModuleMocks } from './voiceSettingsRouteTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const routeState = vi.hoisted(() => ({
  voice: null as VoiceSettings | null,
}));

installVoiceSettingsRouteModuleMocks();

vi.mock('@/voice/settings/useVoiceSettingsMutable', () => ({
  useVoiceSettingsMutable: () => [routeState.voice, vi.fn()],
}));

vi.mock('@/hooks/server/useHappierVoiceSupport', () => ({
  useHappierVoiceSupport: () => true,
}));

vi.mock('@/constants/Languages', () => ({
  LANGUAGES: [],
}));

vi.mock('@/voice/settings/panels/VoicePrivacySection', () => ({
  VoicePrivacySection: () => null,
}));

vi.mock('@/voice/settings/panels/VoiceUiSection', () => ({
  VoiceUiSection: () => null,
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
    machineId: 'voice-runtime-machine',
    machineLabel: 'Voice runtime machine',
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

vi.mock('@/voice/settings/panels/realtime/VoiceGlobalConnectedServicesBindingField', () => ({
  VoiceGlobalConnectedServicesBindingField: (props: object) =>
    React.createElement('VoiceGlobalConnectedServicesBindingField', props),
}));

beforeEach(() => {
  routeState.voice = voiceSettingsParse({
    providerId: 'happier.agent.codex/realtime-codex',
    providers: {
      'happier.agent.codex/realtime-codex': {
        schemaVersion: 2,
        config: { globalConnectedServices: null },
      },
    },
  });
});

afterEach(() => {
  routeState.voice = null;
  standardCleanup();
});

describe('VoiceSettingsScreen Codex settings composition', () => {
  it('renders the public Codex settings once without an empty legacy bundled group', async () => {
    const VoiceSettingsScreen = (await import('@/voice/settings/screens/VoiceConversationsSettingsScreen')).VoiceConversationsSettingsScreen;
    const screen = await renderSettingsView(<VoiceSettingsScreen />);

    const accountFields = screen.tree.findAllByType(
      'VoiceGlobalConnectedServicesBindingField' as never,
    );
    expect(accountFields).toHaveLength(1);
    expect(accountFields[0]?.props).toMatchObject({
      title: 'Codex account',
      agentId: {
        pluginId: 'happier.agent.codex',
        localId: 'codex',
      },
      serviceIds: ['openai-codex'],
    });
    // Mode, readiness, declarative Codex account settings, and language. The
    // public account field appears once; no empty legacy bundled group is added.
    expect(screen.tree.findAllByType('ItemGroup' as never)).toHaveLength(4);
  });
});
