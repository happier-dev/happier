import * as React from 'react';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { Icon } from '@/components/ui/icons/Icon';

import { DEFAULT_AGENT_ID } from '@/agents/catalog/catalog';
import { MachineAdministrationTargetSelector } from '@/components/settings/machines/MachineAdministrationTargetSelector';
import { ItemList } from '@/components/ui/lists/ItemList';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Item } from '@/components/ui/lists/Item';
import { Switch } from '@/components/ui/forms/Switch';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { FieldValueItem } from '@/components/ui/forms/FieldValueItem';
import { SegmentedChoiceItem } from '@/components/ui/lists/SegmentedChoiceItem';
import { t } from '@/text';

import { getDaemonMemoryStatusStateTranslationKey } from '@/sync/domains/memory/getDaemonMemoryStatusStateTranslationKey';
import { getDaemonMemoryEmbeddingsStatusTranslationKey } from '@/sync/domains/memory/getDaemonMemoryEmbeddingsStatusTranslationKey';
import { presentDaemonMemoryStatus } from '@/sync/domains/memory/presentDaemonMemoryStatus';
import { presentDaemonMemoryEmbeddingsStatus } from '@/sync/domains/memory/presentDaemonMemoryEmbeddingsStatus';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';

import type { MemorySettingsV1 } from '@happier-dev/protocol/memory/memorySettings';
import { MemorySettingsArchivedRow } from './MemorySettingsArchivedSection';
import { MemorySettingsBudgetsSection } from './MemorySettingsBudgetsSection';
import { MemorySettingsContentPolicySection } from './MemorySettingsContentPolicySection';
import { MemorySettingsCoverageRow } from './MemorySettingsCoverageSection';
import { MemorySettingsEmbeddingsSection } from './MemorySettingsEmbeddingsSection';
import { MemorySettingsIndexTelemetrySection } from './MemorySettingsIndexTelemetrySection';
import { MemorySettingsPrivacySection } from './MemorySettingsPrivacySection';
import { SettingsPageHeader } from '@/components/settings/shell/SettingsPageHeader';
import { SettingAnchor, SettingRow, SettingSection } from '@/components/settings/shell/SettingRow';
import { MEMORY_SETTINGS } from '@/components/settings/memory/memorySettings';
import { useMachineMemorySettings } from '@/components/settings/memory/useMachineMemorySettings';

/**
 * Until a machine's index is ready only the local index section renders; its "Enabled" row says what
 * is missing (choose a machine, reachable, update). It answers a search for any Memory setting then.
 */
const MEMORY_SECTIONS_AFTER_READY = Object.values(MEMORY_SETTINGS.sectionRefs)
    .filter((section) => section !== MEMORY_SETTINGS.sectionRefs.localIndex);

/** In light mode the embeddings section is not rendered; the Indexing section, whose Index mode row leads to it, answers for it. */
const MEMORY_EMBEDDINGS_SECTIONS = [MEMORY_SETTINGS.sectionRefs.embeddings];

type IndexMode = MemorySettingsV1['indexMode'];
type BackfillPolicy = MemorySettingsV1['backfillPolicy'];
type SummarizerPermissionMode = MemorySettingsV1['hints']['summarizerPermissionMode'];

