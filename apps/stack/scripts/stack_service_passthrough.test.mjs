import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { withPatchedProcessEnv } from './testkit/core/env_scope.mjs';
import { cmdService } from './stack/delegated_script_commands.mjs';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const rootDir = dirname(scriptsDir);

test('hstack stack service passes through service subcommand flags', async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-stack-service-passthrough-'));
  t.after(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  const storageDir = join(tmp, 'stacks');
  const stackName = 'dev-built';
  const stackDir = join(storageDir, stackName);
  const commandRoot = join(tmp, 'repo');
  const outputPath = join(tmp, 'service-argv.json');
  await mkdir(stackDir, { recursive: true });
  await mkdir(join(commandRoot, 'scripts'), { recursive: true });
  await writeFile(join(stackDir, 'env'), `HAPPIER_STACK_STACK=${stackName}\n`, 'utf-8');
  await writeFile(
    join(commandRoot, 'scripts', 'service.mjs'),
    [
      "import { writeFile } from 'node:fs/promises';",
      "const outputPath = process.env.HAPPIER_TEST_OUTPUT_PATH;",
      "await writeFile(outputPath, JSON.stringify({ argv: process.argv.slice(2), envFile: process.env.HAPPIER_STACK_ENV_FILE }));",
    ].join('\n'),
    'utf-8',
  );

  withPatchedProcessEnv(t, {
    HAPPIER_STACK_STORAGE_DIR: storageDir,
    HAPPIER_TEST_OUTPUT_PATH: outputPath,
  });

  await cmdService({ rootDir: commandRoot, stackName, svcCmd: 'status', args: ['--help'] });

  const recorded = JSON.parse(await readFile(outputPath, 'utf-8'));
  assert.deepEqual(recorded.argv, ['status', '--help']);
  assert.equal(recorded.envFile, join(stackDir, 'env'));
});
