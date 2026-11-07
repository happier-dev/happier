import * as React from 'react';

import { useProfile, useSetting } from '@/sync/domains/state/storage';
import { useAllSessions } from '@/sync/store/hooks';
import { isHostVisible, startRuntimeActiveGatedInterval } from '@/utils/runtime/isRuntimeActive';

import { collectAutomaticProviderUsageRefreshTargets, runProviderUsageRefresh, useProviderUsageRefreshContext, type ProviderUsageRefreshContext } from './useProviderUsageRefresh';

const DEFAULT_AUTO_REFRESH_MINUTES = 5;
/** Smallest interval honoured, so a mistyped value cannot hammer the server. */
const MIN_AUTO_REFRESH_MINUTES = 1;

/** Reads the `providerUsageAutoRefreshMinutes` setting: a positive number of minutes, else the default. */
export function resolveProviderUsageAutoRefreshMs(minutes: unknown): number {
    const parsed = typeof minutes === 'number' && Number.isFinite(minutes) && minutes > 0 ? minutes : DEFAULT_AUTO_REFRESH_MINUTES;
    return Math.max(MIN_AUTO_REFRESH_MINUTES, parsed) * 60_000;
}

type Registration = Readonly<{ context: ProviderUsageRefreshContext; intervalMs: number }>;

// One shared timer: any number of mounted surfaces register, but only one refresh runs per tick.
const registrations = new Set<{ current: Registration }>();
let stopTimer: (() => void) | null = null;
let timerIntervalMs = 0;

function syncTimer(): void {
    const latest = [...registrations].at(-1)?.current ?? null;
    if (!latest) {
        stopTimer?.();
        stopTimer = null;
        timerIntervalMs = 0;
        return;
    }
    if (stopTimer && timerIntervalMs === latest.intervalMs) return;
    stopTimer?.();
    timerIntervalMs = latest.intervalMs;
    stopTimer = startRuntimeActiveGatedInterval(() => {
        const current = [...registrations].at(-1)?.current;
        if (current && isHostVisible()) runProviderUsageRefresh(current.context, { connectedProfileRef: null, recordIds: [] }, { automatic: true });
    }, latest.intervalMs);
}

/**
 * Re-queries eligible active providers on the Usage-settings interval, for as long as any surface
 * using this hook is mounted; the timer stops when the last one unmounts.
 */
export function useProviderUsageAutoRefresh(): void {
    const context = useProviderUsageRefreshContext();
    const connectedServices = useProfile()?.connectedServicesV2;
    const sessions = useAllSessions();
    const automaticTargets = React.useMemo(() => collectAutomaticProviderUsageRefreshTargets({
        connectedServices: connectedServices ?? [], sessions,
    }), [connectedServices, sessions]);
    const intervalMs = resolveProviderUsageAutoRefreshMs(useSetting('providerUsageAutoRefreshMinutes'));
    const registration = React.useRef<Registration | null>(null) as React.MutableRefObject<Registration>;
    if (context) registration.current = { context: { ...context, automaticTargets }, intervalMs };
    const signedIn = context !== null;
    React.useEffect(() => {
        if (!signedIn) return;
        registrations.add(registration);
        syncTimer();
        return () => {
            registrations.delete(registration);
            syncTimer();
        };
    }, [signedIn]);
    React.useEffect(() => { syncTimer(); }, [intervalMs]);
}
