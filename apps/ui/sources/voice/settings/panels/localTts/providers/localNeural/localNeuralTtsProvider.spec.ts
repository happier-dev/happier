import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { createVoiceSpeechOutputBoundary } from '@/dev/testkit/harness/voiceSpeechOutputBoundary';
import { createDeferred } from '@/dev/testkit';
import { fetchAndApplyMachines } from '@/sync/engine/machines/syncMachines';
import type { VoiceLocalTtsSettings } from '@/sync/domains/settings/voiceLocalTtsSettings';
import { voiceSettingsDefaults } from '@/sync/domains/settings/voiceSettings';
import { createVoiceSettingsAccountTestHarness } from '../../../voiceSettingsAccountTestHarness';
import { settingsParse } from '@/sync/domains/settings/settings';
import { storage } from '@/sync/domains/state/storage';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { parseModelPackManifest } from '@happier-dev/protocol/voice/modelPacks/manifest';
import { DaemonVoiceInferenceTtsStreamStartRequestSchema } from '@happier-dev/protocol/daemon/voiceInference';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
// These local speech tests never start the unavailable vendor web conversation SDK.
vi.mock('@elevenlabs/client/web', () => ({ Conversation: { startSession: () => { throw new Error('Unexpected ElevenLabs conversation start'); } } }));

let account: Awaited<ReturnType<typeof createVoiceSettingsAccountTestHarness>>;
const boundary = createVoiceSpeechOutputBoundary({ getAccount: () => ({
  home: { id: account.scope.serverId, serverUrl: getActiveServerSnapshot().serverUrl }, credentials: account.credentials,
}) });
const { localNeuralTtsProviderSpec } = await import('./localNeuralTtsProvider');

function tts(execution: 'auto' | 'device'): VoiceLocalTtsSettings {
  return { provider: 'local_neural',
    localNeural: { model: 'kokoro', assetId: 'kokoro-82m-v1.0-onnx-q8-wasm', voiceId: 'af_heart', speed: 1, execution },
    autoSpeakReplies: true, bargeInEnabled: true };
}

// Restore credentials through the SDK storage for the platform under test.
async function restoreAccount() {
    account = await createVoiceSettingsAccountTestHarness(settingsParse({
      experiments: true, featureToggles: { 'voice.agent': true, 'execution.runs': true, 'voice.daemonInference': true },
      voice: { ...voiceSettingsDefaults, executionMachine: { mode: 'fixed', machineId: 'tts-machine', autoMachineId: null } },
    }), { features: createRootLayoutFeaturesResponse({ features: {
      machines: { enabled: true, liveStream: { ...createRootLayoutFeaturesResponse().features.machines.liveStream, enabled: true, serverRouted: { enabled: true } } },
    }, capabilities: { machines: { ...createRootLayoutFeaturesResponse().capabilities.machines, liveStream: { serverRouted: { disabledReason: null, caps: {
      maxBitrateBps: 64_000, maxFramesPerSecond: 50, maxFrameBytes: 16_000, maxDurationMs: 60_000,
      maxTotalBytes: 1_000_000, maxConcurrentStreamsPerAccount: 2, maxConcurrentStreamsPerSocket: 1, maxConcurrentStreamsPerMachine: 1,
    } } } } } }) });
    const accountHttp = account.request.getMockImplementation();
    if (!accountHttp) throw new Error('Account HTTP boundary missing');
    account.request.mockImplementation(async (url, init) => boundary.answerMachineHttpRequest(url, 'tts-machine', account.scope.accountId, init)
      ?? accountHttp(url, init));
    // The bound Machine RPC reads the admitted row projected by Sync.
    await fetchAndApplyMachines({
      credentials: account.credentials,
      expectedAccountMode: 'plain',
      encryption: null,
      machineDataKeys: new Map(),
      sourceServerId: account.scope.serverId,
      throwOnError: true,
      replace: true,
      applyMachines: (machines, replace, rows) => storage.getState().applyMachines(machines, replace, {
        sourceServerId: account.scope.serverId,
        activityUpdates: rows.map(({ id, active, activeAt }) => ({ id, active, activeAt })),
      }),
      onListComplete: () => storage.getState().markMachineListSettled(account.scope.serverId),
    });
}

