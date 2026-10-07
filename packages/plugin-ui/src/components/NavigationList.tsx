import type { ReactElement, ReactNode } from 'react';
import type { PluginUiHostApi } from '@happier-dev/plugin-sdk/ui';
import { useOptionalPluginUiPresentationHost } from '../presentationHost/context.js';
import { ScrollView, StyleSheet, View, type ViewStyle } from 'react-native';

import { useOptionalHappierUiTypography } from '../environment/context.js';
import {
  HAPPIER_COLLECTION_LIST_TEXT,
  HappierCollectionList,
  HappierCollectionListGroupLabel,
  type HappierCollectionListHost,
  type HappierCollectionListTextRole,
} from '../presentation/collection/CollectionList.js';
import { HappierListItem } from '../presentation/collection/List.js';
import { HappierTextField } from '../presentation/form/Fields.js';
import { HAPPIER_SEARCH_FIELD_METRICS } from '../presentation/form/FieldBox.js';
import { resolveHappierTextStepStyle } from '../presentation/layout/pageText.js';
import type { HappierStyleProp } from '../presentation/portableTypes.js';
import { HappierText } from '../presentation/text/Text.js';
import { Icon, PluginUiIconGlyph, type IconName } from './Icon.js';
import { usePluginTheme, usePluginTranslation } from './PluginUiProvider.js';
import { resolveAuthorText } from './resolveAuthorText.js';

export type NavigationListSearchProps = Readonly<{
  value: string;
  onValueChange: (value: string) => void;
  /** Visible placeholder and assistive-technology name of the field. */
  label: string;
  testID?: string;
}>;

/**
 * A state a row or a group speaks for — only a state, never activity. `attention` draws the warning
 * glyph, `paused` the pause glyph; `label` says it in words (a row's accessible name, a group's
 * visible text).
 */
export type NavigationListStatus = Readonly<{
  kind: 'attention' | 'paused';
  label: string;
}>;

/** The column's one way out, pinned under its rows (the settings of what it lists). */
export type NavigationListFooter = Readonly<{
  title: string;
  icon: IconName;
  onPress: () => unknown;
  testID?: string;
}>;

export type NavigationListProps = Readonly<{
  /** The column's title, beside its count. */
  title?: string;
  titleKey?: string;
  /** A quiet, tabular count beside the title; omit it while unknown. */
  count?: number | null;
  /** The column's one header action (an `IconButton` "+", or a menu). */
  headerAction?: ReactNode;
  /**
   * A search field under the header. Pass it only once the list is long enough to need it; the
   * author filters its own rows (no results is one quiet row, and only for a real query).
   */
  search?: NavigationListSearchProps | null;
  /** A row pinned under the scrolling rows, above a hairline. */
  footer?: NavigationListFooter;
  children?: ReactNode;
  testID?: string;
}>;

export type NavigationListGroupProps = Readonly<{
  /** What the rows share, as a quiet sentence-case label. */
  title?: string;
  titleKey?: string;
  count?: number;
  /** The first group directly under the header sits closer to it. */
  first?: boolean;
  /** An identity mark before the title (a brand mark the rows share). */
  mark?: ReactNode;
  /** A state that concerns every row of the group, said once here instead of on each row. */
  status?: NavigationListStatus;
  children?: ReactNode;
}>;

export type NavigationListRowProps = Readonly<{
  /** The same qualified page/location ordinary activation opens; the host supplies workspace gestures. */
  destination?: NavigationListDestination;
  title?: string;
  titleKey?: string;
  /** A glyph from the icon vocabulary, drawn in the rows' leading column in the quiet glyph colour. */
  icon?: IconName;
  /** An identity mark instead of a glyph (a brand mark, an avatar), in the same leading column. */
  mark?: ReactNode;
  /** A quiet value at the row's end (a count). */
  detail?: string;
  /** The row the page currently shows: the plane's selected chip. */
  selected?: boolean;
  /** The row's own state, as a glyph at its end; its words join the row's accessible name. */
  status?: NavigationListStatus;
  onPress: () => unknown;
  disabled?: boolean;
  accessibilityLabel?: string;
  testID?: string;
}>;

export type NavigationListDestination = Readonly<{
  destination: Parameters<PluginUiHostApi['openSurface']>[0];
  subPath?: string;
}>;

