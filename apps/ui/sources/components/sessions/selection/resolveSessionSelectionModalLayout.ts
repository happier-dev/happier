import { resolveModalCardDimensions } from '@/modal/components/card/useModalCardDimensions';

export const SESSION_SELECTION_MODAL_WIDTH = 560;
export const SESSION_SELECTION_MODAL_SIZE = 'md' as const;
export const SESSION_SELECTION_MODAL_DEFAULT_MAX_HEIGHT_RATIO = 0.88;
export const SESSION_SELECTION_MODAL_MIN_KEYBOARD_MAX_HEIGHT_RATIO = 0.42;
export const SESSION_SELECTION_MODAL_VIEWPORT_VERTICAL_MARGIN = 48;
export const SESSION_SELECTION_MODAL_DEFAULT_LIST_MAX_HEIGHT = 360;
export const SESSION_SELECTION_MODAL_MIN_LIST_MAX_HEIGHT = 160;
export const SESSION_SELECTION_MODAL_RESERVED_NON_LIST_HEIGHT = 112;

export type SessionSelectionModalLayout = Readonly<{
    maxHeightRatio: number;
    listMaxHeight: number;
}>;

function normalizePositiveFinite(value: number | null | undefined): number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}

export function resolveSessionSelectionModalLayout(input: Readonly<{
    windowWidth?: number;
    windowHeight: number;
    keyboardHeight: number;
}>): SessionSelectionModalLayout {
    const windowWidth = normalizePositiveFinite(input.windowWidth) || SESSION_SELECTION_MODAL_WIDTH;
    const windowHeight = normalizePositiveFinite(input.windowHeight);
    const keyboardHeight = Math.min(normalizePositiveFinite(input.keyboardHeight), windowHeight);

    if (windowHeight <= 0) {
        return {
            maxHeightRatio: SESSION_SELECTION_MODAL_DEFAULT_MAX_HEIGHT_RATIO,
            listMaxHeight: SESSION_SELECTION_MODAL_DEFAULT_LIST_MAX_HEIGHT,
        };
    }

    const availableHeight = keyboardHeight > 0
        ? Math.max(
            0,
            windowHeight - keyboardHeight - SESSION_SELECTION_MODAL_VIEWPORT_VERTICAL_MARGIN * 2,
        )
        : windowHeight;
    const maxHeightRatio = keyboardHeight > 0
        ? clamp(
            availableHeight / windowHeight,
            SESSION_SELECTION_MODAL_MIN_KEYBOARD_MAX_HEIGHT_RATIO,
            SESSION_SELECTION_MODAL_DEFAULT_MAX_HEIGHT_RATIO,
        )
        : SESSION_SELECTION_MODAL_DEFAULT_MAX_HEIGHT_RATIO;
    const cardMaxHeight = resolveModalCardDimensions(
        { width: windowWidth, height: windowHeight },
        {
            width: SESSION_SELECTION_MODAL_WIDTH,
            maxHeightRatio,
            size: SESSION_SELECTION_MODAL_SIZE,
        },
    ).maxHeight;
    const listMaxHeight = clamp(
        Math.floor(cardMaxHeight - SESSION_SELECTION_MODAL_RESERVED_NON_LIST_HEIGHT),
        SESSION_SELECTION_MODAL_MIN_LIST_MAX_HEIGHT,
        cardMaxHeight,
    );

    return {
        maxHeightRatio,
        listMaxHeight,
    };
}
