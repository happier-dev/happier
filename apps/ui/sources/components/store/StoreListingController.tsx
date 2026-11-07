import * as React from 'react';
import type { MarketplaceCatalogReferenceV1 } from '@happier-dev/protocol/marketplace';
import type { RegistryItemV1 } from '@happier-dev/protocol/registries';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { CapabilityAddDetailAction, type CapabilityListingConfig } from '@/components/capabilities/add/CapabilityAddModal';
import { CapabilityDetailHeader } from '@/components/capabilities/detail/CapabilityDetailHeader';
import { createActionInputForm } from '@/components/plugins/actions/actionInputForm';
import { presentActionInputForm } from '@/components/plugins/actions/presentActionInputForm';
import { useRegistryItem } from '@/registries/useRegistryItem';
import { admitRegistrySummaryMark } from '@/registries/registryBrandMark';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import { t } from '@/text';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { skillHref } from '@/components/settings/skills/skillsCollectionModel';
import { runGuardedNavigation } from '@/utils/navigation/runGuardedNavigation';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { StoreMcpListing, type StoreMcpListingState } from './StoreMcpListing';
import { StoreSkillListing, type StoreSkillListingState } from './StoreSkillListing';
import { StoreAgentListing, type StoreAgentListingState } from './StoreAgentListing';
import { StorePluginListing, type StorePluginListingState } from './StorePluginListing';
import { resolveStoreContributionRoute } from './catalog/useStoreOpenReference';
import { StoreItemMark } from './catalog/StoreItemMark';
import { submitBrowserExtensionMutation } from './submitBrowserExtensionMutation';

type BrowserExtensionListingState = Readonly<{
    config: CapabilityListingConfig<RegistryItemV1>;
    item: RegistryItemV1 | null;
    resolving: boolean;
}>;

/** Catalog selection and presentation only; the existing browser Action owns acquisition, review and restart. */
function useBrowserExtensionListing(reference: MarketplaceCatalogReferenceV1): BrowserExtensionListingState {
    const selected = reference.type === 'registryItem' && reference.kind === 'browserExtension' ? reference : null;
    const read = useRegistryItem({ kind: 'browserExtension', sourceId: selected?.sourceId ?? '',
        itemId: selected?.itemId ?? '', ...(selected?.version ? { version: selected.version } : {}) }, selected !== null);
    const scope = useAccountSettingsScope();
    const execution = useMountedActionExecution(scope);
    const config = React.useMemo<CapabilityListingConfig<RegistryItemV1>>(() => ({
        catalog: { itemKey: item => item.summary.itemId },
        renderDetail: item => <><CapabilityDetailHeader title={item.summary.title} purpose={item.summary.description}
            mark={<StoreItemMark facts={{ kind: 'browserExtension', title: item.summary.title,
                brand: admitRegistrySummaryMark(item.summary).brandMark }} size={40} />}
            facts={{}} testID="store.browserExtension.header" /><CapabilityAddDetailAction /></>,
        detailFooter: item => ({ primary: { label: t('capabilities.store.add'),
            ...(!execution.ready ? { disabledReason: t('common.loading') } : {}),
            onPress: async () => {
                if (item.payload.kind !== 'browserExtension' || !execution.binding) return null;
                const source = item.payload.extension;
                const spec = getActionSpec('browser.extensions.install');
                const inputHints = spec.inputHints!;
                const form = createActionInputForm({
                    presentation: { title: item.summary.title, description: item.summary.description ?? null,
                        inputHints: { ...inputHints, fields: inputHints.fields.filter(field =>
                            field.path === 'machineId' || field.path === 'profileId') } },
                    accountLifetime: execution.binding, signal: execution.getSignal(),
                    submit: (candidate, { signal }) => submitBrowserExtensionMutation({
                        actionId: 'browser.extensions.install', input: { ...candidate, source },
                        machineId: typeof candidate.machineId === 'string' ? candidate.machineId : '',
                        execute: execution.execute, signal, confirmText: t('capabilities.store.add'),
                    }),
                });
                presentActionInputForm({ form, signal: execution.getSignal(), actionId: spec.id });
                return null;
            } } }),
        testID: 'store.browserExtension',
    }), [read.item, read.loading, execution.ready, execution.binding, execution.execute, execution.getSignal]);
    return { config, item: read.item, resolving: read.loading };
}

export type StoreListingState =
    | (Readonly<{ kind: 'mcpServer' }> & StoreMcpListingState)
    | (Readonly<{ kind: 'skill' }> & StoreSkillListingState)
    | (Readonly<{ kind: 'agent' }> & StoreAgentListingState)
    | (Readonly<{ kind: 'plugin' }> & StorePluginListingState)
    | (Readonly<{ kind: 'browserExtension' }> & BrowserExtensionListingState)
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
        case 'browserExtension': return children({ kind: 'browserExtension', ...browserExtension });
        case 'mcpServer': return <StoreMcpListing key={key} selection={reference} onClose={onClose} continuationId={props.continuationId}>
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
