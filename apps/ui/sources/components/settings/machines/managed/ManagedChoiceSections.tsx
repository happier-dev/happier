import * as React from 'react';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import {
  Collection,
  type CollectionAnatomy,
  type CollectionField,
} from '@happier-dev/plugin-ui';
import {
  happierPageTextMetrics,
  useHappierCollection,
} from '@happier-dev/plugin-ui/presentation';

import { SelectionTiles } from '@/components/ui/forms/SelectionTiles';
import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { CoreCollectionScope } from '@/components/ui/lists/collection/CoreCollectionScope';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

import {
  countryFlag,
  type ManagedImageOption,
  type ManagedLocationOption,
  type ManagedSizeOption,
} from './managedMachineDisplay';

/**
 * The configurator's three kinds of choice (plan 51 §8): size is a comparison, so it is a table; the
 * system is something you can see, so it is a card; a place is a short list of named regions.
 */

const keyOfSize = (size: ManagedSizeOption) => size.id;
const NOOP_OPEN = () => undefined;

/** The size comparison: the public Collection table with one radio column and tabular numbers. */
export const ManagedSizeTable = React.memo(function ManagedSizeTable(
  props: Readonly<{
    sizes: readonly ManagedSizeOption[];
    value: string | null;
    onChange: (id: string) => void;
    /** Local sizes show what the host keeps instead of a price ("Left for MacBook Pro"). */
    headroomTitle?: string;
    compact?: boolean;
    testID: string;
  }>,
) {
  const model = useHappierCollection({
    items: props.sizes,
    keyOf: keyOfSize,
    selection: 'none',
    openKey: null,
    onOpenChange: NOOP_OPEN,
  });
  const hasHourly = props.sizes.some((size) => size.hourly !== undefined);
  const hasMonthly =
    !props.compact && props.sizes.some((size) => size.monthly !== undefined);
  const hasHeadroom =
    !props.compact &&
    props.headroomTitle !== undefined &&
    props.sizes.some((size) => size.headroom !== undefined);
  const anatomy = React.useMemo((): CollectionAnatomy<ManagedSizeOption> => {
    const fields: CollectionField<ManagedSizeOption>[] = [
      numberField(
        'cpu',
        t('managedMachines.config.columns.cpu'),
        (size) => size.cpu,
        4,
      ),
      numberField(
        'memory',
        t('managedMachines.config.columns.memory'),
        (size) => size.memory,
        3,
      ),
    ];
    // Disk stays a column wherever the table has room; the table's own priorities drop it, not a device label.
    fields.push(
      numberField(
        'disk',
        t('managedMachines.config.columns.disk'),
        (size) => size.disk,
        2,
      ),
    );
    if (hasHourly)
      fields.push(
        numberField(
          'hourly',
          t('managedMachines.config.columns.perHour'),
          (size) => size.hourly ?? t('common.unknown'),
          5,
        ),
      );
    if (hasMonthly)
      fields.push(
        numberField(
          'monthly',
          t('managedMachines.config.columns.perMonth'),
          (size) => size.monthly ?? t('common.unknown'),
          1,
        ),
      );
    if (hasHeadroom)
      fields.push(
        numberField(
          'headroom',
          props.headroomTitle ?? '',
          (size) => size.headroom ?? '',
          1,
          140,
        ),
      );
    return {
      glyph: () => null,
      title: (size) => size.name,
      fields,
      accessibilityLabel: (size) =>
        [size.name, size.spec, size.hourly, size.unavailableReason]
          .filter(Boolean)
          .join(', '),
      testID: (size) => `${props.testID}:${size.id}`,
      columnTitles: { title: t('managedMachines.config.columns.size') },
    };
  }, [
    hasHeadroom,
    hasHourly,
    hasMonthly,
    props.compact,
    props.headroomTitle,
    props.testID,
  ]);
  const selection = React.useMemo(
    () => ({
      single: {
        value: props.value,
        onValueChange: props.onChange,
        isItemSelectable: (size: ManagedSizeOption) =>
          size.selectable ?? size.unavailableReason === undefined,
        unavailableReason: (size: ManagedSizeOption) =>
          size.unavailableReason ?? null,
      },
    }),
    [props.onChange, props.value],
  );
  // A phone has no room for the headroom column, so what the chosen size leaves this computer moves
  // beneath the table instead of disappearing at the point of choice.
  const selectedHeadroom =
    props.compact && props.headroomTitle !== undefined
      ? props.sizes.find((size) => size.id === props.value)?.headroom
      : undefined;
  return (
    <>
      <CoreCollectionScope>
        <Collection
          model={model}
          anatomy={anatomy}
          accessibilityLabel={t('managedMachines.config.size')}
          presentation="table"
          detail="none"
          scroll="page-virtualized"
          selection={selection}
          minListWidth={280}
          minDetailWidth={0}
          preferredListRatio={1}
          testID={props.testID}
        />
      </CoreCollectionScope>
      {selectedHeadroom !== undefined ? (
        <Item
          testID={`${props.testID}:headroom`}
          title={props.headroomTitle}
          density="compact"
          mode="info"
          showChevron={false}
          rightElement={<TabularCell text={selectedHeadroom} />}
        />
      ) : null}
    </>
  );
});

