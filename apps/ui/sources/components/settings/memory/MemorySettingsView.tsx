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

import { fetchDaemonMemorySettings, writeDaemonMemorySettings } from '@/sync/domains/memory/fetchDaemonMemorySettings';
import { fetchDaemonMemoryStatus } from '@/sync/domains/memory/fetchDaemonMemoryStatus';
import { getDaemonMemoryStatusStateTranslationKey } from '@/sync/domains/memory/getDaemonMemoryStatusStateTranslationKey';
import { getDaemonMemoryEmbeddingsStatusTranslationKey } from '@/sync/domains/memory/getDaemonMemoryEmbeddingsStatusTranslationKey';
import { presentDaemonMemoryStatus } from '@/sync/domains/memory/presentDaemonMemoryStatus';
import { presentDaemonMemoryEmbeddingsStatus } from '@/sync/domains/memory/presentDaemonMemoryEmbeddingsStatus';
import { MACHINE_ADMINISTRATION_SELECTION_KEYS_V1 } from '@/sync/domains/machines/administration/selectionPreferences';
import {
    useMachineAdministrationTargetSelection,
    type FreshMachineAdministrationExecutionTargetV1,
} from '@/sync/domains/machines/administration/useTargetSelection';
import { isMachineAdministrationExecutionTargetCurrent } from '@/sync/domains/machines/administration/operationCurrentness';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';

import { DEFAULT_MEMORY_SETTINGS, type MemorySettingsV1 } from '@happier-dev/protocol/memory/memorySettings';
import type { MemoryStatusV1 } from '@happier-dev/protocol/memory/memoryStatus';
import { MemorySettingsArchivedRow } from './MemorySettingsArchivedSection';
import type { ArchivedMemoryStatusRequestState } from '@/sync/domains/memory/resolveArchivedMemoryEligibilityControl';
import { MemorySettingsBudgetsSection } from './MemorySettingsBudgetsSection';
import { MemorySettingsContentPolicySection } from './MemorySettingsContentPolicySection';
import { MemorySettingsCoverageRow } from './MemorySettingsCoverageSection';
import { MemorySettingsEmbeddingsSection } from './MemorySettingsEmbeddingsSection';
import { MemorySettingsIndexTelemetrySection } from './MemorySettingsIndexTelemetrySection';
import { MemorySettingsPrivacySection } from './MemorySettingsPrivacySection';
import { SettingsPageHeader } from '@/components/settings/shell/SettingsPageHeader';
import { SettingAnchor, SettingRow, SettingSection } from '@/components/settings/shell/SettingRow';
import { MEMORY_SETTINGS } from '@/components/settings/memory/memorySettings';

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

/**
 * Whether the managed machine's memory settings can be shown and changed. Every memory setting
 * lives on the machine, so without a reachable, current daemon the page says why instead of
 * presenting defaults as the machine's settings.
 */
type MachineSettingsAccess = 'noMachine' | 'pending' | 'ready' | 'updateRequired' | 'unreachable';

/** The outcome of the last settled settings read, for the machine it was read from. */
type SettledMachineRead = Readonly<{ targetKey: string; access: 'ready' | 'updateRequired' | 'unreachable' }>;

function resolveExecutionTargetKey(target: FreshMachineAdministrationExecutionTargetV1 | null): string | null {
    return target
        ? [target.target.serverIdentityId, target.target.machineId, target.serverId].join('\u0000')
        : null;
}

