import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  deriveVoiceModelPackLicenseTextDigestV1,
  deriveVoiceModelPackManifestDigestV1,
} from '@happier-dev/voice-modelpacks';
import { DAEMON_VOICE_INFERENCE_STT_STREAM_PCM_FORMAT } from '@happier-dev/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import { reloadConfiguration } from '@/configuration';
import type { PinnedHttpStreamTransport } from '@/network/pinnedHttp';
import { createPluginRegistryStateStore } from '@/plugins/store/registry/currentState';
import { resolvePluginStorePaths } from '@/plugins/store/paths';
import { readCurrentCommittedPluginGenerations } from '@/plugins/store/registry/generationStore';
import {
  materializeZipformerVoiceModelPackPluginFixture,
  ZIPFORMER_VOICE_MODEL_PACK_FIXTURE_LOCAL_ID,
  ZIPFORMER_VOICE_MODEL_PACK_FIXTURE_PLUGIN_ID,
} from '@/plugins/testkit/voiceModelPackPackage';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createObservedForkedWorkerProcessTracker } from '../forkedWorker/processTracker.testkit';
import { createNodeModelPackInstallerHost } from '../nodeModelPackInstallerHost';
import { resolveVoiceInferencePaths } from '../voiceInferencePaths';
import type { VoiceInferenceWorkerHandle } from '../voiceInferenceWorker';
import { startVoiceInferenceWorker } from '../voiceInferenceWorker';
import { readInstalledVoiceModelPackManifest } from '../voiceModelPackInstaller';
import {
  installVoiceModelPackPluginArchiveFixture,
  VOICE_MODEL_PACK_TEST_RUNTIME_LIFECYCLE,
} from './pluginArchiveFixture';
import { createDaemonPublicVoiceModelPackRuntime as createProductionDaemonPublicVoiceModelPackRuntime } from './runtime';

function createDaemonPublicVoiceModelPackRuntime(
  params: Parameters<typeof createProductionDaemonPublicVoiceModelPackRuntime>[0],
): ReturnType<typeof createProductionDaemonPublicVoiceModelPackRuntime> {
  return createProductionDaemonPublicVoiceModelPackRuntime({
    ...params,
    readPluginFinalPolicyCurrentGenerations: async () => {
      const committed = await readCurrentCommittedPluginGenerations(resolvePluginStorePaths({
        happyHomeDir: params.happyHomeDir,
      }));
      if (!committed) return null;
      return new Map([...committed.generations].map(([pluginId, generation]) => [pluginId, {
        immutableGenerationId: generation.immutableGenerationId,
        desiredImmutableGenerationId: generation.immutableGenerationId,
        appliedImmutableGenerationId: generation.immutableGenerationId,
        distribution: generation.installation?.source.distribution ?? 'bundled',
        applied: true,
        selectedAccess: generation.installation?.optionalAccess ?? [],
      }]));
    },
  });
}

const modelRoot = process.env.HAPPIER_F34_REAL_ZIPFORMER_MODEL_DIR?.trim() ?? '';
const integrationEnabled = modelRoot.length > 0;
const expectedSourceManifestSha256 = '99d29f21ed7254df011e0d83162e255bf9ca9095b8bf43f3df45d4d1142fcb2d';
const expectedFixtureSha256 = 'eb43c6741e5ae8562de45ac30b1cf97fdab5388a3e8b9e238528e99c59ffce0c';
const expectedTranscriptSubstrings = ['confirmation', 'continuing'] as const;
const fixtureWavPath = fileURLToPath(new URL(
  '../../../../../../packages/tests/fixtures/voice/phrases/long-utterance.16k.wav',
  import.meta.url,
));

type MeasurementIsolationMode = 'in_process' | 'forked';

function resolveMeasurementIsolationModes(): readonly MeasurementIsolationMode[] {
  const raw = String(process.env.HAPPIER_F34_REAL_ZIPFORMER_ISOLATION_MODES ?? 'forked');
  const modes = raw.split(',').map((value) => value.trim().toLowerCase()).filter(
    (value): value is MeasurementIsolationMode => value === 'in_process' || value === 'forked',
  );
  return modes.length > 0 ? modes : ['forked'];
}

