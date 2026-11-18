import type { ReactNode } from 'react';
import { View } from 'react-native';

import { HappierText } from '../text/Text.js';

/**
 * A count that needs the person speaks in its tone (lab svcApps "3 need you", monitoring-1115 "1 down · 1 slow"): the
 * rest of the line stays quiet. Only the two tones a state can need you in.
 */
export type HappierPageCountTone = 'danger' | 'warning';

/**
 * One part of a page's count line, already saying its number in words ("12 Machines"), or that part with the tone it
 * speaks in; absent parts drop out.
 */
export type HappierPageCountPart = string | Readonly<{ text: string; tone: HappierPageCountTone }> | null | undefined | false;

type ShownPart = Readonly<{ text: string; tone: HappierPageCountTone | null }>;

function shownParts(parts: readonly HappierPageCountPart[]): ShownPart[] {
  const shown: ShownPart[] = [];
  for (const part of parts) {
    if (typeof part === 'string') { if (part.trim().length > 0) shown.push({ text: part, tone: null }); }
    else if (part && part.text.trim().length > 0) shown.push(part);
  }
  return shown;
}

/**
 * The page's count line from its owner's reported counts ("12 Machines · 3 online"): each part already says its
 * number in words; an absent or empty part drops out, and no part means no line. Pages never count for it.
 */
export function formatHappierPageCount(parts: readonly HappierPageCountPart[]): string | null {
  const shown = shownParts(parts);
  return shown.length > 0 ? shown.map((part) => part.text).join(' · ') : null;
}

/**
 * How the line's words are drawn: one line, meta step, secondary ink, tabular figures. Without `tone` it draws the
 * whole line (`text` may hold the spans of the parts that speak); with `tone` it draws one such span inside that line,
 * in the tone's ink. A host binds its own text owner for both, so the tones are its theme's.
 */
export type HappierPageCountLineTextRender = (input: Readonly<{ text: ReactNode; tone?: HappierPageCountTone; testID?: string }>) => ReactNode;

const renderDefaultText: HappierPageCountLineTextRender = (input) => input.tone ? (
  <HappierText tone={input.tone}>{input.text}</HappierText>
) : (
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
 * page header draw. One quiet meta line in tabular figures, where only a count that needs the person speaks in its
 * tone; its reserved empty place while the counts are read; otherwise nothing.
 */
export function HappierPageCountLine(props: HappierPageCountLineProps) {
  const renderText = props.renderText ?? renderDefaultText;
  const shown = shownParts(props.parts);
  if (shown.length > 0) {
    const text: ReactNode = shown.some((part) => part.tone !== null)
      ? shown.map((part, index) => (
        <HappierCountPartText key={index} part={part} lead={index > 0} renderText={renderText} />
      ))
      : shown.map((part) => part.text).join(' · ');
    return renderText(props.testID === undefined ? { text } : { text, testID: props.testID });
  }
  if (props.pending !== true) return null;
  return (
    <View aria-hidden accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {renderText({ text: ' ' })}
    </View>
  );
}

function HappierCountPartText(props: Readonly<{ part: ShownPart; lead: boolean; renderText: HappierPageCountLineTextRender }>) {
  const separator = props.lead ? ' · ' : '';
  if (props.part.tone === null) return <>{separator}{props.part.text}</>;
  return <>{separator}{props.renderText({ text: props.part.text, tone: props.part.tone })}</>;
}
