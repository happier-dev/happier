import { useHappierThemeSurfaceOverridesEnabled } from '@happier-dev/plugin-ui/presentation';
import * as React from 'react';
import { themeSurfaceDataSet } from '@happier-dev/plugin-ui';
import { themeSurfaceStyles } from '@/theme/css/themeSurfaceStyles';
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
    selected?: boolean;
    style?: StyleProp<TextStyle>;
}>) {
    const surfaceOverridesEnabled = useHappierThemeSurfaceOverridesEnabled();
    const { activityAt } = props;
    const readNextRefreshAtMs = React.useCallback(
        (nowMs: number) => readShortRelativeTimeRefreshAtMs(activityAt, nowMs), [activityAt]);
    // The list surface's data demand: covered, the age holds; shown again, it renders only if it moved.
    const nowMs = useSessionListRuntimeDeadlineNowMs(readNextRefreshAtMs, useSessionListSurfaceDataActiveSignal());
    return (
        <Text dataSet={themeSurfaceDataSet('session-row', 'meta', props.selected ? 'selected' : 'default')}
            style={[props.style, themeSurfaceStyles.surface(surfaceOverridesEnabled ? { surface: 'session-row', part: 'meta', state: props.selected ? 'selected' : 'default' } : undefined)]} numberOfLines={1}>
            {formatShortRelativeTimeAt(activityAt, nowMs)}
        </Text>
    );
});
