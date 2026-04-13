import { normalizePublicReleaseRingId, type PublicReleaseRingId } from '@happier-dev/release-runtime/releaseRings';

import type { DaemonServiceMode, DaemonServiceTargetMode } from './plan';

export type DaemonServiceSelectableEntry = Readonly<{
  id: string;
  label: string;
  platform: 'darwin' | 'linux' | 'win32';
  scope: 'user' | 'system';
  mode: DaemonServiceMode;
  definitionPath: string;
  ring: PublicReleaseRingId;
  instanceId: string;
  targetMode: DaemonServiceTargetMode;
}>;

export type DaemonServiceUninstallFilters = Readonly<{
  ring: PublicReleaseRingId | null;
  instanceId: string | null;
  all: boolean;
}>;

function resolveScopeFromMode(mode: DaemonServiceMode): 'user' | 'system' {
  return mode === 'system' ? 'system' : 'user';
}

function matchesFilters(params: Readonly<{
  service: DaemonServiceSelectableEntry;
  platform: DaemonServiceSelectableEntry['platform'];
  mode: DaemonServiceMode;
  ring: PublicReleaseRingId | null;
  instanceId: string | null;
}>): boolean {
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
  services: readonly DaemonServiceSelectableEntry[];
  platform: DaemonServiceSelectableEntry['platform'];
  mode: DaemonServiceMode;
  defaultRing: PublicReleaseRingId;
  defaultInstanceId: string;
  filters: DaemonServiceUninstallFilters;
}>): readonly DaemonServiceSelectableEntry[] {
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

  throw new Error('Multiple background services matched the requested uninstall target. Re-run with --all or add more specific filters.');
}
