import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  installVersionedPayload,
  resolveInstalledFirstPartyComponentPaths,
} from '../dist/firstPartyRuntime/index.js';

const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');

function withPlatform(platform, fn) {
  Object.defineProperty(process, 'platform', { ...originalPlatformDescriptor, value: platform });
  const result = fn();
  if (result && typeof result.finally === 'function') {
    return result.finally(() => {
      Object.defineProperty(process, 'platform', originalPlatformDescriptor);
    });
  }
  Object.defineProperty(process, 'platform', originalPlatformDescriptor);
  return result;
}

async function createPayload(rootDir, versionId, contents, executableName = 'happier') {
  const payloadRoot = join(rootDir, `payload-${versionId}`);
  await mkdir(join(payloadRoot, 'package-dist'), { recursive: true });
  await writeFile(join(payloadRoot, executableName), contents, 'utf8');
  await writeFile(join(payloadRoot, 'package-dist', 'index.mjs'), `export default ${JSON.stringify(versionId)};\n`, 'utf8');
  return payloadRoot;
}

test('installVersionedPayload promotes payload, syncs shims, and prunes older versions', async () => {
  const homeDir = await mkdtemp(join(tmpdir(), 'happier-install-versioned-payload-'));
  const env = { ...process.env, HAPPIER_HOME_DIR: homeDir };

  try {
    await installVersionedPayload({
      componentId: 'happier-cli',
      versionId: '1.0.0',
      payloadRoot: await createPayload(homeDir, '1.0.0', 'first-version'),
      processEnv: env,
    });
    await installVersionedPayload({
      componentId: 'happier-cli',
      versionId: '2.0.0',
      payloadRoot: await createPayload(homeDir, '2.0.0', 'second-version'),
      processEnv: env,
    });
    const result = await installVersionedPayload({
      componentId: 'happier-cli',
      versionId: '3.0.0',
      payloadRoot: await createPayload(homeDir, '3.0.0', 'third-version'),
      processEnv: env,
    });

    const paths = resolveInstalledFirstPartyComponentPaths({
      componentId: 'happier-cli',
      processEnv: env,
    });
    assert.equal(result.currentVersionId, '3.0.0');
    assert.equal(result.previousVersionId, '2.0.0');
    assert.equal(result.hadLegacyCurrentInstallWithoutVersionMarkers, false);
    assert.equal(await readFile(paths.binaryPath, 'utf8'), 'third-version');
    assert.equal(await readFile(join(paths.previousPath, 'happier'), 'utf8'), 'second-version');
    assert.equal(existsSync(join(homeDir, 'cli', 'versions', '1.0.0')), false);
    assert.equal(existsSync(join(homeDir, 'bin', 'happier')), true);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});

test('installVersionedPayload resolves Windows .exe payloads and shims', async () => {
  await withPlatform('win32', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-install-versioned-payload-win32-'));
    const env = { ...process.env, HAPPIER_HOME_DIR: homeDir };

    try {
      const result = await installVersionedPayload({
        componentId: 'happier-cli',
        versionId: '1.0.0',
        payloadRoot: await createPayload(homeDir, '1.0.0', 'windows-version', 'happier.exe'),
        processEnv: env,
      });

      const paths = resolveInstalledFirstPartyComponentPaths({
        componentId: 'happier-cli',
        processEnv: env,
      });

      assert.equal(result.currentVersionId, '1.0.0');
      assert.equal(result.hadLegacyCurrentInstallWithoutVersionMarkers, false);
      assert.equal(paths.binaryPath, join(homeDir, 'cli', 'current', 'happier.exe'));
      assert.equal(paths.shimPaths[0], join(homeDir, 'bin', 'happier.exe'));
      assert.equal(await readFile(paths.binaryPath, 'utf8'), 'windows-version');
      assert.equal(await readFile(paths.shimPaths[0], 'utf8'), 'windows-version');
      assert.equal(existsSync(join(homeDir, 'bin', 'happier.exe')), true);
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });
});
