import * as React from 'react';
import { View } from 'react-native';
import { useLocalSearchParams } from '@/components/appShell/workspace/destinationRoute';
import { StyleSheet } from 'react-native-unistyles';

import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { CopiedPill } from '@/components/ui/copy/CopiedPill';
import { SectionContentRow } from '@/components/ui/lists/SectionContentRow';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { useTemporaryCopyFeedback } from '@/components/ui/copy/useTemporaryCopyFeedback';
import { useLocalSettingMutable } from '@/sync/domains/state/storage';
import { t } from '@/text';
import { setClipboardStringSafe } from '@/utils/ui/clipboard';
import { exportThemeProfileToJson } from '@/theme/profiles/themeProfileImportExport';
import { BUILT_IN_THEME_PROFILES, getBuiltInThemeProfileDefinition, isBuiltInThemeProfilePresetId } from '@/theme/profiles/builtInThemeProfiles';
import type { ThemeProfileMode, ThemeProfileV1 } from '@/theme/profiles/themeProfileTypes';
import { resolveThemePresetSourcePreferredMode } from './themeProfilePresetOptions';
import { exportThemeProfileFile } from './themeProfileFileExport';
import { SettingsPageHeader } from '@/components/settings/shell/SettingsPageHeader';

const getProfileIdParam = (value: string | string[] | undefined): string | null => {
    if (Array.isArray(value)) return value[0] ?? null;
    return value ?? null;
};

const sanitizeDownloadName = (value: string): string => (
    value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'theme'
);

const resolveExportMode = (profile: ThemeProfileV1): ThemeProfileMode => {
    const builtIn = isBuiltInThemeProfilePresetId(profile.id) ? getBuiltInThemeProfileDefinition(profile.id) : undefined;
    if (builtIn) return builtIn.preferredMode;
    return resolveThemePresetSourcePreferredMode(profile);
};


export const ThemeProfileExportScreen = React.memo(function ThemeProfileExportScreen() {
    const styles = stylesheet;
    const copyFeedback = useTemporaryCopyFeedback();
    const params = useLocalSearchParams();
    const [themeProfiles] = useLocalSettingMutable('themeProfiles');
    const profileId = getProfileIdParam(params.profileId);
    const builtInDefinition = BUILT_IN_THEME_PROFILES.find((definition) => definition.profile.id === profileId);
    const customProfile = themeProfiles.profiles.find((entry) => entry.id === profileId) ?? null;
    const profile = customProfile ?? builtInDefinition?.profile ?? null;
    // Built-in themes are named by their translated title, not their stored profile name.
    const displayName = customProfile?.name ?? (builtInDefinition ? t(builtInDefinition.translationKey) : null);
    const json = React.useMemo(() => (profile ? exportThemeProfileToJson(profile, { mode: resolveExportMode(profile), includeResolvedValues: true }) : ''), [profile]);
    const fileName = React.useMemo(() => (profile ? `happier-theme-${sanitizeDownloadName(profile.name)}.json` : 'happier-theme.json'), [profile]);

    const copy = React.useCallback(async () => {
        if (!json) return;
        const copied = await setClipboardStringSafe(json);
        if (copied) {
            copyFeedback.markCopied('theme-profile');
        }
    }, [copyFeedback, json]);

    const download = React.useCallback(async () => {
        if (!json) return;
        await exportThemeProfileFile(fileName, json);
    }, [fileName, json]);

    return (
        <ItemList testID="settings-theme-profile-export-screen" style={{ paddingTop: 0 }}>
            <SettingsPageHeader
                description={profile
                    ? t('settingsAppearance.themeProfiles.exportPageDescription')
                    : t('settingsAppearance.themeProfiles.exportMissingDescription')}
                actions={profile ? (
                    <View style={styles.headerActions}>
                        <CopiedPill
                            visible={copyFeedback.isCopied('theme-profile')}
                            testID="settings-theme-profile-export-copy-feedback"
                        />
                        <RoundButton
                            testID="settings-theme-profile-export-download"
                            size="small"
                            display="inverted"
                            title={t('settingsAppearance.themeProfiles.downloadExportJson')}
                            onPress={() => { void download(); }}
                        />
                        <RoundButton
                            testID="settings-theme-profile-export-copy"
                            size="small"
                            title={t('settingsAppearance.themeProfiles.copyExportJson')}
                            disabled={!json}
                            onPress={() => { void copy(); }}
                        />
                    </View>
                ) : undefined}
            />
            {profile ? (
                <ItemGroup title={displayName ?? profile.name} description={t('settingsAppearance.themeProfiles.exportFooter')}>
                    <SectionContentRow>
                        <FieldTextInput
                            testID="settings-theme-profile-export-json"
                            value={json}
                            onChangeText={() => {}}
                            editable={false}
                            accessibilityLabel={t('settingsAppearance.themeProfiles.exportJson')}
                            multiline
                            minLines={12}
                            monospace
                        />
                    </SectionContentRow>
                </ItemGroup>
            ) : null}
        </ItemList>
    );
});

const stylesheet = StyleSheet.create(() => ({
    headerActions: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
}));
