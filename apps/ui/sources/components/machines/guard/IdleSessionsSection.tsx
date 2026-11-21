import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';
import type { MachineGuardPolicyPatchV1, MachineGuardPolicyV1 } from '@happier-dev/protocol/machines/guard/guardPolicyV1';
import type { MachineGuardViewV1 } from '@happier-dev/protocol/machines/guard/guardRpcV1';

import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { PAGE_LIST_METRICS } from '@/components/ui/lists/pageListMetrics';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

import { MachineAgentMark } from '@/components/machines/agents/MachineAgentMark';
import { describeMachineTerminalLabel } from '@/components/machines/terminal/machineTerminalTitle';

import { GuardCountdown } from './GuardCountdown';
import { GuardInsetFigure, GuardInsetList, GuardInsetRow, useGuardInsetFigureStyle } from './GuardInsetRows';
import { NeverTouchedLine } from './GuardLadder';
import {
    IDLE_AFTER_PRESETS_MS, IDLE_LEAD_PRESETS_MS, describeIdleSessionsRow, formatGuardDuration, guardKeepReasonLabel,
    orderIdleSessions, parseCustomGuardMinutes,
} from './guardPresentation';
import { GuardSelectRow, GuardSwitchRow } from './guardRows';
import type { GuardRowId } from './useGuardPolicy';

type IdleRule = MachineGuardPolicyV1['idleSessions'];
type Failure = (row: GuardRowId) => string | null;

function minutesCustom(value: number) {
    return { title: t('machineGuard.memory.customMinutes.title'), body: t('machineGuard.memory.customMinutes.body'),
        invalid: t('machineGuard.memory.customMinutes.invalid'), defaultValue: `${value / 60_000} min`, parse: parseCustomGuardMinutes };
}

/**
 * Idle sessions (lab `rg` G2 / G3-1): one switch, the delay and the warning lead (R39), then the
 * present — who would stop and when, who is kept and why — and the one promise of what is never
 * stopped. The list is the daemon's, so the policy explains itself with real sessions.
 */
export const IdleSessionsSection = React.memo(function IdleSessionsSection(props: Readonly<{
    machineName: string;
    machineId: string;
    serverId: string;
    rule: IdleRule;
    idle: MachineGuardViewV1['idle'] | null;
    editable: boolean;
    failure: Failure;
    /** A saved value the machine hasn't applied yet. */
    awaiting: Failure;
    save: (row: GuardRowId, patch: MachineGuardPolicyPatchV1) => void;
}>) {
    const { rule, save, editable, failure, awaiting } = props;
    const idle = props.idle ? orderIdleSessions(props.idle) : [];
    return (
        <ItemGroup title={t('machineGuard.idle.title')} description={t('machineGuard.idle.description')}>
            <GuardSwitchRow testID="machine-guard-idle" title={t('machineGuard.idle.switchTitle')} subtitle={describeIdleSessionsRow(rule, props.idle)}
                value={rule.enabled} editable={editable} failed={failure('idle')} awaiting={awaiting('idle')} onToggle={enabled => save('idle', { idleSessions: { enabled } })} />
            {rule.enabled ? (
                <GuardSelectRow testID="machine-guard-idle-after" title={t('machineGuard.idle.afterTitle')} subtitle={t('machineGuard.idle.afterHelp')}
                    label={t('machineGuard.idle.afterTitle')} value={rule.afterMs} format={formatGuardDuration} presets={IDLE_AFTER_PRESETS_MS}
                    custom={minutesCustom(rule.afterMs)} editable={editable} failed={failure('idleAfter')} awaiting={awaiting('idleAfter')}
                    onChange={afterMs => save('idleAfter', { idleSessions: afterMs > rule.warnBeforeMs ? { afterMs } : { afterMs, warnBeforeMs: Math.min(rule.warnBeforeMs, afterMs - 60_000) } })} />
            ) : null}
            {rule.enabled ? (
                <GuardSelectRow testID="machine-guard-idle-lead" title={t('machineGuard.idle.leadTitle')} subtitle={t('machineGuard.idle.leadHelp')}
                    label={t('machineGuard.idle.leadTitle')} value={rule.warnBeforeMs} format={formatGuardDuration}
                    presets={IDLE_LEAD_PRESETS_MS.filter(lead => lead < rule.afterMs)}
                    custom={{ ...minutesCustom(rule.warnBeforeMs), parse: raw => { const ms = parseCustomGuardMinutes(raw); return ms !== null && ms < rule.afterMs ? ms : null; } }}
                    editable={editable} failed={failure('idleLead')} awaiting={awaiting('idleLead')} onChange={warnBeforeMs => save('idleLead', { idleSessions: { warnBeforeMs } })} />
            ) : null}
            {rule.enabled && idle.length > 0 ? (
                <View testID="machine-guard-idle-now">
                    <View style={styles.caption}><Text style={styles.captionText}>{t('machineGuard.idle.rightNow', { machine: props.machineName })}</Text></View>
                    <GuardInsetList>
                        {idle.map((entry, index) => (
                            <IdleRow key={entry.sessionRef} index={index} title={entry.title ?? t('session.untitled')} agentId={entry.agentId}
                                machineId={props.machineId} serverId={props.serverId}
                                qualifier={[t('machineGuard.idle.idleFor', { duration: formatGuardDuration(entry.idleMs) }),
                                    ...(entry.status === 'kept' && entry.reason ? [guardKeepReasonLabel(entry.reason)] : [])].join(' · ')}
                                trailing={entry.status === 'stops_at' && entry.stopAt !== undefined ? { kind: 'countdown', stopAt: entry.stopAt }
                                    : entry.status === 'kept' ? { kind: 'kept' } : { kind: 'none' }} />
                        ))}
                    </GuardInsetList>
                </View>
            ) : null}
            {rule.enabled ? <NeverTouchedLine text={t('machineGuard.idle.onlyFinished')} /> : null}
        </ItemGroup>
    );
});

