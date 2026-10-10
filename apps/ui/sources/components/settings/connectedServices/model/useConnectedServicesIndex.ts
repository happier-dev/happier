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
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { areServerAccountScopesEqual } from '@/sync/domains/scope/serverAccountScope';
import { selectActiveServerAccountScopeForServer } from '@/sync/domains/scope/activeServerAccountScope';
import { getPreferredLanguage, t } from '@/text';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { resolveAgentConnectedAccountPurposeDefaults } from '@happier-dev/protocol/account/settings/connected-services';
import { useConnectedAccountCatalog } from '@/sync/store/settings/useConnectedAccountCatalog';
import { useProviderCatalog } from '@/sync/store/useProviderCatalog';
import { buildProviderGatewayCollection, areProviderGatewayDeclarationsKnown,
    type ProviderGatewayCollectionRow } from '../../providers/collection/providerCollectionModel';
import { useProviderConnections } from '@/providers/hooks/useProviderConnections';

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
const NO_GATEWAYS: readonly ProviderGatewayCollectionRow[] = Object.freeze([]);

export function useConnectedServicesIndex(options: Readonly<{ agents: 'load' | 'cached'; gateways?: boolean }>) {
    const profile = useProfile();
    const scope = useActiveServerAccountScope();
    // The Account catalog is the saved payload authority, independent of Machine admission.
    const gatewayCatalog = useProviderCatalog(options.gateways ? scope : null);
    const appShellProjection = useAppShellPluginUiProjection();
    const projectionMachineId = appShellProjection.accountLifetime?.isCurrent()
        && areServerAccountScopesEqual(appShellProjection.accountLifetime.scope, scope)
        && selectActiveServerAccountScopeForServer(scope, appShellProjection.serverId)
        ? appShellProjection.machineId : null;
    const sourceMachineId = options.agents === 'load' ? projectionMachineId : null;
    // Listing gateways is a Settings request of its own: the rail asks for it while it only reads
    // cached agents, so the Gateways group does not depend on which detail is open beside it.
    const gatewayMachineId = options.gateways ? projectionMachineId : null;
    const gatewayDeclarations = useProviderConnections({
        enabled: Boolean(options.gateways && gatewayMachineId && gatewayCatalog?.status === 'ready' && !gatewayCatalog.stale
            && gatewayCatalog.data?.connections.some(connection => connection.deployment.kind === 'managedLocal')),
        machineId: gatewayMachineId,
        serverId: appShellProjection.serverId,
    });
    const gateways = React.useMemo(() => {
        if (!gatewayCatalog?.data || gatewayCatalog.status !== 'ready' || gatewayCatalog.stale) return null;
        const connections = gatewayCatalog.data.connections;
        const views = gatewayDeclarations.data?.connections ?? null;
        if (!areProviderGatewayDeclarationsKnown({ connections, views })) return null;
        return connections.some(connection => connection.deployment.kind === 'managedLocal')
            ? buildProviderGatewayCollection({ connections, views: views ?? [] }) : NO_GATEWAYS;
    }, [gatewayCatalog?.data, gatewayCatalog?.status, gatewayCatalog?.stale, gatewayDeclarations.data]);
    const purposeCatalog = useConnectedAccountCatalog('purposes', scope, { sourceMachineId });
    const settings = useSettingsSelector((settings) => ({
        connectedServicesDefaultAuthByAgentIdV1: settings.connectedServicesDefaultAuthByAgentIdV1,
        connectedServicesAdditionalDefaultAuthByAgentIdV1: settings.connectedServicesAdditionalDefaultAuthByAgentIdV1,
        connectedServicesDefaultProfileByServiceId: settings.connectedServicesDefaultProfileByServiceId,
    }));
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
    // The catalog owner supplies admitted bundled declarations while no daemon
    // projection is available. Dynamic Agents still need their projected row.
    const agentsKnown = agentEntries.some((agent) => agent.identity !== null);

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
        if (!agentsKnown || purposeCatalog.status !== 'ready' || purposeCatalog.stale || !purposeCatalog.value) return null;
        return agentEntries
            .filter((agent) => agent.connectedAccounts.length > 0)
            .map((agent) => ({
                agentId: agent.agentId,
                title: agent.title,
                services: agent.connectedAccounts.map((declaration) => declaration.service),
                defaults: agent.identity
                    ? resolveAgentConnectedAccountPurposeDefaults({
                        settings: {
                            connectedServicesDefaultAuthByAgentIdV1: settings.connectedServicesDefaultAuthByAgentIdV1,
                            connectedServicesAdditionalDefaultAuthByAgentIdV1: settings.connectedServicesAdditionalDefaultAuthByAgentIdV1,
                        },
                        purposeBindings: purposeCatalog.value,
                        agentId: agent.agentId,
                        consumer: agent.identity,
                        declarations: agent.connectedAccounts,
                    }).flatMap((entry) => entry.target ? [entry.target] : [])
                    : [],
            }));
    }, [
        agentEntries,
        agentsKnown,
        purposeCatalog.status,
        purposeCatalog.stale,
        purposeCatalog.value,
        settings.connectedServicesDefaultAuthByAgentIdV1,
        settings.connectedServicesAdditionalDefaultAuthByAgentIdV1,
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
        agentUses,
    ]);

    return {
        indexModel,
        gateways,
        gatewaysKnown: gateways !== null,
        gatewayDeclarations,
        gatewayCatalog,
        purposeCatalog,
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
