import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import {
  HappierCollapsibleBody,
  type HappierCollapsibleBodyActionProps,
} from '@happier-dev/plugin-ui/presentation';

import { MarkdownView } from '@/components/markdown/MarkdownView';
import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';
import { ICON_SIZE, Icon } from '@/components/ui/icons/Icon';
import { resolveVerticalScrollEdgeMaskStyle } from '@/components/ui/scroll/resolveScrollEdgeMaskStyle';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';

/** The excerpt reads at the interface reading size (the Markdown `document` profile). */
const EXCERPT_LINE_HEIGHT = Typography.variant('reading').lineHeight;
const EXCERPT_LINES = 4;
// The clip ends in the shared scroll-edge fade, so the preview never ends on half a line of text.
const EXCERPT_FADE =
  resolveVerticalScrollEdgeMaskStyle(
    { top: false, bottom: true, left: false, right: false },
    { fadeSize: EXCERPT_LINE_HEIGHT * 1.5 },
  ) ?? undefined;

/**
 * A message quoted where something is made from it (Save as decision, Discuss this answer): its source line,
 * then the message itself drawn by the Markdown renderer (code blocks stay code blocks), clipped to a few lines
 * behind Show more. The quote card matches the returned-answer quote: an inset fill with a rule on its leading
 * edge. Clipping and its disclosure belong to `HappierCollapsibleBody`, the one clipped-preview owner.
 */
export function MarkdownExcerpt(
  props: Readonly<{
    markdown: string;
    /** What the excerpt is ("Source · this answer"). */
    source: string;
    showMore: string;
    showLess: string;
    testID?: string;
  }>,
) {
  const { theme } = useUnistyles();
  return (
    <View testID={props.testID} style={styles.quote}>
      <View style={styles.source}>
        <Icon
          name="quotes"
          size={ICON_SIZE.xs}
          color={theme.colors.text.secondary}
        />
        <Text variant="meta" style={styles.sourceText} numberOfLines={1}>
          {props.source}
        </Text>
      </View>
      <HappierCollapsibleBody
        maxHeight={EXCERPT_LINES * EXCERPT_LINE_HEIGHT}
        slack={EXCERPT_LINE_HEIGHT}
        showMore={props.showMore}
        showLess={props.showLess}
        Action={ExcerptAction}
        {...(EXCERPT_FADE ? { fade: EXCERPT_FADE } : {})}
        gap={theme.space.s6}
        {...(props.testID
          ? {
              testID: `${props.testID}.body`,
              actionTestID: `${props.testID}.fold`,
            }
          : {})}
      >
        <MarkdownView
          markdown={props.markdown}
          profile="document"
          selectable={false}
        />
      </HappierCollapsibleBody>
    </View>
  );
}

function ExcerptAction(props: HappierCollapsibleBodyActionProps) {
  return <TextLinkButton {...props} size="meta" />;
}

const styles = StyleSheet.create((theme) => ({
  quote: {
    alignSelf: 'stretch',
    minWidth: 0,
    gap: theme.space.s6,
    borderLeftWidth: 2,
    borderLeftColor: theme.colors.border.default,
    borderRadius: theme.borderRadius.xl,
    backgroundColor: theme.colors.surface.inset,
    paddingHorizontal: theme.space.s12,
    paddingVertical: theme.space.s10,
  },
  source: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s6,
    minWidth: 0,
  },
  sourceText: { flexShrink: 1, color: theme.colors.text.secondary },
}));
