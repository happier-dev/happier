import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { createTempDir } from './tempdir.test_helper.mjs';

const stackRoot = fileURLToPath(new URL('..', import.meta.url));

function makeFailingNpmBin(tmp) {
  const binDir = join(tmp, 'bin');
  mkdirSync(binDir, { recursive: true });
  const npmPath = join(binDir, 'npm');
  writeFileSync(
    npmPath,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === 'install') {
  process.stderr.write('fake install failure\\n');
  process.exit(42);
}
if (args[0] === 'view') {
  process.stdout.write('9.9.9\\n');
  process.exit(0);
}
process.exit(0);
`,
    'utf-8'
  );
  chmodSync(npmPath, 0o755);
  return { binDir };
}

test('hstack self update prints a concise failure message without stack trace noise', (t) => {
  const tmp = createTempDir(t, 'hstack-self-update-fail-');
  const { binDir } = makeFailingNpmBin(tmp);
  const res = spawnSync(process.execPath, [join('scripts', 'self.mjs'), 'update', '--json'], {
    cwd: stackRoot,
    env: {
      ...process.env,
      PATH: `${binDir}${delimiter}${process.env.PATH ?? ''}`,
      HAPPIER_STACK_HOME_DIR: join(tmp, 'home'),
    },
    encoding: 'utf-8',
    timeout: 10000,
  });
  if (res.error) throw res.error;
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /\[self\] failed: npm install exited with status 42/i);
  assert.doesNotMatch(res.stderr, /\n\s*at\s+/i);
});
