import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import type { ExecutionRunStatus } from '@happier-dev/protocol';
import { Text } from '@/components/ui/text/Text';


function normalizeStatus(status: unknown): ExecutionRunStatus | 'unknown' {
    switch (status) {
        case 'running':
        case 'succeeded':
        case 'failed':
        case 'cancelled':
        case 'timeout':
            return status;
        default:
            return 'unknown';
    }
}

export const ExecutionRunStatusPill = React.memo((props: Readonly<{ status: unknown }>) => {
    const { theme } = useUnistyles();
    const status = normalizeStatus(props.status);

    const colors = (() => {
        switch (status) {
            case 'running':
                return { bg: theme.colors.surface.inset, fg: theme.colors.text.secondary };
            case 'succeeded':
                return { bg: theme.colors.surface.inset, fg: theme.colors.text.primary };
            case 'failed':
                return { bg: theme.colors.surface.inset, fg: theme.colors.text.primary };
            case 'cancelled':
                return { bg: theme.colors.surface.inset, fg: theme.colors.text.secondary };
            case 'timeout':
                return { bg: theme.colors.surface.inset, fg: theme.colors.text.secondary };
            case 'unknown':
                return { bg: theme.colors.surface.inset, fg: theme.colors.text.secondary };
        }
    })();

    return (
        <View style={[styles.pill, { backgroundColor: colors.bg, borderColor: theme.colors.border.default }]}>
            <Text style={[styles.text, { color: colors.fg }]}>
                {status}
            </Text>
        </View>
    );
});

const styles = StyleSheet.create(() => ({
    pill: {
        paddingHorizontal: 8,
        paddingVertical: 4,
        borderRadius: 999,
        borderWidth: 1,
        alignSelf: 'flex-start',
    },
    text: {
        fontSize: 11,
        fontWeight: '600',
        fontFamily: 'Menlo',
    },
}));

