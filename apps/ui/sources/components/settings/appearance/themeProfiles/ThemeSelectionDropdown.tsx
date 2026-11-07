import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import type { ThemePreference } from '@/components/ui/layout/statusBarStyle';
import { t } from '@/text';
import type { ThemeProfileMode, ThemeProfilesLocalStateV1 } from '@/theme/profiles/themeProfileTypes';
import { getActiveThemeProfileIdForMode } from '@/theme/profiles/themeProfilePersistence';
import { buildThemePresetSourceOptions, type ThemePresetSourceOption } from './themeProfilePresetOptions';
import { Icon, type IconName } from '@/components/ui/icons/Icon';
import { IconAction } from '@/components/ui/buttons/IconAction';

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
): IconName => {
    if (option.kind === 'adaptive') return 'circle-half';
    if (option.kind === 'builtIn') return 'sparkle';
    if (option.kind === 'custom') return 'palette';
    return option.id === 'dark' ? 'moon' : 'sun';
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
            <Icon
                name={getOptionIconName(option)}
                size={20}
                color={option.kind === 'builtIn' ? theme.colors.accent.indigo : theme.colors.status.connecting}
            />
        ),
    })), [options, theme.colors.accent.indigo, theme.colors.status.connecting]);

    const selectTheme = (itemId: string) => {
        if (props.variant === 'current') {
            const option = options.find((entry) => entry.id === itemId);
            if (option) props.onSelectTheme(option);
            return;
        }
        props.onSelectProfile(itemId === props.mode ? null : itemId);
    };
    const selectedIndex = options.findIndex((option) => option.id === selectedId);
    const previous = options[selectedIndex - 1];
    const next = selectedIndex >= 0 ? options[selectedIndex + 1] : undefined;
    const testID = props.variant === 'current'
        ? 'settings-theme-selector'
        : `settings-theme-${props.mode}-selector`;

    return (
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            <View style={{ flex: 1, minWidth: 0 }}>
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
                            <Icon
                                name={props.variant === 'current'
                                    ? 'circle-half'
                                    : props.mode === 'dark' ? 'moon' : 'sun'}
                                size={29}
                                color={theme.colors.status.connecting}
                            />
                        ),
                        showSelectedSubtitle: false,
                        itemProps: { testID: `${testID}-trigger` },
                    }}
                    items={items}
                    onSelect={selectTheme}
                />
            </View>
            <View style={{ flexDirection: 'row', paddingEnd: 8, gap: 4 }}>
                <IconAction
                    testID={`${testID}-previous`}
                    accessibilityLabel={`${t('settingsAppearance.theme')}: ${t('common.previous')}`}
                    disabled={!previous}
                    style={{ minWidth: 44, minHeight: 44 }}
                    onPress={() => { if (previous) selectTheme(previous.id); }}
                >
                    <Icon name="caret-up" size={20} color={theme.colors.text.secondary} />
                </IconAction>
                <IconAction
                    testID={`${testID}-next`}
                    accessibilityLabel={`${t('settingsAppearance.theme')}: ${t('common.next')}`}
                    disabled={!next}
                    style={{ minWidth: 44, minHeight: 44 }}
                    onPress={() => { if (next) selectTheme(next.id); }}
                >
                    <Icon name="caret-down" size={20} color={theme.colors.text.secondary} />
                </IconAction>
            </View>
        </View>
    );
});
