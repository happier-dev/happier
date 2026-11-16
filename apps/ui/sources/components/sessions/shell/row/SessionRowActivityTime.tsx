import * as React from 'react';
import type { StyleProp, TextStyle } from 'react-native';

import { Text } from '@/components/ui/text/Text';
import { useSessionListRuntimeDeadlineNowMs } from '@/hooks/session/sessionListRuntimeClock';
import { formatShortRelativeTimeAt, readShortRelativeTimeRefreshAtMs } from '@/utils/time/formatShortRelativeTime';
import { useSessionListSurfaceDataActiveSignal } from '@/components/sessions/shell/surface/sessionListSurfaceDataActive';

/**
 * A row's age ("44m") on the shared session-list clock. Only this leaf wakes at its own label
 * boundary, so a minute turning never rebuilds the row's view model or re-renders the row.
 */
export const SessionRowActivityTime = React.memo(function SessionRowActivityTime(props: Readonly<{
    activityAt: number;
    style?: StyleProp<TextStyle>;
}>) {
    const { activityAt } = props;
    const readNextRefreshAtMs = React.useCallback(
        (nowMs: number) => readShortRelativeTimeRefreshAtMs(activityAt, nowMs), [activityAt]);
    // The list surface's data demand: covered, the age holds; shown again, it renders only if it moved.
    const nowMs = useSessionListRuntimeDeadlineNowMs(readNextRefreshAtMs, useSessionListSurfaceDataActiveSignal());
    return (
        <Text style={props.style} numberOfLines={1}>
            {formatShortRelativeTimeAt(activityAt, nowMs)}
        </Text>
    );
});
