import * as React from 'react';
import type { MarketplaceCatalogReferenceV1 } from '@happier-dev/protocol/marketplace';
import type { RegistryItemV1 } from '@happier-dev/protocol/registries';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { CapabilityAddDetailAction, type CapabilityListingConfig } from '@/components/capabilities/add/CapabilityAddModal';
import { CapabilityDetailHeader } from '@/components/capabilities/detail/CapabilityDetailHeader';
import { useRegistryItem } from '@/registries/useRegistryItem';
import { useRegistrySources } from '@/registries/useRegistrySources';
import { PluginListingFacts } from '@/components/settings/plugins/listing/PluginListingFacts';
import { admitRegistrySummaryMark } from '@/registries/registryBrandMark';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import { t } from '@/text';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { useStoreBrowserProfileScope, useStoreMachineScope } from '@/components/settings/plugins/model/useStoreMachineScope';
import { mcpServerRoute } from '@/components/settings/mcpServers/collection/mcpServerCollectionModel';
import { skillHref } from '@/components/settings/skills/skillsCollectionModel';
import { runGuardedNavigation } from '@/utils/navigation/runGuardedNavigation';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { StoreMcpListing, type StoreMcpListingState } from './StoreMcpListing';
import { StoreSkillListing, type StoreSkillListingState } from './StoreSkillListing';
import { StoreAgentListing, type StoreAgentListingState } from './StoreAgentListing';
import { StorePluginListing, type StorePluginListingState } from './StorePluginListing';
import { resolveStoreContributionRoute } from './catalog/useStoreOpenReference';
import { useStoreStarterListing } from './StoreStarterListing';
import { StoreItemMark } from './catalog/StoreItemMark';
import { presentBrowserExtensionInstallForm } from './submitBrowserExtensionMutation';

type BrowserExtensionListingState = Readonly<{
    config: CapabilityListingConfig<RegistryItemV1>;
    item: RegistryItemV1 | null;
    resolving: boolean;
    error: ReturnType<typeof useRegistryItem>['error'];
    status: ReturnType<typeof useRegistryItem>['status'];
    refresh: ReturnType<typeof useRegistryItem>['refresh'];
}>;

/** Catalog selection and presentation only; the existing browser Action owns acquisition, review and restart. */
function useBrowserExtensionListing(reference: MarketplaceCatalogReferenceV1): BrowserExtensionListingState {
    const selected = reference.type === 'registryItem' && reference.kind === 'browserExtension' ? reference : null;
    const read = useRegistryItem({ kind: 'browserExtension', sourceId: selected?.sourceId ?? '',
        itemId: selected?.itemId ?? '', ...(selected?.version ? { version: selected.version } : {}) }, selected !== null);
    const sources = useRegistrySources('browserExtension', selected !== null);
    const sourceTitle = sources.sources.find(source => source.id === selected?.sourceId)?.title;
    const scope = useAccountSettingsScope();
    const execution = useMountedActionExecution(scope);
    const { binding, execute, getSignal } = execution;
    // A profile's Extensions section opened the Store for one Machine and profile: the form starts there.
    const seedMachineId = useStoreMachineScope()?.machineId ?? null;
    const seedProfileId = useStoreBrowserProfileScope();
    const config = React.useMemo<CapabilityListingConfig<RegistryItemV1>>(() => ({
        catalog: { itemKey: item => item.summary.itemId },
        renderDetail: item => <><CapabilityDetailHeader title={item.summary.title} purpose={item.summary.description}
            mark={<StoreItemMark facts={{ kind: 'browserExtension', title: item.summary.title,
                brand: admitRegistrySummaryMark(item.summary).brandMark }} size={40} />}
            facts={{ extra: [t('capabilities.store.kindWord.browserExtension')] }} testID="store.browserExtension.header" /><CapabilityAddDetailAction />
            {item.payload.kind === 'browserExtension' ? <PluginListingFacts browserExtension={item.payload.listing ?? {}}
                publisher={item.summary.publisher?.name} sourceTitle={sourceTitle} testID="store.browserExtension.facts" /> : null}</>,
        detailFooter: item => ({ primary: { label: t('capabilities.store.add'),
            ...(!execution.ready ? { disabledReason: t('common.loading') } : {}),
            onPress: async () => {
                if (item.payload.kind !== 'browserExtension') return null;
                presentBrowserExtensionInstallForm({ title: item.summary.title, description: item.summary.description ?? null,
                    source: item.payload.extension, execution: { binding, execute, getSignal }, seedMachineId, seedProfileId });
                return null;
            } } }),
        testID: 'store.browserExtension',
    }), [read.item, read.loading, execution.ready, binding, execute, getSignal, seedMachineId, seedProfileId, sourceTitle]);
    return { config, item: read.item, resolving: read.loading, error: read.error, status: read.status, refresh: read.refresh };
}

