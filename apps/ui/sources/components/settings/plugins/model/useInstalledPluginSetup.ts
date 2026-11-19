import * as React from 'react';
import type { PluginProjectionV2 } from '@happier-dev/protocol/daemon/contributionRegistryProjection';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { machinePageHref } from '@/components/machines/page/machinePageHref';
import { presentConnectSheet } from '@/components/settings/connectedServices/setup/ConnectedServiceSetupModal';
import { mcpServerRoute } from '@/components/settings/mcpServers/collection/mcpServerCollectionModel';
import { areServerAccountScopesEqual } from '@/sync/domains/scope/serverAccountScope';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { getStorage } from '@/sync/domains/state/storageStore';
import { useActiveServerAccountScopeLifetime, useMachineField, useProfile } from '@/sync/store/hooks';

import { projectInstalledPluginSetup, type InstalledPluginSetupRow, type PluginSettingSetupObservation } from './installedPluginSetup';
import { buildPluginDetailRoute, type PluginsSurfaceHost } from './pluginsSurfaceRoutes';

const NO_SETTING_OBSERVATIONS: readonly PluginSettingSetupObservation[] = [];

/** Shared view model for an installed listing and detail. Opening a row invokes its owning surface. */
export function useInstalledPluginSetup(input: Readonly<{
    pluginId: string;
    host: PluginsSurfaceHost;
    installed: boolean;
    projection: PluginProjectionV2 | null;
    machineId: string | null;
    serverId: string | null;
    settings?: readonly PluginSettingSetupObservation[];
}>) {
    const { installed, pluginId, projection, machineId, serverId, host, settings = NO_SETTING_OBSERVATIONS } = input;
    const router = useRouter();
    const lifetime = useActiveServerAccountScopeLifetime();
    const canUseAccountFacts = installed && lifetime !== null && (serverId === null
        || areServerProfileIdentifiersEquivalent(lifetime.scope.serverId, serverId));
    const profileScope = getStorage()(state => state.profileScope, { profileScope: true });
    const profile = useProfile(current => ({
        id: current.id,
        accounts: current.connectedAccountsV4,
        groups: current.connectedAccountGroupsV4,
    }), ['id', 'connectedAccountsV4', 'connectedAccountGroupsV4']);
    const profileCurrent = canUseAccountFacts && areServerAccountScopesEqual(profileScope, lifetime.scope)
        && profile.id === lifetime.scope.accountId;
    const profiles = profileCurrent ? profile.accounts : null;
    const groups = profileCurrent ? profile.groups : null;
    const machineSetup = useMachineField(machineId ?? '', 'daemonState', 'setup', {
        enabled: installed && machineId !== null && serverId !== null, serverId,
    });
    const rows = React.useMemo(() => installed ? projectInstalledPluginSetup({
        pluginId,
        projection,
        connections: profiles && groups ? { profiles, groups } : null,
        settings,
        machineSetup,
    }) : [], [installed, groups, profiles, pluginId, projection, settings, machineSetup]);
    const open = React.useCallback(async (row: InstalledPluginSetupRow) => {
        if (lifetime?.isCurrent() !== true) return;
        switch (row.kind) {
            case 'connectedAccount':
                if (canUseAccountFacts) await presentConnectSheet({ scope: lifetime.scope, intent: 'link', service: row.service });
                return;
            case 'mcpSignIn':
                if (canUseAccountFacts) router.push(mcpServerRoute(row.serverId) as never);
                return;
            case 'setting':
            case 'secret':
                router.push(buildPluginDetailRoute(host, pluginId));
                return;
            case 'machineRecipe':
                if (machineId && serverId) router.push(machinePageHref({
                    door: 'rail', target: { machineId, serverId }, tab: { id: 'setup' },
                }) as never);
        }
    }, [canUseAccountFacts, lifetime, router, host, pluginId, machineId, serverId]);
    return { rows, open } as const;
}
