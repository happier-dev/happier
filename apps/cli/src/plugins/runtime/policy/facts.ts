import type { PluginFinalPolicyInput, PluginHostAccessRequestV2 } from '@happier-dev/protocol';
import type { PluginAccessSelection } from '@/plugins/store/install/accessScopeRegistry';

export type PluginFinalPolicyCurrentGeneration = Readonly<{
  immutableGenerationId: string;
  packageDigest: string;
  manifestDigest: string;
  distribution: unknown;
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

function pluginPackageIdentity(params: Readonly<{
  pluginId: string;
  immutableGenerationId: string;
  packageDigest: string;
  manifestDigest: string;
  distribution: unknown;
}>): string {
  return JSON.stringify({
    pluginId: params.pluginId,
    immutableGenerationId: params.immutableGenerationId,
    packageDigest: params.packageDigest,
    manifestDigest: params.manifestDigest,
    distribution: params.distribution,
  });
}

/**
 * Materializes package/currentness and independently owned authorization facts
 * once for every final-policy consumer. It deliberately does not decide action
 * surfaces/danger or Voice pack/license/resource semantics.
 */
export function resolvePluginFinalPolicyAuthorizationFacts(params: Readonly<{
  pluginId: string;
  targetManifestDigest: string;
  current: PluginFinalPolicyCurrentGeneration | null;
  resourceSelections?: PluginFinalPolicyAuthorizationFacts['resourceSelections'];
  scopedGrants?: PluginFinalPolicyAuthorizationFacts['scopedGrants'];
  operatingSystemAuthorization?: PluginFinalPolicyAuthorizationFacts['operatingSystemAuthorization'];
}>): PluginFinalPolicyAuthorizationFacts {
  const targetGeneration = params.current?.immutableGenerationId
    ?? `uncommitted:${params.pluginId}`;
  const packageIdentity = params.current
    ? pluginPackageIdentity({
        pluginId: params.pluginId,
        immutableGenerationId: params.current.immutableGenerationId,
        packageDigest: params.current.packageDigest,
        manifestDigest: params.targetManifestDigest,
        distribution: params.current.distribution,
      })
    : `uncommitted:${params.pluginId}:${params.targetManifestDigest}`;
  const reviewedPackageIdentity = params.current
    ? pluginPackageIdentity({
        pluginId: params.pluginId,
        immutableGenerationId: params.current.immutableGenerationId,
        packageDigest: params.current.packageDigest,
        manifestDigest: params.current.manifestDigest,
        distribution: params.current.distribution,
      })
    : null;

  return Object.freeze({
    packageTrust: Object.freeze({ packageIdentity, reviewedPackageIdentity }),
    generation: Object.freeze({
      targetGeneration,
      desiredGeneration: params.current?.immutableGenerationId ?? null,
      appliedGeneration: params.current?.applied === true
        ? params.current.immutableGenerationId
        : null,
    }),
    resourceSelections: Object.freeze([...(params.resourceSelections ?? [])]),
    scopedGrants: Object.freeze([...(params.scopedGrants ?? [])]),
    operatingSystemAuthorization: Object.freeze([...(params.operatingSystemAuthorization ?? [])]),
  });
}
