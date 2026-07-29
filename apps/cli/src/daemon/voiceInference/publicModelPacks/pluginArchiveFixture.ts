import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

import * as tar from 'tar';

import { createDaemonArchivePluginChangePreparer } from '@/plugins/daemon/archiveChangePreparer';
import { createDaemonPluginChangeService } from '@/plugins/daemon/changeService';
import { resolvePluginStorePaths } from '@/plugins/store/paths';
import { readCurrentCommittedPluginGenerations } from '@/plugins/store/registry/generationStore';
import { createPluginRegistryStateStore, type PluginRegistryRuntimeLifecycle } from '@/plugins/store/registry/currentState';
import { archiveSha256IntegrityFromDigest } from '@/plugins/distribution/archive/integrity';

export const VOICE_MODEL_PACK_TEST_RUNTIME_LIFECYCLE: PluginRegistryRuntimeLifecycle = Object.freeze({
  prepare: async () => Object.freeze({
    abort: async () => undefined,
    adopt: async () => undefined,
  }),
});

export async function installVoiceModelPackPluginArchiveFixture(params: Readonly<{
  happyHomeDir: string;
  archiveSourceRoot: string;
  packageRoot: string;
  archiveFileName: string;
  interactionId: string;
}>): Promise<Readonly<{
  archivePath: string;
  archiveSha256: string;
  manifestDigest: string;
  packageDigest: string;
}>> {
  if (basename(params.packageRoot) !== 'package') {
    throw new Error('Voice model-pack npm archive fixtures must use a package/ root');
  }

  const manifest = JSON.parse(
    await readFile(join(params.packageRoot, '.happier-plugin', 'plugin.json'), 'utf8'),
  ) as { id?: unknown; version?: unknown };
  if (typeof manifest.id !== 'string' || typeof manifest.version !== 'string') {
    throw new Error('Voice model-pack archive fixture manifest must declare string id and version');
  }

  await writeFile(join(params.packageRoot, 'package.json'), JSON.stringify({
    name: '@happier-dev/voice-model-pack-fixture',
    version: manifest.version,
    keywords: ['happier-plugin'],
    happier: { manifest: '.happier-plugin/plugin.json' },
    files: ['.happier-plugin', 'daemon.mjs'],
  }, null, 2), 'utf8');

  const archivePath = join(params.archiveSourceRoot, params.archiveFileName);
  await tar.c({ gzip: true, file: archivePath, cwd: params.archiveSourceRoot, portable: true }, ['package']);
  const archiveSha256 = createHash('sha256').update(await readFile(archivePath)).digest('hex');

  const service = createDaemonPluginChangeService({
    prepare: createDaemonArchivePluginChangePreparer({
      happyHomeDir: params.happyHomeDir,
      runtimeLifecycle: VOICE_MODEL_PACK_TEST_RUNTIME_LIFECYCLE,
    }),
  });
  try {
    const begun = await service.requestPluginChange({
      kind: 'installArchive',
      locator: archivePath,
      expectedIntegrity: archiveSha256IntegrityFromDigest(archiveSha256),
    });
    if (begun.kind !== 'reviewRequired') {
      throw new Error(`Voice model-pack archive fixture did not require review: ${JSON.stringify(begun)}`);
    }
    if (begun.review.pluginId !== manifest.id || begun.review.version !== manifest.version) {
      throw new Error('Voice model-pack archive review identity differs from its manifest/package identity');
    }

    const committed = await service.decidePluginChange({
      pendingChangeId: begun.pendingChangeId,
      decision: 'installAndTrust',
      actorEvidence: {
        kind: 'authenticatedLocalUser',
        interactionId: params.interactionId,
        occurredAtMs: Date.now(),
      },
    });
    if (committed.kind !== 'committed' || committed.pluginId !== manifest.id) {
      throw new Error(`Voice model-pack archive fixture was not committed: ${JSON.stringify(committed)}`);
    }

    const installed = (await createPluginRegistryStateStore({ happyHomeDir: params.happyHomeDir }).read())
      .plugins[manifest.id];
    if (!installed?.install.manifestDigest) {
      throw new Error('Committed Voice model-pack archive fixture is missing its manifest digest');
    }
    const committedGenerations = await readCurrentCommittedPluginGenerations(resolvePluginStorePaths({
      happyHomeDir: params.happyHomeDir,
    }));
    const committedGeneration = committedGenerations?.generations.get(manifest.id);
    if (!committedGeneration) {
      throw new Error('Committed Voice model-pack archive fixture is missing its immutable generation');
    }
    if (committedGeneration.record.manifestDigest !== installed.install.manifestDigest) {
      throw new Error('Committed Voice model-pack archive fixture manifest and generation identities differ');
    }
    return Object.freeze({
      archivePath,
      archiveSha256,
      manifestDigest: installed.install.manifestDigest,
      packageDigest: committedGeneration.record.packageDigest,
    });
  } finally {
    await service.shutdown();
  }
}
