import * as React from 'react';
import { Platform, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { AGENT_INPUT_ACTION_CHIP_GAP_X, AGENT_INPUT_FIELD_TO_CHIP_RAIL_GAP_PX, NATIVE_ACTION_CHIP_GAP_Y } from './agentInputChromeStyles';

/**
 * A reading card's resolved control line. The primary and secondary groups receive already ordered
 * nodes; the composer placement owner decides membership. Each group is sized to its controls, so
 * on a narrow card the second group moves under the first instead of squeezing its labels
 * (DESIGN-9 N34). On a wide card the first group takes the rest of the line and the second sits at its end.
 * The card's own action (a Run review's Start) is not a chip: it keeps the card's trailing edge, where
 * Send sits, also when the chips wrap on a phone (FIN-DESIGN-ACCEPT-2 F13).
 */
export function AgentInputReadOnlyChipRow(props: Readonly<{
    engine: readonly React.ReactNode[];
    chips: readonly React.ReactNode[];
    trailing?: React.ReactNode;
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
            {props.trailing == null ? null : <View style={styles.trailing}>{props.trailing}</View>}
        </View>
    );
}

const styles = StyleSheet.create(() => ({
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        flexWrap: 'wrap',
        // The live composer's rhythm: the field-to-rail step above, rails one block below it.
        marginTop: AGENT_INPUT_FIELD_TO_CHIP_RAIL_GAP_PX,
        rowGap: NATIVE_ACTION_CHIP_GAP_Y,
        // With no + before it, the first chip's glyph starts on the text's edge (chip inset 10, text inset 8).
        marginLeft: -2,
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
        ...(Platform.OS === 'web' ? { columnGap: AGENT_INPUT_ACTION_CHIP_GAP_X, rowGap: NATIVE_ACTION_CHIP_GAP_Y } : { marginBottom: -NATIVE_ACTION_CHIP_GAP_Y }),
    },
    /** On a shared line the primary group takes the rest; the secondary group sits at its end. */
    engine: {
        flexGrow: 1,
    },
    trailing: {
        marginLeft: 'auto',
        flexShrink: 0,
    },
}));
