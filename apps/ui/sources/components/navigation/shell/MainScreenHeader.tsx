import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import {
  usePublishPageCreateAction,
  type PageCreateAction,
} from '@/components/navigation/mobile/chrome/pageCreateAction';
import { CompactSearchField } from '@/components/ui/forms/CompactSearchField';
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

/** The search a main screen keeps behind the magnifier on its title row. */
export type MainScreenSearch = Readonly<{
  value: string;
  onChangeText: (query: string) => void;
  placeholder: string;
  testID: string;
  /** Ends the field (a saved space's filter funnel, as the Sessions field ends with it). */
  trailing?: React.ReactNode;
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
  /** The page's count line ("40 artifacts · 1 saved today"), last before the body, under the open search field. */
  status?: React.ReactNode;
}>;

/**
 * A main screen's head (owner 11-10/11-11): the title (or the title as its scope control), then on the same row
 * the magnifier that opens the search field and the "+" that runs the page's create action; the bar's "+" runs
 * the same action on a phone. What the title scopes (chips, a view switch, a count) sits right under it. The one
 * owner every main screen that is a page draws; a column-headed list draws the Collection's own header.
 */
export const MainScreenHeader = React.memo(function MainScreenHeader(
  props: MainScreenHeaderProps,
) {
  const phone = useDeviceType() === 'phone';
  const create = props.create ?? null;
  usePublishPageCreateAction(phone ? create : null);
  const search = props.search ?? null;
  const searchState = useMainScreenSearch(search);
  const columnMaxWidth = useLayoutMaxWidth();
  const createControl =
    props.createTrigger !== undefined
      ? props.createTrigger
      : create
        ? <CollectionCreateButton create={create} />
        : null;
  const hasActions =
    props.actions != null || search !== null || createControl !== null;
  return (
    <>
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
          actionsLayout="inline"
          actions={
            hasActions ? (
              <>
                {search ? (
                  <CollectionSearchToggle
                    testID={`${search.testID}:toggle`}
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
      {props.band != null || (search && searchState.open) || props.status != null ? (
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
              {...(search.trailing == null ? {} : { trailing: search.trailing })}
            />
          ) : null}
          {props.status}
          </View>
        </View>
      ) : null}
    </>
  );
});

/**
 * The magnifier's field: closed until pressed; a query keeps it open; pressing again (or clearing) closes it and
 * clears the query. Only an explicit open focuses, so a retained query restoring the page does not steal focus.
 */
export function useMainScreenSearch(
  search: MainScreenSearch | null,
): Readonly<{ open: boolean; focusOnOpen: boolean; toggle: () => void }> {
  const [opened, setOpened] = React.useState(false);
  const value = search?.value ?? '';
  const onChangeText = search?.onChangeText;
  const open = opened || value.length > 0;
  const toggle = React.useCallback(() => {
    if (open) {
      onChangeText?.('');
      setOpened(false);
    } else {
      setOpened(true);
    }
  }, [onChangeText, open]);
  return { open, focusOnOpen: opened && value.length === 0, toggle };
}

const styles = StyleSheet.create((theme) => ({
  // Right under the title (owner 11-11), on the sheets' edge: the header's own bottom padding is the gap above; the
  // band, the open field and the count line sit one small step apart and end with that step before the page's first
  // section, so the chips sit on the title and the count line on what it counts.
  underBand: {
    alignSelf: 'stretch',
    alignItems: 'center',
  },
  under: {
    width: '100%',
    paddingBottom: theme.space.s8,
    gap: theme.space.s8,
  },
}));
