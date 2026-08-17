import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { materializeBundleCandidate, packBundleCandidate } from './bundle-candidate.mjs';

test('bundle candidate is source/version bound and materializes only fixed inputs', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tauri-candidate-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const candidateUi = path.join(root, 'candidate-ui');
  const trustedUi = path.join(root, 'trusted-ui');
  const outDir = path.join(root, 'candidate');
  fs.mkdirSync(path.join(candidateUi, 'src-tauri', 'target', 'release'), { recursive: true });
  fs.mkdirSync(path.join(candidateUi, 'src-tauri', 'binaries'), { recursive: true });
  fs.writeFileSync(path.join(candidateUi, 'src-tauri', 'target', 'release', 'app'), 'candidate-app');
  fs.writeFileSync(path.join(candidateUi, 'src-tauri', 'binaries', 'hsetup-x86_64-unknown-linux-gnu'), 'candidate-sidecar');
  fs.writeFileSync(path.join(candidateUi, 'src-tauri', 'binaries', 'hsetup-x86_64-unknown-linux-gnu.gz'), 'candidate-sidecar-gzip');

  const identity = { platformKey: 'linux-x86_64', tauriTarget: '', sourceSha: 'a'.repeat(40), environment: 'preview', uiVersion: '1.2.3', buildVersion: '1.2.3-preview.7' };
  packBundleCandidate({ ...identity, uiDir: candidateUi, outDir });
  materializeBundleCandidate({ ...identity, uiDir: trustedUi, candidateDir: outDir });
  assert.equal(fs.readFileSync(path.join(trustedUi, 'src-tauri', 'target', 'release', 'app'), 'utf8'), 'candidate-app');
  assert.equal(fs.readFileSync(path.join(trustedUi, 'src-tauri', 'binaries', 'hsetup-x86_64-unknown-linux-gnu.gz'), 'utf8'), 'candidate-sidecar-gzip');
  assert.throws(() => materializeBundleCandidate({ ...identity, sourceSha: 'b'.repeat(40), uiDir: trustedUi, candidateDir: outDir }), /sourceSha does not match/);
  fs.writeFileSync(path.join(outDir, 'files', 'unexpected'), 'no');
  assert.throws(() => materializeBundleCandidate({ ...identity, uiDir: trustedUi, candidateDir: outDir }), /unexpected entries/);
});
