/** The composer field's line, as a multiple of its type size, when its text style declares no line height. */
export const COMPOSER_EDITOR_LINE_HEIGHT_RATIO = 1.4;

/**
 * One line of the composer field in pixels, from its already-scaled type. The web field's box draws this
 * line (`composerEditorHostStyle.web.ts`), and the composer's layout owner reads it to know whether a line
 * still fits beside the attachment rail.
 */
export function resolveComposerEditorLineHeightPx(scaled: Readonly<{ fontSize?: number; lineHeight?: number }>): number {
  if (typeof scaled.lineHeight === 'number' && scaled.lineHeight > 0) return scaled.lineHeight;
  return (scaled.fontSize ?? 0) * COMPOSER_EDITOR_LINE_HEIGHT_RATIO;
}