/**
 * Idle terminals (R40, off by default): the same anatomy as idle sessions — switch, delay, warning lead —
 * and the terminals that would close. Until the machine lists them (lane 50a wave 3), the rule shows
 * without a list.
 */
export const IdleTerminalsSection = React.memo(function IdleTerminalsSection(props: Readonly<{
    machineName: string;
    machineId: string;
    serverId: string;
    rule: IdleRule;
    terminals: MachineGuardViewV1['idleTerminals'] | null;
    editable: boolean;
    failure: Failure;
    /** A saved value the machine hasn't applied yet. */
    awaiting: Failure;
    save: (row: GuardRowId, patch: MachineGuardPolicyPatchV1) => void;
}>) {
    const { rule, save, editable, failure, awaiting } = props;
    const terminals = props.terminals ?? [];
    return (
        <ItemGroup title={t('machineGuard.terminals.title')} description={t('machineGuard.terminals.description')}>
            <GuardSwitchRow testID="machine-guard-terminals" title={t('machineGuard.terminals.switchTitle')}
                subtitle={rule.enabled ? t('machineGuard.terminals.onHelp', { lead: formatGuardDuration(rule.warnBeforeMs) }) : t('machineGuard.terminals.off')}
                value={rule.enabled} editable={editable} failed={failure('terminals')} awaiting={awaiting('terminals')} onToggle={enabled => save('terminals', { idleTerminals: { enabled } })} />
            {rule.enabled ? (
                <GuardSelectRow testID="machine-guard-terminals-after" title={t('machineGuard.terminals.afterTitle')} subtitle={t('machineGuard.terminals.afterHelp')}
                    label={t('machineGuard.terminals.afterTitle')} value={rule.afterMs} format={formatGuardDuration} presets={IDLE_AFTER_PRESETS_MS}
                    custom={minutesCustom(rule.afterMs)} editable={editable} failed={failure('terminalsAfter')} awaiting={awaiting('terminalsAfter')}
                    onChange={afterMs => save('terminalsAfter', { idleTerminals: afterMs > rule.warnBeforeMs ? { afterMs } : { afterMs, warnBeforeMs: Math.min(rule.warnBeforeMs, afterMs - 60_000) } })} />
            ) : null}
            {rule.enabled ? (
                <GuardSelectRow testID="machine-guard-terminals-lead" title={t('machineGuard.terminals.leadTitle')} subtitle={t('machineGuard.terminals.leadHelp')}
                    label={t('machineGuard.terminals.leadTitle')} value={rule.warnBeforeMs} format={formatGuardDuration}
                    presets={IDLE_LEAD_PRESETS_MS.filter(lead => lead < rule.afterMs)}
                    custom={{ ...minutesCustom(rule.warnBeforeMs), parse: raw => { const ms = parseCustomGuardMinutes(raw); return ms !== null && ms < rule.afterMs ? ms : null; } }}
                    editable={editable} failed={failure('terminalsLead')} awaiting={awaiting('terminalsLead')} onChange={warnBeforeMs => save('terminalsLead', { idleTerminals: { warnBeforeMs } })} />
            ) : null}
            {rule.enabled && terminals.length > 0 ? (
                <GuardInsetList testID="machine-guard-terminals-now">
                    {terminals.map((terminal, index) => (
                        <IdleRow key={terminal.terminalKey} index={index} title={describeMachineTerminalLabel(terminal, props.machineName)} machineId={props.machineId} serverId={props.serverId}
                            qualifier={[t('machineGuard.idle.idleFor', { duration: formatGuardDuration(terminal.idleMs) }),
                                ...terminal.reasons.filter(reason => reason !== 'not_yet').map(reason => t(`machineGuard.terminals.reasons.${reason}`))].join(' · ')}
                            trailing={terminal.status === 'stops_at' && terminal.stopAt !== undefined ? { kind: 'countdown', stopAt: terminal.stopAt, closes: true }
                                : terminal.status === 'eligible' ? { kind: 'text', text: t('machineGuard.terminals.canClose') } : { kind: 'none' }} />
                    ))}
                </GuardInsetList>
            ) : null}
        </ItemGroup>
    );
});

