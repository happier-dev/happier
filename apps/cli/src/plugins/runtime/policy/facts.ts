import type {
  PluginFinalPolicyInput,
  PluginFinalPolicyTargetGenerationMode,
  PluginHostAccessRequestV2,
} from '@happier-dev/protocol';
import type { PluginAccessSelection } from '@/plugins/store/install/accessScopeRegistry';

export type PluginFinalPolicyCurrentGeneration = Readonly<{
  /** The exact generation whose declaration describes this operation. */
  immutableGenerationId: string;
  /** The durable desired generation; it can move without retiring a retained target. */
  desiredImmutableGenerationId: string | null;
  /** The generation actually applied to this operation's active runtime. */
  appliedImmutableGenerationId: string | null;
  distribution: unknown;
  /** Compatibility projection for current catalog consumers. */
  applied: boolean;
  selectedAccess: readonly SelectedPluginAccess[];
}>;

export type SelectedPluginAccess = PluginAccessSelection;

export type PluginFinalPolicyAuthorizationFacts = Pick<
  PluginFinalPolicyInput,
  | 'packageTrust'
  | 'generation'
  | 'resourceSelections'
  | 'scopedGrants'
  | 'operatingSystemAuthorization'
>;

function fixedNetworkOrigins(scope: unknown): readonly string[] {
  if (!scope || typeof scope !== 'object' || Array.isArray(scope)) return Object.freeze([]);
  const targets = (scope as Readonly<Record<string, unknown>>).targets;
  if (!Array.isArray(targets)) return Object.freeze([]);
  return Object.freeze(targets.flatMap((target) => {
    if (!target || typeof target !== 'object' || Array.isArray(target)) return [];
    const record = target as Readonly<Record<string, unknown>>;
    return record.kind === 'fixedOrigin' && typeof record.origin === 'string'
      ? [record.origin]
      : [];
  }));
}

/** Network disclosure is required manifest configuration, never an optional host-resource grant. */
export function resolveRequiredPluginNetworkOrigins(params: Readonly<{
  required: readonly PluginHostAccessRequestV2[];
}>): readonly string[] {
  const requiredOrigins = params.required.flatMap((request) => (
    request.capability === 'network' ? fixedNetworkOrigins(request.scope) : []
  ));
  return Object.freeze([...new Set(requiredOrigins)].sort());
}

function pluginGenerationIdentity(params: Readonly<{
  pluginId: string;
  immutableGenerationId: string;
  distribution: unknown;
}>): string {
  return JSON.stringify({
    pluginId: params.pluginId,
    immutableGenerationId: params.immutableGenerationId,
    distribution: params.distribution,
  });
}

/**
 * Materializes direct generation/currentness and independently owned authorization facts
 * once for every final-policy consumer. It deliberately does not decide action
 * surfaces/danger or Voice pack/license/resource semantics.
 */
export function resolvePluginFinalPolicyAuthorizationFacts(params: Readonly<{
  pluginId: string;
  current: PluginFinalPolicyCurrentGeneration | null;
  targetGenerationMode?: PluginFinalPolicyTargetGenerationMode;
  resourceSelections?: PluginFinalPolicyAuthorizationFacts['resourceSelections'];
  scopedGrants?: PluginFinalPolicyAuthorizationFacts['scopedGrants'];
  operatingSystemAuthorization?: PluginFinalPolicyAuthorizationFacts['operatingSystemAuthorization'];
}>): PluginFinalPolicyAuthorizationFacts {
  const targetGeneration = params.current?.immutableGenerationId
    ?? `uncommitted:${params.pluginId}`;
  const desiredGeneration = params.current?.desiredImmutableGenerationId ?? null;
  const appliedGeneration = params.current?.appliedImmutableGenerationId ?? null;
  const packageIdentity = params.current
    ? pluginGenerationIdentity({
        pluginId: params.pluginId,
        immutableGenerationId: params.current.immutableGenerationId,
        distribution: params.current.distribution,
      })
    : `uncommitted:${params.pluginId}`;
  const reviewedPackageIdentity = params.current
    ? pluginGenerationIdentity({
        pluginId: params.pluginId,
        immutableGenerationId: params.current.immutableGenerationId,
        distribution: params.current.distribution,
      })
    : null;

  return Object.freeze({
    packageTrust: Object.freeze({ packageIdentity, reviewedPackageIdentity }),
    generation: Object.freeze({
      targetGeneration,
      desiredGeneration,
      appliedGeneration,
      targetGenerationMode: params.targetGenerationMode ?? 'current',
    }),
    resourceSelections: Object.freeze([...(params.resourceSelections ?? [])]),
    scopedGrants: Object.freeze([...(params.scopedGrants ?? [])]),
    operatingSystemAuthorization: Object.freeze([...(params.operatingSystemAuthorization ?? [])]),
  });
}
