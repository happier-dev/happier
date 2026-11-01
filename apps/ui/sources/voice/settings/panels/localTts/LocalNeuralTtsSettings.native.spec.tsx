import React from 'react';
import { act, ReactTestRenderer } from 'react-test-renderer';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { createVoiceSpeechOutputBoundary } from '@/dev/testkit/harness/voiceSpeechOutputBoundary';
import { settingsParse } from '@/sync/domains/settings/settings';
import { readLocalConversationVoiceSettings, voiceSettingsParse, writeLocalConversationVoiceSettings } from '@/sync/domains/settings/voiceSettings';
import { pressTestInstanceAsync, renderScreen, waitForTestEvent } from '@/dev/testkit';
import { DaemonVoiceModelCatalogProvider } from '@/voice/settings/panels/modelCatalog/DaemonVoiceModelCatalogContext';
import { DaemonVoiceInferenceModelStatusSchema, DaemonVoiceInferenceModelsListResponseSchema,
  DaemonVoiceInferenceModelsStatusResponseSchema } from '@happier-dev/protocol/daemon/voiceInference';
import { createDeferred, createMachineFixture } from '@/dev/testkit';
import { parseModelPackManifest } from '@happier-dev/protocol/voice/modelPacks/manifest';
import { KOKORO_DEFAULT_TTS_PACK_ID } from '@happier-dev/protocol/voice/modelPacks/catalog';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';


let account: Awaited<ReturnType<typeof import('../voiceSettingsAccountTestHarness')['createVoiceSettingsAccountTestHarness']>> | null = null;
const boundary = createVoiceSpeechOutputBoundary({ getAccount: async () => {
  if (!account) throw new Error('Device samples must not issue daemon RPC');
  const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
  return { home: { id: account.scope.serverId, serverUrl: getActiveServerSnapshot().serverUrl }, credentials: account.credentials };
} });
let filesystem: ReturnType<typeof boundary.reset>['filesystem'];
const sherpa = boundary.native;
// Settings never starts the unavailable vendor conversation SDK in this Node harness.
vi.mock('@elevenlabs/client/web', () => ({ Conversation: { startSession: () => { throw new Error('Unexpected ElevenLabs conversation start'); } } }));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());

vi.mock('@expo/vector-icons', () => ({
  Ionicons: 'Ionicons',
}));

// Load the real settings owner during collection; a cold graph import is not playback behavior.
const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
const { SelectedDaemonModelPackRow } = await import('@/voice/settings/panels/modelCatalog/DaemonModelPackRow');
const { LocalNeuralTtsSettings } = await import('./LocalNeuralTtsSettings.native');
const { localNeuralTtsPreviewController } = await import('./providers/localNeural/previewLocalNeuralTts');
const { invokeVoiceSettingsOperation } = await import('@/voice/settings/voiceSettingsOperationInvoker');
const { useDaemonVoiceModelCatalogState } = await import('@/voice/settings/panels/modelCatalog/useDaemonVoiceModelCatalogState');
const { t, getPreferredLanguage, setPreferredLanguageFromSettings } = await import('@/text');
const { Alert } = await import('react-native');
const initialLanguage = getPreferredLanguage();

const searchParams = vi.hoisted(() => ({ value: {} as Record<string, string> }));
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({ params: () => searchParams.value }).module);
const { LocalNeuralTtsSettings: WebSettings } = await import('./LocalNeuralTtsSettings.web');

