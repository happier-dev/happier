import type {
  BackendSessionLaunchHintsV1,
  ForkSessionMetadata as ForkSessionMetadataV1,
} from '@happier-dev/plugin-sdk/agents/runtime';

import {
  buildOpenCodeSessionEnvironmentVariables,
  readOpenCodeSessionAffinityFromMetadata,
} from '../../../identity/affinity.js';

export async function resolveOpenCodeReplayChildLaunch(params: Readonly<{
  parentMetadata: ForkSessionMetadataV1;
}>): Promise<BackendSessionLaunchHintsV1 | null> {
  const affinity = readOpenCodeSessionAffinityFromMetadata(params.parentMetadata);
  if (!affinity.backendMode) return null;

  return {
    environmentVariables: buildOpenCodeSessionEnvironmentVariables({
      backendMode: affinity.backendMode,
      serverBaseUrl: affinity.serverBaseUrlExplicit ? affinity.serverBaseUrl : null,
      serverBaseUrlExplicit: affinity.serverBaseUrlExplicit,
    }),
  };
}
