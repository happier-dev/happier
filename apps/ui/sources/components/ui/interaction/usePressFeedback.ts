import * as React from 'react';
import { Platform } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

/**
 * Press, hover and selection feedback for any pressable surface.
 *
 * **Tint the surface; never dim the content.** The idiom this replaces — `opacity: pressed ? 0.7 : 1`
 * — reads as a design convention but is a measured accessibility failure: it drops `text.secondary`
 * to 2.87:1 in light and 2.95:1 in dark, under the 4.5:1 its own token registry declares. Opacity
 * multiplies the CONTENT, so every glyph and label in the pressed subtree loses contrast at once.
 * A background tint moves only the layer behind the content and leaves the ink at full strength.
 * `pressFeedbackContrast.test.ts` measures both and is the gate.
 *
 * Disabled dimming is a different thing and is left to the caller: WCAG exempts inactive
 * components from contrast minimums, and the three canonical controls each already carry their own
 * disabled opacity. Nothing here changes them.
 */

/**
 * The only fills this mechanism may paint. It is a closed list so the contrast gate can enumerate
 * it, and so "press feedback" can never quietly become an opacity again.
 */
export const PRESS_FEEDBACK_SURFACE_TOKEN_IDS = [
    'surface.pressed',
    'surface.selected',
    'surface.pressedOverlay',
] as const;

export type PressFeedbackSurfaceTokenId = typeof PRESS_FEEDBACK_SURFACE_TOKEN_IDS[number];

/**
 * `row` is a full-bleed list row: iOS paints its own overlay, Android and web let the ripple carry
 * the press, and a selected row outranks a hover so it does not flicker under the pointer.
 * `control` is a bounded button: it always paints its own press, and hover outranks selection
 * because a toggled-on control still has to acknowledge the pointer.
 */
export type PressFeedbackTone = 'row' | 'control';

export type PressFeedbackPlatform = 'ios' | 'android' | 'web';

export type PressFeedbackVisualState = Readonly<{
    pressed?: boolean;
    hovered?: boolean;
}>;

export type PressFeedbackOptions = Readonly<{
    tone?: PressFeedbackTone;
    disabled?: boolean;
    /** A persistently selected row, or a control that is toggled on. */
    selected?: boolean;
}>;

export type PressFeedback = Readonly<{
    /**
     * The fill for a given interaction state, or `undefined` when the surface should keep whatever
     * the caller painted. Never an opacity — that is the whole point of this module.
     */
    resolveBackgroundColor: (state?: PressFeedbackVisualState) => string | undefined;
    /** Android/web ripple ink, for the hosts that hand their own ripple config to `Pressable`. */
    rippleColor: string;
}>;

export function resolvePressFeedbackSurfaceTokenId(params: Readonly<{
    tone: PressFeedbackTone;
    platform: PressFeedbackPlatform;
    pressed: boolean;
    hovered: boolean;
    selected: boolean;
    disabled: boolean;
}>): PressFeedbackSurfaceTokenId | null {
    if (params.disabled) return null;

    if (params.tone === 'row') {
        // Android and web paint the press with a ripple, so a second fill would double it up.
        if (params.pressed && params.platform === 'ios') return 'surface.pressedOverlay';
        if (params.selected) return 'surface.selected';
        if (params.hovered) return 'surface.pressed';
        return null;
    }

    if (params.pressed) return 'surface.selected';
    if (params.hovered) return 'surface.pressed';
    if (params.selected) return 'surface.pressed';
    return null;
}

export function resolvePressFeedbackPlatform(): PressFeedbackPlatform {
    if (Platform.OS === 'ios') return 'ios';
    if (Platform.OS === 'android') return 'android';
    return 'web';
}

export function usePressFeedback(options: PressFeedbackOptions = {}): PressFeedback {
    const { theme } = useUnistyles();
    const tone = options.tone ?? 'control';
    const disabled = options.disabled ?? false;
    const selected = options.selected ?? false;
    const platform = resolvePressFeedbackPlatform();

    const surfacePressed = theme.colors.surface.pressed;
    const surfaceSelected = theme.colors.surface.selected;
    const surfacePressedOverlay = theme.colors.surface.pressedOverlay;
    const rippleColor = theme.colors.surface.ripple;

    return React.useMemo(() => {
        const fillByTokenId: Record<PressFeedbackSurfaceTokenId, string> = {
            'surface.pressed': surfacePressed,
            'surface.selected': surfaceSelected,
            'surface.pressedOverlay': surfacePressedOverlay,
        };

        return {
            resolveBackgroundColor: (state?: PressFeedbackVisualState) => {
                const tokenId = resolvePressFeedbackSurfaceTokenId({
                    tone,
                    platform,
                    pressed: state?.pressed ?? false,
                    hovered: state?.hovered ?? false,
                    selected,
                    disabled,
                });
                return tokenId === null ? undefined : fillByTokenId[tokenId];
            },
            rippleColor,
        };
    }, [
        disabled,
        platform,
        rippleColor,
        selected,
        surfacePressed,
        surfacePressedOverlay,
        surfaceSelected,
        tone,
    ]);
}
