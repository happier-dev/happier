import * as React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';

import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { ItemRowActions } from '@/components/ui/lists/ItemRowActions';
import type { ItemAction } from '@/components/ui/lists/itemActions';
import { t } from '@/text';
import { BUILT_IN_THEME_PROFILES, getBuiltInThemeProfileDefinition, isBuiltInThemeProfilePresetId } from '@/theme/profiles/builtInThemeProfiles';
import { findThemeProfileById } from '@/theme/profiles/themeProfilePersistence';
import type { BuiltInThemeProfileDefinition, ThemeProfilesLocalStateV1, ThemeProfileV1 } from '@/theme/profiles/themeProfileTypes';
import type { ThemePreference } from '@/components/ui/layout/statusBarStyle';

type BaseThemeSelectionId = ThemePreference;
type ThemeSelectionKind = 'base' | 'builtIn' | 'custom';

export type ThemeSelectionOption = Readonly<{
    id: string;
    kind: ThemeSelectionKind;
    title: string;
    subtitle: string;
    profile: ThemeProfileV1 | null;
    builtInDefinition?: BuiltInThemeProfileDefinition;
}>;

export type ThemeSelectionDropdownProps = Readonly<{
    open: boolean;
    onOpenChange: (open: boolean) => void;
    themePreference: ThemePreference;
    themeProfiles: ThemeProfilesLocalStateV1;
    managementActions?: boolean;
    onSelectBaseTheme: (themePreference: BaseThemeSelectionId) => void;
    onSelectProfile: (profileId: string) => void;
    onDuplicateTheme?: (option: ThemeSelectionOption) => void;
    onEditProfile?: (profile: ThemeProfileV1) => void;
    onDeleteProfile?: (profile: ThemeProfileV1) => void;
}>;

const baseThemeOptions = (): readonly ThemeSelectionOption[] => [
    {
        id: 'adaptive',
        kind: 'base',
        title: t('settingsAppearance.themeOptions.adaptive'),
        subtitle: t('settingsAppearance.themeDescriptions.adaptive'),
        profile: null,
    },
    {
        id: 'light',
        kind: 'base',
        title: t('settingsAppearance.themeOptions.light'),
        subtitle: t('settingsAppearance.themeDescriptions.light'),
        profile: null,
    },
    {
        id: 'dark',
        kind: 'base',
        title: t('settingsAppearance.themeOptions.dark'),
        subtitle: t('settingsAppearance.themeDescriptions.dark'),
        profile: null,
    },
];

export const resolveSelectedThemeSelectionId = (
    themePreference: ThemePreference,
    themeProfiles: ThemeProfilesLocalStateV1,
): string => {
    const activeProfile = findThemeProfileById(themeProfiles, themeProfiles.activeProfileId);
    if (!activeProfile) return themePreference;
    return activeProfile.id;
};

export const buildThemeSelectionOptions = (themeProfiles: ThemeProfilesLocalStateV1): readonly ThemeSelectionOption[] => [
    ...baseThemeOptions(),
    ...BUILT_IN_THEME_PROFILES.map((definition): ThemeSelectionOption => ({
        id: definition.profile.id,
        kind: 'builtIn',
        title: t(definition.translationKey),
        subtitle: t('settingsAppearance.themeProfiles.readOnlyPreset'),
        profile: definition.profile,
        builtInDefinition: definition,
    })),
    ...themeProfiles.profiles.map((profile): ThemeSelectionOption => ({
        id: profile.id,
        kind: 'custom',
        title: profile.name,
        subtitle: t('settingsAppearance.themeProfiles.customProfileSubtitle'),
        profile,
    })),
];

const getOptionIconName = (option: ThemeSelectionOption): React.ComponentProps<typeof Ionicons>['name'] => {
    if (option.kind === 'builtIn') return 'sparkles-outline';
    if (option.kind === 'custom') return 'color-palette-outline';
    return 'contrast-outline';
};

export const ThemeSelectionDropdown = React.memo(function ThemeSelectionDropdown(props: ThemeSelectionDropdownProps) {
    const { theme } = useUnistyles();
    const selectedId = resolveSelectedThemeSelectionId(props.themePreference, props.themeProfiles);
    const options = React.useMemo(() => buildThemeSelectionOptions(props.themeProfiles), [props.themeProfiles]);

    const items = React.useMemo((): readonly DropdownMenuItem[] => options.map((option) => {
        const actions: ItemAction[] = [];

        if (props.managementActions && props.onDuplicateTheme) {
            actions.push({
                id: `duplicate-${option.id}`,
                title: t('settingsAppearance.themeProfiles.duplicateTheme'),
                subtitle: option.title,
                icon: 'copy-outline',
                color: theme.colors.accent.blue,
                inlineTestID: `settings-theme-duplicate-${option.id}`,
                onPress: () => props.onDuplicateTheme?.(option),
            });
        }

        if (props.managementActions && option.kind === 'custom' && option.profile && props.onEditProfile) {
            const profile = option.profile;
            actions.push({
                id: `edit-${option.id}`,
                title: t('settingsAppearance.themeProfiles.editProfile'),
                subtitle: option.title,
                icon: 'create-outline',
                color: theme.colors.accent.blue,
                inlineTestID: `settings-theme-edit-${option.id}`,
                onPress: () => props.onEditProfile?.(profile),
            });
        }

        if (props.managementActions && option.kind === 'custom' && option.profile && props.onDeleteProfile) {
            const profile = option.profile;
            actions.push({
                id: `delete-${option.id}`,
                title: t('settingsAppearance.themeProfiles.deleteProfile'),
                subtitle: option.title,
                icon: 'trash-outline',
                destructive: true,
                inlineTestID: `settings-theme-delete-${option.id}`,
                onPress: () => props.onDeleteProfile?.(profile),
            });
        }

        return {
            id: option.id,
            title: option.title,
            subtitle: option.subtitle,
            icon: <Ionicons name={getOptionIconName(option)} size={22} color={option.kind === 'builtIn' ? theme.colors.accent.indigo : theme.colors.status.connecting} />,
            rightElement: actions.length ? (
                <ItemRowActions
                    title={option.title}
                    actions={actions}
                    compactActionIds={actions.map((action) => action.id)}
                    pinnedActionIds={actions.map((action) => action.id)}
                    overflowTriggerTestID={`settings-theme-actions-${option.id}`}
                    iconSize={18}
                    gap={12}
                />
            ) : undefined,
        };
    }), [options, props, theme.colors.accent.blue, theme.colors.accent.indigo, theme.colors.status.connecting]);

    const selectedOption = options.find((option) => option.id === selectedId) ?? null;

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
                title: t('settingsAppearance.theme'),
                subtitle: selectedOption?.subtitle ?? t('settingsAppearance.themeDescription'),
                icon: <Ionicons name="contrast-outline" size={29} color={theme.colors.status.connecting} />,
                showSelectedSubtitle: false,
                itemProps: { testID: 'settings-theme-selector-trigger' },
            }}
            items={items}
            onSelect={(itemId) => {
                if (itemId === 'adaptive' || itemId === 'light' || itemId === 'dark') {
                    props.onSelectBaseTheme(itemId);
                    return;
                }

                const builtIn = isBuiltInThemeProfilePresetId(itemId)
                    ? getBuiltInThemeProfileDefinition(itemId)
                    : undefined;
                if (builtIn) {
                    props.onSelectProfile(builtIn.profile.id);
                    return;
                }

                props.onSelectProfile(itemId);
            }}
        />
    );
});
