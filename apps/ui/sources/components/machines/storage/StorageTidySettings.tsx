import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import type { MachineResourcesPolicyPatchV1, MachineResourcesPolicyV1 } from '@happier-dev/protocol/machines/resources/machineResourcesPolicyV1';

import { PolicyValueSelect } from '@/components/machines/policy/PolicyValueSelect';
import { createWeeklyStorageReviewWorkflowSeed } from '@/components/automations/storage/weeklyStorageReviewTemplate';
import { useAutomationsSupport } from '@/hooks/server/useAutomationsSupport';
import { Icon } from '@/components/ui/icons/Icon';
import { DiskThresholdSelect } from '@/components/machines/vitals/MachineAlertsPage';
import { Switch } from '@/components/ui/forms/Switch';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { Modal } from '@/modal';
import { useMachineResourcesPolicy } from '@/sync/domains/machines/resources/useMachineResourcesPolicy';
import { storeWorkflowDefinitionDraftSeed } from '@/sync/domains/workflows/workflowDefinitionDraftSeed';
import { t } from '@/text';
import { fireAndForget } from '@/utils/system/fireAndForget';

import {
    FOREVER_ID,
    LOG_RETENTION_PRESET_DAYS,
    SCAN_TIME_PRESETS,
    SUGGEST_UNUSED_PRESET_DAYS,
    TRASH_EMPTY_PRESET_DAYS,
    WEEKDAYS,
    formatStorageDays,
    formatStorageWeekday,
    parseCustomScanTime,
    parseCustomStorageDays,
} from './storageTidyChoices';
import type { StorageSummary } from './storageViewModel';

type RowId = 'scan' | 'disk' | 'logs' | 'trash' | 'suggest';
type StoragePatch = NonNullable<MachineResourcesPolicyPatchV1['storage']>;
type DiskPatch = NonNullable<NonNullable<MachineResourcesPolicyPatchV1['alerts']>['disk']>;

const DEFAULT_SCAN = { weekday: 0, time: '03:00', onlyOnPower: true } as const;

/**
 * Keeping it tidy (plan 40 STO-21/22, lab `rs` SET / SETp): the rows that close the Storage tab, each
 * saying its current state; anything that would act on its own is off until turned on, and turning a
 * switch on opens its rule in place as a sentence of selects. Every value is the machine's one
 * resources policy (`storage`, and plan 20's `alerts.disk` for the disk alert) through
 * `machines.resources.policy.set`; continuous values end with Custom… (R43). Recipients and an offline
 * machine read the last-known values without changing them.
 */
