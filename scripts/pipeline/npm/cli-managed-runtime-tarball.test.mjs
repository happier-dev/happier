import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { resolveWindowsCommandInvocation } from '../lib/windows/resolveWindowsCommandInvocation.mjs';
import {
  assertCliManagedRuntimeTarballCoherence,
  assertCliManagedRuntimeTarballPublication,
} from './cli-managed-runtime-tarball.mjs';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const cliRoot = join(repoRoot, 'apps', 'cli');
const requireFromTest = createRequire(import.meta.url);
const {
  getCliRuntimeAssetArchiveManifest,
  RUNTIME_ASSET_CHECKSUM_MANIFEST_NAME,
} = requireFromTest('../../../apps/cli/scripts/unpack-tools.cjs');

function archiveEntries(tarballPath) {
  return String(execFileSync('tar', ['-tzf', tarballPath], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }))
    .split(/\r?\n/u)
    .map((entry) => entry.trim().replaceAll('\\', '/').replace(/^(?:\.\/)+/u, '').replace(/\/+$/u, ''))
    .filter(Boolean);
}

function packWithNpm(packageRoot) {
  const env = { ...process.env };
  const invocation = resolveWindowsCommandInvocation({
    command: 'npm',
    args: ['pack', '--ignore-scripts', '--json', '--loglevel=error'],
    env,
    resolveCommandOnPath: true,
  });
  const raw = String(execFileSync(invocation.command, invocation.args, {
    cwd: packageRoot,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
  })).trim();
  const packed = JSON.parse(raw);
  const filename = String((Array.isArray(packed) ? packed[0] : packed)?.filename ?? '').trim();
  assert.ok(filename.endsWith('.tgz'), `npm pack did not report a tarball: ${raw}`);
  return join(packageRoot, filename);
}

async function createCliPackFixture({
  omitArchiveName = '',
  omitChecksumManifest = false,
  omitChecksumName = '',
  includeUnpacked = false,
  extraArchiveName = '',
  extraChecksumName = '',
} = {}) {
  const packageRoot = await mkdtemp(join(tmpdir(), 'happier-cli-runtime-tarball-'));
  const archivesDir = join(packageRoot, 'tools', 'archives');
  const checksums = [];
  try {
    const cliPackageManifest = JSON.parse(
      await readFile(join(cliRoot, 'package.json'), 'utf8'),
    );
    if (!Array.isArray(cliPackageManifest.files)
      || cliPackageManifest.files.some((entry) => typeof entry !== 'string')) {
      throw new Error('CLI package.json must declare a string files list for runtime archive packlist validation');
    }
    await writeFile(join(packageRoot, 'package.json'), `${JSON.stringify({
      name: '@happier-dev/cli',
      version: '0.0.0-test',
      happier: {
        managedRuntimePublication: {
          v: 1,
          mode: 'complete',
          unavailableProviderRefs: [],
        },
      },
      // Exercise npm's real CLI file-selection list instead of a test-local
      // approximation. The fixture only supplies the runtime-asset corridor.
      files: cliPackageManifest.files,
    })}\n`, 'utf8');
    await writeFile(join(packageRoot, '.npmignore'), await readFile(join(cliRoot, '.npmignore'), 'utf8'), 'utf8');
    await mkdir(archivesDir, { recursive: true });

    for (const runtimeAsset of getCliRuntimeAssetArchiveManifest()) {
      if (runtimeAsset.archiveName === omitArchiveName) continue;
      const bytes = Buffer.from(`fixture ${runtimeAsset.archiveName}\n`, 'utf8');
      await writeFile(join(archivesDir, runtimeAsset.archiveName), bytes);
      if (runtimeAsset.archiveName !== omitChecksumName) {
        checksums.push(
          `${crypto.createHash('sha256').update(bytes).digest('hex')}  ${runtimeAsset.archiveName}`,
        );
      }
    }
    if (!omitChecksumManifest) {
      if (extraChecksumName) {
        checksums.push(`${crypto.createHash('sha256').update('extra\n').digest('hex')}  ${extraChecksumName}`);
      }
      await writeFile(
        join(archivesDir, RUNTIME_ASSET_CHECKSUM_MANIFEST_NAME),
        `${checksums.join('\n')}\n`,
        'utf8',
      );
    }
    if (extraArchiveName) {
      await writeFile(join(archivesDir, extraArchiveName), 'extra\n', 'utf8');
    }
    if (includeUnpacked) {
      const unpackedDir = join(packageRoot, 'tools', 'unpacked');
      await mkdir(unpackedDir, { recursive: true });
      await writeFile(join(unpackedDir, 'should-not-ship'), 'leak\n', 'utf8');
    }
    return { packageRoot, tarballPath: packWithNpm(packageRoot) };
  } catch (error) {
    await rm(packageRoot, { recursive: true, force: true });
    throw error;
  }
}


