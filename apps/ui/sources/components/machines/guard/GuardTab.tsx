import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';
import { ItemLoadStateRows } from '@/components/ui/lists/ItemLoadStateRows';

import type { MachinePageTabBodyProps } from '@/components/machines/page/machinePageTabQuery';
import { useMachineTabFacts } from '@/components/machines/page/useMachineTabFacts';
import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';
import { Icon } from '@/components/ui/icons/Icon';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { DEFAULT_MACHINE_GUARD_ACTIVITY_QUERY } from '@/sync/domains/machines/guard/machineGuardRpc';
import { useMachineGuardActivity, useMachineGuardView } from '@/sync/domains/machines/guard/useMachineGuardView';
import { t } from '@/text';
import { formatAsOfTime } from '@/utils/time/formatAsOfTime';

import { MachineActivityPage } from './activity/MachineActivityPage';
import { MachineActivityRow } from './activity/MachineActivityRow';
import { useGuardWayBack } from './activity/useGuardWayBack';
import { GuardPhoneFreshness } from './GuardBarAccessory';
import { guardRowAwaitsMachine } from './guardPresentation';
import { IdleSessionsSection, IdleTerminalsSection } from './IdleSessionsSection';
import { LeftBehindSection, LimitsAndPowerSection } from './LeftBehindAndLimitsSections';
import { MemoryGuardSection } from './MemoryGuardSection';
import { AgentToolsSection } from './AgentToolsSection';
import { useGuardPolicy, type GuardRowId } from './useGuardPolicy';

const RECENT_ACTIVITY = 3;

/**
 * The machine page's Guard tab (plan 50 §5.4, lab `rg` G1–G5, G8, G9): what Happier may stop on the
 * machine by itself — memory guard and its live ladder, idle sessions and terminals, left-behind
 * processes, limits and power — and what it did (Activity, with a way back). The rules are the
 * machine's one resources policy; what would happen, what is happening and what happened are the
 * daemon's Guard view, live while shown. Same sections in every state: offline and shared machines
 * read the rules without changing them, an older Happier says what it would need.
 */
export const GuardTab = React.memo(function GuardTab(props: MachinePageTabBodyProps) {
    const params = props.params.id === 'guard' ? props.params : null;
    const { setParams } = props;
    const openActivity = React.useCallback(() => setParams({ id: 'guard', page: 'activity' }), [setParams]);
    const back = React.useCallback(() => setParams({ id: 'guard' }), [setParams]);
    if (params?.page === 'activity') {
        return <MachineActivityPage serverId={props.serverId} machineId={props.machineId} machineName={props.machineName} onBack={back}
            barAccessoryShown={props.barAccessoryShown === true} />;
    }
    return <GuardRules serverId={props.serverId} machineId={props.machineId} machineName={props.machineName} onOpenActivity={openActivity}
        barAccessoryShown={props.barAccessoryShown === true} />;
});

