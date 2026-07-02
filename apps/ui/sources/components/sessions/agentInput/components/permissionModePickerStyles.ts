import type { StyleProp, TextStyle, ViewStyle } from 'react-native';

export type PermissionModePickerStyles = Readonly<{
    overlaySection: StyleProp<ViewStyle>;
    overlaySectionTitle: StyleProp<TextStyle>;
    overlayOptionRow: StyleProp<ViewStyle>;
    overlayOptionRowPressed: StyleProp<ViewStyle>;
    overlayRadioOuter: StyleProp<ViewStyle>;
    overlayRadioOuterSelected: StyleProp<ViewStyle>;
    overlayRadioOuterUnselected: StyleProp<ViewStyle>;
    overlayRadioInner: StyleProp<ViewStyle>;
    overlayOptionLabel: StyleProp<TextStyle>;
    overlayOptionLabelSelected: StyleProp<TextStyle>;
    overlayOptionLabelUnselected: StyleProp<TextStyle>;
    overlayOptionDescription: StyleProp<TextStyle>;
}>;
