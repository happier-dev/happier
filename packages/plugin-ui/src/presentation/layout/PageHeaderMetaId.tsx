import { Platform } from 'react-native';
import type { ReactNode } from 'react';

import { useHappierCopyFeedback } from '../interaction/copyFeedback.js';
import { HappierPressable } from '../interaction/Pressable.js';
import type { HappierStyleProp } from '../portableTypes.js';
import { HAPPIER_MIDDLE_ELLIPSIS_STYLE, splitForWebMiddleEllipsis } from '../text/middleEllipsis.js';
import { HappierText } from '../text/Text.js';

/** How a page header copies an address, path or id from its meta line. */
export type HappierPageHeaderMetaIdCopy = Readonly<{
  write: (value: string) => unknown;
  copiedLabel: string;
}>;

/** What only a host owns: its own text owner for the words, and its hover anchor for the whole value. */
export type HappierPageHeaderMetaIdHost = Readonly<{
  renderValue: (value: string) => ReactNode;
  renderCopied: (label: string) => ReactNode;
  renderAnchor: (input: Readonly<{ value: string; onPress: () => void; children: ReactNode }>) => ReactNode;
}>;

/**
 * An id, address or path on the meta line has no word to wrap at: it stays on one line and gives up its
 * middle, names the whole value, and copies it on tap ("Copied" in its place for a moment).
 */
export function HappierPageHeaderMetaId(props: HappierPageHeaderMetaIdCopy & Readonly<{ value: string; host: HappierPageHeaderMetaIdHost }>) {
  const feedback = useHappierCopyFeedback();
  const { value, write, host } = props;
  return host.renderAnchor({
    value,
    onPress: () => { void feedback.copy(() => write(value)); },
    children: feedback.isCopied() ? host.renderCopied(props.copiedLabel) : host.renderValue(value),
  });
}

/** The one line that gives up its middle, in the portable text owner; a host keeps the same shape with its own. */
export function HappierMiddleEllipsisText(props: Readonly<{ value: string; style?: HappierStyleProp; testID?: string }>) {
  const split = Platform.OS === 'web' ? splitForWebMiddleEllipsis(props.value) : null;
  if (split === null) return <HappierText testID={props.testID} style={props.style} numberOfLines={1} ellipsizeMode="middle">{props.value}</HappierText>;
  return <HappierText testID={props.testID} style={[props.style, HAPPIER_MIDDLE_ELLIPSIS_STYLE.row]}>
    <HappierText style={HAPPIER_MIDDLE_ELLIPSIS_STYLE.head} numberOfLines={1} ellipsizeMode="tail">{split.head}</HappierText>
    <HappierText style={HAPPIER_MIDDLE_ELLIPSIS_STYLE.tail} numberOfLines={1}>{split.tail}</HappierText>
  </HappierText>;
}

/** The anchor where a host has no hover tooltip: it names the whole value and takes the tap. */
export function HappierPageHeaderMetaIdAnchor(props: Readonly<{ value: string; onPress: () => void; children: ReactNode }>) {
  return <HappierPressable accessibilityRole="button" accessibilityLabel={props.value} onPress={props.onPress}
    style={{ flexShrink: 1, minWidth: 0 }}>{props.children}</HappierPressable>;
}
