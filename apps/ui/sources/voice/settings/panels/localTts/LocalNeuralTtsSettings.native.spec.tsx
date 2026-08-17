import React from 'react';
import { act, ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { pressTestInstanceAsync, renderScreen } from '@/dev/testkit';
import { installLocalTtsCommonModuleMocks } from './localTtsTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const modalAlertSpy = vi.fn();
const prepareModelSpy = vi.fn(async (..._args: any[]) => {});
const cancelPrepareSpy = vi.fn();
const localModelPackState = vi.hoisted(() => ({
  modelStatus: 'idle' as 'idle' | 'downloading' | 'ready' | 'error',
}));
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
    modelStatus: localModelPackState.modelStatus,
    downloadProgress: null,
    downloadDetail: null,
    installed: false,
    installSummary: null,
    updateCheckedRemote: null,
    refreshInstallState: vi.fn(async () => {}),
    prepareModel: prepareModelSpy,
    cancelPrepare: cancelPrepareSpy,
    clearAssets: vi.fn(),
    checkForUpdates: vi.fn(),
    };
  },
}));

vi.mock('@/voice/settings/panels/modelCatalog/DaemonModelPackRow', () => ({
  SelectedDaemonModelPackRow: (props: any) => React.createElement('DaemonModelSection', props),
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

function expectAtLeast44PointTarget(style: unknown): void {
  const flattened = (Array.isArray(style) ? style : [style]).reduce<Record<string, unknown>>(
    (result, entry) => entry && typeof entry === 'object' ? { ...result, ...entry } : result,
    {},
  );
  const width = Math.max(
    typeof flattened.width === 'number' ? flattened.width : 0,
    typeof flattened.minWidth === 'number' ? flattened.minWidth : 0,
  );
  const height = Math.max(
    typeof flattened.height === 'number' ? flattened.height : 0,
    typeof flattened.minHeight === 'number' ? flattened.minHeight : 0,
  );
  expect(width).toBeGreaterThanOrEqual(44);
  expect(height).toBeGreaterThanOrEqual(44);
}

type AccessoryButtonProps = {
  accessibilityRole?: string;
  accessibilityLabel?: string;
  style?: unknown;
  onPress: (event: { stopPropagation?: () => void }) => void;
};

function requireAccessoryButton(node: unknown): React.ReactElement<AccessoryButtonProps> {
  if (!React.isValidElement<AccessoryButtonProps>(node)) {
    throw new Error('Expected an accessory button element');
  }
  return node;
}

describe('LocalNeuralTtsSettings (native)', () => {
  beforeEach(() => {
    modalAlertSpy.mockClear();
    prepareModelSpy.mockClear();
    cancelPrepareSpy.mockClear();
    localModelPackState.modelStatus = 'idle';
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

  it('passes the published canonical Kokoro manifest URL to model-pack state', async () => {
    const { LocalNeuralTtsSettings } = await import('./LocalNeuralTtsSettings.native');

    await renderScreen(React.createElement(LocalNeuralTtsSettings, {
      cfgKokoro: { model: 'kokoro', assetId: null, voiceId: null, speed: null, execution: 'auto' },
      setKokoro: vi.fn(),
      networkTimeoutMs: 1000,
      popoverBoundaryRef: null,
    }));

    expect(modelPackStateParamsSpy).toHaveBeenCalledWith(expect.objectContaining({
      packId: 'kokoro-82m-v1.0-onnx-q8-wasm',
      manifestUrl: 'https://example.com/kokoro-82m-v1.0-onnx-q8-wasm.json',
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
    expect(daemonModelSection.props.packId).toBe('kokoro-82m-v1.0-onnx-q8-wasm');
    expect(modelPackStateParamsSpy).toHaveBeenCalledWith(expect.objectContaining({
      packId: 'kokoro-82m-v1.0-onnx-q8-wasm',
    }));
  });

  it('keeps download cancellation outside the model row with named 44pt button semantics', async () => {
    localModelPackState.modelStatus = 'downloading';
    const { LocalNeuralTtsSettings } = await import('./LocalNeuralTtsSettings.native');
    const setKokoro = vi.fn();

    const { tree } = await renderScreen(<LocalNeuralTtsSettings
      cfgKokoro={{ model: 'kokoro', assetId: null, voiceId: null, speed: null, execution: 'device' }}
      setKokoro={setKokoro}
      networkTimeoutMs={1000}
      popoverBoundaryRef={null}
    />);

    const modelRow = tree.root.findAll((node) => (
      node.props.title === 'settingsVoice.local.kokoro.model.title'
      && typeof node.props.onPress === 'function'
      && node.props.rightElement !== undefined
    ))[0];
    expect(modelRow).toBeTruthy();
    expect(modelRow?.props.rightElementOutsidePressable).toBe(true);

    const cancelButton = requireAccessoryButton(modelRow?.props.rightElement);
    expect(cancelButton.props.accessibilityRole).toBe('button');
    expect(cancelButton.props.accessibilityLabel).toBe('common.cancel');
    expectAtLeast44PointTarget(cancelButton.props.style);

    const stopPropagation = vi.fn();
    await act(async () => {
      cancelButton.props.onPress({ stopPropagation });
    });
    expect(stopPropagation).toHaveBeenCalledOnce();
    expect(cancelPrepareSpy).toHaveBeenCalledOnce();
    expect(prepareModelSpy).not.toHaveBeenCalled();
    expect(setKokoro).not.toHaveBeenCalled();
  });

  it('keeps voice preview outside the selectable row with named 44pt button semantics', async () => {
    const { LocalNeuralTtsSettings } = await import('./LocalNeuralTtsSettings.native');
    const setKokoro = vi.fn();
    const { tree } = await renderScreen(<LocalNeuralTtsSettings
      cfgKokoro={{ model: 'kokoro', assetId: null, voiceId: null, speed: null, execution: 'device' }}
      setKokoro={setKokoro}
      networkTimeoutMs={1000}
      popoverBoundaryRef={null}
    />);

    const voiceMenu = tree.root.findAllByType('DropdownMenu')
      .find((node) => node.props.itemTrigger?.title === 'settingsVoice.local.kokoro.voice.title');
    expect(voiceMenu?.props.itemRowProps).toEqual(expect.objectContaining({
      rightElementOutsidePressable: true,
    }));

    const accessory = await renderScreen(voiceMenu?.props.items[0].rightElement);
    const previewButton = accessory.tree.root.findByType('Pressable');
    expect(previewButton.props.accessibilityRole).toBe('button');
    expect(previewButton.props.accessibilityLabel).toBe('settingsVoice.realtimeProviders.catalog.preview');
    expectAtLeast44PointTarget(previewButton.props.style);

    const stopPropagation = vi.fn();
    await act(async () => {
      previewButton.props.onPress({ stopPropagation });
    });
    expect(stopPropagation).toHaveBeenCalledOnce();
    expect(setKokoro).not.toHaveBeenCalled();
  });
});
