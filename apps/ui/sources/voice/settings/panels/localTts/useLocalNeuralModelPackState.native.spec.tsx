import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';

import { createDeferred, flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';
import { createVoiceSpeechOutputBoundary } from '@/dev/testkit/harness/voiceSpeechOutputBoundary';
import { KOKORO_DEFAULT_TTS_PACK_ID } from '@happier-dev/protocol/voice/modelPacks/catalog';
vi.mock('socket.io-client', async original =>
  (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(original));
const boundary = createVoiceSpeechOutputBoundary({ getAccount: () => {
  throw new Error('Device model preparation must not dispatch a daemon RPC');
} });
let { filesystem } = boundary.reset();

vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());

const { Alert } = await import('react-native');
const { t } = await import('@/text');
// The native dialog API is the OS boundary; ModalManager and text remain real.
const alert = vi.spyOn(Alert, 'alert').mockImplementation(() => {});

const { useLocalNeuralModelPackState } = await import('./useLocalNeuralModelPackState.native');
const { useLocalNeuralKokoroVoiceCatalog } = await import('./useLocalNeuralKokoroVoiceCatalog.native');
const { createVoiceSettingsAccountTestHarness } = await import('../voiceSettingsAccountTestHarness');
const { settingsParse } = await import('@/sync/domains/settings/settings');
const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
const input = { packId: KOKORO_DEFAULT_TTS_PACK_ID };
let account: Awaited<ReturnType<typeof createVoiceSettingsAccountTestHarness>>;

describe('useLocalNeuralModelPackState (native)', () => {
  beforeEach(async () => {
    ({ filesystem } = boundary.reset());
    boundary.platform.value = 'ios';
    boundary.setNativeAvailable(false);
    alert.mockClear();
    account = await createVoiceSettingsAccountTestHarness(settingsParse({
      actionsSettingsV1: { v: 1, approvalWaivedSurfaces: { 'settings.invoke': ['ui'], 'settings.set': ['ui'] } },
      voice: { providerId: 'local_conversation', providers: { local_conversation: { schemaVersion: 1, config: {
        stt: { provider: 'local_neural', localNeural: { execution: 'device', assetId: input.packId } },
        tts: { provider: 'local_neural', localNeural: { execution: 'device', assetId: input.packId } },
      } } } },
    }));
  });
  afterEach(async () => { standardCleanup(); boundary.disposeNativeSdkBridge(); vi.unstubAllGlobals(); await account.dispose(); });
  afterAll(async () => { alert.mockRestore(); await boundary.disposeAudioSession(); });

  it('refuses manual native model operations through disabled settings.invoke without blocking an adjacent setting', async () => {
    const fetch = vi.fn(async () => { throw new Error('A refused model operation must not download'); });
    vi.stubGlobal('fetch', fetch);
    account.replaceSettings(settingsParse({ ...account.settings, actionsSettingsV1: { v: 1,
      actions: { 'settings.invoke': { disabledSurfaces: ['ui'] } }, approvalWaivedSurfaces: { 'settings.set': ['ui'] } } }));
    const hook = await renderHook(useLocalNeuralModelPackState, { initialProps: input });
    await act(async () => { await hook.getCurrent().prepareModel(); });
    expect(fetch).not.toHaveBeenCalled();
    expect(alert).not.toHaveBeenCalled();
    expect(filesystem.files.size).toBe(0);
    expect(boundary.native.initialize).not.toHaveBeenCalled();
    const adjacent = await createDefaultActionExecutor().execute('settings.set', { anchor: 'voicePrivacy.recentMessagesCount', value: 7 }, {
      surface: 'ui', authority: 'present_user', serverId: account.scope.serverId, expectedAccountId: account.scope.accountId,
    });
    expect(adjacent, JSON.stringify(adjacent)).toMatchObject({ ok: true });
    expect(account.persistedSettings.voice.privacy.recentMessagesCount).toBe(7);
  });

  it('publishes no equal device model or voice observations and preserves unchanged voice rows', async () => {
    const manifest = { packId: input.packId, kind: 'tts_sherpa', model: 'kokoro', version: '1',
      voices: [{ id: 'af_heart', title: 'Heart', sid: 0 }, { id: 'af_bella', title: 'Bella', sid: 1 }],
      files: [{ path: 'model.bin', url: 'https://example.test/model.bin', sha256: 'a'.repeat(64), sizeBytes: 1 }] };
    const writeManifest = () => filesystem.files.set(`${filesystem.root}/${input.packId}/pack.json`,
      new TextEncoder().encode(JSON.stringify({ manifest })));
    writeManifest();
    filesystem.files.set(`${filesystem.root}/${input.packId}/model.bin`, new Uint8Array([1]));
    const summaryPublished = vi.fn();
    const voicesPublished = vi.fn();
    function useCatalog() {
      const pack = useLocalNeuralModelPackState(input);
      const voices = useLocalNeuralKokoroVoiceCatalog({ installSummary: pack.installSummary });
      React.useEffect(() => { summaryPublished(); }, [pack.installSummary]);
      React.useEffect(() => { voicesPublished(); }, [voices]);
      return { ...pack, voices };
    }
    const hook = await renderHook(useCatalog);
    await flushHookEffects();
    const initial = hook.getCurrent();
    expect(initial.voices).toHaveLength(2);
    summaryPublished.mockClear();
    voicesPublished.mockClear();
    for (let refresh = 0; refresh < 5; refresh += 1) {
      await act(async () => { await hook.getCurrent().refreshInstallState(); });
    }
    expect(summaryPublished).toHaveBeenCalledTimes(0);
    expect(voicesPublished).toHaveBeenCalledTimes(0);
    expect(hook.getCurrent().installSummary).toBe(initial.installSummary);
    expect(hook.getCurrent().voices).toBe(initial.voices);
    // A model revision is real, but does not change its voice catalog.
    manifest.version = '2';
    writeManifest();
    await act(async () => { await hook.getCurrent().refreshInstallState(); });
    await flushHookEffects();
    expect(summaryPublished).toHaveBeenCalledTimes(1);
    expect(voicesPublished).toHaveBeenCalledTimes(0);
    manifest.voices[0]!.title = 'Updated Heart';
    writeManifest();
    await act(async () => { await hook.getCurrent().refreshInstallState(); });
    await flushHookEffects();
    expect(voicesPublished).toHaveBeenCalledTimes(1);
    expect(hook.getCurrent().voices[0]).toMatchObject({ title: 'Updated Heart' });
    expect(hook.getCurrent().voices[1]).toBe(initial.voices[1]);
  });

  it('warns when native storage becomes unavailable, falls back, and recovers on a later refresh', async () => {
    const manifest = { packId: input.packId, kind: 'tts_sherpa', model: 'kokoro', version: '1',
      files: [{ path: 'model.bin', url: 'https://example.test/model.bin', sha256: 'a'.repeat(64), sizeBytes: 1 }] };
    filesystem.files.set(`${filesystem.root}/${input.packId}/pack.json`, new TextEncoder().encode(JSON.stringify({ manifest })));
    filesystem.files.set(`${filesystem.root}/${input.packId}/model.bin`, new Uint8Array([1]));
    const hook = await renderHook(useLocalNeuralModelPackState, { initialProps: input });
    expect(hook.getCurrent().installed).toBe(true);
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const BaseDirectory = filesystem.fs.Directory;
    class UnavailableDirectory extends BaseDirectory {
      constructor(...args: unknown[]) {
        super(...args);
        throw new Error('storage_unavailable');
      }
    }
    try {
      filesystem.fs.Directory = UnavailableDirectory;
      await act(async () => { await hook.getCurrent().refreshInstallState(); });
      expect(hook.getCurrent().installed).toBe(false);
      expect(hook.getCurrent().installSummary).toBeNull();
      expect(hook.getCurrent().modelStatus).toBe('idle');
      expect(warning.mock.calls.some(call => call.some(value =>
        value instanceof Error && value.message === 'storage_unavailable'))).toBe(true);
      expect(alert).not.toHaveBeenCalled();
      filesystem.fs.Directory = BaseDirectory;
      await act(async () => { await hook.getCurrent().refreshInstallState(); });
      expect(hook.getCurrent().installed).toBe(true);
      expect(hook.getCurrent().modelStatus).toBe('ready');
    } finally {
      filesystem.fs.Directory = BaseDirectory;
      warning.mockRestore();
    }
  });

  it('admits manual preparation with observation disabled and keeps installed-state visibility unchanged', async () => {
    const manifest = { packId: input.packId, kind: 'tts_sherpa', model: 'kokoro', version: '1',
      files: [{ path: 'model.bin', url: 'https://example.test/model.bin', sha256: 'a'.repeat(64), sizeBytes: 1 }] };
    filesystem.files.set(`${filesystem.root}/${input.packId}/pack.json`, new TextEncoder().encode(JSON.stringify({ manifest })));
    filesystem.files.set(`${filesystem.root}/${input.packId}/model.bin`, new Uint8Array([1]));
    const hook = await renderHook(useLocalNeuralModelPackState, { initialProps: { ...input, readEnabled: false } });
    await act(async () => { await hook.getCurrent().prepareModel(); });
    expect(hook.getCurrent().modelStatus).toBe('idle');
    expect(hook.getCurrent().installed).toBe(false);
    expect(hook.getCurrent().installSummary).toBeNull();
    expect(alert).toHaveBeenCalledWith(t('common.error'), t('settingsVoice.local.kokoro.alerts.runtimeUnsupported.body'), undefined);
    expect(filesystem.files.get(`${filesystem.root}/${input.packId}/model.bin`)).toEqual(new Uint8Array([1]));
  });

  it('settles a cancelled download back to idle instead of pinning downloading', async () => {
    boundary.setNativeAvailable(true);
    const requested = createDeferred<AbortSignal>();
    vi.stubGlobal('fetch', vi.fn((_url: string, options: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = options.signal;
        if (!signal) throw new Error('Expected an admitted installer cancellation signal');
        requested.resolve(signal);
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      })));
    const hook = await renderHook(useLocalNeuralModelPackState, { initialProps: input });
    let operation!: Promise<void>;
    await act(async () => { operation = hook.getCurrent().prepareModel(); });
    const signal = await requested.promise;
    expect(hook.getCurrent().modelStatus).toBe('downloading');
    await act(async () => { hook.getCurrent().cancelPrepare(); await operation; });
    expect(signal.aborted).toBe(true);
    expect(hook.getCurrent().modelStatus).toBe('idle');
    expect(hook.getCurrent().downloadProgress).toBeNull();
    expect(filesystem.files.size).toBe(0);
    expect(alert).not.toHaveBeenCalled();
  });

  it.each(['stt_sherpa', 'tts_sherpa'] as const)('refreshes resumable %s bytes after cancellation', async role => {
    boundary.setNativeAvailable(true);
    const scratch = `${filesystem.root}/.${input.packId}.scratch/model.bin`;
    filesystem.files.set(scratch, new Uint8Array([1]));
    const requested = createDeferred<AbortSignal>();
    vi.stubGlobal('fetch', vi.fn((_url: string, options: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = options.signal;
        if (!signal) throw new Error('Expected installer cancellation signal');
        requested.resolve(signal);
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      })));
    const hook = await renderHook(useLocalNeuralModelPackState, { initialProps: {
      ...input, role,
    } });
    expect(hook.getCurrent().installSummary?.partialBytes).toBe(1);
    let operation!: Promise<void>;
    await act(async () => { operation = hook.getCurrent().prepareModel(); });
    await requested.promise;
    filesystem.files.set(scratch, new Uint8Array([1, 2, 3]));
    await act(async () => { hook.getCurrent().cancelPrepare(); await operation; });
    expect(hook.getCurrent().modelStatus).toBe('idle');
    expect(hook.getCurrent().installSummary?.partialBytes).toBe(3);
    expect(filesystem.files.get(scratch)).toEqual(new Uint8Array([1, 2, 3]));
    expect(alert).not.toHaveBeenCalled();
  });

  it.each(['stt_sherpa', 'tts_sherpa'] as const)('surfaces storage failure concurrent with %s cancellation', async role => {
    boundary.setNativeAvailable(true);
    const manifest = { packId: input.packId, kind: role, model: 'kokoro', version: '1',
      files: [{ path: 'model.bin', url: 'https://example.test/model.bin', sha256: 'a'.repeat(64), sizeBytes: 1 }] };
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(manifest)));
    const hook = await renderHook(useLocalNeuralModelPackState, { initialProps: {
      ...input, role,
    } });
    const BaseFile = filesystem.fs.File;
    class StorageFailureFile extends BaseFile {
      write(content: string | Uint8Array, options?: { append?: boolean }) {
        if (this.uri.endsWith('/.resume-plan.json')) {
          hook.getCurrent().cancelPrepare();
          throw new Error('storage_write_failed');
        }
        super.write(content, options);
      }
    }
    filesystem.fs.File = StorageFailureFile;
    try {
      await act(async () => { await hook.getCurrent().prepareModel(); });
      expect(hook.getCurrent().modelStatus).toBe('error');
      expect(alert.mock.calls.some(call => String(call[1]).includes('storage_write_failed'))).toBe(true);
      expect(hook.getCurrent().installed).toBe(false);
    } finally {
      filesystem.fs.File = BaseFile;
    }
  });

  it.each(['stt_sherpa', 'tts_sherpa'] as const)('keeps the installed %s pack ready after an update fails', async role => {
    const manifest = { packId: input.packId, kind: role, model: 'kokoro', version: '1',
      files: [{ path: 'model.bin', url: 'https://example.test/model.bin', sha256: 'a'.repeat(64), sizeBytes: 1 }] };
    filesystem.files.set(`${filesystem.root}/${input.packId}/pack.json`, new TextEncoder().encode(JSON.stringify({ manifest })));
    filesystem.files.set(`${filesystem.root}/${input.packId}/model.bin`, new Uint8Array([1]));
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network_offline'); }));
    const alerted = createDeferred<void>();
    alert.mockImplementationOnce(() => alerted.resolve());
    const hook = await renderHook(useLocalNeuralModelPackState, { initialProps: {
      ...input, role,
    } });
    expect(hook.getCurrent().modelStatus).toBe('ready');
    await act(async () => { hook.getCurrent().checkForUpdates(); });
    await alerted.promise;
    expect(alert).toHaveBeenCalled();
    expect(hook.getCurrent().modelStatus).toBe('ready');
    expect(hook.getCurrent().installed).toBe(true);
  });
});
