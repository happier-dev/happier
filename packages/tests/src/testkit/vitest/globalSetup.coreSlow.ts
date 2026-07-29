import { repoRootDir } from '../paths';
import { prepareCliForGlobalSetup } from './prepareCliForGlobalSetup';

export default async function globalSetupCoreSlow(): Promise<void> {
  await prepareCliForGlobalSetup({
    rootDir: repoRootDir(),
    lane: 'core-slow',
    env: process.env,
  });
}