const previewConfig = { model: 'kokoro' as const, assetId: null, voiceId: 'af_heart', speed: 1, execution: 'device' as const };
function startActionPreview() {
  const voice = voiceSettingsParse({ providerId: 'local_conversation' });
  const local = readLocalConversationVoiceSettings(voice);
  const settings = settingsParse({ voice: writeLocalConversationVoiceSettings(voice, {
    ...local, tts: { ...local.tts, provider: 'local_neural', localNeural: previewConfig },
  }) });
  return invokeVoiceSettingsOperation('tts_preview', 'conversation', {
    input: { kind: 'voice_preview', voiceId: 'af_heart' }, isCurrent: () => true,
    readSettings: async () => settings, mutateSettings: async () => { throw new Error('Preview must not change settings'); },
  });
}
async function ensurePreviewAccount() {
  if (!account) {
    const { createVoiceSettingsAccountTestHarness } = await import('../voiceSettingsAccountTestHarness');
    const voice = voiceSettingsParse({ providerId: 'local_conversation' });
    const local = readLocalConversationVoiceSettings(voice);
    account = await createVoiceSettingsAccountTestHarness(settingsParse({ voice: writeLocalConversationVoiceSettings(voice, {
      ...local, tts: { ...local.tts, provider: 'local_neural', localNeural: previewConfig },
    }), actionsSettingsV1: { v: 1, approvalWaivedSurfaces: { 'settings.invoke': ['ui'] } } }));
  }
}
async function mountPreviewPicker() {
  await ensurePreviewAccount();
  const screen = await renderScreen(<LocalNeuralTtsSettings cfgKokoro={previewConfig} setKokoro={vi.fn()} networkTimeoutMs={1000} />);
  const menu = () => screen.tree.root.findAllByType(DropdownMenu)
    .find(node => node.props.itemTrigger?.title === t('settingsVoice.local.kokoro.voice.title'))!;
  const sampleButton = () => {
    const accessory = menu().props.items[0].rightElement as React.ReactElement<{
      children: React.ReactElement<{ onPress: () => void }>;
    }>;
    return accessory.props.children;
  };
  await waitForTestEvent(screen.subscribe, () => menu().props.items, items => items.length === 1);
  expect(menu().props.items).toHaveLength(1);
  return { screen, menu, sampleButton };
}

