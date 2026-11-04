import * as React from 'react';

import { EmptyState } from '@/components/ui/empty/EmptyState';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { resolveHomeDisplayLabel } from '@/components/settings/server/homeDisplayName';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { areServerProfileIdentifiersEquivalent, getServerProfileById } from '@/sync/domains/server/serverProfiles';
import {
    getAppliedActiveServerId,
    getAppliedActiveServerSnapshot,
    isAppliedActiveServerRuntimeAvailable,
    retryActiveServerConnection,
    subscribeAppliedActiveServer,
    subscribeAppliedActiveServerRuntimeAvailability,
} from '@/sync/runtime/orchestration/connectionManager';
import { t } from '@/text';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { storage } from '@/sync/domains/state/storage';
import { selectSyncErrorForServer } from '@/sync/runtime/connectivity/syncErrorScope';
import { resolveServerScopedMachineInventoryKeys } from '@/sync/domains/machines/resolveServerScopedMachines';

import { resolveHomeConnectionSummary } from './resolveHomeConnectionSummary';
import { resolveConnectionHealth } from './resolveConnectionHealth';

function subscribeApplied(listener: () => void): () => void {
    return subscribeAppliedActiveServer(() => listener());
}

/** The Home whose health the connection summary reports: the applied one, else the requested one. */
function useReportedHomeServerId(): string | null {
    const requestedServerId = useActiveServerSnapshot().serverId;
    const appliedServerId = React.useSyncExternalStore(subscribeApplied, getAppliedActiveServerId, getAppliedActiveServerId);
    return appliedServerId || requestedServerId || null;
}

/** Whether the Home this device uses is unreachable: the canonical connection summary the footer shows. */
export function useActiveHomeUnavailable(): boolean {
    return React.useSyncExternalStore(subscribeAppliedHomeSummary,
        readAppliedHomeUnavailable, readAppliedHomeUnavailable);
}

function readAppliedHomeUnavailable(): boolean {
    return readAppliedHomeSummaryKind() === 'unavailable';
}

/** The canonical connection summary of the applied Home, read without subscribing to its machines. */
function readAppliedHomeSummaryKind() {
    if (!isAppliedActiveServerRuntimeAvailable()) return null;
    const state = storage.getState();
    const serverId = getAppliedActiveServerSnapshot().serverId;
    const syncError = selectSyncErrorForServer(state.syncError, serverId);
    const statuses = state.machineListStatusByServerId;
    const keys = resolveServerScopedMachineInventoryKeys({ serverId, machineListByServerId: statuses });
    const status = keys.map(key => statuses[key]).find(value => value !== undefined) ?? 'loading';
    // Machine counts refine connected-state labels but cannot make a Home
    // unavailable. Its list's error/sign-in state still enters the same classifier.
    const health = resolveConnectionHealth({ socketStatus: state.socketStatus,
        endpointStatus: state.endpointStatus, endpointReason: state.endpointReason,
        hasSyncError: Boolean(syncError), syncErrorKind: syncError?.kind,
        machineGroups: [{ machineCount: null, onlineCount: null, status }] });
    return resolveHomeConnectionSummary({ healthKind: health.kind }).kind;
}

function subscribeAppliedHomeSummary(listener: () => void): () => void {
    const unsubscribe = storage.subscribe(listener);
    const unsubscribeApplied = subscribeAppliedActiveServer(listener);
    const unsubscribeAvailability = subscribeAppliedActiveServerRuntimeAvailability(listener);
    return () => { unsubscribe(); unsubscribeApplied(); unsubscribeAvailability(); };
}

/**
 * Whether the Home this device uses is still being reached (its connection summary reads "reconnecting"):
 * right after sign-in, a restart or a network change. A read that fails in that gap has not settled
 * into a failure; it reads as loading and is read again once the Home answers or is declared unreachable.
 */
export function useSettlingHomeServerId(): string | null {
    // Until the connection manager has applied the Home, the connection health owner reads it as connecting too.
    const settling = React.useSyncExternalStore(subscribeAppliedHomeSummary,
        () => !isAppliedActiveServerRuntimeAvailable() || readAppliedHomeSummaryKind() === 'reconnecting', () => false);
    const reportedServerId = useReportedHomeServerId();
    return settling ? reportedServerId : null;
}

