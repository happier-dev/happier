import * as React from 'react';
import { useIsFocused, useNavigation } from '@/components/appShell/workspace/destinationRoute';
import type { MarketplaceSourceV1 } from '@happier-dev/protocol/marketplace';

import { MachineAdministrationTargetSelector } from '@/components/settings/machines/MachineAdministrationTargetSelector';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { ExpandableItem } from '@/components/ui/lists/ExpandableItem';
import { SectionContentRow } from '@/components/ui/lists/SectionContentRow';
import { SectionButtonRow } from '@/components/ui/lists/SectionButtonRow';
import { Switch } from '@/components/ui/forms/Switch';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { SectionActionButton } from '@/components/ui/lists/SectionActionButton';
import { buildActionRowAccessibilityLabel } from '@/components/ui/lists/actionRowAccessibility';
import { Modal } from '@/modal';
import { t } from '@/text';
import { useUnsavedDraftNavigationGuard } from '@/utils/navigation/useUnsavedDraftNavigationGuard';
import { runGuardedNavigation } from '@/utils/navigation/runGuardedNavigation';

import { NpmRegistryProfilesSection } from './NpmRegistryProfilesSection';
import { usePluginSettingsScreenState } from './model/usePluginSettingsScreenState';
import { SettingsPageHeader } from '@/components/settings/shell/SettingsPageHeader';

/**
 * The incumbent failure presentation for administration mutations: one modal
 * alert instead of an escaped rejection, mirroring the webhook administration
 * screen.
 */
async function alertSourceOperationFailed(): Promise<void> {
    await Modal.alertAsync(t('common.error'), t('settingsPlugins.sourceAdministration.operationFailed'));
}

async function presentSourceMutationSettlement(
    settlement: Readonly<{ status: 'success' | 'unavailable' | 'outcomeUnknown' | 'superseded' }>,
): Promise<void> {
    if (settlement.status === 'outcomeUnknown') {
        await Modal.alertAsync(
            t('settingsPlugins.sourceAdministration.operationOutcomeUnknownTitle'),
            t('settingsPlugins.sourceAdministration.operationOutcomeUnknownBody'),
        );
    } else if (settlement.status === 'unavailable') {
        await alertSourceOperationFailed();
    }
}

type SourceDraft = Readonly<{ sourceUrl: string; title: string; description: string }>;

function MarketplaceSourceEditor(props: Readonly<{
    source: MarketplaceSourceV1 | null;
    disabled: boolean;
    onSave: (draft: SourceDraft) => Promise<void>;
    onCancel: () => void;
}>) {
    const navigation = useNavigation();
    const [draft, setDraft] = React.useState<SourceDraft>(() => ({
        sourceUrl: props.source?.sourceUrl ?? '',
        title: props.source?.title ?? '',
        description: props.source?.description ?? '',
    }));
    useUnsavedDraftNavigationGuard({
        navigation,
        isDirty: draft.sourceUrl !== (props.source?.sourceUrl ?? '')
            || draft.title !== (props.source?.title ?? '')
            || draft.description !== (props.source?.description ?? ''),
        onDiscard: props.onCancel,
        tag: 'marketplace-source-draft',
    });
    return <>
        {(props.source ? ['sourceUrl', 'title', 'description'] as const : ['sourceUrl'] as const).map((name) => {
            const label = t(name === 'sourceUrl' ? 'settingsPlugins.sourceAdministration.sourceUrl'
                : name === 'title' ? 'settingsPlugins.sourceAdministration.displayName'
                    : 'settingsPlugins.sourceAdministration.description');
            return <Item key={name} title={label} showChevron={false}
                accessoryLayout={name === 'description' ? 'stacked' : 'adaptive'}
                rightElement={<FieldTextInput
                    testID={`settings.plugins.sources.draft.${name}`}
                    accessibilityLabel={label}
                    value={draft[name]}
                    editable={!props.disabled}
                    autoCapitalize="none"
                    multiline={name === 'description'}
                    onChangeText={(value) => setDraft((current) => ({ ...current, [name]: value }))}
                />}
            />;
        })}
        <SectionContentRow><SectionButtonRow>
            <RoundButton testID="settings.plugins.sources.draft.save" title={t('common.save')} size="small"
                disabled={props.disabled || !draft.sourceUrl.trim() || (props.source !== null && !draft.title.trim())}
                onPress={() => { void props.onSave(draft); }} />
            <RoundButton testID="settings.plugins.sources.draft.cancel" title={t('common.cancel')} size="small"
                display="secondary" disabled={props.disabled} onPress={props.onCancel} />
        </SectionButtonRow></SectionContentRow>
    </>;
}

