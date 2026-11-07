import React from 'react';
import { Pressable, View, type TextStyle } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { TextInput } from '@/components/ui/text/Text';
import { t } from '@/text';
import { Icon } from '@/components/ui/icons/Icon';

const TAG_FILTER_ITEM_PREFIX = 'session-list-tag-filter:';
const SEARCH_INPUT_CHROME_RESET_STYLE = {
    outline: 'none',
    outlineStyle: 'none',
    outlineWidth: 0,
    outlineColor: 'transparent',
    outlineOffset: 0,
    boxShadow: 'none',
    borderWidth: 0,
    borderColor: 'transparent',
    backgroundColor: 'transparent',
    appearance: 'none',
    WebkitAppearance: 'none',
} as unknown as TextStyle;

const stylesheet = StyleSheet.create((theme) => ({
    // Horizontal padding matches the Happier/Direct tabs bar directly above.
    bar: {
        flexDirection: 'row' as const,
        alignItems: 'center' as const,
        gap: 10,
        paddingHorizontal: 15,
        paddingBottom: 6,
        backgroundColor: theme.colors.background.canvas,
    },
    searchField: {
        flex: 1,
        minWidth: 0,
        height: 34,
        flexDirection: 'row' as const,
        alignItems: 'center' as const,
        gap: 6,
        paddingLeft: 10,
        paddingRight: 8,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.input.background,
    },
    searchInput: {
        flex: 1,
        minWidth: 0,
        height: 20,
        lineHeight: 20,
        padding: 0,
        margin: 0,
        color: theme.colors.text.primary,
    },
    searchTrailingAccessory: {
        width: 18,
        height: 20,
        alignItems: 'center' as const,
        justifyContent: 'center' as const,
        flexShrink: 0,
    },
    searchClearButton: {
        width: 18,
        height: 20,
        alignItems: 'center' as const,
        justifyContent: 'center' as const,
    },
    iconButton: {
        width: 20,
        height: 24,
        alignItems: 'center' as const,
        justifyContent: 'center' as const,
    },
}));

function stopPressEventPropagation(event: unknown): void {
    if (!event || typeof event !== 'object' || !('stopPropagation' in event)) return;
    const stopPropagation = (event as { stopPropagation?: () => void }).stopPropagation;
    if (typeof stopPropagation === 'function') {
        (event as { stopPropagation: () => void }).stopPropagation();
    }
}

function resolveTagFromItemId(itemId: string): string | null {
    if (!itemId.startsWith(TAG_FILTER_ITEM_PREFIX)) return null;
    const tag = itemId.slice(TAG_FILTER_ITEM_PREFIX.length);
    return tag.length > 0 ? tag : null;
}

