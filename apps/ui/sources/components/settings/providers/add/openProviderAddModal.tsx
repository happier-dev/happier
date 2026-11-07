import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';
import { canonicalizeProviderContributionKeyV1 } from '@happier-dev/protocol/providers/contribution-identity';
import { projectAvailableProviderContributionsV1 } from '@happier-dev/protocol/providers/connections/sourceFactsV1';

import { CapabilityAddDetailAction, CapabilityAddModalBody, openCapabilityAddModalHost, type CapabilityAddModalConfig } from '@/components/capabilities/add/CapabilityAddModal';
import { CapabilityDetailHeader } from '@/components/capabilities/detail/CapabilityDetailHeader';
import { buildCapabilityCollectionAnatomy } from '@/components/capabilities/row/buildCapabilityCollectionAnatomy';
import { EmptyState } from '@/components/ui/empty/EmptyState';
import type { CustomModalInjectedProps } from '@/modal/types';
import { readAccountAgentProviderDeclarations, readAccountProviderDeclarations } from '@/providers/catalog/accountProviderDeclarations';
import { projectProviderDeclarationDetail, type ProviderDeclarationDetail } from '@/providers/catalog/providerDeclarationDetail';
import { Text } from '@/components/ui/text/Text';
import { ProviderIcon } from '@/providers/connection/ProviderIcon';
import { presentDetectedProvider } from '@/providers/connection/detectedProviderPresentation';
import { useProviderSettingsTarget } from '@/providers/hooks/targetMachine';
import { useProviderConnections, type ProviderConnectionRefreshScope } from '@/providers/hooks/useProviderConnections';
import { useRetireProviderStateOnAccountChange } from '@/providers/hooks/accountLifetimeRetirement';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { t } from '@/text';

import { ProviderAddDetailSections } from './ProviderAddDetailSections';
import { ProviderErrorItems } from '../ProviderErrorItems';
import { useProviderFeatureAvailability } from '../ProviderFeatureAvailability';
import { buildProviderCollection, newProviderRoute, providerConnectionDetailRoute, type ProviderAvailableContribution, type ProviderCollectionFoundRow } from '../collection/providerCollectionModel';
import { ProviderConnectionAuthoringScreen } from '../ProviderConnectionAuthoringScreen';
import { useProviderFoundContinuation } from '../collection/useProviderFoundContinuation';

type ProviderAddRow = Readonly<{ kind: 'contribution'; key: string; provider: ProviderAvailableContribution; detail: ProviderDeclarationDetail }>
    | Readonly<{ kind: 'found'; key: string; found: ProviderCollectionFoundRow;
        /** The found server's provider in the catalog: its details say what it needs, works with and holds. */
        contribution: Readonly<{ provider: ProviderAvailableContribution; detail: ProviderDeclarationDetail }> | null }>;
type ProviderAddParams = Readonly<{ onAdd: (href: string) => void }>;
const TEST_ID = 'providers.add';

/** Every Provider Add entry uses the capability picker; setup remains the existing authoring owner. */
export function openProviderAddModal(params: ProviderAddParams): Readonly<{ close: () => void }> {
    return openCapabilityAddModalHost(ProviderAddModal, { params }, {
        title: t('settingsProvidersCollection.pickerTitle'), testID: TEST_ID,
    });
}

