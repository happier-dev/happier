import * as React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';

import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import type { ThemePreference } from '@/components/ui/layout/statusBarStyle';
import { t } from '@/text';
import type { ThemeProfileMode, ThemeProfilesLocalStateV1 } from '@/theme/profiles/themeProfileTypes';
import { getActiveThemeProfileIdForMode } from '@/theme/profiles/themeProfilePersistence';
import { buildThemePresetSourceOptions, type ThemePresetSourceOption } from './themeProfilePresetOptions';

type ThemeSelectionBaseProps = Readonly<{
    open: boolean;
    onOpenChange: (open: boolean) => void;
    themeProfiles: ThemeProfilesLocalStateV1;
}>;

type AdaptiveThemeSelectionOption = Readonly<{
    id: 'adaptive';
    kind: 'adaptive';
    title: string;
    subtitle: string;
    profile: null;
    preferredMode: null;
}>;

export type ThemeSelectionOption = ThemePresetSourceOption | AdaptiveThemeSelectionOption;

export type ThemeSelectionDropdownProps = ThemeSelectionBaseProps & (
    | Readonly<{
        variant: 'current';
        themePreference: ThemePreference;
        onSelectTheme: (option: ThemeSelectionOption) => void;
    }>
    | Readonly<{
        variant: 'slot';
        mode: ThemeProfileMode;
        onSelectProfile: (profileId: string | null) => void;
    }>
);

const adaptiveThemeOption = (): AdaptiveThemeSelectionOption => ({
    id: 'adaptive',
    kind: 'adaptive',
    title: t('settingsAppearance.themeOptions.adaptive'),
    subtitle: t('settingsAppearance.themeDescriptions.adaptive'),
    profile: null,
    preferredMode: null,
});

export const buildCurrentThemeSelectionOptions = (
    themeProfiles: ThemeProfilesLocalStateV1,
): readonly ThemeSelectionOption[] => [
    adaptiveThemeOption(),
    ...buildThemePresetSourceOptions(themeProfiles),
];

export const buildThemeSelectionOptions = (
    themeProfiles: ThemeProfilesLocalStateV1,
    mode: ThemeProfileMode,
): readonly ThemePresetSourceOption[] => (
    buildThemePresetSourceOptions(themeProfiles)
        .filter((option) => option.preferredMode === mode)
);

export const resolveCurrentThemeSelectionId = (
    themePreference: ThemePreference,
    themeProfiles: ThemeProfilesLocalStateV1,
): string => {
    if (themePreference === 'adaptive') return 'adaptive';
    return getActiveThemeProfileIdForMode(themeProfiles, themePreference) ?? themePreference;
};

export const resolveSelectedThemeSelectionId = (
    mode: ThemeProfileMode,
    themeProfiles: ThemeProfilesLocalStateV1,
): string => getActiveThemeProfileIdForMode(themeProfiles, mode) ?? mode;

export type ThemeSlotSelectionDropdownProps = ThemeSelectionBaseProps & Readonly<{
    variant: 'slot';
    mode: ThemeProfileMode;
    onSelectProfile: (profileId: string | null) => void;
}>;

const getOptionIconName = (
    option: ThemeSelectionOption,
): React.ComponentProps<typeof Ionicons>['name'] => {
    if (option.kind === 'adaptive') return 'contrast-outline';
    if (option.kind === 'builtIn') return 'sparkles-outline';
    if (option.kind === 'custom') return 'color-palette-outline';
    return option.id === 'dark' ? 'moon-outline' : 'sunny-outline';
};

export const ThemeSelectionDropdown = React.memo(function ThemeSelectionDropdown(props: ThemeSelectionDropdownProps) {
    const { theme } = useUnistyles();
    const mode = props.variant === 'slot' ? props.mode : null;
    const selectedId = props.variant === 'current'
        ? resolveCurrentThemeSelectionId(props.themePreference, props.themeProfiles)
        : resolveSelectedThemeSelectionId(props.mode, props.themeProfiles);
    const options = React.useMemo(
        () => props.variant === 'current'
            ? buildCurrentThemeSelectionOptions(props.themeProfiles)
            : buildThemeSelectionOptions(props.themeProfiles, props.mode),
        [mode, props.themeProfiles, props.variant],
    );

    const items = React.useMemo((): readonly DropdownMenuItem[] => options.map((option) => ({
        id: option.id,
        title: option.title,
        subtitle: option.subtitle,
        icon: (
            <Ionicons
                name={getOptionIconName(option)}
                size={22}
                color={option.kind === 'builtIn' ? theme.colors.accent.indigo : theme.colors.status.connecting}
            />
        ),
    })), [options, theme.colors.accent.indigo, theme.colors.status.connecting]);

    return (
        <DropdownMenu
            open={props.open}
            onOpenChange={props.onOpenChange}
            variant="selectable"
            search={false}
            selectedId={selectedId}
            showCategoryTitles={false}
            matchTriggerWidth={true}
            connectToTrigger={true}
            rowKind="item"
            itemTrigger={{
                title: props.variant === 'current'
                    ? t('settingsAppearance.theme')
                    : props.mode === 'dark'
                    ? t('settingsAppearance.themeOptions.dark')
                    : t('settingsAppearance.themeOptions.light'),
                subtitle: props.variant === 'current'
                    ? t('settingsAppearance.themeDescription')
                    : props.mode === 'dark'
                    ? t('settingsAppearance.themeDescriptions.dark')
                    : t('settingsAppearance.themeDescriptions.light'),
                icon: (
                    <Ionicons
                        name={props.variant === 'current'
                            ? 'contrast-outline'
                            : props.mode === 'dark' ? 'moon-outline' : 'sunny-outline'}
                        size={29}
                        color={theme.colors.status.connecting}
                    />
                ),
                showSelectedSubtitle: false,
                itemProps: {
                    testID: props.variant === 'current'
                        ? 'settings-theme-selector-trigger'
                        : `settings-theme-${props.mode}-selector-trigger`,
                },
            }}
            items={items}
            onSelect={(itemId) => {
                if (props.variant === 'current') {
                    const option = options.find((entry) => entry.id === itemId);
                    if (option) props.onSelectTheme(option);
                    return;
                }
                props.onSelectProfile(itemId === props.mode ? null : itemId);
            }}
        />
    );
});
