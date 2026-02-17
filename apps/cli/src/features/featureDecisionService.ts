import {
  applyFeatureDependencies,
  createFeatureDecision,
  evaluateFeatureDecisionBase,
  isFeatureServerRepresented,
  readServerEnabledBit,
  type FeatureDecision,
  type FeatureId,
} from '@happier-dev/protocol';

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
  const memo = new Map<FeatureId, FeatureDecision>();

  const resolve = (featureId: FeatureId): FeatureDecision => {
    const cached = memo.get(featureId);
    if (cached) return cached;

    const serverRepresented = isFeatureServerRepresented(featureId);

    const featureInputs = createCliFeatureDecisionInputs({
      featureId,
      env: inputs.env,
      serverSnapshot: inputs.serverSnapshot,
    });

    // Global policy gates apply before any server probing.
    const globalDecision = evaluateFeatureDecisionBase({
      featureId,
      scope: { scopeKind: 'runtime' },
      supportsClient: true,
      buildPolicy: featureInputs.buildPolicy,
      localPolicyEnabled: featureInputs.localPolicyEnabled,
      serverSupported: true,
      serverEnabled: true,
    });

    if (globalDecision.blockedBy && globalDecision.blockedBy !== 'server') {
      memo.set(featureId, globalDecision);
      return globalDecision;
    }

    if (!serverRepresented) {
      const out = applyFeatureDependencies({
        featureId,
        baseDecision: globalDecision,
        resolveDependencyDecision: resolve,
      });

      memo.set(featureId, out);
      return out;
    }

    if (!inputs.serverSnapshot) {
      const out = createFeatureDecision({
        featureId,
        state: 'unknown',
        blockedBy: 'server',
        blockerCode: 'probe_failed',
        diagnostics: ['server_probe:missing'],
        evaluatedAt: Date.now(),
        scope: { scopeKind: 'runtime' },
      });
      memo.set(featureId, out);
      return out;
    }

    if (inputs.serverSnapshot.status === 'unsupported') {
      const out = createFeatureDecision({
        featureId,
        state: 'unsupported',
        blockedBy: 'server',
        blockerCode: inputs.serverSnapshot.reason === 'endpoint_missing' ? 'endpoint_missing' : 'misconfigured',
        diagnostics: [`server_unsupported:${inputs.serverSnapshot.reason}`],
        evaluatedAt: Date.now(),
        scope: { scopeKind: 'runtime' },
      });
      memo.set(featureId, out);
      return out;
    }

    if (inputs.serverSnapshot.status === 'error') {
      const out = createFeatureDecision({
        featureId,
        state: 'unknown',
        blockedBy: 'server',
        blockerCode: 'probe_failed',
        diagnostics: [`server_error:${inputs.serverSnapshot.reason}`],
        evaluatedAt: Date.now(),
        scope: { scopeKind: 'runtime' },
      });
      memo.set(featureId, out);
      return out;
    }

    const serverEnabled = readServerEnabledBit(inputs.serverSnapshot.features, featureId) === true;
    const baseDecision = evaluateFeatureDecisionBase({
      featureId,
      scope: { scopeKind: 'runtime' },
      supportsClient: true,
      buildPolicy: featureInputs.buildPolicy,
      localPolicyEnabled: featureInputs.localPolicyEnabled,
      serverSupported: true,
      serverEnabled,
    });

    const out = applyFeatureDependencies({
      featureId,
      baseDecision,
      resolveDependencyDecision: resolve,
    });

    memo.set(featureId, out);
    return out;
  };

  return resolve(inputs.featureId);
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
}): Promise<Readonly<{ decision: FeatureDecision; serverSnapshot?: CliServerFeaturesSnapshot }>> {
  const inputs = await loadCliFeatureDecisionInputsForServer({
    featureId: params.featureId,
    env: params.env,
    serverUrl: params.serverUrl,
    timeoutMs: params.timeoutMs,
  });

  const decision = resolveCliFeatureDecisionFromInputs(inputs);

  return {
    decision,
    serverSnapshot: inputs.serverSnapshot,
  };
}
