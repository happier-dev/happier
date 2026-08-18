export const MIN_WEB_SOFTWARE_KEYBOARD_INSET_PX = 80;
export const WEB_MOBILE_LIKE_MAX_VIEWPORT_WIDTH_PX = 768;

export function isWebMobileLikeViewportWidth(width: number): boolean {
    return Number.isFinite(width) && width > 0 && width < WEB_MOBILE_LIKE_MAX_VIEWPORT_WIDTH_PX;
}

/** True when the focused element can summon the software keyboard on a mobile web host. */
export function isWebKeyboardEditableElementFocused(doc: Pick<Document, 'activeElement'> | Document): boolean {
    const activeElement = doc?.activeElement;
    if (!activeElement) return false;
    const tagName = (activeElement.tagName ?? '').toLowerCase();
    return tagName === 'input' || tagName === 'textarea' || activeElement.getAttribute('contenteditable') === 'true';
}

export type WebVisualViewportKeyboardInsetParams = Readonly<{
    isEditableElementFocused: boolean;
    isMobileLikeHost: boolean;
    layoutViewportHeight: number;
    visualViewportHeight: number;
    visualViewportOffsetTop: number;
}>;

export function resolveWebVisualViewportKeyboardInset(params: WebVisualViewportKeyboardInsetParams): number {
    if (!params.isEditableElementFocused || !params.isMobileLikeHost) {
        return 0;
    }

    const layoutViewportHeight = Number(params.layoutViewportHeight);
    const visualViewportHeight = Number(params.visualViewportHeight);
    const visualViewportOffsetTop = Number(params.visualViewportOffsetTop);
    if (
        !Number.isFinite(layoutViewportHeight)
        || !Number.isFinite(visualViewportHeight)
        || !Number.isFinite(visualViewportOffsetTop)
    ) {
        return 0;
    }

    const inset = Math.max(0, layoutViewportHeight - visualViewportHeight - visualViewportOffsetTop);
    if (inset < MIN_WEB_SOFTWARE_KEYBOARD_INSET_PX) {
        return 0;
    }

    return Math.round(inset);
}
