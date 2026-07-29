import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
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
    assert.equal(firstPromotion.hadLegacyCurrentInstallWithoutVersionMarkers, false);

    const secondStage = await createStagedPayload(homeDir, '2.0.0', 'second-version');
    const secondPromotion = await promoteVersionedPayload({
      componentId: 'happier-cli',
      processEnv: env,
      versionId: '2.0.0',
      stagedPayloadPath: secondStage,
    });

    assert.equal(secondPromotion.currentVersionId, '2.0.0');
    assert.equal(secondPromotion.previousVersionId, '1.0.0');
    assert.equal(secondPromotion.hadLegacyCurrentInstallWithoutVersionMarkers, false);

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

test('promoteVersionedPayload fails closed without leaving a partial version directory', async () => {
  const homeDir = await mkdtemp(join(tmpdir(), 'happier-first-party-runtime-atomic-'));
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
    await mkdir(join(secondStage, 'public-release-ring.id'));

    await assert.rejects(
      () =>
        promoteVersionedPayload({
          componentId: 'happier-cli',
          processEnv: env,
          versionId: '2.0.0',
          stagedPayloadPath: secondStage,
        }),
      /directory|eisdir/i,
    );

    const paths = resolveInstalledFirstPartyComponentPaths({
      componentId: 'happier-cli',
      processEnv: env,
    });

    assert.equal(existsSync(join(paths.versionsDir, '2.0.0')), false);
    assert.equal(await readFile(paths.binaryPath, 'utf8'), 'first-version');

    const entries = await readdir(paths.versionsDir);
    const visibleEntries = entries.filter((entry) => !entry.startsWith('.')).sort();
    assert.deepEqual(visibleEntries, ['1.0.0']);
    assert.equal(statSync(join(paths.versionsDir, '1.0.0')).isDirectory(), true);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});

test('promoteVersionedPayload detects a legacy current install when the current payload exists without version markers', async () => {
  const homeDir = await mkdtemp(join(tmpdir(), 'happier-first-party-runtime-legacy-'));
  const env = { ...process.env, HAPPIER_HOME_DIR: homeDir };

  try {
    const paths = resolveInstalledFirstPartyComponentPaths({
      componentId: 'happier-cli',
      processEnv: env,
    });
    await mkdir(join(paths.currentPath, 'package-dist'), { recursive: true });
    await writeFile(paths.binaryPath, 'legacy-version', 'utf8');
    await writeFile(join(paths.currentPath, 'package-dist', 'index.mjs'), 'export default "legacy";\n', 'utf8');

    const nextStage = await createStagedPayload(homeDir, '2.0.0', 'second-version');
    const promotion = await promoteVersionedPayload({
      componentId: 'happier-cli',
      processEnv: env,
      versionId: '2.0.0',
      stagedPayloadPath: nextStage,
    });

    assert.equal(promotion.currentVersionId, '2.0.0');
    assert.equal(promotion.previousVersionId, null);
    assert.equal(promotion.hadLegacyCurrentInstallWithoutVersionMarkers, true);
    assert.equal(await readFile(paths.binaryPath, 'utf8'), 'second-version');
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});

test('promoteVersionedPayload embeds the public release ring marker into the promoted payload', async () => {
  const homeDir = await mkdtemp(join(tmpdir(), 'happier-first-party-runtime-'));
  const env = { ...process.env, HAPPIER_HOME_DIR: homeDir };

  try {
    const stagedPayloadPath = await createStagedPayload(homeDir, '1.0.0-preview.1', 'preview-version');
    const promotion = await promoteVersionedPayload({
      componentId: 'happier-cli',
      processEnv: env,
      releaseRing: 'preview',
      versionId: '1.0.0-preview.1',
      stagedPayloadPath,
    });

    assert.equal(existsSync(join(promotion.versionPath, 'public-release-ring.id')), true);
    assert.equal(await readFile(join(promotion.versionPath, 'public-release-ring.id'), 'utf8'), 'preview\n');
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
