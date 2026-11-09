import type { AcpBackendLaunchV1 } from '../settingsV1.js';
import { z } from 'zod/mini';
import { PinnedArchivePlatformSchema, type PinnedArchiveInstallableAsset } from '../../../installables/sourceKind.js';
import { lazyZodSchema } from '../../../lazyZodSchema.js';
import type { AcpRegistryAgentV1, RegistryAgentDistributionV1 } from '../../../registries/registryItemsV1.js';
import { isAcpRegistryArchiveUrlV1, mapAcpRegistryBinaryAssetsV1, selectAcpRegistryDistributionV1 } from './mapAcpRegistryAgentV1.js';
import { resolveAcpPlatformTargetV1 } from './acpPlatformTargetsV1.js';
type PinnedArchiveAssetsByPlatform = Extract<AcpBackendLaunchV1, { kind: 'archive' }>['assetsByPlatform'];

export type AcpPlatformFitV1 =
  | Readonly<{ kind: 'can_run'; via: AcpBackendLaunchV1['kind']; target?: keyof PinnedArchiveAssetsByPlatform }>
  | Readonly<{ kind: 'cant_run'; reason: 'no_build_for_platform' | 'archive_type_unsupported' }>
  | Readonly<{ kind: 'unknown'; reason: 'platform_unknown' | 'arch_unknown' }>;

export const AcpPlatformFitV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('can_run'), via: z.enum(['command', 'npm', 'archive', 'uv']), target: z.optional(PinnedArchivePlatformSchema) }),
  z.strictObject({ kind: z.literal('cant_run'), reason: z.enum(['no_build_for_platform', 'archive_type_unsupported']) }),
  z.strictObject({ kind: z.literal('unknown'), reason: z.enum(['platform_unknown', 'arch_unknown']) }),
]));

function archiveSupported(asset: PinnedArchiveInstallableAsset): boolean {
  return asset.kind === 'executable' || isAcpRegistryArchiveUrlV1(asset.archiveUrl);
}

/** List projection reuses admission's distribution selection and archive interpretation. */
export function summarizeAcpRegistryDistributionV1(distributions: AcpRegistryAgentV1['distributions']): RegistryAgentDistributionV1 | undefined {
  const selected = selectAcpRegistryDistributionV1(distributions);
  if (!selected) return undefined;
  if (selected.kind !== 'archive') return { kind: selected.kind };
  const mapped = mapAcpRegistryBinaryAssetsV1(selected.distribution);
  if (!mapped.success) return undefined;
  return { kind: 'archive', platforms: Object.fromEntries(Object.entries(mapped.data).flatMap(([target, asset]) =>
    asset ? [[target, archiveSupported(asset) ? 'supported' : 'archive_type_unsupported']] : [])) };
}

export function resolveAcpPlatformFitV1(input: AcpBackendLaunchV1 | AcpRegistryAgentV1['distributions'] | RegistryAgentDistributionV1,
  machine: Readonly<{ platform: string | null; arch: string | null }>,
): AcpPlatformFitV1 {
  if (!machine.platform) return { kind: 'unknown', reason: 'platform_unknown' };
  if (!machine.arch) return { kind: 'unknown', reason: 'arch_unknown' };
  const distribution = 'kind' in input ? null : selectAcpRegistryDistributionV1(input);
  if (!('kind' in input) && !distribution) return { kind: 'cant_run', reason: 'no_build_for_platform' };
  const kind = 'kind' in input ? input.kind : distribution!.kind;
  const target = resolveAcpPlatformTargetV1(machine.platform, machine.arch);
  if (!target) return { kind: 'cant_run', reason: 'no_build_for_platform' };
  if (kind !== 'archive') return { kind: 'can_run', via: kind };
  if ('kind' in input && input.kind === 'archive' && 'platforms' in input) {
    const support = input.platforms[target];
    if (!support) return { kind: 'cant_run', reason: 'no_build_for_platform' };
    return support === 'supported' ? { kind: 'can_run', via: 'archive', target }
      : { kind: 'cant_run', reason: 'archive_type_unsupported' };
  }
  const mapped = distribution?.kind === 'archive' ? mapAcpRegistryBinaryAssetsV1(distribution.distribution) : null;
  const assets = 'kind' in input && input.kind === 'archive' && 'assetsByPlatform' in input ? input.assetsByPlatform : mapped?.success ? mapped.data : {};
  const asset = assets[target];
  if (!asset) return { kind: 'cant_run', reason: 'no_build_for_platform' };
  if (!archiveSupported(asset)) {
    return { kind: 'cant_run', reason: 'archive_type_unsupported' };
  }
  return { kind: 'can_run', via: 'archive', target };
}
