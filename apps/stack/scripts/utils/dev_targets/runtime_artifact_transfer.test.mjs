import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { linkDaemonSupportPayload } from '../../build/build_daemon_artifact.mjs';
import { readReusableArtifactManifest } from '../../runtime/shared/artifact_manifest.mjs';
import { importRuntimeArtifactClosure } from './runtime_artifact_transfer.mjs';

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
