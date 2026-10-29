import * as React from 'react';
import { Platform, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';

import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { renderDropdownItemTriggerRightElement } from '@/components/ui/forms/dropdown/renderDropdownItemTriggerRightElement';
import { resolveFieldBoxColors } from '@/components/ui/forms/fieldBox';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';

export type ToolbarSelectItem = Readonly<{
    id: string;
    title: string;
    /** A leading mark (an agent's brand mark), shown in the menu row and in the trigger when selected. */
    icon?: React.ReactNode;
    /** Quiet right-aligned facts in the menu row only ("Git · 16"). */
    detail?: string;
    /** A choice that cannot be taken now keeps its place; its `detail` says why ("Offline"). */
    disabled?: boolean;
}>;

/** An operation listed under the choices, after a hairline ("Add a registry…", "Manage registries"). */
export type ToolbarSelectAction = Readonly<{
    id: string;
    title: string;
    icon?: React.ReactNode;
    onPress: () => void;
}>;

/**
 * A toolbar filter or scope choice: the selected choice in a compact bordered field, the choices in a
 * menu. Used where a page or modal narrows one collection (Plugins' status and source, the external
 * sessions browser's agent and source), and a value's type in a row of fields (`ValueRefRowsEditor`);
 * a configuration row uses a field select instead.
 */
export const ToolbarSelect = React.memo(function ToolbarSelect(props: Readonly<{
    /** Names the menu; its trigger is `<testID>.trigger` and each choice `<testID>:<id>`. */
    testID: string;
    /** What is being chosen ("Status", "Agent"): the trigger's accessible name is `<label>: <choice>`. */
    label: string;
    items: ReadonlyArray<ToolbarSelectItem>;
    selectedId: string | null;
    onSelect: (id: string) => void;
    disabled?: boolean;
    /** Fit a narrow toolbar to its choice; keep the platform press target and typography. */
    compact?: boolean;
    /** Fill the column a row of fields gives it (a value's type beside its name and value). */
    fill?: boolean;
    /** Operations under the choices; picking one runs it and never changes the choice. */
    actions?: ReadonlyArray<ToolbarSelectAction>;
    /** The trigger's words while nothing is chosen ("Choose a Machine"); without it the first choice stands in. */
    placeholder?: string;
}>) {
    const { theme } = useUnistyles();
    const [open, setOpen] = React.useState(false);
    const items = React.useMemo(() => [
        ...props.items.map((item) => ({
            id: item.id,
            title: item.title,
            ...(item.icon ? { icon: item.icon } : {}),
            ...(item.detail
                ? { rightElement: <ToolbarSelectDetail text={item.detail} checked={item.id === props.selectedId} /> }
                : { checked: item.id === props.selectedId }),
            ...(item.disabled ? { disabled: true } : {}),
            ...(props.actions?.length ? { category: 'choices' } : {}),
            testID: `${props.testID}:${item.id}`,
        })),
        ...(props.actions ?? []).map((action) => ({
            id: `action:${action.id}`,
            title: action.title,
            ...(action.icon ? { icon: action.icon } : {}),
            category: 'actions',
            testID: `${props.testID}:action:${action.id}`,
        })),
    ], [props.actions, props.items, props.selectedId, props.testID]);
    const selected = props.items.find((item) => item.id === props.selectedId)
        ?? (props.placeholder === undefined ? props.items[0] ?? null : null);
    const selectedTitle = selected?.title ?? props.placeholder ?? '';
    return (
        <DropdownMenu
            testID={props.testID}
            open={open && props.disabled !== true}
            onOpenChange={setOpen}
            items={items}
            selectedId={props.selectedId}
            onSelect={(id) => {
                setOpen(false);
                const action = props.actions?.find((candidate) => `action:${candidate.id}` === id);
                if (action) action.onPress();
                else props.onSelect(id);
            }}
            separateCategories={props.actions !== undefined && props.actions.length > 0}
            placement="bottom"
            popoverAnchorAlign="end"
            variant="slim"
            matchTriggerWidth={false}
            // A menu whose rows carry facts needs room for both the name and its facts on one line.
            maxWidthCap={props.items.some((item) => item.detail) ? 440 : 320}
            showCategoryTitles={false}
            popoverPortalWebTarget="body"
            trigger={({ toggle }) => (
                <HappierPressable
                    testID={`${props.testID}.trigger`}
                    onPress={toggle}
                    disabled={props.disabled}
                    accessibilityRole="button"
                    accessibilityLabel={`${props.label}: ${selectedTitle}`}
                    expanded={open}
                    hasPopup="menu"
                    style={{ justifyContent: 'center', ...(props.fill ? { width: '100%' } : null) }}
                >
                    {renderDropdownItemTriggerRightElement({
                        detail: selectedTitle,
                        open,
                        detailColor: theme.colors.text.secondary,
                        chevronColor: theme.colors.text.secondary,
                        field: resolveFieldBoxColors(theme),
                        leading: selected?.icon,
                        fieldSpan: props.fill ? 'row' : props.compact ? 'intrinsic' : 'content',
                    })}
                </HappierPressable>
            )}
        />
    );
});

/** A row's right side: its quiet facts, then the check when it is the current choice (the row's own right slot replaces the menu's check). */
function ToolbarSelectDetail(props: Readonly<{ text: string; checked: boolean }>) {
    const { theme } = useUnistyles();
    return (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.space.s8 }}>
            <Text variant="meta" style={{ color: theme.colors.text.secondary, fontVariant: ['tabular-nums'] }} numberOfLines={1}>
                {props.text}
            </Text>
            <View style={{ width: ICON_SIZE.sm, alignItems: 'center' }}>
                {props.checked ? <Icon name="check" size={ICON_SIZE.sm} color={theme.colors.text.primary} /> : null}
            </View>
        </View>
    );
}
