import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { reloadConfiguration } from '@/configuration';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createPluginRegistryStateStore } from '@/plugins/store/registry/currentState';
import { readInstalledPluginCatalogSnapshot } from '@/plugins/projection/catalog/installed';
import { resolvePluginStorePaths } from '@/plugins/store/paths';
import { readCurrentCommittedPluginGenerations } from '@/plugins/store/registry/generationStore';
import {
  materializeZipformerVoiceModelPackPluginFixture,
  ZIPFORMER_VOICE_MODEL_PACK_FIXTURE_LOCAL_ID,
  ZIPFORMER_VOICE_MODEL_PACK_FIXTURE_PLUGIN_ID,
} from '@/plugins/testkit/voiceModelPackPackage';
import { startVoiceInferenceWorker } from '../voiceInferenceWorker';
import { deriveVoiceModelPackLicenseTextDigestV1 } from '@happier-dev/voice-modelpacks';
import { resolveVoiceInferencePaths } from '../voiceInferencePaths';
import { readInstalledVoiceModelPackManifest } from '../voiceModelPackInstaller';
import { createNodeModelPackInstallerHost } from '../modelPackInstallerHost.node';
import type { PinnedHttpStreamTransport } from '@/network/pinnedHttp';
import {
  installVoiceModelPackPluginArchiveFixture,
  VOICE_MODEL_PACK_TEST_RUNTIME_LIFECYCLE,
} from './pluginArchiveFixture';
import {
  createDaemonPublicVoiceModelPackRuntime as createProductionDaemonPublicVoiceModelPackRuntime,
  resolveDefaultDaemonVoiceModelPackHostCapabilities,
} from './runtime';

function createDaemonPublicVoiceModelPackRuntime(
  params: Parameters<typeof createProductionDaemonPublicVoiceModelPackRuntime>[0],
): ReturnType<typeof createProductionDaemonPublicVoiceModelPackRuntime> {
  return createProductionDaemonPublicVoiceModelPackRuntime({
    ...params,
    host: params.host ?? {
      executionHost: 'daemon',
      hostVersion: '0.2.10',
      platform: 'linux',
      architecture: 'x64',
      runtimeFamilies: {
        sherpa_zipformer_streaming: { abiVersion: 1 },
      },
    },
    readPluginFinalPolicyCurrentGenerations: params.readPluginFinalPolicyCurrentGenerations ?? (async () => {
      const committed = await readCurrentCommittedPluginGenerations(resolvePluginStorePaths({
        happyHomeDir: params.happyHomeDir,
      }));
      if (!committed) return null;
      return new Map([...committed.generations].map(([pluginId, generation]) => [pluginId, {
        immutableGenerationId: generation.immutableGenerationId,
        manifestDigest: generation.record.manifestDigest,
        packageDigest: generation.record.packageDigest,
        distribution: generation.installation?.source.distribution ?? 'bundled',
        applied: true,
        selectedAccess: generation.installation?.optionalAccess ?? [],
      }]));
    }),
  });
}

function createMonoPcm16WavBuffer(sampleCount = 4, sampleRate = 16_000): Buffer {
  const dataSize = sampleCount * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataSize, 40);
  return buffer;
}