function GuardRules(props: Readonly<{ serverId: string; machineId: string; machineName: string; onOpenActivity: () => void; barAccessoryShown: boolean }>) {
    const facts = useMachineTabFacts(props.serverId, props.machineId);
    const guard = useMachineGuardView({ machineId: props.machineId, serverId: props.serverId });
    const activity = useMachineGuardActivity({ machineId: props.machineId, serverId: props.serverId, ...DEFAULT_MACHINE_GUARD_ACTIVITY_QUERY });
    const policyState = useGuardPolicy(guard);
    const wayBack = useGuardWayBack({ serverId: props.serverId, machineId: props.machineId });
    const view = guard.view;
    const policy = policyState.policy;
    const failure = React.useCallback((row: GuardRowId) => policyState.failed.has(row)
        ? t('machineGuard.saveFailed', { machine: props.machineName }) : null, [policyState.failed, props.machineName]);
    const editable = policyState.editable && !guard.offline;
    // The controls show the saved rules; the machine's last answer says what it runs (FX5 item 23).
    const running = view?.policy ?? null;
    const awaiting = React.useCallback((row: GuardRowId): string | null => policyState.policy !== null && !policyState.failed.has(row)
        && guardRowAwaitsMachine(row, policyState.policy, running) ? t('machineGuard.awaitingMachine', { machine: props.machineName }) : null,
    [policyState.policy, policyState.failed, running, props.machineName]);

    if (guard.status === 'not_reported') {
        return (
            <ItemGroup>
                <SurfaceStateCard testID="machine-guard-older" kind="empty" iconName="shield"
                    title={t('machineGuard.states.olderTitle', { machine: props.machineName })}
                    reason={t('machineGuard.states.olderBody', { machine: props.machineName })} />
            </ItemGroup>
        );
    }
    // Offline with no last view: the rules still read from the machine's synced policy (lab `rg` G9 2), read-only
    // under the offline banner; only a machine whose policy never arrived says it in one line.
    if (!view && guard.offline && !policyState.policy) {
        return (
            <ItemGroup>
                <SurfaceStateCard testID="machine-guard-offline-empty" kind="unavailable" size="line"
                    title={t('machineGuard.states.offlineTitle', { machine: props.machineName })}
              reason={t('machineGuard.states.offlineReason')} />
            </ItemGroup>
        );
    }
    // A first read that failed says so once, in one line; the saved rules still read and change below it.
    const readFailed = !view && guard.status === 'error' ? (
        <ItemGroup>
            <SurfaceStateCard testID="machine-guard-error" kind="error" size="line" title={t('machineGuard.states.error', { machine: props.machineName })}
                action={{ label: t('machineGuard.tryAgain'), onPress: guard.retry, testID: 'machine-guard-retry' }} />
        </ItemGroup>
    ) : null;
    if (!policy) return readFailed ?? <GuardLoading machineName={props.machineName} />;

    const nowMs = Date.now();
    // Only the Activity list can establish emptiness. The Guard view's recentActivity covers today,
    // whereas this preview and the detail page share the same default history and retained store entry.
    const recent = activity.list?.entries.slice(0, RECENT_ACTIVITY) ?? [];
    const activityLine = activity.list ? { id: 'empty', kind: 'empty' as const, iconName: 'clock' as const, title: t('machineGuard.activity.empty', { machine: props.machineName }) }
        : activity.offline ? { id: 'offline', kind: 'unavailable' as const, iconName: undefined, title: t('machineGuard.states.offlineTitle', { machine: props.machineName }), reason: t('machineGuard.states.offlineReason') }
            : activity.status === 'error' || activity.status === 'not_reported' ? { id: 'error', kind: 'unavailable' as const, iconName: undefined, title: t('machineGuard.activity.error') }
                : { id: 'loading', kind: 'loading' as const, iconName: undefined, title: t('machineGuard.activity.loading') };
    return (
        <View testID="machine-guard">
            <ItemGroup surface="none" header="none">
                <View style={styles.introBlock}>
                    <Text style={styles.intro}>
                        {facts.recipient ? t('machineGuard.states.recipient', { machine: props.machineName }) : t('machineGuard.intro', { machine: props.machineName })}
                    </Text>
                    {props.barAccessoryShown ? null : <GuardPhoneFreshness serverId={props.serverId} machineId={props.machineId} />}
                </View>
            </ItemGroup>
            {guard.offline ? <OfflineBanner machineName={props.machineName} asOf={facts.lastSeenAt} onRetry={guard.retry} /> : readFailed}
            <MemoryGuardSection machineName={props.machineName} policy={policy} view={view} editable={editable}
                failed={policyState.failed} awaiting={awaiting}
                reading={!view && !guard.offline && guard.status !== 'error'} nowMs={nowMs} save={policyState.save} />
            <IdleSessionsSection machineName={props.machineName} machineId={props.machineId} serverId={props.serverId} rule={policy.idleSessions} idle={view?.idle ?? null}
                editable={editable} failure={failure} awaiting={awaiting} save={policyState.save} />
            <IdleTerminalsSection machineId={props.machineId} serverId={props.serverId} rule={policy.idleTerminals} terminals={view?.idleTerminals ?? null}
                editable={editable} failure={failure} awaiting={awaiting} save={policyState.save} />
            <LeftBehindSection machineName={props.machineName} rule={policy.leftBehind} present={view?.leftBehind ?? null}
                editable={editable} failure={failure} awaiting={awaiting} save={policyState.save} />
            <LimitsAndPowerSection machineName={props.machineName} platform={facts.platform} policy={policy} state={view?.state ?? null}
                keepAwake={view?.keepAwake ?? null} editable={editable} failure={failure} awaiting={awaiting} save={policyState.save} />
            <AgentToolsSection settings={guard.settings} editable={editable} machineName={props.machineName} />
            <ItemGroup title={t('machineGuard.activity.title')}
                action={recent.length > 0 ? <TextLinkButton testID="machine-guard-all-activity" label={t('machineGuard.activity.all')} onPress={props.onOpenActivity} /> : undefined}>
                {recent.length > 0 ? recent.map((entry, index) => (
                    <MachineActivityRow key={entry.id} entry={entry} pendingId={wayBack.pendingId} onWayBack={wayBack.run}
                        readOnly={activity.offline} showDivider={index < recent.length - 1} />
                )) : (
                    <SurfaceStateCard testID={`machine-guard-activity-${activityLine.id}`} kind={activityLine.kind} size="line"
                        {...(activityLine.iconName ? { iconName: activityLine.iconName } : {})} title={activityLine.title}
                        {...('reason' in activityLine ? { reason: activityLine.reason } : {})} />
                )}
            </ItemGroup>
        </View>
    );
}

