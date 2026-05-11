export const STORY_DECK_WIDE_CONTENT_HORIZONTAL_PADDING = 45;
export const STORY_DECK_WIDE_CONTENT_TOP_PADDING = 45;
export const STORY_DECK_WIDE_CONTENT_BOTTOM_PADDING = 30;
export const STORY_DECK_WIDE_MEDIA_TEXT_GAP = 48;
export const STORY_DECK_WIDE_MEDIA_MAX_SIZE = 370;
export const STORY_DECK_WIDE_MEDIA_MIN_SIZE = 280;
export const STORY_DECK_WIDE_DETAILS_MAX_WIDTH = 420;
export const STORY_DECK_WIDE_LIST_CONTENT_GAP = 30;
export const STORY_DECK_WIDE_LIST_ROW_BASIS = '47%';
export const STORY_DECK_WIDE_TITLE_FONT_SIZE = 32;
export const STORY_DECK_WIDE_TITLE_LINE_HEIGHT = 35;
export const STORY_DECK_WIDE_BODY_FONT_SIZE = 18;
export const STORY_DECK_WIDE_BODY_LINE_HEIGHT = 21;

export function resolveWideStoryDeckMediaSize(containerWidth: number): number {
    const availableWidth = Math.max(
        0,
        containerWidth
            - STORY_DECK_WIDE_CONTENT_HORIZONTAL_PADDING * 2
            - STORY_DECK_WIDE_MEDIA_TEXT_GAP,
    );

    if (availableWidth <= 0) return 0;

    return Math.min(
        STORY_DECK_WIDE_MEDIA_MAX_SIZE,
        Math.max(STORY_DECK_WIDE_MEDIA_MIN_SIZE, availableWidth * 0.5),
    );
}
