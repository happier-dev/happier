import * as React from 'react';
import { Platform, Pressable, type StyleProp, type View, type ViewStyle } from 'react-native';

import { DeferredAnchoredTooltip } from './DeferredAnchoredTooltip';
import { useActionTooltip } from '@/components/ui/buttons/ActionTooltip';
import { useKeyboardShortcutLabel } from '@/keyboard/shortcutLabels';
import type { KeyboardCommandId } from '@/keyboard/types';
import { withShortcut } from '@/keyboard/withShortcut';

/**
 * Focusable help text, with no action unless the text itself is the control. A pointer shows it on hover and a
 * keyboard on focus (web); touch holds it above the finger for as long as a long press lasts (native).
 */
export function Tooltip(props: Readonly<{
    /** Empty: the host stays but shows no help text. */
    label: string;
    shortcutCommandId?: KeyboardCommandId;
    /** What assistive tech reads when the help text alone would drop the visible text it explains. */
    accessibilityLabel?: string;
    children: React.ReactNode;
    testID?: string;
    style?: StyleProp<ViewStyle>;
    /** The text is also a control (an id that copies on tap): the tooltip's own press target takes it, so it never swallows the tap. */
    onPress?: () => void;
    /** Off when this wraps a control: that control is the tab stop, and its focus still shows the tooltip. */
    focusable?: boolean;
    /** Hide the help text for now (for example while the wrapped control's own popover is open). */
    hidden?: boolean;
}>) {
    const shortcut = useKeyboardShortcutLabel(props.shortcutCommandId);
    const label = props.label === '' ? '' : withShortcut(props.label, shortcut);
    const anchorRef = React.useRef<View | null>(null);
    const [hovered, setHovered] = React.useState(false);
    const [focused, setFocused] = React.useState(false);
    const [held, setHeld] = React.useState(false);
    // A press on the wrapped control answers the pointer until it leaves, as on an IconButton.
    const { isVisible, onPressIn: suppress, onHoverOut: resetSuppression } = useActionTooltip(undefined, props.hidden);
    const touchReadout = Platform.OS !== 'web' && props.label !== '';
    return (
        <Pressable
            ref={anchorRef}
            testID={props.testID}
            accessibilityRole={props.onPress ? 'button' : 'text'}
            onPress={props.onPress}
            focusable={props.focusable}
            accessibilityLabel={props.accessibilityLabel ?? (label === '' ? undefined : label)}
            onHoverIn={() => setHovered(true)}
            onHoverOut={() => { setHovered(false); resetSuppression(); }}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            onLongPress={touchReadout ? () => setHeld(true) : undefined}
            onPressOut={touchReadout ? () => setHeld(false) : undefined}
            {...(Platform.OS === 'web' ? { onPointerDown: suppress } : {})}
            style={props.style}
        >
            {props.children}
            {Platform.OS === 'web' && props.label !== '' && isVisible({ hovered, focused }) ? (
                <DeferredAnchoredTooltip activationKey={`${hovered}:${focused}`} anchorRef={anchorRef} label={label} testID={props.testID ? `${props.testID}-tooltip` : undefined} />
            ) : null}
            {touchReadout && held ? (
                <DeferredAnchoredTooltip activationKey="held" anchorRef={anchorRef} label={label} placement="top" testID={props.testID ? `${props.testID}-tooltip` : undefined} />
            ) : null}
        </Pressable>
    );
}
