import { isMobileLayoutWidth } from '@/components/sessions/layout/isMobileLayoutWidth';

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

/**
 * From the composer card's edge to its content: the typed line, the status line's dot and its last instrument, and
 * the icon of a chrome-free notice above the composer all stand on it.
 */
export function resolveComposerCardContentInsetX(theme: Readonly<{ space: Readonly<{ s20: number }> }>, screenWidth: number): number {
    return isMobileLayoutWidth(screenWidth) ? COMPOSER_PHONE_CARD_CONTENT_INSET : theme.space.s20;
}
