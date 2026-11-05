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

/**
 * One draft review comment's card, read and being written alike: the author line (your avatar, You ·
 * draft, an optional trailing control) over the body. The saved card and the inline composer both draw
 * it, so opening a draft to edit keeps its card and only swaps the text for a field.
 */
export function ReviewCommentDraftFrame(
  props: Readonly<{
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
        <Avatar
          id={profile.id}
          imageUrl={getAvatarUrl(profile)}
          thumbhash={profile.avatar?.thumbhash}
          size={18}
        />
        <Text variant="meta" emphasis="semiBold" style={styles.author}>
          {t('detailsSurface.review.draftAuthor')}
        </Text>
        <Text
          variant="meta"
          style={styles.meta}
        >{`· ${t('detailsSurface.review.draftStatus')}`}</Text>
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
    borderRadius: 10,
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
  author: { color: theme.colors.text.primary },
  meta: { color: theme.colors.text.secondary, flexShrink: 1 },
  grow: { flex: 1 },
}));

/** The comment's text, read (Markdown) or being written (the field): one role, so editing never reflows it. */
export const reviewCommentDraftText = StyleSheet.create((theme) => ({
  body: {
    ...Typography.variant('body'),
    color: theme.colors.text.primary,
  },
}));
