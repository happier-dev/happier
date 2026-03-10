import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startManagedOpenCodeServer } from './openCodeManagedServer';

const ORIGINAL_ENV = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  HAPPIER_HOME_DIR: process.env.HAPPIER_HOME_DIR,
  HAPPIER_OPENCODE_PATH: process.env.HAPPIER_OPENCODE_PATH,
};

const TEMP_DIRS = new Set<string>();

afterEach(() => {
  if (ORIGINAL_ENV.PATH === undefined) delete process.env.PATH;
  else process.env.PATH = ORIGINAL_ENV.PATH;
  if (ORIGINAL_ENV.HOME === undefined) delete process.env.HOME;
  else process.env.HOME = ORIGINAL_ENV.HOME;
  if (ORIGINAL_ENV.HAPPIER_HOME_DIR === undefined) delete process.env.HAPPIER_HOME_DIR;
  else process.env.HAPPIER_HOME_DIR = ORIGINAL_ENV.HAPPIER_HOME_DIR;
  if (ORIGINAL_ENV.HAPPIER_OPENCODE_PATH === undefined) delete process.env.HAPPIER_OPENCODE_PATH;
  else process.env.HAPPIER_OPENCODE_PATH = ORIGINAL_ENV.HAPPIER_OPENCODE_PATH;
  for (const dir of TEMP_DIRS) rmSync(dir, { recursive: true, force: true });
  TEMP_DIRS.clear();
});

describe('startManagedOpenCodeServer', () => {
  it('fails closed when the OpenCode CLI is unavailable', async () => {
    const root = mkdtempSync(join(tmpdir(), 'happier-opencode-server-test-'));
    TEMP_DIRS.add(root);
    process.env.HAPPIER_HOME_DIR = join(root, 'home');
    process.env.HOME = join(root, 'home');
    process.env.PATH = join(root, 'empty-path');
    delete process.env.HAPPIER_OPENCODE_PATH;

    await expect(startManagedOpenCodeServer({ port: 43111, timeoutMs: 25 })).rejects.toThrow(/system install/i);
  });
});
