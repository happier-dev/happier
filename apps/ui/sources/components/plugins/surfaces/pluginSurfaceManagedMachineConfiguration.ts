import { PluginUiOpenManagedMachineConfigurationRequestV1Schema, type PluginUiHostApiSurfaceContextV1 } from '@happier-dev/protocol/plugins/ui/client';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { areServerProfileIdentifiersEquivalent, getServerProfileById } from '@/sync/domains/server/serverProfiles';
import { resolveServerScopedMachine } from '@/sync/domains/machines/resolveServerScopedMachine';
import { storage } from '@/sync/domains/state/storageStore';
import { createManagedProvisionerClient } from '@/components/settings/machines/managed/managedProvisionerClient';
import { buildManagedMachineConfigurationRoute } from '@/components/settings/machines/managed/managedMachineConfigurationRoute';
import { createPluginSurfaceHostApiError, type PluginSurfaceHostApiMethodHandler } from './createPluginSurfaceHostApi';

/** Navigation authority comes from this admitted mount, never the plugin's execution origin. */
export function createPluginSurfaceManagedMachineConfigurationHandler(input: Readonly<{
    target: Extract<PluginUiHostApiSurfaceContextV1['target'], { kind: 'machine' }>;
    accountLifetime: ActiveServerAccountScopeLifetime;
    isCurrent(): boolean;
    navigate(route: string): void;
}>): PluginSurfaceHostApiMethodHandler | null {
    const { target, accountLifetime } = input;
    const homeId = target.homeId;
    const installationId = target.installationId;
    if (!homeId || !installationId) return null;
    const controller = { machineId: target.machineId, installationId };
    const isCurrent = () => {
        if (!input.isCurrent() || !accountLifetime.isCurrent()
            || !areServerProfileIdentifiersEquivalent(target.serverId, accountLifetime.scope.serverId)
            || getServerProfileById(target.serverId)?.serverIdentityId !== homeId) return false;
        const machine = resolveServerScopedMachine(storage.getState(), target.serverId, target.machineId);
        return Boolean(machine && !machine.revokedAt && !machine.replacedByMachineId && machine.installationId === installationId);
    };
    return async (request, options) => {
        const payload = PluginUiOpenManagedMachineConfigurationRequestV1Schema.safeParse(request.payload);
        if (!payload.success) return createPluginSurfaceHostApiError('invalid_payload');
        if (!isCurrent()) return createPluginSurfaceHostApiError('stale_surface');
        if (options?.signal?.aborted) return createPluginSurfaceHostApiError('aborted');
        const catalog = await createManagedProvisionerClient(accountLifetime.scope, homeId).execute(
            'machines.provisioners.list', { homeId, controller }, options?.signal ? { signal: options.signal } : undefined,
        );
        if (!isCurrent()) return createPluginSurfaceHostApiError('stale_surface');
        if (options?.signal?.aborted) return createPluginSurfaceHostApiError('aborted');
        if (catalog.kind !== 'succeeded') return createPluginSurfaceHostApiError(
            catalog.kind === 'failed' ? catalog.code : catalog.kind === 'approval_pending' ? 'approval_waiting' : 'unavailable',
        );
        const provisioner = payload.data.provisioner;
        if (!catalog.value.provisioners.some(entry => entry.contribution.pluginId === provisioner.pluginId
            && entry.contribution.localId === provisioner.localId)) return createPluginSurfaceHostApiError('unavailable');
        input.navigate(buildManagedMachineConfigurationRoute({ serverId: target.serverId,
            provisioner: buildQualifiedPluginContributionKey(provisioner), controller }));
        return null;
    };
}