function ProviderAddModal({ params, onClose, ...injected }: CustomModalInjectedProps & Readonly<{ params: ProviderAddParams }>) {
    const { theme } = useUnistyles();
    const { enabled } = useProviderFeatureAvailability();
    const accountLifetime = useRetireProviderStateOnAccountChange(onClose);
    const target = useProviderSettingsTarget();
    const localDiscoveryEnabled = useFeatureEnabled('providers.localDiscovery');
    const query = useProviderConnections({ enabled: enabled && target.accountAddressAvailable,
        machineId: target.machineId, serverId: target.accountServerId });
    const refresh = React.useCallback(async (scope?: ProviderConnectionRefreshScope) => { await query.refresh(scope); }, [query.refresh]);
    const continueAuthoring = (href: string) => {
        if (accountLifetime?.isCurrent()) params.onAdd(href);
    };
    const navigate = (href: string) => { onClose(); continueAuthoring(href); };
    const foundContinuation = useProviderFoundContinuation({ target, refresh, navigate });
    const [search, setSearch] = React.useState('');
    const available = React.useMemo(() => {
        // The Account declaration owner supplies bundled and admitted dynamic Providers.
        const declarations = new Map(readAccountProviderDeclarations(query.declarationContext)
            .map(declaration => [canonicalizeProviderContributionKeyV1(declaration.contributionKey), declaration]));
        const agents = new Map(readAccountAgentProviderDeclarations({ kind: 'account' }).map(agent => [agent.agentTargetKey, agent]));
        for (const agent of readAccountAgentProviderDeclarations(query.declarationContext)) agents.set(agent.agentTargetKey, agent);
        const agentDeclarations = [...agents.values()];
        return projectAvailableProviderContributionsV1({ connections: query.catalog?.connections ?? [], definitions: [...declarations.values()] })
            .map(provider => ({ provider, detail: projectProviderDeclarationDetail(declarations.get(canonicalizeProviderContributionKeyV1(provider.contributionKey))!, agentDeclarations) }));
    }, [query.catalog?.connections, query.declarationContext]);
    const found = React.useMemo(() => buildProviderCollection({ data: query.data, query: '', localDiscoveryEnabled,
        declarationContext: query.declarationContext }).found, [query.data, query.declarationContext, localDiscoveryEnabled]);
    const rows = React.useMemo<readonly ProviderAddRow[]>(() => {
        if (!enabled || !target.accountAddressAvailable) return [];
        const needle = search.trim().toLocaleLowerCase();
        const byContribution = new Map(available.map(entry => [canonicalizeProviderContributionKeyV1(entry.provider.contributionKey), entry]));
        return [
            ...found.map(row => ({ kind: 'found' as const, key: row.key, found: row,
                contribution: byContribution.get(canonicalizeProviderContributionKeyV1(foundContributionKey(row))) ?? null })),
            ...available.map(({ provider, detail }) => ({ kind: 'contribution' as const, key: `contribution:${provider.contributionKey}`, provider, detail })),
        ].filter(row => title(row).toLocaleLowerCase().includes(needle));
    }, [available, enabled, found, search, target.accountAddressAvailable]);
    // A row's mark stands in its leading column; the details' at the header's mark size (as MCP and Agents draw them).
    const mark = (row: ProviderAddRow, size = 20) => <ProviderIcon contributionKey={row.kind === 'contribution' ? row.provider.contributionKey
        : foundContributionKey(row.found)}
        icon={row.kind === 'contribution' ? row.provider.icon : row.found.icon} size={size} color={theme.colors.text.secondary} />;
    const config: CapabilityAddModalConfig<ProviderAddRow> = {
        title: t('settingsProvidersCollection.pickerTitle'), testID: TEST_ID,
        modes: [
            { key: 'browse', label: t('settingsProvidersCollection.menuCatalogCategory'), icon: 'magnifying-glass', kind: 'catalog' },
            // A custom endpoint is set up in the dialog by the one authoring owner; saving opens the new provider.
            { key: 'custom', label: t('settingsProvidersCollection.customEndpoint'), icon: 'plus', kind: 'input',
                renderBody: () => <ProviderConnectionAuthoringScreen onCreated={connectionId => navigate(providerConnectionDetailRoute(connectionId))} onDiscard={onClose} /> },
        ],
        catalog: { query: search, onQueryChange: setSearch, searchPlaceholder: t('settingsProviders.searchPlaceholder'),
            items: rows, itemKey: row => row.key, loading: query.loading && available.length === 0,
            groups: [
                { key: 'found', title: t('settingsProvidersCollection.addFoundGroup'), itemKeys: rows.filter(row => row.kind === 'found').map(row => row.key) },
                { key: 'providers', title: t('settingsProvidersCollection.addProvidersGroup'), itemKeys: rows.filter(row => row.kind === 'contribution').map(row => row.key) },
            ].filter(group => group.itemKeys.length > 0),
            anatomy: buildCapabilityCollectionAnatomy({ title, description, facts: () => ({}), mark: row => mark(row),
                accessibilityLabel: row => [title(row), description(row)].filter(Boolean).join(', '),
                testID: row => `${TEST_ID}:item:${row.key}` }),
            empty: <EmptyState layout="line" title={t(search.trim() ? 'settingsProviders.searchEmptyTitle' : 'settingsProviders.emptyTitle')} /> },
        renderDetail: row => <>
            <CapabilityDetailHeader title={title(row)} purpose={purpose(row) ?? undefined} mark={mark(row, 28)}
                facts={row.kind === 'found' && row.found.kind === 'candidate' ? (() => {
                    const candidate = row.found.candidate;
                    const details = presentDetectedProvider(candidate,
                        target.machineRows.find(machine => machine.target.machineId === candidate.machineId)?.displayName ?? candidate.machineId);
                    const facts = headerFacts(row);
                    return { ...facts, extra: [...(facts.extra ?? []), details.where, details.availability] };
                })() : headerFacts(row)} testID={`${TEST_ID}:detail:${row.key}`} />
            <CapabilityAddDetailAction />
            {row.kind === 'contribution'
                ? <ProviderAddDetailSections name={row.provider.name} kind={row.provider.kind} detail={row.detail} testID={`${TEST_ID}:detail:${row.key}`} />
                : row.contribution
                    ? <ProviderAddDetailSections name={row.contribution.provider.name} kind={row.contribution.provider.kind}
                        detail={row.contribution.detail} testID={`${TEST_ID}:detail:${row.key}`} /> : null}
            {query.error || query.machineError || foundContinuation.mutation.error || foundContinuation.selectionError
                ? <ProviderErrorItems size="line" error={foundContinuation.selectionError ?? foundContinuation.mutation.error ?? query.error ?? query.machineError}
                    retry={foundContinuation.mutation.error ? foundContinuation.mutation.retry : refresh} /> : null}
        </>,
        detailFooter: row => ({
            ...(row.kind === 'contribution' && row.detail.nextStep ? {
                provenance: <Text variant="meta" style={{ color: theme.colors.text.secondary }}>{t('settingsProvidersCollection.addNextApiKey')}</Text>,
            } : {}),
            primary: {
                label: t(row.kind === 'contribution' ? 'settingsProvidersCollection.connect' : row.found.kind === 'candidate'
                    ? 'settingsProvidersCollection.connect' : 'settingsProvidersCollection.start'),
                ...(row.kind === 'found' && row.found.kind === 'installation' && !row.found.installation.managedStartAvailable
                    ? { disabledReason: description(row) ?? t('settingsProviders.local.installedNotRunning') } : {}),
                onPress: async () => {
                    if (row.kind === 'contribution') { navigate(newProviderRoute(row.provider.contributionKey)); return null; }
                    const result = row.found.kind === 'candidate'
                        ? await foundContinuation.connectDetectedCandidate(row.found.candidate)
                        : await foundContinuation.startLocalInstallation(row.found.installation);
                    return result?.status === 'success' ? { itemId: row.key } : null;
                },
            },
        }),
    };
    return <CapabilityAddModalBody {...injected} onClose={onClose} config={config} />;
}

