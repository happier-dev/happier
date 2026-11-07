import type { ComponentType, ReactElement, ReactNode } from 'react';
import { View } from 'react-native';

import type {
  HappierPortableStyle,
  HappierStyleProp,
} from '../portableTypes.js';
import { HAPPIER_SPACE_STEPS } from '../../environment/spacing.js';

/**
 * How an Account that took part reads, once its host has classified it (Protocol's
 * `classifyAccountActorLabelV1`): the viewer, a person by their profile name, a current member without
 * one, or someone who has left. The relationship and the profile are the caller's facts; this is
 * presentation input, never an identity or an access decision.
 */
export type HappierAccountActorLabel =
  | Readonly<{ kind: 'self' }>
  | Readonly<{ kind: 'former' }>
  | Readonly<{ kind: 'profile'; label: string }>
  | Readonly<{ kind: 'unnamed' }>;

export type HappierAccountBylineTextProps = Readonly<{
  testID?: string;
  color: string;
  accessibilityLabel: string;
  /** The name is one line, cut at its end; the sentence still names the person in full. */
  numberOfLines: 1;
  style: HappierPortableStyle;
  children: string;
}>;

export type HappierAccountBylineProps = Readonly<{
  /** The byline row. */
  testID?: string;
  /** The name's own test id (a host's existing attribution hook). */
  nameTestID?: string;
  /** The face's wrapper test id. */
  faceTestID?: string;
  /** The localized name: "You", "Mara Chen", "Former member", "Happier member". */
  name: string;
  /** The one sentence a screen reader hears ("Sent by Mara Chen"); the face stays silent. */
  accessibilityLabel: string;
  /** The person's mark at the end of the line, drawn by the host's avatar owner. */
  face: ReactNode;
  Text: ComponentType<HappierAccountBylineTextProps>;
  /** The quiet ink the name is set in. */
  color: string;
  space?: Readonly<Record<'s6', number>>;
  /** Where the line sits in its surface; the caller owns placement, the line owns its anatomy. */
  style?: HappierStyleProp;
}>;

/**
 * Who sent a message: one quiet line of name then face, cut to the line, read once by its sentence.
 * Shared by Happier's transcript and plugin threads, so a person, You and a former member read the same
 * in both. Classification stays with Protocol and the host; the caller passes the localized result.
 */
export function HappierAccountByline(
  props: HappierAccountBylineProps,
): ReactElement {
  const space = props.space ?? HAPPIER_SPACE_STEPS;
  const { Text } = props;
  return (
    <View
      testID={props.testID}
      style={[rowStyle, { gap: space.s6 }, props.style]}
    >
      <Text
        testID={props.nameTestID}
        color={props.color}
        accessibilityLabel={props.accessibilityLabel}
        numberOfLines={1}
        style={nameStyle}
      >
        {props.name}
      </Text>
      <View
        testID={props.faceTestID}
        accessible={false}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        aria-hidden
      >
        {props.face}
      </View>
    </View>
  );
}

const rowStyle = {
  flexDirection: 'row',
  alignItems: 'center',
  maxWidth: '100%',
} satisfies HappierPortableStyle;
const nameStyle = { flexShrink: 1 } satisfies HappierPortableStyle;
