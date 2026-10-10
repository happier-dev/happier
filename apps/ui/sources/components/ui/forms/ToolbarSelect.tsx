import * as React from 'react';
import { Platform } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';

import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { renderDropdownItemTriggerRightElement } from '@/components/ui/forms/dropdown/renderDropdownItemTriggerRightElement';
import { resolveFieldBoxColors } from '@/components/ui/forms/fieldBox';
import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';

export type ToolbarSelectItem = Readonly<{
    id: string;
    title: string;
    /** A leading mark (an agent's brand mark), shown in the menu row and in the trigger when selected. */
    icon?: React.ReactNode;
}>;

/**
 * A toolbar filter or scope choice: the selected choice in a compact bordered field, the choices in a
 * menu. Used where a page or modal narrows one collection (Plugins' status and source, the external
 * sessions browser's agent and source); a configuration row uses a field select instead.
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
}>) {
    const { theme } = useUnistyles();
    const [open, setOpen] = React.useState(false);
    const items = React.useMemo(() => props.items.map((item) => ({
        id: item.id,
        title: item.title,
        ...(item.icon ? { icon: item.icon } : {}),
        testID: `${props.testID}:${item.id}`,
    })), [props.items, props.testID]);
    const selected = props.items.find((item) => item.id === props.selectedId) ?? props.items[0] ?? null;
    const selectedTitle = selected?.title ?? '';
    return (
        <DropdownMenu
            testID={props.testID}
            open={open && props.disabled !== true}
            onOpenChange={setOpen}
            items={items}
            selectedId={props.selectedId}
            onSelect={(id) => {
                setOpen(false);
                props.onSelect(id);
            }}
            placement="bottom"
            popoverAnchorAlign="end"
            variant="slim"
            matchTriggerWidth={false}
            maxWidthCap={320}
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
                    style={{ minHeight: resolveMinimumInteractiveTargetSize(Platform.OS), minWidth: resolveMinimumInteractiveTargetSize(Platform.OS), justifyContent: 'center' }}
                >
                    {renderDropdownItemTriggerRightElement({
                        detail: selectedTitle,
                        open,
                        detailColor: theme.colors.text.secondary,
                        chevronColor: theme.colors.text.secondary,
                        field: resolveFieldBoxColors(theme),
                        leading: selected?.icon,
                        fieldSpan: props.compact ? 'intrinsic' : 'content',
                    })}
                </HappierPressable>
            )}
        />
    );
});
