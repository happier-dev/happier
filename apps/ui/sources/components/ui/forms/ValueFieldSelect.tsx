import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';

import { DropdownMenu, type DropdownMenuSelection } from '@/components/ui/forms/dropdown/DropdownMenu';
import { renderDropdownItemTriggerRightElement } from '@/components/ui/forms/dropdown/renderDropdownItemTriggerRightElement';
import { resolveFieldBoxColors } from '@/components/ui/forms/fieldBox';

export type ValueFieldSelectItem = Readonly<{
    id: string;
    title: string;
    /** A leading mark, shown in the menu row and in the field when selected. */
    icon?: React.ReactNode;
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
}>) {
    const { theme } = useUnistyles();
    const [open, setOpen] = React.useState(false);
    const items = React.useMemo(() => props.items.map((item) => ({
        id: item.id,
        title: item.title,
        ...(item.icon ? { icon: item.icon } : {}),
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
                setOpen(false);
                props.onSelect(id, selection);
            }}
            placement="bottom"
            popoverAnchorAlign={props.fill ? 'start' : 'end'}
            variant="slim"
            matchTriggerWidth={props.fill === true}
            {...(props.fill ? {} : { maxWidthCap: 320 })}
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
                    style={{ justifyContent: 'center' }}
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