/** "studio is offline · These are its guard settings as of …" above what it blocks (G9-2). */
function OfflineBanner(props: Readonly<{ machineName: string; asOf: number | null; onRetry: () => void }>) {
    const { theme } = useUnistyles();
    return (
        <ItemGroup>
            <View testID="machine-guard-offline" style={styles.banner}>
                <Icon name="info" size={16} color={theme.colors.text.secondary} />
                <View style={styles.bannerBody}>
                    <Text style={styles.bannerTitle}>{t('machineGuard.states.offlineTitle', { machine: props.machineName })}</Text>
                    <Text style={styles.bannerText}>
                        {t('machineGuard.states.offlineBody', { time: props.asOf === null ? t('machineGuard.states.lastKnown') : formatAsOfTime(props.asOf) })}
                    </Text>
                    <TextLinkButton label={t('machineGuard.tryAgain')} onPress={props.onRetry} tone="strong" />
                </View>
            </View>
        </ItemGroup>
    );
}

/** Loading (G9-4): the sections and rows at their final size; only values and candidates are reserved. */
function GuardLoading(props: Readonly<{ machineName: string }>) {
    return (
        <View testID="machine-guard-loading" accessibilityLabel={t('machineGuard.states.loading')} accessibilityRole="progressbar">
            <ItemGroup title={t('machineGuard.memory.title')} description={t('machineGuard.memory.description', { machine: props.machineName })}>
                <ItemLoadStateRows state={{ kind: 'loading' }} rows={4} lines={2} />
            </ItemGroup>
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    introBlock: {
        gap: theme.space.s8,
    },
    intro: {
        ...Typography.default(),
        ...happierPageTextMetrics('pageDescription'),
        color: theme.colors.text.secondary,
        maxWidth: 640,
    },
    banner: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: theme.space.s12,
        padding: theme.space.s16,
    },
    bannerBody: {
        flex: 1,
        gap: theme.space.s4,
        alignItems: 'flex-start',
    },
    bannerTitle: {
        ...Typography.default('semiBold'),
        ...happierPageTextMetrics('rowTitle'),
        color: theme.colors.text.primary,
    },
    bannerText: {
        ...Typography.default(),
        ...happierPageTextMetrics('rowDescription'),
        color: theme.colors.text.secondary,
    },
}));
