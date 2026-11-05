import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

/** The overlapping identity marks used in collaboration rows and headers. */
export type AvatarStackEntry = Readonly<{
    key: string;
    content: React.ReactNode;
    /** Only a real avatar has the separating ring; team and link glyphs stay bare. */
    avatar?: boolean;
    ringColor?: string;
    testID?: string;
}>;

export function AvatarStack(props: Readonly<{
    entries: readonly AvatarStackEntry[];
    size: number;
    testID?: string;
    ringColor?: string;
    accessibilityLabel?: string;
    /**
     * The marks share one leading slot of the avatar's own size, so a row's title keeps one edge whether it has a
     * glyph, one face or two. The first entry stands in the slot; the next peeks out behind it, into the row's inset.
     */
    slot?: boolean;
}>) {
    const { theme } = useUnistyles();
    const markOffset = (index: number) => props.slot ? { position: 'absolute' as const, top: 0, left: -2 - index * SLOT_PEEK_PX } : null;
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
                    borderColor: entry.ringColor ?? props.ringColor ?? theme.colors.surface.base,
                },
            ]}
        >{entry.content}</View>)}
    </View>;
}

/** How far a second face shows past the first in one slot: enough to read as a second person, no more. */
const SLOT_PEEK_PX = 6;

const styles = StyleSheet.create(() => ({
    stack: { flexDirection: 'row', alignItems: 'center' },
    mark: { alignItems: 'center', justifyContent: 'center' },
}));
