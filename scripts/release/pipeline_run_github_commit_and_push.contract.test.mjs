import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

function run(args) {
  return spawnSync(process.execPath, [path.join(repoRoot, 'scripts', 'pipeline', 'run.mjs'), ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
}

test('pipeline run exposes github-commit-and-push (dry-run)', () => {
  const res = run([
    'github-commit-and-push',
    '--paths',
    'package.json',
    '--message',
    'test commit (dry-run)',
    '--push-mode',
    'never',
    '--dry-run',
  ]);
  assert.equal(res.status, 0, `expected exit 0, got ${res.status} stderr=${res.stderr}`);
  assert.match(res.stdout, /\[dry-run\].*git add package\.json/);
  assert.match(res.stdout, /\[dry-run\].*git commit -m "test commit \(dry-run\)"/);
  assert.match(res.stdout, /DID_COMMIT=true/);
  assert.doesNotMatch(res.stdout, /\[dry-run\].*git push\b/);
});

