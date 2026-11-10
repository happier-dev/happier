import { HappierPressable, type HappierPressableProps } from '@happier-dev/plugin-ui/presentation';
import * as React from 'react';
import { View } from 'react-native';

import { Icon, type IconName } from '@/components/ui/icons/Icon';
import { ChromeGlyph, ChromeGlyphEmphasisContext } from '@/components/ui/icons/chromeGlyphInk';
import { motionTokens } from '@/components/ui/motion/motionTokens';

import { SESSION_HEADER_ACTION_SIZE_PX, useSessionHeaderActionMetrics } from './sessionHeaderIconMetrics';

/** Half the gap the header keeps between its actions: neighbouring hit areas meet, never overlap. */
export function useSessionHeaderActionHitReach(): Readonly<{ left: number; right: number }> {
    const { gapPx } = useSessionHeaderActionMetrics();
    return React.useMemo(() => ({ left: gapPx / 2, right: gapPx / 2 }), [gapPx]);
}

/**
 * A session-header action's glyph at the header's size for the current pointer: shell chrome ink
 * (`useChromeGlyphInk`), or `color` when the glyph speaks for a state (a warning).
 */
export function SessionHeaderGlyph(props: Readonly<{ name: IconName; color?: string }>) {
    const size = useSessionHeaderActionMetrics().glyphPx;
    return props.color
        ? <Icon name={props.name} size={size} color={props.color} />
        : <ChromeGlyph name={props.name} size={size} />;
}

/** The session header's trailing actions in one row, one gap apart (`useSessionHeaderActionMetrics`). */
export function SessionHeaderActionsRow(props: Readonly<{ children: React.ReactNode }>) {
    const { gapPx } = useSessionHeaderActionMetrics();
    return <View style={{ flexDirection: 'row', alignItems: 'center', gap: gapPx }}>{props.children}</View>;
}

/**
 * A direct session-header action: the page's control-height square around the header glyph. The
 * square is the whole drawn box; a finger reaches 44 through the shared pressable's hit area.
 */
export const SessionHeaderActionButton = React.memo(function SessionHeaderActionButton(props: Readonly<{
    testID?: string;
    accessibilityLabel: string;
    onPress: HappierPressableProps['onPress'];
    disabled?: boolean;
    expanded?: boolean;
    controlRef?: HappierPressableProps['controlRef'];
    children: React.ReactNode;
}>) {
    const hitReach = useSessionHeaderActionHitReach();
    return (
        <HappierPressable
            testID={props.testID}
            accessibilityLabel={props.accessibilityLabel}
            onPress={props.onPress}
            disabled={props.disabled}
            expanded={props.expanded}
            controlRef={props.controlRef}
            hitReach={hitReach}
            style={(state) => ({
                width: SESSION_HEADER_ACTION_SIZE_PX,
                height: SESSION_HEADER_ACTION_SIZE_PX,
                alignItems: 'center',
                justifyContent: 'center',
                opacity: props.disabled === true ? 0.45 : state.pressed ? motionTokens.press.opacity : 1,
            })}
        >
            {(state) => (
                <ChromeGlyphEmphasisContext.Provider value={state.hovered || state.pressed || state.focused || props.expanded === true}>
                    {props.children}
                </ChromeGlyphEmphasisContext.Provider>
            )}
        </HappierPressable>
    );
});
