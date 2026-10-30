import {
  memo,
  type ComponentType,
  type ReactElement,
  type ReactNode,
} from 'react';
import { Platform } from 'react-native';

import { HAPPIER_SPACE_STEPS } from '../../environment/spacing.js';
import type {
  HappierPortableStyle,
  HappierStyleProp,
} from '../portableTypes.js';

/** The chip's own type size and shape; its face, inks and inset come from the host. */
export const HAPPIER_INLINE_CODE_METRICS = Object.freeze({
  fontSizePx: 13,
  radiusPx: 4,
  paddingVerticalPx: 1,
} as const);

export type HappierInlineCodeTextProps = Readonly<{
  style: HappierStyleProp;
  testID?: string;
  children: ReactNode;
}>;

export type HappierInlineCodeProps = Readonly<{
  /** The host's text owner (core: its Text with the user's font scale). */
  Text: ComponentType<HappierInlineCodeTextProps>;
  /** The host's mono face; absent, the platform's. */
  fontFamily?: string;
  /** The code's ink and its fill (an ink tint in core, so the chip shows on every surface). */
  ink: string;
  fill: string;
  /** The horizontal inset, the host's `s4` spacing step (density-aware in core). */
  paddingHorizontalPx?: number;
  style?: HappierStyleProp;
  testID?: string;
  children: ReactNode;
}>;

// The portable style has no whiteSpace; react-native-web still receives it.
const WEB_NO_WRAP_STYLE =
  Platform.OS === 'web'
    ? ({ whiteSpace: 'nowrap' } as unknown as HappierPortableStyle)
    : null;

/**
 * A command, flag or identifier set inside a sentence: mono on a quiet ink fill. The prose
 * around it stays localized; the code itself is never translated. On web the chip never breaks inside
 * itself: when it does not fit the line it moves to the next line as one unit (native Text has no such
 * control). Happier core and plugin surfaces draw the chip with this one owner; each host supplies only
 * its text owner, face, inks and inset.
 */
export const HappierInlineCode = memo(function HappierInlineCode(
  props: HappierInlineCodeProps,
): ReactElement {
  const { Text } = props;
  return (
    <Text
      style={[
        {
          ...(props.fontFamily === undefined
            ? {}
            : { fontFamily: props.fontFamily }),
          fontSize: HAPPIER_INLINE_CODE_METRICS.fontSizePx,
          color: props.ink,
          backgroundColor: props.fill,
          borderRadius: HAPPIER_INLINE_CODE_METRICS.radiusPx,
          paddingHorizontal:
            props.paddingHorizontalPx ?? HAPPIER_SPACE_STEPS.s4,
          paddingVertical: HAPPIER_INLINE_CODE_METRICS.paddingVerticalPx,
        },
        WEB_NO_WRAP_STYLE,
        props.style,
      ]}
      {...(props.testID === undefined ? {} : { testID: props.testID })}
    >
      {props.children}
    </Text>
  );
});
