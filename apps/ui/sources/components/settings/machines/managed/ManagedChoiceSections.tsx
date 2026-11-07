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
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { CoreCollectionScope } from '@/components/ui/lists/collection/CoreCollectionScope';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

import {
  countryFlag,
  managedImageLabel,
  type ManagedImageOption,
  type ManagedLocationOption,
  type ManagedNetworkOption,
  type ManagedSizeOption,
} from './managedMachineDisplay';

/**
 * The configurator's three kinds of choice: size compares specifications and rates; the
 * system is something you can see, so it is a card; a place is a short list of named regions.
 */

const keyOfSize = (size: ManagedSizeOption) => size.id;
const NOOP_OPEN = () => undefined;
const NUMBER_COLUMN_MIN_WIDTH_PX = 64;
/** Size names are short codes ("cpx31", "Medium"): the rate columns keep the room a sentence title would take (lab m-config/A). */
const SIZE_TITLE_MIN_WIDTH_PX = 120;
/**
 * The rates outrank the single choice's reason column (Collection's `reason` slot, priority 5): where both don't
 * fit beside the receipt, the comparison keeps its prices; an unavailable size stays unselectable and names its
 * reason to assistive technology.
 */
const RATE_COLUMN_PRIORITY = 6;

/** Specifications stay together as the last comparison column to yield to the narrow list. */
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
    const fields: CollectionField<ManagedSizeOption>[] = [numberField(
      'spec',
      [t('managedMachines.config.columns.cpu'), t('managedMachines.config.columns.memory'), t('managedMachines.config.columns.disk')].join(' · '),
      size => sizeByline(size, true),
      // A rate or refusal alone cannot replace the machine's resource facts (CLOUD40).
      Number.POSITIVE_INFINITY,
      3 * NUMBER_COLUMN_MIN_WIDTH_PX,
    )];
    if (hasHourly)
      fields.push(
        numberField(
          'hourly',
          t('managedMachines.config.columns.perHour'),
          (size) => size.hourly ?? t('common.unknown'),
          RATE_COLUMN_PRIORITY + 1,
        ),
      );
    if (hasMonthly)
      fields.push(
        numberField(
          'monthly',
          t('managedMachines.config.columns.perMonth'),
          (size) => size.monthly ?? t('common.unknown'),
          RATE_COLUMN_PRIORITY,
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
      // Specifications never compete with the rate or refusal columns for visibility.
      byline: size => sizeByline(size),
      fields,
      accessibilityLabel: (size) =>
        [size.name, sizeByline(size), size.unavailableReason, size.warning]
          .filter(Boolean)
          .join(', '),
      testID: (size) => `${props.testID}:${size.id}`,
      titleMinWidth: SIZE_TITLE_MIN_WIDTH_PX,
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
        // The memory advice is one line under the table, not repeated on each low row.
        unavailableReason: (size: ManagedSizeOption) => size.unavailableReason ?? null,
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
  // One advice for the table: the chosen size's, or, before a choice, the advice the low sizes share.
  const chosen = props.sizes.find((size) => size.id === props.value);
  const memoryWarning = chosen ? chosen.warning
    : props.sizes.find((size) => size.warning !== undefined)?.warning;
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
      {memoryWarning ? (
        <SurfaceStateCard kind="warning" size="line" title={memoryWarning} testID={`${props.testID}:memory-warning`} />
      ) : null}
    </>
  );
});

function sizeByline(size: ManagedSizeOption, fieldColumns = false): string {
  const cores = Number(size.cpu);
  return [
    size.cpu === '' ? null : Number.isFinite(cores) ? t('managedMachines.receipt.cores', { count: cores }) : size.cpu,
    size.memory,
    size.disk,
    fieldColumns || size.hourly === undefined ? null : `${size.hourly} ${t('managedMachines.price.perHour')}`,
  ]
    .filter((part) => part !== null && part !== '')
    .join(' · ');
}

function numberField(
  key: string,
  title: string,
  read: (size: ManagedSizeOption) => string,
  priority: number,
  minWidth = NUMBER_COLUMN_MIN_WIDTH_PX,
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

/**
 * The system a machine starts with. A provisioner that ships previews gets visual cards showing them;
 * one that names its images only gets cards with room for the name, since a blank preview frame with a
 * clipped caption says nothing.
 */
export const ManagedImageTiles = React.memo(function ManagedImageTiles(
  props: Readonly<{
    images: readonly ManagedImageOption[];
    value: string | null;
    onChange: (id: string) => void;
    testID: string;
  }>,
) {
  const options = props.images.map((image) => ({
    id: image.id,
    title: managedImageLabel(image.name),
    subtitle: image.description,
    disabled: !(image.selectable ?? image.unavailableReason === undefined),
    preview: image.preview,
  }));
  const onChange = (next: string | null) => {
    if (next) props.onChange(next);
  };
  if (!props.images.some((image) => image.preview)) {
    return (
      <SelectionTiles<string>
        surface="sheet"
        density="compact"
        maximumColumns={2}
        minimumTileWidth={IMAGE_TILE_MIN_WIDTH_PX}
        subtitleLines={1}
        accessibilityLabel={t('managedMachines.config.image')}
        testIdPrefix={props.testID}
        options={options}
        value={props.value}
        onChange={onChange}
      />
    );
  }
  return (
    <SelectionTiles<string>
      variant="visual"
      tileSizing="fill"
      accessibilityLabel={t('managedMachines.config.image')}
      testIdPrefix={props.testID}
      options={options}
      value={props.value}
      onChange={onChange}
    />
  );
});

/** A name-only image card: narrower than this, an image takes the full row. */
const IMAGE_TILE_MIN_WIDTH_PX = 200;

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

/** The provider's networking variants as short named cells of one sheet, side by side where there is room. */
export const ManagedNetworkGroup = React.memo(function ManagedNetworkGroup(
  props: Readonly<{
    title: string;
    description?: string;
    networks: readonly ManagedNetworkOption[];
    value: string | null;
    onChange: (id: string) => void;
    testID: string;
  }>,
) {
  const options = React.useMemo(
    () =>
      props.networks.map((network) => ({
        id: network.id,
        title: network.name,
        subtitle: network.unavailableReason,
        disabled: !(network.selectable ?? network.unavailableReason === undefined),
      })),
    [props.networks],
  );
  return (
    <ItemGroup title={props.title} description={props.description}>
      <SelectionTiles<string>
        surface="sheet"
        density="compact"
        maximumColumns={3}
        minimumTileWidth={NETWORK_TILE_MIN_WIDTH_PX}
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

/** A short name such as "IPv4 and IPv6" fits three across; narrower than this, a variant takes the full row. */
const NETWORK_TILE_MIN_WIDTH_PX = 150;

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
