import {
  createFeatureDecision,
  type FeatureDecision,
  type FeatureId,
} from '@happier-dev/protocol';

import { evaluateCliFeatureDecision } from './featureDecisionEngine';
import { getCliFeatureDefinition } from './featureRegistry';
import {
  createCliFeatureDecisionInputs,
  loadCliFeatureDecisionInputsForServer,
  type CliFeatureDecisionInputs,
} from './featureDecisionInputs';
import {
  type CliServerFeaturesSnapshot,
} from './serverFeaturesClient';

export type { CliServerFeaturesSnapshot } from './serverFeaturesClient';

function resolveCliFeatureDecisionFromInputs(
  inputs: CliFeatureDecisionInputs,
): FeatureDecision {
  const definition = getCliFeatureDefinition(inputs.featureId);

  if (definition.serverRequired && !inputs.serverSnapshot) {
    return createFeatureDecision({
      featureId: inputs.featureId,
      state: 'unknown',
      blockedBy: 'server',
      blockerCode: 'probe_failed',
      diagnostics: ['server_probe:missing'],
      evaluatedAt: Date.now(),
      scope: { scopeKind: 'runtime' },
    });
  }

  if (definition.serverRequired && inputs.serverSnapshot?.status === 'unsupported') {
    return createFeatureDecision({
      featureId: inputs.featureId,
      state: 'unsupported',
      blockedBy: 'server',
      blockerCode: inputs.serverSnapshot.reason === 'endpoint_missing' ? 'endpoint_missing' : 'misconfigured',
      diagnostics: [`server_unsupported:${inputs.serverSnapshot.reason}`],
      evaluatedAt: Date.now(),
      scope: { scopeKind: 'runtime' },
    });
  }

  if (definition.serverRequired && inputs.serverSnapshot?.status === 'error') {
    return createFeatureDecision({
      featureId: inputs.featureId,
      state: 'unknown',
      blockedBy: 'server',
      blockerCode: 'probe_failed',
      diagnostics: [`server_error:${inputs.serverSnapshot.reason}`],
      evaluatedAt: Date.now(),
      scope: { scopeKind: 'runtime' },
    });
  }

  const serverSupported =
    !definition.serverRequired || inputs.serverSnapshot?.status === 'ready';
  const serverEnabled = !definition.serverRequired
    ? true
    : inputs.serverSnapshot?.status === 'ready'
      ? definition.serverEnabled(inputs.serverSnapshot.features)
      : false;

  return evaluateCliFeatureDecision({
    featureId: inputs.featureId,
    supportsClient: true,
    buildPolicy: inputs.buildPolicy,
    localPolicyEnabled: inputs.localPolicyEnabled,
    serverSupported,
    serverEnabled,
  });
}

export function resolveCliFeatureDecision(params: {
  featureId: FeatureId;
  env: NodeJS.ProcessEnv;
  serverSnapshot?: CliServerFeaturesSnapshot;
}): FeatureDecision {
  const inputs = createCliFeatureDecisionInputs({
    featureId: params.featureId,
    env: params.env,
    serverSnapshot: params.serverSnapshot,
  });
  return resolveCliFeatureDecisionFromInputs(inputs);
}

export async function resolveCliFeatureDecisionForServer(params: {
  featureId: FeatureId;
  env: NodeJS.ProcessEnv;
  serverUrl: string;
  timeoutMs?: number;
}): Promise<Readonly<{ decision: FeatureDecision; serverSnapshot: CliServerFeaturesSnapshot }>> {
  const inputs = await loadCliFeatureDecisionInputsForServer({
    featureId: params.featureId,
    env: params.env,
    serverUrl: params.serverUrl,
    timeoutMs: params.timeoutMs,
  });
  if (!inputs.serverSnapshot) {
    throw new Error('Server snapshot is required when resolving feature decision for a server');
  }

  const decision = resolveCliFeatureDecisionFromInputs(inputs);

  return {
    decision,
    serverSnapshot: inputs.serverSnapshot,
  };
}
