import * as React from 'react';
import { Platform, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { NATIVE_ACTION_CHIP_GAP_Y } from './agentInputChromeStyles';

/**
 * A reading card's chip line: the engine, then the card's own chips (Step options). Each group is
 * sized to its chips, so on a narrow card the second group moves under the first instead of the
 * engine being squeezed to "Choos…" beside it (DESIGN-9 N34). On a wide card the engine group takes
 * the rest of the line and the card's chips sit at its end.
 */
export function AgentInputReadOnlyChipRow(props: Readonly<{
    engine: readonly React.ReactNode[];
    chips: readonly React.ReactNode[];
    testID?: string;
}>): React.ReactElement {
    return (
        <View testID={props.testID} style={styles.row}>
            <View testID={props.testID === undefined ? undefined : `${props.testID}-engine`} style={[styles.group, styles.engine]}>
                {props.engine}
            </View>
            <View testID={props.testID === undefined ? undefined : `${props.testID}-chips`} style={styles.group}>
                {props.chips}
            </View>
        </View>
    );
}

const styles = StyleSheet.create(() => ({
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        flexWrap: 'wrap',
        rowGap: 4,
    },
    /**
     * Content-sized: a zero basis (`flex: 1`) would make the line never wrap, so the engine group
     * shrank to whatever Step options left it.
     */
    group: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        flexGrow: 0,
        flexShrink: 1,
        flexBasis: 'auto',
        minWidth: 0,
        overflow: 'visible',
        ...(Platform.OS === 'web' ? { columnGap: 6, rowGap: 1 } : { marginBottom: -NATIVE_ACTION_CHIP_GAP_Y }),
    },
    /** On a shared line the engine takes the rest, so Step options sit at the line's end. */
    engine: {
        flexGrow: 1,
    },
}));
