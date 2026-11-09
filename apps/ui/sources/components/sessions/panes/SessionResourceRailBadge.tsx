import * as React from 'react';
import type { RailBadgeSignalRenderer } from '@/components/navigation/shell/appRail/AppRailBadge';
import { TabBadge } from '@/components/ui/navigation/tabBadge/TabBadge';
import { useLocalServiceInventoryRunningCount, type LocalServiceInventoryRunningCountInput } from '@/sync/domains/local/services/inventory/useLocalServiceInventoryRunningCount';
import { useSessionBoardItemCount } from '@/sync/domains/sessionSystemRecords/useSessionSystemRecordBinding';

type BadgeSignalProps = Readonly<{ renderSignal?: RailBadgeSignalRenderer }>;

function renderCount(count: number | null, testID: string, renderSignal?: RailBadgeSignalRenderer) {
    const signal = count !== null && count > 0 ? { kind: 'count' as const, value: count, tone: 'neutral' as const } : null;
    if (renderSignal) return <>{renderSignal(signal)}</>;
    return signal ? <TabBadge variant="count" size="compact" value={signal.value} tone="neutral" testID={testID} /> : null;
}

/** The Session model owns acquisition; the badge passively selects its exact Machine's scalar. */
export const SessionServicesRailBadge = React.memo((props: LocalServiceInventoryRunningCountInput & BadgeSignalProps) => (
    renderCount(useLocalServiceInventoryRunningCount(props), 'session-action-rail:services:badge', props.renderSignal)
));

/** Numeric and placement consumers share the existing repository's one-open acquisition. */
export const SessionBoardRailBadge = React.memo((props: Parameters<typeof useSessionBoardItemCount>[0] & BadgeSignalProps) => (
    renderCount(useSessionBoardItemCount(props), 'session-action-rail:board:badge', props.renderSignal)
));
