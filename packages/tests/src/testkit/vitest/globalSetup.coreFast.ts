import { repoRootDir } from '../paths';
import { prepareCliForGlobalSetup } from './prepareCliForGlobalSetup';

export default async function globalSetupCoreFast(): Promise<void> {
  await prepareCliForGlobalSetup({
    rootDir: repoRootDir(),
    lane: 'core-fast',
    env: process.env,
  });
}
