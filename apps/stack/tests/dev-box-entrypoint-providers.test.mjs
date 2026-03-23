import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { buildStackHarnessEnv, writeFakeBin } from '../scripts/testkit/core/fake_bin_harness.mjs';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));

test('dev-box entrypoint installs provider CLIs via hstack when HAPPIER_PROVIDER_CLIS is set', (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'happier-dev-box-entrypoint-'));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const logPath = join(tmp, 'hstack.log');
  writeFileSync(logPath, '', 'utf-8');

  const { binDir } = writeFakeBin({
    root: tmp,
    name: 'hstack',
    content: `#!/bin/sh
set -eu
echo "$@" >> "${logPath}"
exit 0
`,
  });

  const entrypoint = join(repoRoot, 'docker', 'dev-box', 'entrypoint.sh');
  const res = spawnSync('sh', [entrypoint, 'sh', '-lc', 'echo ok'], {
    env: buildStackHarnessEnv({
      binDirs: [binDir],
      extraEnv: { HAPPIER_PROVIDER_CLIS: 'codex' },
    }),
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
