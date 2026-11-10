/**
 * Horizontal inset (px) between the screen edge and the composer-area content:
 * the agent input panel and its auxiliary banners (`ComposerAuxiliaryFrame`).
 *
 * Matches the transcript message horizontal inset (`MessageView` user/agent/tool
 * containers, 16px) so the composer and its chrome line up with the messages
 * above them. Single source of truth for the composer-area edge alignment.
 */
export const COMPOSER_CONTENT_HORIZONTAL_INSET = 16;

/**
 * Phone only: from the composer card's edge to its content (the typed line and the first chip's glyph), so the
 * card stands on 16 and its content on 28 (phone lab D13). Desktop keeps the composer chrome's own anatomy.
 */
export const COMPOSER_PHONE_CARD_CONTENT_INSET = 12;