export type StoreListingState =
    | (Readonly<{ kind: 'mcpServer' }> & StoreMcpListingState)
    | (Readonly<{ kind: 'skill' }> & StoreSkillListingState)
    | (Readonly<{ kind: 'agent' }> & StoreAgentListingState)
    | (Readonly<{ kind: 'plugin' }> & StorePluginListingState)
    | (Readonly<{ kind: 'browserExtension' }> & BrowserExtensionListingState)
    | (Readonly<{ kind: 'starter' }> & ReturnType<typeof useStoreStarterListing>)
    | Readonly<{ kind: 'continuation'; href: string }>
    | Readonly<{ kind: 'unavailable' }>;

/** Validated native ref in; native controller/props out. S40-UI (Apps: STORE-APP-UI) owns detail, pane and page composition. */
export function StoreListingController(props: Readonly<{
    reference: Exclude<MarketplaceCatalogReferenceV1, { type: 'software' }>;
    onClose: () => void;
    continuationId?: string;
    children: (state: StoreListingState) => React.ReactNode;
}>): React.ReactNode {
    const { reference, children, onClose } = props;
    const router = useRouter();
    const browserExtension = useBrowserExtensionListing(reference);
    const starter = useStoreStarterListing(reference);
    const openMcp = React.useCallback<NonNullable<React.ComponentProps<typeof StoreMcpListing>['onAdded']>>((serverId, options) => {
        const result = runGuardedNavigation(() => router.push(mcpServerRoute(serverId, options) as never));
        if (result !== true) fireAndForget(result, { tag: 'StoreListingController.mcp' });
    }, [router]);
    const openSkill = React.useCallback((skillId: string) => {
        const result = runGuardedNavigation(() => router.push(skillHref(skillId) as never));
        if (result !== true) fireAndForget(result, { tag: 'StoreListingController.skill' });
    }, [router]);
    if (reference.type !== 'registryItem') {
        const href = resolveStoreContributionRoute(reference);
        return children(href ? { kind: 'continuation', href } : { kind: 'unavailable' });
    }
    const key = JSON.stringify([reference.kind, reference.sourceId, reference.itemId, reference.version ?? null]);
    switch (reference.kind) {
        case 'starter': return children({ kind: 'starter', ...starter });
        case 'browserExtension': return children({ kind: 'browserExtension', ...browserExtension });
        case 'mcpServer': return <StoreMcpListing key={key} selection={reference} onClose={onClose} onAdded={openMcp} continuationId={props.continuationId}>
            {state => children({ kind: 'mcpServer', ...state })}</StoreMcpListing>;
        case 'skill': return <StoreSkillListing key={key} selection={reference} onClose={onClose} onAdded={openSkill}>
            {state => children({ kind: 'skill', ...state })}</StoreSkillListing>;
        case 'agent': return <StoreAgentListing key={key} selection={reference} onClose={onClose}>
            {state => children({ kind: 'agent', ...state })}</StoreAgentListing>;
        case 'plugin': return <StorePluginListing key={key} reference={reference}>
            {state => children({ kind: 'plugin', ...state })}</StorePluginListing>;
        default: return children({ kind: 'unavailable' });
    }
}
