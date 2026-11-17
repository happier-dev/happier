import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';
import { HAPPIER_SEGMENTED_METRICS, HappierPressable } from '@happier-dev/plugin-ui/presentation';

import { DropdownMenu, type DropdownMenuSelection } from '@/components/ui/forms/dropdown/DropdownMenu';
import { renderDropdownItemTriggerRightElement } from '@/components/ui/forms/dropdown/renderDropdownItemTriggerRightElement';
import { resolveFieldBoxColors } from '@/components/ui/forms/fieldBox';

const TRIGGER_STYLE = { justifyContent: 'center' } as const;
const DISABLED_TRIGGER_STYLE = { justifyContent: 'center', opacity: HAPPIER_SEGMENTED_METRICS.disabledOpacity } as const;

export type ValueFieldSelectItem = Readonly<{
    id: string;
    title: string;
    /** A leading mark, shown in the menu row and in the field when selected. */
    icon?: React.ReactNode;
    /** The menu group this choice sits in; titled groups keep the order their first choice gives them. */
    category?: string;
    /** A line under the choice in the menu (a Session's folder and age). */
    subtitle?: string;
    disabled?: boolean;
}>;

/**
 * A form's value, in the bordered field, where the form lays out its own rows (a value's type beside its name, a pull
 * request's base branch). A configuration row uses `DropdownMenu`'s item trigger; a choice that scopes or narrows what
 * a page or toolbar shows is the filter chip (`SelectionListFilterChip`), never a field.
 */
export const ValueFieldSelect = React.memo(function ValueFieldSelect(props: Readonly<{
    /** Names the menu; its trigger is `<testID>.trigger` and each choice `<testID>:<id>`. */
    testID: string;
    /** What is being chosen ("Base", "Type"): the trigger's accessible name is `<label>: <choice>`. */
    label: string;
    items: ReadonlyArray<ValueFieldSelectItem>;
    selectedId: string | null;
    /** `selection` carries where the choice was made, for what opens from it (the Connect sheet). */
    onSelect: (id: string, selection?: DropdownMenuSelection) => void;
    disabled?: boolean;
    /** Fit a narrow row to its choice. */
    compact?: boolean;
    /**
     * Stacked under its label in a form: the field spans the row and its menu opens at the field's width and
     * edge, so long choices ("Caddy on vps-2 · public") read whole instead of truncating in a capped menu.
     */
    fill?: boolean;
    /** The field's words while nothing is chosen; without it the first choice stands in. */
    placeholder?: string;
    /** A search field atop the menu, for a list long enough to look through (a person's Projects). */
    searchPlaceholder?: string;
    /** The menu's line when it has no choices (a list still loading, or none to choose). */
    emptyLabel?: string;
    /** The menu opened or closed: a list read only while it is open starts here. */
    onOpenChange?: (open: boolean) => void;
    /** A choice that acts in place (a retry) and leaves the menu open on its result. */
    keepsOpen?: (id: string) => boolean;
    /** The stored value no longer resolves: the field wears the invalid border instead of looking chosen. */
    invalid?: boolean;
}>) {
    const { theme } = useUnistyles();
    const [open, setOpenState] = React.useState(false);
    const onOpenChange = props.onOpenChange;
    const setOpen = React.useCallback((next: boolean) => {
        setOpenState(next);
        onOpenChange?.(next);
    }, [onOpenChange]);
    const grouped = props.items.some((item) => item.category !== undefined);
    const items = React.useMemo(() => props.items.map((item) => ({
        id: item.id,
        title: item.title,
        ...(item.icon ? { icon: item.icon } : {}),
        ...(item.category === undefined ? {} : { category: item.category }),
        ...(item.subtitle === undefined ? {} : { subtitle: item.subtitle }),
        ...(item.disabled ? { disabled: true } : {}),
        checked: item.id === props.selectedId,
        testID: `${props.testID}:${item.id}`,
    })), [props.items, props.selectedId, props.testID]);
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
            onSelect={(id, selection) => {
                if (props.keepsOpen?.(id) !== true) setOpen(false);
                props.onSelect(id, selection);
            }}
            {...(props.keepsOpen === undefined ? {} : { closeOnSelect: false })}
            {...(props.emptyLabel === undefined ? {} : { emptyLabel: props.emptyLabel })}
            placement="bottom"
            popoverAnchorAlign={props.fill ? 'start' : 'end'}
            variant="slim"
            matchTriggerWidth={props.fill === true}
            {...(props.fill ? {} : { maxWidthCap: 320 })}
            showCategoryTitles={grouped}
            {...(props.searchPlaceholder ? { search: true, searchPlaceholder: props.searchPlaceholder } : {})}
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
                    // A field that cannot change now paints at the disabled step its row's segmented choice uses, so
                    // the row reads as held, not merely unresponsive.
                    style={props.disabled ? DISABLED_TRIGGER_STYLE : TRIGGER_STYLE}
                >
                    {renderDropdownItemTriggerRightElement({
                        detail: selectedTitle,
                        open,
                        detailColor: theme.colors.text.secondary,
                        chevronColor: theme.colors.text.secondary,
                        field: resolveFieldBoxColors(theme, props.invalid ? 'invalid' : 'idle'),
                        leading: selected?.icon,
                        fieldSpan: props.fill ? 'row' : props.compact ? 'intrinsic' : 'content',
                    })}
                </HappierPressable>
            )}
        />
    );
});
