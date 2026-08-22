import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { cpus, loadavg, tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { reloadConfiguration } from '@/configuration';
import { createObservedForkedWorkerProcessTracker } from './forkedWorker/processTracker.testkit';
import { fetchVoiceModelPackManifest, hashVoiceModelPackManifest, readInstalledVoiceModelPackManifest } from './voiceModelPackInstaller';
import { resolveVoiceInferencePaths } from './voiceInferencePaths';
import { startVoiceInferenceWorker, type VoiceInferenceWorkerHandle } from './voiceInferenceWorker';
import { resolveVoiceInferenceWorkerRequestTimeoutMs } from './voiceInferenceWorkerConfig';

const KOKORO_PACK_ID = 'kokoro-82m-v1.0-onnx-q8-wasm';
const EXPECTED_MANIFEST_SHA256 = '89b5065457e5eb54d3b2fb5c4b28b638738bbeffe4be79dc5f329df1e0f09cc0';
const EXPECTED_FILE_COUNT = 362;
const EXPECTED_TOTAL_BYTES = 186_129_644;
const EXPECTED_NORMALIZED_ALIAS_COUNT = 104;
const NORMALIZED_ALIAS_PREFIX = 'kokoro-82m-v1.0-onnx-q8-wasm__espeak-ng-data__voices__.v__';
const enabled = process.env.HAPPIER_F34_REAL_KOKORO === '1';
const ACTIVE_CANCELLATION_SETTLEMENT_BOUND_MS = 3_000;
const DEFAULT_TIMEOUT_MAX_ONE_MINUTE_LOAD_PER_CPU = 0.75;
const DEFAULT_TIMEOUT_CONTENTION_WAIT_MS = 20 * 60_000;
const CURRENT_SOURCE_RUNTIME_MODULE = new URL(
  './runtime/packagedVoiceInferenceRuntime.ts',
  import.meta.url,
).href;

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

function inspectPcm16Wav(bytes: Buffer): Readonly<{
  sampleRate: number;
  samples: number;
  peak: number;
  rms: number;
}> {
  expect(bytes.subarray(0, 4).toString('ascii')).toBe('RIFF');
  expect(bytes.subarray(8, 12).toString('ascii')).toBe('WAVE');
  expect(bytes.subarray(12, 16).toString('ascii')).toBe('fmt ');
  expect(bytes.readUInt16LE(20)).toBe(1);
  expect(bytes.readUInt16LE(22)).toBe(1);
  expect(bytes.readUInt16LE(34)).toBe(16);
  expect(bytes.subarray(36, 40).toString('ascii')).toBe('data');
  const sampleRate = bytes.readUInt32LE(24);
  const dataBytes = bytes.readUInt32LE(40);
  expect(dataBytes).toBe(bytes.byteLength - 44);
  expect(dataBytes).toBeGreaterThan(sampleRate / 5);

  let peak = 0;
  let squareTotal = 0;
  const samples = dataBytes / 2;
  for (let offset = 44; offset < bytes.byteLength; offset += 2) {
    const sample = bytes.readInt16LE(offset) / 32_768;
    peak = Math.max(peak, Math.abs(sample));
    squareTotal += sample * sample;
  }
  const rms = Math.sqrt(squareTotal / samples);
  expect(peak).toBeGreaterThan(0.01);
  expect(rms).toBeGreaterThan(0.001);
  return { sampleRate, samples, peak, rms };
}

async function waitForDefaultTimeoutContentionBaseline(input: Readonly<{
  ownedWorkerPids: () => readonly number[];
  logicalCpuCount: number;
  maxOneMinuteLoad: number;
  timeoutMs?: number;
}>): Promise<Readonly<{
  loadAverages: readonly number[];
  waitedMs: number;
}>> {
  const startedAt = performance.now();
  const deadline = startedAt + (input.timeoutMs ?? DEFAULT_TIMEOUT_CONTENTION_WAIT_MS);
  let consecutiveAdmissibleSamples = 0;
  let announcedWait = false;
  let lastLoadAverages = loadavg();
  let lastOwnedWorkerPids: readonly number[] = [];
  while (performance.now() < deadline) {
    lastLoadAverages = loadavg();
    lastOwnedWorkerPids = input.ownedWorkerPids();
    if (
      lastLoadAverages[0]! <= input.maxOneMinuteLoad
      && lastOwnedWorkerPids.length === 0
    ) {
      consecutiveAdmissibleSamples += 1;
      if (consecutiveAdmissibleSamples >= 2) {
        return {
          loadAverages: lastLoadAverages,
          waitedMs: performance.now() - startedAt,
        };
      }
    } else {
      consecutiveAdmissibleSamples = 0;
      if (!announcedWait) {
        announcedWait = true;
        console.info('kokoro-real-stage', {
          stage: 'default_timeout_contention_waiting',
          logicalCpuCount: input.logicalCpuCount,
          loadAverages: lastLoadAverages.map((value) => Number(value.toFixed(2))),
          maxOneMinuteLoad: input.maxOneMinuteLoad,
          ownedVoiceWorkerPids: lastOwnedWorkerPids,
        });
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 10_000));
  }
  throw new Error(
    `kokoro_real_default_timeout_contention_not_admitted:${JSON.stringify({
      loadAverages: lastLoadAverages.map((value) => Number(value.toFixed(2))),
      maxOneMinuteLoad: input.maxOneMinuteLoad,
      ownedVoiceWorkerPids: lastOwnedWorkerPids,
    })}`,
  );
}

async function observeUnsettledSynthesis(input: Readonly<{
  isSettled: () => boolean;
  observationMs?: number;
  timeoutMs?: number;
}>): Promise<number> {
  const observationMs = input.observationMs ?? 1_000;
  const startedAt = performance.now();
  const deadline = performance.now() + (input.timeoutMs ?? 10_000);
  while (performance.now() < deadline) {
    if (input.isSettled()) {
      throw new Error('kokoro_real_synthesis_settled_before_cancellation_observation');
    }
    const elapsedMs = performance.now() - startedAt;
    if (elapsedMs >= observationMs) {
      return elapsedMs;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('kokoro_real_synthesis_did_not_remain_unsettled');
}

describe.runIf(enabled)('canonical public Kokoro consumed lifecycle', () => {
  let homeDir = '';
  let originalHome: string | undefined;
  let originalVariant: string | undefined;
  let originalPreferTsx: string | undefined;
  let originalRuntimeModule: string | undefined;
  let originalRequestTimeoutMs: string | undefined;
  const workers: VoiceInferenceWorkerHandle[] = [];
  const ownedWorkerProcesses = createObservedForkedWorkerProcessTracker();

  beforeAll(async () => {
    originalHome = process.env.HAPPIER_HOME_DIR;
    originalVariant = process.env.HAPPIER_VARIANT;
    originalPreferTsx = process.env.HAPPIER_CLI_SUBPROCESS_PREFER_TSX;
    originalRuntimeModule = process.env.HAPPIER_VOICE_INFERENCE_RUNTIME_MODULE;
    originalRequestTimeoutMs = process.env.HAPPIER_VOICE_INFERENCE_WORKER_REQUEST_TIMEOUT_MS;
    homeDir = await mkdtemp(join(tmpdir(), 'happier-kokoro-real-'));
    process.env.HAPPIER_HOME_DIR = homeDir;
    process.env.HAPPIER_VARIANT = 'dev';
    process.env.HAPPIER_CLI_SUBPROCESS_PREFER_TSX = '1';
    // The repository's canonical shared-dependency publisher may be busy while this gated
    // source canary runs. Use the existing runtime-module override so both the worker entrypoint
    // and engine execute current TypeScript source without mutating shared package-dist output.
    process.env.HAPPIER_VOICE_INFERENCE_RUNTIME_MODULE = CURRENT_SOURCE_RUNTIME_MODULE;
    // Native first-load and synthesis timing varies substantially under concurrent CI/QA load.
    // The canary measures real completion and cleanup, so keep the normal centralized timeout
    // owner but use its supported upper-bound override rather than turning host load into a
    // false worker-hang result.
    process.env.HAPPIER_VOICE_INFERENCE_WORKER_REQUEST_TIMEOUT_MS = '600000';
    reloadConfiguration();
  });

  afterAll(async () => {
    await Promise.all(workers.splice(0).map(async (worker) => await worker.stop().catch(() => undefined)));
    if (originalHome === undefined) delete process.env.HAPPIER_HOME_DIR;
    else process.env.HAPPIER_HOME_DIR = originalHome;
    if (originalVariant === undefined) delete process.env.HAPPIER_VARIANT;
    else process.env.HAPPIER_VARIANT = originalVariant;
    if (originalPreferTsx === undefined) delete process.env.HAPPIER_CLI_SUBPROCESS_PREFER_TSX;
    else process.env.HAPPIER_CLI_SUBPROCESS_PREFER_TSX = originalPreferTsx;
    if (originalRuntimeModule === undefined) delete process.env.HAPPIER_VOICE_INFERENCE_RUNTIME_MODULE;
    else process.env.HAPPIER_VOICE_INFERENCE_RUNTIME_MODULE = originalRuntimeModule;
    if (originalRequestTimeoutMs === undefined) delete process.env.HAPPIER_VOICE_INFERENCE_WORKER_REQUEST_TIMEOUT_MS;
    else process.env.HAPPIER_VOICE_INFERENCE_WORKER_REQUEST_TIMEOUT_MS = originalRequestTimeoutMs;
    reloadConfiguration();
    await rm(homeDir, { recursive: true, force: true });
  });

  it('installs exact public bytes, synthesizes, cancels, restarts, and removes without leaks', async () => {
    const startedAt = performance.now();
    const manifest = await fetchVoiceModelPackManifest({ packId: KOKORO_PACK_ID });
    expect(hashVoiceModelPackManifest(manifest)).toBe(EXPECTED_MANIFEST_SHA256);
    expect(manifest).toMatchObject({
      packId: KOKORO_PACK_ID,
      kind: 'tts_sherpa',
      model: 'kokoro',
      version: 'kokoro-int8-multi-lang-v1_1',
    });
    expect(manifest.files).toHaveLength(EXPECTED_FILE_COUNT);
    expect(manifest.files.reduce((total, file) => total + file.sizeBytes, 0)).toBe(EXPECTED_TOTAL_BYTES);
    expect(manifest.files.filter((file) => (
      file.path.startsWith('espeak-ng-data/voices/!v/')
      && new URL(file.url).pathname.split('/').at(-1)?.startsWith(NORMALIZED_ALIAS_PREFIX)
    ))).toHaveLength(EXPECTED_NORMALIZED_ALIAS_COUNT);
    const manifestFetchedMs = performance.now() - startedAt;
    console.info('kokoro-real-stage', { stage: 'manifest_verified', manifestFetchedMs: Math.round(manifestFetchedMs) });

    const firstWorker = await startVoiceInferenceWorker({
      isolationMode: 'forked',
      perModelConcurrency: 1,
      onForkedWorkerProcess: ownedWorkerProcesses.observe,
    });
    workers.push(firstWorker);
    await expect(firstWorker.installModel({ packId: 'kokoro-en-v0_19' })).rejects.toMatchObject({
      code: 'unsupported_runtime_family',
    });

    const installStartedAt = performance.now();
    const installedStatus = await firstWorker.installModel({ packId: KOKORO_PACK_ID });
    const installMs = performance.now() - installStartedAt;
    console.info('kokoro-real-stage', { stage: 'installed', installMs: Math.round(installMs) });
    expect(installedStatus).toMatchObject({
      packId: KOKORO_PACK_ID,
      installState: 'installed',
      runtimeFamily: 'sherpa_kokoro_offline',
      runtimeSupported: true,
    });

    const paths = resolveVoiceInferencePaths();
    const installedManifest = await readInstalledVoiceModelPackManifest({
      packsRootDir: paths.packsRootDir,
      packId: KOKORO_PACK_ID,
    });
    expect(installedManifest).toEqual(manifest);
    const packDir = join(paths.packsRootDir, KOKORO_PACK_ID);
    for (const file of manifest.files) {
      const filePath = join(packDir, ...file.path.split('/'));
      expect((await stat(filePath)).size, file.path).toBe(file.sizeBytes);
      expect(await sha256File(filePath), file.path).toBe(file.sha256);
    }

    const warmStartedAt = performance.now();
    await firstWorker.warmModelPack(KOKORO_PACK_ID);
    const warmMs = performance.now() - warmStartedAt;
    console.info('kokoro-real-stage', { stage: 'warmed', warmMs: Math.round(warmMs) });
    const firstSynthesisStartedAt = performance.now();
    const firstAudio = await firstWorker.synthesizeTts({
      requestId: 'kokoro-real-first',
      text: 'Happier confirms the exact Kokoro model pack is working.',
      packId: KOKORO_PACK_ID,
      voiceId: null,
      speed: 1,
      output: { codec: 'wav', mimeType: 'audio/wav' },
    });
    const firstSynthesisMs = performance.now() - firstSynthesisStartedAt;
    const firstAudioInspection = inspectPcm16Wav(await readFile(firstAudio.filePath));
    await rm(firstAudio.filePath, { force: true });
    console.info('kokoro-real-stage', {
      stage: 'first_tts',
      firstSynthesisMs: Math.round(firstSynthesisMs),
      firstAudio: firstAudioInspection,
    });

    const occupyingSynthesis = firstWorker.synthesizeTts({
      requestId: 'kokoro-real-occupying',
      text: 'This deterministic sentence occupies the one-slot Kokoro generation queue.',
      packId: KOKORO_PACK_ID,
      voiceId: null,
      speed: 1,
      output: { codec: 'wav', mimeType: 'audio/wav' },
    });
    const cancelledSynthesis = firstWorker.synthesizeTts({
      requestId: 'kokoro-real-cancelled',
      text: 'This admitted queued generation must be cancelled.',
      packId: KOKORO_PACK_ID,
      voiceId: null,
      speed: 1,
      output: { codec: 'wav', mimeType: 'audio/wav' },
    });
    const cancelStartedAt = performance.now();
    await firstWorker.cancelTts('kokoro-real-cancelled');
    await expect(cancelledSynthesis).rejects.toMatchObject({ code: 'cancelled' });
    const cancellationSettlementMs = performance.now() - cancelStartedAt;
    expect(cancellationSettlementMs).toBeLessThan(1_000);
    const occupyingAudio = await occupyingSynthesis;
    inspectPcm16Wav(await readFile(occupyingAudio.filePath));
    await rm(occupyingAudio.filePath, { force: true });
    console.info('kokoro-real-stage', {
      stage: 'queued_cancelled',
      cancellationSettlementMs: Math.round(cancellationSettlementMs),
    });

    const activeWorkerPid = await ownedWorkerProcesses.waitForNewPid();
    let activeSynthesisSettled = false;
    const activeSynthesis = firstWorker.synthesizeTts({
      requestId: 'kokoro-real-active-cancelled',
      text: [
        'Happier is measuring cancellation while Kokoro is actively generating speech.',
        'The native generation must stop without publishing stale audio.',
        'The supervised worker must recover for the next synthesis request.',
        'This sentence keeps the real generation unsettled long enough to cancel in flight.',
        'Cancellation remains bounded even while the synchronous native engine is occupied.',
      ].join(' '),
      packId: KOKORO_PACK_ID,
      voiceId: null,
      speed: 1,
      output: { codec: 'wav', mimeType: 'audio/wav' },
    }).finally(() => {
      activeSynthesisSettled = true;
    });
    const unsettledSynthesisObservationMs = await observeUnsettledSynthesis({
      isSettled: () => activeSynthesisSettled,
    });
    const activeCancelStartedAt = performance.now();
    await firstWorker.cancelTts('kokoro-real-active-cancelled');
    const activeCancellationResult = await Promise.race([
      activeSynthesis.then(
        () => ({ kind: 'resolved' as const }),
        (error: unknown) => ({ kind: 'rejected' as const, error }),
      ),
      new Promise<{ kind: 'timeout' }>((resolve) => {
        setTimeout(
          () => resolve({ kind: 'timeout' }),
          ACTIVE_CANCELLATION_SETTLEMENT_BOUND_MS,
        );
      }),
    ]);
    const activeCancellationSettlementMs = performance.now() - activeCancelStartedAt;
    expect(activeCancellationResult).toMatchObject({
      kind: 'rejected',
      error: { code: 'cancelled' },
    });
    expect(activeCancellationSettlementMs).toBeLessThan(ACTIVE_CANCELLATION_SETTLEMENT_BOUND_MS);
    const activeTermination = await ownedWorkerProcesses.waitForTermination(activeWorkerPid);
    expect(activeTermination).toMatchObject({ type: 'signaled', signal: 'SIGKILL' });
    const activeWorkerTerminationMs = performance.now() - activeCancelStartedAt;
    expect(activeWorkerTerminationMs).toBeLessThan(ACTIVE_CANCELLATION_SETTLEMENT_BOUND_MS);
    expect(await readdir(paths.tempDir)).toEqual([]);

    const postCancelSynthesisStartedAt = performance.now();
    const postCancelSynthesis = firstWorker.synthesizeTts({
      requestId: 'kokoro-real-post-active-cancel',
      text: 'Kokoro remains healthy after an actively executing generation is cancelled.',
      packId: KOKORO_PACK_ID,
      voiceId: null,
      speed: 1,
      output: { codec: 'wav', mimeType: 'audio/wav' },
    });
    const replacementWorkerPid = await ownedWorkerProcesses.waitForNewPid([activeWorkerPid]);
    expect(replacementWorkerPid).not.toBe(activeWorkerPid);
    const postCancelAudio = await postCancelSynthesis;
    const postCancelSynthesisMs = performance.now() - postCancelSynthesisStartedAt;
    const postCancelAudioInspection = inspectPcm16Wav(await readFile(postCancelAudio.filePath));
    await rm(postCancelAudio.filePath, { force: true });
    console.info('kokoro-real-stage', {
      stage: 'active_cancelled',
      workerPid: activeWorkerPid,
      unsettledSynthesisObservationMs: Math.round(unsettledSynthesisObservationMs),
      activeCancellationSettlementMs: Math.round(activeCancellationSettlementMs),
      activeWorkerTerminationMs: Math.round(activeWorkerTerminationMs),
      replacementWorkerPid,
      staleOutputEntries: 0,
      postCancelSynthesisMs: Math.round(postCancelSynthesisMs),
      postCancelAudio: postCancelAudioInspection,
    });

    const stopStartedAt = performance.now();
    await firstWorker.stop();
    workers.splice(workers.indexOf(firstWorker), 1);
    const stopMs = performance.now() - stopStartedAt;
    expect(ownedWorkerProcesses.activePids()).toEqual([]);

    // Re-create the worker after removing the test-only upper-bound override. This characterizes
    // process-cold warm and synthesis against the unmodified canonical 30-second owner while
    // reusing the exact installed q8 pack.
    const logicalCpuCount = cpus().length;
    const defaultTimeoutMaxOneMinuteLoad = (
      logicalCpuCount * DEFAULT_TIMEOUT_MAX_ONE_MINUTE_LOAD_PER_CPU
    );
    const defaultTimeoutContentionBaseline = await waitForDefaultTimeoutContentionBaseline({
      ownedWorkerPids: ownedWorkerProcesses.activePids,
      logicalCpuCount,
      maxOneMinuteLoad: defaultTimeoutMaxOneMinuteLoad,
    });
    const loadAverages = defaultTimeoutContentionBaseline.loadAverages;
    console.info('kokoro-real-stage', {
      stage: 'default_timeout_contention_baseline',
      logicalCpuCount,
      loadAverages: loadAverages.map((value) => Number(value.toFixed(2))),
      maxOneMinuteLoad: defaultTimeoutMaxOneMinuteLoad,
      ownedVoiceWorkerPids: [],
      waitedMs: Math.round(defaultTimeoutContentionBaseline.waitedMs),
    });
    expect(loadAverages[0]).toBeLessThanOrEqual(defaultTimeoutMaxOneMinuteLoad);
    delete process.env.HAPPIER_VOICE_INFERENCE_WORKER_REQUEST_TIMEOUT_MS;
    reloadConfiguration();
    const defaultRequestTimeoutMs = resolveVoiceInferenceWorkerRequestTimeoutMs();
    expect(defaultRequestTimeoutMs).toBe(30_000);
    const restartedWorker = await startVoiceInferenceWorker({
      isolationMode: 'forked',
      onForkedWorkerProcess: ownedWorkerProcesses.observe,
    });
    workers.push(restartedWorker);
    const restartWarmStartedAt = performance.now();
    await restartedWorker.warmModelPack(KOKORO_PACK_ID);
    const restartWarmMs = performance.now() - restartWarmStartedAt;
    const alreadyWarmStartedAt = performance.now();
    await restartedWorker.warmModelPack(KOKORO_PACK_ID);
    const alreadyWarmMs = performance.now() - alreadyWarmStartedAt;
    const restartSynthesisStartedAt = performance.now();
    const restartAudio = await restartedWorker.synthesizeTts({
      requestId: 'kokoro-real-restarted',
      text: 'Kokoro still works after the inference worker restarts.',
      packId: KOKORO_PACK_ID,
      voiceId: null,
      speed: 1,
      output: { codec: 'wav', mimeType: 'audio/wav' },
    });
    const restartSynthesisMs = performance.now() - restartSynthesisStartedAt;
    const restartAudioInspection = inspectPcm16Wav(await readFile(restartAudio.filePath));
    await rm(restartAudio.filePath, { force: true });
    console.info('kokoro-real-stage', {
      stage: 'restart_tts',
      defaultRequestTimeoutMs,
      restartWarmMs: Math.round(restartWarmMs),
      alreadyWarmMs: Math.round(alreadyWarmMs),
      restartSynthesisMs: Math.round(restartSynthesisMs),
      restartAudio: restartAudioInspection,
    });

    await restartedWorker.stop();
    workers.splice(workers.indexOf(restartedWorker), 1);
    const removalWorker = await startVoiceInferenceWorker({ isolationMode: 'in_process' });
    workers.push(removalWorker);
    await removalWorker.removeModel(KOKORO_PACK_ID);
    await expect(stat(packDir)).rejects.toMatchObject({ code: 'ENOENT' });
    await removalWorker.stop();
    workers.splice(workers.indexOf(removalWorker), 1);

    expect(await readdir(paths.tempDir)).toEqual([]);
    expect(await readdir(paths.packsRootDir)).toEqual([]);
    expect(ownedWorkerProcesses.activePids()).toEqual([]);
    console.info('kokoro-real-lifecycle', {
      manifestSha256: EXPECTED_MANIFEST_SHA256,
      files: EXPECTED_FILE_COUNT,
      totalBytes: EXPECTED_TOTAL_BYTES,
      manifestFetchedMs: Math.round(manifestFetchedMs),
      installMs: Math.round(installMs),
      warmMs: Math.round(warmMs),
      firstSynthesisMs: Math.round(firstSynthesisMs),
      cancellationSettlementMs: Math.round(cancellationSettlementMs),
      activeCancellationSettlementMs: Math.round(activeCancellationSettlementMs),
      activeWorkerTerminationMs: Math.round(activeWorkerTerminationMs),
      unsettledSynthesisObservationMs: Math.round(unsettledSynthesisObservationMs),
      postCancelSynthesisMs: Math.round(postCancelSynthesisMs),
      stopMs: Math.round(stopMs),
      defaultTimeoutBaselineLoadAverages: loadAverages.map((value) => Number(value.toFixed(2))),
      defaultTimeoutLogicalCpuCount: logicalCpuCount,
      defaultTimeoutContentionWaitMs: Math.round(defaultTimeoutContentionBaseline.waitedMs),
      defaultRequestTimeoutMs,
      restartWarmMs: Math.round(restartWarmMs),
      alreadyWarmMs: Math.round(alreadyWarmMs),
      restartSynthesisMs: Math.round(restartSynthesisMs),
      firstAudio: firstAudioInspection,
      postCancelAudio: postCancelAudioInspection,
      restartAudio: restartAudioInspection,
      workerLeaks: 0,
      tempRootEntries: 0,
    });
  }, 35 * 60_000);
});