type FixturePluginJson = {
  id: string;
  version: string;
  contributes: {
    voiceModelPacks: Array<{
      id: string;
      manifest: {
        version: string;
        provenance: { source: string; publisher: string };
        license: {
          id: string;
          title: string;
          url: string;
          requiresAcceptance: boolean;
          text?: string;
        };
        runtime: {
          platforms: Array<'darwin' | 'linux' | 'win32'>;
          architectures: Array<'arm64' | 'x64'>;
        };
        files: Array<{
          path: string;
          url: string;
          sha256: string;
          sizeBytes: number;
        }>;
      };
    }>;
  };
};

type PublishedModelManifest = {
  packId: string;
  version: string;
  files: Array<{
    path: string;
    url: string;
    sha256: string;
    sizeBytes: number;
  }>;
};

async function sha256File(filePath: string): Promise<string> {
  return createHash('sha256').update(await readFile(filePath)).digest('hex');
}

async function readKnownProcessRssBytes(processIds: readonly number[]): Promise<number | null> {
  // RSS is optional measurement evidence. Worker identity and lifecycle come only from the
  // canonical observer, so a sandbox that rejects `ps` must not block this canary.
  if (process.platform === 'win32') return null;
  try {
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile(
        'ps',
        ['-o', 'pid=,rss=', '-p', processIds.join(',')],
        { encoding: 'utf8' },
        (error, output) => error ? reject(error) : resolve(String(output)),
      );
    });
    const rssByPid = new Map(stdout.split('\n').flatMap((line) => {
      const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
      if (!match) return [];
      return [[Number.parseInt(match[1]!, 10), Number.parseInt(match[2]!, 10) * 1024] as const];
    }));
    const values = processIds.map((pid) => rssByPid.get(pid));
    return values.every((value): value is number => typeof value === 'number')
      ? values.reduce((total, value) => total + value, 0)
      : null;
  } catch {
    return null;
  }
}

type VoiceFixturePcm = Readonly<{
  pcm16Bytes: Uint8Array;
}>;

async function readLongVoiceFixturePcm16(): Promise<Uint8Array> {
  // Reuse the repository's canonical fixture decoder instead of adding another WAV parser.
  const modulePath = '../../../../../../packages/tests/src/testkit/voice/voiceFixture.ts';
  const candidate: unknown = await import(/* @vite-ignore */ modulePath);
  if (!candidate || typeof candidate !== 'object') throw new Error('voice_fixture_testkit_unavailable');
  const readFixture = (candidate as Record<string, unknown>).readVoiceFixturePcm16;
  if (typeof readFixture !== 'function') throw new Error('voice_fixture_testkit_unavailable');
  const fixture = await (readFixture as (id: string) => Promise<VoiceFixturePcm>)('long-utterance-16k');
  return fixture.pcm16Bytes;
}

function repeatPcm16(bytes: Uint8Array, repeats: number): Uint8Array {
  return Buffer.concat(Array.from({ length: repeats }, () => Buffer.from(bytes)));
}

function createLocalPublishedAssetInstallerHost(
  assetPathByUrl: ReadonlyMap<string, string>,
) {
  return ({ packsRootDir, urlPolicy }: Parameters<typeof createNodeModelPackInstallerHost>[0]) => {
    const transport: PinnedHttpStreamTransport = async (request) => {
      if (request.url.startsWith('https://github.com/')) {
        return {
          status: 302,
          headers: {
            location: request.url.replace(
              'https://github.com/',
              'https://release-assets.githubusercontent.com/',
            ),
          },
          contentLength: 0,
          read: async () => null,
          cancel: () => undefined,
        };
      }

      const publishedUrl = request.url.replace(
        'https://release-assets.githubusercontent.com/',
        'https://github.com/',
      );
      const assetPath = assetPathByUrl.get(publishedUrl);
      if (!assetPath) throw new Error(`f34_real_asset_missing:${publishedUrl}`);
      const bytes = await readFile(assetPath);
      let delivered = false;
      return {
        status: 200,
        headers: { 'content-length': String(bytes.byteLength) },
        contentLength: bytes.byteLength,
        read: async () => {
          if (delivered) return null;
          delivered = true;
          return bytes;
        },
        cancel: () => undefined,
      };
    };

    return createNodeModelPackInstallerHost({
      packsRootDir,
      urlPolicy,
      resolveAddresses: async () => ['93.184.216.34'],
      pinnedTransport: transport,
      resolveAvailableDiskBytes: async () => 1024 * 1024 * 1024,
      minFreeDiskHeadroomBytes: 0,
    });
  };
}

