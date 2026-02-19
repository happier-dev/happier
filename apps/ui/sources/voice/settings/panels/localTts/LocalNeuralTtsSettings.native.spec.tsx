import React from 'react';
import renderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const modalAlertSpy = vi.fn();
const prepareModelSpy = vi.fn(async (..._args: any[]) => {});

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
    alert: (...args: any[]) => modalAlertSpy(...args),
  },
}));

vi.mock('@/components/ui/lists/Item', () => ({
  Item: (props: any) => React.createElement('Item', props),
}));

vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
  DropdownMenu: (props: any) =>
    React.createElement(
      'DropdownMenu',
      props,
      typeof props.trigger === 'function' ? props.trigger({ open: false, toggle: () => {} }) : props.trigger,
    ),
}));

vi.mock('@/voice/kokoro/runtime/kokoroSupport', () => ({
  isKokoroRuntimeSupported: () => false,
}));

vi.mock('@/voice/modelPacks/manifests', () => ({
  resolveModelPackManifestUrl: () => 'https://example.com/manifest.json',
}));

vi.mock('./useLocalNeuralModelPackState.native', () => ({
  useLocalNeuralModelPackState: () => ({
    modelStatus: 'idle',
    downloadProgress: null,
    downloadDetail: null,
    installed: false,
    installSummary: null,
    updateCheckedRemote: null,
    refreshInstallState: vi.fn(async () => {}),
    prepareModel: prepareModelSpy,
    cancelPrepare: vi.fn(),
    clearAssets: vi.fn(),
    checkForUpdates: vi.fn(),
  }),
}));

vi.mock('./useLocalNeuralKokoroVoiceCatalog.native', () => ({
  useLocalNeuralKokoroVoiceCatalog: () => [{ id: 'af_heart', title: 'Heart' }],
}));

vi.mock('@/voice/kokoro/assets/kokoroAssetSets', () => ({
  getKokoroAssetSetOptions: () => [{ id: 'dummy', title: 'Dummy', subtitle: '' }],
}));

vi.mock('@/voice/output/KokoroTtsController', () => ({
  speakKokoroText: vi.fn(),
}));

vi.mock('@/voice/runtime/VoicePlaybackController', () => ({
  createVoicePlaybackController: () => ({ registerStopper: () => () => {}, interrupt: vi.fn() }),
}));

describe('LocalNeuralTtsSettings (native)', () => {
  beforeEach(() => {
    modalAlertSpy.mockClear();
    prepareModelSpy.mockClear();
  });

  it('blocks model download when runtime is unsupported and surfaces a clear error', async () => {
    const { LocalNeuralTtsSettings } = await import('./LocalNeuralTtsSettings.native');

    let tree!: ReactTestRenderer;
    act(() => {
      tree = renderer.create(
        React.createElement(LocalNeuralTtsSettings, {
          cfgKokoro: { model: 'kokoro', assetId: null, voiceId: null, speed: null },
          setKokoro: vi.fn(),
          networkTimeoutMs: 1000,
          popoverBoundaryRef: null,
        }),
      );
    });
    await act(async () => {});

    const modelItem = tree.root
      .findAll((n) => n.props?.title === 'Kokoro model')
      .find((n) => typeof n.props?.onPress === 'function');
    expect(modelItem).toBeTruthy();

    await act(async () => {
      modelItem!.props.onPress?.();
    });
    await act(async () => {});

    expect(prepareModelSpy).not.toHaveBeenCalled();
    expect(modalAlertSpy).toHaveBeenCalled();
    expect(String(modalAlertSpy.mock.calls[0]?.[1] ?? '')).toContain('Kokoro is not supported');
  });
});
