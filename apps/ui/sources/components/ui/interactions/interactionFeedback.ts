import { happierFocusRingStyle, type HappierFocusRingPlacement } from '@happier-dev/plugin-ui/presentation';

/**
 * The one focus ring (`happierFocusRingStyle`: 2px of the focus colour, a 2px page-coloured gap,
 * following the control's radius) for a control whose ring shows. A `HappierPressable`'s `focused`
 * already is that decision; a raw pressable narrows its own flag with `resolveHappierFocusRingVisible`
 * (or `isHappierFocusVisible` on focus) so pointer focus never paints it.
 */
export function focusRingStyle(params: Readonly<{
    focused: boolean;
    color: string;
    placement?: HappierFocusRingPlacement;
}>): ReturnType<typeof happierFocusRingStyle> {
    return happierFocusRingStyle({ visible: params.focused, color: params.color, placement: params.placement });
}
