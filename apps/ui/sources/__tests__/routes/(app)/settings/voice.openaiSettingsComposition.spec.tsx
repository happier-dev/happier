import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderSettingsView, standardCleanup } from '@/dev/testkit';
import {
  voiceSettingsParse,
  type VoiceSettings,
} from '@/sync/domains/settings/voiceSettings';
import {
  OPENAI_REALTIME_DEFAULT_SETTINGS,
} from '../../../../../../../packages/plugins/openai/src/protocol/voice/settings';

import { installVoiceSettingsRouteModuleMocks } from './voiceSettingsRouteTestHelpers';
import { createDefaultVoiceProviderRegistry } from '@/voice/registry/defaultRegistry';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const OPENAI_PROVIDER_ID = 'happier.voice.openai/realtime-openai';
const routeState = vi.hoisted(() => ({
  voice: null as VoiceSettings | null,
  writes: [] as VoiceSettings[],
}));

installVoiceSettingsRouteModuleMocks();

vi.mock('@/voice/settings/useVoiceSettingsMutable', () => ({
  useVoiceSettingsMutable: () => [routeState.voice, (next: VoiceSettings) => routeState.writes.push(next)],
}));

vi.mock('@/hooks/server/useHappierVoiceSupport', () => ({
  useHappierVoiceSupport: () => true,
}));

vi.mock('@/constants/Languages', () => ({
  LANGUAGES: [],
}));

vi.mock('@/voice/settings/panels/LocalDirectSection', () => ({
  LocalDirectSection: () => null,
}));

vi.mock('@/voice/settings/panels/LocalConversationSection', () => ({
  LocalConversationSection: () => null,
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

beforeEach(() => {
  routeState.writes = [];
  routeState.voice = voiceSettingsParse({
    providerId: OPENAI_PROVIDER_ID,
    providers: {
      [OPENAI_PROVIDER_ID]: {
        schemaVersion: 1,
        config: OPENAI_REALTIME_DEFAULT_SETTINGS,
      },
    },
  });
});

afterEach(() => {
  routeState.voice = null;
  standardCleanup();
});

describe('VoiceSettingsScreen OpenAI settings composition', () => {
  it('renders exactly one Turn detection control from the public manifest settings', async () => {
    const VoiceSettingsScreen = (await import('@/voice/settings/screens/VoiceConversationsSettingsScreen')).VoiceConversationsSettingsScreen;
    const screen = await renderSettingsView(<VoiceSettingsScreen />);
    const dropdowns = screen.tree.findAllByType('DropdownMenu' as never);

    expect(createDefaultVoiceProviderRegistry().get(OPENAI_PROVIDER_ID)?.providerSettings?.presentation).toMatchObject({
      fields: expect.arrayContaining([expect.objectContaining({ kind: 'select', path: 'turnDetection' })]),
    });
    const turnDetectionControls = dropdowns.filter((dropdown) => (
        dropdown.props.itemTrigger?.title === 'Turn detection'
        ||
        dropdown.props.testID === 'voice-realtime-field-turnDetection'
    ));
    expect(turnDetectionControls).toHaveLength(1);
    await act(async () => turnDetectionControls[0].props.onSelect('manual'));
    expect(routeState.writes.at(-1)?.providers[OPENAI_PROVIDER_ID]?.config).toMatchObject({ turnDetection: 'manual' });
  });
});
