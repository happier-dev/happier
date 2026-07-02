import type {
  BackendSessionLaunchHintsV1,
  ForkSurfaceV1,
} from '@happier-dev/agents';

import {
  applyOpenCodeSessionAffinityMetadata,
  buildOpenCodeSessionEnvironmentVariables,
  readOpenCodeSessionAffinityFromMetadata,
} from '../../../identity/affinity.js';

export async function resolveOpenCodeReplayChildLaunch(params: Readonly<{
  parentMetadata: Readonly<Record<string, unknown>>;
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

export async function opencodeReplayForkContinuationHandler(params: Readonly<{
  parentMetadata: Record<string, unknown>;
}>): Promise<Readonly<{
  spawn: Readonly<{ environmentVariables?: Readonly<Record<string, string>> }>;
  metadata: Readonly<Record<string, unknown>>;
}> | null> {
  const affinity = readOpenCodeSessionAffinityFromMetadata(params.parentMetadata);
  if (!affinity.backendMode) return null;

  const environmentVariables = buildOpenCodeSessionEnvironmentVariables({
    backendMode: affinity.backendMode,
    serverBaseUrl: affinity.serverBaseUrlExplicit ? affinity.serverBaseUrl : null,
    serverBaseUrlExplicit: affinity.serverBaseUrlExplicit,
  });
  const metadata = applyOpenCodeSessionAffinityMetadata({
    backendMode: affinity.backendMode,
    serverBaseUrl: affinity.serverBaseUrlExplicit ? affinity.serverBaseUrl : null,
    serverBaseUrlExplicit: affinity.serverBaseUrlExplicit,
  });

  return {
    spawn: { environmentVariables },
    metadata,
  };
}

export const openCodeForkSurface: ForkSurfaceV1 = {
  resolveReplayChildLaunch: async ({ parentMetadata }) =>
    await resolveOpenCodeReplayChildLaunch({
      parentMetadata: parentMetadata as Record<string, unknown>,
    }),
};
