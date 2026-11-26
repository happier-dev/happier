import * as React from 'react';
import { resolveHref } from 'expo-router/build/link/href';

import { buildHomeRecoveryHref } from '@/components/settings/server/navigation/serverSettingsRouteParams';
import { useAppUpdateStatus } from '@/updates/useAppUpdateStatus';
import { requestOpenExternalUrl } from '@/utils/url/requestOpenExternalUrl';
import { selectHomeAdmission } from '@/sync/runtime/connectivity/homeAdmissionReadiness';
import { runGuardedNavigation } from '@/utils/navigation/runGuardedNavigation';

import { EmptyState } from '@/components/ui/empty/EmptyState';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
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
import type { HomeAdmissionSnapshot } from '@/sync/store/domains/realtime';
import { selectSyncErrorForServer } from '@/sync/runtime/connectivity/syncErrorScope';
import { resolveServerScopedMachineInventoryKeys } from '@/sync/domains/machines/resolveServerScopedMachines';

import { resolveHomeAdmissionConnectionSummary, resolveHomeConnectionSummary, type HomeConnectionSummary } from './resolveHomeConnectionSummary';
import { resolveConnectionHealth } from './resolveConnectionHealth';

function subscribeApplied(listener: () => void): () => void {
    return subscribeAppliedActiveServer(() => listener());
}