export const MemorySettingsView = React.memo(function MemorySettingsView() {
    const router = useRouter();
    const memorySearchEnabled = useFeatureEnabled('memory.search');
    const administrationTargetSelection = useMachineAdministrationTargetSelection(
        MACHINE_ADMINISTRATION_SELECTION_KEYS_V1.memory,
    );
    const executionTarget = administrationTargetSelection.resolveExecutionTarget();
    const executionTargetKey = resolveExecutionTargetKey(executionTarget);
    const hasExecutionTarget = executionTarget !== null;
    const isExecutionTargetCurrent = React.useCallback((
        target: FreshMachineAdministrationExecutionTargetV1,
    ) => {
        return isMachineAdministrationExecutionTargetCurrent({
            expectedTarget: target,
            resolveCurrentTarget: administrationTargetSelection.resolveExecutionTarget,
        });
    }, [administrationTargetSelection.resolveExecutionTarget]);

    const [settings, setSettings] = React.useState<MemorySettingsV1>(() => DEFAULT_MEMORY_SETTINGS);
    // Settings are writable only after a read settled for the machine being managed. Until then the
    // page holds defaults (or another machine's values), and a write would post them over the machine.
    const [settledRead, setSettledRead] = React.useState<SettledMachineRead | null>(null);
    const settledReadRef = React.useRef<SettledMachineRead | null>(null);
    const settleRead = React.useCallback((next: SettledMachineRead | null) => {
        settledReadRef.current = next;
        setSettledRead(next);
    }, []);
    const [memoryStatus, setMemoryStatus] = React.useState<MemoryStatusV1 | null>(null);
    const [memoryStatusRequestState, setMemoryStatusRequestState] = React.useState<ArchivedMemoryStatusRequestState>('unresolved');
    const [loading, setLoading] = React.useState(false);

    const fetchSettings = React.useCallback(async () => {
        if (!memorySearchEnabled) return;
        const target = administrationTargetSelection.resolveExecutionTarget();
        if (!target) return;
        setLoading(true);
        settleRead(null);
        setMemoryStatus(null);
        setMemoryStatusRequestState('loading');
        try {
            const [settingsResult, statusResult] = await Promise.all([
                fetchDaemonMemorySettings({
                    machineId: target.machine.id,
                    serverId: target.serverId,
                }).then((result) => ({ result, unreachable: false as const }))
                    .catch(() => ({ result: null, unreachable: true as const })),
                fetchDaemonMemoryStatus({
                    machineId: target.machine.id,
                    serverId: target.serverId,
                }).then((status) => ({ status, requestState: 'resolved' as const }))
                    .catch(() => ({ status: null, requestState: 'unreachable' as const })),
            ]);
            if (!isExecutionTargetCurrent(target)) return;
            const targetKey = resolveExecutionTargetKey(target)!;
            if (settingsResult.result) {
                setSettings(settingsResult.result.settings);
                settleRead({ targetKey, access: settingsResult.result.supported ? 'ready' : 'updateRequired' });
            } else {
                settleRead({ targetKey, access: 'unreachable' });
            }
            setMemoryStatus(statusResult.status);
            setMemoryStatusRequestState(statusResult.requestState);
        } finally {
            if (isExecutionTargetCurrent(target)) setLoading(false);
        }
    }, [administrationTargetSelection.resolveExecutionTarget, isExecutionTargetCurrent, memorySearchEnabled, settleRead]);

    React.useEffect(() => {
        if (!memorySearchEnabled) return;
        if (!hasExecutionTarget) {
            setSettings(DEFAULT_MEMORY_SETTINGS);
            settleRead(null);
            setMemoryStatus(null);
            setMemoryStatusRequestState('unresolved');
            setLoading(false);
            return;
        }
        void fetchSettings();
    }, [executionTargetKey, fetchSettings, hasExecutionTarget, memorySearchEnabled, settleRead]);

    const writeSettings = React.useCallback(async (next: MemorySettingsV1) => {
        if (!memorySearchEnabled) return;
        const target = administrationTargetSelection.resolveExecutionTarget();
        if (!target) return;
        const targetKey = resolveExecutionTargetKey(target)!;
        const read = settledReadRef.current;
        if (read?.targetKey !== targetKey || read.access !== 'ready') return;
        const result = await writeDaemonMemorySettings({
            machineId: target.machine.id,
            serverId: target.serverId,
            settings: next,
        });
        if (!isExecutionTargetCurrent(target)) return;
        setSettings(result.settings);
        if (!result.supported) {
            settleRead({ targetKey, access: 'updateRequired' });
            return;
        }
        setMemoryStatusRequestState('loading');
        const statusResult = await fetchDaemonMemoryStatus({
            machineId: target.machine.id,
            serverId: target.serverId,
        }).then((status) => ({ status, requestState: 'resolved' as const }))
            .catch(() => ({ status: null, requestState: 'unreachable' as const }));
        if (!isExecutionTargetCurrent(target)) return;
        setMemoryStatus(statusResult.status);
        setMemoryStatusRequestState(statusResult.requestState);
    }, [administrationTargetSelection.resolveExecutionTarget, isExecutionTargetCurrent, memorySearchEnabled, settleRead]);

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

    const access: MachineSettingsAccess = !hasExecutionTarget
        ? 'noMachine'
        : settledRead?.targetKey === executionTargetKey
            ? settledRead.access
            : 'pending';

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
                                    void writeSettings({ ...settings, indexMode: mode });
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