/** The sessions list's single top bar: search field, tag filter and view menu. */
export const SessionListHeaderControls = React.memo(function SessionListHeaderControls(props: Readonly<{
    allKnownTags: ReadonlyArray<string>;
    selectedTags: ReadonlyArray<string>;
    searchQuery: string;
    onSelectedTagsChange: (tags: string[]) => void;
    onSearchQueryChange: (query: string) => void;
    searchTrailingAccessory?: React.ReactNode;
    viewMenu: React.ReactNode;
}>) {
    const {
        allKnownTags,
        onSearchQueryChange,
        onSelectedTagsChange,
        searchQuery,
        selectedTags,
        searchTrailingAccessory,
        viewMenu,
    } = props;
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const inputRef = React.useRef<React.ElementRef<typeof TextInput> | null>(null);
    // Keep a local input echo so native TextInput receives the typed value synchronously even if the parent prop lags.
    const [searchInputValue, setSearchInputValue] = React.useState(searchQuery);
    const [tagMenuOpen, setTagMenuOpen] = React.useState(false);
    const iconColor = theme.colors.text.secondary;
    const activeIconColor = theme.colors.accent.blue;
    const searchHasQuery = searchInputValue.trim().length > 0;
    const searchTrailingAccessoryHasContent = React.Children.count(searchTrailingAccessory) > 0;
    const showSearchClearButton = searchHasQuery && !searchTrailingAccessoryHasContent;
    const shouldRenderSearchTrailingSlot = searchTrailingAccessoryHasContent || searchHasQuery;
    const selectedTagSet = React.useMemo(() => new Set(selectedTags), [selectedTags]);

    React.useEffect(() => {
        setSearchInputValue(searchQuery);
    }, [searchQuery]);

    const handleSearchQueryChange = React.useCallback((query: string) => {
        setSearchInputValue(query);
        onSearchQueryChange(query);
    }, [onSearchQueryChange]);

    const clearSearch = React.useCallback(() => {
        setSearchInputValue('');
        onSearchQueryChange('');
    }, [onSearchQueryChange]);

    const handleSearchKeyPress = React.useCallback((event: { nativeEvent?: { key?: string } }) => {
        if (event.nativeEvent?.key !== 'Escape') return;
        clearSearch();
        inputRef.current?.blur?.();
    }, [clearSearch]);

    const handleClearSearch = React.useCallback((event?: unknown) => {
        stopPressEventPropagation(event);
        clearSearch();
    }, [clearSearch]);

    const tagItems = React.useMemo((): DropdownMenuItem[] => allKnownTags.map((tag) => {
        const selected = selectedTagSet.has(tag);
        return {
            id: `${TAG_FILTER_ITEM_PREFIX}${tag}`,
            title: tag,
            icon: <Icon name="tag" size={14} color={selected ? activeIconColor : iconColor} />,
            rightElement: selected
                ? <Icon name="check" size={14} color={activeIconColor} />
                : null,
        };
    }), [activeIconColor, allKnownTags, iconColor, selectedTagSet]);

    const handleTagSelect = React.useCallback((itemId: string) => {
        const tag = resolveTagFromItemId(itemId);
        if (!tag) return;
        const nextTags = selectedTagSet.has(tag)
            ? selectedTags.filter((item) => item !== tag)
            : [...selectedTags, tag];
        onSelectedTagsChange(nextTags);
    }, [onSelectedTagsChange, selectedTagSet, selectedTags]);

    return (
        <View style={styles.bar} testID="session-list-header-controls">
            <View style={styles.searchField}>
                <Icon
                    name="magnifying-glass"
                    size={16}
                    color={searchHasQuery ? activeIconColor : iconColor}
                />
                <TextInput
                    ref={inputRef}
                    testID="session-list-search-input"
                    accessibilityLabel={t('sessionsList.searchSessions')}
                    placeholder={t('sessionsList.searchSessionsPlaceholder')}
                    placeholderTextColor={theme.colors.input.placeholder}
                    value={searchInputValue}
                    onChangeText={handleSearchQueryChange}
                    onKeyPress={handleSearchKeyPress}
                    returnKeyType="search"
                    autoCapitalize="none"
                    autoCorrect={false}
                    style={[styles.searchInput, SEARCH_INPUT_CHROME_RESET_STYLE]}
                />
                {shouldRenderSearchTrailingSlot ? (
                    <View
                        testID="session-list-search-trailing-accessory"
                        pointerEvents={showSearchClearButton ? 'auto' : 'none'}
                        accessibilityElementsHidden={showSearchClearButton ? undefined : true}
                        importantForAccessibility={showSearchClearButton ? undefined : 'no-hide-descendants'}
                        style={styles.searchTrailingAccessory}
                    >
                        {showSearchClearButton ? (
                            <Pressable
                                testID="session-list-search-clear"
                                accessibilityRole="button"
                                accessibilityLabel={t('common.clearSearch')}
                                onPress={handleClearSearch}
                                hitSlop={10}
                                style={styles.searchClearButton}
                            >
                                <Icon
                                    name="x-circle"
                                    size={14}
                                    color={theme.colors.text.tertiary}
                                />
                            </Pressable>
                        ) : searchTrailingAccessory}
                    </View>
                ) : null}
            </View>
            {allKnownTags.length > 0 ? (
                <DropdownMenu
                    open={tagMenuOpen}
                    onOpenChange={setTagMenuOpen}
                    items={tagItems}
                    onSelect={handleTagSelect}
                    selectedId={selectedTags[0] ?? null}
                    placement="left"
                    variant="slim"
                    search={allKnownTags.length > 8}
                    searchPlaceholder={t('sessionTags.searchOrAddPlaceholder')}
                    closeOnSelect={false}
                    matchTriggerWidth={false}
                    maxWidthCap={220}
                    showCategoryTitles={false}
                    popoverPortalWebTarget="body"
                    trigger={({ toggle }) => (
                        <Pressable
                            testID="session-list-tag-filter-trigger"
                            accessibilityRole="button"
                            accessibilityLabel={t('sessionsList.filterByTags')}
                            onPress={(event) => {
                                stopPressEventPropagation(event);
                                toggle();
                            }}
                            hitSlop={8}
                            style={styles.iconButton}
                        >
                            <Icon
                                name="tag"
                                size={16}
                                color={selectedTags.length > 0 ? activeIconColor : iconColor}
                            />
                        </Pressable>
                    )}
                />
            ) : null}
            {viewMenu}
        </View>
    );
});
