import * as React from 'react';
import { type StyleProp, View, type ViewStyle } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HAPPIER_ICON_BUTTON_SIZE, useHappierMaterialColorResolver } from '@happier-dev/plugin-ui/presentation';

import { Avatar } from '@/components/ui/avatar/Avatar';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { getAvatarUrl } from '@/sync/domains/profiles/profile';
import { useProfile } from '@/sync/domains/state/storage';
import { t } from '@/text';

/** Who wrote a saved comment and where it sits ("line 2"), for its author line. */
export type ReviewCommentFrameAuthor = Readonly<{
  mark: React.ReactNode;
  name: string;
  meta?: string;
}>;

/**
 * One review comment's card at its line, read and being written alike: the author line (avatar or Agent
 * mark, name, meta, an optional trailing control) over the body. A draft reads "You · draft"; a saved
 * comment passes its own author, so a draft keeps its card when it is saved, and opening a draft to edit
 * only swaps the text for a field.
 */
export function ReviewCommentDraftFrame(
  props: Readonly<{
    /** A saved comment's author line; a draft's (yours, "draft") when absent. */
    author?: ReviewCommentFrameAuthor;
    /** At the end of the author line (the saved card's ⋯ menu). */
    headerTrailing?: React.ReactNode;
    children: React.ReactNode;
    style?: StyleProp<ViewStyle>;
    testID?: string;
  }>,
) {
  const { theme } = useUnistyles();
  const paintColor = useHappierMaterialColorResolver();
  const profile = useProfile();
  const author = props.author;
  const meta = author ? author.meta : t('detailsSurface.review.draftStatus');
  return (
    <View
      testID={props.testID}
      style={[
        styles.card,
        { backgroundColor: paintColor(theme.colors.surface.base) },
        props.style,
      ]}
    >
      <View style={styles.header}>
        {author ? author.mark : (
          <Avatar
            id={profile.id}
            imageUrl={getAvatarUrl(profile)}
            thumbhash={profile.avatar?.thumbhash}
            size={18}
          />
        )}
        <Text variant="meta" emphasis="semiBold" numberOfLines={1} style={styles.author}>
          {author ? author.name : t('detailsSurface.review.draftAuthor')}
        </Text>
        {meta ? <Text variant="meta" numberOfLines={1} style={styles.meta}>{`· ${meta}`}</Text> : null}
        <View style={styles.grow} />
        {props.headerTrailing}
      </View>
      {props.children}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  card: {
    gap: theme.space.s6,
    padding: theme.space.s10,
    borderRadius: theme.borderRadius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border.default,
    backgroundColor: theme.colors.surface.base,
  },
  // Held at the ⋯ button's height, so the line keeps its place whether or not a trailing control shows.
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s6,
    minHeight: HAPPIER_ICON_BUTTON_SIZE,
  },
  author: { color: theme.colors.text.primary, flexShrink: 1 },
  meta: { color: theme.colors.text.secondary, flexShrink: 1 },
  grow: { flex: 1 },
}));

/** The comment slot under a line: drafts, saved comments and findings share its one edge and gap. */
export const reviewCommentSlot = StyleSheet.create((theme) => ({
  slot: { gap: theme.space.s6, marginTop: theme.space.s6, marginRight: theme.space.s8 },
}));

/** The comment's text, read (Markdown) or being written (the field): one role, so editing never reflows it. */
export const reviewCommentDraftText = StyleSheet.create((theme) => ({
  body: {
    ...Typography.variant('body'),
    color: theme.colors.text.primary,
  },
}));
