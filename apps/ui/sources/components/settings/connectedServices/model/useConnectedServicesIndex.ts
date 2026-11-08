import * as React from 'react';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';

import {
    useProjectedConnectedServicesRegistry,
    useProjectedPluginLocalizedTextResolver,
} from '@/components/appShell/plugins/AppShellPluginUiProjection';
import {
    getConnectedServiceRegistryIdentityFallback,
    getLegacyConnectedServiceRegistryEntry,
    type ConnectedServiceRegistrySnapshot,
} from '@/sync/domains/connectedServices/connectedServiceRegistry';
import { resolveConnectedAccountUiNegotiation } from '@/sync/domains/connectedServices/resolveConnectedAccountUiNegotiation';
import { useServerFeaturesRuntimeSnapshot } from '@/sync/domains/features/featureDecisionRuntime';
import { useProfile } from '@/sync/store/hooks';
import { useSettingsValues } from '@/sync/store/settingsReadHooks';
import type { MachineAdministrationTargetSelectionV1 } from '@/sync/domains/machines/administration/useTargetSelection';
import type { MachineAdministrationTargetV1 } from '@happier-dev/protocol/account/settings/machineAdministrationSelectionsV1';
import { getPreferredLanguage, t } from '@/text';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { canonicalizeProviderContributionKeyV1 } from '@happier-dev/protocol/providers/contribution-identity';
import { useProviderCatalog } from '@/sync/store/useProviderCatalog';
import { useActivePluginAccountAvailabilityReader } from '@/sync/domains/plugins/availability/projection';
import { buildProviderGatewayCollection, areProviderGatewayDeclarationsKnown,
    type ProviderGatewayCollectionRow } from '../../providers/collection/providerCollectionModel';
import { chooseProviderGatewayContributionV1 } from '@/providers/connection/gatewayConfiguration';
import { readAccountProviderDeclarations } from '@/providers/catalog/accountProviderDeclarations';
import { refreshProviderCatalog } from '@/sync/engine/settings/providerCatalogEngine';
import { buildConnectedServicesGatewayRoute } from '../collection/connectedServicesCollectionRoutes';

import {
    buildConnectedServicesIndexModel,
} from './buildConnectedServicesIndexModel';
import { useConnectedServicesAgentUses } from './useConnectedServicesAgents';
import { presentConnectedServiceIndexDiagnostics, presentConnectedServiceRegistryReadState } from './presentConnectedServiceIndexDiagnostics';
import { resolveQualifiedConnectedServiceRegistryDisplayName } from './resolveConnectedServiceDisplayName';

/**
 * The Connected services index: which services have accounts (with who uses each and the roles each
 * account plays) and which services the agents on your machines accept that you have not connected
 * (G3). One owner for the page, its in-place catalog and the Home invitation.
 *
 * `agents: 'load'` asks the selected Connected services Machine for its projection (the settings page);
 * `agents: 'cached'` only reads what this launch already holds, so a hub never asks a machine.
 */
const NO_GATEWAYS: readonly ProviderGatewayCollectionRow[] = Object.freeze([]);
const NO_ACCOUNTS = Object.freeze([]);

/** A gateway row with what it draws on, as the rail and the phone's index show it. */
/** A gateway with the services it serves and the Agents whose saved default model goes through it. */
export type ConnectedServicesGatewayRow = ProviderGatewayCollectionRow & Readonly<{
    summary: string;
    agents: readonly Readonly<{ agentId: string; title: string }>[];
}>;

