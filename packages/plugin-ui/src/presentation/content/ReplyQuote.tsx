import type { ComponentType, ReactElement, ReactNode } from 'react';
import { View } from 'react-native';

import type { HappierPortableStyle } from '../portableTypes.js';

import { HAPPIER_RADIUS_V1 } from '../../environment/radius.js';
import { HAPPIER_SPACE_STEPS } from '../../environment/spacing.js';
import { HappierPressable } from '../interaction/Pressable.js';
import { happierFocusRingStyle } from '../interaction/focusVisible.js';

/** Presentation facts only: the caller admits the source and owns navigation. */
export type HappierReplyQuoteSource = Readonly<{
  state: 'available';
  label: string;
  text: string;
  detail?: string;
  onPress?: () => void;
  accessibilityLabel?: string;
}> | Readonly<{
  state: 'unavailable';
  label: string;
  reason: string;
}>;

export type HappierReplyQuoteTextProps = Readonly<{
  role: 'source' | 'quote' | 'detail';
  color: string;
  testID?: string;
  /** The quote is one line: a reminder of what is answered, not a second copy of it. */
  numberOfLines?: number;
  style?: HappierPortableStyle;
  children: ReactNode;
}>;

export type HappierReplyQuoteProps = Readonly<{
  testID?: string;
  source: HappierReplyQuoteSource;
  leading?: ReactNode;
  Text: ComponentType<HappierReplyQuoteTextProps>;
  colors: Readonly<{
    text: string; secondaryText: string; border: string; focus: string;
    /** A passage's fill: the host's quiet inset surface, a hair off the page. */
    passage?: string;
  }>;
  space?: Readonly<Record<'s2' | 's6' | 's8', number> & Partial<Record<'s10' | 's12', number>>>;
  /** A passage box's corner; defaults to the shared base step. */
  radius?: number;
  /**
   * `reply` (default): one line of mark, source and words on a left rule. `passage`: the quoted words
   * alone, up to two lines, in their own filled box (lab T3-A), where the surface already names the
   * source (a second opinion on one answer, a note on selected messages).
   */
  form?: 'reply' | 'passage';
}>;

/**
 * One quiet source quote before a reply, shared by core, Doc threads and plugins (lab T2-A):
 * one line of mark, source and the quoted words, cut to the line; pressing it opens the source.
 */
export function HappierReplyQuote(props: HappierReplyQuoteProps): ReactElement {
  const { Text, colors, source } = props;
  const space = props.space ?? HAPPIER_SPACE_STEPS;
  const boxed = props.form === 'passage';
  // A reply's quote is a rule beside the words; a passage is the words themselves, set in a filled box.
  const frame = boxed
    ? { borderRadius: props.radius ?? HAPPIER_RADIUS_V1.lg, backgroundColor: colors.passage,
      paddingHorizontal: space.s12 ?? HAPPIER_SPACE_STEPS.s12, paddingVertical: space.s10 ?? HAPPIER_SPACE_STEPS.s10,
      gap: space.s2, minWidth: 0 }
    : { borderLeftWidth: 2, borderLeftColor: colors.border,
      paddingHorizontal: space.s8, paddingVertical: space.s2, gap: space.s2, minWidth: 0 };
  const passage = boxed && source.state === 'available';
  const content = <>
    <View style={{ flexDirection: 'row', alignItems: passage ? 'flex-start' : 'center', gap: space.s6, minWidth: 0 }}>
      {props.leading}
      {passage ? null : <Text role="source" color={colors.text} numberOfLines={1} style={{ flexShrink: 0, maxWidth: '45%' }}>{source.label}</Text>}
      {source.state === 'available'
        ? <Text role="quote" color={colors.secondaryText} numberOfLines={passage ? 2 : 1} style={{ flexShrink: 1, minWidth: 0 }}
            testID={props.testID ? `${props.testID}.text` : undefined}>{passage ? passageWords(source.text) : source.text}</Text>
        : <Text role="detail" color={colors.secondaryText} numberOfLines={1} style={{ flexShrink: 1, minWidth: 0 }}
            testID={props.testID ? `${props.testID}.unavailable` : undefined}>{source.reason}</Text>}
    </View>
    {source.state === 'available' && source.detail ? <Text role="detail" color={colors.secondaryText}>{source.detail}</Text> : null}
  </>;
  return source.state === 'available' && source.onPress
    ? <HappierPressable testID={props.testID} accessibilityRole="link"
        accessibilityLabel={source.accessibilityLabel ?? [source.label, source.text, source.detail].filter(Boolean).join(', ')}
        onPress={source.onPress} style={state => [frame, happierFocusRingStyle({ visible: state.focused, color: colors.focus })]}>
        {content}
      </HappierPressable>
    : <View testID={props.testID} style={frame}>{content}</View>;
}

/** A passage is an excerpt read as running words: its paragraph breaks would spend its two lines on blank space. */
function passageWords(text: string): string {
  return text.replace(/\s+/gu, ' ').trim();
}
