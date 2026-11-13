import { featureRequiresServerSnapshot, getCanonicalFeatureId } from '@happier-dev/protocol/features/catalog';
import type { ProcessEnvInput } from '@/utils/processEnv/buildScopedProcessEnv';
import type { FeatureId } from '@happier-dev/protocol';
import { sessionProcessEnvironment } from '@/agent/runtime/lifecycle/hostedSessionScope';

import { getCliFeatureBuildPolicyDecision } from './featureBuildPolicy';
import { resolveCliLocalFeaturePolicyEnabled } from './featureLocalPolicy';
import { resolveCliGlobalOnlyFeatureDecision } from './featureDecisionGlobalOnly';
import {
  fetchServerFeaturesSnapshot,
  type CliServerFeaturesSnapshot,
} from './serverFeaturesClient';

export type CliFeatureDecisionInputs = Readonly<{
  featureId: FeatureId;
  env: ProcessEnvInput;
  buildPolicy: 'allow' | 'deny' | 'neutral';
  localPolicyEnabled: boolean;
  serverSnapshot?: CliServerFeaturesSnapshot;
}>;

/** Explicit callers retain their environment; ambient policy belongs to the current Session. */
export function resolveCliFeatureDecisionEnvironment(env?: ProcessEnvInput): ProcessEnvInput {
  return env ?? sessionProcessEnvironment();
}

export function createCliFeatureDecisionInputs(params: {
  featureId: FeatureId;
  env?: ProcessEnvInput;
  serverSnapshot?: CliServerFeaturesSnapshot;
}): CliFeatureDecisionInputs {
  const featureId = getCanonicalFeatureId(params.featureId);
  const env = resolveCliFeatureDecisionEnvironment(params.env);
  return {
    featureId,
    env,
    buildPolicy: getCliFeatureBuildPolicyDecision(featureId, env),
    localPolicyEnabled: resolveCliLocalFeaturePolicyEnabled(featureId, env),
    serverSnapshot: params.serverSnapshot,
  };
}

export async function loadCliFeatureDecisionInputsForServer(params: {
  featureId: FeatureId;
  env?: ProcessEnvInput;
  serverUrl: string;
  timeoutMs?: number;
  resolveAuthorizationHeaders?: (request: Readonly<{
    method: 'GET';
    path: string;
  }>) => Readonly<Record<string, string>> | null;
}): Promise<CliFeatureDecisionInputs> {
  const env = resolveCliFeatureDecisionEnvironment(params.env);
  const globalDecision = resolveCliGlobalOnlyFeatureDecision({ featureId: params.featureId, env });
  if (globalDecision.state !== 'enabled') {
    return createCliFeatureDecisionInputs({
      featureId: params.featureId,
      env,
      serverSnapshot: undefined,
    });
  }

  if (!featureRequiresServerSnapshot(params.featureId)) {
    return createCliFeatureDecisionInputs({
      featureId: params.featureId,
      env,
      serverSnapshot: undefined,
    });
  }

  const serverSnapshot = await fetchServerFeaturesSnapshot({
    serverUrl: params.serverUrl,
    timeoutMs: params.timeoutMs,
    ...(params.resolveAuthorizationHeaders
      ? { resolveAuthorizationHeaders: params.resolveAuthorizationHeaders }
      : {}),
  });

  return createCliFeatureDecisionInputs({
    featureId: params.featureId,
    env,
    serverSnapshot,
  });
}
