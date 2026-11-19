import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { AppRailBadge } from '@/components/navigation/shell/appRail/AppRailBadge';

import { useNotchPlanePaint } from './notch/NotchShape';

const NEEDS_YOU_DOT = Object.freeze({ kind: 'dot', tone: 'attention' } as const);

/**
 * The island's one needs-you mark (taste R2 N2/N5): any identity glyph, centred in a fixed slot, with the
 * rail's dot anchored to that slot, not to the glyph. A Bot face and an Agent mark of different sizes then
 * carry their dot on the same column line, and a row and its rest mark read the same. The dot's ring is cut
 * from the island's plane paint.
 */
export function DesktopActivityOverlayNeedsYouMark(props: React.PropsWithChildren<Readonly<{
    slotSize: number;
    needsYou: boolean;
    testID?: string;
}>>): React.ReactElement {
    const plane = useNotchPlanePaint();
    return (
        <View testID={props.testID} style={[styles.slot, { width: props.slotSize, height: props.slotSize }]}>
            {props.children}
            {props.needsYou ? (
                <AppRailBadge
                    testID={props.testID ? `${props.testID}-needs-you` : undefined}
                    signal={NEEDS_YOU_DOT}
                    glyphSizePx={props.slotSize}
                    corner="bottomRight"
                    ringColor={plane}
                />
            ) : null}
        </View>
    );
}

const styles = StyleSheet.create(() => ({
    slot: {
        flexShrink: 0,
        alignItems: 'center',
        justifyContent: 'center',
    },
}));
