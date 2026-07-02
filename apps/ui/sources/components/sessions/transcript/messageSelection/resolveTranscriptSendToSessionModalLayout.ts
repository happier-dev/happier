import { resolveModalCardDimensions } from '@/modal/components/card/useModalCardDimensions';

export const TRANSCRIPT_SEND_TO_SESSION_MODAL_WIDTH = 560;
export const TRANSCRIPT_SEND_TO_SESSION_MODAL_SIZE = 'md' as const;
export const TRANSCRIPT_SEND_TO_SESSION_MODAL_DEFAULT_MAX_HEIGHT_RATIO = 0.88;
export const TRANSCRIPT_SEND_TO_SESSION_MODAL_MIN_KEYBOARD_MAX_HEIGHT_RATIO = 0.42;
export const TRANSCRIPT_SEND_TO_SESSION_MODAL_VIEWPORT_VERTICAL_MARGIN = 48;
export const TRANSCRIPT_SEND_TO_SESSION_MODAL_DEFAULT_LIST_MAX_HEIGHT = 360;
export const TRANSCRIPT_SEND_TO_SESSION_MODAL_MIN_LIST_MAX_HEIGHT = 160;
export const TRANSCRIPT_SEND_TO_SESSION_MODAL_RESERVED_NON_LIST_HEIGHT = 112;

export type TranscriptSendToSessionModalLayout = Readonly<{
    maxHeightRatio: number;
    listMaxHeight: number;
}>;

function normalizePositiveFinite(value: number | null | undefined): number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}

export function resolveTranscriptSendToSessionModalLayout(input: Readonly<{
    windowWidth?: number;
    windowHeight: number;
    keyboardHeight: number;
}>): TranscriptSendToSessionModalLayout {
    const windowWidth = normalizePositiveFinite(input.windowWidth) || TRANSCRIPT_SEND_TO_SESSION_MODAL_WIDTH;
    const windowHeight = normalizePositiveFinite(input.windowHeight);
    const keyboardHeight = Math.min(normalizePositiveFinite(input.keyboardHeight), windowHeight);

    if (windowHeight <= 0) {
        return {
            maxHeightRatio: TRANSCRIPT_SEND_TO_SESSION_MODAL_DEFAULT_MAX_HEIGHT_RATIO,
            listMaxHeight: TRANSCRIPT_SEND_TO_SESSION_MODAL_DEFAULT_LIST_MAX_HEIGHT,
        };
    }

    const availableHeight = keyboardHeight > 0
        ? Math.max(
            0,
            windowHeight - keyboardHeight - TRANSCRIPT_SEND_TO_SESSION_MODAL_VIEWPORT_VERTICAL_MARGIN * 2,
        )
        : windowHeight;
    const maxHeightRatio = keyboardHeight > 0
        ? clamp(
            availableHeight / windowHeight,
            TRANSCRIPT_SEND_TO_SESSION_MODAL_MIN_KEYBOARD_MAX_HEIGHT_RATIO,
            TRANSCRIPT_SEND_TO_SESSION_MODAL_DEFAULT_MAX_HEIGHT_RATIO,
        )
        : TRANSCRIPT_SEND_TO_SESSION_MODAL_DEFAULT_MAX_HEIGHT_RATIO;
    const cardMaxHeight = resolveModalCardDimensions(
        { width: windowWidth, height: windowHeight },
        {
            width: TRANSCRIPT_SEND_TO_SESSION_MODAL_WIDTH,
            maxHeightRatio,
            size: TRANSCRIPT_SEND_TO_SESSION_MODAL_SIZE,
        },
    ).maxHeight;
    const listMaxHeight = clamp(
        Math.floor(cardMaxHeight - TRANSCRIPT_SEND_TO_SESSION_MODAL_RESERVED_NON_LIST_HEIGHT),
        TRANSCRIPT_SEND_TO_SESSION_MODAL_MIN_LIST_MAX_HEIGHT,
        cardMaxHeight,
    );

    return {
        maxHeightRatio,
        listMaxHeight,
    };
}
