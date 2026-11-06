import * as React from 'react';
import { View } from 'react-native';
import { HappierChevron } from '../presentation/collection/DisclosureChevron.js';
import {
  HappierRegistryShelf, type RegistryShelfHost, type RegistryShelfProps,
} from '../presentation/capabilities/RegistryShelf.js';
import {
  HappierRegistryShelfAddControl, type RegistryShelfAddControlProps,
} from '../presentation/capabilities/RegistryShelfAddControl.js';
import {
  HappierRegistrySourcesUnavailable, type RegistrySourceFailure, type RegistrySourcesUnavailableProps,
  type RegistrySourcesUnavailableStateProps,
} from '../presentation/capabilities/RegistrySourcesUnavailable.js';
import { PluginUiPresentationHostProviderInternal, useOptionalPluginUiPresentationHost } from '../presentationHost/context.js';
import { Button, IconButton } from './Button.js';
import { PluginUiIconGlyph } from './Icon.js';
import { Item, ItemGroup } from './List.js';
import { SurfaceState } from './State.js';
import { HappierText } from '../presentation/text/Text.js';
import { usePluginTheme, usePluginTranslation } from './PluginUiProvider.js';

export type { RegistryShelfProps, RegistryShelfProjection, RegistryShelfUnavailable } from '../presentation/capabilities/RegistryShelf.js';
export type { RegistryShelfAddControlProps, RegistryShelfAddState } from '../presentation/capabilities/RegistryShelfAddControl.js';
export type { RegistrySourceFailure, RegistrySourcesUnavailableProps } from '../presentation/capabilities/RegistrySourcesUnavailable.js';

function ShelfScope(props: React.ComponentProps<RegistryShelfHost['Scope']>) {
  const parent = useOptionalPluginUiPresentationHost();
  const host = React.useMemo(() => parent ? { ...parent, renderPageScroller: props.renderPageScroller } : null, [parent, props.renderPageScroller]);
  return host ? <PluginUiPresentationHostProviderInternal host={host}>{props.children}</PluginUiPresentationHostProviderInternal> : <>{props.children}</>;
}
function ShelfRow({ rightElement, showChevron: _showChevron, ...props }: React.ComponentProps<RegistryShelfHost['Row']>) {
  return <Item {...props} accessory={rightElement} accessoryOutsidePressable />;
}
function BrowseAll({ destination: _destination, title, ...props }: React.ComponentProps<RegistryShelfHost['BrowseAll']>) {
  const theme = usePluginTheme();
  return <Button {...props} title={title} size="small" variant="plain">
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.xsmall }}>
      <HappierText variant="label" tone="secondary">{title}</HappierText>
      <HappierChevron direction="right" color={theme.colors.secondaryText} size={14} />
    </View>
  </Button>;
}
const shelfHost: RegistryShelfHost = { Section: ItemGroup, Row: ShelfRow, BrowseAll, Scope: ShelfScope, Unavailable: RegistrySourcesUnavailable };

/** A registry's suggestions; acquisition, projection and commands remain with the caller. */
export function RegistryShelf<Item>(props: RegistryShelfProps<Item>) {
  return <HappierRegistryShelf {...props} host={shelfHost} />;
}

/** One Add, pending, retry and acknowledged-success presentation for a shelf item. */
export function RegistryShelfAddControl(props: RegistryShelfAddControlProps) {
  const theme = usePluginTheme();
  return <HappierRegistryShelfAddControl {...props} host={{
    renderAddedIcon: () => <PluginUiIconGlyph name="check" size={14} color={theme.colors.secondaryText} />,
    renderAddedLabel: label => <HappierText variant="meta" numberOfLines={1} tone="secondary">{label}</HappierText>,
    renderRetry: input => <Button {...input} size="small" variant="secondary" />,
    renderAdd: ({ title: _title, ...input }) => <IconButton {...input} icon={<PluginUiIconGlyph name="add" size={14} tone="secondary" />} />,
  }} />;
}

function UnavailableState({ reason, ...props }: RegistrySourcesUnavailableStateProps) {
  return <SurfaceState {...props} description={reason} />;
}
function DetailText(props: Readonly<{ children: React.ReactNode }>) {
  return <HappierText variant="meta" tone="secondary">{props.children}</HappierText>;
}
const retry = (onRetry: RegistrySourceFailure['onRetry']) => { void Promise.resolve(onRetry()).catch(() => {}); };
const unavailableHost = { State: UnavailableState, DetailText, retry };

/** A quiet outage line or page state with caller-provided failure facts and recovery. */
export function RegistrySourcesUnavailable(props: RegistrySourcesUnavailableProps) {
  const translate = usePluginTranslation();
  return <HappierRegistrySourcesUnavailable {...props} host={unavailableHost} labels={{
    sourcesUnreachable: count => translate('capabilities.store.sourcesUnreachable', `${count} sources could not be reached`, { count }),
    retry: translate('capabilities.store.retry', 'Try again'), showDetails: translate('common.details', 'Details'),
    hideDetails: translate('capabilities.store.hideSources', 'Hide sources'),
  }} />;
}
