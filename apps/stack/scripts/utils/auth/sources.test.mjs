import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { detectSeedableAuthSources } from './sources.mjs';

async function withTempRoot(t) {
  const dir = await mkdtemp(join(tmpdir(), 'happy-stacks-auth-sources-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}

async function writeSeedableStack({ stacksRoot, stackName, cliHomeDir }) {
  const stackDir = join(stacksRoot, stackName);
  await mkdir(stackDir, { recursive: true });
  await writeFile(join(stackDir, 'env'), `HAPPIER_STACK_CLI_HOME_DIR=${cliHomeDir}\n`, 'utf-8');
  await mkdir(cliHomeDir, { recursive: true });
  await writeFile(join(cliHomeDir, 'access.key'), `${stackName}-token\n`, 'utf-8');
}

test('detectSeedableAuthSources includes discovered local donor stacks before main', async (t) => {
  const root = await withTempRoot(t);
  const stacksRoot = join(root, 'stacks');
  const env = {
    HAPPIER_STACK_STORAGE_DIR: stacksRoot,
  };

  await writeSeedableStack({ stacksRoot, stackName: 'dev-auth', cliHomeDir: join(root, 'dev-auth-cli') });
  await writeSeedableStack({
    stacksRoot,
    stackName: 'overlay-v2-20260418',
    cliHomeDir: join(root, 'overlay-v2-20260418-cli'),
  });
  await writeSeedableStack({ stacksRoot, stackName: 'main', cliHomeDir: join(root, 'main-cli') });
  await mkdir(join(stacksRoot, 'voice-refactor-qa'), { recursive: true });
  await writeFile(
    join(stacksRoot, 'voice-refactor-qa', 'env'),
    'HAPPIER_STACK_CLI_HOME_DIR=/tmp/voice-refactor-qa-cli\n',
    'utf-8',
  );

  assert.deepEqual(
    detectSeedableAuthSources({
      env,
      excludeStackNames: ['voice-refactor-qa'],
    }),
    ['dev-auth', 'overlay-v2-20260418', 'main'],
  );
});
