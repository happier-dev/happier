import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { resolveThemeColor } from '@/theme/parseThemeColor';
import { t } from '@/text';
import {
  DiffHunkRowTextInsetContext,
  DiffHunkRowViewportContext,
} from './hunks/DiffHunkRow';

/**
 * The fold Find opened for its current match (Find lab F1d), drawn once for every diff renderer: a faint band in
 * the current-match tint above the opened rows, the reason where the code text begins, and the way back at its end.
 * `onFoldAgain` is the renderer's own refold operation, the same one `ui.find {op:'refold'}` reaches.
 */
export const DiffFindOpenedFoldRow = React.memo(function DiffFindOpenedFoldRow(
  props: Readonly<{
    /** The unchanged lines the fold held, all of which Find opened. */
    hiddenCount: number;
    onFoldAgain: () => unknown;
  }>,
) {
  const { theme } = useUnistyles();
  // Like a change row, the band sits in the code column: the renderer says where code text begins, and a
  // sideways-scrolling column keeps the band at the visible width so "Fold again" stays at the pane edge.
  const textInset = React.useContext(DiffHunkRowTextInsetContext);
  const viewport = React.useContext(DiffHunkRowViewportContext);
  const band = React.useMemo(
    () =>
      resolveThemeColor(theme.colors.find.matchCurrent)
        .alpha(0.1)
        .rgb()
        .string(),
    [theme.colors.find.matchCurrent],
  );
  return (
    <View
      testID="diff-find-opened-fold"
      style={[
        styles.row,
        // RN's DimensionValue has no `ch`; only the web Pierre adapter supplies one, and RNW passes CSS lengths through.
        { paddingLeft: textInset as number, backgroundColor: band },
        viewport
          ? {
              width: viewport.width,
              transform: [{ translateX: viewport.offsetX }],
            }
          : null,
      ]}
    >
      <Icon
        name="arrows-down-up"
        size={ICON_SIZE.xs}
        color={theme.colors.text.tertiary}
      />
      <Text
        variant="meta"
        numberOfLines={1}
        style={[styles.label, { color: theme.colors.text.tertiary }]}
      >
        {t('find.openedForMatch', { count: props.hiddenCount })}
      </Text>
      {/* The link keeps its own sentence alignment (flex-start); its box centres on the band's line. */}
      <View>
        <TextLinkButton
          testID="diff-find-fold-again"
          tone="accent"
          size="meta"
          label={t('find.foldAgain')}
          onPress={props.onFoldAgain}
        />
      </View>
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  row: {
    minHeight: 30,
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s8,
    paddingRight: theme.space.s12,
  },
  label: {
    flex: 1,
    minWidth: 0,
  },
}));
