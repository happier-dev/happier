import * as React from 'react';
import { Animated, Easing, Platform, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { HappierPressable, resolveHappierCollectionTitleAccessoryFits } from '@happier-dev/plugin-ui/presentation';

import { IconButton } from '@/components/ui/buttons/IconButton';
import { CompactSearchField } from '@/components/ui/forms/CompactSearchField';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { SelectionListFilterChip, type SelectionListFilter } from '@/components/ui/selectionList';
import { Text } from '@/components/ui/text/Text';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { t } from '@/text';
import { focusRingStyle } from '@/components/ui/interactions/interactionFeedback';

import { SessionListLayoutSegment, SessionListViewOptionsButton, stopPressEventPropagation } from '../sessionListChrome';
import { SESSION_LIST_COLUMN_METRICS, sessionListStyles } from '../sessionListStyles';
import { CollectionFilterButton } from '@/components/ui/lists/collection/CollectionFilterButton';
import { CollectionTitleNaturalWidthContext } from '@/components/ui/lists/collection/CollectionTitleButton';
import { CollectionSpaceSwipeTitle, CollectionSpaceSwipeZone, useCollectionSpaceSwipeTrack } from '@/components/ui/lists/collection/CollectionSpaceSwipeZone';
import { useIsTablet } from '@/utils/platform/responsive';
import { usePhoneTabNavRow } from '@/components/navigation/shell/phoneTabNavRow';

const SEARCH_FIELD_FADE_MS = 170;
type Focusable = Readonly<{ focus: () => void }>;


export type SessionListSearchChromeProps = Readonly<{
    filterControl?: React.ReactNode;
    /** The spaces strip under the title (lab `clspaces`); its presence makes the conditions the tokens below. */
    spacesStrip?: React.ReactNode;
    /** Conditions on top of the space, as removable tokens (lab `clfilter:filter`). */
    filterTokens?: React.ReactNode;
    /** Floating surfaces the space chrome hangs from this header (the save form). */
    overlays?: React.ReactNode;
    /** The header's bottom edge, where the filter and the save form hang. */
    anchorRef?: React.RefObject<View | null>;
    /** Find's filter button beside the search field (badge = active conditions). */
    filterButton?: Readonly<{ activeCount: number; open: boolean; onPress(): void }>;
    /** Phone paging between spaces on the title and strip (lab `clspaces:swipe`). */
    spaceSwipe?: Readonly<{ canPrevious: boolean; canNext: boolean; previousLabel: string | null; nextLabel: string | null; onCommit(direction: -1 | 1): void }>;
    filterSummary?: Readonly<{ label: string; onReset(): void }>;
    /** Facets that are on without showing in the title; each chip turns its own facet off. */
    filterChips?: ReadonlyArray<SelectionListFilter>;
    /** A fixed Run window has a quiet summary, not a second Sessions scope title. */
    presentation?: 'sessions' | 'runs';
    searchQuery: string;
    /** Exact Home whose transcript provider supplies contextual matches. */
    searchScopeLabel?: string;
    organizationServerId?: string | null;
    searchTrailingAccessory?: React.ReactNode;
    searchStatus?: Readonly<{
        message: string;
        onRetry?: () => void;
    }>;
    onSearchQueryChange: (query: string) => void;
    /**
     * Opens the universal Search surface with the contextual query preserved. The
     * session list never renders universal results itself.
     */
    onSearchEverything?: (query: string) => void;
}>;

/**
 * Stable, non-virtualized sibling of the one virtualized session-results list.
 *
 * The title row — the list's scope title, the search toggle and View options — and, while search is
 * open, the compact search field on its own row beneath it live here, never inside virtualized row
 * data, so typing, provider publication, filtering and zero-result rebuilds cannot remount the input.
 * The field is the shared `CompactSearchField`: a leading magnifying glass, the input, and one
 * trailing close button. Close and Escape clear the query,
 * collapse the field and return focus to the search toggle.
 */
export const SessionListSearchChrome = React.memo(function SessionListSearchChrome(
    props: SessionListSearchChromeProps,
) {
    const {
        filterControl,
        onSearchEverything,
        onSearchQueryChange,
        searchQuery,
        searchScopeLabel,
        searchStatus,
        searchTrailingAccessory,
    } = props;
    const styles = sessionListStyles;
    const { theme } = useUnistyles();
    const isTablet = useIsTablet();
    const reducedMotion = useReducedMotionPreference();
    const trimmedQuery = searchQuery.trim();
    const [searchOpened, setSearchOpened] = React.useState(false);
    const [searchFocused, setSearchFocused] = React.useState(false);
    const searchIsOpen = searchOpened || trimmedQuery.length > 0;
    const fieldOpacity = React.useRef(new Animated.Value(searchIsOpen ? 1 : 0)).current;
    const toggleRef = React.useRef<Focusable | null>(null);
    // The header's icon buttons keep the lab's compact squares under every pointer; a finger reaches
    // them through the shared hit area, never a larger drawn square.
    // The title keeps its floor and, beside the segment, the space's whole name: the segment yields to View options
    // when the row is too narrow for both. Measured on layout only, never per frame.
    const [layoutSegmentFits, setLayoutSegmentFits] = React.useState(true);
    const layoutSegmentWidthRef = React.useRef<number | null>(null);
    const titleSlotWidthRef = React.useRef<number | null>(null);
    const titleNaturalWidthRef = React.useRef(0);
    const decideLayoutSegment = React.useCallback(() => {
        const titleWidth = titleSlotWidthRef.current;
        setLayoutSegmentFits((shown) => resolveHappierCollectionTitleAccessoryFits({
            shown, titleWidth, accessoryWidth: layoutSegmentWidthRef.current,
            titleFloor: Math.max(SESSION_LIST_COLUMN_METRICS.titleFloorPx, titleNaturalWidthRef.current),
            gap: SESSION_LIST_COLUMN_METRICS.iconButtonGapPx,
        }));
    }, []);
    const handleTitleSlotLayout = React.useCallback((event: { nativeEvent: { layout: { width: number } } }) => {
        titleSlotWidthRef.current = event.nativeEvent.layout.width;
        decideLayoutSegment();
    }, [decideLayoutSegment]);
    const handleTitleNaturalWidth = React.useCallback((widthPx: number) => {
        titleNaturalWidthRef.current = widthPx;
        decideLayoutSegment();
    }, [decideLayoutSegment]);
    const handleLayoutSegmentLayout = React.useCallback((event: { nativeEvent: { layout: { width: number } } }) => {
        layoutSegmentWidthRef.current = event.nativeEvent.layout.width;
    }, []);
    const iconColor = theme.colors.text.secondary;

    React.useEffect(() => {
        Animated.timing(fieldOpacity, {
            toValue: searchIsOpen ? 1 : 0,
            duration: reducedMotion ? 0 : SEARCH_FIELD_FADE_MS,
            easing: Easing.out(Easing.cubic),
            useNativeDriver: Platform.OS !== 'web',
        }).start();
    }, [fieldOpacity, reducedMotion, searchIsOpen]);

    const handleToggleRef = React.useCallback((instance: Focusable | null) => {
        toggleRef.current = instance;
    }, []);

    const closeSearch = React.useCallback(() => {
        onSearchQueryChange('');
        setSearchOpened(false);
        setSearchFocused(false);
        // The field that held focus is gone: hand focus back to the control that opened it.
        toggleRef.current?.focus?.();
    }, [onSearchQueryChange]);

    const handleToggleSearch = React.useCallback((event?: unknown) => {
        stopPressEventPropagation(event);
        if (searchIsOpen) {
            closeSearch();
            return;
        }
        setSearchOpened(true);
        setSearchFocused(true);
    }, [closeSearch, searchIsOpen]);

    const handleSearchFocus = React.useCallback(() => {
        // Once explicitly focused, the field owns a stable open lifetime until
        // the user explicitly closes it. Native clear gestures can emit blur as
        // part of platform focus transfer; that must not remount the field.
        setSearchOpened(true);
        setSearchFocused(true);
    }, []);

    const handleSearchBlur = React.useCallback(() => {
        setSearchFocused(false);
    }, []);

    const handleSearchKeyPress = React.useCallback((event: { nativeEvent?: { key?: string } }) => {
        if (event.nativeEvent?.key !== 'Escape') return;
        closeSearch();
    }, [closeSearch]);

    const handleCloseSearch = React.useCallback((event?: unknown) => {
        stopPressEventPropagation(event);
        closeSearch();
    }, [closeSearch]);

    const handleSearchEverything = React.useCallback((event?: unknown) => {
        stopPressEventPropagation(event);
        onSearchEverything?.(trimmedQuery);
    }, [onSearchEverything, trimmedQuery]);

    const handleRetrySearch = React.useCallback((event?: unknown) => {
        stopPressEventPropagation(event);
        searchStatus?.onRetry?.();
    }, [searchStatus]);

    const resetControl = props.filterSummary ? <HappierPressable
        testID="session-list-filter-summary-reset"
        accessibilityRole="button"
        accessibilityLabel={t('common.reset')}
        onPress={props.filterSummary.onReset}
        style={(state) => [
            styles.searchChromeStatusRetry,
            focusRingStyle({ focused: state.focused, color: theme.colors.border.focus }),
        ]}
    ><Text style={styles.searchChromeStatusActionText}>{t('common.reset')}</Text></HappierPressable> : null;

    const spaceChrome = props.presentation !== 'runs' && props.spacesStrip !== undefined;
    const spaceSwipeCommit = props.spaceSwipe?.onCommit;
    const handleSpaceSwipe = React.useCallback((direction: -1 | 1) => spaceSwipeCommit?.(direction), [spaceSwipeCommit]);
    const spaceSwipeTrack = useCollectionSpaceSwipeTrack();
    // On a phone tab whose column is the page, the shell's line joins this header (lab `clviews:recentP`):
    // one nav row — the Home line, the column's controls, the shell's glyphs — then the large title alone.
    const shellNavRow = usePhoneTabNavRow();
    const navRow = props.presentation === 'runs' ? null : shellNavRow;
    const columnControls = (
        <>
            {props.presentation === 'runs' || !layoutSegmentFits ? null : <View testID="session-list-layout-slot" onLayout={handleLayoutSegmentLayout}>
                <SessionListLayoutSegment />
            </View>}
            <IconButton
                testID="session-list-search-trigger"
                accessibilityLabel={t('sessionsList.searchSessions')}
                tooltip={t('sessionsList.searchSessions')}
                variant="plain"
                size={SESSION_LIST_COLUMN_METRICS.iconButtonSizePx}
                iconSize={ICON_SIZE.sm}
                interactiveTargetGapPx={SESSION_LIST_COLUMN_METRICS.iconButtonGapPx}
                selected={searchIsOpen}
                controlRef={handleToggleRef}
                iconName="magnifying-glass"
                onPress={handleToggleSearch}
            />
            {props.presentation === 'runs' ? resetControl : <SessionListViewOptionsButton
                onOpenFilter={props.filterButton ? props.filterButton.onPress : undefined}
                placement="bottom"
                serverId={props.organizationServerId}
            />}
        </>
    );
    return (
        <View ref={props.anchorRef} collapsable={false} style={styles.searchChrome} testID="session-list-search-chrome">
            {navRow ? (
                <View testID="session-list-phone-nav-row" style={styles.searchChromeControlsRow}>
                    {/* The Home line yields its width before the controls do; the segment yields first. */}
                    <View style={styles.searchChromeTitleSlot} onLayout={handleTitleSlotLayout}>{navRow.leading}</View>
                    {columnControls}
                    {navRow.trailing}
                </View>
            ) : null}
            <CollectionSpaceSwipeZone
                testID="session-list-space-swipe-zone"
                track={spaceSwipeTrack}
                enabled={spaceChrome && props.spaceSwipe !== undefined && !isTablet}
                canPrevious={props.spaceSwipe?.canPrevious ?? false}
                canNext={props.spaceSwipe?.canNext ?? false}
                onCommit={handleSpaceSwipe}
            >
            <View
                testID="session-list-search-primary-controls"
                style={[styles.searchChromeControlsRow, props.presentation === 'runs' ? styles.searchChromeSummaryRow : null]}
            >
                <View testID="session-list-title-slot" style={styles.searchChromeTitleSlot} onLayout={navRow ? undefined : handleTitleSlotLayout}>
                    {/* Beside its controls the title says how wide its whole name is; alone on its row (a phone tab) it has the row. */}
                    <CollectionTitleNaturalWidthContext.Provider value={navRow ? null : handleTitleNaturalWidth}>
                    {spaceChrome ? (
                        <CollectionSpaceSwipeTitle track={spaceSwipeTrack}
                            previousLabel={props.spaceSwipe?.previousLabel ?? null} nextLabel={props.spaceSwipe?.nextLabel ?? null}>
                            {filterControl}
                        </CollectionSpaceSwipeTitle>
                    ) : filterControl}
                    </CollectionTitleNaturalWidthContext.Provider>
                </View>
                {navRow ? null : columnControls}
            </View>
            {spaceChrome ? props.spacesStrip : null}
            </CollectionSpaceSwipeZone>
            {props.filterSummary && props.presentation !== 'runs' && !spaceChrome ? (
                <View testID="session-list-filter-summary" style={styles.searchChromeStatusRow}>
                    <Text style={styles.searchChromeStatusText}>{props.filterSummary.label}</Text>
                    {resetControl}
                </View>
            ) : null}
            {props.filterChips && props.filterChips.length > 0 && props.presentation !== 'runs' && !spaceChrome ? (
                <View testID="session-list-filter-chips" style={styles.searchChromeChipRow}>
                    {props.filterChips.map((filter) => <SelectionListFilterChip key={filter.id} filter={filter} />)}
                </View>
            ) : null}
            {searchIsOpen ? (
                <Animated.View style={[{ opacity: fieldOpacity }, props.filterButton ? styles.searchChromeFindRow : null]}>
                    <CompactSearchField
                        testID="session-list-search-input"
                        accessibilityLabel={t('sessionsList.searchSessions')}
                        placeholder={t('sessionsList.searchSessionsPlaceholder')}
                        value={searchQuery}
                        onChangeText={onSearchQueryChange}
                        onFocus={handleSearchFocus}
                        onBlur={handleSearchBlur}
                        onKeyPress={handleSearchKeyPress}
                        // Only the explicit open path focuses; a retained query restoring
                        // this surface must not steal focus on mount.
                        autoFocus={searchFocused}
                        style={styles.searchChromeField}
                        trailing={(
                            <>
                                {searchTrailingAccessory !== undefined ? (
                                    <View
                                        testID="session-list-search-trailing-accessory"
                                        pointerEvents="none"
                                        accessibilityElementsHidden={true}
                                        importantForAccessibility="no-hide-descendants"
                                        style={styles.headerSearchTrailingAccessory}
                                    >
                                        {searchTrailingAccessory}
                                    </View>
                                ) : null}
                                <IconButton
                                    testID="session-list-search-close"
                                    accessibilityLabel={t('sessionsList.closeSearch')}
                                    variant="plain"
                                    size={SESSION_LIST_COLUMN_METRICS.fieldCloseButtonSizePx}
                                    iconSize={ICON_SIZE.xs}
                                    iconName="x"
                                    onPress={handleCloseSearch}
                                />
                            </>
                        )}
                    />
                    {props.filterButton ? (
                        <CollectionFilterButton
                            testID="session-list-filter-open"
                            activeCount={props.filterButton.activeCount}
                            open={props.filterButton.open}
                            onPress={props.filterButton.onPress}
                        />
                    ) : null}
                </Animated.View>
            ) : null}
            {spaceChrome ? props.filterTokens : null}
            {searchScopeLabel && trimmedQuery.length > 0 ? (
                <View
                    testID="session-list-search-scope"
                    accessibilityLiveRegion="polite"
                    style={styles.searchChromeScopeRow}
                >
                    <Icon name="hard-drives" size={13} color={iconColor} />
                    <Text style={styles.searchChromeScopeText}>{searchScopeLabel}</Text>
                </View>
            ) : null}
            {searchStatus && trimmedQuery.length > 0 ? (
                <View
                    testID="session-list-search-status"
                    accessibilityLiveRegion="polite"
                    role={Platform.OS === 'web' ? 'status' : undefined}
                    style={styles.searchChromeStatusRow}
                >
                    <Text style={styles.searchChromeStatusText}>{searchStatus.message}</Text>
                    {searchStatus.onRetry ? (
                        <HappierPressable
                            testID="session-list-search-retry"
                            accessibilityRole="button"
                            accessibilityLabel={t('common.retry')}
                            onPress={handleRetrySearch}
                            style={styles.searchChromeStatusRetry}
                        >
                            <Text style={styles.searchChromeStatusRetryText}>{t('common.retry')}</Text>
                        </HappierPressable>
                    ) : null}
                </View>
            ) : null}
            {onSearchEverything && trimmedQuery.length > 0 ? (
                <HappierPressable
                    testID="session-list-search-everything"
                    accessibilityRole="button"
                    accessibilityLabel={t('sessionsList.searchEverythingFor', { query: trimmedQuery })}
                    onPress={handleSearchEverything}
                    hitReach={{ top: 4, bottom: 4 }}
                    style={styles.searchChromeEscalationRow}
                >
                    <Icon name="magnifying-glass" size={14} color={iconColor} />
                    <Text style={styles.searchChromeEscalationText}>
                        {t('sessionsList.searchEverythingFor', { query: trimmedQuery })}
                    </Text>
                </HappierPressable>
            ) : null}
            {props.overlays}
        </View>
    );
});
