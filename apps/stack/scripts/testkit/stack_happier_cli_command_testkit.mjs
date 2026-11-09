import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { ensureMinimalMonorepoLayout } from './core/minimal_monorepo_layout.mjs';
import { prepareStubHappierCliDependencies, writeStubCliDistBuildManifest, writeStubHappierCliFiles } from './core/stub_happier_cli_files.mjs';
import { createTempFixture } from './core/temp_fixture.mjs';
import { allocateAvailableLocalhostPort } from './core/ephemeral_port.mjs';
import { readHappyCliRuntimeInputFreshness } from '../utils/proc/cli_runtime_inputs.mjs';
import { sanitizeStackTestRunnerEnv } from '../utils/test/test_env.mjs';

export async function createStackHappierCliCommandFixture(
  t,
  {
    prefix,
    stackName = 'exp-test',
    serverPort,
    distIndexScript,
    binHappierScript = "import '../dist/index.mjs';\n",
  } = {},
) {
  const resolvedServerPort = serverPort ?? await allocateAvailableLocalhostPort();
  const fixture = await createTempFixture(t, { prefix });
  const tmp = fixture.root;
  const storageDir = join(tmp, 'storage');
  const homeDir = join(tmp, 'home');
  const workspaceDir = join(tmp, 'workspace');
  const monoRoot = join(workspaceDir, 'happier');
  const stackCliHome = join(storageDir, stackName, 'cli');

  // An existing Home config prevents env.mjs from loading the checkout's
  // env.local, which can otherwise replace this fixture's selected CLI repo.
  await mkdir(homeDir, { recursive: true });
  await writeFile(join(homeDir, '.env'), '', 'utf-8');
  await ensureMinimalMonorepoLayout(monoRoot);
  const { cliDir } = await writeStubHappierCliFiles(monoRoot, {
    distIndexScript,
    binHappierScript,
    distBuildManifest: false,
  });
  const dependencyEnv = await prepareStubHappierCliDependencies(monoRoot, {
    cliDir,
    env: {
      ...sanitizeStackTestRunnerEnv(process.env),
      HAPPIER_STACK_REPO_DIR: monoRoot,
      HAPPIER_STACK_HOME_DIR: homeDir,
      HAPPIER_STACK_STORAGE_DIR: storageDir,
      HAPPIER_DEV_TARGET_EXECUTION: '1',
    },
  });
  // These command fixtures exercise lifecycle behavior with a current CLI publication.
  // A manifest without its real input fingerprint only exercises degraded-build fallback.
  const inputFreshness = await readHappyCliRuntimeInputFreshness(cliDir);
  if (!inputFreshness) throw new Error('could not fingerprint stub CLI inputs');
  writeStubCliDistBuildManifest(cliDir, { inputFingerprint: inputFreshness.fingerprint });
  await mkdir(stackCliHome, { recursive: true });

  async function writeStackEnv({
    name = stackName,
    cliHomeDir = stackCliHome,
    port = resolvedServerPort,
    repoDir = monoRoot,
  } = {}) {
    const envPath = join(storageDir, name, 'env');
    await mkdir(join(storageDir, name), { recursive: true });
    await writeFile(
      envPath,
      [
        `HAPPIER_STACK_REPO_DIR=${repoDir}`,
        `HAPPIER_STACK_CLI_HOME_DIR=${cliHomeDir}`,
        ...(port === '' ? [] : [`HAPPIER_STACK_SERVER_PORT=${port}`]),
        '',
      ].join('\n'),
      'utf-8',
    );
    return envPath;
  }

  const envPath = await writeStackEnv();

  return {
    ...fixture,
    tmp,
    storageDir,
    homeDir,
    workspaceDir,
    monoRoot,
    stackName,
    serverPort: resolvedServerPort,
    stackCliHome,
    envPath,
    writeStackEnv,
    baseEnv: {
      ...sanitizeStackTestRunnerEnv(process.env),
      ...dependencyEnv,
      HAPPIER_STACK_HOME_DIR: homeDir,
      HAPPIER_STACK_STORAGE_DIR: storageDir,
      HAPPIER_STACK_WORKSPACE_DIR: workspaceDir,
      HAPPIER_STACK_REPO_DIR: monoRoot,
      HAPPIER_STACK_CLI_ROOT_DISABLE: '1',
      // This fixture substitutes the CLI process; dependency publication is
      // covered by its own owner tests, not by command passthrough tests.
      HAPPIER_STACK_SYNC_BUNDLED_WORKSPACES: '0',
      HAPPIER_STACK_DAEMON_START_VERIFY_TIMEOUT_MS: '5000',
      HAPPIER_STACK_DAEMON_START_VERIFY_POLL_MS: '25',
      HAPPIER_STACK_DAEMON_START_VERIFY_STABLE_MS: '0',
    },
  };
}
