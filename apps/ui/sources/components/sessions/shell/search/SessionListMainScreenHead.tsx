import * as React from 'react';
import { Platform, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';

import { MainScreenHeader } from '@/components/navigation/shell/MainScreenHeader';
import { Icon } from '@/components/ui/icons/Icon';
import { CollectionFilterButton } from '@/components/ui/lists/collection/CollectionFilterButton';
import {
  CollectionSpaceSwipeTitle,
  CollectionSpaceSwipeZone,
  useCollectionSpaceSwipeTrack,
} from '@/components/ui/lists/collection/CollectionSpaceSwipeZone';
import { SelectionListFilterChip } from '@/components/ui/selectionList';
import { Text } from '@/components/ui/text/Text';
import { focusRingStyle } from '@/components/ui/interactions/interactionFeedback';
import { t } from '@/text';

import {
  SessionListViewOptionsButton,
  stopPressEventPropagation,
} from '../sessionListChrome';
import { sessionListStyles } from '../sessionListStyles';
import { sessionListSubjectCopyKey } from '../sessionListViewEmptyStateModel';
import type { SessionListSearchChromeProps } from './SessionListSearchChrome';

/**
 * My work as a phone main screen (owner 11-11): the one main-screen head every main screen draws (it opens on the
 * Home line) — the space as the title ("My work ⌄"), the magnifier and View options on its row; the
 * spaces and their conditions right under it; the field (with its funnel) and what the search says last. Only the
 * facts are the session list's; the anatomy is the shared head's.
 */
export const SessionListMainScreenHead = React.memo(
  function SessionListMainScreenHead(props: SessionListSearchChromeProps) {
    const styles = sessionListStyles;
    const { theme } = useUnistyles();
    const spaceChrome = props.spacesStrip !== undefined;
    const spaceSwipeTrack = useCollectionSpaceSwipeTrack();
    const spaceSwipeCommit = props.spaceSwipe?.onCommit;
    const handleSpaceSwipe = React.useCallback(
      (direction: -1 | 1) => spaceSwipeCommit?.(direction),
      [spaceSwipeCommit],
    );
    const trimmedQuery = props.searchQuery.trim();
    const { onSearchEverything, searchStatus } = props;
    const placeholder = t(
      sessionListSubjectCopyKey(
        'sessionsList.searchSessionsPlaceholder',
        props.subject,
      ),
    );
    const filterButton = props.filterButton;
    const trailing =
      props.searchTrailingAccessory !== undefined || filterButton ? (
        <>
          {props.searchTrailingAccessory !== undefined ? (
            <View
              testID="session-list-search-trailing-accessory"
              pointerEvents="none"
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
              style={styles.headerSearchTrailingAccessory}
            >
              {props.searchTrailingAccessory}
            </View>
          ) : null}
          {/* The funnel ends the field (lab `spfield` B): the filters open from what they narrow. */}
          {filterButton ? (
            <CollectionFilterButton
              testID="session-list-filter-open"
              activeCount={filterButton.activeCount}
              open={filterButton.open}
              onPress={filterButton.onPress}
            />
          ) : null}
        </>
      ) : undefined;
    const search = React.useMemo(
      () => ({
        value: props.searchQuery,
        onChangeText: props.onSearchQueryChange,
        placeholder,
        testID: 'session-list-search',
        ...(trailing === undefined ? {} : { trailing }),
      }),
      [placeholder, props.onSearchQueryChange, props.searchQuery, trailing],
    );
    const resetControl = props.filterSummary ? (
      <HappierPressable
        testID="session-list-filter-summary-reset"
        accessibilityRole="button"
        accessibilityLabel={t('common.reset')}
        onPress={props.filterSummary.onReset}
        style={(state) => [
          styles.searchChromeStatusRetry,
          focusRingStyle({
            focused: state.focused,
            color: theme.colors.border.focus,
          }),
        ]}
      >
        <Text style={styles.searchChromeStatusActionText}>
          {t('common.reset')}
        </Text>
      </HappierPressable>
    ) : null;
    const band = spaceChrome ? (
      <>
        {props.spacesStrip}
        {props.filterTokens}
      </>
    ) : props.filterSummary || (props.filterChips?.length ?? 0) > 0 ? (
      <>
        {props.filterSummary ? (
          <View
            testID="session-list-filter-summary"
            style={styles.searchChromeStatusRow}
          >
            <Text style={styles.searchChromeStatusText}>
              {props.filterSummary.label}
            </Text>
            {resetControl}
          </View>
        ) : null}
        {props.filterChips && props.filterChips.length > 0 ? (
          <View
            testID="session-list-filter-chips"
            style={styles.searchChromeChipRow}
          >
            {props.filterChips.map((filter) => (
              <SelectionListFilterChip key={filter.id} filter={filter} />
            ))}
          </View>
        ) : null}
      </>
    ) : undefined;
    const status =
      trimmedQuery.length > 0 &&
      (props.searchScopeLabel || searchStatus || onSearchEverything) ? (
        <>
          {props.searchScopeLabel ? (
            <View
              testID="session-list-search-scope"
              accessibilityLiveRegion="polite"
              style={styles.searchChromeScopeRow}
            >
              <Icon
                name="hard-drives"
                size={13}
                color={theme.colors.text.secondary}
              />
              <Text style={styles.searchChromeScopeText}>
                {props.searchScopeLabel}
              </Text>
            </View>
          ) : null}
          {searchStatus ? (
            <View
              testID="session-list-search-status"
              accessibilityLiveRegion="polite"
              role={Platform.OS === 'web' ? 'status' : undefined}
              style={styles.searchChromeStatusRow}
            >
              <Text style={styles.searchChromeStatusText}>
                {searchStatus.message}
              </Text>
              {searchStatus.onRetry ? (
                <HappierPressable
                  testID="session-list-search-retry"
                  accessibilityRole="button"
                  accessibilityLabel={t('common.retry')}
                  onPress={(event?: unknown) => {
                    stopPressEventPropagation(event);
                    searchStatus.onRetry?.();
                  }}
                  style={styles.searchChromeStatusRetry}
                >
                  <Text style={styles.searchChromeStatusRetryText}>
                    {t('common.retry')}
                  </Text>
                </HappierPressable>
              ) : null}
            </View>
          ) : null}
          {onSearchEverything ? (
            <HappierPressable
              testID="session-list-search-everything"
              accessibilityRole="button"
              accessibilityLabel={t('sessionsList.searchEverythingFor', {
                query: trimmedQuery,
              })}
              onPress={(event?: unknown) => {
                stopPressEventPropagation(event);
                onSearchEverything(trimmedQuery);
              }}
              hitReach={{ top: 4, bottom: 4 }}
              style={styles.searchChromeEscalationRow}
            >
              <Icon
                name="magnifying-glass"
                size={14}
                color={theme.colors.text.secondary}
              />
              <Text style={styles.searchChromeEscalationText}>
                {t('sessionsList.searchEverythingFor', { query: trimmedQuery })}
              </Text>
            </HappierPressable>
          ) : null}
        </>
      ) : undefined;
    return (
      <View
        ref={props.anchorRef}
        collapsable={false}
        testID="session-list-search-chrome"
      >
        <CollectionSpaceSwipeZone
          testID="session-list-space-swipe-zone"
          track={spaceSwipeTrack}
          enabled={spaceChrome && props.spaceSwipe !== undefined}
          canPrevious={props.spaceSwipe?.canPrevious ?? false}
          canNext={props.spaceSwipe?.canNext ?? false}
          onCommit={handleSpaceSwipe}
        >
          <MainScreenHeader
            testID="session-list-header"
            title={t('tabs.sessions')}
            titleControl={
              spaceChrome ? (
                <CollectionSpaceSwipeTitle
                  track={spaceSwipeTrack}
                  previousLabel={props.spaceSwipe?.previousLabel ?? null}
                  nextLabel={props.spaceSwipe?.nextLabel ?? null}
                >
                  {props.filterControl}
                </CollectionSpaceSwipeTitle>
              ) : (
                props.filterControl
              )
            }
            search={search}
            // The layout choice lives in View options on a phone: the title row keeps the space's whole name, as the
            // column's segment yields to View options when the row is too narrow for both.
            actions={
              <SessionListViewOptionsButton
                onOpenFilter={filterButton ? filterButton.onPress : undefined}
                placement="bottom"
                serverId={props.organizationServerId}
              />
            }
            band={band}
            status={status}
          />
        </CollectionSpaceSwipeZone>
        {props.overlays}
      </View>
    );
  },
);
