import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';
import {
  HappierRegistryShelf, HappierRegistryShelfAddControl,
  type RegistryShelfProps, type RegistryShelfProjection, type RegistryShelfUnavailable,
  type RegistryShelfHost, type RegistryShelfAddState, type RegistryShelfAddControlProps,
} from '@happier-dev/plugin-ui/presentation';
import type { RegistryCatalogItemSummary as RegistryItemSummaryV1 } from '@/registries/registryBrandMark';
import { RegistrySourcesUnavailable } from './RegistrySourcesUnavailable';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Icon } from '@/components/ui/icons/Icon';
import { SectionActionButton } from '@/components/ui/lists/SectionActionButton';
import { Text } from '@/components/ui/text/Text';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { describeRegistrySourceFailure, type RegistryFailureStatus } from '@/registries/describeRegistrySourceStatus';
import { CoreCollectionScope } from '@/components/ui/lists/collection/CoreCollectionScope';

export type { RegistryShelfProjection, RegistryShelfUnavailable, RegistryShelfAddState };
export type RegistryShelfCard = RegistryItemSummaryV1;

export function registryShelfCardKey(item: RegistryShelfCard): string {
  return `${item.sourceId}:${item.itemId}`;
}
export const registryShelfProjection: RegistryShelfProjection<RegistryShelfCard> =
  {
    keyOf: registryShelfCardKey,
    title: (item) => item.title,
    description: (item) => item.description ?? null,
    testID: (item) => item.itemId,
  };

/**
 * The typed acquisition result a homepage shelf already holds (`useRegistrySuggestions`), read into the one
 * outage line. A failed source page names its source and reason; a read that failed outright names the
 * shelf's source. A settled empty read carries neither, so a confirmed-empty shelf stays quiet.
 */
export function resolveRegistryShelfUnavailable(
  shelf: Readonly<{
    sourceId: string | null;
    error: string | null;
    status: RegistryFailureStatus | null;
    sourceFailures: readonly Readonly<{ sourceId: string; message: string }>[];
    refresh: () => Promise<void>;
  }>,
  sourceName: (sourceId: string) => string | undefined | null,
): RegistryShelfUnavailable | undefined {
  const failure = shelf.sourceFailures[0];
  if (!failure && !shelf.error) return undefined;
  const sourceId = failure?.sourceId ?? shelf.sourceId;
  const name = sourceId ? sourceName(sourceId) : null;
  return {
    message: failure ? name ? `${name} · ${failure.message}` : failure.message
      : describeRegistrySourceFailure(shelf.status, name),
    onRetry: shelf.refresh,
  };
}

const shelfHost: RegistryShelfHost = {
  Section: ({ children, ...input }) => <ItemGroup {...input}>{children}</ItemGroup>,
  BrowseAll: SectionActionButton,
  Row: Item,
  Scope: CoreCollectionScope,
  Unavailable: RegistrySourcesUnavailable,
};

export const RegistryShelf = React.memo(function RegistryShelf<Item>(props: RegistryShelfProps<Item>) {
  return <HappierRegistryShelf {...props} host={shelfHost} />;
}) as <Item>(props: RegistryShelfProps<Item>) => React.ReactElement;

export const RegistryShelfAddControl = React.memo(function RegistryShelfAddControl(props: RegistryShelfAddControlProps) {
  const { theme } = useUnistyles();
  return <HappierRegistryShelfAddControl {...props} host={{
    renderAddedIcon: () => <Icon name="check" size={14} color={theme.colors.text.tertiary} />,
    renderAddedLabel: label => <Text variant="meta" numberOfLines={1} style={{ color: theme.colors.text.tertiary }}>{label}</Text>,
    renderRetry: input => <RoundButton {...input} size="small" display="secondary" />,
    renderAdd: ({ title, ...input }) => <IconButton {...input} iconName="plus" variant="plain" tooltip={title} />,
  }} />;
});
