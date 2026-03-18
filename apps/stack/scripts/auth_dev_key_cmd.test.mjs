import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { authScriptPath, getStackRootFromMeta, runNodeCapture } from './testkit/auth_testkit.mjs';

test('hstack auth dev-key --set stores key and exits successfully', async () => {
  const rootDir = getStackRootFromMeta(import.meta.url);
  const homeDir = await mkdtemp(join(tmpdir(), 'happier-auth-dev-key-'));
  const key = Buffer.alloc(32, 7).toString('base64url');

  try {
    const env = {
      ...process.env,
      HAPPIER_STACK_HOME_DIR: homeDir,
      HAPPIER_STACK_STACK: 'test-stack',
      HAPPIER_STACK_ENV_FILE: join(homeDir, 'missing.env'),
    };

    const res = await runNodeCapture([authScriptPath(rootDir), 'dev-key', `--set=${key}`], { cwd: rootDir, env });
    assert.equal(
      res.code,
      0,
      `expected exit 0, got ${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`
    );

    const storedRaw = await readFile(join(homeDir, 'keys', 'dev-auth.json'), 'utf-8');
    const stored = JSON.parse(storedRaw);
    assert.equal(stored.secretKeyBase64Url, key);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});
