import React from 'react';
import { act, ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { pressTestInstanceAsync, renderScreen } from '@/dev/testkit';
import { installLocalTtsCommonModuleMocks } from './localTtsTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const modalAlertSpy = vi.fn();
const prepareModelSpy = vi.fn(async (..._args: any[]) => {});
installLocalTtsCommonModuleMocks({
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({
            spies: {
                alert: (...args: any[]) => modalAlertSpy(...args),
            },
        }).module;
    },
});

vi.mock('@expo/vector-icons', () => ({
  Ionicons: 'Ionicons',
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
    tree = (await renderScreen(React.createElement(LocalNeuralTtsSettings, {
          cfgKokoro: { model: 'kokoro', assetId: null, voiceId: null, speed: null },
          setKokoro: vi.fn(),
          networkTimeoutMs: 1000,
          popoverBoundaryRef: null,
        }))).tree;
    await act(async () => {});

    const modelItem = tree.root
      .findAll((n) => n.props?.title === 'settingsVoice.local.kokoro.model.title')
      .find((n) => typeof n.props?.onPress === 'function');
    expect(modelItem).toBeTruthy();

    await act(async () => {
      await pressTestInstanceAsync(modelItem!);
    });
    await act(async () => {});

    expect(prepareModelSpy).not.toHaveBeenCalled();
    expect(modalAlertSpy).toHaveBeenCalled();
    expect(modalAlertSpy.mock.calls[0]?.[1]).toBe('settingsVoice.local.kokoro.alerts.runtimeUnsupported.body');
  });
});
