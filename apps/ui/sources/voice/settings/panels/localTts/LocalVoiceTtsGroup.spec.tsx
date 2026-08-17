import React from 'react';
import { act, ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { pressTestInstanceAsync, renderScreen } from '@/dev/testkit';
import { voiceSettingsDefaults } from '@/sync/domains/settings/voiceSettings';
import { installLocalTtsCommonModuleMocks } from './localTtsTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installLocalTtsCommonModuleMocks();

const providerTestSpy = vi.fn();
const primeWebAudioPlaybackSpy = vi.fn();

vi.mock('@expo/vector-icons', () => ({
  Ionicons: 'Ionicons',
}));

vi.mock('@/components/ui/lists/Item', () => ({
  Item: (props: any) => React.createElement('Item', props),
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
  ItemGroup: (props: any) => React.createElement('ItemGroup', props, props.children),
}));

vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
  DropdownMenu: (props: any) =>
    React.createElement(
      'DropdownMenu',
      props,
      typeof props.trigger === 'function' ? props.trigger({ open: false, toggle: () => {} }) : props.trigger,
    ),
}));

vi.mock('@/components/ui/forms/Switch', () => ({
  Switch: (props: any) => React.createElement('Switch', props),
}));

vi.mock('@/voice/settings/panels/localTts/providers/registry', () => ({
  useLocalTtsProviderSpecs: () => [{ id: 'local_neural', title: 'Local neural', subtitle: '', iconName: 'sparkle' }],
  getLocalTtsProviderSpec: () => ({
    id: 'local_neural',
    title: 'Local neural',
    subtitle: '',
    iconName: 'sparkle',
    Settings: () => null,
    test: (...args: any[]) => providerTestSpy(...args),
  }),
}));

vi.mock('@/voice/local/formatVoiceTestFailureMessage', () => ({
  formatVoiceTestFailureMessage: (_title: string, err: unknown) => String((err as any)?.message ?? err),
}));

vi.mock('@/voice/output/webAudioContext', () => ({
  primeWebAudioPlayback: () => primeWebAudioPlaybackSpy(),
}));

describe('LocalVoiceTtsGroup', () => {
  beforeEach(() => {
    providerTestSpy.mockReset();
    primeWebAudioPlaybackSpy.mockReset();
  });

  it('uses the localized row titles as the accessible names for both switches', async () => {
    const { LocalVoiceTtsGroup } = await import('./LocalVoiceTtsGroup');
    const screen = await renderScreen(React.createElement(LocalVoiceTtsGroup, {
      cfgTts: {
        provider: 'local_neural',
        autoSpeakReplies: false,
        bargeInEnabled: false,
        localNeural: { model: 'kokoro', assetId: null, voiceId: null, speed: null, execution: 'auto' },
        openaiCompat: { baseUrl: null, apiKey: null, model: null, voice: null, format: null },
        googleCloud: null,
      } as any,
      setTts: vi.fn(),
      voice: voiceSettingsDefaults,
      setVoice: vi.fn(),
      networkTimeoutMs: 15000,
      popoverBoundaryRef: null,
    }));

    const switchRows = screen.tree.root.findAllByType('Item' as any)
      .filter((row) => row.props.rightElement?.props?.accessibilityLabel !== undefined);
    expect(switchRows.map((row) => ({
      title: row.props.title,
      accessibilityLabel: row.props.rightElement.props.accessibilityLabel,
    }))).toEqual([
      {
        title: 'settingsVoice.local.autoSpeak',
        accessibilityLabel: 'settingsVoice.local.autoSpeak',
      },
      {
        title: 'settingsVoice.local.bargeIn',
        accessibilityLabel: 'settingsVoice.local.bargeIn',
      },
    ]);
  });

  it('shows a speaking status while test is running', async () => {
    let resolve!: () => void;
    providerTestSpy.mockImplementationOnce(() => new Promise<void>((r) => { resolve = r; }));

    const { LocalVoiceTtsGroup } = await import('./LocalVoiceTtsGroup');

    let tree!: ReactTestRenderer;
    tree = (await renderScreen(React.createElement(LocalVoiceTtsGroup, {
          cfgTts: {
            provider: 'local_neural',
            autoSpeakReplies: false,
            bargeInEnabled: false,
            localNeural: { model: 'kokoro', assetId: null, voiceId: null, speed: null, execution: 'auto' },
            openaiCompat: { baseUrl: null, apiKey: null, model: null, voice: null, format: null },
            googleCloud: null,
          } as any,
          setTts: vi.fn(),
          voice: voiceSettingsDefaults,
          setVoice: vi.fn(),
          networkTimeoutMs: 15000,
          popoverBoundaryRef: null,
        }))).tree;

    const getTestItem = () =>
      tree.root
        .findAll((n) => n.props?.title === 'settingsVoice.local.testTts')
        .find((n) => typeof n.props?.onPress === 'function')!;

    expect(getTestItem().props.detail).toBe('common.none');

    await act(async () => {
      await pressTestInstanceAsync(getTestItem());
    });
    await act(async () => {});

    expect(primeWebAudioPlaybackSpy).toHaveBeenCalledTimes(1);
    expect(getTestItem().props.detail).toBe('settingsVoice.local.speaking');

    await act(async () => {
      resolve();
    });
    await act(async () => {});

    expect(getTestItem().props.detail).toBe('common.none');
  });
});
