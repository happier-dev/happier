import React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { usePopoverBoundaryRef } from '@/components/ui/popover';
import { normalizeNodeForView } from '@/components/ui/rendering/normalizeNodeForView';

import type {
    AgentInputChipPickerOption,
    AgentInputChipPickerOptionSection,
} from './AgentInputChipPickerTypes';

export type AgentInputChipPickerTopSelectorProps = Readonly<{
    sections: ReadonlyArray<AgentInputChipPickerOptionSection>;
    focusedOptionId: string | null;
    selectedOptionId: string | null;
    onFocusOption: (optionId: string) => void;
}>;

const PICKER_ICON_SIZE = 18;

function normalizePickerIcon(icon: React.ReactNode): React.ReactNode {
    if (!icon) return undefined;

    const resizedIcon = React.isValidElement(icon) && icon.type !== React.Fragment
        ? React.cloneElement(icon as React.ReactElement<Record<string, unknown>>, {
            size: PICKER_ICON_SIZE,
        })
        : icon;

    return (
        <View style={iconStyles.iconWrapper}>
            {normalizeNodeForView(resizedIcon)}
        </View>
    );
}

export function AgentInputChipPickerTopSelector(props: AgentInputChipPickerTopSelectorProps) {
    const styles = stylesheet;
    const [open, setOpen] = React.useState(false);
    const popoverBoundaryRef = usePopoverBoundaryRef();

    const items = React.useMemo<ReadonlyArray<DropdownMenuItem>>(
        () =>
            props.sections.flatMap((section) =>
                section.options.map((option) => ({
                    id: option.id,
                    title: option.label,
                    subtitle: option.subtitle,
                    category: section.label,
                    icon: normalizePickerIcon(option.icon),
                    disabled: option.disabled,
                })),
            ),
        [props.sections],
    );

    const focusedOption = React.useMemo<AgentInputChipPickerOption | null>(() => {
        for (const section of props.sections) {
            const found = section.options.find((option) => option.id === props.focusedOptionId);
            if (found) return found;
        }
        return props.sections[0]?.options[0] ?? null;
    }, [props.focusedOptionId, props.sections]);

    const subtitle = focusedOption?.subtitle ?? focusedOption?.sectionLabel ?? null;
    const itemTrigger = React.useMemo(() => ({
        title: focusedOption?.label ?? '',
        icon: normalizePickerIcon(focusedOption?.icon),
        subtitleFormatter: () => subtitle,
        showSelectedDetail: false,
        itemProps: {
            testID: 'agent-input-chip-picker.top-selector-trigger',
            style: styles.triggerItem,
        },
    }), [focusedOption?.icon, focusedOption?.label, styles.triggerItem, subtitle]);

    return (
        <View testID="agent-input-chip-picker.top-selector" style={styles.container}>
            <DropdownMenu
                open={open}
                onOpenChange={setOpen}
                items={items}
                selectedId={props.selectedOptionId ?? focusedOption?.id ?? null}
                onSelect={props.onFocusOption}
                rowKind="item"
                variant="selectable"
                matchTriggerWidth
                popoverBoundaryRef={popoverBoundaryRef}
                itemTrigger={itemTrigger}
            />
        </View>
    );
}

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        width: '100%',
    },
    triggerItem: {
        paddingHorizontal: 0,
    },
}));

const iconStyles = StyleSheet.create({
    iconWrapper: {
        width: PICKER_ICON_SIZE,
        height: PICKER_ICON_SIZE,
        alignItems: 'center',
        justifyContent: 'center',
    },
});
