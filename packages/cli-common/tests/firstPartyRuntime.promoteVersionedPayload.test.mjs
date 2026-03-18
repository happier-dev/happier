import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  promoteVersionedPayload,
  rollbackVersionedPayload,
  resolveInstalledFirstPartyComponentPaths,
} from '../dist/firstPartyRuntime/index.js';

async function createStagedPayload(rootDir, versionId, contents) {
  const stagedPayloadPath = join(rootDir, `stage-${versionId}`);
  await mkdir(stagedPayloadPath, { recursive: true });
  await writeFile(join(stagedPayloadPath, 'happier'), contents, 'utf8');
  await mkdir(join(stagedPayloadPath, 'package-dist'), { recursive: true });
  await writeFile(join(stagedPayloadPath, 'package-dist', 'index.mjs'), `export default ${JSON.stringify(versionId)};\n`, 'utf8');
  return stagedPayloadPath;
}

test('promoteVersionedPayload updates current payload and preserves previous payload', async () => {
  const homeDir = await mkdtemp(join(tmpdir(), 'happier-first-party-runtime-'));
  const env = { ...process.env, HAPPIER_HOME_DIR: homeDir };

  try {
    const firstStage = await createStagedPayload(homeDir, '1.0.0', 'first-version');
    const firstPromotion = await promoteVersionedPayload({
      componentId: 'happier-cli',
      processEnv: env,
      versionId: '1.0.0',
      stagedPayloadPath: firstStage,
    });

    assert.equal(firstPromotion.currentVersionId, '1.0.0');
    assert.equal(firstPromotion.previousVersionId, null);

    const secondStage = await createStagedPayload(homeDir, '2.0.0', 'second-version');
    const secondPromotion = await promoteVersionedPayload({
      componentId: 'happier-cli',
      processEnv: env,
      versionId: '2.0.0',
      stagedPayloadPath: secondStage,
    });

    assert.equal(secondPromotion.currentVersionId, '2.0.0');
    assert.equal(secondPromotion.previousVersionId, '1.0.0');

    const paths = resolveInstalledFirstPartyComponentPaths({
      componentId: 'happier-cli',
      processEnv: env,
    });
    assert.equal(await readFile(paths.binaryPath, 'utf8'), 'second-version');
    assert.equal(await readFile(join(paths.previousPath, 'happier'), 'utf8'), 'first-version');
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});

test('rollbackVersionedPayload swaps current and previous payloads', async () => {
  const homeDir = await mkdtemp(join(tmpdir(), 'happier-first-party-runtime-'));
  const env = { ...process.env, HAPPIER_HOME_DIR: homeDir };

  try {
    const firstStage = await createStagedPayload(homeDir, '1.0.0', 'first-version');
    await promoteVersionedPayload({
      componentId: 'happier-cli',
      processEnv: env,
      versionId: '1.0.0',
      stagedPayloadPath: firstStage,
    });
    const secondStage = await createStagedPayload(homeDir, '2.0.0', 'second-version');
    await promoteVersionedPayload({
      componentId: 'happier-cli',
      processEnv: env,
      versionId: '2.0.0',
      stagedPayloadPath: secondStage,
    });

    const result = await rollbackVersionedPayload({
      componentId: 'happier-cli',
      processEnv: env,
    });

    assert.equal(result.currentVersionId, '1.0.0');
    assert.equal(result.previousVersionId, '2.0.0');

    const paths = resolveInstalledFirstPartyComponentPaths({
      componentId: 'happier-cli',
      processEnv: env,
    });
    assert.equal(await readFile(paths.binaryPath, 'utf8'), 'first-version');
    assert.equal(await readFile(join(paths.previousPath, 'happier'), 'utf8'), 'second-version');
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});

test('rollbackVersionedPayload fails closed when no previous payload exists', async () => {
  const homeDir = await mkdtemp(join(tmpdir(), 'happier-first-party-runtime-'));
  const env = { ...process.env, HAPPIER_HOME_DIR: homeDir };

  try {
    await assert.rejects(
      () =>
        rollbackVersionedPayload({
          componentId: 'happier-cli',
          processEnv: env,
        }),
      /previous/i,
    );
    assert.equal(existsSync(join(homeDir, 'cli', 'previous')), false);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});
