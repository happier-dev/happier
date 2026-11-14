import type { ReactNode } from 'react';
import { View } from 'react-native';

import { HappierText } from '../text/Text.js';

/** One part of a page's count line, already saying its number in words ("12 Machines"); absent parts drop out. */
export type HappierPageCountPart = string | null | undefined | false;

/**
 * The page's count line from its owner's reported counts ("12 Machines · 3 online"): each part already says its
 * number in words; an absent or empty part drops out, and no part means no line. Pages never count for it.
 */
export function formatHappierPageCount(parts: readonly HappierPageCountPart[]): string | null {
  const shown = parts.filter((part): part is string => typeof part === 'string' && part.trim().length > 0);
  return shown.length > 0 ? shown.join(' · ') : null;
}

/** How the line's words are drawn: one line, meta step, secondary ink, tabular figures. */
export type HappierPageCountLineTextRender = (input: Readonly<{ text: string; testID?: string }>) => ReactNode;

const renderDefaultText: HappierPageCountLineTextRender = (input) => (
  <HappierText testID={input.testID} variant="meta" tone="secondary" tabularNumbers numberOfLines={1}>
    {input.text}
  </HappierText>
);

export type HappierPageCountLineProps = Readonly<{
  parts: readonly HappierPageCountPart[];
  /** The counts are still being read: the line keeps its place, empty, so nothing moves when they arrive. */
  pending?: boolean;
  testID?: string;
  /** A same-realm host binds its own text owner (its type scale and font scaling); the rule stays this owner's. */
  renderText?: HappierPageCountLineTextRender;
}>;

/**
 * The page's count line, last before the body: the one owner both a core main screen's head and a plugin
 * page header draw. One quiet meta line in tabular figures; its reserved empty place while the counts are
 * read; otherwise nothing.
 */
export function HappierPageCountLine(props: HappierPageCountLineProps) {
  const renderText = props.renderText ?? renderDefaultText;
  const line = formatHappierPageCount(props.parts);
  if (line !== null) return renderText(props.testID === undefined ? { text: line } : { text: line, testID: props.testID });
  if (props.pending !== true) return null;
  return (
    <View aria-hidden accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {renderText({ text: ' ' })}
    </View>
  );
}
