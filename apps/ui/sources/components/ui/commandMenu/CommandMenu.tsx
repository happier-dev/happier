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
import { COMMAND_MENU_ROOT_STEP_ID } from './commandMenuAccessibility';

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

    const pointerHighlightRef = React.useRef(false);
    const selectedOptionIdRef = React.useRef<string | null>(null);

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
                ...(item.disabled ? { disabled: true as const } : {}),
                onHighlight: item.onHighlight ? () => { if (item.id !== selectedOptionIdRef.current) pointerHighlightRef.current = true; item.onHighlight?.(); } : undefined,
                content: item.renderRow ? item.renderRow() : (
                    <CommandMenuRow
                        label={item.label}
                        description={item.description}
                        icon={item.icon}
                        disabled={item.disabled}
                        testID={testID ? `${testID}:row:${item.id}` : undefined}
                    />
                ),
            });
        }

        return [...(props.leadingEmptyGroup ? [{
            kind: 'static' as const,
            id: props.leadingEmptyGroup.title,
            title: props.leadingEmptyGroup.title,
            options: [],
            resultHint: props.leadingEmptyGroup.hint,
            virtualization: 'never' as const,
        }] : []), ...groups.map((g, index) => ({
            kind: 'static' as const,
            id: g.group ?? `section-${index}`,
            title: g.group,
            options: g.options,
            virtualization: 'never' as const,
        }))];
    }, [items, testID, props.leadingEmptyGroup]);

    const rootStep = React.useMemo<SelectionListStep>(() => ({
        id: COMMAND_MENU_ROOT_STEP_ID,
        sections,
        emptyStateLabel: emptyStateLabel ?? t('commandMenu.empty'),
    }), [sections, emptyStateLabel]);

    const selectedOptionId = React.useMemo(() => {
        if (selectedIndex < 0 || selectedIndex >= items.length) return null;
        return items[selectedIndex]?.id ?? null;
    }, [selectedIndex, items]);

    // The list follows the keyboard selection. A row the pointer merely rests on is highlighted too, but
    // scrolling to it would shift the list under the pointer (and past the first section's header when
    // a menu opens beneath it), so a pointer-driven highlight leaves the scroll target where it was.
    selectedOptionIdRef.current = selectedOptionId;
    const [scrollTargetOptionId, setScrollTargetOptionId] = React.useState(selectedOptionId);
    React.useEffect(() => {
        if (pointerHighlightRef.current) {
            pointerHighlightRef.current = false;
            return;
        }
        setScrollTargetOptionId(selectedOptionId);
    }, [selectedOptionId]);

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
            flip={props.flip}
            gap={gap}
            boundaryRef={boundaryRef}
            clearanceRef={props.clearanceRef}
            keyboardBottomInset={keyboardBottomInset}
            edgePadding={edgePadding}
            backdrop={backdrop}
            consumeOutsidePointerDown={consumeOutsidePointerDown}
            containerStyle={containerStyle}
            onRequestClose={onRequestClose}
            preserveHostFocus={props.preserveHostFocus}
            matchAnchorWidth={props.matchAnchorWidth}
            fillHeight={props.fillHeight}
            phoneSheetTitle={props.phoneSheetTitle}
            header={props.header}
            footer={props.footer}
            testID={testID ? `${testID}:surface` : undefined}
        >
            <View style={props.fillHeight ? emptyStyles.bodyFill : emptyStyles.body}>
            <View style={emptyStyles.list}>
            {items.length === 0 && props.emptyState != null ? (
                // A held frame centres a pane-sized empty state in the room the rows would take; a line stays under the header.
                <View style={props.fillHeight ? (props.emptyStateAlign === 'start' ? emptyStyles.emptyFillStart : emptyStyles.emptyFill) : undefined}>{props.emptyState}</View>
            ) : items.length === 0 && emptyStateLabel ? (
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
                    activeScrollOptionId={scrollTargetOptionId}
                    onSelect={handleSelect}
                    onRequestClose={onRequestClose}
                    keyboardHintsEnabled={false}
                    disableTransitions
                    testID={testID ? `${testID}:list` : undefined}
                    maxHeight={maxHeight}
                    heightBehavior={props.fillHeight ? undefined : resolvePopoverSelectionListHeightBehavior()}
                    fillAvailableSpace={props.fillHeight}
                />
            )}
            </View>
            {props.preview}
            </View>
        </CommandMenuSurface>
    );
});

const emptyStyles = StyleSheet.create((theme) => ({
    body: { flexDirection: 'row', minHeight: 0, flexShrink: 1 },
    bodyFill: { flexDirection: 'row', minHeight: 0, flex: 1 },
    list: { flex: 1, minWidth: 0, minHeight: 0 },
    emptyFill: { flex: 1, justifyContent: 'center' },
    emptyFillStart: { flex: 1, justifyContent: 'flex-start' },
    container: {
        paddingHorizontal: theme.space.s24,
        paddingVertical: theme.space.s24,
        alignItems: 'center',
        justifyContent: 'center',
    },
    label: {
        fontSize: 13,
        color: theme.colors.text.secondary,
        textAlign: 'center',
    },
}));