async function materializePackedExternalPlugin(params: Readonly<{
  happyHomeDir: string;
  roots: string[];
}>): Promise<Readonly<{
  archiveSha256: string;
  sourceIntegrity: string;
  immutableGenerationId: string;
  pluginJson: FixturePluginJson;
  assetPathByUrl: ReadonlyMap<string, string>;
  publishedManifestSha256: string;
}>> {
  const publishedManifestPath = join(modelRoot, 'manifest.json');
  const publishedManifestSha256 = await sha256File(publishedManifestPath);
  expect(publishedManifestSha256).toBe(expectedSourceManifestSha256);
  const publishedManifest = JSON.parse(
    await readFile(publishedManifestPath, 'utf8'),
  ) as PublishedModelManifest;
  expect(publishedManifest).toMatchObject({
    packId: 'sherpa-onnx-streaming-zipformer-en-20M-2023-02-17',
    version: 'sherpa-onnx-streaming-zipformer-en-20M-2023-02-17-int8',
  });

  const archiveSourceRoot = await mkdtemp(join(tmpdir(), 'happier-f34-real-plugin-'));
  params.roots.push(archiveSourceRoot);
  const archiveRoot = join(archiveSourceRoot, 'package');
  await materializeZipformerVoiceModelPackPluginFixture(archiveRoot);

  const pluginJsonPath = join(archiveRoot, '.happier-plugin', 'plugin.json');
  const pluginJson = JSON.parse(await readFile(pluginJsonPath, 'utf8')) as FixturePluginJson;
  const contribution = pluginJson.contributes.voiceModelPacks[0]!;
  const exactLicenseText = await readFile(join(modelRoot, 'LICENSES', 'Apache-2.0.txt'), 'utf8');
  if (
    (process.platform !== 'darwin' && process.platform !== 'linux' && process.platform !== 'win32')
    || (process.arch !== 'arm64' && process.arch !== 'x64')
  ) {
    throw new Error(`voice_model_pack_real_fixture_host_unsupported:${process.platform}-${process.arch}`);
  }
  contribution.manifest.runtime.platforms = [process.platform];
  contribution.manifest.runtime.architectures = [process.arch];
  contribution.manifest.license = {
    ...contribution.manifest.license,
    requiresAcceptance: true,
    text: exactLicenseText,
  };

  expect(pluginJson).toMatchObject({
    id: ZIPFORMER_VOICE_MODEL_PACK_FIXTURE_PLUGIN_ID,
    version: '0.1.0',
  });
  expect(contribution).toMatchObject({
    id: ZIPFORMER_VOICE_MODEL_PACK_FIXTURE_LOCAL_ID,
    manifest: {
      version: '2023.2.17',
      provenance: {
        source: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-streaming-zipformer-en-20M-2023-02-17.tar.bz2',
        publisher: 'k2-fsa',
      },
      license: {
        id: 'Apache-2.0',
        url: 'https://www.apache.org/licenses/LICENSE-2.0',
        requiresAcceptance: true,
      },
    },
  });

  const publishedFiles = new Map(publishedManifest.files.map((file) => [file.path, file]));
  const assetPathByUrl = new Map<string, string>();
  for (const file of contribution.manifest.files) {
    expect(file).toEqual(publishedFiles.get(file.path));
    const assetPath = join(modelRoot, ...file.path.split('/'));
    expect(await stat(assetPath)).toMatchObject({ size: file.sizeBytes });
    expect(await sha256File(assetPath)).toBe(file.sha256);
    assetPathByUrl.set(file.url, assetPath);
  }
  expect(assetPathByUrl.size).toBe(8);

  await writeFile(pluginJsonPath, JSON.stringify(pluginJson, null, 2), 'utf8');
  const installed = await installVoiceModelPackPluginArchiveFixture({
    happyHomeDir: params.happyHomeDir,
    archiveSourceRoot,
    packageRoot: archiveRoot,
    archiveFileName: 'zipformer-plugin.tgz',
    interactionId: 'voice-model-pack-real-fixture-install',
  });

  return {
    archiveSha256: installed.archiveSha256,
    sourceIntegrity: installed.sourceIntegrity,
    immutableGenerationId: installed.immutableGenerationId,
    pluginJson,
    assetPathByUrl,
    publishedManifestSha256,
  };
}

