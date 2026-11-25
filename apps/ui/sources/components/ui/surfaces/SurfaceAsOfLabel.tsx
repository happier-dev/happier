import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Icon } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import { formatAsOfTime } from '@/utils/time/formatAsOfTime';

/** "As of 10:42": when retained facts were read. Quiet, in a section's metadata slot. */
export function SurfaceAsOfLabel(props: Readonly<{ at: number; testID?: string }>) {
    const { theme } = useUnistyles();
    return (
        <View testID={props.testID} style={stylesheet.row}>
            <Icon name="clock" size={12} color={theme.colors.text.tertiary} />
            <Text style={stylesheet.text} numberOfLines={1}>{t('settingsOverview.asOf', { time: formatAsOfTime(props.at) })}</Text>
        </View>
    );
}

const stylesheet = StyleSheet.create((theme) => ({
    // An as-of time is one line: squeezed beside other controls it ends in an ellipsis, never a second line.
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        flexShrink: 1,
        minWidth: 0,
        gap: theme.space.s4,
    },
    text: {
        flexShrink: 1,
        color: theme.colors.text.secondary,
        fontSize: 12,
        lineHeight: 16,
        fontVariant: ['tabular-nums'],
    },
}));
