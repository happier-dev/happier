import * as React from 'react';
import { Platform, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';

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
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: theme.space.s8,
    paddingTop: theme.space.s2,
    paddingBottom: theme.space.s4,
  },
  save: {
    marginLeft: 'auto',
    paddingHorizontal: theme.space.s4,
    minHeight: Platform.OS === 'web' ? 24 : 44,
    justifyContent: 'center',
    borderRadius: 6,
  },
  saveActive: { backgroundColor: theme.colors.surface.selected },
  saveText: {
    color: theme.colors.text.secondary,
    ...Typography.variant('meta', 'semiBold'),
  },
}));

/**
 * Conditions on top of a space, as removable tokens under the strip (lab `clfilter:filter`), with Save as
 * space at the end: what narrows the list is always in sight and one tap from gone. Every saved-space list
 * (Sessions, Workflows, Discussions) draws this one row.
 */
export const CollectionConditionTokens = React.memo(function CollectionConditionTokens(
  props: Readonly<{
    /** `<prefix>-chips`, `<prefix>-token:<id>`, `<prefix>-tokens-save`. */
    testIDPrefix: string;
    tokens: readonly CollectionConditionToken[];
    /** The list's one-press chips, leading the row: what it narrows by most, then what else is on. */
    quickFilters?: readonly SelectionListFilter[];
    onRemove: (id: string) => void;
    /** Saved-space lists offer Save as space at the end of the row. */
    onSave?: () => void;
  }>,
) {
  const { onRemove, testIDPrefix } = props;
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
    <View testID={`${testIDPrefix}-chips`} style={styles.row}>
      {props.quickFilters?.map((filter) => <SelectionListFilterChip key={filter.id} filter={filter} />)}
      {filters.map((filter) => <SelectionListFilterChip key={filter.id} filter={filter} />)}
      {props.onSave ? <HappierPressable
        testID={`${testIDPrefix}-tokens-save`}
        accessibilityRole="button"
        accessibilityLabel={t('sessionsList.spacesSaveAs')}
        onPress={props.onSave}
        style={(state) => [styles.save, state.hovered || state.pressed ? styles.saveActive : null]}
      >
        <Text style={styles.saveText}>{t('sessionsList.spacesSaveAs').replace('…', '')}</Text>
      </HappierPressable> : null}
    </View>
  );
});
