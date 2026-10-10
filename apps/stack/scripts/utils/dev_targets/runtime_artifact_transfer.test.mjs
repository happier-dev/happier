import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { getFirstPartyComponentCatalogEntry } from '@happier-dev/cli-common/firstPartyRuntime/componentCatalog';
import { linkDaemonSupportPayload } from '../../build/build_daemon_artifact.mjs';
import { readReusableArtifactManifest } from '../../runtime/shared/artifact_manifest.mjs';
import { importRuntimeArtifactClosure, packControlledRuntimeSnapshot, packRuntimeArtifactClosure, runRuntimeArchiveCommand } from './runtime_artifact_transfer.mjs';
import { symlink } from 'node:fs/promises';


test('controlled import entry releases its uploaded archive after a rejected import', async () => {
  const root = await mkdtemp(join(tmpdir(), 'controlled-import-cleanup-'));
  try {
    const archivePath = join(root, 'snapshot.tar');
    await writeFile(archivePath, 'incomplete archive');
    const consumer = join(root, 'consumer');
    await mkdir(consumer);
    await writeFile(join(consumer, 'retained.txt'), 'retained');
    const entry = fileURLToPath(new URL('./runtime_artifact_transfer.mjs', import.meta.url));
    const result = spawnSync(process.execPath, [entry, `--archive=${archivePath}`, `--stack-base-dir=${consumer}`, '--snapshot-id=broken'], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /runtime archive operation failed/);
    await assert.rejects(stat(archivePath), { code: 'ENOENT' });
    assert.deepEqual(await readdir(consumer), ['retained.txt']);
    assert.equal(await readFile(join(consumer, 'retained.txt'), 'utf8'), 'retained');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('controlled archive import stages on consumer storage without usable system temp and retains the complete relocatable closure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'controlled-transfer-'));
  const producer = join(root, 'producer');
  const consumer = join(root, 'consumer');
  const target = { platform: process.platform, arch: process.arch };
  const snapshotId = 'qa-snapshot';
  const snapshotDir = join(producer, 'runtime/builds', snapshotId);
  const components = {};
  const artifacts = {};
  try {
    for (const [component, directory, entrypoint] of [['web', 'ui', 'index.html'], ['server', 'server', 'happier-server'], ['daemon', 'cli', 'happier']]) {
      const artifactDir = join(producer, 'artifacts', component, component + '-code');
      await mkdir(join(artifactDir, 'payload'), { recursive: true });
      await writeFile(join(artifactDir, 'payload', entrypoint), component);
      if (component === 'daemon') {
        const nodeEntrypoint = join(artifactDir, 'payload', getFirstPartyComponentCatalogEntry('happier-daemon').nodeEntrypointRelativePath);
        await mkdir(dirname(nodeEntrypoint), { recursive: true });
        await writeFile(nodeEntrypoint, 'export {};');
        await writeFile(join(dirname(nodeEntrypoint), '.build-manifest.json'), JSON.stringify({ fingerprint: '1234567890abcdef' }));
      }
      const manifest = { version: 1, component, artifactFingerprint: component + '-code', sourceFingerprint: 'source', payloadDir: 'payload', entrypoint, target };
      await writeFile(join(artifactDir, 'manifest.json'), JSON.stringify(manifest));
      artifacts[component] = { manifest };
      await mkdir(snapshotDir, { recursive: true });
      await symlink(`../../../artifacts/${component}/${component}-code/payload`, join(snapshotDir, directory));
      components[component] = { artifactFingerprint: component + '-code', entrypoint: directory + '/' + entrypoint };
    }
    await writeFile(join(snapshotDir, 'manifest.json'), JSON.stringify({ version: 1, snapshotId, sourceFingerprint: 'source', components, target }));
    await assert.rejects(importRuntimeArtifactClosure({ sourceStackBaseDir: producer, stackBaseDir: consumer, artifacts, snapshotId, target: { ...target, arch: 'foreign' } }), /target/);
    const archivePath = join(root, 'snapshot.tar');
    await packControlledRuntimeSnapshot({ snapshot: { producerStackBaseDir: producer, snapshotId, manifest: { components } }, target, archivePath });
    // Real child/OS temp boundary: usable consumer storage must suffice even
    // when system temp is unavailable (the live QA host has tmpfs user quotas).
    const unavailableTemp = join(root, 'unavailable-system-temp');
    const entry = fileURLToPath(new URL('./runtime_artifact_transfer.mjs', import.meta.url));
    const result = spawnSync(process.execPath, [entry, `--archive=${archivePath}`, `--stack-base-dir=${consumer}`, `--snapshot-id=${snapshotId}`], {
      encoding: 'utf8', env: { ...process.env, TMPDIR: unavailableTemp, TEMP: unavailableTemp, TMP: unavailableTemp },
    });
    assert.equal(result.status, 0, result.stderr);
    await assert.rejects(stat(archivePath), { code: 'ENOENT' });
    await rm(producer, { recursive: true });
    assert.equal(await readFile(join(consumer, 'runtime/builds', snapshotId, 'cli/happier'), 'utf8'), 'daemon');
    const pointer = JSON.parse(await readFile(join(consumer, 'runtime/current.json'), 'utf8'));
    assert.equal(pointer.snapshotId, snapshotId);
    assert.equal(pointer.snapshotPath, join(consumer, 'runtime/builds', snapshotId));
    assert.deepEqual((await readdir(consumer)).sort(), ['artifacts', 'runtime']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('artifact transfer preserves support closure after the worker store disappears and rejects damaged or foreign-target bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'runtime-transfer-'));
  const worker = join(root, 'worker');
  const producer = join(root, 'producer');
  const target = { platform: process.platform, arch: process.arch };
  const codeDir = join(worker, 'artifacts/daemon/code');
  const supportDir = join(worker, 'artifacts/daemon-support/support');
  const manifest = (component, artifactFingerprint, entrypoint) => ({
    version: 1, component, artifactFingerprint, sourceFingerprint: 'source', payloadDir: 'payload', entrypoint, target,
  });
  const code = { ...manifest('daemon', 'code', 'happier'), daemonSupportArtifactFingerprint: 'support' };
  const artifacts = { daemon: { manifest: code } };
  try {
    for (const name of ['node_modules', 'tools', 'scripts', '.project']) await mkdir(join(supportDir, 'payload', name), { recursive: true });
    await mkdir(join(codeDir, 'payload'), { recursive: true });
    await writeFile(join(codeDir, 'payload/happier'), 'code');
    await writeFile(join(supportDir, 'payload/tools/tool'), 'support');
    await writeFile(join(supportDir, 'manifest.json'), JSON.stringify(manifest('daemon-support', 'support', 'tools/tool')));
    await writeFile(join(codeDir, 'manifest.json'), JSON.stringify(code));
    await linkDaemonSupportPayload({ codePayloadDir: join(codeDir, 'payload'), supportPayloadDir: join(supportDir, 'payload') });
    await assert.rejects(importRuntimeArtifactClosure({ sourceStackBaseDir: worker, stackBaseDir: producer, artifacts, target: { ...target, arch: 'foreign' } }), /target/);
    await rm(join(supportDir, 'payload/tools/tool'));
    await assert.rejects(importRuntimeArtifactClosure({ sourceStackBaseDir: worker, stackBaseDir: producer, artifacts, target }), /invalid transferred/);
    await writeFile(join(supportDir, 'payload/tools/tool'), 'support');
    const imported = await importRuntimeArtifactClosure({ sourceStackBaseDir: worker, stackBaseDir: producer, artifacts, target });
    await rm(worker, { recursive: true });
    assert.ok(await readReusableArtifactManifest({ artifactDir: imported.daemon.artifactDir, artifactFingerprint: 'code' }));
    assert.equal(await readFile(join(imported.daemon.artifactDir, 'payload/tools/tool'), 'utf8'), 'support');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
