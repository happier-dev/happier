import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));

test('dev-box entrypoint installs provider CLIs via hstack when HAPPIER_PROVIDER_CLIS is set', (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'happier-dev-box-entrypoint-'));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const binDir = join(tmp, 'bin');
  mkdirSync(binDir, { recursive: true });
  const logPath = join(tmp, 'hstack.log');
  writeFileSync(logPath, '', 'utf-8');

  const hstackPath = join(binDir, 'hstack');
  writeFileSync(
    hstackPath,
    `#!/bin/sh
set -eu
echo "$@" >> "${logPath}"
exit 0
`,
    'utf-8',
  );
  chmodSync(hstackPath, 0o755);

  const entrypoint = join(repoRoot, 'docker', 'dev-box', 'entrypoint.sh');
  const injectedPath = `${binDir}${delimiter}${process.env.PATH ?? ''}`;
  const res = spawnSync('sh', [entrypoint, 'sh', '-lc', 'echo ok'], {
    env: { ...process.env, PATH: injectedPath, HAPPIER_PROVIDER_CLIS: 'codex' },
    encoding: 'utf-8',
    timeout: 15000,
  });
  if (res.error) throw res.error;
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout ?? '', /ok/);

  const log = readFileSync(logPath, 'utf-8');
  assert.match(log, /providers install/);
  assert.match(log, /codex/);
});
