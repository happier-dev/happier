import { createFeatureDecision, type FeatureDecision, type FeatureDecisionScope } from './decision.js';
import type { FeatureId } from './featureIds.js';
import { FEATURE_CATALOG, FEATURE_IDS } from './catalog.js';
import type { FeatureBuildPolicyEvaluation } from './buildPolicy.js';

export type FeatureDecisionBaseInput = Readonly<{
  featureId: FeatureId;
  scope: FeatureDecisionScope;
  supportsClient: boolean;
  buildPolicy: FeatureBuildPolicyEvaluation;
  localPolicyEnabled: boolean;
  serverSupported: boolean;
  serverEnabled: boolean;
  diagnostics?: readonly string[];
  evaluatedAt?: number;
}>;

export function evaluateFeatureDecisionBase(input: FeatureDecisionBaseInput): FeatureDecision {
  const base = {
    featureId: input.featureId,
    diagnostics: [...(input.diagnostics ?? [])],
    evaluatedAt: input.evaluatedAt ?? Date.now(),
    scope: input.scope,
  };

  if (!input.supportsClient) {
    return createFeatureDecision({
      ...base,
      state: 'disabled',
      blockedBy: 'client',
      blockerCode: 'not_implemented',
    });
  }

  if (input.buildPolicy === 'deny') {
    return createFeatureDecision({
      ...base,
      state: 'disabled',
      blockedBy: 'build_policy',
      blockerCode: 'build_disabled',
    });
  }

  if (!input.localPolicyEnabled) {
    return createFeatureDecision({
      ...base,
      state: 'disabled',
      blockedBy: 'local_policy',
      blockerCode: 'flag_disabled',
    });
  }

  if (!input.serverSupported) {
    return createFeatureDecision({
      ...base,
      state: 'unsupported',
      blockedBy: 'server',
      blockerCode: 'endpoint_missing',
    });
  }

  if (!input.serverEnabled) {
    return createFeatureDecision({
      ...base,
      state: 'disabled',
      blockedBy: 'server',
      blockerCode: 'feature_disabled',
    });
  }

  return createFeatureDecision({
    ...base,
    state: 'enabled',
    blockedBy: null,
    blockerCode: 'none',
  });
}

const DEPENDENCIES_BY_ID: ReadonlyMap<FeatureId, readonly FeatureId[]> = new Map(
  FEATURE_IDS.map((featureId) => [featureId, FEATURE_CATALOG[featureId].dependencies] as const),
);

export function applyFeatureDependencies(params: Readonly<{
  featureId: FeatureId;
  baseDecision: FeatureDecision;
  resolveDependencyDecision: (dependencyId: FeatureId) => FeatureDecision;
}>): FeatureDecision {
  const dependencies = DEPENDENCIES_BY_ID.get(params.featureId) ?? [];
  if (dependencies.length === 0) return params.baseDecision;

  if (params.baseDecision.state !== 'enabled') return params.baseDecision;

  const baseDiagnostics = params.baseDecision.diagnostics ?? [];

  const blockers: Array<Readonly<{ dependencyId: FeatureId; decision: FeatureDecision }>> = [];
  for (const dep of dependencies) {
    const depDecision = params.resolveDependencyDecision(dep);
    if (depDecision.state === 'enabled') continue;
    blockers.push({ dependencyId: dep, decision: depDecision });
  }

  if (blockers.length === 0) return params.baseDecision;

  const diagnostics = [
    ...baseDiagnostics,
    ...blockers.flatMap(({ dependencyId, decision }) => [
      `dependency:${dependencyId}:${decision.state}`,
      ...(decision.blockedBy ? [`dependency_blockedBy:${dependencyId}:${decision.blockedBy}`] : []),
    ]),
  ];

  const hasDisabled = blockers.some(
    ({ decision }) => decision.state === 'disabled' || decision.state === 'unsupported',
  );
  if (hasDisabled) {
    return createFeatureDecision({
      featureId: params.featureId,
      state: 'disabled',
      blockedBy: 'dependency',
      blockerCode: 'dependency_disabled',
      diagnostics,
      evaluatedAt: params.baseDecision.evaluatedAt,
      scope: params.baseDecision.scope,
    });
  }

  return createFeatureDecision({
    featureId: params.featureId,
    state: 'unknown',
    blockedBy: 'dependency',
    blockerCode: 'dependency_unknown',
    diagnostics,
    evaluatedAt: params.baseDecision.evaluatedAt,
    scope: params.baseDecision.scope,
  });
}