/** The header's one sentence: what connecting gives you (the row's kind line moves to the header facts). */
function purpose(row: ProviderAddRow): string | null {
    if (row.kind === 'found') return description(row);
    return t(row.detail.auth?.required ? 'settingsProvidersCollection.addDescription' : 'settingsProvidersCollection.addDetail.purpose', { provider: row.provider.name });
}
function headerFacts(row: ProviderAddRow): React.ComponentProps<typeof CapabilityDetailHeader>['facts'] {
    // A found server's header carries its catalog provider's facts, as that provider's own details do.
    const entry = row.kind === 'contribution' ? row : row.contribution;
    if (entry === null) return {};
    const { provider, detail } = entry;
    const extra = [provider.kind === 'frontier' || provider.kind === 'local' ? null : t(`settingsProviders.kind.${provider.kind}`),
        provider.provenance === 'external' ? t('settingsProviders.compatibility.experimental') : null].filter((fact): fact is string => fact !== null);
    return detail.source.provenance === 'first_party' ? { source: { kind: 'happier' }, extra } : { extra };
}
function foundContributionKey(found: ProviderCollectionFoundRow): string {
    return found.kind === 'candidate' ? found.candidate.contributionKey : found.installation.contributionKey;
}

function title(row: ProviderAddRow): string { return row.kind === 'contribution' ? row.provider.name : row.found.title; }
function description(row: ProviderAddRow): string | null {
    if (row.kind === 'found') return row.found.kind === 'candidate'
        ? t('settingsProvidersCollection.foundOnThisMachine')
        : t(row.found.installation.status === 'app_running_server_off' ? 'settingsProviders.local.appRunningServerOff' : 'settingsProviders.local.installedNotRunning');
    // A catalog row is not a found one, so the local kind's "Runs on this machine" stays off it (found rows say where).
    return [row.provider.kind === 'frontier' || row.provider.kind === 'local' ? null : t(`settingsProviders.kind.${row.provider.kind}`),
        row.provider.provenance === 'external' ? t('settingsProviders.compatibility.experimental') : null].filter(Boolean).join(' · ') || null;
}
