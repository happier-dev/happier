import {
  HappierTextLinkButton,
  happierPageTextMetrics,
  type HappierTextLinkButtonProps,
} from '@happier-dev/plugin-ui/presentation';
import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';

/** Size and line of the existing row-meta step; the weight stays the link's own. */
function resolveMetaMetrics() {
  const { fontSize, lineHeight, letterSpacing } = Typography.variant('meta');
  return { fontSize, lineHeight, letterSpacing };
}

function TextLinkButtonText(props: React.ComponentProps<HappierTextLinkButtonProps['Text']>) {
  return <Text numberOfLines={props.numberOfLines} testID={props.testID} style={props.style as React.ComponentProps<typeof Text>['style']}>{props.children}</Text>;
}

/**
 * An operation written as words inside or beside a sentence: a tertiary choice ("Don't show again"),
 * a disclosure ("More" / "Less"), the one contextual recovery ending a status line ("Ask Happier").
 *
 * It is a button, not navigation: semibold ink (secondary, or primary for `strong`) that underlines on hover, the
 * shared press dip, and the keyboard focus ring. The text keeps its line height, so it sits on the
 * baseline of the sentence it ends; on a touch pointer the press frame reaches the platform minimum
 * above and below the line without taking layout. The focus ring and press dip stay on the words.
 */
export const TextLinkButton = React.memo(function TextLinkButton(
  props: Readonly<{
    label: string;
    onPress: () => unknown;
    /**
     * `quiet` reads as part of the sentence; `strong` is the sentence's one recovery; `accent` is the
     * active-state link that closes a band the user's own search opened (Find's note link colour).
     */
    tone?: 'quiet' | 'strong' | 'accent';
    /** `meta` ends a compact meta or status line (the composer's status row) at the row-meta step. */
    size?: 'row' | 'meta';
    accessibilityLabel?: string;
    /** A disclosure says whether what it controls is open. */
    expanded?: boolean;
    disabled?: boolean;
    testID?: string;
    /** Lets a surface land keyboard focus on this link (a question's safe answer). */
    controlRef?: HappierTextLinkButtonProps['controlRef'];
  }>,
) {
  const { theme } = useUnistyles();
  const strong = props.tone === 'strong';
  const accent = props.tone === 'accent' ? theme.colors.state.active.foreground : undefined;
  return (
    <HappierTextLinkButton
      {...props}
      Text={TextLinkButtonText}
      labelStyle={{
        ...Typography.default('semiBold'),
        ...(props.size === 'meta' ? resolveMetaMetrics() : happierPageTextMetrics('rowDescription')),
        color: accent ?? (strong ? theme.colors.text.primary : theme.colors.text.secondary),
      }}
      hoverColor={accent ?? theme.colors.text.primary}
      focusColor={theme.colors.border.focus}
    />
  );
});