describe('localNeuralTtsProviderSpec', () => {
  const envKey = 'EXPO_PUBLIC_KOKORO_OPERATION_TIMEOUT_MS';
  let priorEnv: string | undefined;

  beforeEach(async () => {
    const reset = boundary.reset();
    boundary.platform.value = 'ios';
    const manifest = parseModelPackManifest({ packId: 'kokoro-82m-v1.0-onnx-q8-wasm', kind: 'tts_sherpa',
      model: 'kokoro', version: '1', frontend: { lang: 'en' },
      voices: [{ id: 'af_heart', title: 'Heart', sid: 0 }], defaultVoiceId: 'af_heart',
      files: [{ path: 'model.onnx', url: 'https://example.test/model.onnx', sha256: 'a'.repeat(64), sizeBytes: 1 }] });
    reset.filesystem.files.set(`${reset.filesystem.root}/${manifest.packId}/pack.json`, new TextEncoder().encode(JSON.stringify({ manifest })));
    priorEnv = process.env[envKey];
    process.env[envKey] = '120000';
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    boundary.disposeNativeSdkBridge();
    await account?.dispose();
    if (priorEnv === undefined) delete process.env[envKey];
    else process.env[envKey] = priorEnv;
  });
  afterAll(async () => { await boundary.disposeAudioSession(); });

  it('uses Kokoro operation timeout (not a fixed 60s floor) for Test TTS', async () => {
    await restoreAccount();
    const initialized = createDeferred<void>();
    const initialization = createDeferred<void>();
    boundary.nativeInitialize.mockImplementationOnce(async () => { initialized.resolve(); await initialization.promise; });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let settled = false;
    const result = localNeuralTtsProviderSpec.test({ cfgTts: tts('auto'), voice: voiceSettingsDefaults,
      networkTimeoutMs: 15_000, sample: 'Hello' }).then(() => { settled = true; return null; }, error => { settled = true; return error; });
    await initialized.promise;
    await vi.advanceTimersByTimeAsync(60_001);
    expect(settled).toBe(false);
    expect(boundary.nativeSynthesize).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(59_999);
    expect(await result).toMatchObject({ message: 'timeout' });
    expect(boundary.encodedAudio.start).not.toHaveBeenCalled();
    initialization.resolve();
  });

  it('routes Test TTS through the actual daemon stream for the default web auto execution path', async () => {
    boundary.platform.value = 'web';
    await restoreAccount();
    const play = vi.fn();
    // HTMLAudioElement is the browser SDK boundary; real playback and stream ACK stay live.
    vi.stubGlobal('Audio', class {
      onended: (() => void) | null = null;
      onerror: (() => void) | null = null;
      pause() {}
      async play() { play(); queueMicrotask(() => this.onended?.()); }
    });
    await localNeuralTtsProviderSpec.test({ cfgTts: tts('auto'), voice: voiceSettingsDefaults,
      networkTimeoutMs: 15_000, sample: 'Hello' });
    const start = boundary.machineRpc.mock.calls.map(([request]) => request)
      .find(request => request.method === 'daemon.voiceInference.tts.stream.start');
    expect(start).toBeDefined();
    expect(DaemonVoiceInferenceTtsStreamStartRequestSchema.parse(start?.payload)).toMatchObject({
      text: 'Hello', packId: 'kokoro-82m-v1.0-onnx-q8-wasm', voiceId: 'af_heart',
    });
    expect(play).toHaveBeenCalledOnce();
    expect(boundary.machineRpc.mock.calls.some(([request]) => request.method === 'daemon.voiceInference.tts.stream.ack')).toBe(true);
    expect(boundary.nativeSynthesize).not.toHaveBeenCalled();
  });

  it('preserves explicit web device execution and reports the unsupported device runtime', async () => {
    boundary.platform.value = 'web';
    await restoreAccount();
    await expect(localNeuralTtsProviderSpec.test({ cfgTts: tts('device'), voice: voiceSettingsDefaults,
      networkTimeoutMs: 15_000, sample: 'Hello from web device' })).rejects.toThrow('kokoro_runtime_unsupported');
    expect(boundary.machineRpc).not.toHaveBeenCalled();
    expect(boundary.nativeSynthesize).not.toHaveBeenCalled();
  });
});
