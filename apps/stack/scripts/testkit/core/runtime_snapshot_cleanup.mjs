import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseEnvToObject } from '../../utils/env/dotenv.mjs';
import { stopStackWithEnv } from '../../utils/stack/stop.mjs';
import { sanitizeStackTestRunnerEnv } from '../../utils/test/test_env.mjs';
import { hasRuntimeSnapshotFixtureStarted } from './runtime_snapshot_lifetime.mjs';

const stackRoot = fileURLToPath(new URL('../../../', import.meta.url));

export async function stopRuntimeSnapshotFixture({ root, stackName }) {
  const baseDir = join(root, 'storage', stackName);
  // Reader fixtures also contain projected runtime records. Only the fixture's
  // own server/daemon producers grant it responsibility for stopping resources.
  if (!await hasRuntimeSnapshotFixtureStarted(baseDir)) return;
  const envPath = join(baseDir, 'env');
  const raw = await readFile(envPath, 'utf8').catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (raw === null) {
    const error = new Error(`Started runtime fixture ${stackName} configuration is missing; retained ${root}`);
    error.code = 'ESTACKFIXTURECLEANUPINCOMPLETE';
    throw error;
  }
  const env = {
    ...sanitizeStackTestRunnerEnv(process.env, { isolatedStackRoot: root }),
    ...parseEnvToObject(raw),
    HAPPIER_STACK_STACK: stackName,
    HAPPIER_STACK_STORAGE_DIR: join(root, 'storage'),
    HAPPIER_STACK_ENV_FILE: envPath,
    HAPPIER_STACK_CLI_HOME_DIR: join(baseDir, 'cli'),
  };
  const actions = await stopStackWithEnv({
    rootDir: stackRoot,
    stackName,
    baseDir,
    env,
    json: true,
    noDocker: true,
    stopAttribution: { requestedBy: 'runtime snapshot fixture', reason: 'native test teardown' },
  });
  if (actions.finalization?.finalized !== true || actions.errors.length > 0) {
    const steps = actions.errors.map(failure => failure.step).join(', ');
    const error = new Error(`Runtime fixture ${stackName} cleanup is incomplete (${actions.finalization?.reason ?? 'unknown'}; ${steps}); retained ${root}`);
    error.code = 'ESTACKFIXTURECLEANUPINCOMPLETE';
    throw error;
  }
}
