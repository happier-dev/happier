export const MIN_WEB_SOFTWARE_KEYBOARD_INSET_PX = 80;

export type WebVisualViewportKeyboardInsetParams = Readonly<{
    layoutViewportHeight: number;
    visualViewportHeight: number;
    visualViewportOffsetTop: number;
    isEditableElementFocused: boolean;
    isMobileLikeHost: boolean;
}>;

export function resolveWebVisualViewportKeyboardInset(params: WebVisualViewportKeyboardInsetParams): number {
    if (!params.isEditableElementFocused || !params.isMobileLikeHost) {
        return 0;
    }

    const layoutViewportHeight = Number(params.layoutViewportHeight);
    const visualViewportHeight = Number(params.visualViewportHeight);
    const visualViewportOffsetTop = Number(params.visualViewportOffsetTop);
    if (!Number.isFinite(layoutViewportHeight) || !Number.isFinite(visualViewportHeight) || !Number.isFinite(visualViewportOffsetTop)) {
        return 0;
    }

    const inset = Math.max(0, layoutViewportHeight - visualViewportHeight - visualViewportOffsetTop);
    if (inset < MIN_WEB_SOFTWARE_KEYBOARD_INSET_PX) {
        return 0;
    }

    return Math.round(inset);
}
