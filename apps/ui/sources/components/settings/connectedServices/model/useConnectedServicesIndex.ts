import type { MachineAdministrationTargetSelectionV1 } from '@/sync/domains/machines/administration/useTargetSelection';
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
    type ConnectedServiceRegistrySnapshot,
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
import { buildProviderGatewayCollection, areProviderGatewayDeclarationsKnown, providerConnectionDetailRoute,
    type ProviderGatewayCollectionRow } from '../../providers/collection/providerCollectionModel';
import { useProviderConnectionMutation } from '@/providers/hooks/useProviderConnectionMutation';
import { createProviderGateway, chooseProviderGatewayContributionV1 } from '@/providers/connection/gatewayConfiguration';
import { readAccountProviderDeclarations } from '@/providers/catalog/accountProviderDeclarations';
import { refreshProviderCatalog } from '@/sync/engine/settings/providerCatalogEngine';
import { randomUUID } from '@/platform/randomUUID';

import {
    buildConnectedServicesIndexModel,
    type ConnectedServicesIndexAgentUse,
} from './buildConnectedServicesIndexModel';
import { presentConnectedServiceIndexDiagnostics } from './presentConnectedServiceIndexDiagnostics';
import { resolveConnectedServiceRegistryEntryDisplayName, resolveQualifiedConnectedServiceRegistryDisplayName } from './resolveConnectedServiceDisplayName';

/**
 * The Connected services index: which services have accounts (with who uses each and the roles each
 * account plays) and which services the agents on your machines accept that you have not connected
 * (G3). One owner for the page, its in-place catalog and the Home invitation.
 *
 * `agents: 'load'` may ask the app-shell machine for its agent projection (the settings page);
 * `agents: 'cached'` only reads what this launch already holds, so a hub never asks a machine.
 */
const NO_GATEWAYS: readonly ProviderGatewayCollectionRow[] = Object.freeze([]);

/** A gateway row with what it draws on, as the rail and the phone's index show it. */
export type ConnectedServicesGatewayRow = ProviderGatewayCollectionRow & Readonly<{ summary: string }>;
const ADD_GATEWAY_KEY = 'gateway:add';
const NO_MACHINE_TARGET = () => null;

