import * as React from 'react';

import type { PageHeaderMetaFact } from '@/components/ui/layout/PageHeader';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { isMachineResourceStateStale, machineResourceStore } from '@/sync/domains/machines/resources/machineResourceStore';
import type { MachineResourceKey } from '@/sync/domains/machines/resources/machineRpc';
import { retryMachineResourceSummaries } from '@/sync/domains/machines/resources/retryMachineResourceSummaries';
import { readMachineResourceReadStatus } from '@/sync/domains/machines/resources/machineResourceAvailability';
import { useMachineDaemonReadIdentities } from '@/sync/domains/machines/useMachineDaemonReadTarget';
import { t } from '@/text';
import { formatAsOfTime } from '@/utils/time/formatAsOfTime';

/**
 * How current the summaries a surface shows are, from the held answers themselves (no clock of its own: it
 * re-reads on every store notification). `staleSince` is the oldest held sample of a summary that stopped
 * answering (MPG-18 stale, or a read that failed twice); `slow` is a first failed watch (M-15), every value kept;
 * `held` says any summary has arrived at all. `retry` is the one recovery for every summary shown.
 */
export function useMachineSummaryFreshness(machineKeys: readonly MachineResourceKey[]): Readonly<{
    staleSince: number | null;
    slow: boolean;
    held: boolean;
    retry: () => void;
}> {
    const identities = useMachineDaemonReadIdentities(machineKeys);
    const qualifiedKeys = React.useMemo(() => identities.filter(identity => identity.accountMatches).map(identity => identity.key), [identities]);
    const inputs = React.useMemo(() => qualifiedKeys.map(key => ({ ...key, view: 'summary' as const })), [qualifiedKeys]);
    const subscribe = React.useCallback((listener: () => void) => {
        const stops = inputs.map(input => machineResourceStore.observe(input, listener));
        return () => { for (const stop of stops) stop(); };
    }, [inputs]);
    const readStaleSince = React.useCallback(() => {
        let oldest: number | null = null;
        const now = Date.now();
        for (const input of inputs) {
            const state = machineResourceStore.getState(input);
            if (!state.summary) continue;
            if (!isMachineResourceStateStale(state, now) && readMachineResourceReadStatus(state) !== 'error') continue;
            oldest = oldest === null ? state.summary.sampledAt : Math.min(oldest, state.summary.sampledAt);
        }
        return oldest;
    }, [inputs]);
    const readSlow = React.useCallback(
        () => inputs.some(input => readMachineResourceReadStatus(machineResourceStore.getState(input)) === 'slow'),
        [inputs],
    );
    const readHeld = React.useCallback(() => inputs.some(input => machineResourceStore.getState(input).summary != null), [inputs]);
    const staleSince = React.useSyncExternalStore(subscribe, readStaleSince, readStaleSince);
    const slow = React.useSyncExternalStore(subscribe, readSlow, readSlow);
    const held = React.useSyncExternalStore(subscribe, readHeld, readHeld);
    const retry = React.useCallback(() => retryMachineResourceSummaries(qualifiedKeys), [qualifiedKeys]);
    return { staleSince, slow, held, retry };
}

/**
 * A page header's freshness facts for the summaries it shows (MPG-11, §13 rule 9): "Live" while they answer,
 * "As of 10:42 · Retry" once they stopped, "Slow to answer · Retry" after a first failed watch; nothing until a
 * summary has arrived, or when the page shows none (no keys).
 */
export function useMachineSummaryFreshnessFacts(machineKeys: readonly MachineResourceKey[], testIDPrefix: string): readonly PageHeaderMetaFact[] {
    const { staleSince, slow, held, retry } = useMachineSummaryFreshness(machineKeys);
    return React.useMemo((): readonly PageHeaderMetaFact[] => {
        const retryFact: PageHeaderMetaFact = { key: 'retry', text: t('common.retry'), onPress: retry, accessibilityLabel: t('common.retry'), testID: `${testIDPrefix}.retry` };
        if (staleSince !== null) {
            return [{ key: 'freshness', text: t('surfaceState.asOf', { time: formatAsOfTime(staleSince) }), testID: `${testIDPrefix}.stale` }, retryFact];
        }
        if (slow) return [{ key: 'freshness', text: t('machineSummary.slowReason'), testID: `${testIDPrefix}.slow` }, retryFact];
        return held ? [{ key: 'freshness', text: t('machineVitals.live'), testID: `${testIDPrefix}.live` }] : [];
    }, [held, retry, slow, staleSince, testIDPrefix]);
}

/**
 * "As of 10:42 · Retry" while the summaries a surface shows stopped answering (MPG-18 stale, or a read that
 * failed twice): the oldest held sample's time and the one recovery, as the machine page's chip says it. A
 * first failed watch is only "Slow to answer · Retry" with every value kept (M-15). Otherwise the surface's
 * own line (`fallback`) stands. The strips themselves dim one step; this line is the only words about it.
 * The chip gives way before Retry does, so it fits a 372 px popover in any locale.
 */
export function MachineSummaryFreshnessLine(props: Readonly<{ machineKeys: readonly MachineResourceKey[]; fallback: React.ReactNode }>) {
    const { staleSince, slow, retry } = useMachineSummaryFreshness(props.machineKeys);
    if (staleSince === null && !slow) return <>{props.fallback}</>;
    return (
        <SurfaceFreshnessLine
            testID="machines.summary.stale"
            presentation="chip"
            asOf={staleSince}
            reason={staleSince === null ? t('machineSummary.slowReason') : ''}
            action={{ label: t('common.retry'), onPress: retry }}
        />
    );
}
