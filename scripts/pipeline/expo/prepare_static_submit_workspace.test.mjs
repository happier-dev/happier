import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..');

test('prepares a dependency-free Android submit project from canonical app identity', () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'happier-expo-submit-'));
  try {
    execFileSync(
      process.execPath,
      [
        'scripts/pipeline/expo/prepare-static-submit-workspace.mjs',
        '--environment',
        'preview',
        '--profile',
        'preview',
        '--out-dir',
        outputDir,
      ],
      { cwd: repoRoot, stdio: 'pipe' },
    );

    const app = JSON.parse(fs.readFileSync(path.join(outputDir, 'app.json'), 'utf8'));
    const eas = JSON.parse(fs.readFileSync(path.join(outputDir, 'eas.json'), 'utf8'));
    assert.deepEqual(app.expo, {
      name: 'Happier (preview)',
      slug: 'happier',
      owner: 'happier-dev',
      android: { package: 'dev.happier.app.preview' },
      extra: { eas: { projectId: '2a550bd7-e4d2-4f59-ab47-dcb778775cee' } },
    });
    assert.deepEqual(eas, { submit: { preview: { android: { track: 'internal' } } } });
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(outputDir, 'package.json'), 'utf8')), {
      name: 'happier-static-expo-submit',
      private: true,
    });

    const artifactPath = path.join(outputDir, 'candidate.aab');
    fs.writeFileSync(artifactPath, 'fixture');
    const submitOutput = execFileSync(
      process.execPath,
      [
        'scripts/pipeline/expo/submit.mjs',
        '--environment',
        'preview',
        '--platform',
        'android',
        '--profile',
        'preview',
        '--project-dir',
        outputDir,
        '--path',
        artifactPath,
        '--wait',
        'false',
        '--dry-run',
      ],
      { cwd: repoRoot, env: { ...process.env, CI: 'true' }, encoding: 'utf8' },
    );
    assert.match(submitOutput, new RegExp(`cwd: ${outputDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.match(submitOutput, /eas-cli@18\.0\.1 submit --platform android --profile preview/);
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});

test('expo submit accepts an isolated project directory', () => {
  const src = fs.readFileSync(path.join(repoRoot, 'scripts/pipeline/expo/submit.mjs'), 'utf8');
  assert.match(src, /'project-dir':\s*\{\s*type:\s*'string'/);
  assert.match(src, /values\['project-dir'\]/);
  assert.match(src, /cwd:\s*uiDir/);
});
