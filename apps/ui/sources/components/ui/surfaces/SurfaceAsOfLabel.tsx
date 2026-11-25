import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Icon } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import { formatAsOfTime } from '@/utils/time/formatAsOfTime';

/** "As of 10:42": when retained facts were read. Quiet, in a section's metadata slot. */
export function SurfaceAsOfLabel(props: Readonly<{
    at: number;
    testID?: string;
    /** Squeezed beside other controls, the time yields first on one line (the composer popover header, r227 #72). */
    yieldsFirst?: boolean;
}>) {
    const { theme } = useUnistyles();
    return (
        <View testID={props.testID} style={[stylesheet.row, props.yieldsFirst ? stylesheet.yielding : null]}>
            <Icon name="clock" size={12} color={theme.colors.text.tertiary} />
            <Text style={[stylesheet.text, props.yieldsFirst ? stylesheet.yieldingText : null]}
                {...(props.yieldsFirst ? { numberOfLines: 1 } : {})}>{t('settingsOverview.asOf', { time: formatAsOfTime(props.at) })}</Text>
        </View>
    );
}

const stylesheet = StyleSheet.create((theme) => ({
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s4,
    },
    yielding: { flexShrink: 1, minWidth: 0 },
    text: {
        color: theme.colors.text.secondary,
        fontSize: 12,
        lineHeight: 16,
        fontVariant: ['tabular-nums'],
    },
    yieldingText: { flexShrink: 1 },
}));
