import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync, lstatSync, readlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  promoteVersionedPayload,
  resolveInstalledFirstPartyComponentPaths,
  syncInstalledFirstPartyShims,
} from '../dist/firstPartyRuntime/index.js';

async function createStagedPayload(rootDir, versionId, contents) {
  const stagedPayloadPath = join(rootDir, `stage-${versionId}`);
  await mkdir(stagedPayloadPath, { recursive: true });
  await writeFile(join(stagedPayloadPath, 'happier'), contents, 'utf8');
  await mkdir(join(stagedPayloadPath, 'package-dist'), { recursive: true });
  await writeFile(join(stagedPayloadPath, 'package-dist', 'index.mjs'), `export default ${JSON.stringify(versionId)};\n`, 'utf8');
  return stagedPayloadPath;
}

for (const [releaseRing, shimName, installRootPattern] of [
  ['stable', 'happier', /cli\/current\/happier|..\/cli\/current\/happier/],
  ['preview', 'hprev', /cli-preview\/current\/happier|..\/cli-preview\/current\/happier/],
  ['publicdev', 'hdev', /cli-dev\/current\/happier|..\/cli-dev\/current\/happier/],
]) {
  test(`syncInstalledFirstPartyShims points the ${releaseRing} shim at the current payload binary`, async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-first-party-runtime-'));
    const env = { ...process.env, HAPPIER_HOME_DIR: homeDir };

    try {
      await promoteVersionedPayload({
        componentId: 'happier-cli',
        processEnv: env,
        releaseRing,
        versionId: '1.0.0',
        stagedPayloadPath: await createStagedPayload(homeDir, '1.0.0', 'payload-binary'),
      });
      const result = await syncInstalledFirstPartyShims({
        componentId: 'happier-cli',
        processEnv: env,
        releaseRing,
      });

      const paths = resolveInstalledFirstPartyComponentPaths({
        componentId: 'happier-cli',
        processEnv: env,
        releaseRing,
      });
      assert.deepEqual(result.shimPaths, paths.shimPaths);
      assert.equal(paths.shimPaths[0], join(homeDir, 'bin', shimName));
      assert.equal(existsSync(paths.shimPaths[0]), true);

      if (process.platform === 'win32') {
        assert.equal(await readFile(paths.shimPaths[0], 'utf8'), 'payload-binary');
      } else {
        assert.equal(lstatSync(paths.shimPaths[0]).isSymbolicLink(), true);
        assert.match(readlinkSync(paths.shimPaths[0]), installRootPattern);
      }
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });
}
