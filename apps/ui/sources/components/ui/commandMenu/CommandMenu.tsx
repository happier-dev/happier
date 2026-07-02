import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import {
    SelectionList,
    resolvePopoverSelectionListHeightBehavior,
    type SelectionListOption,
    type SelectionListSectionDescriptor,
    type SelectionListStep,
} from '@/components/ui/selectionList';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';

import { CommandMenuSurface } from './CommandMenuSurface';
import { CommandMenuRow } from './CommandMenuRow';
import type { CommandMenuItem, CommandMenuProps } from './commandMenuTypes';

const DEFAULT_MAX_HEIGHT = 280;

/**
 * Reusable command-menu primitive.
 *
 * Renders a Popover-anchored overlay containing a SelectionList (D28).
 * The host owns all state (items, query, selectedIndex, filtering).
 * This component is purely presentational + keyboard-nav.
 *
 * D22: No read-only "search header" (query echo).
 * D23: Section dividers between groups when items have groups.
 * D28: SelectionList for row rendering.
 * D29: Popover's built-in motion for enter/exit.
 */
export const CommandMenu = React.memo((props: CommandMenuProps) => {
    const {
        open,
        anchor,
        query,
        items,
        selectedIndex,
        onSelect,
        onRequestClose,
        maxHeight = DEFAULT_MAX_HEIGHT,
        maxWidth,
        placement,
        gap,
        boundaryRef,
        keyboardBottomInset,
        edgePadding,
        backdrop,
        consumeOutsidePointerDown,
        containerStyle,
        emptyStateLabel,
        testID = 'command-menu',
    } = props;

    // Build SelectionList sections from items, grouped by group field (D23).
    const sections = React.useMemo<ReadonlyArray<SelectionListSectionDescriptor>>(() => {
        if (items.length === 0) return [];

        const groups: Array<{ group: string | undefined; options: SelectionListOption[] }> = [];
        let currentGroup: { group: string | undefined; options: SelectionListOption[] } | null = null;

        for (const item of items) {
            if (!currentGroup || currentGroup.group !== item.group) {
                currentGroup = { group: item.group, options: [] };
                groups.push(currentGroup);
            }
            currentGroup.options.push({
                id: item.id,
                label: item.label,
                subtitle: item.description,
                content: item.renderRow ? item.renderRow() : (
                    <CommandMenuRow
                        label={item.label}
                        description={item.description}
                        icon={item.icon}
                        testID={testID ? `${testID}:row:${item.id}` : undefined}
                    />
                ),
            });
        }

        return groups.map((g, index) => ({
            kind: 'static' as const,
            id: g.group ?? `section-${index}`,
            title: g.group,
            options: g.options,
            virtualization: 'never' as const,
        }));
    }, [items, testID]);

    const rootStep = React.useMemo<SelectionListStep>(() => ({
        id: 'command-menu-root',
        sections,
        emptyStateLabel: emptyStateLabel ?? t('commandMenu.empty'),
    }), [sections, emptyStateLabel]);

    const selectedOptionId = React.useMemo(() => {
        if (selectedIndex < 0 || selectedIndex >= items.length) return null;
        return items[selectedIndex]?.id ?? null;
    }, [selectedIndex, items]);

    const handleSelect = React.useCallback(
        (id: string) => {
            const index = items.findIndex((item) => item.id === id);
            if (index < 0) return;
            onSelect(items[index]!, index);
        },
        [items, onSelect],
    );

    if (!open) return null;

    return (
        <CommandMenuSurface
            open={open}
            anchor={anchor}
            maxHeight={maxHeight}
            maxWidth={maxWidth}
            placement={placement}
            gap={gap}
            boundaryRef={boundaryRef}
            keyboardBottomInset={keyboardBottomInset}
            edgePadding={edgePadding}
            backdrop={backdrop}
            consumeOutsidePointerDown={consumeOutsidePointerDown}
            containerStyle={containerStyle}
            onRequestClose={onRequestClose}
            testID={testID ? `${testID}:surface` : undefined}
        >
            {items.length === 0 && emptyStateLabel ? (
                <View
                    style={emptyStyles.container}
                    testID={testID ? `${testID}:empty` : undefined}
                    accessibilityRole="text"
                >
                    <Text style={emptyStyles.label}>{emptyStateLabel}</Text>
                </View>
            ) : (
                <SelectionList
                    rootStep={rootStep}
                    selectedOptionId={selectedOptionId}
                    activeScrollOptionId={selectedOptionId}
                    onSelect={handleSelect}
                    onRequestClose={onRequestClose}
                    keyboardHintsEnabled={false}
                    disableTransitions
                    testID={testID ? `${testID}:list` : undefined}
                    maxHeight={maxHeight}
                    heightBehavior={resolvePopoverSelectionListHeightBehavior()}
                />
            )}
        </CommandMenuSurface>
    );
});

const emptyStyles = StyleSheet.create((theme) => ({
    container: {
        paddingHorizontal: 24,
        paddingVertical: 28,
        alignItems: 'center',
        justifyContent: 'center',
    },
    label: {
        fontSize: 13,
        color: theme.colors.text.secondary,
        textAlign: 'center',
    },
}));
