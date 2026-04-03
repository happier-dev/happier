import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

function writeFile(p, contents) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, contents);
}

test('collect-updater-artifacts supports Windows .msi.sig updater signatures (non-zipped)', () => {
  const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..');
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'happier-tauri-collect-'));
  const artifactRel = path.join(
    'apps',
    'ui',
    'src-tauri',
    'target',
    'release',
    'bundle',
    'msi',
    'Happier (dev)_0.1.2-23_x64_en-US.msi',
  );
  const sigRel = `${artifactRel}.sig`;

  const fixtureUiDir = path.join(fixtureRoot, 'apps', 'ui');
  writeFile(path.join(fixtureUiDir, 'src-tauri', 'target', 'release', 'bundle', 'msi', path.basename(artifactRel)), 'msi-bytes');
  writeFile(
    path.join(fixtureUiDir, 'src-tauri', 'target', 'release', 'bundle', 'msi', `${path.basename(artifactRel)}.sig`),
    'signature',
  );

  execFileSync(
    process.execPath,
    [
      path.join(repoRoot, 'scripts', 'pipeline', 'tauri', 'collect-updater-artifacts.mjs'),
      '--environment',
      'dev',
      '--platform-key',
      'windows-x86_64',
      '--ui-version',
      '0.1.2',
      '--ui-dir',
      fixtureUiDir,
    ],
    { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] },
  );

  const outDir = path.join(repoRoot, 'dist', 'tauri', 'updates', 'windows-x86_64');
  assert.ok(fs.existsSync(outDir), 'expected output dir to exist');

  const outArtifact = path.join(outDir, 'happier-ui-desktop-dev-windows-x86_64.msi');
  const outSig = `${outArtifact}.sig`;
  assert.ok(fs.existsSync(outArtifact), 'expected output artifact to exist');
  assert.ok(fs.existsSync(outSig), 'expected output signature to exist');

  fs.rmSync(outDir, { recursive: true, force: true });
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
});
