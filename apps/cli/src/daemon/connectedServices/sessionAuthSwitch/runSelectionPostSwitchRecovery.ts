import type {
  ConnectedServiceBindingsV1,
  ConnectedAccountServiceKey,
} from '@happier-dev/protocol';

import type { TrackedSession } from '@/daemon/types';

type RuntimeAuthSelectionsByServiceId = ReadonlyMap<ConnectedAccountServiceKey, unknown>;

type ProviderPostSwitchRecoverContext = Readonly<{
  tracked: TrackedSession;
  sessionId: string;
  normalizedBindings: ConnectedServiceBindingsV1;
  serviceId: ConnectedAccountServiceKey;
  action: 'hot_applied' | 'restart_requested';
  countTrackedClaimsForStatePath?: (statePath: string) => number;
  hasUnknownTrackedClaims?: boolean;
  hasInFlightTurnForStatePath?: (statePath: string) => boolean;
}>;

type ProviderPostSwitchRecover = (input: ProviderPostSwitchRecoverContext) => Promise<void> | void;

type RunSelectionPostSwitchRecoveryInput = Readonly<{
  tracked: TrackedSession;
  sessionId: string;
  normalizedBindings: ConnectedServiceBindingsV1;
  serviceIds: ReadonlySet<ConnectedAccountServiceKey>;
  action: 'hot_applied' | 'restart_requested';
  runtimeAuthSelectionsByServiceId?: RuntimeAuthSelectionsByServiceId;
  countTrackedClaimsForStatePath?: (statePath: string) => number;
  hasUnknownTrackedClaims?: boolean;
  hasInFlightTurnForStatePath?: (statePath: string) => boolean;
}>;

type RunSelectionPostSwitchRecoveryResult =
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false; errorCode: 'post_switch_recovery_failed' }>;

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readProviderPostSwitchRecover(value: unknown): ProviderPostSwitchRecover | null {
  return typeof value === 'function' ? value as ProviderPostSwitchRecover : null;
}

function listConnectedTargetServiceIds(input: Readonly<{
  normalizedBindings: ConnectedServiceBindingsV1;
  serviceIds: ReadonlySet<ConnectedAccountServiceKey>;
}>): ConnectedAccountServiceKey[] {
  return Object.entries(input.normalizedBindings.bindingsByServiceId)
    .flatMap(([serviceIdRaw, binding]) => {
      const serviceId = serviceIdRaw;
      if (binding.source !== 'connected') return [];
      if (!input.serviceIds.has(serviceId)) return [];
      return [serviceId];
    });
}

export async function runSelectionPostSwitchRecovery(
  input: RunSelectionPostSwitchRecoveryInput,
): Promise<RunSelectionPostSwitchRecoveryResult> {
  const targetServiceIds = listConnectedTargetServiceIds({
    normalizedBindings: input.normalizedBindings,
    serviceIds: input.serviceIds,
  });

  for (const serviceId of targetServiceIds) {
    const selection = readRecord(input.runtimeAuthSelectionsByServiceId?.get(serviceId));
    const postSwitchRecover = readProviderPostSwitchRecover(selection?.postSwitchRecover);
    if (!postSwitchRecover) continue;
    try {
      await postSwitchRecover({
        tracked: input.tracked,
        sessionId: input.sessionId,
        normalizedBindings: input.normalizedBindings,
        serviceId,
        action: input.action,
        ...(input.countTrackedClaimsForStatePath
          ? { countTrackedClaimsForStatePath: input.countTrackedClaimsForStatePath }
          : {}),
        ...(typeof input.hasUnknownTrackedClaims === 'boolean'
          ? { hasUnknownTrackedClaims: input.hasUnknownTrackedClaims }
          : {}),
        ...(input.hasInFlightTurnForStatePath
          ? { hasInFlightTurnForStatePath: input.hasInFlightTurnForStatePath }
          : {}),
      });
    } catch {
      return { ok: false, errorCode: 'post_switch_recovery_failed' };
    }
  }

  return { ok: true };
}