/** The Home whose health the connection summary reports: the applied one, else the requested one. */
export function useReportedHomeServerId(): string | null {
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

/** Whether the page already says this Home can't be reached: the applied Home, read once from the same summary. */
export function readHomeShownUnavailable(serverId: string | null | undefined): boolean {
    if (!readAppliedHomeUnavailable()) return false;
    return !serverId || areServerProfileIdentifiersEquivalent(serverId, getAppliedActiveServerSnapshot().serverId);
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
    const unsubscribe = storage.subscribe(listener, {
        syncError: true, machineListStatusByServerId: true, socketStatus: true, endpointStatus: true, endpointReason: true,
    });
    const unsubscribeApplied = subscribeAppliedActiveServer(listener);
    const unsubscribeAvailability = subscribeAppliedActiveServerRuntimeAvailability(listener);
    return () => { unsubscribe(); unsubscribeApplied(); unsubscribeAvailability(); };
}

/** The connection verdict for this mount's Home, when the applied runtime owns it. */
export function useScopedHomeConnectionKind(serverId: string | null | undefined) {
    const read = React.useCallback(() => {
        if (!serverId || !areServerProfileIdentifiersEquivalent(serverId, getAppliedActiveServerSnapshot().serverId)) {
            return null;
        }
        return readAppliedHomeSummaryKind() ?? 'reconnecting';
    }, [serverId]);
    const subscribe = React.useCallback((listener: () => void) =>
        serverId ? subscribeAppliedHomeSummary(listener) : () => {}, [serverId]);
    return React.useSyncExternalStore(subscribe, read, read);
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
 * the app's one offline line, one quiet state line with its Retry beside the sentence (a column states its
 * condition in one line, never a bordered strip; WAVE-ACCEPT-1117C). A page header's notice slot keeps the
 * inline freshness line, which carries when its kept content was read.
 */
export function HomeReachabilityGate(props: Readonly<{
    /** `pane`: a whole pane (glyph, title, one line, Retry). `line`: one quiet line in a list. */
    variant: 'pane' | 'line';
    children: React.ReactNode;
    /** For multi-Home lists, only report this Home when it is part of the visible query. */
    relevantServerIds?: readonly string[];
    onUnavailable?: () => void;
    accountRestoring?: Readonly<{ returnTo: string }>;
    /** `line` only: drawn inline in a page header's notice slot, with the time the kept content was read. */
    presentation?: 'inline';
    asOf?: number | null;
}>) {
    const unavailable = useActiveHomeUnavailable();
    // Name the Home whose health this reports: the applied one (during a switch the requested Home
    // is not yet the one the transport is talking to), as the footer's Home line does.
    const serverId = useReportedHomeServerId();
    const relevant = props.relevantServerIds === undefined
        || (serverId !== null && props.relevantServerIds.some((id) => areServerProfileIdentifiersEquivalent(id, serverId)));
    const { accountRestoring, onUnavailable } = props;
    const requested = useActiveServerSnapshot();
    // A signed-out runtime can be applied after a 401; the first Account still
    // has not admitted, and the exact refusal is the reason this shell is here.
    const cold = storage(state => accountRestoring ? selectHomeAdmission(state.homeAdmission, requested) : null);
    const summary = cold ? resolveHomeAdmissionConnectionSummary(cold.verdict) : null;
    const showAdmission = summary !== null;
    React.useLayoutEffect(() => {
        if ((unavailable || showAdmission) && relevant) onUnavailable?.();
    }, [onUnavailable, relevant, unavailable, showAdmission]);
    const home = React.useMemo(
        () => resolveHomeDisplayLabel(serverId ? getServerProfileById(serverId) : null, serverId ?? '', serverId ?? undefined),
        [serverId],
    );
    const retry = React.useMemo(() => ({
        label: t('common.retry'),
        testID: 'home-unreachable-retry',
        onPress: () => {
            fireAndForget(retryActiveServerConnection(), { tag: 'HomeReachabilityGate.retry' });
        },
    }), []);

    if (relevant && summary && accountRestoring && cold) {
        const requestedHome = resolveHomeDisplayLabel(getServerProfileById(requested.serverId),
            requested.serverId, requested.serverId);
        return <HomeAdmissionRecoveryCard admission={cold} summary={summary} returnTo={accountRestoring.returnTo} home={requestedHome} retry={retry} />;
    }
    if (!unavailable || !relevant) return <>{props.children}</>;
    if (props.variant === 'line' && props.presentation === 'inline') {
        return (
            <SurfaceFreshnessLine
                testID="home-unreachable"
                glyph="cloud-slash"
                reason={t('sidebarFooter.homeUnreachableLine', { home })}
                action={retry}
                presentation="inline"
                {...(props.asOf !== undefined ? { asOf: props.asOf } : {})}
            />
        );
    }
    if (props.variant === 'line') {
        return (
            <SurfaceStateCard
                testID="home-unreachable"
                size="line"
                kind="unavailable"
                iconName="cloud-slash"
                title={t('sidebarFooter.homeUnreachableLine', { home })}
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


function HomeAdmissionRecoveryCard(props: Readonly<{
    admission: HomeAdmissionSnapshot;
    summary: HomeConnectionSummary;
    returnTo: string;
    home: string;
    retry: Readonly<{ label: string; testID: string; onPress: () => void }>;
}>) {
    const { target, verdict } = props.admission;
    if (!('retryable' in verdict)) return null;
    switch (verdict.kind) {
        case 'auth_failed': {
            return <SurfaceStateCard kind="unavailable" size="page" testID="home-unreachable"
                title={t('server.homes.signInAgainTitle', { name: props.home })}
                reason={t('server.homes.signInAgainDescription')} diagnosticCode={verdict.code}
                action={props.summary.action === 'restore' ? {
                    testID: 'home-admission-restore', label: t('connect.restoreAccount'),
                    onPress: () => {
                        // The cold shell has not mounted its navigator. Enter the
                        // existing public Home recovery route in this document's tab.
                        const href = resolveHref(buildHomeRecoveryHref({
                            profileRef: target.serverId, returnTo: props.returnTo,
                        }));
                        const result = runGuardedNavigation(() => window.location.assign(href));
                        if (result !== true) fireAndForget(result, { tag: 'HomeAdmissionRecovery.restore' });
                    },
                } : undefined} />;
        }
        case 'update_required': {
            const requirement = verdict.requirement;
            const component = 'component' in requirement ? requirement.component : 'client';
            const code = 'error' in requirement ? requirement.error : requirement.kind;
            if (component === 'client') return <HomeAdmissionClientUpdateCard diagnosticCode={code} />;
            // The external-link Action runs on this client before the Home admits the Account.
            const guide = component === 'server' ? 'server--self-host-updates' : 'cli-updates-binary-vs-npm';
            return <SurfaceStateCard kind="unavailable" size="page" testID="home-unreachable"
                title={t('updates.summary.required')} diagnosticCode={code} diagnosticDetail={component}
                action={props.summary.action === 'update' ? { testID: 'home-admission-update', label: t('updates.action.openUpdates'),
                    onPress: () => requestOpenExternalUrl('https://docs.happier.dev/releases/updates#' + guide) } : undefined} />;
        }
        case 'offline':
        case 'unavailable':
        case 'transient':
            return <SurfaceStateCard kind="unavailable" size="page" testID="home-unreachable"
                title={t('sidebarFooter.homeUnreachableTitle', { home: props.home })}
                reason={t('sidebarFooter.homeUnreachableBody')} diagnosticCode={verdict.code}
                diagnosticDetail={verdict.kind === 'transient' && verdict.status ? `HTTP ${verdict.status}` : undefined}
                detail={verdict.kind === 'unavailable' && verdict.carrier === 'iroh' ? t('systemStatus.transport.irohCurrent') : undefined}
                action={props.summary.action === 'retry' ? props.retry : undefined} />;
        case 'fail_closed':
        case 'refused':
            return <SurfaceStateCard kind="unavailable" size="page" testID="home-unreachable"
                title={t('connectionStatus.summary.unavailable')} diagnosticCode={verdict.code} />;
    }
}

function HomeAdmissionClientUpdateCard({ diagnosticCode }: Readonly<{ diagnosticCode: string }>) {
    const update = useAppUpdateStatus();
    const available = update.model.item.action.kind === 'run';
    return <SurfaceStateCard kind="unavailable" size="page" testID="home-unreachable"
        title={t('updates.summary.required')} diagnosticCode={diagnosticCode}
        action={{
            testID: 'home-admission-update',
            label: available ? t('updates.action.update') : t('updates.action.checkNow'),
            onPress: () => {
                fireAndForget(available ? update.run() : update.checkNow(), { tag: 'HomeAdmissionRecovery.update' });
            },
        }} />;
}