export const StorageTidySettings = React.memo(function StorageTidySettings(props: Readonly<{
    serverId: string;
    machineId: string;
    machineName: string;
    summary: StorageSummary;
    /** Opens Protected folders (lab `rs` SET 3). */
    onOpenProtected?: () => void;
}>) {
    const router = useRouter();
    const automationsSupport = useAutomationsSupport();
    const policyState = useMachineResourcesPolicy({ serverId: props.serverId, machineId: props.machineId });
    const [pending, setPending] = React.useState<Readonly<{ row: RowId; policy: MachineResourcesPolicyV1 }> | null>(null);
    const [failed, setFailed] = React.useState<RowId | null>(null);
    const policy = pending?.policy ?? policyState.policy;
    const { set } = policyState;
    const save = React.useCallback((row: RowId, patch: MachineResourcesPolicyPatchV1) => {
        if (!policy) return;
        // The row shows the choice at once; the machine's answer decides what stays.
        setPending({ row, policy: applyPatch(policy, patch) });
        setFailed(null);
        fireAndForget((async () => {
            const result = await set(patch);
            setPending(null);
            if (!result.saved) setFailed(row);
        })(), { tag: 'StorageTidySettings.save' });
    }, [policy, set]);
    const saveStorage = React.useCallback((row: RowId, patch: StoragePatch) => save(row, { storage: patch }), [save]);
    const saveDisk = React.useCallback((patch: DiskPatch) => save('disk', { alerts: { disk: patch } }), [save]);
    const largestVolumeBytes = React.useCallback(
        () => props.summary.volumes.reduce<number | null>((max, volume) => Math.max(max ?? 0, volume.totalBytes), null),
        [props.summary.volumes]);

    if (!policy) return null;
    const editable = policyState.editable && pending === null;
    const readOnlyNote = policyState.readOnlyReason === 'offline' ? t('machineStorage.tidy.readOnlyOffline', { machine: props.machineName })
        : policyState.readOnlyReason === 'not_custodian' ? t('machineStorage.tidy.readOnlyNotCustodian', { machine: props.machineName }) : null;
    const storage = policy.storage;
    const disk = policy.alerts.disk;

    return (
        <ItemGroup title={t('machineStorage.tidy.title')} description={readOnlyNote ?? t('machineStorage.tidy.description')}>
            <SwitchRuleRow testID="machine-storage-tidy-scan" title={t('machineStorage.tidy.scan.title')}
                subtitle={failed === 'scan' ? t('machineStorage.tidy.saveFailed') : storage.scheduledScan ? t('machineStorage.tidy.scan.on', { machine: props.machineName }) : t('machineStorage.tidy.scan.off')}
                failed={failed === 'scan'} value={storage.scheduledScan !== null} editable={editable}
                onToggle={on => saveStorage('scan', { scheduledScan: on ? DEFAULT_SCAN : null })}>
                {storage.scheduledScan ? (
                    <>
                        <SentenceText>{t('machineStorage.tidy.scan.every')}</SentenceText>
                        <PolicyValueSelect testID="machine-storage-tidy-scan-weekday" label={t('machineStorage.tidy.scan.weekdayLabel')}
                            value={formatStorageWeekday(storage.scheduledScan.weekday)} disabled={!editable} invalid={failed === 'scan'}
                            choices={WEEKDAYS.map(weekday => ({ id: String(weekday), title: formatStorageWeekday(weekday) }))}
                            selectedId={String(storage.scheduledScan.weekday)}
                            onSelect={id => saveStorage('scan', { scheduledScan: { ...storage.scheduledScan!, weekday: Number(id) } })} />
                        <SentenceText>{t('machineStorage.tidy.scan.at')}</SentenceText>
                        <ScanTimeSelect time={storage.scheduledScan.time} disabled={!editable} invalid={failed === 'scan'}
                            onChange={time => saveStorage('scan', { scheduledScan: { ...storage.scheduledScan!, time } })} />
                    </>
                ) : null}
            </SwitchRuleRow>
            <SwitchRuleRow testID="machine-storage-tidy-disk" title={t('machineStorage.tidy.disk.title')}
                subtitle={failed === 'disk' ? t('machineStorage.tidy.saveFailed') : disk.enabled ? t('machineStorage.tidy.disk.on') : t('machineStorage.tidy.disk.off')}
                failed={failed === 'disk'} value={disk.enabled} editable={editable} onToggle={enabled => saveDisk({ enabled })}>
                {disk.enabled ? (
                    <>
                        <SentenceText>{t('machineStorage.tidy.disk.lead')}</SentenceText>
                        <DiskThresholdSelect threshold={disk.threshold} largestVolumeBytes={largestVolumeBytes} disabled={!editable}
                            invalid={failed === 'disk'} onChange={threshold => saveDisk({ threshold })} />
                        <SentenceText>{t('machineStorage.tidy.disk.tail')}</SentenceText>
                    </>
                ) : null}
            </SwitchRuleRow>
            {props.onOpenProtected ? (
                <Item testID="machine-storage-tidy-protected" title={t('machineStorage.protectedFolders.title')}
                    subtitle={t('machineStorage.protectedFolders.row', { count: storage.protectedFolders.length })}
                    icon={<Icon name="lock" size={18} />} onPress={props.onOpenProtected} />
            ) : null}
            <DaysRow testID="machine-storage-tidy-logs" title={t('machineStorage.tidy.logs.title')} subtitle={t('machineStorage.tidy.logs.subtitle')}
                label={t('machineStorage.tidy.logs.label')} customTitle={t('machineStorage.tidy.logs.customTitle')}
                presets={LOG_RETENTION_PRESET_DAYS} days={storage.logRetentionDays} foreverLabel={t('machineStorage.tidy.logs.forever')}
                format={formatStorageDays} editable={editable} failed={failed === 'logs'}
                onChange={days => saveStorage('logs', { logRetentionDays: days })} />
            <DaysRow testID="machine-storage-tidy-trash" title={t('machineStorage.tidy.trash.title')} subtitle={t('machineStorage.tidy.trash.subtitle')}
                label={t('machineStorage.tidy.trash.label')} customTitle={t('machineStorage.tidy.trash.customTitle')}
                presets={TRASH_EMPTY_PRESET_DAYS} days={storage.trashEmptyAfterDays} foreverLabel={t('machineStorage.tidy.trash.never')}
                format={days => t('machineStorage.tidy.trash.after', { days })} editable={editable} failed={failed === 'trash'}
                onChange={days => saveStorage('trash', { trashEmptyAfterDays: days })} />
            <DaysRow testID="machine-storage-tidy-suggest" title={t('machineStorage.tidy.suggest.title')} subtitle={t('machineStorage.tidy.suggest.subtitle')}
                label={t('machineStorage.tidy.suggest.label')} customTitle={t('machineStorage.tidy.suggest.customTitle')}
                presets={SUGGEST_UNUSED_PRESET_DAYS} days={storage.suggestUnusedAfterDays} foreverLabel={null}
                format={formatStorageDays} editable={editable} failed={failed === 'suggest'}
                onChange={days => { if (days !== null) saveStorage('suggest', { suggestUnusedAfterDays: days }); }} />
            {automationsSupport.enabled ? <Item testID="machine-storage-tidy-weekly-review"
                title={t('machineStorage.tidy.weeklyReview.title')} subtitle={t('machineStorage.tidy.weeklyReview.subtitle')}
                icon={<Icon name="timer" size={20} />}
                onPress={() => {
                    const definitionDraftSeedId = storeWorkflowDefinitionDraftSeed(createWeeklyStorageReviewWorkflowSeed({
                        name: t('machineStorage.tidy.weeklyReview.title'),
                    }));
                    router.push({ pathname: '/workflows/new', params: { definitionDraftSeedId } } as never);
                }} /> : null}
        </ItemGroup>
    );
});

