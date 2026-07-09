import React from 'react';
import { act, ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { pressTestInstanceAsync, renderScreen } from '@/dev/testkit';
import { installLocalTtsCommonModuleMocks } from './localTtsTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const modalAlertSpy = vi.fn();
const prepareModelSpy = vi.fn(async (..._args: any[]) => {});
const modelPackStateParamsSpy = vi.hoisted(() => vi.fn());
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
  resolveModelPackManifestUrl: (params: any) => `https://example.com/${params.packId}.json`,
}));

vi.mock('./useLocalNeuralModelPackState.native', () => ({
  useLocalNeuralModelPackState: (params: any) => {
    modelPackStateParamsSpy(params);
    return {
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
    };
  },
}));

vi.mock('@/voice/settings/panels/daemonInference/DaemonVoiceInferenceModelSection', () => ({
  DaemonVoiceInferenceModelSection: (props: any) => React.createElement('DaemonModelSection', props),
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

vi.mock('@/voice/runtime/playback/VoicePlaybackController', () => ({
  createVoicePlaybackController: () => ({ registerStopper: () => () => {}, interrupt: vi.fn() }),
}));

describe('LocalNeuralTtsSettings (native)', () => {
  beforeEach(() => {
    modalAlertSpy.mockClear();
    prepareModelSpy.mockClear();
    modelPackStateParamsSpy.mockClear();
  });

  it('blocks model download when runtime is unsupported and surfaces a clear error', async () => {
    const { LocalNeuralTtsSettings } = await import('./LocalNeuralTtsSettings.native');

    let tree!: ReactTestRenderer;
    tree = (await renderScreen(React.createElement(LocalNeuralTtsSettings, {
          cfgKokoro: { model: 'kokoro', assetId: null, voiceId: null, speed: null, execution: 'auto' },
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

  it('uses the canonical Kokoro model-pack id for native model state when no asset id is stored', async () => {
    const { LocalNeuralTtsSettings } = await import('./LocalNeuralTtsSettings.native');

    await renderScreen(React.createElement(LocalNeuralTtsSettings, {
      cfgKokoro: { model: 'kokoro', assetId: null, voiceId: null, speed: null, execution: 'auto' },
      setKokoro: vi.fn(),
      networkTimeoutMs: 1000,
      popoverBoundaryRef: null,
    }));

    expect(modelPackStateParamsSpy).toHaveBeenCalledWith(expect.objectContaining({
      packId: 'kokoro-tts-en-v1',
      manifestUrl: 'https://example.com/kokoro-tts-en-v1.json',
    }));
  });

  it('normalizes legacy Kokoro ids before rendering the daemon model section', async () => {
    const { LocalNeuralTtsSettings } = await import('./LocalNeuralTtsSettings.native');

    const tree = (await renderScreen(React.createElement(LocalNeuralTtsSettings, {
      cfgKokoro: {
        model: 'kokoro',
        assetId: 'kokoro-82m-v1.0-onnx-q8-wasm',
        voiceId: 'af_heart',
        speed: 1,
        execution: 'daemon',
      },
      setKokoro: vi.fn(),
      networkTimeoutMs: 1000,
      popoverBoundaryRef: null,
    }))).tree;

    const daemonModelSection = tree.root.findByType('DaemonModelSection');
    expect(daemonModelSection.props.packId).toBe('kokoro-tts-en-v1');
    expect(modelPackStateParamsSpy).toHaveBeenCalledWith(expect.objectContaining({
      packId: 'kokoro-tts-en-v1',
    }));
  });
});
