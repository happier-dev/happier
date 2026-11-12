import * as React from 'react';
import { View, type LayoutChangeEvent } from 'react-native';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';
import { HAPPIER_POINTER_MINIMUM_INTERACTIVE_TARGET_SIZE } from '@happier-dev/plugin-ui/environment';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { renderDropdownItemTriggerRightElement } from '@/components/ui/forms/dropdown/renderDropdownItemTriggerRightElement';
import { FIELD_BOX_METRICS, resolveFieldBoxColors } from '@/components/ui/forms/fieldBox';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { focusRingStyle } from '@/components/ui/interactions/interactionFeedback';
import { SelectionListFilterChip } from '@/components/ui/selectionList/SelectionListFilterChips';
import type { SelectionListFilter } from '@/components/ui/selectionList/_types';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { WorkflowLifecycleStatus } from '@/components/workflows/presentation/WorkflowLifecycleStatus';
import type { WorkflowInvocationLifecycleContext } from '@/components/workflows/presentation/workflowLifecyclePresentation';
import { t } from '@/text';

import type { WorkflowFlowLoopItemFilter, WorkflowFlowLoopView } from './workflowFlowLoopItems';

const NO_ITEMS: readonly never[] = [];

type LoopItemStatusFilter = Exclude<WorkflowFlowLoopItemFilter, 'all'>;
const STATUS_FILTERS: readonly LoopItemStatusFilter[] = ['needsYou', 'running', 'failed'];

const STATUS_FILTER_LABEL: Readonly<Record<LoopItemStatusFilter, () => string>> = {
    needsYou: () => t('workflows.map.itemFilter.needsYou'),
    running: () => t('workflows.map.itemFilter.running'),
    failed: () => t('workflows.map.itemFilter.failed'),
};

/**
 * The loop body's item selector (07 S14, lab `flow-F1`): step through or pick the item the Map draws,
 * narrowed by what the items are doing. Which items exist is decided by `resolveWorkflowFlowLoopScope`;
 * the menu's rows are built only while it is open, so a closed selector costs nothing per item.
 */
