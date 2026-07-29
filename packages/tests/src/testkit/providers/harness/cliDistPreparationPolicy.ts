import { shouldUseCliSourceEntrypoint } from '../../process/cliLaunchSpec';

export function shouldPrepareProviderCliDist(env: NodeJS.ProcessEnv): boolean {
  return !shouldUseCliSourceEntrypoint(env);
}
