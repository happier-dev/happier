import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { ensureMinimalMonorepoLayout } from './core/minimal_monorepo_layout.mjs';
import { writeStubHappierCliFiles } from './core/stub_happier_cli_files.mjs';
import { createTempFixture } from './core/temp_fixture.mjs';

export async function createStackHappierCliCommandFixture(
  t,
  {
    prefix,
    stackName = 'exp-test',
    serverPort = 4101,
    distIndexScript,
    binHappierScript = "import '../dist/index.mjs';\n",
  } = {},
) {
  const fixture = await createTempFixture(t, { prefix });
  const tmp = fixture.root;
  const storageDir = join(tmp, 'storage');
  const homeDir = join(tmp, 'home');
  const workspaceDir = join(tmp, 'workspace');
  const monoRoot = join(workspaceDir, 'happier');
  const stackCliHome = join(storageDir, stackName, 'cli');

  await ensureMinimalMonorepoLayout(monoRoot);
  await writeStubHappierCliFiles(monoRoot, {
    distIndexScript,
    binHappierScript,
  });
  await mkdir(stackCliHome, { recursive: true });

  async function writeStackEnv({
    name = stackName,
    cliHomeDir = stackCliHome,
    port = serverPort,
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
    stackCliHome,
    envPath,
    writeStackEnv,
    baseEnv: {
      ...process.env,
      HAPPIER_STACK_HOME_DIR: homeDir,
      HAPPIER_STACK_STORAGE_DIR: storageDir,
      HAPPIER_STACK_WORKSPACE_DIR: workspaceDir,
      HAPPIER_STACK_CLI_ROOT_DISABLE: '1',
    },
  };
}
