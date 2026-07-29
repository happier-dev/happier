import { Platform } from 'react-native';

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
 * Corner radius shared by every bounded surface in the composer stack: the agent input panel and
 * the auxiliary banners stacked above it. They are peers in one column, so they round alike;
 * controls nested inside them derive a concentric radius from this value minus their inset.
 */
export const COMPOSER_SURFACE_RADIUS = Platform.select({ default: 16, android: 20 }) as number;
