import * as React from 'react';

import { AGENT_IDS } from '@/agents/catalog/catalog';
import { getResolvedAgentCatalogEntries } from '@/agents/backendCatalog/agentCatalogProjection';
import { useDaemonMergedProjectionInputs } from '@/agents/backendCatalog/useDaemonMergedProjectionInputs';
import {
    useAppShellPluginUiProjection,
    useProjectedConnectedServicesRegistry,
    useProjectedPluginLocalizedTextResolver,
} from '@/components/appShell/plugins/AppShellPluginUiProjection';
import {
    getGeneratedLegacyConnectedServiceRegistryFallback,
    getLegacyConnectedServiceRegistryEntry,
} from '@/sync/domains/connectedServices/connectedServiceRegistry';
import { resolveConnectedAccountUiNegotiation } from '@/sync/domains/connectedServices/resolveConnectedAccountUiNegotiation';
import { useServerFeaturesRuntimeSnapshot } from '@/sync/domains/features/featureDecisionRuntime';
import { useProfile, useSettingsSelector } from '@/sync/store/hooks';
import { getPreferredLanguage, t } from '@/text';
import {
    buildQualifiedPluginContributionKey,
    resolveAgentConnectedAccountPurposeDefaults,
} from '@happier-dev/protocol';

import {
    buildConnectedServicesIndexModel,
    type ConnectedServicesIndexAgentUse,
} from './buildConnectedServicesIndexModel';
import { presentConnectedServiceIndexDiagnostics } from './presentConnectedServiceIndexDiagnostics';
import { resolveConnectedServiceRegistryEntryDisplayName } from './resolveConnectedServiceDisplayName';

/**
 * The Connected services index: which services have accounts (with who uses each and the roles each
 * account plays) and which services the agents on your machines accept that you have not connected
 * (G3). One owner for the page, its in-place catalog and the Home invitation.
 *
 * `agents: 'load'` may ask the app-shell machine for its agent projection (the settings page);
 * `agents: 'cached'` only reads what this launch already holds, so a hub never asks a machine.
 */
export function useConnectedServicesIndex(options: Readonly<{ agents: 'load' | 'cached' }>) {
    const profile = useProfile();
    const settings = useSettingsSelector((settings) => ({
        connectedAccountPurposeBindingsV1: settings.connectedAccountPurposeBindingsV1,
        connectedServicesDefaultAuthByAgentIdV1: settings.connectedServicesDefaultAuthByAgentIdV1,
        connectedServicesDefaultProfileByServiceId: settings.connectedServicesDefaultProfileByServiceId,
    }));
    const appShellProjection = useAppShellPluginUiProjection();
    const registrySnapshot = useProjectedConnectedServicesRegistry();
    const localizePluginText = useProjectedPluginLocalizedTextResolver();
    const locale = getPreferredLanguage();
    const serverFeatures = useServerFeaturesRuntimeSnapshot({ enabled: true });
    const transport = resolveConnectedAccountUiNegotiation(serverFeatures);

    const daemonAgentProjection = useDaemonMergedProjectionInputs({
        machineId: appShellProjection.machineId,
        serverId: appShellProjection.serverId,
        enabled: Boolean(appShellProjection.machineId),
        load: options.agents === 'load',
    });
    const agentEntries = React.useMemo(() => getResolvedAgentCatalogEntries({
        enabledAgentIds: AGENT_IDS,
        mergedProviderProjectionById: daemonAgentProjection.inputs?.mergedProviderProjectionById ?? null,
        mergedBackendProjectionById: daemonAgentProjection.inputs?.mergedBackendProjectionById ?? null,
    }), [
        daemonAgentProjection.inputs?.mergedBackendProjectionById,
        daemonAgentProjection.inputs?.mergedProviderProjectionById,
    ]);
    const agentsKnown = Boolean(daemonAgentProjection.inputs?.mergedProviderProjectionById);

    const legacyServices = profile.connectedServicesV2;
    const qualifiedAccounts = transport === 'advertised-v4' ? profile.connectedAccountsV4 ?? [] : [];
    const qualifiedGroups = transport === 'advertised-v4' ? profile.connectedAccountGroupsV4 ?? [] : [];
    const registryEntries = registrySnapshot.entries;

    const visibleRegistryEntries = React.useMemo(() => {
        if (transport !== 'legacy') return registryEntries;
        // A released V2 profile becomes a row only through the generated built-in adapter. This
        // retains old-server access without allowing a scalar id to select a foreign or novel V4
        // descriptor.
        const byQualifiedService = new Map<string, typeof registryEntries[number]>();
        for (const entry of registryEntries) {
            if (!entry.service || !entry.legacyServiceId) continue;
            byQualifiedService.set(buildQualifiedPluginContributionKey(entry.service), entry);
        }
        for (const service of legacyServices) {
            const entry = getLegacyConnectedServiceRegistryEntry(service.serviceId);
            if (!entry.service || !entry.legacyServiceId) continue;
            byQualifiedService.set(buildQualifiedPluginContributionKey(entry.service), entry);
        }
        return [...byQualifiedService.values()];
    }, [transport, registryEntries, legacyServices]);

    const agentUses = React.useMemo((): readonly ConnectedServicesIndexAgentUse[] | null => {
        if (!agentsKnown) return null;
        return agentEntries
            .filter((agent) => agent.connectedAccounts.length > 0)
            .map((agent) => ({
                agentId: agent.agentId,
                title: agent.title,
                services: agent.connectedAccounts.map((declaration) => declaration.service),
                defaults: agent.identity
                    ? resolveAgentConnectedAccountPurposeDefaults({
                        settings: {
                            connectedAccountPurposeBindingsV1: settings.connectedAccountPurposeBindingsV1,
                            connectedServicesDefaultAuthByAgentIdV1: settings.connectedServicesDefaultAuthByAgentIdV1,
                        },
                        agentId: agent.agentId,
                        consumer: agent.identity,
                        declarations: agent.connectedAccounts,
                    }).flatMap((entry) => entry.target ? [entry.target] : [])
                    : [],
            }));
    }, [
        agentEntries,
        agentsKnown,
        settings.connectedAccountPurposeBindingsV1,
        settings.connectedServicesDefaultAuthByAgentIdV1,
    ]);

    const indexModel = React.useMemo(() => buildConnectedServicesIndexModel({
        transport,
        entries: visibleRegistryEntries,
        qualifiedAccounts,
        qualifiedGroups,
        legacyServices,
        defaultAccountByServiceKey: settings.connectedServicesDefaultProfileByServiceId,
        resolveLabel: (entry) => entry
            ? resolveConnectedServiceRegistryEntryDisplayName(entry, t, localizePluginText)
            : t('connectedServices.fallbackName'),
        resolveFallbackEntry: getGeneratedLegacyConnectedServiceRegistryFallback,
        presentDiagnostics: (entry) => presentConnectedServiceIndexDiagnostics({
            entry,
            registryErrorReason: registrySnapshot.errorReason,
        }),
        loadingLabel: t('common.loading'),
        agentUses,
    }), [
        transport,
        visibleRegistryEntries,
        qualifiedAccounts,
        qualifiedGroups,
        legacyServices,
        settings.connectedServicesDefaultProfileByServiceId,
        // The labels are localized.
        locale,
        localizePluginText,
        registrySnapshot.errorReason,
        agentUses,
    ]);

    return {
        indexModel,
        transport,
        agentEntries,
        agentsKnown,
        qualifiedAccounts,
        qualifiedGroups,
        legacyServices,
        registrySnapshot,
        appShellProjection,
        localizePluginText,
    };
}
