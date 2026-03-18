import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');

function readScript(relPath) {
  return fs.readFileSync(path.join(repoRoot, relPath), 'utf8');
}

test('expo pipeline scripts resolve interactivity through a shared helper', () => {
  const nativeBuild = readScript('scripts/pipeline/expo/native-build.mjs');
  const submit = readScript('scripts/pipeline/expo/submit.mjs');

  assert.match(nativeBuild, /resolve-expo-interactivity\.mjs/);
  assert.match(submit, /resolve-expo-interactivity\.mjs/);
  assert.doesNotMatch(nativeBuild, /String\(process\.env\.PIPELINE_INTERACTIVE \?\? ''\)/);
  assert.doesNotMatch(submit, /Boolean\(expoToken\) && !pipelineInteractive/);
});

test('expo submit stays interactive locally unless PIPELINE_INTERACTIVE opts into non-interactive mode', () => {
  const out = execFileSync(
    process.execPath,
    [
      path.join(repoRoot, 'scripts', 'pipeline', 'expo', 'submit.mjs'),
      '--environment',
      'preview',
      '--platform',
      'android',
      '--dry-run',
    ],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        CI: '',
        EXPO_TOKEN: 'test-token',
        PIPELINE_INTERACTIVE: '',
      },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    },
  );

  assert.match(out, /\[pipeline\] expo submit: environment=preview platform=android/);
  assert.match(out, /\[dry-run\].*\bnpx\b/);
  assert.doesNotMatch(out, /\s--non-interactive\b/);
});
