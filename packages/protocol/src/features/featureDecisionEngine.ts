import { createFeatureDecision, type FeatureDecision, type FeatureDecisionScope } from './decision.js';
import type { FeaturesResponse } from '../features.js';
import type { FeatureId } from './featureIds.js';
import { FEATURE_CATALOG, FEATURE_IDS } from './catalog.js';
import type { FeatureBuildPolicyEvaluation } from './buildPolicy.js';
import { readServerEnabledBit, tryWriteServerEnabledBitInPlace } from './serverEnabledBit.js';

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

type FeatureDependencyDecisionInput = Readonly<{
  featureId: FeatureId;
  baseDecision: FeatureDecision;
  resolveDependencyDecision: (dependencyId: FeatureId) => FeatureDecision;
}>;

type ServerFeatureDependencyClosureInput = Readonly<{
  serverPayload: FeaturesResponse;
}>;

export function applyFeatureDependencies(params: FeatureDependencyDecisionInput): FeatureDecision;
export function applyFeatureDependencies(params: ServerFeatureDependencyClosureInput): void;
export function applyFeatureDependencies(
  params: FeatureDependencyDecisionInput | ServerFeatureDependencyClosureInput,
): FeatureDecision | void {
  if ('serverPayload' in params) {
    applyServerFeatureDependencyClosureInPlace(params.serverPayload);
    return;
  }

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

  const disabledBlocker = blockers.find(
    ({ decision }) => decision.state === 'disabled' || decision.state === 'unsupported',
  );
  if (disabledBlocker) {
    return createFeatureDecision({
      featureId: params.featureId,
      state: 'disabled',
      blockedBy: 'dependency',
      blockerCode: 'dependency_disabled',
      diagnostics,
      evaluatedAt: params.baseDecision.evaluatedAt,
      scope: params.baseDecision.scope,
      blockingDependencyId: disabledBlocker.dependencyId,
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
    blockingDependencyId: blockers[0]!.dependencyId,
  });
}

const DEPENDENTS_BY_ID: ReadonlyMap<FeatureId, readonly FeatureId[]> = (() => {
  const dependents = new Map<FeatureId, FeatureId[]>();
  for (const featureId of FEATURE_IDS) {
    for (const dependencyId of FEATURE_CATALOG[featureId].dependencies) {
      const list = dependents.get(dependencyId) ?? [];
      list.push(featureId);
      dependents.set(dependencyId, list);
    }
  }
  return dependents;
})();

/**
 * Every feature that depends on `featureId`, directly or through another dependent, in catalog
 * order: the features a parent takes with it when it turns off. Read from the same catalog edges
 * `applyFeatureDependencies` enforces, so a client previewing a change never rebuilds the closure.
 */
export function listFeatureDependents(featureId: FeatureId): readonly FeatureId[] {
  const found = new Set<FeatureId>();
  const pending: FeatureId[] = [featureId];
  while (pending.length > 0) {
    for (const dependent of DEPENDENTS_BY_ID.get(pending.pop()!) ?? []) {
      if (dependent === featureId || found.has(dependent)) continue;
      found.add(dependent);
      pending.push(dependent);
    }
  }
  return FEATURE_IDS.filter((id) => found.has(id));
}

const SERVER_FEATURE_DEPENDENCY_SCOPE: FeatureDecisionScope = { scopeKind: 'runtime' };

export type ServerFeatureDecisionsInput = Readonly<{
  /** A server payload before dependency closure (its bits are the resolvers' own answers). */
  serverPayload: Pick<FeaturesResponse, 'features'>;
  /** Restrict output and evaluation to these ids and their dependencies; omitted evaluates all bits. */
  featureIds?: readonly FeatureId[];
  /** The server build policy; omitted when denies were already written into the payload. */
  buildPolicy?: (featureId: FeatureId) => FeatureBuildPolicyEvaluation;
}>;

/**
 * One typed decision per feature the payload carries an enabled bit for: build policy
 * first, then the payload's own bit, then dependency closure through `applyFeatureDependencies`
 * (so a blocked feature names the dependency that blocked it). The closure of `/v1/features` is
 * computed from these same decisions, so what the console explains is what clients receive.
 * The payload is not modified.
 */
export function evaluateServerFeatureDecisions(
  params: ServerFeatureDecisionsInput,
): ReadonlyMap<FeatureId, FeatureDecision> {
  const response = params.serverPayload;
  const decisions = new Map<FeatureId, FeatureDecision>();
  const evaluating = new Set<FeatureId>();

  const evaluate = (featureId: FeatureId): FeatureDecision => {
    const known = decisions.get(featureId);
    if (known) return known;
    const base = evaluateFeatureDecisionBase({
      featureId,
      scope: SERVER_FEATURE_DEPENDENCY_SCOPE,
      supportsClient: true,
      buildPolicy: params.buildPolicy?.(featureId) ?? 'neutral',
      localPolicyEnabled: true,
      serverSupported: true,
      serverEnabled: readServerEnabledBit(response, featureId) === true,
      evaluatedAt: 0,
    });
    // The catalog is acyclic; a cycle would stop at the feature's own bit rather than recurse.
    if (evaluating.has(featureId)) return base;
    evaluating.add(featureId);
    const decision = applyFeatureDependencies({
      featureId,
      baseDecision: base,
      resolveDependencyDecision: evaluate,
    });
    evaluating.delete(featureId);
    decisions.set(featureId, decision);
    return decision;
  };

  const out = new Map<FeatureId, FeatureDecision>();
  for (const featureId of params.featureIds ?? FEATURE_IDS) {
    if (readServerEnabledBit(response, featureId) === null) continue;
    out.set(featureId, evaluate(featureId));
  }
  return out;
}

function applyServerFeatureDependencyClosureInPlace(response: FeaturesResponse): void {
  const decisions = evaluateServerFeatureDecisions({ serverPayload: response });
  for (const [featureId, decision] of decisions) {
    if (decision.state === 'enabled') continue;
    tryWriteServerEnabledBitInPlace(response, featureId, false);
  }
}
