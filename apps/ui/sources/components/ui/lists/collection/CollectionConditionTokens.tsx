import * as React from 'react';
import { Platform, View, type LayoutChangeEvent } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HAPPIER_FILTER_CHIP_METRICS, HappierPressable } from '@happier-dev/plugin-ui/presentation';

import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { SelectionListFilterChip, type SelectionListFilter } from '@/components/ui/selectionList';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

export type CollectionConditionToken = Readonly<{
  /** The condition's field: removing the token restores that field to the space. */
  id: string;
  /** The field's name ("Project", "Needs me"). */
  label: string;
  /** Its values in words; a field that is only on or off repeats its name. */
  valueLabel: string;
}>;

const styles = StyleSheet.create((theme) => ({
  row: {
    flexDirection: 'row',
    // Save stands on the first line when the tokens wrap under it.
    alignItems: 'flex-start',
    gap: theme.space.s8,
    paddingTop: theme.space.s2,
    paddingBottom: theme.space.s4,
  },
  // Every token stays in sight: a line that outgrows its column wraps, it never scrolls a token out of view.
  chips: {
    flexGrow: 1,
    flexShrink: 1,
    minWidth: 0,
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: theme.space.s8,
  },
  saveSlot: {
    flexShrink: 0,
    minHeight: HAPPIER_FILTER_CHIP_METRICS.minHeightPx,
    justifyContent: 'center',
  },
  save: {
    paddingHorizontal: theme.space.s4,
    minHeight: Platform.OS === 'web' ? 24 : 44,
    justifyContent: 'center',
    borderRadius: 6,
  },
  saveIcon: { minWidth: Platform.OS === 'web' ? 24 : 44, alignItems: 'center' },
  saveActive: { backgroundColor: theme.colors.surface.selected },
  saveText: {
    color: theme.colors.text.secondary,
    ...Typography.variant('meta', 'semiBold'),
  },
}));

/**
 * Conditions on top of a space, as removable tokens on one quiet line under the field or strip (lab
 * `clfilter:filter`, `spfield` B), with Save as space at the end: what narrows the list is always in sight and
 * one tap from gone. It is drawn only while something is on. Every saved-space list (Sessions, Workflows,
 * Discussions) and every Settings column draws this one line. Where the tokens outgrow the column they wrap to
 * a second line rather than scroll out of view, and Save gives its words up for its icon (its name stays), so a
 * 272 px sidebar keeps every condition visible (Coordination visual acceptance 11-07).
 */
export const CollectionConditionTokens = React.memo(function CollectionConditionTokens(
  props: Readonly<{
    /** `<prefix>-chips`, `<prefix>-token:<id>`, `<prefix>-tokens-save`. */
    testIDPrefix: string;
    tokens: readonly CollectionConditionToken[];
    onRemove: (id: string) => void;
    /** Saved-space lists offer Save as space at the end of the row. */
    onSave?: () => void;
  }>,
) {
  const { onRemove, testIDPrefix } = props;
  const { theme } = useUnistyles();
  const tokenCount = props.tokens.length;
  // The row width and token count at which the tokens wrapped with Save in words: at that width or narrower, with
  // as many tokens or more, Save keeps its icon, so the room the icon frees never flips it back and forth.
  const [iconWithin, setIconWithin] = React.useState<Readonly<{ width: number; count: number }> | null>(null);
  const [width, setWidth] = React.useState<number | null>(null);
  const [wrapped, setWrapped] = React.useState(false);
  const iconOnly = iconWithin !== null && width !== null && width <= iconWithin.width && tokenCount >= iconWithin.count;
  const onRowLayout = React.useCallback((event: LayoutChangeEvent) => {
    const next = Math.round(event.nativeEvent.layout.width);
    setWidth((current) => (current === next ? current : next));
  }, []);
  // A token line taller than one token has wrapped.
  const onTokensLayout = React.useCallback((event: LayoutChangeEvent) => {
    setWrapped(event.nativeEvent.layout.height > HAPPIER_FILTER_CHIP_METRICS.minHeightPx * 1.5);
  }, []);
  const hasSave = props.onSave !== undefined;
  // Decided once both layouts have landed (a child's layout can arrive before its row's new width): wrapped with
  // Save in words means the words crowd the tokens, so Save takes its icon at this width.
  React.useEffect(() => {
    if (!wrapped || iconOnly || !hasSave || width === null) return;
    setIconWithin((current) => (current?.width === width && current.count === tokenCount ? current : { width, count: tokenCount }));
  }, [hasSave, iconOnly, tokenCount, width, wrapped]);
  const filters = React.useMemo<readonly SelectionListFilter[]>(
    () => props.tokens.map((token) => ({
      id: token.id,
      testID: `${testIDPrefix}-token:${token.id}`,
      label: token.label,
      valueLabel: token.valueLabel,
      onClear: () => onRemove(token.id),
      clearAccessibilityLabel: t('sessionsList.conditionRemove', { field: token.label }),
    })),
    [onRemove, props.tokens, testIDPrefix],
  );
  return (
    <View testID={`${testIDPrefix}-chips`} style={styles.row} onLayout={onRowLayout}>
      <View style={styles.chips} onLayout={onTokensLayout}>
        {filters.map((filter) => <SelectionListFilterChip key={filter.id} filter={filter} />)}
      </View>
      {props.onSave ? <View style={styles.saveSlot}><HappierPressable
        testID={`${testIDPrefix}-tokens-save`}
        accessibilityRole="button"
        accessibilityLabel={t('sessionsList.spacesSaveAs')}
        onPress={props.onSave}
        style={(state) => [styles.save, iconOnly ? styles.saveIcon : null, state.hovered || state.pressed ? styles.saveActive : null]}
      >
        {iconOnly
          ? <Icon name="bookmark-plus" size={ICON_SIZE.sm} color={theme.colors.text.secondary} />
          : <Text style={styles.saveText}>{t('sessionsList.spacesSaveAs').replace('…', '')}</Text>}
      </HappierPressable></View> : null}
    </View>
  );
});