function numberField(
  key: string,
  title: string,
  read: (size: ManagedSizeOption) => string,
  priority: number,
  minWidth = 64,
): CollectionField<ManagedSizeOption> {
  return {
    key,
    title,
    minWidth,
    priority,
    align: 'end',
    render: (size) => <TabularCell text={read(size)} />,
  };
}

function TabularCell(props: Readonly<{ text: string }>) {
  return (
    <Text style={styles.tabular} numberOfLines={1}>
      {props.text}
    </Text>
  );
}

/** The system a machine starts with, as cards showing the provisioner's own preview. */
export const ManagedImageTiles = React.memo(function ManagedImageTiles(
  props: Readonly<{
    images: readonly ManagedImageOption[];
    value: string | null;
    onChange: (id: string) => void;
    testID: string;
  }>,
) {
  return (
    <SelectionTiles<string>
      variant="visual"
      tileSizing="fill"
      accessibilityLabel={t('managedMachines.config.image')}
      testIdPrefix={props.testID}
      options={props.images.map((image) => ({
        id: image.id,
        title: image.name,
        subtitle: image.description,
        disabled: !(image.selectable ?? image.unavailableReason === undefined),
        preview: image.preview,
      }))}
      value={props.value}
      onChange={(next) => {
        if (next) props.onChange(next);
      }}
    />
  );
});

/**
 * Named regions as one radio group drawn as cells of the section's one sheet: flag, city, country, two
 * across where there is room and one per line on a phone (lab `m-config` location grid).
 */
export const ManagedLocationGroup = React.memo(function ManagedLocationGroup(
  props: Readonly<{
    title: string;
    description?: string;
    locations: readonly ManagedLocationOption[];
    value: string | null;
    onChange: (id: string) => void;
    testID: string;
  }>,
) {
  const { theme } = useUnistyles();
  const options = React.useMemo(
    () =>
      props.locations.map((location) => {
        const flag = countryFlag(location.countryCode);
        return {
          id: location.id,
          title: location.city,
          subtitle: location.unavailableReason ?? (location.country || undefined),
          disabled: !(location.selectable ?? location.unavailableReason === undefined),
          mark: flag ? (
            <Text style={styles.flag}>{flag}</Text>
          ) : (
            <Icon name="globe" size={18} color={theme.colors.text.secondary} />
          ),
        };
      }),
    [props.locations, theme.colors.text.secondary],
  );
  return (
    <ItemGroup title={props.title} description={props.description}>
      <SelectionTiles<string>
        surface="sheet"
        density="compact"
        maximumColumns={2}
        minimumTileWidth={LOCATION_TILE_MIN_WIDTH_PX}
        subtitleLines={1}
        accessibilityLabel={props.title}
        testIdPrefix={props.testID}
        options={options}
        value={props.value}
        onChange={(next) => {
          if (next) props.onChange(next);
        }}
      />
    </ItemGroup>
  );
});

/** A city and its country on one line each; narrower than this, a region takes the full row. */
const LOCATION_TILE_MIN_WIDTH_PX = 200;

const styles = StyleSheet.create((theme) => ({
  tabular: {
    ...Typography.default(),
    ...Typography.tabular(),
    ...happierPageTextMetrics('rowTitle'),
    color: theme.colors.text.primary,
    textAlign: 'right',
  },
  flag: {
    ...happierPageTextMetrics('rowTitle'),
  },
}));