/** The policy as it will read once a patch lands (the same field merge the policy owner applies). */
function applyPatch(policy: MachineResourcesPolicyV1, patch: MachineResourcesPolicyPatchV1): MachineResourcesPolicyV1 {
    return {
        ...policy,
        storage: { ...policy.storage, ...patch.storage },
        alerts: patch.alerts?.disk ? { ...policy.alerts, disk: { ...policy.alerts.disk, ...patch.alerts.disk } } : policy.alerts,
    };
}

function SwitchRuleRow(props: Readonly<{
    testID: string;
    title: string;
    subtitle: string;
    failed: boolean;
    value: boolean;
    editable: boolean;
    onToggle: (value: boolean) => void;
    showDivider?: boolean;
    children: React.ReactNode;
}>) {
    const { theme } = useUnistyles();
    return (
        <Item testID={props.testID} title={props.title} subtitle={props.subtitle} mode="info" showDivider={props.showDivider}
            subtitleStyle={props.failed ? { color: theme.colors.state.danger.textForeground } : undefined}
            rightElement={<Switch testID={`${props.testID}-switch`} value={props.value} disabled={!props.editable}
                accessibilityLabel={props.title} onValueChange={props.onToggle} />}
            bottomElement={props.children ? <View testID={`${props.testID}-rule`} style={styles.sentence}>{props.children}</View> : undefined} />
    );
}

function SentenceText(props: Readonly<{ children: string }>) {
    return <Text style={styles.sentenceText}>{props.children}</Text>;
}

