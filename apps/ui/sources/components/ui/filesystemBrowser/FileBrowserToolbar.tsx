import * as React from 'react';
import { Pressable, View, type LayoutChangeEvent, type PressableProps, type ViewProps } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { TextInput } from '@/components/ui/text/Text';

export type FileBrowserToolbarActionLike = Readonly<{
    id: string;
    /**
     * Higher values mean "more important" (prefer keeping visible in tight layouts).
     */
    priority: number;
}>;

export function resolveVisibleFileBrowserToolbarActionIds(params: Readonly<{
    toolbarWidth: number | null;
    actions: readonly FileBrowserToolbarActionLike[];
}>): ReadonlySet<string> {
    const rawWidth = params.toolbarWidth;
    const toolbarWidth = typeof rawWidth === 'number' && Number.isFinite(rawWidth) ? rawWidth : 0;
    if (toolbarWidth <= 0) {
        return new Set(params.actions.map((action) => action.id));
    }

    // Conservative heuristic:
    // - always keep higher-priority actions visible
    // - progressively hide lower-priority actions as the toolbar narrows
    //
    // The concrete breakpoints are intentionally coarse; the caller handles "more actions"
    // so correctness does not depend on perfect pixel math.
    const actions = [...params.actions].sort((a, b) => b.priority - a.priority);
    const maxVisible = toolbarWidth >= 760
        ? actions.length
        : toolbarWidth >= 560
            ? Math.min(actions.length, 3)
            : toolbarWidth >= 440
                ? Math.min(actions.length, 2)
                : Math.min(actions.length, 1);

    return new Set(actions.slice(0, maxVisible).map((action) => action.id));
}

export type FileBrowserToolbarProps = ViewProps & Readonly<{
    searchTestID?: string;
    searchPlaceholder?: string;
    searchValue: string;
    onSearchValueChange: (value: string) => void;
    onWidthChange?: (width: number) => void;
}>;

export function FileBrowserToolbar({
    searchTestID,
    searchPlaceholder,
    searchValue,
    onSearchValueChange,
    onWidthChange,
    style,
    children,
    ...rest
}: FileBrowserToolbarProps) {
    const { theme } = useUnistyles();

    const handleLayout = React.useCallback((event: LayoutChangeEvent) => {
        onWidthChange?.(event.nativeEvent.layout.width);
    }, [onWidthChange]);

    return (
        <View
            {...rest}
            onLayout={handleLayout}
            style={[styles.row, { borderBottomColor: theme.colors.divider }, style]}
        >
            <View style={[styles.searchWrap, { borderColor: theme.colors.divider, backgroundColor: theme.colors.surface }]}>
                <TextInput
                    testID={searchTestID}
                    placeholder={searchPlaceholder}
                    value={searchValue}
                    onChangeText={onSearchValueChange}
                    autoCapitalize="none"
                    autoCorrect={false}
                    spellCheck={false}
                    clearButtonMode="never"
                    style={[styles.searchInput, { color: theme.colors.text }]}
                    placeholderTextColor={theme.colors.textSecondary}
                />
            </View>
            <View style={styles.actions}>
                {children}
            </View>
        </View>
    );
}

export type FileBrowserToolbarIconButtonProps = Omit<PressableProps, 'children'> & Readonly<{
    selected?: boolean;
    children: React.ReactNode;
}>;

export function FileBrowserToolbarIconButton({
    selected = false,
    disabled,
    style,
    children,
    ...rest
}: FileBrowserToolbarIconButtonProps) {
    const { theme } = useUnistyles();
    const userStyle = style;
    return (
        <Pressable
            {...rest}
            disabled={disabled}
            hitSlop={8}
            style={(state) => ([
                styles.iconButton,
                {
                    borderColor: selected ? theme.colors.textLink : theme.colors.divider,
                    backgroundColor: theme.colors.surface,
                    opacity: disabled ? 0.5 : (state.pressed ? 0.75 : 1),
                },
                typeof userStyle === 'function' ? userStyle(state) : userStyle,
            ])}
        >
            {children}
        </Pressable>
    );
}

const styles = StyleSheet.create(() => ({
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        paddingHorizontal: 12,
        paddingVertical: 10,
        borderBottomWidth: 1,
    },
    searchWrap: {
        flex: 1,
        minWidth: 160,
        borderWidth: 1,
        borderRadius: 10,
        paddingHorizontal: 10,
        paddingVertical: 6,
    },
    searchInput: {
        padding: 0,
        margin: 0,
        minHeight: 20,
    },
    actions: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        flexShrink: 0,
    },
    iconButton: {
        width: 34,
        height: 34,
        borderRadius: 10,
        borderWidth: 1,
        alignItems: 'center',
        justifyContent: 'center',
    },
}));
