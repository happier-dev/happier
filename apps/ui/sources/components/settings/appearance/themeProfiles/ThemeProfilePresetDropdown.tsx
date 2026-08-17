import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { t } from '@/text';
import type { ThemePresetSourceOption } from './themeProfilePresetOptions';
import { Icon, type IconName } from '@/components/ui/icons/Icon';

const getPresetIconName = (option: ThemePresetSourceOption): IconName => {
    if (option.kind === 'builtIn') return 'sparkle';
    if (option.kind === 'custom') return 'palette';
    return option.id === 'dark' ? 'moon' : 'sun';
};

export const ThemeProfilePresetDropdown = React.memo(function ThemeProfilePresetDropdown(props: Readonly<{
    open: boolean;
    onOpenChange: (open: boolean) => void;
    options: readonly ThemePresetSourceOption[];
    selectedOption: ThemePresetSourceOption | null;
    onSelect: (presetId: string) => void;
}>) {
    const { theme } = useUnistyles();
    const items = React.useMemo((): readonly DropdownMenuItem[] => props.options.map((option) => ({
        id: option.id,
        title: option.title,
        subtitle: option.subtitle,
        icon: <Icon name={getPresetIconName(option)} size={20} color={option.kind === 'builtIn' ? theme.colors.accent.indigo : theme.colors.status.connecting} />,
    })), [props.options, theme.colors.accent.indigo, theme.colors.status.connecting]);

    return (
        <DropdownMenu
            open={props.open}
            onOpenChange={props.onOpenChange}
            variant="selectable"
            search={false}
            selectedId={props.selectedOption?.id ?? 'light'}
            showCategoryTitles={false}
            matchTriggerWidth={true}
            connectToTrigger={true}
            rowKind="item"
            itemTrigger={{
                title: t('settingsAppearance.themeProfiles.presetSource'),
                subtitle: props.selectedOption?.title ?? t('settingsAppearance.themeProfiles.presetSourceSubtitle'),
                icon: <Icon name="stack-simple" size={29} color={theme.colors.accent.indigo} />,
                showSelectedSubtitle: false,
                itemProps: { testID: 'settings-theme-profile-preset-source' },
            }}
            items={items}
            onSelect={props.onSelect}
        />
    );
});