describe.runIf(integrationEnabled)('real daemon public Voice model-pack lifecycle', () => {
  const roots: string[] = [];
  const workers: VoiceInferenceWorkerHandle[] = [];
  const observedForkedWorkers = createObservedForkedWorkerProcessTracker();
  const envScope = createEnvKeyScope([
    'HAPPIER_HOME_DIR',
    'HAPPIER_CLI_SUBPROCESS_PREFER_TSX',
    'HAPPIER_VOICE_INFERENCE_WORKER_REQUEST_TIMEOUT_MS',
    'HAPPIER_F34_REAL_ZIPFORMER_ISOLATION_MODES',
  ]);

  afterEach(async () => {
    await Promise.all(workers.splice(0).map(async (worker) => await worker.stop().catch(() => undefined)));
    envScope.restore();
    reloadConfiguration();
    await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
  });

  it('installs exact published bytes, infers through the worker before and after restart, then removes the pack', async () => {
    expect(await sha256File(fixtureWavPath)).toBe(expectedFixtureSha256);
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-f34-real-home-'));
    roots.push(happyHomeDir);
    envScope.patch({
      HAPPIER_HOME_DIR: happyHomeDir,
      // Keep the integration on the current source closure. Forked mode spawns the real hidden
      // CLI worker in a separate OS process; in-process mode exercises the same owner directly.
      // A mutable package-dist can legitimately lag the source/protocol packages during
      // development and is covered by release packaging.
      HAPPIER_CLI_SUBPROCESS_PREFER_TSX: 'true',
      HAPPIER_VOICE_INFERENCE_WORKER_REQUEST_TIMEOUT_MS: '240000',
    });
    reloadConfiguration();

    const packed = await materializePackedExternalPlugin({ happyHomeDir, roots });
    expect(packed.sourceIntegrity).toMatch(/^sha256-/);
    const paths = resolveVoiceInferencePaths();
    const qualifiedPackId = `${ZIPFORMER_VOICE_MODEL_PACK_FIXTURE_PLUGIN_ID}/${ZIPFORMER_VOICE_MODEL_PACK_FIXTURE_LOCAL_ID}`;
    const isolationModes = resolveMeasurementIsolationModes();
    const firstIsolationMode = isolationModes[0] ?? 'forked';
    const initialPublicRuntime = createDaemonPublicVoiceModelPackRuntime({
      accountId: 'account-f34-real',
      machineId: 'machine-f34-real',
      happyHomeDir,
      paths,
      createInstallerHost: createLocalPublishedAssetInstallerHost(packed.assetPathByUrl),
    });
    const initialWorker = await startVoiceInferenceWorker({
      publicModelPacks: initialPublicRuntime,
      isolationMode: firstIsolationMode,
      onForkedWorkerProcess: observedForkedWorkers.observe,
    });
    workers.push(initialWorker);
    const [blockedStatus] = await initialWorker.listModels();
    expect(blockedStatus).toMatchObject({
      packId: qualifiedPackId,
      pluginIdentity: {
        pluginId: ZIPFORMER_VOICE_MODEL_PACK_FIXTURE_PLUGIN_ID,
        packId: ZIPFORMER_VOICE_MODEL_PACK_FIXTURE_LOCAL_ID,
      },
      installState: 'not_installed',
      runtimeSupported: false,
      licenseReview: {
        pluginVersion: '0.1.0',
        packVersion: '2023.2.17',
        licenseId: 'Apache-2.0',
        licenseSourceUrl: 'https://www.apache.org/licenses/LICENSE-2.0',
        artifactBinding: {
          kind: 'sourceIntegrity',
          integrity: packed.sourceIntegrity,
        },
        accepted: false,
      },
    });
    const licenseReview = blockedStatus!.licenseReview!;
    expect(licenseReview.licenseTextDigest).toBe(
      deriveVoiceModelPackLicenseTextDigestV1(licenseReview.licenseText),
    );
    await expect(initialWorker.installModel({ packId: qualifiedPackId })).rejects.toMatchObject({
      code: 'unsupported_runtime_family',
    });
    const acceptedStatus = await initialWorker.acceptModelPackLicense({
      qualifiedPackId,
      pluginId: licenseReview.pluginId,
      packId: licenseReview.packId,
      pluginVersion: licenseReview.pluginVersion,
      packVersion: licenseReview.packVersion,
      licenseId: licenseReview.licenseId,
      licenseSourceUrl: licenseReview.licenseSourceUrl,
      licenseTextDigest: licenseReview.licenseTextDigest,
      artifactBinding: licenseReview.artifactBinding,
    });
    await expect(initialPublicRuntime.resolve(qualifiedPackId)).resolves.toMatchObject({
      descriptor: expect.objectContaining({
        status: 'available',
        reason: null,
      }),
    });
    expect(acceptedStatus).toMatchObject({
      packId: qualifiedPackId,
      runtimeSupported: true,
      licenseReview: { accepted: true },
    });

    const installedStatus = await initialWorker.installModel({ packId: qualifiedPackId });
    expect(installedStatus).toMatchObject({
      packId: qualifiedPackId,
      installState: 'installed',
      runtimeSupported: true,
    });
    const installedEntry = await initialPublicRuntime.resolve(qualifiedPackId);
    expect(installedEntry?.installedMetadata).toMatchObject({
      pluginVersion: '0.1.0',
      artifactBinding: {
        kind: 'sourceIntegrity',
        integrity: packed.sourceIntegrity,
      },
      packVersion: '2023.2.17',
      manifestDigest: deriveVoiceModelPackManifestDigestV1(
        packed.pluginJson.contributes.voiceModelPacks[0]!.manifest as Parameters<typeof deriveVoiceModelPackManifestDigestV1>[0],
      ),
    });
    expect(installedEntry?.installedManifest?.files).toEqual(
      packed.pluginJson.contributes.voiceModelPacks[0]!.manifest.files,
    );

    await mkdir(paths.tempDir, { recursive: true });
    const uploadPath = join(paths.tempDir, 'f34-real-long-utterance.16k.wav');
    await copyFile(fixtureWavPath, uploadPath);
    const longPcm16 = repeatPcm16(await readLongVoiceFixturePcm16(), 10);
    let finalWorker: VoiceInferenceWorkerHandle = initialWorker;
    let finalForkedWorkerPid: number | null = null;
    const modeEvidence: Array<Readonly<Record<string, unknown>>> = [];
    for (const [modeIndex, isolationMode] of isolationModes.entries()) {
      const firstWorker = modeIndex === 0
        ? initialWorker
        : await startVoiceInferenceWorker({
          publicModelPacks: createDaemonPublicVoiceModelPackRuntime({
            accountId: 'account-f34-real',
            machineId: 'machine-f34-real',
            happyHomeDir,
            paths,
          }),
          isolationMode,
          onForkedWorkerProcess: observedForkedWorkers.observe,
        });
      if (modeIndex > 0) workers.push(firstWorker);

      // Each transcription consumes the staged upload through the production owner.
      // Re-stage it at the mode boundary so a multi-mode measurement compares runtimes
      // instead of inheriting the previous mode's cleanup.
      await copyFile(fixtureWavPath, uploadPath);
      const parentRssBeforeWarm = await readKnownProcessRssBytes([process.pid])
        ?? process.memoryUsage().rss;
      const firstWarmStartedAt = performance.now();
      await firstWorker.warmModelPack(qualifiedPackId);
      const firstWarmMs = performance.now() - firstWarmStartedAt;
      const firstForkedWorkerPid = isolationMode === 'forked'
        ? await observedForkedWorkers.waitForNewPid()
        : null;
      if (isolationMode === 'in_process') {
        expect(observedForkedWorkers.activePids()).toEqual([]);
      }
      const parentRssAfterWarm = await readKnownProcessRssBytes([process.pid])
        ?? process.memoryUsage().rss;
      const firstProcessTreeRssAfterWarm = firstForkedWorkerPid === null
        ? null
        : await readKnownProcessRssBytes([process.pid, firstForkedWorkerPid]);
      const firstForkedWorkerRssAfterWarm = firstForkedWorkerPid === null
        ? null
        : await readKnownProcessRssBytes([firstForkedWorkerPid]);
      const [warmedModelStatus] = await firstWorker.listModels();
      const firstInferenceStartedAt = performance.now();
      const firstTranscript = await firstWorker.transcribeAudio({
        requestId: `f34-real-${isolationMode}-first-inference`,
        uploadId: `f34-real-${isolationMode}-first-upload`,
        filePath: uploadPath,
        inputMimeType: 'audio/wav',
        packId: qualifiedPackId,
        language: 'en',
        normalization: {
          inputTransport: 'upload_transfer',
          strategy: 'ui_pretranscoded_pcm16_fallback',
          systemFfmpegAllowed: false,
        },
      });
      const firstInferenceMs = performance.now() - firstInferenceStartedAt;
      const normalizedFirstTranscript = firstTranscript.text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      expect(normalizedFirstTranscript.length).toBeGreaterThan(10);
      for (const expected of expectedTranscriptSubstrings) {
        expect(normalizedFirstTranscript).toContain(expected);
      }

      const activeCancellationRequestId = `f34-real-${isolationMode}-active-cancel`;
      const activeCancellationSession = await firstWorker.createStreamingTranscriptionSession({
        requestId: activeCancellationRequestId,
        packId: qualifiedPackId,
        language: 'en',
        format: DAEMON_VOICE_INFERENCE_STT_STREAM_PCM_FORMAT,
      });
      let activeAppendSettled = false;
      const activeAppendOutcome = activeCancellationSession.appendPcm16({
        seq: 0,
        pcm16Bytes: longPcm16,
      }).then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      ).finally(() => {
        activeAppendSettled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 75));
      expect(activeAppendSettled).toBe(false);
      const cancellationStartedAt = performance.now();
      await firstWorker.cancelStt(activeCancellationRequestId);
      const activeCancellationOutcome = await activeAppendOutcome;
      const cancellationSettlementMs = performance.now() - cancellationStartedAt;
      expect(activeCancellationOutcome).toMatchObject({ ok: false, error: { code: 'cancelled' } });
      await activeCancellationSession.close().catch(() => undefined);

      const firstStopStartedAt = performance.now();
      await firstWorker.stop();
      workers.splice(workers.indexOf(firstWorker), 1);
      const firstStopMs = performance.now() - firstStopStartedAt;
      const firstForkedCleanupMs = firstForkedWorkerPid !== null
        ? (await observedForkedWorkers.waitForTermination(firstForkedWorkerPid), performance.now() - firstStopStartedAt)
        : null;
      const restartedWorker = await startVoiceInferenceWorker({
        publicModelPacks: createDaemonPublicVoiceModelPackRuntime({
          accountId: 'account-f34-real',
          machineId: 'machine-f34-real',
          happyHomeDir,
          paths,
        }),
        isolationMode,
        onForkedWorkerProcess: observedForkedWorkers.observe,
      });
      workers.push(restartedWorker);

      const restartParentRssBeforeWarm = await readKnownProcessRssBytes([process.pid])
        ?? process.memoryUsage().rss;
      const restartWarmStartedAt = performance.now();
      await restartedWorker.warmModelPack(qualifiedPackId);
      const restartWarmMs = performance.now() - restartWarmStartedAt;
      const restartedForkedWorkerPid = isolationMode === 'forked'
        ? await observedForkedWorkers.waitForNewPid(firstForkedWorkerPid === null ? [] : [firstForkedWorkerPid])
        : null;
      if (firstForkedWorkerPid !== null && restartedForkedWorkerPid !== null) {
        expect(restartedForkedWorkerPid).not.toBe(firstForkedWorkerPid);
      }
      const restartParentRssAfterWarm = await readKnownProcessRssBytes([process.pid])
        ?? process.memoryUsage().rss;
      const restartProcessTreeRssAfterWarm = restartedForkedWorkerPid === null
        ? null
        : await readKnownProcessRssBytes([process.pid, restartedForkedWorkerPid]);
      const restartedForkedWorkerRssAfterWarm = restartedForkedWorkerPid === null
        ? null
        : await readKnownProcessRssBytes([restartedForkedWorkerPid]);
      const [restartWarmedModelStatus] = await restartedWorker.listModels();
      await copyFile(fixtureWavPath, uploadPath);
      const restartInferenceStartedAt = performance.now();
      const restartedTranscript = await restartedWorker.transcribeAudio({
        requestId: `f34-real-${isolationMode}-restarted-inference`,
        uploadId: `f34-real-${isolationMode}-restarted-upload`,
        filePath: uploadPath,
        inputMimeType: 'audio/wav',
        packId: qualifiedPackId,
        language: 'en',
        normalization: {
          inputTransport: 'upload_transfer',
          strategy: 'ui_pretranscoded_pcm16_fallback',
          systemFfmpegAllowed: false,
        },
      });
      const restartInferenceMs = performance.now() - restartInferenceStartedAt;
      const normalizedRestartedTranscript = restartedTranscript.text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      for (const expected of expectedTranscriptSubstrings) {
        expect(normalizedRestartedTranscript).toContain(expected);
      }

      let crashIsolation: Readonly<Record<string, unknown>> = {
        applicable: false,
        reason: isolationMode === 'forked'
          ? 'forked_worker_not_observed'
          : 'in_process_has_no_crash_boundary',
      };
      let activeForkedWorkerPid = restartedForkedWorkerPid;
      if (restartedForkedWorkerPid !== null) {
        const crashRequestId = `f34-real-${isolationMode}-crash-containment`;
        const crashSession = await restartedWorker.createStreamingTranscriptionSession({
          requestId: crashRequestId,
          packId: qualifiedPackId,
          language: 'en',
          format: DAEMON_VOICE_INFERENCE_STT_STREAM_PCM_FORMAT,
        });
        let crashAppendSettled = false;
        const crashAppendOutcome = crashSession.appendPcm16({
          seq: 0,
          pcm16Bytes: longPcm16,
        }).then(
          (value) => ({ ok: true as const, value }),
          (error: unknown) => ({ ok: false as const, error }),
        ).finally(() => {
          crashAppendSettled = true;
        });
        await new Promise((resolve) => setTimeout(resolve, 75));
        expect(crashAppendSettled).toBe(false);
        const crashStartedAt = performance.now();
        process.kill(restartedForkedWorkerPid, 'SIGKILL');
        const crashOutcome = await crashAppendOutcome;
        const crashSettlementMs = performance.now() - crashStartedAt;
        expect(crashOutcome).toMatchObject({ ok: false, error: { code: 'runtime_unavailable' } });
        await observedForkedWorkers.waitForTermination(restartedForkedWorkerPid);
        await restartedWorker.cancelStt(crashRequestId);
        await crashSession.close().catch(() => undefined);

        await copyFile(fixtureWavPath, uploadPath);
        const recoveryStartedAt = performance.now();
        const recoveredTranscriptPromise = restartedWorker.transcribeAudio({
          requestId: `f34-real-${isolationMode}-post-crash-inference`,
          uploadId: `f34-real-${isolationMode}-post-crash-upload`,
          filePath: uploadPath,
          inputMimeType: 'audio/wav',
          packId: qualifiedPackId,
          language: 'en',
          normalization: {
            inputTransport: 'upload_transfer',
            strategy: 'ui_pretranscoded_pcm16_fallback',
            systemFfmpegAllowed: false,
          },
        });
        const recoveredForkedWorkerPid = await observedForkedWorkers.waitForNewPid([restartedForkedWorkerPid]);
        expect(recoveredForkedWorkerPid).not.toBe(restartedForkedWorkerPid);
        const recoveredTranscript = await recoveredTranscriptPromise;
        const recoveryInferenceMs = performance.now() - recoveryStartedAt;
        const normalizedRecoveredTranscript = recoveredTranscript.text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
        for (const expected of expectedTranscriptSubstrings) {
          expect(normalizedRecoveredTranscript).toContain(expected);
        }
        activeForkedWorkerPid = recoveredForkedWorkerPid;
        crashIsolation = {
          applicable: true,
          activeRequestRejected: 'runtime_unavailable',
          daemonProcessSurvived: true,
          replacementProcessDistinct: true,
          postCrashInferenceSucceeded: true,
          crashSettlementMs: Math.round(crashSettlementMs),
          recoveryInferenceMs: Math.round(recoveryInferenceMs),
        };
      }

      modeEvidence.push({
        mode: isolationMode,
        firstTranscript: firstTranscript.text,
        restartedTranscript: restartedTranscript.text,
        coldWarmMs: Math.round(firstWarmMs),
        coldInferenceMs: Math.round(firstInferenceMs),
        firstWarmMs: Math.round(firstWarmMs),
        firstInferenceMs: Math.round(firstInferenceMs),
        restartWarmMs: Math.round(restartWarmMs),
        restartInferenceMs: Math.round(restartInferenceMs),
        cancellationSettlementMs: Math.round(cancellationSettlementMs),
        activeCancellation: 'admitted 71-second streaming append remained pending before cancellation',
        parentRssBeforeWarm,
        parentRssAfterWarm,
        processTreeRssAfterWarm: firstProcessTreeRssAfterWarm,
        forkChildRssAfterWarm: firstForkedWorkerRssAfterWarm,
        restartParentRssBeforeWarm,
        restartParentRssAfterWarm,
        restartProcessTreeRssAfterWarm,
        restartForkChildRssAfterWarm: restartedForkedWorkerRssAfterWarm,
        loadedArtifactBytes: warmedModelStatus?.loadedArtifactBytes ?? null,
        restartLoadedArtifactBytes: restartWarmedModelStatus?.loadedArtifactBytes ?? null,
        firstStopMs: Math.round(firstStopMs),
        firstForkedCleanupMs: firstForkedCleanupMs === null ? null : Math.round(firstForkedCleanupMs),
        restartUsedDistinctProcess: firstForkedWorkerPid !== null && restartedForkedWorkerPid !== null ? true : null,
        crashIsolation,
      });
      finalWorker = restartedWorker;
      finalForkedWorkerPid = activeForkedWorkerPid;

      if (modeIndex < isolationModes.length - 1) {
        await restartedWorker.stop();
        workers.splice(workers.indexOf(restartedWorker), 1);
        if (activeForkedWorkerPid !== null) await observedForkedWorkers.waitForTermination(activeForkedWorkerPid);
      }
    }

    const pluginStore = createPluginRegistryStateStore({
      happyHomeDir,
      runtimeLifecycle: VOICE_MODEL_PACK_TEST_RUNTIME_LIFECYCLE,
    });
    await pluginStore.update((current) => ({
      ...current,
      plugins: {
        ...current.plugins,
        [ZIPFORMER_VOICE_MODEL_PACK_FIXTURE_PLUGIN_ID]: {
          ...current.plugins[ZIPFORMER_VOICE_MODEL_PACK_FIXTURE_PLUGIN_ID]!,
          state: {
            ...current.plugins[ZIPFORMER_VOICE_MODEL_PACK_FIXTURE_PLUGIN_ID]!.state,
            enabled: false,
          },
        },
      },
    }));
    await expect(finalWorker.listModels()).resolves.toEqual([
      expect.objectContaining({
        packId: qualifiedPackId,
        installState: 'installed',
        runtimeSupported: false,
      }),
    ]);
    await expect(finalWorker.warmModelPack(qualifiedPackId)).rejects.toMatchObject({
      code: 'model_not_installed',
    });

    await pluginStore.uninstall(ZIPFORMER_VOICE_MODEL_PACK_FIXTURE_PLUGIN_ID);
    await finalWorker.removeModel(qualifiedPackId);
    await expect(finalWorker.listModels()).resolves.toEqual([]);
    expect((await pluginStore.read()).plugins[ZIPFORMER_VOICE_MODEL_PACK_FIXTURE_PLUGIN_ID]).toBeUndefined();
    await expect(readInstalledVoiceModelPackManifest({
      packsRootDir: paths.packsRootDir,
      packId: installedEntry!.directoryKey,
    })).resolves.toBeNull();
    await expect(stat(join(paths.packsRootDir, installedEntry!.directoryKey))).rejects.toMatchObject({ code: 'ENOENT' });

    const finalStopStartedAt = performance.now();
    await finalWorker.stop();
    workers.splice(workers.indexOf(finalWorker), 1);
    const finalStopMs = performance.now() - finalStopStartedAt;
    const finalForkedCleanupMs = finalForkedWorkerPid !== null
      ? (await observedForkedWorkers.waitForTermination(finalForkedWorkerPid), performance.now() - finalStopStartedAt)
      : null;
    expect(observedForkedWorkers.activePids()).toEqual([]);

    console.info('F34_REAL_DAEMON_EVIDENCE', JSON.stringify({
      pluginId: ZIPFORMER_VOICE_MODEL_PACK_FIXTURE_PLUGIN_ID,
      pluginVersion: '0.1.0',
      packId: ZIPFORMER_VOICE_MODEL_PACK_FIXTURE_LOCAL_ID,
      packVersion: '2023.2.17',
      sourceIntegrity: packed.sourceIntegrity,
      immutableGenerationId: packed.immutableGenerationId,
      archiveSha256: packed.archiveSha256,
      publishedManifestSha256: packed.publishedManifestSha256,
      fixtureSha256: expectedFixtureSha256,
      isolationModes,
      modeEvidence,
      finalStopMs: Math.round(finalStopMs),
      finalForkedCleanupMs: finalForkedCleanupMs === null ? null : Math.round(finalForkedCleanupMs),
      orphanCheck: 'no_observed_voice_inference_worker_alive_after_final_stop',
      removal: 'plugin uninstalled and model directory absent',
    }));
  }, 600_000);
});
