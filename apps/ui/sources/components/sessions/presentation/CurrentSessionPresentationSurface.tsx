import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import {
    CURRENT_SESSION_PRESENTATION_AGENT_STATE_KEY,
    CurrentSessionPresentationStateV1Schema,
} from '@happier-dev/protocol/sessions';

import { Text } from '@/components/ui/text/Text';
import { recordSessionPayloadConsumptionTelemetry } from '@/sync/domains/session/sessionPayloadConsumptionTelemetry';
import type { Session } from '@/sync/domains/state/storageTypes';

const stylesheet = StyleSheet.create((theme) => ({
    group: {
        gap: 6,
        paddingHorizontal: 12,
        paddingVertical: 8,
    },
    item: {
        borderRadius: 8,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.inset,
        paddingHorizontal: 10,
        paddingVertical: 7,
    },
    text: {
        color: theme.colors.text.secondary,
        fontSize: 12,
        lineHeight: 17,
    },
}));

export const CurrentSessionPresentationSurface = React.memo(function CurrentSessionPresentationSurface(props: Readonly<{
    session: Pick<Session, 'agentState'>;
    placement: 'beforeComposer' | 'afterComposer';
}>) {
    const styles = stylesheet;
    const raw = (props.session.agentState as Record<string, unknown> | null)?.[
        CURRENT_SESSION_PRESENTATION_AGENT_STATE_KEY
    ];
    const parsed = CurrentSessionPresentationStateV1Schema.safeParse(raw);
    if (!parsed.success) return null;
    if (props.placement === 'beforeComposer') {
        recordSessionPayloadConsumptionTelemetry({
            family: 'presentation',
            payload: parsed.data,
            itemCount: parsed.data.statuses.length + parsed.data.widgets.length,
            lineCount: parsed.data.statuses.length
                + parsed.data.widgets.reduce((sum, widget) => sum + widget.lines.length, 0),
        });
    }

    const lines = props.placement === 'beforeComposer'
        ? [
            ...parsed.data.statuses.map((status) => ({ key: `status:${status.key}`, lines: [status.text] })),
            ...parsed.data.widgets
                .filter((widget) => widget.placement === 'beforeComposer')
                .map((widget) => ({ key: `widget:${widget.key}`, lines: widget.lines })),
        ]
        : parsed.data.widgets
            .filter((widget) => widget.placement === 'afterComposer')
            .map((widget) => ({ key: `widget:${widget.key}`, lines: widget.lines }));
    if (lines.length === 0) return null;

    return (
        <View
            style={styles.group}
            testID={`current-session-presentation-${props.placement}`}
            accessibilityLiveRegion="polite"
        >
            {lines.map((item) => (
                <View key={item.key} style={styles.item}>
                    {item.lines.map((line, index) => (
                        <Text key={`${item.key}:${index}`} style={styles.text}>{line}</Text>
                    ))}
                </View>
            ))}
        </View>
    );
});
