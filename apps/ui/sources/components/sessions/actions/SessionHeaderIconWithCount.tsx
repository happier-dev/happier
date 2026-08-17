import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';

/**
 * A header glyph with a count riding its top-right corner.
 *
 * Two header actions carry a count. The automations button already overlaid it; the subagents button
 * set it beside the glyph instead, which made that one control twice as wide as its neighbours and
 * pushed the row out of rhythm. A count is an annotation on the thing it counts, so it sits on it.
 *
 * The badge is deliberately small and fully rounded: at 16pt tall an 8pt radius is a capsule, which
 * is what a count bubble should be — the app's 8pt badge rule and a round counter agree here rather
 * than conflict.
 */

const BADGE_HEIGHT_PX = 16;

export type SessionHeaderIconWithCountProps = Readonly<{
    children: React.ReactNode;
    count: number;
    /** Defaults to the accent colour; an attention-seeking count can pass the error colour. */
    badgeColor?: string;
}>;

export const SessionHeaderIconWithCount = React.memo((props: SessionHeaderIconWithCountProps) => {
    const { theme } = useUnistyles();

    return (
        <View style={{ position: 'relative', alignItems: 'center', justifyContent: 'center' }}>
            {props.children}
            {props.count > 0 ? (
                <View
                    pointerEvents="none"
                    style={{
                        position: 'absolute',
                        top: -6,
                        right: -10,
                        minWidth: BADGE_HEIGHT_PX,
                        height: BADGE_HEIGHT_PX,
                        paddingHorizontal: 4,
                        borderRadius: BADGE_HEIGHT_PX / 2,
                        alignItems: 'center',
                        justifyContent: 'center',
                        backgroundColor: props.badgeColor ?? theme.colors.accent.blue,
                    }}
                >
                    <Text
                        numberOfLines={1}
                        style={{
                            color: theme.colors.surface.base,
                            fontSize: 10,
                            lineHeight: 13,
                            ...Typography.default('semiBold'),
                        }}
                    >
                        {props.count}
                    </Text>
                </View>
            ) : null}
        </View>
    );
});

SessionHeaderIconWithCount.displayName = 'SessionHeaderIconWithCount';