/** A days value as a select: presets, Forever/Never when the field has one, then Custom…. */
function DaysRow(props: Readonly<{
    testID: string;
    title: string;
    subtitle: string;
    label: string;
    customTitle: string;
    presets: readonly number[];
    days: number | null;
    /** The `null` choice's name, when the field has one. */
    foreverLabel: string | null;
    format: (days: number) => string;
    editable: boolean;
    failed: boolean;
    onChange: (days: number | null) => void;
    showDivider?: boolean;
}>) {
    const { theme } = useUnistyles();
    const { onChange, customTitle, days } = props;
    const choices = React.useMemo(() => [
        ...props.presets.map(value => ({ id: String(value), title: props.format(value) })),
        ...(props.foreverLabel ? [{ id: FOREVER_ID, title: props.foreverLabel }] : []),
    ], [props]);
    const current = days === null ? FOREVER_ID : String(days);
    const custom = React.useCallback(() => {
        fireAndForget((async () => {
            const raw = await Modal.prompt(customTitle, t('machineStorage.tidy.customDays.body'), {
                defaultValue: days === null ? '' : `${days} d`,
                confirmText: t('common.save'),
            });
            if (raw === null) return;
            const value = parseCustomStorageDays(raw);
            if (value === null) {
                Modal.alert(customTitle, t('machineStorage.tidy.customDays.invalid'));
                return;
            }
            onChange(value);
        })(), { tag: 'StorageTidySettings.customDays' });
    }, [customTitle, days, onChange]);
    return (
        <Item testID={props.testID} title={props.title} subtitle={props.failed ? t('machineStorage.tidy.saveFailed') : props.subtitle}
            subtitleStyle={props.failed ? { color: theme.colors.state.danger.textForeground } : undefined}
            // A select follows the shared row rule: beside its label on a wide row, beneath it on a phone.
            mode="info" showDivider={props.showDivider} accessoryLayout="adaptive"
            rightElement={
                <PolicyValueSelect testID={`${props.testID}-select`} label={props.label}
                    value={days === null ? (props.foreverLabel ?? '') : props.format(days)} choices={choices}
                    selectedId={choices.some(choice => choice.id === current) ? current : null}
                    onSelect={id => onChange(id === FOREVER_ID ? null : Number(id))} onCustom={custom}
                    disabled={!props.editable} invalid={props.failed} />
            } />
    );
}

function ScanTimeSelect(props: Readonly<{ time: string; disabled: boolean; invalid: boolean; onChange: (time: string) => void }>) {
    const { onChange, time } = props;
    const choices = React.useMemo(() => SCAN_TIME_PRESETS.map(value => ({ id: value, title: value })), []);
    const custom = React.useCallback(() => {
        fireAndForget((async () => {
            const raw = await Modal.prompt(t('machineStorage.tidy.scan.customTime.title'), t('machineStorage.tidy.scan.customTime.body'), {
                defaultValue: time,
                confirmText: t('common.save'),
            });
            if (raw === null) return;
            const value = parseCustomScanTime(raw);
            if (value === null) {
                Modal.alert(t('machineStorage.tidy.scan.customTime.title'), t('machineStorage.tidy.scan.customTime.invalid'));
                return;
            }
            onChange(value);
        })(), { tag: 'StorageTidySettings.customTime' });
    }, [onChange, time]);
    return (
        <PolicyValueSelect testID="machine-storage-tidy-scan-time" label={t('machineStorage.tidy.scan.timeLabel')} value={time}
            choices={choices} selectedId={choices.some(choice => choice.id === time) ? time : null}
            onSelect={onChange} onCustom={custom} disabled={props.disabled} invalid={props.invalid} />
    );
}

const styles = StyleSheet.create((theme) => ({
    sentence: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'center',
        columnGap: theme.space.s8,
        rowGap: theme.space.s6,
        paddingTop: theme.space.s8,
    },
    sentenceText: {
        ...Typography.variant('meta'),
        color: theme.colors.text.secondary,
    },
}));
