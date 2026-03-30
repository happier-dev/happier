import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  promoteVersionedPayload,
  pruneRetainedVersions,
  resolveFirstPartyInstallLayout,
} from '../dist/firstPartyRuntime/index.js';

async function createStagedPayload(rootDir, versionId) {
  const stagedPayloadPath = join(rootDir, `stage-${versionId}`);
  await mkdir(stagedPayloadPath, { recursive: true });
  await writeFile(join(stagedPayloadPath, 'happier'), versionId, 'utf8');
  await mkdir(join(stagedPayloadPath, 'package-dist'), { recursive: true });
  await writeFile(join(stagedPayloadPath, 'package-dist', 'index.mjs'), `export default ${JSON.stringify(versionId)};\n`, 'utf8');
  return stagedPayloadPath;
}

test('pruneRetainedVersions removes versions outside the retained set', async () => {
  const homeDir = await mkdtemp(join(tmpdir(), 'happier-first-party-runtime-'));
  const env = { ...process.env, HAPPIER_HOME_DIR: homeDir };

  try {
    await promoteVersionedPayload({
      componentId: 'happier-cli',
      processEnv: env,
      versionId: '1.0.0',
      stagedPayloadPath: await createStagedPayload(homeDir, '1.0.0'),
    });
    await promoteVersionedPayload({
      componentId: 'happier-cli',
      processEnv: env,
      versionId: '2.0.0',
      stagedPayloadPath: await createStagedPayload(homeDir, '2.0.0'),
    });
    await promoteVersionedPayload({
      componentId: 'happier-cli',
      processEnv: env,
      versionId: '3.0.0',
      stagedPayloadPath: await createStagedPayload(homeDir, '3.0.0'),
    });

    const result = await pruneRetainedVersions({
      componentId: 'happier-cli',
      processEnv: env,
      orderedVersionIdsNewestFirst: ['3.0.0', '2.0.0', '1.0.0'],
      currentVersionId: '3.0.0',
      previousVersionId: '2.0.0',
    });

    assert.deepEqual(result.prunedVersionIds, ['1.0.0']);

    const layout = resolveFirstPartyInstallLayout({
      componentId: 'happier-cli',
      processEnv: env,
    });
    const versions = (await readdir(layout.versionsDir)).sort();
    assert.deepEqual(versions, ['2.0.0', '3.0.0']);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});
