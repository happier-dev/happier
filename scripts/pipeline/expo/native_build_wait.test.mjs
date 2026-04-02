import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

function readRepoFile(relPath) {
  const here = path.dirname(url.fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(here, '..', '..', '..');
  return fs.readFileSync(path.join(repoRoot, relPath), 'utf8');
}

test('native-build supports disabling wait (so native_submit can schedule builds without blocking)', () => {
  const src = readRepoFile('scripts/pipeline/expo/native-build.mjs');
  assert.match(src, /\bwait:\s*\{\s*type:\s*'string'/, 'expected native-build.mjs to accept a wait flag');
  assert.match(src, /--no-wait/, "expected native-build.mjs to pass '--no-wait' when wait is disabled");
});

test('native-build forwards --wait/--no-wait in interactive (non --non-interactive) mode', () => {
  const src = readRepoFile('scripts/pipeline/expo/native-build.mjs');

  // Assert against the interactive cloud build `run(...)` call (the one that uses
  // `cwd: uiDir` + `stdio: 'inherit'` and does not rely on `--non-interactive --json`).
  assert.match(
    src,
    /run\(\s*[\s\S]*?'npx'\s*,\s*\[\s*[\s\S]*?'build'[\s\S]*?'--profile'[\s\S]*?profile[\s\S]*?\.\.\.\(waitForBuild\s*\?\s*\['--wait'\]\s*:\s*\['--no-wait'\]\)[\s\S]*?\]\s*,\s*\{\s*cwd:\s*uiDir[\s\S]*?stdio:\s*'inherit'[\s\S]*?\}\s*\)\s*;/,
    "expected interactive cloud build invocation to forward '--wait' or '--no-wait'",
  );
});

test('ui-mobile-release native_submit (cloud) disables waiting for EAS build completion', () => {
  const src = readRepoFile('scripts/pipeline/run.mjs');
  assert.match(src, /native_submit[\s\S]+--wait/, 'expected ui-mobile-release native_submit to pass --wait to native-build');
});