describe('LocalNeuralTtsSettings (native)', () => {
  beforeEach(async () => {
    ({ filesystem } = boundary.reset());
    boundary.platform.value = 'ios';
    setPreferredLanguageFromSettings('en');
    const manifest = parseModelPackManifest({ packId: KOKORO_DEFAULT_TTS_PACK_ID, kind: 'tts_sherpa', model: 'kokoro', version: '1',
      frontend: { lang: 'en' }, voices: [{ id: 'af_heart', title: 'Heart', sid: 0 }], defaultVoiceId: 'af_heart',
      files: [{ path: 'model.onnx', url: 'https://example.test/model.onnx', sha256: 'a'.repeat(64), sizeBytes: 1 }] });
    filesystem.files.set(`${filesystem.root}/${manifest.packId}/pack.json`, new TextEncoder().encode(JSON.stringify({ manifest })));
    sherpa.initialize.mockClear();
    localNeuralTtsPreviewController.stop();
  });
  afterEach(async () => {
    await act(async () => { localNeuralTtsPreviewController.stop(); });
    boundary.disposeNativeSdkBridge();
    vi.unstubAllGlobals();
    await account?.dispose();
    account = null;
  });
  afterAll(async () => { await boundary.disposeAudioSession(); setPreferredLanguageFromSettings(initialLanguage); });

  it.each([['web', WebSettings], ['native', LocalNeuralTtsSettings]] as const)('reveals the requested voice selector on %s', async (_platform, Settings) => {
    searchParams.value = { setting: 'voiceConversations.ttsVoiceId' };
    const screen = await renderScreen(<Settings cfgKokoro={previewConfig} setKokoro={vi.fn()} networkTimeoutMs={1000} />);
    expect(screen.findAll(node => typeof node.type === 'string' && node.props.nativeID === 'setting-voiceConversations.ttsVoiceId')).toHaveLength(1);
    expect(screen.findByTestId('setting-reveal.voiceConversations.ttsVoiceId')).not.toBeNull();
    searchParams.value = {};
  });

  it('honors disabled Settings Action admission for a native picker preview press', async () => {
    const { menu, sampleButton } = await mountPreviewPicker();
    account!.replaceSettings(settingsParse({ ...account!.settings, actionsSettingsV1: { v: 1,
      actions: { 'settings.invoke': { enabled: false } } } }));
    await act(async () => { menu().props.onOpenChange(true); sampleButton().props.onPress(); });
    expect(localNeuralTtsPreviewController.read()).toBeNull();
    expect(sherpa.initialize).not.toHaveBeenCalled();
  });

  it.each(['pending', 'active'] as const)('leaves another caller’s %s sample current with the menu closed and after unmount', async phase => {
    const { screen, menu } = await mountPreviewPicker();
    const initialization = createDeferred<void>();
    const initializationStarted = createDeferred<void>();
    if (phase === 'pending') sherpa.initialize.mockImplementationOnce(() => {
      initializationStarted.resolve();
      return initialization.promise;
    });
    const finishPlayback = boundary.holdNextPlayback('encoded');
    let operation!: ReturnType<typeof invokeVoiceSettingsOperation>;
    await act(async () => {
      operation = startActionPreview();
      await (phase === 'pending' ? initializationStarted.promise : finishPlayback.started);
    });
    expect(phase === 'pending' ? sherpa.initialize : boundary.encodedAudio.start).toHaveBeenCalledOnce();
    expect(menu().props.open).toBe(false);
    expect(localNeuralTtsPreviewController.read()).toBe('af_heart');
    await screen.unmount();
    expect(localNeuralTtsPreviewController.read()).toBe('af_heart');
    expect(sherpa.cancelInitialization).not.toHaveBeenCalled();
    expect(boundary.encodedAudio.stop).not.toHaveBeenCalled();
    if (phase === 'pending') {
      initialization.resolve();
      await finishPlayback.started;
      expect(boundary.encodedAudio.start).toHaveBeenCalledOnce();
    }
    await finishPlayback.started;
    finishPlayback();
    expect(await operation).toMatchObject({ status: 'completed' });
    expect(localNeuralTtsPreviewController.read()).toBeNull();
    expect([...filesystem.files.keys()].filter(uri => uri.startsWith('file:///cache/'))).toEqual([]);
    expect(boundary.getAudioSessionCoordinator().getSnapshot().leaseCount).toBe(0);
  });

  it.each(['close', 'unmount'] as const)('retires only its own pending sample on picker %s, including late playback', async retirement => {
    const synthesis = createDeferred<void>();
    const synthesisStarted = createDeferred<void>();
    const outputRemoved = createDeferred<void>();
    let outputUri = '';
    let heldJobId = '';
    const deleteFile = filesystem.files.delete.bind(filesystem.files);
    const deletion = vi.spyOn(filesystem.files, 'delete').mockImplementation(uri => {
      const result = deleteFile(uri);
      if (uri === outputUri) outputRemoved.resolve();
      return result;
    });
    sherpa.synthesizeToWavFile.mockImplementationOnce(async input => {
      heldJobId = input.jobId;
      synthesisStarted.resolve();
      await synthesis.promise;
      if (!input.outWavPath) throw new Error('Expected native output path');
      outputUri = `file://${input.outWavPath}`;
      filesystem.files.set(outputUri, new Uint8Array([1, 2]));
      return { wavPath: input.outWavPath, sampleRate: 24_000 };
    });
    const { screen, menu, sampleButton } = await mountPreviewPicker();
    await act(async () => { menu().props.onOpenChange(true); });
    await act(async () => { sampleButton().props.onPress(); });
    expect(localNeuralTtsPreviewController.read()).toBe('af_heart');
    await synthesisStarted.promise;
    expect(heldJobId).not.toBe('');
    if (retirement === 'close') await act(async () => { menu().props.onOpenChange(false); });
    else await screen.unmount();
    expect(sherpa.cancel).toHaveBeenCalledWith({ jobId: heldJobId });
    expect(localNeuralTtsPreviewController.read()).toBeNull();
    await act(async () => { synthesis.resolve(); });
    await outputRemoved.promise;
    expect(filesystem.files.has(outputUri)).toBe(false);
    deletion.mockRestore();
    expect(boundary.encodedAudio.start).not.toHaveBeenCalled();
  });

  it('preserves a replacement Action sample when the picker closes and its old sample settles late', async () => {
    const synthesis = createDeferred<void>();
    const synthesisStarted = createDeferred<void>();
    let heldJobId = '';
    sherpa.synthesizeToWavFile.mockImplementationOnce(async input => {
      heldJobId = input.jobId;
      synthesisStarted.resolve();
      await synthesis.promise;
      if (!input.outWavPath) throw new Error('Expected native output path');
      filesystem.files.set(`file://${input.outWavPath}`, new Uint8Array([1, 2]));
      return { wavPath: input.outWavPath, sampleRate: 24_000 };
    });
    const { screen, menu, sampleButton } = await mountPreviewPicker();
    await act(async () => { menu().props.onOpenChange(true); });
    await act(async () => { sampleButton().props.onPress(); });
    await synthesisStarted.promise;
    expect(heldJobId).not.toBe('');
    const finishPlayback = boundary.holdNextPlayback('encoded');
    let replacement!: ReturnType<typeof invokeVoiceSettingsOperation>;
    await act(async () => {
      replacement = startActionPreview();
      await finishPlayback.started;
      expect(boundary.encodedAudio.start).toHaveBeenCalledOnce();
      menu().props.onOpenChange(false);
    });
    await screen.unmount();
    await act(async () => { synthesis.resolve(); });
    expect(sherpa.cancel).toHaveBeenCalledWith({ jobId: heldJobId });
    expect(localNeuralTtsPreviewController.read()).toBe('af_heart');
    expect(boundary.encodedAudio.stop).not.toHaveBeenCalled();
    await finishPlayback.started;
    finishPlayback();
    expect(await replacement).toMatchObject({ status: 'completed' });
    expect(localNeuralTtsPreviewController.read()).toBeNull();
    expect(boundary.getAudioSessionCoordinator().getSnapshot().leaseCount).toBe(0);
  });

  it('reflects and stops the shared preview attempt instead of keeping an independent mounted player', async () => {
    await ensurePreviewAccount();
    const { isKokoroRuntimeSupported } = await import('@/voice/kokoro/runtime/kokoroSupport');
    expect(isKokoroRuntimeSupported()).toBe(true);
    const { localNeuralTtsPreviewController } = await import('./providers/localNeural/previewLocalNeuralTts');
    const { tree } = await renderScreen(<LocalNeuralTtsSettings
      cfgKokoro={{ model: 'kokoro', assetId: null, voiceId: 'af_heart', speed: 1, execution: 'device' }}
      setKokoro={vi.fn()}
      networkTimeoutMs={1000}
    />);
    const menu = tree.root.findAll((node) => node.props.itemTrigger?.title === t('settingsVoice.local.kokoro.voice.title')
      && typeof node.props.onOpenChange === 'function')[0];
    expect(menu).toBeDefined();
    await act(async () => { menu!.props.onOpenChange(true); });
    const finishPlayback = boundary.holdNextPlayback('encoded');
    let operation!: ReturnType<typeof invokeVoiceSettingsOperation>;
    await act(async () => {
      operation = startActionPreview();
      await finishPlayback.started;
      expect(boundary.encodedAudio.start).toHaveBeenCalledOnce();
    });
    await finishPlayback.started;
    const voiceMenu = () => tree.root.findAll((node) => node.props.itemTrigger?.title === t('settingsVoice.local.kokoro.voice.title')
      && Array.isArray(node.props.items))[0];
    const previewGlyph = () => {
      const accessory = voiceMenu()!.props.items[0].rightElement as React.ReactElement<{ children: React.ReactElement<{ icon: React.ReactElement<{ name: string }> }> }>;
      return accessory.props.children.props.icon.props.name;
    };
    expect(previewGlyph()).toBe('pause-circle');
    const accessory = voiceMenu()!.props.items[0].rightElement as React.ReactElement<{ children: React.ReactElement<{ onPress: () => void }> }>;
    await act(async () => { accessory.props.children.props.onPress(); });
    expect(previewGlyph()).toBe('play');
    expect(await operation).toMatchObject({ status: 'cancelled' });
    expect(boundary.encodedAudio.stop).toHaveBeenCalledOnce();
  });

  it.each([null, 1, Number.NaN])('shows effective default speed for %s and changes it without replacing the selected pack or voice', async (storedSpeed) => {
    const cfgKokoro = { model: 'kokoro' as const, assetId: 'dummy', voiceId: 'af_heart', speed: storedSpeed, execution: 'device' as const };
    const setKokoro = vi.fn();
    const { tree } = await renderScreen(<LocalNeuralTtsSettings
      cfgKokoro={cfgKokoro}
      setKokoro={setKokoro}
      networkTimeoutMs={1000}
    />);
    const speed = tree.root.findAll((node) => node.props.itemTrigger?.title === t('settingsVoice.local.kokoro.speed.title')
      && typeof node.props.onSelect === 'function')[0];
    expect(speed).toBeDefined();
    expect(speed!.props.selectedId).toBe('1');
    expect(setKokoro).not.toHaveBeenCalled();
    await act(async () => { speed!.props.onSelect('1.2'); });
    expect(setKokoro).toHaveBeenCalledWith({ ...cfgKokoro, speed: 1.2 });
  });

  it('blocks model download when runtime is unsupported and surfaces a clear error', async () => {
    await ensurePreviewAccount();
    account!.replaceSettings(settingsParse({ ...account!.settings, actionsSettingsV1: { v: 1,
      actions: { 'settings.invoke': { disabledSurfaces: ['ui'] } } } }));
    const nativeAlert = vi.spyOn(Alert, 'alert');
    nativeAlert.mockClear();
    try {
      boundary.setNativeAvailable(false);
      const fetch = vi.fn();
      vi.stubGlobal('fetch', fetch);
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
        .findAll((n) => n.props?.title === t('settingsVoice.local.kokoro.model.title'))
        .find((n) => typeof n.props?.onPress === 'function');
      expect(modelItem).toBeTruthy();

      await act(async () => {
        await pressTestInstanceAsync(modelItem!);
      });
      await act(async () => {});

      expect(nativeAlert).not.toHaveBeenCalled();
      await act(async () => { account!.replaceSettings(settingsParse({ ...account!.settings, actionsSettingsV1: { v: 1,
        approvalWaivedSurfaces: { 'settings.invoke': ['ui'] } } })); });
      const alerted = createDeferred<void>();
      nativeAlert.mockImplementationOnce(() => alerted.resolve());
      await act(async () => { await pressTestInstanceAsync(modelItem!); });
      await alerted.promise;
      expect(nativeAlert).toHaveBeenCalled();

      expect(fetch).not.toHaveBeenCalled();
      expect(sherpa.initialize).not.toHaveBeenCalled();
      expect(nativeAlert).toHaveBeenCalled();
      expect(nativeAlert.mock.calls[0]?.[1]).toBe(t('settingsVoice.local.kokoro.alerts.runtimeUnsupported.body'));
    } finally {
      nativeAlert.mockRestore();
    }
  });

  it('downloads from the published canonical Kokoro manifest URL through model-pack state', async () => {
    await ensurePreviewAccount();
    filesystem.files.clear();
    const requested = createDeferred<{ url: string; signal: AbortSignal }>();
    vi.stubGlobal('fetch', vi.fn((url: string, options: RequestInit) => new Promise<Response>((_resolve, reject) => {
      if (!options.signal) throw new Error('Expected the installer lifetime signal');
      requested.resolve({ url, signal: options.signal });
      options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    })));
    const { LocalNeuralTtsSettings } = await import('./LocalNeuralTtsSettings.native');

    const screen = await renderScreen(React.createElement(LocalNeuralTtsSettings, {
      cfgKokoro: { model: 'kokoro', assetId: null, voiceId: null, speed: null, execution: 'auto' },
      setKokoro: vi.fn(),
      networkTimeoutMs: 1000,
      popoverBoundaryRef: null,
    }));

    const modelRow = screen.tree.root.findAll(node => node.props.title === t('settingsVoice.local.kokoro.model.title')
      && typeof node.props.onPress === 'function')[0]!;
    let preparing!: Promise<void>;
    await act(async () => { preparing = modelRow.props.onPress(); });
    const request = await requested.promise;
    const url = new URL(request.url);
    expect(`${url.origin}${url.pathname}`).toBe('https://github.com/happier-dev/happier-assets/releases/download/model-packs/kokoro-82m-v1.0-onnx-q8-wasm__manifest.json');
    await screen.unmount();
    // An admitted download belongs to the installer after its settings view detaches.
    expect(request.signal.aborted).toBe(false);
    const { findRunningModelPackInstall } = await import('@/voice/modelPacks/installer.native');
    const running = await findRunningModelPackInstall({ packId: KOKORO_DEFAULT_TTS_PACK_ID });
    expect(running).not.toBeNull();
    const cancellation = new AbortController();
    const settled = running!.follow({ signal: cancellation.signal });
    cancellation.abort();
    await expect(settled).rejects.toThrow();
    await preparing;
    expect(request.signal.aborted).toBe(true);
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

    const daemonModelSection = tree.root.findByType(SelectedDaemonModelPackRow);
    expect(daemonModelSection.props.packId).toBe('kokoro-82m-v1.0-onnx-q8-wasm');
    // A daemon selection does not activate the device installer beneath the real hook.
    expect(sherpa.initialize).not.toHaveBeenCalled();
  });

  it('keeps download cancellation outside the model row with named button semantics', async () => {
    await ensurePreviewAccount();
    filesystem.files.clear();
    const requested = createDeferred<AbortSignal>();
    vi.stubGlobal('fetch', vi.fn((_url: string, options: RequestInit) => new Promise<Response>((_resolve, reject) => {
      if (!options.signal) throw new Error('Expected the installer lifetime signal');
      requested.resolve(options.signal);
      options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    })));
    const { LocalNeuralTtsSettings } = await import('./LocalNeuralTtsSettings.native');
    const setKokoro = vi.fn();

    const { tree } = await renderScreen(<LocalNeuralTtsSettings
      cfgKokoro={{ model: 'kokoro', assetId: null, voiceId: null, speed: null, execution: 'device' }}
      setKokoro={setKokoro}
      networkTimeoutMs={1000}
      popoverBoundaryRef={null}
    />);

    const modelRow = () => tree.root.findAll((node) => (
      node.props.title === t('settingsVoice.local.kokoro.model.title')
      && typeof node.props.onPress === 'function'
      && node.props.rightElement !== undefined
    ))[0];
    let preparing!: Promise<void>;
    await act(async () => { preparing = modelRow()!.props.onPress(); });
    const signal = await requested.promise;
    expect(modelRow()).toBeTruthy();
    expect(modelRow()?.props.rightElementOutsidePressable).toBe(true);

    const cancelButton = tree.root.findAllByProps({ accessibilityLabel: t('common.cancel') })
      .find((node) => String(node.type) === 'Pressable');
    expect(cancelButton).toBeTruthy();
    expect(cancelButton!.props.accessibilityRole).toBe('button');

    const stopPropagation = vi.fn();
    await act(async () => {
      cancelButton!.props.onPress({ stopPropagation });
    });
    expect(stopPropagation).toHaveBeenCalledOnce();
    expect(signal.aborted).toBe(true);
    await act(async () => { await preparing; });
    await waitForTestEvent(tree.subscribe, () => modelRow()?.props.rightElementOutsidePressable, outside => outside === false);
    expect(modelRow()?.props.rightElementOutsidePressable).toBe(false);
    expect(filesystem.files.size).toBe(0);
    expect(sherpa.initialize).not.toHaveBeenCalled();
    expect(setKokoro).not.toHaveBeenCalled();
  });

  it('keeps voice preview outside the selectable row with named button semantics', async () => {
    const { LocalNeuralTtsSettings } = await import('./LocalNeuralTtsSettings.native');
    const setKokoro = vi.fn();
    const { tree } = await renderScreen(<LocalNeuralTtsSettings
      cfgKokoro={{ model: 'kokoro', assetId: null, voiceId: null, speed: null, execution: 'device' }}
      setKokoro={setKokoro}
      networkTimeoutMs={1000}
      popoverBoundaryRef={null}
    />);

    const voiceMenu = tree.root.findAllByType(DropdownMenu)
      .find((node) => node.props.itemTrigger?.title === t('settingsVoice.local.kokoro.voice.title'));
    await waitForTestEvent(tree.subscribe, () => voiceMenu?.props.items, items => items?.length === 1);
    expect(voiceMenu?.props.items).toHaveLength(1);
    expect(voiceMenu?.props.itemRowProps).toEqual(expect.objectContaining({
      rightElementOutsidePressable: true,
    }));

    const accessoryElement = voiceMenu?.props.items[0].rightElement;
    if (!React.isValidElement(accessoryElement)) throw new Error('Expected the native preview accessory');
    const accessory = await renderScreen(accessoryElement);
    const previewButton = accessory.tree.root.findByType('Pressable');
    expect(previewButton.props.accessibilityRole).toBe('button');
    expect(previewButton.props.accessibilityLabel).toBe(t('settingsVoice.realtimeProviders.catalog.preview', { voice: 'Heart' }));

    const stopPropagation = vi.fn();
    await act(async () => {
      previewButton.props.onPress({ stopPropagation });
    });
    expect(stopPropagation).toHaveBeenCalledOnce();
    expect(setKokoro).not.toHaveBeenCalled();
  });

  it('uses daemon status voices and its declared default for daemon execution', async () => {
    const { createVoiceSettingsAccountTestHarness } = await import('../voiceSettingsAccountTestHarness');
    const { storage } = await import('@/sync/domains/state/storage');
    account = await createVoiceSettingsAccountTestHarness(settingsParse({ experiments: true,
      featureToggles: { 'voice.agent': true, 'execution.runs': true, 'voice.daemonInference': true },
      voice: { providerId: 'local_conversation', executionMachine: { mode: 'fixed', machineId: 'tts-machine' } },
    }), { features: createRootLayoutFeaturesResponse({ features: {
      machines: { enabled: true, liveStream: { ...createRootLayoutFeaturesResponse().features.machines.liveStream, enabled: true, serverRouted: { enabled: true } } },
    }, capabilities: { machines: { ...createRootLayoutFeaturesResponse().capabilities.machines, liveStream: { serverRouted: { disabledReason: null, caps: {
      maxBitrateBps: 64_000, maxFramesPerSecond: 50, maxFrameBytes: 16_000, maxDurationMs: 60_000,
      maxTotalBytes: 1_000_000, maxConcurrentStreamsPerAccount: 2, maxConcurrentStreamsPerSocket: 1, maxConcurrentStreamsPerMachine: 1,
    } } } } } }) });
    const accountHttp = account.request.getMockImplementation();
    if (!accountHttp) throw new Error('Account HTTP boundary missing');
    const accountId = account.scope.accountId;
    account.request.mockImplementation(async (url, init) => boundary.answerMachineHttpRequest(url, 'tts-machine', accountId, init)
      ?? accountHttp(url, init));
    const machine = createMachineFixture({ id: 'tts-machine', activeAt: Date.now() });
    storage.getState().applyMachines([machine], true, { sourceServerId: account.scope.serverId });
    const status = DaemonVoiceInferenceModelStatusSchema.parse({
          packId: 'acme.voice/tts-pack', pluginIdentity: { pluginId: 'acme.voice', packId: 'tts-pack' },
          kind: 'tts_sherpa', model: 'kokoro', version: '1', executionSupport: ['daemon'],
          installState: 'installed', progress: null, lastError: null, updatedAtMs: 1,
          voices: [{ id: 'calm', title: 'Calm' }, { id: 'bright', title: 'Bright' }],
          defaultVoiceId: 'bright',
        });
    boundary.machineRpc.mockImplementation(async request => {
      if (request.method === 'daemon.voiceInference.models.list') return DaemonVoiceInferenceModelsListResponseSchema.parse({ ok: true, models: [status] });
      if (request.method === 'daemon.voiceInference.models.status') return DaemonVoiceInferenceModelsStatusResponseSchema.parse({ ok: true, models: [] });
      throw new Error(`Unexpected model catalog RPC: ${request.method}`);
    });
    function DaemonSettings() {
      const controller = useDaemonVoiceModelCatalogState({ refreshKey: 'tts-machine' });
      return <DaemonVoiceModelCatalogProvider value={controller}>
        <LocalNeuralTtsSettings cfgKokoro={{ model: 'kokoro', assetId: 'acme.voice/tts-pack', voiceId: null, speed: 1, execution: 'daemon' }}
          setKokoro={vi.fn()} networkTimeoutMs={1000} popoverBoundaryRef={null} />
      </DaemonVoiceModelCatalogProvider>;
    }

    const { tree } = await renderScreen(
      <DaemonSettings />,
    );

    const voiceMenu = () => tree.root.findAllByType(DropdownMenu)
      .find((node) => node.props.itemTrigger?.title === t('settingsVoice.local.kokoro.voice.title'));
    await waitForTestEvent(tree.subscribe, () => voiceMenu()?.props.items.map((item: { id: string }) => item.id),
      ids => ids?.length === 2 && ids[0] === 'calm' && ids[1] === 'bright');
    expect(voiceMenu()?.props.items.map((item: { id: string }) => item.id)).toEqual(['calm', 'bright']);
    expect(voiceMenu()?.props.selectedId).toBe('bright');
    expect(voiceMenu()?.props.items.every((item: { rightElement?: React.ReactNode }) => item.rightElement === undefined)).toBe(true);
  });
});
