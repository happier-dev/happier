import * as React from 'react';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { Icon } from '@/components/ui/icons/Icon';

import { MachineAdministrationTargetSelector } from '@/components/settings/machines/MachineAdministrationTargetSelector';
import { ItemList } from '@/components/ui/lists/ItemList';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Item } from '@/components/ui/lists/Item';
import { Switch } from '@/components/ui/forms/Switch';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
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
import { LlmTaskRunnerPicker } from '@/components/settings/llmTasks/LlmTaskRunnerPicker';
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

/** A blank value line: pending rows keep the height they will have, so the sheet does not grow when the values arrive. */
const PENDING_VALUE_LINE = '\u00A0';

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
    // Hints run on the machine this page manages; its Agents and Auto's pick come from there.
    const summarizerMachine = administrationTargetSelection.resolveExecutionTarget();

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
                <SettingsPageHeader description={t('memorySearchSettings.pagePurpose')} actions={machineChip} actionsPlacement="page" />
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

    // Until the machine answers, values are unknown, not unavailable: their rows keep their title and wait with a spinner.
    const pending = access === 'pending';
    const enabledSubtitle = access === 'ready' || pending
        ? t('memorySearchSettings.enabled.subtitle')
        : access === 'noMachine'
            ? t('memorySearchSettings.enabled.chooseMachine')
            : access === 'unreachable'
                ? t('memorySearchSettings.enabled.unreachable')
                : t('memorySearchSettings.enabled.updateRequired');

    return (
        <ItemList>
            <SettingsPageHeader description={t('memorySearchSettings.pagePurpose')} actions={machineChip} actionsPlacement="page" />
            <SettingSection section={MEMORY_SETTINGS.sectionRefs.localIndex} answersFor={access === 'ready' ? undefined : MEMORY_SECTIONS_AFTER_READY}>
                <ItemGroup
                    title={t('memorySearchSettings.enabled.sectionTitle')}
                    description={t('memorySearchSettings.enabled.footer')}
                >
                    <SettingRow
                        setting={MEMORY_SETTINGS.settings.enabled}
                        subtitle={enabledSubtitle}
                        subtitleLines={0}
                        // Until the machine answers, the row still says what it does and its switch holds its place, disabled.
                        rightElement={access === 'ready' ? (
                            <Switch
                                value={settings.enabled}
                                onValueChange={(value) => {
                                    void writeSettings({ ...settings, enabled: Boolean(value) });
                                }}
                            />
                        ) : pending ? (
                            <Switch value={false} disabled />
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
                                subtitle={pending ? PENDING_VALUE_LINE : statusSubtitle}
                                loading={pending}
                                showChevron={false}
                            />
                            <Item
                                title={t('memorySearchSettings.status.diskUsageTitle')}
                                subtitle={pending ? PENDING_VALUE_LINE : diskUsageSubtitle}
                                loading={pending}
                                showChevron={false}
                            />
                        </>
                    )}
                    {access !== 'noMachine' && showEmbeddingsStatus ? (
                        <>
                            <Item
                                title={t('memorySearchSettings.status.embeddingsTitle')}
                                subtitle={pending ? PENDING_VALUE_LINE : embeddingsStatusSubtitle}
                                loading={pending}
                                showChevron={false}
                            />
                            <Item
                                title={t('memorySearchSettings.status.embeddingsProviderTitle')}
                                subtitle={pending ? PENDING_VALUE_LINE : embeddingsProviderSubtitle}
                                loading={pending}
                                showChevron={false}
                            />
                            <Item
                                title={t('memorySearchSettings.status.embeddingsModelTitle')}
                                subtitle={pending ? PENDING_VALUE_LINE : embeddingsModelSubtitle}
                                loading={pending}
                                showChevron={false}
                            />
                        </>
                    ) : null}
                    {/* Which conversations are searched, and how, is the Search page's. No leading icon: it would reserve a gutter that indents every other title in this sheet (the same rule as the Search page's Memory search row). */}
                    <Item
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
                        description={t(settings.hints.summarizerRunner === null
                            ? 'newSession.selectAiBackendTitle'
                            : 'memorySearchSettings.hints.footer')}
                    >
                        <SettingAnchor settings={[MEMORY_SETTINGS.settings.summarizerBackend, MEMORY_SETTINGS.settings.summarizerModel, MEMORY_SETTINGS.settings.permissions]}>
                            <LlmTaskRunnerPicker
                                task="memory_hints"
                                value={settings.hints.summarizerRunner}
                                unsetMeansAuto={false}
                                onChange={(summarizerRunner) => {
                                    void writeSettings({ ...settings, hints: { ...settings.hints, summarizerRunner } });
                                }}
                                machineId={summarizerMachine?.machine.id ?? null}
                                serverId={summarizerMachine?.serverId ?? null}
                                engineFieldTitle={t(MEMORY_SETTINGS.settings.summarizerBackend.titleKey)}
                                permissionTitle={t(MEMORY_SETTINGS.settings.permissions.titleKey)}
                                testIDPrefix="memory-settings-summarizer"
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