export function useConnectedServicesIndex(options: Readonly<{ agents: 'load' | 'cached'; gateways?: boolean; registry?: ConnectedServiceRegistrySnapshot;
    targetSelection?: MachineAdministrationTargetSelectionV1 }>) {
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
    // The last loaded catalog stays listed while it reloads; only a current one may add another.
    const gatewayRows = React.useMemo(() => {
        if (!gatewayCatalog?.data) return null;
        const connections = gatewayCatalog.data.connections;
        if (!connections.some(connection => connection.deployment.kind === 'managedLocal')) return NO_GATEWAYS;
        return buildProviderGatewayCollection({ connections, declarationContext: { kind: 'account' } });
    }, [gatewayCatalog?.data]);
    const gatewayCatalogCurrent = gatewayCatalog?.status === 'ready' && !gatewayCatalog.stale;
    const gatewaysKnown = gatewayRows !== null && gatewayCatalogCurrent && areProviderGatewayDeclarationsKnown({
        connections: gatewayCatalog?.data?.connections ?? [], declarationContext: { kind: 'account' },
    });
    // With no gateway yet the Gateways group offers one (D19): an Account write, no machine.
    const refreshGateways = React.useCallback(async () => {
        if (scope) await refreshProviderCatalog(scope);
    }, [scope]);
    const gatewayMutation = useProviderConnectionMutation({ resolveTarget: NO_MACHINE_TARGET,
        serverId: scope?.serverId ?? null, refresh: refreshGateways });
    const runGatewayMutation = gatewayMutation.run;
    const canAddGateway = gatewaysKnown && gatewayRows?.length === 0;
    const gatewayContributionChoice = React.useMemo(() => chooseProviderGatewayContributionV1(
        readAccountProviderDeclarations({ kind: 'account' }), {}), [gatewaysKnown]);
    // The group's place is known before its rows (D19): it holds a loading row while the catalog loads.
    const gatewaysLoading = options.gateways === true && (gatewayRows?.length ?? 0) === 0
        && (!gatewayCatalog || gatewayCatalog.status === 'loading');
    const addGateway = React.useMemo(() => {
        // Account gateway creation does not select an execution Machine.
        if (!canAddGateway || gatewayContributionChoice.status === 'unavailable') return null;
        const allocatedConnectionId = `pc_${randomUUID()}`;
        return async (contributionKey?: string): Promise<string | null> => {
            const choice = chooseProviderGatewayContributionV1(readAccountProviderDeclarations({ kind: 'account' }), { contributionKey });
            if (choice.status !== 'selected') return null;
            const contribution = choice.contribution;
            const connectionId = await createProviderGateway({ run: runGatewayMutation, contribution,
                connectionId: allocatedConnectionId, displayName: t('settingsProvidersCollection.gateway.mainGatewayName'),
                slot: null, key: ADD_GATEWAY_KEY });
            return connectionId ? providerConnectionDetailRoute(connectionId) : null;
        };
    }, [canAddGateway, gatewayContributionChoice, runGatewayMutation]);
    // Feature-known place and catalog authority are separate facts. Refusal must
    // keep the place visible, without granting creation or replacing its reason.
    const gatewaySectionVisible = options.gateways === true;
    const gatewayUnavailable = !gatewaySectionVisible || gatewaysLoading || addGateway || (gatewayRows?.length ?? 0) > 0
        ? null
        : gatewayCatalog && gatewayCatalog.status !== 'ready'
            ? { kind: 'catalog' as const, catalog: gatewayCatalog.catalog }
            : { kind: 'declaration' as const };
    const purposeCatalog = useConnectedAccountCatalog('purposes', scope, { sourceMachineId });
    const settings = useSettingsSelector((settings) => ({
        connectedServicesDefaultAuthByAgentIdV1: settings.connectedServicesDefaultAuthByAgentIdV1,
        connectedServicesAdditionalDefaultAuthByAgentIdV1: settings.connectedServicesAdditionalDefaultAuthByAgentIdV1,
        connectedServicesDefaultProfileByServiceId: settings.connectedServicesDefaultProfileByServiceId,
    }));
    const focusedRegistry = useProjectedConnectedServicesRegistry();
    const registrySnapshot = options.registry ?? focusedRegistry;
    const localizePluginText = useProjectedPluginLocalizedTextResolver();
    const locale = getPreferredLanguage();
    // Under each gateway's name: the services it draws on, an Account fact (no machine is read here).
    const gateways = React.useMemo((): readonly ConnectedServicesGatewayRow[] | null => gatewayRows?.map((row) => ({
        ...row,
        summary: row.slotServices.length > 0
            ? row.slotServices.map((service) => resolveQualifiedConnectedServiceRegistryDisplayName(
                registrySnapshot, service, t, localizePluginText)).join(' · ')
            : t('connectedServices.purposeTargets.notSet'),
    })) ?? null, [gatewayRows, registrySnapshot, localizePluginText, locale]);
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
        const purposeBindings = purposeCatalog.value;
        if (!agentsKnown || purposeCatalog.status !== 'ready' || purposeCatalog.stale || !purposeBindings) return null;
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
                        purposeBindings,
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
        gatewaysKnown,
        gatewaysLoading,
        gatewaySectionVisible,
        gatewayUnavailable,
        retryGateways: refreshGateways,
        addGateway,
        gatewayContributionChoice,
        addingGateway: gatewayMutation.isPending(ADD_GATEWAY_KEY),
        addGatewayError: gatewayMutation.error,
        gatewayApproval: gatewayMutation.pendingApproval,
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
