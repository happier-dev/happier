import * as React from 'react';
import { Platform, Pressable, type StyleProp, type View, type ViewStyle } from 'react-native';

import { DeferredAnchoredTooltip } from './DeferredAnchoredTooltip';

/** Focusable help text, with no action unless the text itself is the control. */
export function Tooltip(props: Readonly<{
    /** Empty: the host stays but shows no help text. */
    label: string;
    /** What assistive tech reads when the help text alone would drop the visible text it explains. */
    accessibilityLabel?: string;
    children: React.ReactNode;
    testID?: string;
    style?: StyleProp<ViewStyle>;
    /** The text is also a control (an id that copies on tap): the tooltip's own press target takes it, so it never swallows the tap. */
    onPress?: () => void;
    /** Off when this wraps a control: that control is the tab stop, and its focus still shows the tooltip. */
    focusable?: boolean;
}>) {
    const anchorRef = React.useRef<View | null>(null);
    const [hovered, setHovered] = React.useState(false);
    const [focused, setFocused] = React.useState(false);
    return (
        <Pressable
            ref={anchorRef}
            testID={props.testID}
            accessibilityRole={props.onPress ? 'button' : 'text'}
            onPress={props.onPress}
            focusable={props.focusable}
            accessibilityLabel={props.accessibilityLabel ?? (props.label === '' ? undefined : props.label)}
            onHoverIn={() => setHovered(true)}
            onHoverOut={() => setHovered(false)}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            style={props.style}
        >
            {props.children}
            {Platform.OS === 'web' && props.label !== '' && (hovered || focused) ? (
                <DeferredAnchoredTooltip activationKey={`${hovered}:${focused}`} anchorRef={anchorRef} label={props.label} testID={props.testID ? `${props.testID}-tooltip` : undefined} />
            ) : null}
        </Pressable>
    );
}