export const PluginMarketplaceSourcesScreen = React.memo(function PluginMarketplaceSourcesScreen() {
    const isFocused = useIsFocused();
    const state = usePluginSettingsScreenState({ focused: isFocused });
    const [busySourceId, setBusySourceId] = React.useState<string | null>(null);
    const [editingSourceId, setEditingSourceId] = React.useState<string | null>(null);
    React.useEffect(() => { setEditingSourceId(null); }, [state.executionMachineId, state.executionServerId]);
    const configuredSources = state.marketplaceSourceRegistry?.sources ?? [];
    const mutationsDisabled = !state.daemonAdministrationAvailable
        || busySourceId !== null
        || state.marketplaceSourceRegistryMutationInFlight;

    const saveSource = React.useCallback(async (draft: SourceDraft, source: MarketplaceSourceV1 | null) => {
        const sourceUrl = draft.sourceUrl.trim();
        const title = draft.title.trim();
        if (!sourceUrl || (source !== null && !title)) return;
        setBusySourceId(source?.id ?? 'new');
        try {
            const settlement = await state.upsertMarketplaceSource({
                sourceUrl, origin: 'user', enabled: source?.enabled ?? true,
                ...(source ? { sourceId: source.id, title, description: draft.description.trim() || null,
                    registryProfileId: source.registryProfileId } : {}),
            });
            await presentSourceMutationSettlement(settlement);
            if (settlement.status === 'success' || settlement.status === 'outcomeUnknown') setEditingSourceId(null);
        } catch {
            await alertSourceOperationFailed();
        } finally {
            setBusySourceId(null);
        }
    }, [state]);

    const remove = React.useCallback(async (source: MarketplaceSourceV1) => {
        const confirmed = await Modal.confirm(
            t('settingsPlugins.sourceAdministration.removeTitle'),
            t('settingsPlugins.sourceAdministration.removeBody', { name: source.title }),
            { confirmText: t('settingsPlugins.sourceAdministration.remove'), cancelText: t('common.cancel'), destructive: true },
        );
        if (!confirmed) return;
        setBusySourceId(source.id);
        try {
            await presentSourceMutationSettlement(await state.removeMarketplaceSource(source.id));
        } catch {
            await alertSourceOperationFailed();
        } finally {
            setBusySourceId(null);
        }
    }, [state]);

    return (
        <ItemList>
            <SettingsPageHeader
                description={t('settingsPlugins.sourceAdministration.subtitle')}
                actions={(
                    <MachineAdministrationTargetSelector
                        selection={state.administrationTargetSelection}
                        testIDPrefix="settings.plugins.sources.target"
                        presentation="chip"
                    />
                )}
            />

            <ItemGroup
                title={t('settingsPlugins.sourceAdministration.configuredTitle')}
                action={(
                    <SectionActionButton
                        testID="settings.plugins.sources.add"
                        title={t('settingsPlugins.sourceAdministration.add')}
                        icon="plus"
                        onPress={() => { void runGuardedNavigation(() => setEditingSourceId('new')); }}
                        disabled={mutationsDisabled || state.marketplaceSourceRegistry === null}
                        loading={busySourceId === 'new'}
                    />
                )}
            >
                {editingSourceId === 'new' ? (
                    <ExpandableItem expanded onExpandedChange={(next) => { if (!next) setEditingSourceId(null); }}
                        header={({ headerProps }) => <Item {...headerProps} title={t('settingsPlugins.sourceAdministration.add')} showChevron={false} />}>
                        <MarketplaceSourceEditor source={null} disabled={mutationsDisabled}
                            onSave={(draft) => saveSource(draft, null)} onCancel={() => setEditingSourceId(null)} />
                    </ExpandableItem>
                ) : null}
                <Item
                    testID="settings.plugins.sources.communityNpm"
                    title={t('settingsPlugins.sourceAdministration.communityTitle')}
                    subtitle={t('settingsPlugins.sourceAdministration.communitySubtitle')}
                    mode="info"
                    showChevron={false}
                    accessibilityLabel={`${t('settingsPlugins.sourceAdministration.communityTitle')}. ${t('settingsPlugins.sourceAdministration.communitySubtitle')}`}
                />
                {state.marketplaceSourceRegistryLoadError ? (
                    <Item
                        testID="settings.plugins.sources.retry"
                        title={t('settingsPlugins.sourceAdministration.loadError')}
                        subtitle={t('settingsPlugins.sourceAdministration.retry')}
                        onPress={state.refreshMarketplaceSourceRegistry}
                        showChevron={false}
                    />
                ) : null}
                {state.marketplaceSourceRegistryMutationOutcomeUnknown ? (
                    <Item
                        testID="settings.plugins.sources.outcomeUnknown"
                        title={t('settingsPlugins.sourceAdministration.operationOutcomeUnknownTitle')}
                        subtitle={t('settingsPlugins.sourceAdministration.operationOutcomeUnknownBody')}
                        onPress={state.refreshMarketplaceSourceRegistry}
                        showChevron={false}
                    />
                ) : null}
                {/* Rows render only from the authoritative registry. While the
                    one registry owner is loading, its loading truth is shown
                    beside any retained last-known rows instead of presenting a
                    false "no sources" answer; a failed read with no retained
                    registry is answered by the retry row above, never by the
                    empty state. */}
                {state.marketplaceSourceRegistryLoading ? (
                    <Item
                        testID="settings.plugins.sources.loading"
                        title={t('common.loading')}
                        mode="info"
                        showChevron={false}
                    />
                ) : null}
                {state.marketplaceSourceRegistry === null && !state.marketplaceSourceRegistryLoading && !state.marketplaceSourceRegistryLoadError ? (
                    <Item
                        testID="settings.plugins.sources.unavailable"
                        title={t(state.administrationTargetLabel ? 'common.unavailable' : 'newSession.selectMachineTitle')}
                        subtitle={state.administrationTargetLabel
                            ? `${state.administrationTargetLabel.machine} · ${state.administrationTargetLabel.server}`
                            : undefined}
                        subtitleLines={0}
                        detail={state.daemonAdministrationAvailable ? t('common.retry') : undefined}
                        onPress={state.daemonAdministrationAvailable ? state.refreshMarketplaceSourceRegistry : undefined}
                        mode={state.daemonAdministrationAvailable ? 'interactive' : 'info'}
                        showChevron={false}
                    />
                ) : null}
                {state.marketplaceSourceRegistry !== null && configuredSources.length === 0 && !state.marketplaceSourceRegistryLoading && !state.marketplaceSourceRegistryLoadError ? (
                    <Item
                        testID="settings.plugins.sources.empty"
                        title={t('settingsPlugins.sourceAdministration.configuredEmpty')}
                        mode="info"
                        showChevron={false}
                    />
                ) : configuredSources.map((source) => {
                    const userOwned = source.origin === 'user';
                    return (
                        <React.Fragment key={source.id}>
                            {/* Enable/disable is a registry mutation every persisted
                                source supports, curated and user alike, through the
                                same setEnabled owner; editing and removal stay
                                user-only. */}
                            <ExpandableItem
                                expanded={userOwned && editingSourceId === source.id}
                                onExpandedChange={(next) => { void runGuardedNavigation(() => setEditingSourceId(next && userOwned ? source.id : null)); }}
                                header={({ headerProps }) => <Item
                                {...(userOwned ? headerProps : {})}
                                testID={`settings.plugins.sources.source.${source.id}`}
                                title={source.title}
                                subtitle={`${source.sourceUrl}\n${t(source.enabled ? 'settingsPlugins.sourceAdministration.enabled' : 'settingsPlugins.sourceAdministration.disabled')} · ${t(userOwned ? 'settingsPlugins.sourceAdministration.user' : 'settingsPlugins.sourceAdministration.curated')}`}
                                onPress={userOwned ? () => { void runGuardedNavigation(() => setEditingSourceId(source.id)); } : undefined}
                                mode={userOwned ? 'interactive' : 'info'}
                                disabled={userOwned && mutationsDisabled}
                                loading={busySourceId === source.id}
                                showChevron={userOwned}
                                rightElement={(
                                    <Switch
                                        testID={`settings.plugins.sources.enabled.${source.id}`}
                                        accessibilityLabel={`${source.title}: ${t(source.enabled ? 'settingsPlugins.sourceAdministration.enabled' : 'settingsPlugins.sourceAdministration.disabled')}`}
                                        accessibilityState={{ checked: source.enabled, disabled: mutationsDisabled }}
                                        value={source.enabled}
                                        disabled={mutationsDisabled}
                                        onValueChange={(enabled) => {
                                            setBusySourceId(source.id);
                                            void state.setMarketplaceSourceEnabled(source.id, enabled)
                                                .then(presentSourceMutationSettlement)
                                                .catch(() => alertSourceOperationFailed())
                                                .finally(() => setBusySourceId(null));
                                        }}
                                    />
                                )}
                                rightElementOutsidePressable={userOwned}
                            />}
                            >
                            {userOwned && editingSourceId === source.id ? <MarketplaceSourceEditor
                                key={source.id} source={source} disabled={mutationsDisabled}
                                onSave={(draft) => saveSource(draft, source)} onCancel={() => setEditingSourceId(null)} /> : null}
                            </ExpandableItem>
                            {userOwned ? (
                                <Item
                                    testID={`settings.plugins.sources.remove.${source.id}`}
                                    title={t('settingsPlugins.sourceAdministration.remove')}
                                    accessibilityLabel={buildActionRowAccessibilityLabel([
                                        t('settingsPlugins.sourceAdministration.remove'),
                                        source.title,
                                    ])}
                                    onPress={() => { void remove(source); }}
                                    disabled={mutationsDisabled}
                                    destructive
                                    showChevron={false}
                                />
                            ) : null}
                        </React.Fragment>
                    );
                })}
            </ItemGroup>

            <NpmRegistryProfilesSection
                daemonOperationsAvailable={state.daemonAdministrationAvailable}
                targetSelection={state.administrationTargetSelection}
                marketplaceSources={configuredSources}
                onSetMarketplaceSourceProfile={state.setMarketplaceSourceProfile}
                marketplaceSourceMutationInFlight={state.marketplaceSourceRegistryMutationInFlight}
            />
        </ItemList>
    );
});