export function useActiveHomeSettling(homeServerId?: string): boolean {
    const settlingServerId = useSettlingHomeServerId();
    // Only the Home this device uses has a connection summary; another Home's reads settle on their own.
    return settlingServerId !== null && (homeServerId === undefined
        || areServerProfileIdentifiersEquivalent(homeServerId, settlingServerId));
}

/**
 * Whether a failed read that needed only these Homes is explained by the Home this device uses being
 * unreachable: every one of them is that Home, and the canonical connection summary says it is
 * unavailable (the fact the page's "can't reach" banner and the footer show). Such a read defers to
 * that one banner instead of reporting the same cause again.
 */
export function useFailureExplainedByUnreachableHome(homeServerIds: readonly string[]): boolean {
    // A closed or non-pending caller observes no health. Pending callers select only
    // the Home's unavailable bit, never its machine inventory or display details.
    const enabled = homeServerIds.length > 0;
    const readUnavailable = React.useCallback(() => enabled && readAppliedHomeSummaryKind() === 'unavailable', [enabled]);
    const subscribeUnavailable = React.useCallback((listener: () => void) => enabled ? subscribeAppliedHomeSummary(listener) : () => {}, [enabled]);
    const unavailable = React.useSyncExternalStore(subscribeUnavailable, readUnavailable, readUnavailable);
    const reportedServerId = useReportedHomeServerId();
    return unavailable
        && reportedServerId !== null
        && homeServerIds.length > 0
        && homeServerIds.every((id) => areServerProfileIdentifiersEquivalent(id, reportedServerId));
}

/**
 * Wraps a surface's quiet loading state (the home pane, the session list's skeleton rows). While the
 * Home is still being reached it shows that loading state; once the canonical connection summary
 * says the Home is unavailable (the same fact the footer's status shows), it says so by name and
 * offers Retry instead of loading forever. A list or page can also keep this gate mounted beside
 * retained rows or waiting widgets (with no children), so the same Home fact and Retry stay visible:
 * the app's one offline line, drawn by the shared freshness line.
 */
export function HomeReachabilityGate(props: Readonly<{
    /** `pane`: a whole pane (glyph, title, one line, Retry). `line`: one quiet line in a list. */
    variant: 'pane' | 'line';
    children: React.ReactNode;
    /** For multi-Home lists, only report this Home when it is part of the visible query. */
    relevantServerIds?: readonly string[];
}>) {
    const unavailable = useActiveHomeUnavailable();
    // Name the Home whose health this reports: the applied one (during a switch the requested Home
    // is not yet the one the transport is talking to), as the footer's Home line does.
    const serverId = useReportedHomeServerId();
    const relevant = props.relevantServerIds === undefined
        || (serverId !== null && props.relevantServerIds.some((id) => areServerProfileIdentifiersEquivalent(id, serverId)));
    const home = React.useMemo(
        () => resolveHomeDisplayLabel(serverId ? getServerProfileById(serverId) : null, t('settingsAccount.thisHome')),
        [serverId],
    );
    const retry = React.useMemo(() => ({
        label: t('common.retry'),
        testID: 'home-unreachable-retry',
        onPress: () => {
            fireAndForget(retryActiveServerConnection(), { tag: 'HomeReachabilityGate.retry' });
        },
    }), []);

    if (!unavailable || !relevant) return <>{props.children}</>;
    if (props.variant === 'line') {
        return (
            <SurfaceFreshnessLine
                testID="home-unreachable"
                glyph="cloud-slash"
                reason={t('sidebarFooter.homeUnreachableLine', { home })}
                action={retry}
            />
        );
    }
    return (
        <EmptyState
            layout="page"
            testID="home-unreachable"
            scene="homeOffline"
            title={t('sidebarFooter.homeUnreachableTitle', { home })}
            subtitle={t('sidebarFooter.homeUnreachableBody')}
            primaryAction={retry}
        />
    );
}
