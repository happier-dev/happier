import * as React from 'react';
import { useIsAppDestinationRootPath } from '@/components/appShell/destinations/useCompactAppDestinations';
import { Stack, usePathname } from '@/components/appShell/workspace/destinationRoute';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import {
  formatHappierPageCount,
  HappierPageCountLine,
  type HappierPageCountLineTextRender,
  type HappierSearchDisclosure,
  useHappierSearchDisclosure,
} from '@happier-dev/plugin-ui/presentation';

import {
  usePublishPageCreateAction,
  type PageCreateAction,
} from '@/components/navigation/mobile/chrome/pageCreateAction';
import { COMPACT_SEARCH_FIELD_CLOSE_BUTTON_SIZE_PX, CompactSearchField } from '@/components/ui/forms/CompactSearchField';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { ICON_SIZE } from '@/components/ui/icons/Icon';
import { t } from '@/text';
import { Text } from '@/components/ui/text/Text';
import { useLayoutMaxWidth } from '@/components/ui/layout/layout';
import { resolveItemGroupContentHorizontalInsetPx } from '@/components/ui/lists/itemGroupSpacing';
import {
  PageHeader,
  type PageHeaderProps,
} from '@/components/ui/layout/PageHeader';
import { NavigationLargeTitleProvider } from '@/components/ui/layout/navigationTitleChrome';
import {
  CollectionCreateButton,
  CollectionSearchToggle,
} from '@/components/ui/lists/collection/CollectionList';
import { useDeviceType } from '@/utils/platform/responsive';

import { PhoneMainTabLine } from './PhoneMainTabLine';

/** The search a main screen keeps behind the magnifier on its title row. */
export type MainScreenSearch = Readonly<{
  value: string;
  onChangeText: (query: string) => void;
  placeholder: string;
  testID: string;
  /** Ends the field (a saved space's filter funnel, as the Sessions field ends with it). */
  trailing?: React.ReactNode;
  /** A field that hands its query on (Discover opens the Search page with it) rather than filtering in place. */
  onSubmitEditing?: () => void;
}>;

export type MainScreenHeaderProps = Readonly<{
  testID?: string;
  title: string;
  /** The title as a control ("Artifacts ⌄", a saved space's "All workflows ⌄"): its scope and filters. */
  titleControl?: React.ReactNode;
  alwaysShowTitle?: boolean;
  description?: string;
  details?: React.ReactNode;
  meta?: PageHeaderProps['meta'];
  /** Title-row controls after the magnifier, before the "+" (a "⋯"). */
  actions?: React.ReactNode;
  search?: MainScreenSearch | null;
  /** The page's create action: the title row's "+" and, on a phone, the bar's "+" beside the tabs. */
  create?: PageCreateAction | null;
  /**
   * Replaces the title row's "+" when there is more than one way to add (a menu whose trigger is a "+"); `null`
   * when `actions` already draws it. `create` still lends the bar its "+".
   */
  createTrigger?: React.ReactNode;
  /** What stands right under the title: filter chips, a view switch, a saved space's strip. */
  band?: React.ReactNode;
  /** The page's count line ("40 artifacts · 1 saved today"), last before the body: the owner's counts, one per part. */
  count?: readonly (string | null | undefined | false)[];
  /** The counts are still being read: the line keeps its place, empty, so nothing moves when they arrive. */
  countPending?: boolean;
  /** What the open search reports (its scope, "Search everything"), under the field. Never a count. */
  status?: React.ReactNode;
}>;

/**
 * A main screen's head (owner 11-10/11-11): on a phone, the Home line above it; the title (or the title as its scope control), then on the same row
 * the magnifier that opens the search field and the "+" that runs the page's create action; the bar's "+" runs
 * the same action on a phone. What the title scopes (chips, a view switch, a count) sits right under it. The one
 * owner every main screen that is a page draws; a column-headed list draws the Collection's own header.
 */