function expectedUnavailableProviderRefs() {
  const refs = [];
  const seen = new Set();
  for (const runtimeAsset of getCliRuntimeAssetArchiveManifest()) {
    const ref = runtimeAsset.managedProviderRef;
    assert.ok(ref?.pluginId && ref?.providerId);
    const key = `${ref.pluginId}\u0000${ref.providerId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push({ pluginId: ref.pluginId, providerId: ref.providerId });
  }
  return refs;
}

async function createSourceOnlyCliPackFixture({
  unavailableProviderRefs = expectedUnavailableProviderRefs(),
  managedArchiveName = '',
  checksumManifest = false,
} = {}) {
  const packageRoot = await mkdtemp(join(tmpdir(), 'happier-cli-runtime-source-only-'));
  try {
    const cliPackageManifest = JSON.parse(await readFile(join(cliRoot, 'package.json'), 'utf8'));
    await writeFile(join(packageRoot, 'package.json'), `${JSON.stringify({
      name: '@happier-dev/cli',
      version: '0.0.0-test',
      happier: { managedRuntimePublication: { v: 1, mode: 'source-only', unavailableProviderRefs } },
      files: cliPackageManifest.files,
    })}\n`, 'utf8');
    await writeFile(join(packageRoot, '.npmignore'), await readFile(join(cliRoot, '.npmignore'), 'utf8'), 'utf8');
    if (managedArchiveName || checksumManifest) {
      const archivesDir = join(packageRoot, 'tools', 'archives');
      await mkdir(archivesDir, { recursive: true });
      if (managedArchiveName) await writeFile(join(archivesDir, managedArchiveName), 'managed bytes\n', 'utf8');
      if (checksumManifest) await writeFile(join(archivesDir, RUNTIME_ASSET_CHECKSUM_MANIFEST_NAME), '\n', 'utf8');
    }
    return { packageRoot, tarballPath: packWithNpm(packageRoot) };
  } catch (error) {
    await rm(packageRoot, { recursive: true, force: true });
    throw error;
  }
}

async function createUnpackedTarball(managedRuntimePublication = { v: 1, mode: 'complete', unavailableProviderRefs: [] }) {
  const root = await mkdtemp(join(tmpdir(), 'happier-cli-runtime-unpacked-'));
  try {
    const packageDir = join(root, 'package');
    await mkdir(join(packageDir, 'tools', 'unpacked'), { recursive: true });
    await writeFile(join(packageDir, 'package.json'), `${JSON.stringify({
      name: '@happier-dev/cli',
      version: '0.0.0-test',
      happier: {
        managedRuntimePublication,
      },
    })}\n`, 'utf8');
    await writeFile(join(packageDir, 'tools', 'unpacked', 'should-not-ship'), 'leak\n', 'utf8');
    const tarballPath = join(root, 'unpacked-cli.tgz');
    execFileSync('tar', ['-czf', tarballPath, 'package'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    return { root, tarballPath };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

test('CLI publication validates the real npm packlist of every runtime archive and excludes tools/unpacked', async () => {
  const fixture = await createCliPackFixture({ includeUnpacked: true });
  try {
    const entries = archiveEntries(fixture.tarballPath);
    const expectedArchives = getCliRuntimeAssetArchiveManifest().map(
      (runtimeAsset) => `package/tools/archives/${runtimeAsset.archiveName}`,
    );
    assert.deepEqual(
      expectedArchives.filter((entry) => !entries.includes(entry)),
      [],
      'the effective npm packlist must include every advertised CLI runtime archive',
    );
    assert.equal(
      entries.filter((entry) => entry === `package/tools/archives/${RUNTIME_ASSET_CHECKSUM_MANIFEST_NAME}`).length,
      1,
      'the effective npm packlist must include exactly one runtime-asset checksum manifest',
    );
    assert.equal(
      entries.some((entry) => entry === 'package/tools/unpacked' || entry.startsWith('package/tools/unpacked/')),
      false,
      'the effective npm packlist must never include unpacked runtime bytes',
    );
    assert.doesNotThrow(() => assertCliManagedRuntimeTarballCoherence(fixture.tarballPath));
    assert.doesNotThrow(() => assertCliManagedRuntimeTarballPublication(fixture.tarballPath));
  } finally {
    await rm(fixture.packageRoot, { recursive: true, force: true });
  }
});

test('CLI publication fails closed for an incomplete archive inventory or unpacked runtime bytes', async () => {
  const [firstRuntimeAsset] = getCliRuntimeAssetArchiveManifest();
  assert.ok(firstRuntimeAsset);
  const missingArchive = await createCliPackFixture({ omitArchiveName: firstRuntimeAsset.archiveName });
  const missingManifest = await createCliPackFixture({ omitChecksumManifest: true });
  const missingChecksum = await createCliPackFixture({ omitChecksumName: firstRuntimeAsset.archiveName });
  const unpacked = await createUnpackedTarball();
  const extraArchiveName = 'happier-cliproxyapi-managed-riscv64-linux.tar.gz';
  const extraArchive = await createCliPackFixture({ extraArchiveName });
  const extraChecksum = await createCliPackFixture({ extraChecksumName: extraArchiveName });
  try {
    assert.throws(
      () => assertCliManagedRuntimeTarballPublication(missingArchive.tarballPath),
      new RegExp(`missing exactly one managed runtime archive.*${firstRuntimeAsset.platformDir}`, 'u'),
    );
    assert.throws(
      () => assertCliManagedRuntimeTarballPublication(missingManifest.tarballPath),
      new RegExp(`must contain exactly one package/tools/archives/${RUNTIME_ASSET_CHECKSUM_MANIFEST_NAME}`, 'u'),
    );
    assert.throws(
      () => assertCliManagedRuntimeTarballPublication(missingChecksum.tarballPath),
      new RegExp(`missing a checksum inventory entry.*${firstRuntimeAsset.archiveName}`, 'u'),
    );
    assert.throws(
      () => assertCliManagedRuntimeTarballPublication(unpacked.tarballPath),
      /must not contain tools\/unpacked runtime content/u,
    );
    assert.throws(
      () => assertCliManagedRuntimeTarballPublication(extraArchive.tarballPath),
      /unexpected managed runtime archives/u,
    );
    assert.throws(
      () => assertCliManagedRuntimeTarballPublication(extraChecksum.tarballPath),
      /checksum inventory contains unexpected entries/u,
    );
  } finally {
    await Promise.all([
      rm(missingArchive.packageRoot, { recursive: true, force: true }),
      rm(missingManifest.packageRoot, { recursive: true, force: true }),
      rm(missingChecksum.packageRoot, { recursive: true, force: true }),
      rm(unpacked.root, { recursive: true, force: true }),
      rm(extraArchive.packageRoot, { recursive: true, force: true }),
      rm(extraChecksum.packageRoot, { recursive: true, force: true }),
    ]);
  }
});


test('CLI source-only pack coherence proves exact unavailable facets and zero managed runtime bytes', async () => {
  const refs = expectedUnavailableProviderRefs();
  const valid = await createSourceOnlyCliPackFixture();
  const reorderedObjectKeys = await createSourceOnlyCliPackFixture({
    unavailableProviderRefs: refs.map(({ pluginId, providerId }) => ({ providerId, pluginId })),
  });
  const missingRefs = await createSourceOnlyCliPackFixture({ unavailableProviderRefs: [] });
  const wrongRef = await createSourceOnlyCliPackFixture({
    unavailableProviderRefs: refs.map((ref, index) => index === 0 ? { ...ref, providerId: `${ref.providerId}-wrong` } : ref),
  });
  const duplicateRef = await createSourceOnlyCliPackFixture({ unavailableProviderRefs: [...refs, refs[0]] });
  const knownArchive = await createSourceOnlyCliPackFixture({
    managedArchiveName: getCliRuntimeAssetArchiveManifest()[0].archiveName,
  });
  const unknownArchive = await createSourceOnlyCliPackFixture({
    managedArchiveName: 'happier-cliproxyapi-managed-riscv64-linux.tar.gz',
  });
  const checksum = await createSourceOnlyCliPackFixture({ checksumManifest: true });
  const unpacked = await createUnpackedTarball({ v: 1, mode: 'source-only', unavailableProviderRefs: refs });
  try {
    assert.doesNotThrow(() => assertCliManagedRuntimeTarballCoherence(valid.tarballPath));
    assert.doesNotThrow(() => assertCliManagedRuntimeTarballCoherence(reorderedObjectKeys.tarballPath));
    assert.throws(() => assertCliManagedRuntimeTarballPublication(valid.tarballPath), /complete publication metadata/u);
    for (const fixture of [missingRefs, wrongRef]) {
      assert.throws(() => assertCliManagedRuntimeTarballCoherence(fixture.tarballPath), /exact unavailable managed Provider references/u);
    }
    assert.throws(() => assertCliManagedRuntimeTarballCoherence(duplicateRef.tarballPath), /must not contain duplicates/u);
    for (const fixture of [knownArchive, unknownArchive]) {
      assert.throws(() => assertCliManagedRuntimeTarballCoherence(fixture.tarballPath), /must not contain managed runtime archives/u);
    }
    assert.throws(() => assertCliManagedRuntimeTarballCoherence(checksum.tarballPath), /must not contain the managed runtime checksum manifest/u);
    assert.throws(() => assertCliManagedRuntimeTarballCoherence(unpacked.tarballPath), /must not contain tools\/unpacked runtime content/u);
  } finally {
    await Promise.all([
      valid, reorderedObjectKeys, missingRefs, wrongRef, duplicateRef, knownArchive, unknownArchive, checksum,
    ].map((fixture) => rm(fixture.packageRoot, { recursive: true, force: true })));
    await rm(unpacked.root, { recursive: true, force: true });
  }
});