async function installZipformerPluginFixture(params: Readonly<{
  happyHomeDir: string;
  roots: string[];
  requireLicenseAcceptance?: boolean;
}>): Promise<ReadonlyMap<string, Uint8Array>> {
  const archiveSourceRoot = await mkdtemp(join(tmpdir(), 'happier-public-model-pack-archive-'));
  params.roots.push(archiveSourceRoot);
  const archiveRoot = join(archiveSourceRoot, 'package');
  await materializeZipformerVoiceModelPackPluginFixture(archiveRoot);
  const pluginJsonPath = join(archiveRoot, '.happier-plugin', 'plugin.json');
  type FixturePluginJson = {
    contributes: { voiceModelPacks: Array<{ manifest: {
      license: {
        id: string;
        title: string;
        url: string;
        requiresAcceptance: boolean;
        text?: string;
      };
      files: Array<{
      path: string;
      url: string;
      sha256: string;
      sizeBytes: number;
    }> } }> };
  };
  const pluginJson = JSON.parse(await readFile(pluginJsonPath, 'utf8')) as FixturePluginJson;
  if (params.requireLicenseAcceptance) {
    pluginJson.contributes.voiceModelPacks[0]!.manifest.license = {
      ...pluginJson.contributes.voiceModelPacks[0]!.manifest.license,
      requiresAcceptance: true,
      text: 'Exact fixture model license terms.',
    };
  }
  const assets = new Map<string, Uint8Array>();
  for (const file of pluginJson.contributes.voiceModelPacks[0]!.manifest.files) {
    const bytes = new TextEncoder().encode(`fixture:${file.path}`);
    file.url = `https://github.com/happier-dev/happier-assets/releases/download/test/${encodeURIComponent(file.path)}`;
    file.sha256 = createHash('sha256').update(bytes).digest('hex');
    file.sizeBytes = bytes.byteLength;
    assets.set(file.url, bytes);
  }
  await writeFile(pluginJsonPath, JSON.stringify(pluginJson, null, 2), 'utf8');
  await installVoiceModelPackPluginArchiveFixture({
    happyHomeDir: params.happyHomeDir,
    archiveSourceRoot,
    packageRoot: archiveRoot,
    archiveFileName: 'zipformer-plugin.tgz',
    interactionId: 'voice-model-pack-fixture-install',
  });
  return assets;
}

