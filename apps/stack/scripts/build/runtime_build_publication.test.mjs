import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTempFixture } from '../testkit/core/temp_fixture.mjs';
import { withRuntimeBuildPublication } from './build_stack_artifacts.mjs';

test('each explicit build publishes its own requested output without replaying prior demand', async t => {
  const fixture = await createTempFixture(t, { prefix: 'explicit-runtime-build-' });
  const authority = { producerStackName: 'producer', producerStackBaseDir: fixture.root };
  const target = { platform: process.platform, arch: process.arch };
  const selection = { components: { web: true }, activateRuntime: false };
  const publish = fingerprint => async () => {
    const artifactDir = fixture.path('artifacts', 'web', fingerprint);
    mkdirSync(join(artifactDir, 'payload'), { recursive: true });
    writeFileSync(join(artifactDir, 'payload', 'index.html'), `<html>${fingerprint}</html>`);
    const manifest = { version: 1, component: 'web', artifactFingerprint: fingerprint,
      sourceFingerprint: fingerprint, payloadDir: 'payload', entrypoint: 'index.html', target };
    writeFileSync(join(artifactDir, 'manifest.json'), JSON.stringify(manifest));
    return { artifacts: { web: { artifactDir, manifest } }, snapshotId: null };
  };
  await withRuntimeBuildPublication({ authority, target, selection,
    publish: publish('aaaaaaaaaaaaaaaa') });
  const latest = await withRuntimeBuildPublication({ authority, target, selection,
    publish: publish('bbbbbbbbbbbbbbbb') });
  assert.equal(latest.artifacts.web.manifest.artifactFingerprint, 'bbbbbbbbbbbbbbbb');
  assert.equal(existsSync(fixture.path('runtime', 'publication-demands')), false);
});


test('failed explicit construction records failure without replacing selected runtime', async t => {
  const fixture = await createTempFixture(t, { prefix: 'explicit-runtime-failure-' });
  const authority = { producerStackName: 'producer', producerStackBaseDir: fixture.root };
  mkdirSync(fixture.path('runtime'), { recursive: true });
  writeFileSync(fixture.path('runtime', 'current.json'), '{"snapshotId":"last-green"}');
  await assert.rejects(withRuntimeBuildPublication({
    authority, selection: { components: { daemon: true }, activateRuntime: false },
    publish: async () => { throw new Error('emitter failed'); },
  }), /emitter failed/);
  assert.equal(readFileSync(fixture.path('runtime', 'current.json'), 'utf8'), '{"snapshotId":"last-green"}');
  const state = JSON.parse(readFileSync(fixture.path('stack.runtime.json'), 'utf8'));
  assert.equal(state.runtimePublication.components.daemon.phase, 'failed');
});