const TEXT_COLOR_ROLE: Readonly<Record<HappierCollectionListTextRole, 'text' | 'secondaryText' | 'mutedText'>> = {
  title: 'text',
  count: 'mutedText',
  groupTitle: 'secondaryText',
  groupHeading: 'text',
  groupCount: 'mutedText',
};

function NavigationListText(props: Readonly<{
  role: HappierCollectionListTextRole;
  numberOfLines?: number;
  accessibilityRole?: 'header';
  children: ReactNode;
}>): ReactElement {
  const theme = usePluginTheme();
  const typography = useOptionalHappierUiTypography();
  return (
    <HappierText
      numberOfLines={props.numberOfLines}
      accessibilityRole={props.accessibilityRole}
      tabularNumbers={props.role === 'count' || props.role === 'groupCount'}
      style={{
        ...resolveHappierTextStepStyle(HAPPIER_COLLECTION_LIST_TEXT[props.role], typography),
        color: theme.colors[TEXT_COLOR_ROLE[props.role]],
        ...(props.role === 'groupTitle' || props.role === 'groupHeading' ? { flexShrink: 1 } : null),
      }}
    >
      {props.children}
    </HappierText>
  );
}

function NavigationListScroller(props: Readonly<{ style: HappierStyleProp; children: ReactNode }>): ReactElement {
  return <ScrollView style={props.style as never}>{props.children}</ScrollView>;
}

function NavigationListSearchField(props: Readonly<{
  value: string;
  onChangeText: (text: string) => void;
  placeholder: string;
  testID?: string;
  style: HappierStyleProp;
}>): ReactElement {
  const theme = usePluginTheme();
  return (
    <View style={props.style as never}>
    <HappierTextField
      label={props.placeholder}
      appearance="search"
      placeholder={props.placeholder}
      value={props.value}
      onChangeText={props.onChangeText}
      autoCapitalize="none"
      autoCorrect={false}
      leading={<PluginUiIconGlyph name="search" size={HAPPIER_SEARCH_FIELD_METRICS.iconSizePx} tone="secondary" />}
      theme={theme}
      {...(props.testID === undefined ? {} : { testID: props.testID })}
    />
    </View>
  );
}

/**
 * The plugin realm's host primitives for the shared list anatomy. The list lies on the host's
 * plane — `surfaceStyle` is empty — so a plugin column can never paint a ground of its own.
 */
const NAVIGATION_LIST_HOST: HappierCollectionListHost = Object.freeze({
  Text: NavigationListText,
  Scroller: NavigationListScroller,
  SearchField: NavigationListSearchField,
  surfaceStyle: null,
});

function NavigationListRoot(props: NavigationListProps): ReactElement {
  const translate = usePluginTranslation();
  const title = resolveAuthorText(translate, props.title, props.titleKey) ?? '';
  return (
    <HappierCollectionList
      host={NAVIGATION_LIST_HOST}
      title={title}
      {...(props.testID === undefined ? {} : { testID: props.testID })}
      {...(props.count === undefined ? {} : { count: props.count })}
      {...(props.headerAction === undefined ? {} : { headerAction: props.headerAction })}
      search={props.search ? {
        value: props.search.value,
        onChangeText: props.search.onValueChange,
        placeholder: props.search.label,
        ...(props.search.testID === undefined ? {} : { testID: props.search.testID }),
      } : null}
      {...(props.footer === undefined ? {} : { footer: <NavigationListFootRow footer={props.footer} /> })}
    >
      {props.children}
    </HappierCollectionList>
  );
}

const STATUS_ICON: Readonly<Record<NavigationListStatus['kind'], Readonly<{ name: IconName; tone: 'warning' | 'muted' }>>> = {
  attention: { name: 'warning', tone: 'warning' },
  paused: { name: 'pause', tone: 'muted' },
};

const groupStatusStyle: ViewStyle = { flexDirection: 'row', alignItems: 'center', gap: 5, flexShrink: 0 };
const footStyle: ViewStyle = { borderTopWidth: StyleSheet.hairlineWidth, paddingVertical: 6 };