export const MainScreenHeader = React.memo(function MainScreenHeader(
  props: MainScreenHeaderProps,
) {
  const phone = useDeviceType() === 'phone';
  // A main screen (a rail destination's own route) has no bar above it on a phone: the tab bar is its way around and
  // this head is its title row. A page pushed over it keeps its bar and Back.
  const mainScreen = useIsAppDestinationRootPath(usePathname());
  const create = props.create ?? null;
  usePublishPageCreateAction(phone ? create : null);
  const search = props.search ?? null;
  const searchState = useMainScreenSearch(search);
  const columnMaxWidth = useLayoutMaxWidth();
  // The count line's one owner (shared with a plugin page header's `count`) formats, draws and reserves it.
  const hasCount = props.countPending === true || (props.count !== undefined && formatHappierPageCount(props.count) !== null);
  const createControl =
    props.createTrigger !== undefined
      ? props.createTrigger
      : create
        ? <CollectionCreateButton create={create} />
        : null;
  const hasActions =
    props.actions != null || search !== null || createControl !== null;
  return (
    // One piece: a host that spaces its header's pieces (a Collection's header stack) never splits the title from
    // the chips under it, so the band stands at the same step under the title on every main screen.
    <View style={styles.head}>
      {phone && mainScreen ? <Stack.Screen options={MAIN_SCREEN_BAR} /> : null}
      {/* Every phone main screen opens on the same line: the Home it is on, Activity and the avatar (F2, owner Q4). */}
      {phone && mainScreen ? <PhoneMainTabLine /> : null}
      <NavigationLargeTitleProvider largeTitle={phone}>
        <PageHeader
          {...(props.testID === undefined ? {} : { testID: props.testID })}
          title={props.title}
          {...(props.titleControl == null
            ? {}
            : { titleControl: props.titleControl })}
          {...(props.alwaysShowTitle ? { alwaysShowTitle: true } : {})}
          {...(props.description === undefined
            ? {}
            : { description: props.description })}
          {...(props.details == null ? {} : { details: props.details })}
          {...(props.meta === undefined ? {} : { meta: props.meta })}
          actionsPlacement="page"
          // The controls hang from the title's line; the description takes the page's whole width beneath (F2).
          actionsLayout="hang"
          actions={
            hasActions ? (
              <>
                {search ? (
                  <CollectionSearchToggle
                    testID={`${search.testID}:toggle`}
                    controlRef={searchState.toggleRef}
                    open={searchState.open}
                    onPress={searchState.toggle}
                    accessibilityLabel={search.placeholder}
                  />
                ) : null}
                {props.actions}
                {createControl}
              </>
            ) : undefined
          }
        />
      </NavigationLargeTitleProvider>
      {props.band != null || (search && searchState.open) || props.status != null || hasCount ? (
        // The sheets' measure (capped and centred like `ItemGroup`), so the rows stand on the cards' edge at any width.
        <View style={styles.underBand}>
          <View style={[styles.under, { maxWidth: columnMaxWidth, paddingHorizontal: resolveItemGroupContentHorizontalInsetPx() }]}>
          {props.band}
          {search && searchState.open ? (
            <CompactSearchField
              testID={search.testID}
              value={search.value}
              onChangeText={search.onChangeText}
              placeholder={search.placeholder}
              autoFocus={searchState.focusOnOpen}
              onKeyPress={searchState.onKeyPress}
              {...(search.onSubmitEditing === undefined ? {} : { onSubmitEditing: search.onSubmitEditing })}
              // The field ends with what narrows it (a funnel), then its close (My work's field, owner 11-11).
              trailing={
                <>
                  {search.trailing}
                  <IconButton
                    testID={`${search.testID}:close`}
                    accessibilityLabel={t('sessionsList.closeSearch')}
                    variant="plain"
                    size={COMPACT_SEARCH_FIELD_CLOSE_BUTTON_SIZE_PX}
                    iconSize={ICON_SIZE.xs}
                    iconName="x"
                    onPress={searchState.close}
                  />
                </>
              }
            />
          ) : null}
          {props.status}
          {hasCount ? (
            <HappierPageCountLine parts={props.count ?? NO_COUNT} {...(props.countPending === true ? { pending: true } : {})}
              {...(props.testID === undefined ? {} : { testID: `${props.testID}:count` })} renderText={renderCountText} />
          ) : null}
          </View>
        </View>
      ) : null}
    </View>
  );
});

/**
 * The magnifier's field: the one search-behind-a-magnifier rule (`useHappierSearchDisclosure`), shared with a plugin
 * collection page's large title. Only an explicit open focuses, so a retained query restoring the page does not steal
 * focus.
 */
export function useMainScreenSearch(search: MainScreenSearch | null): HappierSearchDisclosure {
  const onChangeText = search?.onChangeText;
  const clear = React.useCallback(() => onChangeText?.(''), [onChangeText]);
  return useHappierSearchDisclosure(search?.value ?? '', onChangeText === undefined ? undefined : clear);
}

const MAIN_SCREEN_BAR = Object.freeze({ headerShown: false });
const NO_COUNT: readonly string[] = Object.freeze([]);
// Core's own text owner draws the shared count line's words (its type scale and font scaling).
const renderCountText: HappierPageCountLineTextRender = (input) => (
  <Text testID={input.testID} variant="meta" numberOfLines={1} style={styles.count}>{input.text}</Text>
);

const styles = StyleSheet.create((theme) => ({
  head: {
    alignSelf: 'stretch',
  },
  // Right under the title (owner 11-11), on the sheets' edge: the header's own bottom padding is the gap above; the
  // band, the open field and the count line sit one small step apart and end with that step before the page's first
  // section, so the chips sit on the title and the count line on what it counts.
  underBand: {
    alignSelf: 'stretch',
    alignItems: 'center',
  },
  count: {
    color: theme.colors.text.secondary,
    fontVariant: ['tabular-nums'],
  },
  under: {
    width: '100%',
    paddingBottom: theme.space.s8,
    gap: theme.space.s8,
  },
}));
