import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('npm pack dry run excludes incremental build metadata from the published file list', () => {
  const result = spawnSync('npm', ['pack', '--json', '--dry-run'], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);

  const packResult = JSON.parse(result.stdout);
  const files = Array.isArray(packResult) && packResult[0] && Array.isArray(packResult[0].files)
    ? packResult[0].files.map((file) => file.path)
    : [];

  assert.equal(files.includes('dist/.tsbuildinfo'), false);
});
