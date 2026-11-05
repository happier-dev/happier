import * as React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { motionTokens } from '@/components/ui/motion/motionTokens';
import { SELECTION_LIST_CARD_CONTENT_INSET_PX } from '@/components/ui/selectionList/_constants';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { OPTION_PICKER_LIST_TEXT_INSET_PX, OptionPickerSelectedControlsContext } from './optionPickerSelectedControlsState';

type WebHoverablePressableState = Readonly<{ pressed: boolean; hovered?: boolean }>;

/**
 * An entry of a picker pane that is not one of its options (Custom…, another source): it shares the option
 * cards' edge, text and hover, so the pane reads as one list.
 */
export const OptionPickerPaneRow = React.forwardRef<React.ElementRef<typeof Pressable>, Readonly<{
    testID: string;
    accessibilityLabel: string;
    title: string;
    description?: string;
    trailing?: React.ReactNode;
    onPress: () => void;
}>>(function OptionPickerPaneRow(props, ref) {
    const { multiColumn } = React.useContext(OptionPickerSelectedControlsContext);
    return (
        <Pressable
            ref={ref}
            testID={props.testID}
            accessibilityRole="button"
            accessibilityLabel={props.accessibilityLabel}
            onPress={props.onPress}
            style={(state) => [
                optionPickerPaneRowStyles.row,
                multiColumn ? null : optionPickerPaneRowStyles.rowInList,
                (state as WebHoverablePressableState).hovered === true ? styles.hovered : null,
                state.pressed ? styles.pressed : null,
            ]}
        >
            <OptionPickerPaneRowContent title={props.title} description={props.description} trailing={props.trailing} />
        </Pressable>
    );
});

export function OptionPickerPaneRowContent(props: Readonly<{
    title: string;
    titleSelected?: boolean;
    description?: string;
    trailing?: React.ReactNode;
}>) {
    return (
        <View style={styles.content}>
            <View style={styles.text}>
                <Text numberOfLines={1} style={[styles.title, props.titleSelected ? styles.titleSelected : null]}>{props.title}</Text>
                {props.description ? <Text style={styles.description}>{props.description}</Text> : null}
            </View>
            {props.trailing}
        </View>
    );
}

export const optionPickerPaneRowStyles = StyleSheet.create((theme) => ({
    row: {
        borderRadius: 12,
        paddingHorizontal: SELECTION_LIST_CARD_CONTENT_INSET_PX,
        paddingVertical: SELECTION_LIST_CARD_CONTENT_INSET_PX,
    },
    rowInList: { paddingHorizontal: OPTION_PICKER_LIST_TEXT_INSET_PX },
    selected: { backgroundColor: theme.colors.surface.selected },
}));

const styles = StyleSheet.create((theme) => ({
    hovered: { backgroundColor: theme.colors.surface.hover },
    pressed: { opacity: motionTokens.press.opacitySubtle },
    content: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: theme.space.s12 },
    text: { flex: 1, minWidth: 0 },
    title: { fontSize: 14, color: theme.colors.text.primary },
    titleSelected: { ...Typography.default('semiBold') },
    description: { fontSize: 12, color: theme.colors.text.secondary },
}));
