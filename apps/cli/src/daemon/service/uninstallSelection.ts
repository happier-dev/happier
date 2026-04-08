import type { HappierService, HappierServicePlatform } from '@happier-dev/cli-common/happierRuntime';
import { normalizePublicReleaseRingId, type PublicReleaseRingId } from '@happier-dev/release-runtime/releaseRings';

import type { DaemonServiceMode } from './plan';

export type DaemonServiceUninstallFilters = Readonly<{
  ring: PublicReleaseRingId | null;
  instanceId: string | null;
  all: boolean;
}>;

function resolveScopeFromMode(mode: DaemonServiceMode): 'user' | 'system' {
  return mode === 'system' ? 'system' : 'user';
}

function isVerifiedDaemon(service: HappierService): boolean {
  return service.serviceType === 'daemon' && service.verification === 'verified';
}

function matchesFilters(params: Readonly<{
  service: HappierService;
  platform: HappierServicePlatform;
  mode: DaemonServiceMode;
  ring: PublicReleaseRingId | null;
  instanceId: string | null;
}>): boolean {
  if (!isVerifiedDaemon(params.service)) return false;
  if (params.service.platform !== params.platform) return false;
  if (params.service.scope !== resolveScopeFromMode(params.mode)) return false;
  if (params.ring && params.service.ring !== params.ring) return false;
  if (params.instanceId && params.service.instanceId !== params.instanceId) return false;
  return true;
}

export function parseDaemonServiceUninstallFlagValue(value: string | null | undefined): PublicReleaseRingId | null {
  return normalizePublicReleaseRingId(String(value ?? '').trim()) || null;
}

export function resolveDaemonServiceUninstallSelection(params: Readonly<{
  services: readonly HappierService[];
  platform: HappierServicePlatform;
  mode: DaemonServiceMode;
  defaultRing: PublicReleaseRingId;
  defaultInstanceId: string;
  filters: DaemonServiceUninstallFilters;
}>): readonly HappierService[] {
  const effectiveRing = params.filters.all
    ? params.filters.ring
    : params.filters.ring ?? (params.filters.instanceId ? null : params.defaultRing);
  const effectiveInstanceId = params.filters.all
    ? params.filters.instanceId
    : params.filters.instanceId ?? (params.filters.ring ? null : params.defaultInstanceId);
  const matches = params.services.filter((service) => matchesFilters({
    service,
    platform: params.platform,
    mode: params.mode,
    ring: effectiveRing,
    instanceId: effectiveInstanceId,
  }));

  if (matches.length <= 1 || params.filters.all) {
    return matches;
  }

  throw new Error('Multiple verified background services matched the requested uninstall target. Re-run with --all or add more specific filters.');
}