export const MemorySettingsView = React.memo(function MemorySettingsView() {
    const router = useRouter();
    const memorySearchEnabled = useFeatureEnabled('memory.search');
    const {
        administrationTargetSelection,
        access,
        loading,
        settings,
        memoryStatus,
        memoryStatusRequestState,
        fetchSettings,
        writeSettings,
    } = useMachineMemorySettings({ enabled: memorySearchEnabled });

    const indexModeOptions = React.useMemo(() => [
        { id: 'hints' as const, label: t('memorySearchSettings.indexMode.options.lightTitle'), description: t('memorySearchSettings.indexMode.options.lightSubtitle') },
        { id: 'deep' as const, label: t('memorySearchSettings.indexMode.options.deepTitle'), description: t('memorySearchSettings.indexMode.options.deepSubtitle') },
    ], []);
    const backfillOptions = React.useMemo(() => [
        { id: 'new_only' as const, label: t('memorySearchSettings.backfill.options.newOnlyTitle'), description: t('memorySearchSettings.backfill.options.newOnlySubtitle') },
        { id: 'last_30_days' as const, label: t('memorySearchSettings.backfill.options.last30DaysTitle'), description: t('memorySearchSettings.backfill.options.last30DaysSubtitle') },
        { id: 'all_history' as const, label: t('memorySearchSettings.backfill.options.allHistoryTitle'), description: t('memorySearchSettings.backfill.options.allHistorySubtitle') },
    ], []);
    const summarizerPermissionOptions = React.useMemo(() => [
        { id: 'no_tools' as const, label: t('memorySearchSettings.hints.permissions.options.noToolsTitle'), description: t('memorySearchSettings.hints.permissions.options.noToolsSubtitle') },
        { id: 'read_only' as const, label: t('memorySearchSettings.hints.permissions.options.readOnlyTitle'), description: t('memorySearchSettings.hints.permissions.options.readOnlySubtitle') },
    ], []);

    const statusPresentation = React.useMemo(() => presentDaemonMemoryStatus(memoryStatus), [memoryStatus]);
    const embeddingsStatusPresentation = React.useMemo(
        () => presentDaemonMemoryEmbeddingsStatus(memoryStatus),
        [memoryStatus],
    );
    const statusSubtitle = React.useMemo(() => {
        if (loading && !statusPresentation) return t('common.loading');
        return t(getDaemonMemoryStatusStateTranslationKey(statusPresentation));
    }, [loading, statusPresentation]);
    const embeddingsStatusSubtitle = React.useMemo(() => {
        if (loading && !embeddingsStatusPresentation) return t('common.loading');
        return t(getDaemonMemoryEmbeddingsStatusTranslationKey(embeddingsStatusPresentation));
    }, [embeddingsStatusPresentation, loading]);
    const diskUsageSubtitle = React.useMemo(() => {
        if (!statusPresentation) return t('memorySearchSettings.status.diskUsageUnavailable');
        return t('memorySearchSettings.status.diskUsageFormatted', {
            light: statusPresentation.lightSize ?? t('common.unavailable'),
            deep: statusPresentation.deepSize ?? t('common.unavailable'),
        });
    }, [statusPresentation]);
    const showEmbeddingsStatus = (memoryStatus?.indexMode ?? settings.indexMode) === 'deep';
    const embeddingsProviderSubtitle = React.useMemo(() => {
        const providerKind = embeddingsStatusPresentation?.providerKind;
        if (providerKind === 'local_transformers') {
            return t('memorySearchSettings.status.embeddingsProviderLocal');
        }
        if (providerKind === 'openai_compatible') {
            return t('memorySearchSettings.status.embeddingsProviderOpenAiCompatible');
        }
        return t('common.unavailable');
    }, [embeddingsStatusPresentation?.providerKind]);
    const embeddingsModelSubtitle = React.useMemo(() => {
        return embeddingsStatusPresentation?.modelId ?? t('common.unavailable');
    }, [embeddingsStatusPresentation?.modelId]);

    // The chip names the machine this page manages; it stays in every state because it is how
    // the user recovers from a missing or unreachable machine.
    const machineChip = (
        <MachineAdministrationTargetSelector
            selection={administrationTargetSelection}
            testIDPrefix="memory-settings-target"
            presentation="chip"
        />
    );

    if (!memorySearchEnabled) {
        return (
            <ItemList>
                <SettingsPageHeader description={t('memorySearchSettings.pagePurpose')} actions={machineChip} />
                <ItemGroup
                    title={t('memorySearchSettings.disabled.title')}
                    description={t('memorySearchSettings.disabled.footer')}
                >
                    <Item
                        icon={<Icon name="flask" />}
                        testID="memory-settings-open-features"
                        title={t('memorySearchSettings.disabled.openFeatureSettings')}
                        onPress={() => router.push('/settings/features')}
                    />
                </ItemGroup>
            </ItemList>
        );
    }

    const enabledSubtitle = access === 'ready'
        ? t('memorySearchSettings.enabled.subtitle')
        : access === 'noMachine'
            ? t('memorySearchSettings.enabled.chooseMachine')
            : access === 'pending'
                ? t('common.loading')
                : access === 'unreachable'
                ? t('memorySearchSettings.enabled.unreachable')
                : t('memorySearchSettings.enabled.updateRequired');

    return (
        <ItemList>
            <SettingsPageHeader description={t('memorySearchSettings.pagePurpose')} actions={machineChip} />
            <SettingSection section={MEMORY_SETTINGS.sectionRefs.localIndex} answersFor={access === 'ready' ? undefined : MEMORY_SECTIONS_AFTER_READY}>
                <ItemGroup
                    title={t('memorySearchSettings.enabled.sectionTitle')}
                    description={t('memorySearchSettings.enabled.footer')}
                >
                    <SettingRow
                        setting={MEMORY_SETTINGS.settings.enabled}
                        subtitle={enabledSubtitle}
                        subtitleLines={0}
                        rightElement={access === 'ready' ? (
                            <Switch
                                value={settings.enabled}
                                onValueChange={(value) => {
                                    void writeSettings({ ...settings, enabled: Boolean(value) });
                                }}
                            />
                        ) : access === 'unreachable' ? (
                            <RoundButton
                                testID="memory-settings-retry"
                                size="small"
                                display="secondary"
                                title={t('common.retry')}
                                disabled={loading}
                                onPress={() => fetchSettings()}
                            />
                        ) : null}
                        showChevron={false}
                    />
                    {access === 'noMachine' ? null : (
                        <>
                            <Item
                                title={t('memorySearchSettings.status.title')}
                                subtitle={statusSubtitle}
                                showChevron={false}
                            />
                            <Item
                                title={t('memorySearchSettings.status.diskUsageTitle')}
                                subtitle={diskUsageSubtitle}
                                showChevron={false}
                            />
                        </>
                    )}
                    {access !== 'noMachine' && showEmbeddingsStatus ? (
                        <>
                            <Item
                                title={t('memorySearchSettings.status.embeddingsTitle')}
                                subtitle={embeddingsStatusSubtitle}
                                showChevron={false}
                            />
                            <Item
                                title={t('memorySearchSettings.status.embeddingsProviderTitle')}
                                subtitle={embeddingsProviderSubtitle}
                                showChevron={false}
                            />
                            <Item
                                title={t('memorySearchSettings.status.embeddingsModelTitle')}
                                subtitle={embeddingsModelSubtitle}
                                showChevron={false}
                            />
                        </>
                    ) : null}
                    {/* Which conversations are searched, and how, is the Search page's. */}
                    <Item
                        icon={<Icon name="magnifying-glass" />}
                        testID="memory-settings-open-search"
                        title={t('conversationSearch.openSearchSettings')}
                        onPress={() => router.push('/settings/search')}
                    />
                </ItemGroup>
            </SettingSection>

            <MemorySettingsIndexTelemetrySection memoryStatus={memoryStatus} />

            {access !== 'ready' ? null : (
                <>
                    {/* Without deep mode the embeddings rows do not exist; Index mode (in this section) is what leads to them. */}
                    <SettingSection section={MEMORY_SETTINGS.sectionRefs.indexing} answersFor={settings.indexMode === 'deep' ? undefined : MEMORY_EMBEDDINGS_SECTIONS}>
                    <ItemGroup
                        title={t('memorySearchSettings.indexing.title')}
                        description={t('memorySearchSettings.indexing.description')}
                    >
                        <SettingAnchor setting={MEMORY_SETTINGS.settings.indexMode}>
                            <SegmentedChoiceItem<IndexMode>
                                title={t(MEMORY_SETTINGS.settings.indexMode.titleKey)}
                                options={indexModeOptions}
                                value={settings.indexMode}
                                onChange={(mode) => {
                                    void writeSettings({
                                        ...settings,
                                        indexMode: mode,
                                        hints: mode === 'hints' ? { ...settings.hints, enabled: true } : settings.hints,
                                    });
                                }}
                                testIDPrefix="memory-settings-index-mode"
                            />
                        </SettingAnchor>
                        <SettingAnchor setting={MEMORY_SETTINGS.settings.backfill}>
                            <SegmentedChoiceItem<BackfillPolicy>
                                title={t(MEMORY_SETTINGS.settings.backfill.titleKey)}
                                options={backfillOptions}
                                value={settings.backfillPolicy}
                                onChange={(policy) => {
                                    void writeSettings({ ...settings, backfillPolicy: policy });
                                }}
                                testIDPrefix="memory-settings-backfill"
                            />
                        </SettingAnchor>
                        <MemorySettingsCoverageRow settings={settings} writeSettings={writeSettings} />
                        <MemorySettingsArchivedRow
                            settings={settings}
                            status={memoryStatus}
                            statusRequestState={memoryStatusRequestState}
                            writeSettings={writeSettings}
                        />
                    </ItemGroup>
                    </SettingSection>

                    <MemorySettingsContentPolicySection settings={settings} writeSettings={writeSettings} />

                    <MemorySettingsEmbeddingsSection settings={settings} writeSettings={writeSettings} />

                    <ItemGroup
                        title={t('memorySearchSettings.hints.title')}
                        description={t('memorySearchSettings.hints.footer')}
                    >
                        <SettingAnchor setting={MEMORY_SETTINGS.settings.summarizerBackend}>
                            <FieldValueItem
                                testID="memory-settings-summarizer-backend"
                                fieldTestID="memory-settings-summarizer-backend-field"
                                title={t(MEMORY_SETTINGS.settings.summarizerBackend.titleKey)}
                                subtitle={t('memorySearchSettings.hints.backend.promptBody')}
                                placeholder={DEFAULT_AGENT_ID}
                                monospace
                                value={settings.hints.summarizerBackendId}
                                onCommit={(draft) => {
                                    if (!draft) return settings.hints.summarizerBackendId;
                                    void writeSettings({
                                        ...settings,
                                        hints: { ...settings.hints, summarizerBackendId: draft },
                                    });
                                }}
                            />
                        </SettingAnchor>
                        <SettingAnchor setting={MEMORY_SETTINGS.settings.summarizerModel}>
                            <FieldValueItem
                                testID="memory-settings-summarizer-model"
                                fieldTestID="memory-settings-summarizer-model-field"
                                title={t(MEMORY_SETTINGS.settings.summarizerModel.titleKey)}
                                subtitle={t('memorySearchSettings.hints.model.promptBody')}
                                placeholder="default"
                                monospace
                                value={settings.hints.summarizerModelId}
                                onCommit={(draft) => {
                                    if (!draft) return settings.hints.summarizerModelId;
                                    void writeSettings({
                                        ...settings,
                                        hints: { ...settings.hints, summarizerModelId: draft },
                                    });
                                }}
                            />
                        </SettingAnchor>
                        <SettingAnchor setting={MEMORY_SETTINGS.settings.permissions}>
                            <SegmentedChoiceItem<SummarizerPermissionMode>
                                title={t(MEMORY_SETTINGS.settings.permissions.titleKey)}
                                options={summarizerPermissionOptions}
                                value={settings.hints.summarizerPermissionMode}
                                onChange={(mode) => {
                                    void writeSettings({
                                        ...settings,
                                        hints: { ...settings.hints, summarizerPermissionMode: mode },
                                    });
                                }}
                                testIDPrefix="memory-settings-summarizer-permissions"
                            />
                        </SettingAnchor>
                    </ItemGroup>

                    <MemorySettingsBudgetsSection settings={settings} writeSettings={writeSettings} />

                    <MemorySettingsPrivacySection settings={settings} writeSettings={writeSettings} />
                </>
            )}
        </ItemList>
    );
});