function createFixtureInstallerHostFactory(
  assets: ReadonlyMap<string, Uint8Array>,
  onBodyComplete?: () => void,
) {
  return ({ packsRootDir, urlPolicy }: Parameters<typeof createNodeModelPackInstallerHost>[0]) => {
    const transport: PinnedHttpStreamTransport = async (request) => {
      if (request.url.startsWith('https://github.com/')) {
        return {
          status: 302,
          headers: { location: request.url.replace('https://github.com/', 'https://release-assets.githubusercontent.com/') },
          contentLength: 0,
          read: async () => null,
          cancel: () => undefined,
        };
      }
      const sourceUrl = request.url.replace('https://release-assets.githubusercontent.com/', 'https://github.com/');
      const bytes = assets.get(sourceUrl);
      if (!bytes) throw new Error(`fixture_asset_missing:${sourceUrl}`);
      let delivered = false;
      return {
        status: 200,
        headers: { 'content-length': String(bytes.byteLength) },
        contentLength: bytes.byteLength,
        read: async () => {
          if (delivered) {
            onBodyComplete?.();
            return null;
          }
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

describe('daemon public Voice model-pack consumed vertical', () => {
  const roots: string[] = [];
  const envScope = createEnvKeyScope(['HAPPIER_HOME_DIR']);

  afterEach(async () => {
    envScope.restore();
    reloadConfiguration();
    await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
  });

  it.each([
    ['darwin', 'arm64'],
    ['darwin', 'x64'],
    ['linux', 'arm64'],
    ['linux', 'x64'],
    ['win32', 'x64'],
  ] as const)('advertises the owned Sherpa runtime target %s-%s', (platform, architecture) => {
    expect(resolveDefaultDaemonVoiceModelPackHostCapabilities(platform, architecture)).toMatchObject({
      executionHost: 'daemon',
      platform,
      architecture,
      runtimeFamilies: {
        sherpa_zipformer_streaming: { abiVersion: 1 },
        sherpa_kokoro_offline: { abiVersion: 1 },
      },
    });
  });

  it('does not advertise Windows arm64 without an owned Sherpa package/archive/runtime target', () => {
    expect(resolveDefaultDaemonVoiceModelPackHostCapabilities('win32', 'arm64')).toBeNull();
  });

  it('fails startup closed when a scoped promotion recovery payload is malformed', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-public-model-pack-home-'));
    roots.push(happyHomeDir);
    envScope.patch({ HAPPIER_HOME_DIR: happyHomeDir });
    reloadConfiguration();
    const paths = resolveVoiceInferencePaths();
    await mkdir(paths.packsRootDir, { recursive: true });
    const intentPath = join(paths.packsRootDir, '.malformed-recovery.promote-intent');
    await writeFile(intentPath, JSON.stringify({
      schemaVersion: 1,
      packId: 'malformed-recovery',
      phase: 'metadata_pending',
      startedAtMs: Date.now(),
      token: 'token',
      priorInstall: null,
      recovery: {
        kind: 'daemon_public_voice_model_pack_state_v1',
        value: {
          accountId: 'account-fixture',
          machineId: 'machine-fixture',
          before: null,
          after: { schemaVersion: 1 },
        },
      },
    }), 'utf8');

    const publicModelPacks = createDaemonPublicVoiceModelPackRuntime({
      accountId: 'account-fixture',
      machineId: 'machine-fixture',
      happyHomeDir,
      paths,
    });
    await expect(publicModelPacks.ready()).rejects.toThrow('voice_model_pack_promotion_recovery_invalid');
    expect(await readFile(intentPath, 'utf8')).toContain('metadata_pending');
  });

  it('installs a trusted archive contribution through the real installer and dispatches through the worker', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-public-model-pack-home-'));
    roots.push(happyHomeDir);
    envScope.patch({ HAPPIER_HOME_DIR: happyHomeDir });
    reloadConfiguration();
    const assets = await installZipformerPluginFixture({ happyHomeDir, roots, requireLicenseAcceptance: true });

    const paths = resolveVoiceInferencePaths();
    const publicModelPacks = createDaemonPublicVoiceModelPackRuntime({
      accountId: 'account-fixture',
      machineId: 'machine-fixture',
      happyHomeDir,
      paths,
      createInstallerHost: createFixtureInstallerHostFactory(assets),
    });
    const qualifiedPackId = `${ZIPFORMER_VOICE_MODEL_PACK_FIXTURE_PLUGIN_ID}/${ZIPFORMER_VOICE_MODEL_PACK_FIXTURE_LOCAL_ID}`;

    const blockedEntry = (await publicModelPacks.list())[0]!;
    expect(blockedEntry).toMatchObject({
      key: qualifiedPackId,
      descriptor: expect.objectContaining({
        status: 'blocked',
        reason: 'license_acceptance_required',
        identity: {
          pluginId: ZIPFORMER_VOICE_MODEL_PACK_FIXTURE_PLUGIN_ID,
          packId: ZIPFORMER_VOICE_MODEL_PACK_FIXTURE_LOCAL_ID,
        },
      }),
    });
    const blockedDescriptor = blockedEntry.descriptor!;
    const blockedContribution = blockedDescriptor.contribution!;
    await expect(publicModelPacks.acceptLicense({
      qualifiedPackId,
      pluginId: blockedDescriptor.identity!.pluginId,
      packId: blockedDescriptor.identity!.packId,
      pluginVersion: blockedDescriptor.pluginVersion,
      packVersion: blockedContribution.manifest.version,
      licenseId: blockedContribution.manifest.license.id,
      licenseSourceUrl: blockedContribution.manifest.license.url,
      licenseTextDigest: deriveVoiceModelPackLicenseTextDigestV1(blockedContribution.manifest.license.text!),
      artifactDigest: blockedDescriptor.sourceDigest!,
    })).resolves.toMatchObject({
      key: qualifiedPackId,
      descriptor: expect.objectContaining({ status: 'available' }),
    });

    const runtimeInputs: string[] = [];
    const worker = await startVoiceInferenceWorker({
      publicModelPacks,
      runtimeLoader: async () => ({
        warmModel: async ({ packId, runtimeDescriptor }) => {
          runtimeInputs.push(`${packId}:${runtimeDescriptor?.family ?? 'missing'}`);
        },
        synthesizeTts: async () => {
          throw new Error('not a TTS fixture');
        },
        transcribeAudio: async ({ packId, runtimeDescriptor }) => {
          runtimeInputs.push(`${packId}:${runtimeDescriptor?.family ?? 'missing'}`);
          return { text: 'zipformer fixture transcript', language: 'en' };
        },
      }),
    });

    await expect(worker.installModel({ packId: qualifiedPackId })).resolves.toMatchObject({
      packId: qualifiedPackId,
      pluginIdentity: {
        pluginId: ZIPFORMER_VOICE_MODEL_PACK_FIXTURE_PLUGIN_ID,
        packId: ZIPFORMER_VOICE_MODEL_PACK_FIXTURE_LOCAL_ID,
      },
      installState: 'installed',
      runtimeSupported: true,
    });
    await expect(readInstalledVoiceModelPackManifest({
      packsRootDir: paths.packsRootDir,
      packId: (await publicModelPacks.resolve(qualifiedPackId))!.directoryKey,
    })).resolves.toMatchObject({ version: '2023.2.17' });

    const uploadPath = join(paths.tempDir, 'public-zipformer.wav');
    await writeFile(uploadPath, createMonoPcm16WavBuffer());
    await expect(worker.transcribeAudio({
      requestId: 'public-zipformer-stt',
      uploadId: 'public-zipformer-upload',
      filePath: uploadPath,
      inputMimeType: 'audio/wav',
      packId: qualifiedPackId,
      language: 'en',
      normalization: {
        inputTransport: 'upload_transfer',
        strategy: 'daemon_decode',
        systemFfmpegAllowed: false,
      },
    })).resolves.toMatchObject({
      text: 'zipformer fixture transcript',
      modelPackId: qualifiedPackId,
    });
    expect(runtimeInputs).toEqual([
      `${qualifiedPackId}:sherpa_zipformer_streaming`,
      `${qualifiedPackId}:sherpa_zipformer_streaming`,
    ]);

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
    await expect(worker.listModels()).resolves.toEqual([
      expect.objectContaining({
        packId: qualifiedPackId,
        installState: 'installed',
        runtimeSupported: false,
      }),
    ]);
    await expect(worker.warmModelPack(qualifiedPackId)).rejects.toMatchObject({ code: 'model_not_installed' });

    await worker.stop();
    await pluginStore.uninstall(ZIPFORMER_VOICE_MODEL_PACK_FIXTURE_PLUGIN_ID);
    const restarted = await startVoiceInferenceWorker({
      publicModelPacks: createDaemonPublicVoiceModelPackRuntime({
        accountId: 'account-fixture',
        machineId: 'machine-fixture',
        happyHomeDir,
        paths,
      }),
      runtimeLoader: async () => null,
    });
    await expect(restarted.listModels()).resolves.toEqual([
      expect.objectContaining({
        packId: qualifiedPackId,
        installState: 'installed',
        runtimeSupported: false,
      }),
    ]);
    await restarted.removeModel(qualifiedPackId);
    await expect(restarted.listModels()).resolves.toEqual([]);
    await restarted.stop();
  });

  it('leaves no installed state when cancellation interrupts the real installer', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-public-model-pack-cancel-home-'));
    roots.push(happyHomeDir);
    envScope.patch({ HAPPIER_HOME_DIR: happyHomeDir });
    reloadConfiguration();
    const assets = await installZipformerPluginFixture({ happyHomeDir, roots });

    const paths = resolveVoiceInferencePaths();
    const controller = new AbortController();
    const publicModelPacks = createDaemonPublicVoiceModelPackRuntime({
      accountId: 'account-cancel-fixture',
      machineId: 'machine-cancel-fixture',
      happyHomeDir,
      paths,
      createInstallerHost: createFixtureInstallerHostFactory(assets, () => controller.abort()),
    });
    const qualifiedPackId = `${ZIPFORMER_VOICE_MODEL_PACK_FIXTURE_PLUGIN_ID}/${ZIPFORMER_VOICE_MODEL_PACK_FIXTURE_LOCAL_ID}`;
    const before = await publicModelPacks.resolve(qualifiedPackId);
    expect(before).not.toBeNull();

    await expect(publicModelPacks.install({
      key: qualifiedPackId,
      signal: controller.signal,
    })).rejects.toMatchObject({ code: 'cancelled' });

    await expect(readInstalledVoiceModelPackManifest({
      packsRootDir: paths.packsRootDir,
      packId: before!.directoryKey,
    })).resolves.toBeNull();
    await expect(publicModelPacks.resolve(qualifiedPackId)).resolves.toMatchObject({
      installedMetadata: null,
      installedManifest: null,
    });
  });

  it('rejects a model-pack install when applied plugin admission changes before durable commit', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-public-model-pack-stale-source-home-'));
    roots.push(happyHomeDir);
    envScope.patch({ HAPPIER_HOME_DIR: happyHomeDir });
    reloadConfiguration();
    const assets = await installZipformerPluginFixture({ happyHomeDir, roots });
    const snapshot = await readInstalledPluginCatalogSnapshot({ happyHomeDir });
    const plugin = snapshot.entries.find((entry) => (
      entry.pluginId === ZIPFORMER_VOICE_MODEL_PACK_FIXTURE_PLUGIN_ID
    ));
    if (!plugin?.manifestDigest) throw new Error('Expected installed Voice fixture manifest');
    const committed = await readCurrentCommittedPluginGenerations(resolvePluginStorePaths({ happyHomeDir }));
    const generation = committed?.generations.get(plugin.pluginId);
    if (!generation) throw new Error('Expected committed Voice fixture generation');
    let admitted = new Map([[plugin.pluginId, {
      immutableGenerationId: generation.immutableGenerationId,
      manifestDigest: generation.record.manifestDigest,
      packageDigest: generation.record.packageDigest,
      distribution: generation.installation?.source.distribution ?? 'bundled',
      applied: true,
      selectedAccess: generation.installation?.optionalAccess ?? [],
    }]]);

    const paths = resolveVoiceInferencePaths();
    const runtime = createDaemonPublicVoiceModelPackRuntime({
      accountId: 'account-stale-source-fixture',
      machineId: 'machine-stale-source-fixture',
      happyHomeDir,
      paths,
      readPluginFinalPolicyCurrentGenerations: async () => admitted,
      createInstallerHost: createFixtureInstallerHostFactory(assets, () => {
        admitted = new Map([[plugin.pluginId, {
          immutableGenerationId: generation.immutableGenerationId,
          manifestDigest: generation.record.manifestDigest,
          packageDigest: `sha256:${'d'.repeat(64)}`,
          distribution: generation.installation?.source.distribution ?? 'bundled',
          applied: true,
          selectedAccess: generation.installation?.optionalAccess ?? [],
        }]]);
      }),
    });
    const qualifiedPackId = `${ZIPFORMER_VOICE_MODEL_PACK_FIXTURE_PLUGIN_ID}/${ZIPFORMER_VOICE_MODEL_PACK_FIXTURE_LOCAL_ID}`;
    const before = await runtime.resolve(qualifiedPackId);
    if (!before) throw new Error('Expected admitted Voice fixture');

    await expect(runtime.install({
      key: qualifiedPackId,
      signal: new AbortController().signal,
    })).rejects.toThrow('voice_model_pack_source_stale');
    await expect(readInstalledVoiceModelPackManifest({
      packsRootDir: paths.packsRootDir,
      packId: before.directoryKey,
    })).resolves.toBeNull();
  });

  it('fails closed after restart when an installed artifact was tampered', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-public-model-pack-tamper-home-'));
    roots.push(happyHomeDir);
    envScope.patch({ HAPPIER_HOME_DIR: happyHomeDir });
    reloadConfiguration();
    const assets = await installZipformerPluginFixture({ happyHomeDir, roots });
    const paths = resolveVoiceInferencePaths();
    const qualifiedPackId = `${ZIPFORMER_VOICE_MODEL_PACK_FIXTURE_PLUGIN_ID}/${ZIPFORMER_VOICE_MODEL_PACK_FIXTURE_LOCAL_ID}`;
    const firstRuntime = createDaemonPublicVoiceModelPackRuntime({
      accountId: 'account-tamper-fixture',
      machineId: 'machine-tamper-fixture',
      happyHomeDir,
      paths,
      createInstallerHost: createFixtureInstallerHostFactory(assets),
    });
    const installed = await firstRuntime.install({
      key: qualifiedPackId,
      signal: new AbortController().signal,
    });
    const firstArtifact = installed.installedManifest!.files[0]!;
    await writeFile(
      join(paths.packsRootDir, installed.directoryKey, ...firstArtifact.path.split('/')),
      new Uint8Array(firstArtifact.sizeBytes).fill(0x7f),
    );

    const restartedRuntime = createDaemonPublicVoiceModelPackRuntime({
      accountId: 'account-tamper-fixture',
      machineId: 'machine-tamper-fixture',
      happyHomeDir,
      paths,
    });
    await expect(restartedRuntime.resolve(qualifiedPackId)).resolves.toMatchObject({
      installedMetadata: expect.any(Object),
      installedManifest: null,
    });
  });

  it('removes a first install when the real durable state write fails after promotion', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-public-model-pack-state-failure-home-'));
    roots.push(happyHomeDir);
    envScope.patch({ HAPPIER_HOME_DIR: happyHomeDir });
    reloadConfiguration();
    const assets = await installZipformerPluginFixture({ happyHomeDir, roots });
    const paths = resolveVoiceInferencePaths();
    const stateFilePath = join(paths.rootDir, 'forced-state-write-failure');
    const qualifiedPackId = `${ZIPFORMER_VOICE_MODEL_PACK_FIXTURE_PLUGIN_ID}/${ZIPFORMER_VOICE_MODEL_PACK_FIXTURE_LOCAL_ID}`;
    const runtime = createDaemonPublicVoiceModelPackRuntime({
      accountId: 'account-state-failure',
      machineId: 'machine-state-failure',
      happyHomeDir,
      paths,
      stateFilePath,
      createInstallerHost: createFixtureInstallerHostFactory(assets),
    });
    const before = await runtime.resolve(qualifiedPackId);
    expect(before).not.toBeNull();
    await mkdir(stateFilePath, { recursive: true });

    await expect(runtime.install({
      key: qualifiedPackId,
      signal: new AbortController().signal,
    })).rejects.toThrow();
    await expect(readInstalledVoiceModelPackManifest({
      packsRootDir: paths.packsRootDir,
      packId: before!.directoryKey,
    })).resolves.toBeNull();
    await expect(runtime.resolve(qualifiedPackId)).resolves.toMatchObject({
      installedMetadata: null,
      installedManifest: null,
    });
  });

  it('rolls forward an upgrade crash after metadata commit and before marker cleanup', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-public-model-pack-commit-crash-'));
    roots.push(happyHomeDir);
    envScope.patch({ HAPPIER_HOME_DIR: happyHomeDir });
    reloadConfiguration();
    const assets = await installZipformerPluginFixture({ happyHomeDir, roots });
    const paths = resolveVoiceInferencePaths();
    const stateFilePath = join(paths.rootDir, 'commit-crash-state.json');
    const key = `${ZIPFORMER_VOICE_MODEL_PACK_FIXTURE_PLUGIN_ID}/${ZIPFORMER_VOICE_MODEL_PACK_FIXTURE_LOCAL_ID}`;
    const runtime = createDaemonPublicVoiceModelPackRuntime({
      accountId: 'account-commit-crash', machineId: 'machine-commit-crash', happyHomeDir, paths, stateFilePath,
      createInstallerHost: createFixtureInstallerHostFactory(assets),
    });
    const installed = await runtime.install({ key, signal: new AbortController().signal });
    const liveDir = join(paths.packsRootDir, installed.directoryKey);
    const backupDir = join(paths.packsRootDir, `.${installed.directoryKey}.backup`);
    const intentPath = join(paths.packsRootDir, `.${installed.directoryKey}.promote-intent`);
    await cp(liveDir, backupDir, { recursive: true });
    const oldManifest = { ...installed.installedManifest!, version: 'prior-version' };
    await writeFile(join(backupDir, 'pack.json'), JSON.stringify(oldManifest), 'utf8');
    const before = { ...installed.installedMetadata!, packVersion: 'prior-version' };
    await writeFile(intentPath, JSON.stringify({
      schemaVersion: 1,
      packId: installed.directoryKey,
      phase: 'metadata_committed',
      startedAtMs: 1,
      token: 'commit-crash',
      priorInstall: {
        scopeKey: JSON.stringify(['account-commit-crash', 'machine-commit-crash']),
        identityKey: JSON.stringify([before.identity.pluginId, before.identity.packId]),
      },
      recovery: {
        kind: 'daemon_public_voice_model_pack_state_v1',
        value: { accountId: 'account-commit-crash', machineId: 'machine-commit-crash', before, after: installed.installedMetadata },
      },
    }), 'utf8');

    const restarted = createDaemonPublicVoiceModelPackRuntime({
      accountId: 'account-commit-crash', machineId: 'machine-commit-crash', happyHomeDir, paths, stateFilePath,
    });
    await restarted.ready();
    expect(JSON.parse(await readFile(join(liveDir, 'pack.json'), 'utf8')).version).toBe(installed.installedManifest!.version);
    await expect(readFile(intentPath, 'utf8')).rejects.toThrow();
    await expect(readFile(join(backupDir, 'pack.json'), 'utf8')).rejects.toThrow();
    await expect(restarted.resolve(key)).resolves.toMatchObject({ installedMetadata: installed.installedMetadata });
  });

  it('keeps rollback recovery visible when metadata rollback fails, then converges exactly on retry', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-public-model-pack-rollback-retry-'));
    roots.push(happyHomeDir);
    envScope.patch({ HAPPIER_HOME_DIR: happyHomeDir });
    reloadConfiguration();
    const assets = await installZipformerPluginFixture({ happyHomeDir, roots });
    const paths = resolveVoiceInferencePaths();
    const stateFilePath = join(paths.rootDir, 'rollback-retry-state.json');
    const savedStatePath = `${stateFilePath}.saved`;
    const key = `${ZIPFORMER_VOICE_MODEL_PACK_FIXTURE_PLUGIN_ID}/${ZIPFORMER_VOICE_MODEL_PACK_FIXTURE_LOCAL_ID}`;
    const runtime = createDaemonPublicVoiceModelPackRuntime({
      accountId: 'account-rollback-retry', machineId: 'machine-rollback-retry', happyHomeDir, paths, stateFilePath,
      createInstallerHost: createFixtureInstallerHostFactory(assets),
    });
    const installed = await runtime.install({ key, signal: new AbortController().signal });
    const liveDir = join(paths.packsRootDir, installed.directoryKey);
    const backupDir = join(paths.packsRootDir, `.${installed.directoryKey}.backup`);
    const intentPath = join(paths.packsRootDir, `.${installed.directoryKey}.promote-intent`);
    await cp(liveDir, backupDir, { recursive: true });
    const oldManifest = { ...installed.installedManifest!, version: 'prior-version' };
    await writeFile(join(backupDir, 'pack.json'), JSON.stringify(oldManifest), 'utf8');
    const before = { ...installed.installedMetadata!, packVersion: 'prior-version' };
    await writeFile(intentPath, JSON.stringify({
      schemaVersion: 1,
      packId: installed.directoryKey,
      phase: 'rollback_pending',
      startedAtMs: 1,
      token: 'rollback-retry',
      priorInstall: {
        scopeKey: JSON.stringify(['account-rollback-retry', 'machine-rollback-retry']),
        identityKey: JSON.stringify([before.identity.pluginId, before.identity.packId]),
      },
      recovery: {
        kind: 'daemon_public_voice_model_pack_state_v1',
        value: { accountId: 'account-rollback-retry', machineId: 'machine-rollback-retry', before, after: installed.installedMetadata },
      },
    }), 'utf8');
    await rename(stateFilePath, savedStatePath);
    await mkdir(stateFilePath);

    await expect(runtime.ready()).rejects.toThrow();
    expect(JSON.parse(await readFile(join(liveDir, 'pack.json'), 'utf8')).version).toBe('prior-version');
    await expect(readFile(intentPath, 'utf8')).resolves.toContain('rollback_pending');

    await rm(stateFilePath, { recursive: true });
    await rename(savedStatePath, stateFilePath);
    const restarted = createDaemonPublicVoiceModelPackRuntime({
      accountId: 'account-rollback-retry', machineId: 'machine-rollback-retry', happyHomeDir, paths, stateFilePath,
    });
    await restarted.ready();
    await expect(readFile(intentPath, 'utf8')).rejects.toThrow();
    await expect(restarted.resolve(key)).resolves.toMatchObject({
      installedMetadata: expect.objectContaining({ packVersion: 'prior-version' }),
      installedManifest: expect.objectContaining({ version: 'prior-version' }),
    });
  });

  it('rehashes on disable-to-reenable reclaim and rejects same-metadata artifact tampering', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-public-model-pack-reclaim-tamper-'));
    roots.push(happyHomeDir);
    envScope.patch({ HAPPIER_HOME_DIR: happyHomeDir });
    reloadConfiguration();
    const assets = await installZipformerPluginFixture({ happyHomeDir, roots });
    const paths = resolveVoiceInferencePaths();
    const key = `${ZIPFORMER_VOICE_MODEL_PACK_FIXTURE_PLUGIN_ID}/${ZIPFORMER_VOICE_MODEL_PACK_FIXTURE_LOCAL_ID}`;
    const runtime = createDaemonPublicVoiceModelPackRuntime({
      accountId: 'account-reclaim', machineId: 'machine-reclaim', happyHomeDir, paths,
      createInstallerHost: createFixtureInstallerHostFactory(assets),
      fingerprintInstalledPack: async () => 'unchanged-physical-fingerprint',
    });
    const installed = await runtime.install({ key, signal: new AbortController().signal });
    const store = createPluginRegistryStateStore({
      happyHomeDir,
      runtimeLifecycle: VOICE_MODEL_PACK_TEST_RUNTIME_LIFECYCLE,
    });
    const setEnabled = async (enabled: boolean) => store.update((current) => ({
      ...current,
      plugins: {
        ...current.plugins,
        [ZIPFORMER_VOICE_MODEL_PACK_FIXTURE_PLUGIN_ID]: {
          ...current.plugins[ZIPFORMER_VOICE_MODEL_PACK_FIXTURE_PLUGIN_ID]!,
          state: { ...current.plugins[ZIPFORMER_VOICE_MODEL_PACK_FIXTURE_PLUGIN_ID]!.state, enabled },
        },
      },
    }));
    await setEnabled(false);
    const artifact = installed.installedManifest!.files[0]!;
    await writeFile(join(paths.packsRootDir, installed.directoryKey, ...artifact.path.split('/')), new Uint8Array(artifact.sizeBytes).fill(0x55));
    await setEnabled(true);
    await expect(runtime.resolve(key)).resolves.toMatchObject({
      descriptor: { loadable: true },
      installedManifest: null,
    });
  });

  it('converges an interrupted first-install rollback to no bytes and no metadata', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-public-model-pack-first-rollback-'));
    roots.push(happyHomeDir);
    envScope.patch({ HAPPIER_HOME_DIR: happyHomeDir });
    reloadConfiguration();
    const assets = await installZipformerPluginFixture({ happyHomeDir, roots });
    const paths = resolveVoiceInferencePaths();
    const stateFilePath = join(paths.rootDir, 'first-rollback-state.json');
    const key = `${ZIPFORMER_VOICE_MODEL_PACK_FIXTURE_PLUGIN_ID}/${ZIPFORMER_VOICE_MODEL_PACK_FIXTURE_LOCAL_ID}`;
    const runtime = createDaemonPublicVoiceModelPackRuntime({
      accountId: 'account-first-rollback', machineId: 'machine-first-rollback', happyHomeDir, paths, stateFilePath,
      createInstallerHost: createFixtureInstallerHostFactory(assets),
    });
    const installed = await runtime.install({ key, signal: new AbortController().signal });
    const intentPath = join(paths.packsRootDir, `.${installed.directoryKey}.promote-intent`);
    await writeFile(intentPath, JSON.stringify({
      schemaVersion: 1,
      packId: installed.directoryKey,
      phase: 'rollback_pending',
      startedAtMs: 1,
      token: 'first-rollback',
      priorInstall: null,
      recovery: {
        kind: 'daemon_public_voice_model_pack_state_v1',
        value: {
          accountId: 'account-first-rollback', machineId: 'machine-first-rollback',
          before: null, after: installed.installedMetadata,
        },
      },
    }), 'utf8');

    const restarted = createDaemonPublicVoiceModelPackRuntime({
      accountId: 'account-first-rollback', machineId: 'machine-first-rollback', happyHomeDir, paths, stateFilePath,
    });
    await restarted.ready();
    await expect(readInstalledVoiceModelPackManifest({
      packsRootDir: paths.packsRootDir,
      packId: installed.directoryKey,
    })).resolves.toBeNull();
    await expect(restarted.resolve(key)).resolves.toMatchObject({
      installedMetadata: null,
      installedManifest: null,
    });
    await expect(readFile(intentPath, 'utf8')).rejects.toThrow();
  });
});
