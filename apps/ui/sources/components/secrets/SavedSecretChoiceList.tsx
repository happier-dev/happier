import * as React from 'react';
import { ScrollView, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { SavedSecretCatalogEntryV1 } from '@happier-dev/protocol/account/settings/savedSecretCatalogV1';

import { sharedSecretProvenanceSegments } from '@/components/secrets/savedSecretRowCopy';
import { CompactSearchField } from '@/components/ui/forms/CompactSearchField';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { COLLECTION_LIST_SEARCH_THRESHOLD } from '@/components/ui/lists/collection/CollectionList';
import { SelectableRow } from '@/components/ui/lists/SelectableRow';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { formatAccountDisplayName } from '@/sync/domains/account/formatAccountDisplayName';
import { t } from '@/text';

/** One saved secret offered for choice: why it leads or why it can't be used now, and whether it can be pressed. */
export type SavedSecretChoiceRow = Readonly<{
  entry: SavedSecretCatalogEntryV1;
  note?: string | null;
  disabled?: boolean;
}>;

/**
 * The one list for choosing a saved secret by name, used by every picker of one (the Connect sheet's Saved tab and
 * the saved-secret picker): search once the list is long, then menu rows with the key mark, name, facts and the
 * check on the chosen one. The caller decides which secrets are offered, in what order, and what a press does.
 * The search stays put while the rows scroll under it; the caller bounds the height.
 */
export function SavedSecretChoiceList(
  props: Readonly<{
    rows: readonly SavedSecretChoiceRow[];
    selectedRef: string | null;
    onChoose: (ref: string) => void;
    testIDPrefix: string;
    /** A line above the rows that applies to all of them (the catalog can't be refreshed, with its retry). */
    notice?: React.ReactNode;
  }>,
) {
  const { theme } = useUnistyles();
  const [query, setQuery] = React.useState('');
  // The kind only tells rows apart when they differ; a list of API keys does not say "API key" on every row.
  const kindsDiffer = React.useMemo(
    () => new Set(props.rows.map((row) => row.entry.kind ?? null)).size > 1,
    [props.rows],
  );
  const searchable =
    query.length > 0 || props.rows.length >= COLLECTION_LIST_SEARCH_THRESHOLD;
  const needle = searchable ? query.trim().toLocaleLowerCase() : '';
  const shown = React.useMemo(
    () =>
      needle
        ? props.rows.filter(({ entry }) =>
            [
              entry.name,
              entry.owner ? formatAccountDisplayName(entry.owner) : null,
            ].some((text) => text?.toLocaleLowerCase().includes(needle)),
          )
        : props.rows,
    [props.rows, needle],
  );
  const prefix = props.testIDPrefix;
  return (
    <>
      {searchable ? (
        <CompactSearchField
          value={query}
          onChangeText={setQuery}
          placeholder={t('connectedServicesSetup.keySearch')}
          testID={`${prefix}:search`}
        />
      ) : null}
      {props.notice ?? null}
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.rows}
        keyboardShouldPersistTaps="handled"
        accessibilityRole="radiogroup"
        testID={`${prefix}:saved`}
      >
        {shown.length === 0 ? (
          <SurfaceStateCard
            testID={`${prefix}:no-matches`}
            kind="empty"
            size="line"
            title={t('common.noMatches')}
          />
        ) : null}
        {shown.map(({ entry, note, disabled }) => {
          const isSelected = entry.ref === props.selectedRef;
          const ownerName =
            entry.relationship === 'recipient' && entry.owner
              ? formatAccountDisplayName(entry.owner)
              : null;
          const kind =
            kindsDiffer && entry.kind
              ? t(`secrets.catalog.kinds.${entry.kind}`)
              : null;
          const facts = [
            note,
            kind,
            ...sharedSecretProvenanceSegments(entry),
          ].filter((fact): fact is string => Boolean(fact));
          return (
            <SelectableRow
              key={entry.ref}
              testID={`${prefix}:saved:${entry.ref}`}
              presentation="menu"
              accessibilityRole="radio"
              accessibilityChecked={isSelected}
              disabled={disabled === true}
              left={
                <Icon
                  name="key"
                  size={ICON_SIZE.sm}
                  color={theme.colors.text.secondary}
                />
              }
              title={entry.name ?? t('secrets.catalog.unavailableName')}
              subtitle={facts.length > 0 ? facts.join(' · ') : undefined}
              right={
                <View style={styles.trailing}>
                  {ownerName ? (
                    <Text style={styles.approves} numberOfLines={1}>
                      {t('connectedServicesSetup.keyOwnerApprovesFirst', {
                        owner: ownerName,
                      })}
                    </Text>
                  ) : null}
                  {/* The chosen secret carries the menus' check; a slot keeps every row's text edge. */}
                  <View style={styles.mark}>
                    {isSelected ? (
                      <Icon
                        testID={`${prefix}:selected:${entry.ref}`}
                        name="check"
                        size={ICON_SIZE.sm}
                        color={theme.colors.text.primary}
                      />
                    ) : null}
                  </View>
                </View>
              }
              onPress={
                disabled === true ? undefined : () => props.onChoose(entry.ref)
              }
            />
          );
        })}
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  scroll: {
    flexGrow: 0,
    flexShrink: 1,
    minHeight: 0,
  },
  rows: {
    gap: theme.space.s2,
    marginHorizontal: -theme.space.s8,
  },
  trailing: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s8,
  },
  mark: {
    width: ICON_SIZE.sm,
    alignItems: 'center',
  },
  approves: {
    ...Typography.variant('meta'),
    color: theme.colors.text.secondary,
  },
}));
