import { PluginUiReadMachineDisplayNameRequestV1Schema } from '@happier-dev/protocol/plugins/ui';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { areServerAccountScopesEqual } from '@/sync/domains/scope/serverAccountScope';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { storage } from '@/sync/domains/state/storageStore';
import { getMachineDisplayName } from '@/utils/sessions/machineDisplayNames';
import { createPluginSurfaceHostApiError, type PluginSurfaceHostApiMethodHandler } from './createPluginSurfaceHostApi';

/** The viewer's existing active-Account display projection is the sole read authority. */
export function createPluginSurfaceMachineDisplayNameHandler(input: Readonly<{
    accountLifetime: ActiveServerAccountScopeLifetime;
    isCurrent: () => boolean;
}>): PluginSurfaceHostApiMethodHandler {
    return (request, options) => {
        const payload = PluginUiReadMachineDisplayNameRequestV1Schema.safeParse(request.payload);
        if (!payload.success) return createPluginSurfaceHostApiError('invalid_payload');
        if (!input.isCurrent() || !input.accountLifetime.isCurrent()) return createPluginSurfaceHostApiError('stale_surface');
        if (options?.signal?.aborted) return createPluginSurfaceHostApiError('unavailable', ['aborted']);
        const state = storage.getState();
        if (!areServerAccountScopesEqual(input.accountLifetime.scope, state.profileScope)
            || !areServerProfileIdentifiersEquivalent(payload.data.serverId, input.accountLifetime.scope.serverId)) {
            return { status: 'unavailable' };
        }
        if (!Object.prototype.hasOwnProperty.call(state.machineDisplayById, payload.data.machineId)) return { status: 'unavailable' };
        const machine = state.machineDisplayById[payload.data.machineId];
        if (!machine || machine.revokedAt) return { status: 'unavailable' };
        return { status: 'ready', displayName: getMachineDisplayName(machine) };
    };
}
