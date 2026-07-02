import type { ConnectedServiceBindingsV1, ConnectedServiceId } from '@happier-dev/protocol';

import { getConnectedServiceRuntimeAuthAdapter } from '@/backends/catalog';
import type { CatalogAgentId } from '@/backends/types';
import { resolveDaemonCatalogAgentIdFromBackendTarget } from '@/daemon/backendTargetRouting';
import type { TrackedSession } from '@/daemon/types';
import type { ConnectedServiceProviderRuntimeAuthAdapter } from '../runtimeAuth/types';

type HotApplyResult =
  | Readonly<{ ok: true }>
  | Readonly<{
      ok: false;
      errorCode:
        | 'hot_apply_unavailable'
        | 'hot_apply_failed'
        | 'hot_apply_restart_required';
      serviceId?: ConnectedServiceId;
      serviceResultsByServiceId?: Readonly<Record<string, SessionConnectedServiceAuthSwitchServiceResult>>;
    }>;

export type SessionConnectedServiceAuthSwitchServiceResult = Readonly<{
  status: 'applied' | 'failed' | 'not_attempted';
  errorCode?: string;
}>;

function resultApplied(result: Readonly<Record<string, unknown>>): boolean {
  return result.applied === true || result.status === 'applied';
}

function readHotApplyFailureErrorCode(
  result: Readonly<Record<string, unknown>>,
): Exclude<HotApplyResult, Readonly<{ ok: true }>>['errorCode'] {
  return result.recovery === 'restart_resume'
    ? 'hot_apply_restart_required'
    : 'hot_apply_failed';
}

export function createSessionConnectedServiceAuthHotApply(deps?: Readonly<{
  resolveRuntimeAuthAdapter?: (agentId: CatalogAgentId) => Promise<ConnectedServiceProviderRuntimeAuthAdapter | null>;
}>) {
  const resolveRuntimeAuthAdapter = deps?.resolveRuntimeAuthAdapter
    ?? (async (agentId: CatalogAgentId) => await getConnectedServiceRuntimeAuthAdapter(agentId));

  return async function hotApplySessionConnectedServiceAuth(input: Readonly<{
    tracked: TrackedSession;
    normalizedBindings: ConnectedServiceBindingsV1;
    serviceIds?: ReadonlySet<ConnectedServiceId>;
    runtimeAuthSelectionsByServiceId?: ReadonlyMap<ConnectedServiceId, unknown>;
  }>): Promise<HotApplyResult> {
    const agentId = resolveDaemonCatalogAgentIdFromBackendTarget(input.tracked.spawnOptions?.backendTarget);
    if (!agentId) return { ok: false, errorCode: 'hot_apply_unavailable' };
    const adapter = await resolveRuntimeAuthAdapter(agentId);
    if (!adapter) return { ok: false, errorCode: 'hot_apply_unavailable' };

    const targetBindings = Object.entries(input.normalizedBindings.bindingsByServiceId)
      .flatMap(([serviceIdRaw, binding]) => {
        if (binding.source !== 'connected') return [];
        const serviceId = serviceIdRaw as ConnectedServiceId;
        if (input.serviceIds && !input.serviceIds.has(serviceId)) return [];
        return [{ serviceId, binding }];
      });
    const serviceResultsByServiceId: Record<string, SessionConnectedServiceAuthSwitchServiceResult> = {};

    for (const [index, { serviceId, binding }] of targetBindings.entries()) {
      const materializedSelection = input.runtimeAuthSelectionsByServiceId?.get(serviceId);
      const request = {
        target: { agentId },
        selection: materializedSelection ?? {
          serviceId,
          binding,
          profileId: binding.profileId,
          ...(binding.selection === 'group'
            ? { groupId: binding.groupId, activeProfileId: binding.profileId }
            : {}),
        },
      };
      const result = await adapter.hotApply(request);
      if (!resultApplied(result)) {
        const errorCode = readHotApplyFailureErrorCode(result);
        serviceResultsByServiceId[serviceId] = { status: 'failed', errorCode };
        for (const remaining of targetBindings.slice(index + 1)) {
          serviceResultsByServiceId[remaining.serviceId] = { status: 'not_attempted' };
        }
        return {
          ok: false,
          errorCode,
          serviceId,
          serviceResultsByServiceId,
        };
      }
      serviceResultsByServiceId[serviceId] = { status: 'applied' };
    }

    return { ok: true };
  };
}