type IdleTrailing = Readonly<{ kind: 'countdown'; stopAt: number; closes?: boolean }> | Readonly<{ kind: 'kept' }>
    | Readonly<{ kind: 'text'; text: string }> | Readonly<{ kind: 'none' }>;

function IdleRow(props: Readonly<{ index: number; agentId?: string; machineId: string; serverId: string; title: string; qualifier: string; trailing: IdleTrailing }>) {
    const kept = props.trailing.kind === 'kept';
    const figure = useGuardInsetFigureStyle('strong');
    return (
        <GuardInsetRow first={props.index === 0} quiet={kept}
            leading={props.agentId ? <MachineAgentMark agentId={props.agentId} machineId={props.machineId} serverId={props.serverId} size={14} /> : undefined}
            label={props.title} qualifier={props.qualifier}
            trailing={props.trailing.kind === 'countdown' ? (
                <GuardCountdown stopAt={props.trailing.stopAt} style={figure}
                    format={duration => props.trailing.kind === 'countdown' && props.trailing.closes
                        ? t('machineGuard.terminals.closesIn', { duration }) : t('machineGuard.idle.stopsIn', { duration })} />
            ) : props.trailing.kind === 'kept' ? (
                <GuardInsetFigure tone="quiet">{t('machineGuard.idle.kept')}</GuardInsetFigure>
            ) : props.trailing.kind === 'text' ? (
                <GuardInsetFigure>{props.trailing.text}</GuardInsetFigure>
            ) : null} />
    );
}

const styles = StyleSheet.create((theme) => ({
    caption: {
        paddingHorizontal: PAGE_LIST_METRICS.rowPaddingHorizontalPx,
        paddingTop: theme.space.s12,
        paddingBottom: theme.space.s6,
    },
    captionText: {
        ...Typography.default(),
        ...happierPageTextMetrics('meta'),
        color: theme.colors.text.secondary,
    },
}));
