import { repoRootDir } from '../paths';
import { prepareServerSharedDepsForRun } from '../process/serverLight';
import { resolveVitestGlobalSetupPaths } from './globalSetupPaths';
import { prepareCliForGlobalSetup } from './prepareCliForGlobalSetup';

export default async function globalSetupCoreFast(): Promise<void> {
  await prepareCliForGlobalSetup({
    rootDir: repoRootDir(),
    lane: 'core-fast',
    env: process.env,
  });
  await prepareServerSharedDepsForRun({
    testDir: resolveVitestGlobalSetupPaths({ rootDir: repoRootDir(), lane: 'core-fast', env: process.env }).setupDir,
    env: process.env,
  });
}
