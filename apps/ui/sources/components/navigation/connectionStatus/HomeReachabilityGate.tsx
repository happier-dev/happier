import * as React from 'react';

import { EmptyState } from '@/components/ui/empty/EmptyState';
import { resolveHomeDisplayLabel } from '@/components/settings/server/homeDisplayName';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { areServerProfileIdentifiersEquivalent, getServerProfileById } from '@/sync/domains/server/serverProfiles';
import {
    getAppliedActiveServerId,
    retryActiveServerConnection,
    subscribeAppliedActiveServer,
} from '@/sync/runtime/orchestration/connectionManager';
import { t } from '@/text';
import { fireAndForget } from '@/utils/system/fireAndForget';

import { resolveHomeConnectionSummary } from './resolveHomeConnectionSummary';
import { useActiveHomeConnectionHealth } from './useConnectionHealth';

function subscribeApplied(listener: () => void): () => void {
    return subscribeAppliedActiveServer(() => listener());
}

/** The Home whose health the connection summary reports: the applied one, else the requested one. */
function useReportedHomeServerId(): string | null {
    const requestedServerId = useActiveServerSnapshot().serverId;
    const appliedServerId = React.useSyncExternalStore(subscribeApplied, getAppliedActiveServerId, getAppliedActiveServerId);
    return appliedServerId || requestedServerId || null;
}

/**
 * Whether a failed read that needed only these Homes is explained by the Home this device uses being
 * unreachable: every one of them is that Home, and the canonical connection summary says it is
 * unavailable (the fact the page's "can't reach" banner and the footer show). Such a read defers to
 * that one banner instead of reporting the same cause again.
 */
export function useFailureExplainedByUnreachableHome(homeServerIds: readonly string[]): boolean {
    const health = useActiveHomeConnectionHealth();
    const unavailable = resolveHomeConnectionSummary({ healthKind: health.kind }).kind === 'unavailable';
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
 * offers Retry instead of loading forever. A list can also keep this gate mounted beside retained
 * rows, so the same Home fact and Retry remain visible while its last-known rows are shown.
 */
export function HomeReachabilityGate(props: Readonly<{
    /** `pane`: a whole pane (glyph, title, one line, Retry). `line`: one quiet line in a list. */
    variant: 'pane' | 'line';
    children: React.ReactNode;
    /** For multi-Home lists, only report this Home when it is part of the visible query. */
    relevantServerIds?: readonly string[];
}>) {
    const health = useActiveHomeConnectionHealth();
    const unavailable = resolveHomeConnectionSummary({ healthKind: health.kind }).kind === 'unavailable';
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
            <EmptyState
                layout="line"
                testID="home-unreachable"
                title={t('sidebarFooter.homeUnreachableLine', { home })}
                primaryAction={retry}
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
