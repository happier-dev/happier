import * as React from 'react';

import { useUnistyles } from 'react-native-unistyles';

import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';

import {
    buildChoiceDropdownItems,
    findChoiceOption,
    findChoiceOptionById,
    type ChoiceOption,
} from './DesktopOverlaySettingsSection.options';

type DesktopOverlayChoiceDropdownRowProps<T extends string | number> = Readonly<{
    testID?: string;
    title: string;
    subtitle: string;
    icon: React.ReactNode;
    choices: readonly ChoiceOption<T>[];
    selectedValue: T;
    onSelect: (value: T) => void;
}>;

export function DesktopOverlayChoiceDropdownRow<T extends string | number>({
    testID,
    title,
    subtitle,
    icon,
    choices,
    selectedValue,
    onSelect,
}: DesktopOverlayChoiceDropdownRowProps<T>) {
    const { theme } = useUnistyles();
    const [open, setOpen] = React.useState(false);

    const items = React.useMemo(
        () => buildChoiceDropdownItems(choices, theme.colors.textSecondary),
        [choices, theme.colors.textSecondary],
    );
    const selectedId = React.useMemo(() => {
        const selectedChoice = findChoiceOption(choices, selectedValue);
        return selectedChoice ? String(selectedChoice.value) : null;
    }, [choices, selectedValue]);

    return (
        <DropdownMenu
            open={open}
            onOpenChange={setOpen}
            items={items}
            selectedId={selectedId}
            onSelect={(itemId) => {
                const selectedChoice = findChoiceOptionById(choices, itemId);
                if (!selectedChoice) {
                    return;
                }

                onSelect(selectedChoice.value);
            }}
            itemTrigger={{
                title,
                subtitle,
                icon,
                itemProps: testID ? { testID } : undefined,
                showSelectedSubtitle: false,
            }}
            rowKind="item"
            connectToTrigger
            variant="default"
        />
    );
}
