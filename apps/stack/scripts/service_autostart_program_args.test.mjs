import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import * as serviceModule from './service.mjs';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const rootDir = scriptsDir;

test('resolveStackAutostartProgramArgs uses the stable hstack shim with --restart', async (t) => {
  assert.equal(typeof serviceModule.resolveStackAutostartProgramArgs, 'function');

  const tmp = await mkdtemp(join(tmpdir(), 'stack-service-program-args-'));
  const canonicalHomeDir = join(tmp, 'canonical-home');
  const shimPath = join(canonicalHomeDir, 'bin', 'hstack');
  await mkdir(join(canonicalHomeDir, 'bin'), { recursive: true });
  await writeFile(shimPath, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

  const previousCanonicalHome = process.env.HAPPIER_STACK_CANONICAL_HOME_DIR;
  process.env.HAPPIER_STACK_CANONICAL_HOME_DIR = canonicalHomeDir;
  t.after(async () => {
    if (previousCanonicalHome == null) delete process.env.HAPPIER_STACK_CANONICAL_HOME_DIR;
    else process.env.HAPPIER_STACK_CANONICAL_HOME_DIR = previousCanonicalHome;
    await rm(tmp, { recursive: true, force: true });
  });

  const programArgs = await serviceModule.resolveStackAutostartProgramArgs({ rootDir, mode: 'user', systemUser: null });
  assert.deepEqual(programArgs, [shimPath, 'start', '--restart']);
});