export const WorkflowFlowLoopItemSelector = React.memo(function WorkflowFlowLoopItemSelector(props: Readonly<{
    loopNodeId: string;
    view: WorkflowFlowLoopView;
    invocationStatusContext: WorkflowInvocationLifecycleContext | undefined;
    onSelectItem: (loopNodeId: string, index: number) => void;
    onFilterItems: (loopNodeId: string, filter: WorkflowFlowLoopItemFilter) => void;
    testIDPrefix: string;
}>): React.ReactElement {
    const { view, loopNodeId, onSelectItem, onFilterItems, invocationStatusContext } = props;
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const [open, setOpen] = React.useState(false);
    // Where the row cannot give the item field a field's own width between the arrows (a phone at a large
    // text size), the field takes the row and the arrows step beneath it, so the item's name is never cut.
    const [stacked, setStacked] = React.useState(false);
    const measureRow = React.useCallback((event: LayoutChangeEvent) => {
        const room = event.nativeEvent.layout.width - 2 * (HAPPIER_POINTER_MINIMUM_INTERACTIVE_TARGET_SIZE + theme.space.s4);
        setStacked(room < FIELD_BOX_METRICS.triggerMinWidthPx);
    }, [theme.space.s4]);
    const testID = `${props.testIDPrefix}-node-${loopNodeId}-item-selector`;
    const position = view.visibleItems.findIndex(item => item.index === view.selectedIndex);
    const selected = view.visibleItems[position];
    const step = (delta: number) => {
        const target = view.visibleItems[position + delta];
        if (target !== undefined) onSelectItem(loopNodeId, target.index);
    };
    const items = React.useMemo(() => !open ? NO_ITEMS : view.visibleItems.map(item => ({
        id: String(item.index),
        title: item.label,
        testID: `${testID}-option-${item.index}`,
        checked: item.index === view.selectedIndex,
        rightElement: <WorkflowLifecycleStatus lifecycle={item.lifecycle} blockKind={item.blockKind} context={invocationStatusContext} chrome="plain" markerOnly />,
    })), [invocationStatusContext, open, testID, view.selectedIndex, view.visibleItems]);

    const options = STATUS_FILTERS.filter(filter => view.counts[filter] > 0);
    const filter: SelectionListFilter | null = options.length === 0 ? null : {
        id: `${loopNodeId}:items`,
        label: t('workflows.map.itemFilter.label'),
        testID: `${testID}-filter`,
        selectedId: view.filter,
        options: [
            { id: 'all', label: t('workflows.map.itemFilter.all') },
            ...options.map(id => ({
                id, label: STATUS_FILTER_LABEL[id](),
                accessory: <Text style={styles.count}>{view.counts[id]}</Text>,
            })),
        ],
        onChange: (id: string) => onFilterItems(loopNodeId, id as WorkflowFlowLoopItemFilter),
    };

    const previous = <StepButton testID={`${testID}-previous`} icon="caret-left" label={t('workflows.map.itemSelector.previous')}
        disabled={position <= 0} onPress={() => step(-1)} />;
    const next = <StepButton testID={`${testID}-next`} icon="caret-right" label={t('workflows.map.itemSelector.next')}
        disabled={position === -1 || position >= view.visibleItems.length - 1} onPress={() => step(1)} />;
    const menu = (
        <View style={styles.menu}>
            <DropdownMenu
                open={open}
                onOpenChange={setOpen}
                items={items}
                selectedId={String(view.selectedIndex)}
                onSelect={(id) => { setOpen(false); onSelectItem(loopNodeId, Number(id)); }}
                search
                variant="slim"
                matchTriggerWidth={false}
                popoverPortalWebTarget="body"
                popoverAccessibilityLabel={t('workflows.map.itemSelector.label')}
                trigger={({ toggle }) => (
                    <HappierPressable
                        testID={`${testID}-open`}
                        accessibilityRole="button"
                        accessibilityLabel={`${t('workflows.map.itemSelector.label')}: ${selected?.label ?? ''}`}
                        expanded={open}
                        hasPopup="menu"
                        onPress={toggle}
                        style={({ focused }) => [styles.trigger, focusRingStyle({ focused, color: theme.colors.border.focus })]}
                    >
                        {renderDropdownItemTriggerRightElement({
                            detail: selected?.label ?? '',
                            open,
                            detailColor: theme.colors.text.primary,
                            chevronColor: theme.colors.text.secondary,
                            field: resolveFieldBoxColors(theme),
                            fieldSpan: 'row',
                        })}
                    </HappierPressable>
                )}
            />
        </View>
    );
    return (
        <View testID={testID} style={styles.container}>
            <View style={styles.row} onLayout={measureRow}>
                {stacked ? null : previous}
                {menu}
                {stacked ? null : next}
            </View>
            {stacked ? <View style={styles.row}>{previous}{next}</View> : null}
            {filter === null ? null : <SelectionListFilterChip filter={filter} />}
        </View>
    );
});

function StepButton(props: Readonly<{
    testID: string;
    icon: 'caret-left' | 'caret-right';
    label: string;
    disabled: boolean;
    onPress: () => void;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    return (
        <HappierPressable
            testID={props.testID}
            accessibilityRole="button"
            accessibilityLabel={props.label}
            disabled={props.disabled}
            onPress={props.onPress}
            style={({ pressed, focused }) => [stylesheet.step, pressed ? { backgroundColor: theme.colors.surface.pressedOverlay } : null,
                focusRingStyle({ focused, color: theme.colors.border.focus })]}
        >
            <Icon name={props.icon} size={ICON_SIZE.sm} color={props.disabled ? theme.colors.text.tertiary : theme.colors.text.secondary} />
        </HappierPressable>
    );
}

const stylesheet = StyleSheet.create((theme) => ({
    // Inset to the loop header's text edges, the same inset the map's item list takes.
    container: {
        gap: theme.space.s8,
        alignItems: 'flex-start',
        paddingHorizontal: theme.space.s16,
    },
    row: {
        alignSelf: 'stretch',
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s4,
    },
    menu: {
        flex: 1,
        minWidth: 0,
    },
    trigger: {
        justifyContent: 'center',
    },
    step: {
        minWidth: HAPPIER_POINTER_MINIMUM_INTERACTIVE_TARGET_SIZE,
        minHeight: HAPPIER_POINTER_MINIMUM_INTERACTIVE_TARGET_SIZE,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: theme.borderRadius.md,
    },
    count: {
        ...Typography.variant('meta'),
        ...Typography.tabular(),
        color: theme.colors.text.tertiary,
    },
}));
