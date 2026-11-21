import * as React from 'react';
import type { PluginProjectionV2 } from '@happier-dev/protocol/daemon/contributionRegistryProjection';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { presentConnectSheet } from '@/components/settings/connectedServices/setup/ConnectedServiceSetupModal';
import { mcpServerRoute } from '@/components/settings/mcpServers/collection/mcpServerCollectionModel';
import { areServerAccountScopesEqual, serverAccountScopedResourceKey } from '@/sync/domains/scope/serverAccountScope';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { usePersistentUiStateValue } from '@/sync/domains/state/persistentUiState';
import { getStorage } from '@/sync/domains/state/storageStore';
import { useActiveServerAccountScopeLifetime, useMachineField, useProfile } from '@/sync/store/hooks';

import type { PluginProjectionEntry } from '@/agents/backendCatalog/daemonContributionRegistryProjectionAdapters';
import type { PluginAccountAvailabilityReader } from '@/sync/domains/plugins/availability/reader';

import { projectInstalledPluginSetup, type InstalledPluginSetupRow } from './installedPluginSetup';
import type { PluginSettingSetupObservation, PublishPluginSettingSetup } from './pluginSettingSetupObservation';
import { installedPluginSetupDismissals, skipInstalledPluginSetupStep } from './installedPluginSetupDismissals';
import { buildPluginDetailRoute, type PluginsSurfaceHost } from './pluginsSurfaceRoutes';

/** The daemon declaration wins; the Account declaration is the same fallback in listing and detail. */
export function usePluginSetupSettingsDeclaration(pluginId: string, projection: PluginProjectionEntry | null,
    reader: PluginAccountAvailabilityReader | null) {
    return React.useMemo(() => {
        if (projection || !pluginId || !reader) return null;
        const admission = reader.readCurrentSettingsDeclaration({ pluginId });
        return admission.kind === 'available' ? admission.declaration : null;
    }, [pluginId, projection, reader]);
}

/** Collect presence-only publications for the mounted Settings sources. Cleanup withdraws retired facts. */
export function usePluginSettingSetupObservations() {
    const [publications, setPublications] = React.useState<readonly (readonly PluginSettingSetupObservation[])[]>([]);
    const publish = React.useCallback<PublishPluginSettingSetup>((observations) => {
        setPublications(current => [...current, observations]);
        return () => setPublications(current => current.filter(entry => entry !== observations));
    }, []);
    const settings = React.useMemo(() => {
        const fields = new Map<string, PluginSettingSetupObservation>();
        for (const publication of publications) {
            for (const observation of publication) fields.set(observation.field.key, observation);
        }
        return [...fields.values()];
    }, [publications]);
    return { settings, publish };
}

/** Shared view model for an installed listing and detail. Opening a row invokes its owning surface. */
export function useInstalledPluginSetup(input: Readonly<{
    pluginId: string;
    host: PluginsSurfaceHost;
    installed: boolean;
    projection: PluginProjectionV2 | null;
    machineId: string | null;
    serverId: string | null;
    settings: readonly PluginSettingSetupObservation[] | null;
}>) {
    const { installed, pluginId, projection, machineId, serverId, host, settings } = input;
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
    }) ?? null;
    const dismissalKey = canUseAccountFacts ? serverAccountScopedResourceKey(lifetime.scope, pluginId) : null;
    const skippedStepIds = usePersistentUiStateValue(installedPluginSetupDismissals, dismissalKey);
    const setup = React.useMemo(() => installed ? projectInstalledPluginSetup({
        pluginId,
        projection,
        connections: profiles && groups ? { profiles, groups } : null,
        settings,
        machineId,
        machineSetup,
        skippedStepIds,
    }) : { rows: [], steps: [], progress: { done: 0, total: 0 }, settingsPending: false }, [
        installed, groups, profiles, pluginId, projection, settings, machineId, machineSetup, skippedStepIds,
    ]);
    const skip = React.useCallback((row: InstalledPluginSetupRow) => {
        if (dismissalKey === null || lifetime?.isCurrent() !== true) return;
        skipInstalledPluginSetupStep(dismissalKey, row.id);
    }, [dismissalKey, lifetime]);
    const open = React.useCallback(async (row: InstalledPluginSetupRow, title: string, recipeMachineId?: string) => {
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
                if (canUseAccountFacts) {
                    const { showStoreMachineRecipeReview } = await import('@/components/store/StoreSoftwareReview');
                    if (lifetime.isCurrent()) showStoreMachineRecipeReview({
                        name: title, item: row.item, scope: lifetime.scope, machineId: recipeMachineId,
                    });
                }
        }
    }, [canUseAccountFacts, lifetime, router, host, pluginId]);
    return { ...setup, open, skip: dismissalKey === null ? null : skip,
        recipeScope: canUseAccountFacts ? lifetime.scope : null } as const;
}
