import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { materializeBundleCandidate, packBundleCandidate, planBundleCandidates } from './bundle-candidate.mjs';

for (const [platformKey, tauriTarget, sidecar] of [
  ['linux-x86_64', '', 'hsetup-x86_64-unknown-linux-gnu'],
  ['windows-x86_64', '', 'hsetup-x86_64-pc-windows-msvc.exe'],
  ['darwin-aarch64', 'aarch64-apple-darwin', 'hsetup-aarch64-apple-darwin'],
  ['darwin-x86_64', 'x86_64-apple-darwin', 'hsetup-x86_64-apple-darwin'],
]) {
  test(`bundle candidate transfers configured channel binaries and verifies integrity (${platformKey})`, (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tauri-candidate-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const candidateUi = path.join(root, 'candidate-ui');
    const trustedUi = path.join(root, 'trusted-ui');
    const outDir = path.join(root, 'candidate');
    const releaseParts = ['src-tauri', 'target', ...(tauriTarget ? [tauriTarget] : []), 'release'];
    fs.mkdirSync(path.join(candidateUi, ...releaseParts), { recursive: true });
    fs.mkdirSync(path.join(candidateUi, 'src-tauri', 'binaries'), { recursive: true });
    for (const uiDir of [candidateUi, trustedUi]) {
      fs.mkdirSync(path.join(uiDir, 'src-tauri'), { recursive: true });
      for (const file of ['tauri.conf.json', 'tauri.preview.conf.json', 'tauri.publicdev.conf.json']) {
        fs.copyFileSync(fileURLToPath(new URL(`../../../apps/ui/src-tauri/${file}`, import.meta.url)), path.join(uiDir, 'src-tauri', file));
      }
      // Prove candidate transfer consumes the config, rather than another name table.
      const configPath = path.join(uiDir, 'src-tauri', 'tauri.preview.conf.json');
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      fs.writeFileSync(configPath, JSON.stringify({ ...config, mainBinaryName: 'happier-desktop-preview-test' }));
    }
    const executable = `happier-desktop-preview-test${platformKey.startsWith('windows-') ? '.exe' : ''}`;
    fs.writeFileSync(path.join(candidateUi, ...releaseParts, executable), 'candidate-app');
    fs.writeFileSync(path.join(candidateUi, 'src-tauri', 'binaries', sidecar), 'candidate-sidecar');
    if (platformKey.startsWith('linux-')) fs.writeFileSync(path.join(candidateUi, 'src-tauri', 'binaries', `${sidecar}.gz`), 'candidate-sidecar-gzip');

    const identity = { platformKey, tauriTarget, sourceSha: 'a'.repeat(40), environment: 'preview', uiVersion: '1.2.3', buildVersion: '1.2.3-preview.7' };
    packBundleCandidate({ ...identity, uiDir: candidateUi, outDir });
    materializeBundleCandidate({ ...identity, uiDir: trustedUi, candidateDir: outDir });
    assert.equal(fs.readFileSync(path.join(trustedUi, ...releaseParts, executable), 'utf8'), 'candidate-app');
    assert.equal(fs.readFileSync(path.join(trustedUi, 'src-tauri', 'binaries', sidecar), 'utf8'), 'candidate-sidecar');
    if (platformKey.startsWith('linux-')) assert.equal(fs.readFileSync(path.join(trustedUi, 'src-tauri', 'binaries', `${sidecar}.gz`), 'utf8'), 'candidate-sidecar-gzip');
    assert.throws(() => materializeBundleCandidate({ ...identity, sourceSha: 'b'.repeat(40), uiDir: trustedUi, candidateDir: outDir }), /sourceSha does not match/);
    for (const [field, value] of [['environment', 'dev'], ['uiVersion', '1.2.4'], ['buildVersion', '1.2.3-preview.8']]) {
      assert.throws(() => materializeBundleCandidate({ ...identity, [field]: value, uiDir: trustedUi, candidateDir: outDir }), new RegExp(`${field} does not match`));
    }
    fs.writeFileSync(path.join(outDir, 'files', executable), 'tampered-app');
    assert.throws(() => materializeBundleCandidate({ ...identity, uiDir: trustedUi, candidateDir: outDir }), /integrity mismatch/);
    fs.writeFileSync(path.join(outDir, 'files', 'unexpected'), 'no');
    assert.throws(() => materializeBundleCandidate({ ...identity, uiDir: trustedUi, candidateDir: outDir }), /unexpected entries/);
  });
}

test('candidate plan builds only missing platforms and retains all finalizers when every candidate is reused', () => {
  const allPlatforms = ['linux-x86_64', 'windows-x86_64', 'darwin-aarch64', 'darwin-x86_64'];
  const artifacts = Object.fromEntries(allPlatforms.map((platform, index) => [platform, { id: index + 1, digest: `sha256:${'b'.repeat(64)}` }]));
  const plan = (reused) => {
    const result = spawnSync(process.execPath, [new URL('./bundle-candidate.mjs', import.meta.url).pathname,
      '--mode', 'plan', '--resume-artifacts-json', JSON.stringify(reused)], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  const fresh = plan({});
  assert.deepEqual(fresh.buildMatrix.include.map((entry) => entry.platform_key), allPlatforms);
  const partial = plan({ 'darwin-aarch64': artifacts['darwin-aarch64'] });
  assert.deepEqual(partial.buildMatrix.include.map((entry) => entry.platform_key), allPlatforms.filter((key) => key !== 'darwin-aarch64'));
  const reused = plan(artifacts);
  assert.equal(reused.buildNeeded, false);
  assert.deepEqual(reused.buildMatrix.include, []);
  assert.deepEqual(reused.finalizeMatrix.include.map((entry) => [entry.platform_key, entry.artifact_id, entry.artifact_digest]),
    allPlatforms.map((key) => [key, artifacts[key].id, artifacts[key].digest]));
});

test('finalized desktop artifacts bypass builds and finalizers while missing siblings use unsigned candidates', () => {
  const artifact = { id: 37, digest: `sha256:${'b'.repeat(64)}` };
  const plan = planBundleCandidates({ 'linux-x86_64': artifact, 'windows-x86_64': artifact }, {
    'linux-x86_64': { ...artifact, id: 38 }, 'darwin-aarch64': artifact,
  });
  assert.deepEqual(plan.buildMatrix.include.map((entry) => entry.platform_key), ['darwin-x86_64']);
  assert.deepEqual(plan.finalizeMatrix.include.map((entry) => [entry.platform_key, entry.artifact_id]),
    [['windows-x86_64', 37], ['darwin-x86_64', '']]);
  assert.deepEqual(plan.reuseMatrix.include.map((entry) => [entry.platform_key, entry.artifact_id, entry.artifact_digest]),
    [['linux-x86_64', 38, artifact.digest], ['darwin-aarch64', 37, artifact.digest]]);
  assert.equal(plan.finalizeNeeded, true);
  assert.equal(plan.reuseNeeded, true);
  const complete = planBundleCandidates({}, Object.fromEntries(
    ['linux-x86_64', 'windows-x86_64', 'darwin-aarch64', 'darwin-x86_64'].map((key) => [key, artifact])));
  assert.equal(complete.buildNeeded, false);
  assert.equal(complete.finalizeNeeded, false);
  assert.equal(complete.reuseNeeded, true);
  assert.deepEqual(complete.finalizeMatrix.include, []);
});