export function useConnectedServicesIndex(options: Readonly<{ agents: 'load' | 'cached'; gateways?: boolean; registry?: ConnectedServiceRegistrySnapshot;
    targetSelection?: MachineAdministrationTargetSelectionV1; initialMachineTarget?: MachineAdministrationTargetV1 | null;
    /** A focused setup flow reads only its service before joining accounts, pools and labels. */
    serviceKey?: string }>) {
    const presented = useLayoutPresentationActive();
    const pluginAvailability = useActivePluginAccountAvailabilityReader(undefined, { enabled: presented });
    const pluginInstallationCensus = React.useMemo(() => {
        const held = pluginAvailability?.readInstalledPlugins();
        return held?.kind === 'available' ? {
            pluginIds: new Set(held.plugins.map(plugin => plugin.pluginId)),
            complete: held.completeness === 'complete',
        } : null;
    }, [pluginAvailability]);
    const { scope, targetSelection, appShellProjection, daemonAgentProjection, agentEntries, agentsKnown, agentUses }
        = useConnectedServicesAgentUses(options);
    // The Account catalog is the saved payload authority, independent of Machine admission.
    const gatewayCatalog = useProviderCatalog(options.gateways ? scope : null, { enabled: presented });
    // The last loaded catalog stays listed while it reloads; only a current one may add another.
    const gatewayRows = React.useMemo(() => {
        if (!gatewayCatalog?.data) return null;
        const connections = gatewayCatalog.data.connections;
        if (!connections.some(connection => connection.deployment.kind === 'managedLocal')) return NO_GATEWAYS;
        return buildProviderGatewayCollection({ connections, declarationContext: { kind: 'account' },
            accountGrants: gatewayCatalog.data.accountGrants, machineGrants: gatewayCatalog.data.machineGrants });
    }, [gatewayCatalog?.data]);
    const gatewayCatalogCurrent = gatewayCatalog?.status === 'ready' && !gatewayCatalog.stale;
    const gatewaysKnown = gatewayRows !== null && gatewayCatalogCurrent && areProviderGatewayDeclarationsKnown({
        connections: gatewayCatalog?.data?.connections ?? [], declarationContext: { kind: 'account' },
    });
    // Opening a gateway draft never starts a runtime or writes the Account catalog.
    const refreshGateways = React.useCallback(async () => {
        if (scope) await refreshProviderCatalog(scope);
    }, [scope]);
    const canAddGateway = gatewaysKnown;
    const gatewayContributionChoice = React.useMemo(() => chooseProviderGatewayContributionV1(
        readAccountProviderDeclarations({ kind: 'account' }), {}), [gatewaysKnown]);
    // Menu counts are Account catalog facts, even with several gateway contributions.
    // Unknown/stale coverage is not a known zero; no Machine read or runtime activation.
    const gatewayCountsByContributionKey = React.useMemo(() => {
        if (!gatewaysKnown || !gatewayCatalog?.data || !gatewayRows) return null;
        const choices = gatewayContributionChoice.status === 'selected'
            ? [gatewayContributionChoice.contribution] : gatewayContributionChoice.choices;
        const declaredKeys = new Map(choices.map(choice => [canonicalizeProviderContributionKeyV1(choice.contributionKey), choice.contributionKey]));
        const counts: Record<string, number> = Object.fromEntries(choices.map(choice => [choice.contributionKey, 0]));
        const listed = new Set(gatewayRows.map(row => row.connectionId));
        for (const connection of gatewayCatalog.data.connections) {
            if (!listed.has(connection.id) || connection.source.kind !== 'contribution') continue;
            const key = declaredKeys.get(canonicalizeProviderContributionKeyV1(connection.source.contributionKey));
            if (key) counts[key] = (counts[key] ?? 0) + 1;
        }
        return counts;
    }, [gatewaysKnown, gatewayCatalog?.data, gatewayRows, gatewayContributionChoice]);
    // The group's place is known before its rows (D19): it holds a loading row while the catalog loads.
    const gatewaysLoading = options.gateways === true && (gatewayRows?.length ?? 0) === 0
        && (!gatewayCatalog || gatewayCatalog.status === 'loading');
    const addGateway = React.useMemo(() => {
        // Account gateway creation does not select an execution Machine.
        if (!canAddGateway || gatewayContributionChoice.status === 'unavailable') return null;
        return async (contributionKey?: string): Promise<string | null> => {
            const choice = chooseProviderGatewayContributionV1(readAccountProviderDeclarations({ kind: 'account' }), { contributionKey });
            if (choice.status !== 'selected') return null;
            return buildConnectedServicesGatewayRoute({ contributionKey: choice.contribution.contributionKey });
        };
    }, [canAddGateway, gatewayContributionChoice]);
    // Feature-known place and catalog authority are separate facts. Refusal must
    // keep the place visible, without granting creation or replacing its reason.
    const gatewaySectionVisible = options.gateways === true;
    const gatewayUnavailable = !gatewaySectionVisible || gatewaysLoading || addGateway || (gatewayRows?.length ?? 0) > 0
        ? null
        : gatewayCatalog && gatewayCatalog.status !== 'ready'
            ? { kind: 'catalog' as const, catalog: gatewayCatalog.catalog }
            : { kind: 'declaration' as const };
    const settings = useSettingsValues([
        'connectedServicesDefaultProfileByServiceId',
        'providerDefaultModelSelectionsByAgentTargetKeyV1',
    ]);
    const focusedRegistry = useProjectedConnectedServicesRegistry();
    const registrySnapshot = options.registry ?? focusedRegistry;
    const localizePluginText = useProjectedPluginLocalizedTextResolver();
    const locale = getPreferredLanguage();
    const serverFeatures = useServerFeaturesRuntimeSnapshot({ enabled: true });
    const transport = resolveConnectedAccountUiNegotiation(serverFeatures);


    // Slot assignments and saved Agent defaults describe configuration, not live usage.
    // Reuse the catalog's targetability decision; contribution containers have no target key.
    // Naming a consumer never requests a Machine.
    const gateways = React.useMemo((): readonly ConnectedServicesGatewayRow[] | null => {
        if (!gatewayRows) return null;
        const agentsByConnectionId = new Map<string, Array<Readonly<{ agentId: string; title: string }>>>();
        for (const agent of agentEntries) {
            const key = agent.backendTargetKey;
            if (!key) continue;
            const connectionId = settings.providerDefaultModelSelectionsByAgentTargetKeyV1[key]?.ref.providerConnectionId;
            if (!connectionId) continue;
            const agents = agentsByConnectionId.get(connectionId) ?? [];
            agents.push({ agentId: agent.agentId, title: agent.title });
            agentsByConnectionId.set(connectionId, agents);
        }
        return gatewayRows.map((row) => {
            const services = row.slotServices.map(service => resolveQualifiedConnectedServiceRegistryDisplayName(
                registrySnapshot, service, t, localizePluginText)).join(' · ');
            const consumers = agentsByConnectionId.get(row.connectionId) ?? [];
            const agents = consumers.map(agent => agent.title).join(' · ');
            return {
                ...row, agents: consumers, detailRoute: buildConnectedServicesGatewayRoute({ connectionId: row.connectionId }),
                // Off says so first (lab Providers rail "Off · ChatGPT"); serving claims are for a gateway that is on.
                summary: !row.enabled ? t('connectedServicesCollection.railGatewayOff', { services })
                    : !services ? t('connectedServices.purposeTargets.notSet')
                    : agents ? t('connectedServicesCollection.railGatewayServesTo', { services, agents })
                        : t('connectedServicesCollection.railGatewayServes', { services }),
            };
        });
    }, [gatewayRows, agentEntries, settings.providerDefaultModelSelectionsByAgentTargetKeyV1,
        registrySnapshot, localizePluginText, locale]);

    const legacyServices = useProfile(profile => options.serviceKey === undefined ? profile.connectedServicesV2
        : profile.connectedServicesV2.filter(service => {
            const entry = getLegacyConnectedServiceRegistryEntry(service.serviceId);
            return entry.service && buildQualifiedPluginContributionKey(entry.service) === options.serviceKey;
        }));
    const qualifiedAccounts = useProfile(profile => transport !== 'advertised-v4' ? NO_ACCOUNTS
        : options.serviceKey === undefined ? profile.connectedAccountsV4
            : profile.connectedAccountsV4.filter(account => buildQualifiedPluginContributionKey(account.ref.service) === options.serviceKey));
    const qualifiedGroups = useProfile(profile => transport !== 'advertised-v4' ? NO_ACCOUNTS
        : options.serviceKey === undefined ? profile.connectedAccountGroupsV4
            : profile.connectedAccountGroupsV4.filter(group => buildQualifiedPluginContributionKey(group.ref.service) === options.serviceKey));
    const registryEntries = React.useMemo(() => options.serviceKey === undefined ? registrySnapshot.entries
        : registrySnapshot.entries.filter(entry => entry.service
            && buildQualifiedPluginContributionKey(entry.service) === options.serviceKey), [registrySnapshot.entries, options.serviceKey]);

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
    const indexModel = React.useMemo(() => buildConnectedServicesIndexModel({
        transport,
        entries: visibleRegistryEntries,
        registryStatus: registrySnapshot.status,
        qualifiedAccounts,
        qualifiedGroups,
        legacyServices,
        defaultAccountByServiceKey: settings.connectedServicesDefaultProfileByServiceId,
        resolveLabel: (_entry, service) => resolveQualifiedConnectedServiceRegistryDisplayName(
            { entries: visibleRegistryEntries }, service, t, localizePluginText),
        resolveFallbackEntry: getConnectedServiceRegistryIdentityFallback,
        presentDiagnostics: (entry) => presentConnectedServiceIndexDiagnostics({
            entry,
        }),
        loadingLabel: t('common.loading'),
        pluginInstallationCensus,
        agentUses,
    }), [
        transport,
        visibleRegistryEntries,
        registrySnapshot.status,
        qualifiedAccounts,
        qualifiedGroups,
        legacyServices,
        settings.connectedServicesDefaultProfileByServiceId,
        // The labels are localized.
        locale,
        localizePluginText,
        agentUses,
        pluginInstallationCensus,
    ]);

    // A failed read of what the machines can add: the page's line and the "+" menu's notice say it once, with the
    // same Retry of the exact projection read. Saved accounts stay listed and choosable.
    const registryReadReason = presentConnectedServiceRegistryReadState(registrySnapshot);
    const reloadRegistry = appShellProjection.reloadConnectedAccountProjection;
    const registryReadFailure = React.useMemo(() => registryReadReason === null ? null
        : { reason: registryReadReason, retry: reloadRegistry }, [registryReadReason, reloadRegistry]);

    return {
        indexModel,
        targetSelection,
        registryReadFailure,
        gateways,
        gatewaysKnown,
        gatewaysLoading,
        gatewaySectionVisible,
        gatewayUnavailable,
        retryGateways: refreshGateways,
        addGateway,
        gatewayContributionChoice,
        gatewayCountsByContributionKey,
        gatewayCatalog,
        transport,
        agentEntries,
        agentsKnown,
        agentProjection: daemonAgentProjection,
        qualifiedAccounts,
        qualifiedGroups,
        legacyServices,
        registrySnapshot,
        appShellProjection,
        localizePluginText,
    };
}
