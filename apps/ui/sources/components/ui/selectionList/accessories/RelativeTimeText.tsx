import * as React from 'react';
import { Platform } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Typography } from '@/constants/Typography';
import { Text } from '@/components/ui/text/Text';

import { formatRelativeTimeShort } from '../formatRelativeTimeShort';

const stylesheet = StyleSheet.create((theme) => ({
    text: {
        fontSize: Platform.select({ ios: 12, default: 11 }),
        lineHeight: Platform.select({ ios: 16, default: 14 }),
        color: theme.colors.text.secondary,
    },
}));

export type RelativeTimeTextProps = Readonly<{
    atMs: number;
    nowMs: number;
    testID?: string;
}>;

/**
 * Renders a compact relative-time string ('5m ago', '2h ago', '14d ago') with
 * `Typography.tabular()` so digits stay at fixed character width — '12m ago' →
 * '13m ago' won't shift sibling layout.
 *
 * Pure presentation: caller is responsible for picking `nowMs` (we don't tick
 * internally — surfaces that need ticking should re-render this component
 * with a fresh `nowMs`).
 */
export function RelativeTimeText(props: RelativeTimeTextProps): React.ReactElement {
    const styles = stylesheet;
    const formatted = formatRelativeTimeShort(props.atMs, props.nowMs);
    return (
        <Text testID={props.testID} style={[styles.text, Typography.tabular()]}>
            {formatted}
        </Text>
    );
}