function NavigationListGroupStatus(props: Readonly<{ status: NavigationListStatus }>): ReactElement {
  const theme = usePluginTheme();
  const typography = useOptionalHappierUiTypography();
  const icon = STATUS_ICON[props.status.kind];
  return (
    <View style={groupStatusStyle}>
      <Icon name={icon.name} size="small" tone={icon.tone} />
      <HappierText
        numberOfLines={1}
        style={{
          ...resolveHappierTextStepStyle(HAPPIER_COLLECTION_LIST_TEXT.groupCount, typography),
          color: props.status.kind === 'attention' ? theme.colors.attention : theme.colors.mutedText,
        }}
      >
        {props.status.label}
      </HappierText>
    </View>
  );
}

function NavigationListFootRow(props: Readonly<{ footer: NavigationListFooter }>): ReactElement {
  const theme = usePluginTheme();
  return (
    <View style={[footStyle, { borderTopColor: theme.colors.divider }]}>
      <HappierListItem
        title={props.footer.title}
        titleNumberOfLines={1}
        icon={<Icon name={props.footer.icon} tone="secondary" />}
        accessory={<Icon name="forward" size="small" tone="muted" />}
        accessibilityRole="button"
        onPress={() => props.footer.onPress()}
        showDivider={false}
        {...(props.footer.testID === undefined ? {} : { testID: props.footer.testID })}
      />
    </View>
  );
}

function NavigationListGroup(props: NavigationListGroupProps): ReactElement {
  const translate = usePluginTranslation();
  const title = resolveAuthorText(translate, props.title, props.titleKey);
  return (
    <>
      {title ? (
        <HappierCollectionListGroupLabel
          host={NAVIGATION_LIST_HOST}
          title={title}
          {...(props.count === undefined ? {} : { count: props.count })}
          {...(props.first === undefined ? {} : { first: props.first })}
          {...(props.mark === undefined ? {} : { mark: props.mark })}
          {...(props.status === undefined ? {} : { trailing: <NavigationListGroupStatus status={props.status} /> })}
        />
      ) : null}
      {props.children}
    </>
  );
}

function NavigationListRow(props: NavigationListRowProps): ReactElement {
  const host = useOptionalPluginUiPresentationHost();
  const translate = usePluginTranslation();
  const title = resolveAuthorText(translate, props.title, props.titleKey) ?? '';
  const status = props.status === undefined ? undefined : STATUS_ICON[props.status.kind];
  const accessibilityLabel = props.status === undefined
    ? props.accessibilityLabel
    : `${props.accessibilityLabel ?? title}, ${props.status.label}`;
  const row = (
    <HappierListItem
      title={title}
      titleNumberOfLines={1}
      icon={props.icon !== undefined ? <Icon name={props.icon} tone="secondary" /> : props.mark}
      detail={props.detail}
      {...(status === undefined ? {} : { accessory: <Icon name={status.name} size="small" tone={status.tone} /> })}
      selected={props.selected === true}
      accessibilityRole="button"
      onPress={() => props.onPress()}
      showDivider={false}
      {...(props.disabled === undefined ? {} : { disabled: props.disabled })}
      {...(accessibilityLabel === undefined ? {} : { accessibilityLabel })}
      {...(props.testID === undefined ? {} : { testID: props.testID })}
    />
  );
  return <>{props.destination && !props.disabled && host?.renderDestinationRow
    ? host.renderDestinationRow({ ...props.destination, children: row }) : row}</>;
}

/**
 * A plugin's navigation column, drawn with the shell's own column anatomy (the Sessions, Projects,
 * Plugins and Settings columns): a title with a quiet count and one header action, search only
 * when the list is long, quiet group labels and flat rows with the plane's selected chip. The plane
 * behind it is the host's; a plugin cannot restyle the plane or the rows.
 *
 * ```tsx
 * <NavigationList title="Views" count={views.length} headerAction={<NewViewButton />}>
 *   {views.map((v) => (
 *     <NavigationList.Row key={v.id} title={v.name} selected={v.path === subPath}
 *       onPress={() => host.openSurface(PAGE, { subPath: v.path })} />
 *   ))}
 * </NavigationList>
 * ```
 */
export const NavigationList = Object.assign(NavigationListRoot, {
  Group: NavigationListGroup,
  Row: NavigationListRow,
});
