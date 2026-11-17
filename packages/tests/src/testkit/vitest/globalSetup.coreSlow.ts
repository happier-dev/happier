import { repoRootDir } from '../paths';
import { prepareServerSharedDepsForRun } from '../process/serverLight';
import { resolveVitestGlobalSetupPaths } from './globalSetupPaths';
import { prepareCliForGlobalSetup } from './prepareCliForGlobalSetup';

export default async function globalSetupCoreSlow(): Promise<void> {
  await prepareCliForGlobalSetup({
    rootDir: repoRootDir(),
    lane: 'core-slow',
    env: process.env,
  });
  await prepareServerSharedDepsForRun({
    testDir: resolveVitestGlobalSetupPaths({ rootDir: repoRootDir(), lane: 'core-slow', env: process.env }).setupDir,
    env: process.env,
  });
}
