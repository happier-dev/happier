import * as React from 'react';
import { Platform, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { useShallow } from 'zustand/react/shallow';
import { ClaudeSessionRetentionPolicyV1Schema, type ClaudeSessionRetentionReportV1 } from '@happier-dev/protocol';

import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { ExpandableItem } from '@/components/ui/lists/ExpandableItem';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { FlashList, useRecyclingState } from '@/components/ui/lists/flashListCompat/FlashListCompat';
import { Text, TextInput } from '@/components/ui/text/Text';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { providerSettingsFieldStyles } from '@/components/settings/providers/providerSettingsFieldStyles';
import { Typography } from '@/constants/Typography';
import { useSessionListRuntimeNowMs, useSessionListRuntimeWake } from '@/hooks/session/sessionListRuntimeClock';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { Modal } from '@/modal';
import { getStorage, storage, useSettingMutable } from '@/sync/domains/state/storage';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { resolveVisibleMachinesForActiveServerFromState } from '@/sync/store/domains/machines/resolveMachinesForActiveServerFromState';
import { t } from '@/text';
import { getMachineDisplayName, isMachineOnline, readMachineStatusNextRefreshAtMs } from '@/utils/sessions/machineUtils';

import {
    readRetentionMachineReport,
    retentionChangeNeedsConfirmation,
    retentionMachineStatus,
    sameRetentionPolicy,
    type RetentionMachineFacts,
    type RetentionMachineStatus,
    type RetentionPolicy,
} from './sessionRetentionPresentation';

const styles = StyleSheet.create(theme => ({
    custom: { gap: 12 },
    error: { ...Typography.default(), color: theme.colors.state.danger.foreground, fontSize: 13 },
    machineList: { height: 320 },
    targetList: { height: 240 },
}));

function asRecord(value: unknown): Readonly<Record<string, unknown>> {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Readonly<Record<string, unknown>> : {};
}

function machineFacts(machine: Machine): RetentionMachineFacts {
    const state = asRecord(machine.daemonState);
    return {
        pid: state.pid,
        startedAt: state.startedAt,
        cliVersion: machine.metadata?.happyCliVersion,
        source: state.providerSettingsSourceV1,
        report: asRecord(state.providerSettingsV1).claude,
    };
}

function statusLabel(status: RetentionMachineStatus): string {
    return t(`settingsProviders.sessionRetention.${status}`);
}

function reasonLabel(reason: string | undefined): string | undefined {
    switch (reason) {
        case 'invalid_settings': return t('settingsProviders.sessionRetention.invalidSettings');
        case 'settings_permission_denied': return t('settingsProviders.sessionRetention.permissionDenied');
        case 'managed_settings_unreadable': return t('settingsProviders.sessionRetention.managedUnreadable');
        case 'managed_settings_detected': return t('settingsProviders.sessionRetention.managed');
        case undefined: return undefined;
        default: return t('settingsProviders.sessionRetention.writeFailed');
    }
}

const RetentionMachineRow = React.memo(function RetentionMachineRow(props: Readonly<{
    machineId: string;
    policy: RetentionPolicy;
}>) {
    const machine = storage(state => state.machines[props.machineId] ?? null);
    const [expanded, setExpanded] = useRecyclingState(false, [props.machineId]);
    const nowMs = useSessionListRuntimeNowMs(Boolean(machine));
    useSessionListRuntimeWake(machine ? readMachineStatusNextRefreshAtMs(machine, nowMs) : null, Boolean(machine));
    if (!machine) return null;
    const facts = machineFacts(machine);
    const report = readRetentionMachineReport(facts);
    const statusKey = retentionMachineStatus(facts, props.policy);
    const status = statusLabel(statusKey);
    const genericFailure = !report && statusKey === 'error';
    const offline = !isMachineOnline(machine, nowMs);
    return (
        <ExpandableItem expanded={expanded} onExpandedChange={setExpanded}
            header={({ headerProps }) => (
                <Item {...headerProps} testID={`claude-session-retention-machine-${machine.id}`}
                    title={getMachineDisplayName(machine) ?? machine.id}
                    subtitle={offline ? `${status} · ${t('settingsProviders.sessionRetention.offline')}` : status}
                    showChevron={Boolean(report?.targets.length) || genericFailure} />
            )}>
            {expanded && genericFailure ? <Item title={t('settingsProviders.sessionRetention.writeFailed')} showChevron={false} /> : null}
            {expanded && report ? <View style={styles.targetList}>
                <FlashList data={report.targets} keyExtractor={(target: ClaudeSessionRetentionReportV1['targets'][number]) => target.id}
                    renderItem={({ item: target }: { item: ClaudeSessionRetentionReportV1['targets'][number] }) => {
                        const title = target.id === 'native' ? t('settingsProviders.sessionRetention.native')
                            : `${t(target.id.includes(':group:') ? 'settingsProviders.sessionRetention.group' : 'settingsProviders.sessionRetention.profile')} ${target.id}`;
                        const targetStatus = !sameRetentionPolicy(report.policy, props.policy) ? 'pending'
                            : target.status === 'unmanaged' ? 'unmanagedStatus' : target.status;
                        const configured = target.currentDays === null ? statusLabel(targetStatus)
                            : `${statusLabel(targetStatus)} · ${t('settingsProviders.sessionRetention.customDays')}: ${target.currentDays.toLocaleString()}`;
                        return <Item title={title} subtitle={reasonLabel(target.reason) ?? configured} showChevron={false} />;
                    }} />
            </View> : null}
        </ExpandableItem>
    );
});

function RetentionMachines(props: Readonly<{ machineIds: readonly string[]; policy: RetentionPolicy }>) {
    return <View style={styles.machineList}>
        <FlashList data={props.machineIds} keyExtractor={(id: string) => id}
            renderItem={({ item }: { item: string }) => <RetentionMachineRow machineId={item} policy={props.policy} />}
            ListEmptyComponent={<Item title={t('settingsProviders.sessionRetention.noMachines')} showChevron={false} />} />
    </View>;
}

export const ClaudeSessionRetentionSettings = React.memo(function ClaudeSessionRetentionSettings() {
    const [stored, setPolicy] = useSettingMutable('claudeSessionRetentionV1');
    const parsed = ClaudeSessionRetentionPolicyV1Schema.safeParse(stored);
    const policy = parsed.success ? parsed.data : null;
    useActiveServerSnapshot();
    const machineIds = storage(useShallow(state => resolveVisibleMachinesForActiveServerFromState(state).map(machine => machine.id)));
    const [menuOpen, setMenuOpen] = React.useState(false);
    const [custom, setCustom] = React.useState(false);
    const [draft, setDraft] = React.useState('');
    const [busy, setBusy] = React.useState(false);
    const [machinesExpanded, setMachinesExpanded] = React.useState(false);
    const selectedId = policy === null ? 'unmanaged' : policy.mode === 'providerDefault' ? 'providerDefault'
        : policy.days === 365 ? 'year' : policy.days === 36500 ? 'century' : 'custom';
    const customVisible = custom || selectedId === 'custom';
    const currentDraft = custom ? draft : policy?.mode === 'days' ? String(policy.days) : draft;
    const parsedDraft = ClaudeSessionRetentionPolicyV1Schema.safeParse({ mode: 'days', days: Number(currentDraft) });
    const draftValid = /^\d+$/.test(currentDraft.trim()) && parsedDraft.success;

    const apply = async (next: RetentionPolicy) => {
        if (busy || sameRetentionPolicy(next, policy)) return;
        setBusy(true);
        try {
            const machines = resolveVisibleMachinesForActiveServerFromState(getStorage().getState()).map(machineFacts);
            if (retentionChangeNeedsConfirmation(next, policy, machines)
                && !await Modal.confirm(t('settingsProviders.sessionRetention.confirmTitle'), t('settingsProviders.sessionRetention.confirmBody'), {
                    confirmText: t('settingsProviders.sessionRetention.confirmAction'),
                    cancelText: t('common.cancel'),
                    destructive: true,
                })) return;
            setPolicy(next);
            setCustom(false);
        } finally { setBusy(false); }
    };

    return <ItemGroup title={t('settingsProviders.sessionRetention.title')} footer={t('settingsProviders.sessionRetention.footer')}>
        <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen} selectedId={custom ? 'custom' : selectedId}
            itemTrigger={{ title: t('settingsProviders.sessionRetention.policy'), itemProps: { testID: 'claude-session-retention-policy', disabled: busy },
                detailFormatter: item => selectedId === 'custom' && !custom && policy?.mode === 'days'
                    ? `${policy.days.toLocaleString()} · ${t('settingsProviders.sessionRetention.custom')}` : item?.title ?? null }}
            items={[
                { id: 'unmanaged', title: t('settingsProviders.sessionRetention.unmanaged'), subtitle: t('settingsProviders.sessionRetention.unmanagedHint') },
                { id: 'providerDefault', title: t('settingsProviders.sessionRetention.providerDefault'), subtitle: t('settingsProviders.sessionRetention.providerDefaultHint') },
                { id: 'year', title: t('settingsProviders.sessionRetention.year') },
                { id: 'century', title: t('settingsProviders.sessionRetention.century') },
                { id: 'custom', title: t('settingsProviders.sessionRetention.custom') },
            ]}
            onSelect={async id => {
                if (busy) return;
                setMenuOpen(false);
                if (id === 'custom') {
                    setDraft(policy?.mode === 'days' ? String(policy.days) : '');
                    setCustom(true);
                } else if (id === 'unmanaged') await apply(null);
                else if (id === 'providerDefault') await apply({ mode: 'providerDefault' });
                else if (id === 'year' || id === 'century') await apply({ mode: 'days', days: id === 'year' ? 365 : 36500 });
            }} />
        {customVisible ? <View style={[providerSettingsFieldStyles.inputContainer, styles.custom]}>
            <Text style={providerSettingsFieldStyles.fieldLabel}>{t('settingsProviders.sessionRetention.customDays')}</Text>
            <TextInput testID="claude-session-retention-custom-days" value={currentDraft}
                accessibilityLabel={t('settingsProviders.sessionRetention.customDays')}
                style={providerSettingsFieldStyles.textInput} keyboardType={Platform.select({ ios: 'number-pad', default: 'numeric' })}
                onChangeText={value => { setCustom(true); setDraft(value); }} autoCorrect={false} autoCapitalize="none" />
            {currentDraft.trim() && !draftValid ? <Text style={styles.error}>{t('settingsProviders.sessionRetention.invalidDays')}</Text> : null}
            <RoundButton testID="claude-session-retention-custom-apply" title={t('settingsProviders.sessionRetention.confirmAction')} size="small"
                disabled={!draftValid || busy} loading={busy} action={async () => { if (parsedDraft.success && draftValid) await apply(parsedDraft.data); }} />
        </View> : null}
        <ExpandableItem expanded={machinesExpanded} onExpandedChange={setMachinesExpanded}
            header={({ headerProps }) => <Item {...headerProps} testID="claude-session-retention-machines"
                title={t('settingsProviders.sessionRetention.machines')} detail={String(machineIds.length)} showChevron /> }>
            {machinesExpanded ? <RetentionMachines machineIds={machineIds} policy={policy} /> : null}
        </ExpandableItem>
    </ItemGroup>;
});
