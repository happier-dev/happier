import React from 'react';
import renderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const providerTestSpy = vi.fn();
const primeWebAudioPlaybackSpy = vi.fn();

vi.mock('react-native-unistyles', () => {
  const theme = { colors: { textSecondary: '#999' } };
  return {
    useUnistyles: () => ({ theme }),
    StyleSheet: {
      create: (factory: any) => (typeof factory === 'function' ? {} : factory),
      absoluteFillObject: {},
    },
  };
});

vi.mock('@expo/vector-icons', () => ({
  Ionicons: 'Ionicons',
}));

vi.mock('@/text', () => ({
  t: (key: string) => key,
}));

vi.mock('@/modal', () => ({
  Modal: {
    prompt: vi.fn(),
    confirm: vi.fn(),
    alert: vi.fn(),
  },
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
  localTtsProviderSpecs: [{ id: 'local_neural', title: 'Local neural', subtitle: '', iconName: 'sparkles-outline' }],
  getLocalTtsProviderSpec: () => ({
    id: 'local_neural',
    title: 'Local neural',
    subtitle: '',
    iconName: 'sparkles-outline',
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

  it('shows a speaking status while test is running', async () => {
    let resolve!: () => void;
    providerTestSpy.mockImplementationOnce(() => new Promise<void>((r) => { resolve = r; }));

    const { LocalVoiceTtsGroup } = await import('./LocalVoiceTtsGroup');

    let tree!: ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(
        React.createElement(LocalVoiceTtsGroup, {
          cfgTts: {
            provider: 'local_neural',
            autoSpeakReplies: false,
            bargeInEnabled: false,
            localNeural: { model: 'kokoro', assetId: null, voiceId: null, speed: null },
            openaiCompat: { baseUrl: null, apiKey: null, model: null, voice: null, format: null },
            googleCloud: null,
          } as any,
          setTts: vi.fn(),
          networkTimeoutMs: 15000,
          popoverBoundaryRef: null,
        }),
      );
    });

    const getTestItem = () =>
      tree.root
        .findAll((n) => n.props?.title === 'settingsVoice.local.testTts')
        .find((n) => typeof n.props?.onPress === 'function')!;

    expect(getTestItem().props.detail).toBe('—');

    await act(async () => {
      getTestItem().props.onPress?.();
    });
    await act(async () => {});

    expect(primeWebAudioPlaybackSpy).toHaveBeenCalledTimes(1);
    expect(getTestItem().props.detail).toBe('Speaking…');

    await act(async () => {
      resolve();
    });
    await act(async () => {});

    expect(getTestItem().props.detail).toBe('—');
  });
});
