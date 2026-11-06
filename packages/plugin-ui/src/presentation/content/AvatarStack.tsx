import * as React from 'react';
import { StyleSheet, View } from 'react-native';

/** The overlapping identity marks used in collaboration rows and headers. */
export type HappierAvatarStackEntry = Readonly<{
    key: string;
    content: React.ReactNode;
    /** Only a real avatar has the separating ring; team and link glyphs stay bare. */
    avatar?: boolean;
    ringColor?: string;
    testID?: string;
}>;

export type HappierAvatarStackProps = Readonly<{
    entries: readonly HappierAvatarStackEntry[];
    size: number;
    testID?: string;
    ringColor: string;
    accessibilityLabel?: string;
    /**
     * The marks share one leading slot of the avatar's own size, so a row's title keeps one edge whether it has a
     * glyph, one face or two. One mark fills the slot; two shrink to fit inside it, the first in front on the slot's
     * edge and the next peeking out behind it, so neither crosses the section label's edge or nears the title.
     */
    slot?: boolean;
}>;

export function HappierAvatarStack(props: HappierAvatarStackProps) {
    const shared = props.slot === true && props.entries.length > 1;
    const faceScale = shared ? (props.size - SLOT_PEEK_PX) / props.size : 1;
    // A mark's box is its face plus the 2 px ring; scaling keeps its centre, so its face's edge moves in by this much.
    const scaledEdge = 2 + (props.size * (1 - faceScale)) / 2;
    const markOffset = (index: number) => props.slot
        ? { position: 'absolute' as const, top: 0, left: index * SLOT_PEEK_PX - scaledEdge, ...(shared ? { transform: [{ scale: faceScale }] } : null) }
        : null;
    const entries = props.slot ? props.entries.map((entry, index) => ({ entry, index })).reverse() : props.entries.map((entry, index) => ({ entry, index }));
    return <View
        testID={props.testID}
        accessible={Boolean(props.accessibilityLabel)}
        accessibilityRole={props.accessibilityLabel ? 'image' : undefined}
        accessibilityLabel={props.accessibilityLabel}
        importantForAccessibility={props.accessibilityLabel ? undefined : 'no-hide-descendants'}
        style={[styles.stack, props.slot ? { width: props.size, height: props.size + 4 } : undefined]}
    >
        {entries.map(({ entry, index }) => <View
            key={entry.key}
            testID={entry.testID}
            accessible={false}
            style={[
                styles.mark,
                { width: props.size + 4, height: props.size + 4 },
                props.slot ? markOffset(index) : { marginLeft: index === 0 ? 0 : -6 },
                entry.avatar === false ? null : {
                    borderRadius: props.size / 2 + 2,
                    borderWidth: 2,
                    borderColor: entry.ringColor ?? props.ringColor,
                },
            ]}
        >{entry.content}</View>)}
    </View>;
}

/** How far a second face shows past the first in one slot: enough to read as a second person, no more. */
const SLOT_PEEK_PX = 4;

const styles = StyleSheet.create({
    stack: { flexDirection: 'row', alignItems: 'center' },
    mark: { alignItems: 'center', justifyContent: 'center' },
});
