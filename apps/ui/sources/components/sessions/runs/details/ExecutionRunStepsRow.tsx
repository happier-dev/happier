import * as React from 'react';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { ICON_SIZE } from '@/components/ui/icons/Icon';
import { DisclosureCaret } from '@/components/ui/lists/DisclosureCaret';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

const stylesheet = StyleSheet.create((theme) => ({
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        alignSelf: 'flex-start',
        paddingVertical: theme.space.s4,
        gap: theme.space.s6,
    },
    title: {
        ...Typography.default(),
        color: theme.colors.text.secondary,
        fontSize: 14,
    },
    count: {
        ...Typography.default(),
        color: theme.colors.text.tertiary,
        fontSize: 14,
        fontVariant: ['tabular-nums'],
    },
}));

/**
 * "How it got there · N steps" (agents lab RP1): the one row that opens a finished Run's transcript
 * under its result, and closes it again.
 */
export const ExecutionRunStepsRow = React.memo((props: Readonly<{
    expanded: boolean;
    stepCount: number;
    onToggle: () => void;
}>) => {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    return (
        <HappierPressable
            testID="session-run-details-steps"
            accessibilityRole="button"
            expanded={props.expanded}
            onPress={props.onToggle}
            style={styles.row}
        >
            <DisclosureCaret expanded={props.expanded} size={ICON_SIZE.xs} />
            <Text style={styles.title}>
                {t('runPage.steps.title')}
                {props.stepCount > 0 ? (
                    <Text style={styles.count}>{` · ${t('runPage.steps.count', { count: props.stepCount })}`}</Text>
                ) : null}
            </Text>
        </HappierPressable>
    );
});
