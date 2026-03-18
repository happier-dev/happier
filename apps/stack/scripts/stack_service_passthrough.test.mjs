import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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

  const previousStorage = process.env.HAPPIER_STACK_STORAGE_DIR;
  const previousOutput = process.env.HAPPIER_TEST_OUTPUT_PATH;
  process.env.HAPPIER_STACK_STORAGE_DIR = storageDir;
  process.env.HAPPIER_TEST_OUTPUT_PATH = outputPath;
  t.after(() => {
    if (previousStorage == null) delete process.env.HAPPIER_STACK_STORAGE_DIR;
    else process.env.HAPPIER_STACK_STORAGE_DIR = previousStorage;
    if (previousOutput == null) delete process.env.HAPPIER_TEST_OUTPUT_PATH;
    else process.env.HAPPIER_TEST_OUTPUT_PATH = previousOutput;
  });

  await cmdService({ rootDir: commandRoot, stackName, svcCmd: 'status', args: ['--help'] });

  const recorded = JSON.parse(await readFile(outputPath, 'utf-8'));
  assert.deepEqual(recorded.argv, ['status', '--help']);
  assert.equal(recorded.envFile, join(stackDir, 'env'));
});
