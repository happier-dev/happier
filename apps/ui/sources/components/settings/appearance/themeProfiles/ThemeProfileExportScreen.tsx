import * as React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { Platform, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { useUnistyles } from 'react-native-unistyles';
import { StyleSheet } from 'react-native-unistyles';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { CopiedPill } from '@/components/ui/copy/CopiedPill';
import { SettingsActionFooter } from '@/components/ui/settingsSurface/SettingsActionFooter';
import { TextInput } from '@/components/ui/text/Text';
import { useTemporaryCopyFeedback } from '@/components/ui/copy/useTemporaryCopyFeedback';
import { useLocalSettingMutable } from '@/sync/domains/state/storage';
import { t } from '@/text';
import { setClipboardStringSafe } from '@/utils/ui/clipboard';
import { exportThemeProfileToJson } from '@/theme/profiles/themeProfileImportExport';
import { BUILT_IN_THEME_PROFILES, getBuiltInThemeProfileDefinition, isBuiltInThemeProfilePresetId } from '@/theme/profiles/builtInThemeProfiles';
import type { ThemeProfileMode, ThemeProfileV1 } from '@/theme/profiles/themeProfileTypes';
import { resolveThemePresetSourcePreferredMode } from './themeProfilePresetOptions';

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

async function downloadThemeJson(fileName: string, json: string): Promise<void> {
    if (
        Platform.OS === 'web'
        && typeof document !== 'undefined'
        && typeof Blob !== 'undefined'
        && typeof URL !== 'undefined'
        && typeof URL.createObjectURL === 'function'
    ) {
        const href = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
        const anchor = document.createElement('a');
        anchor.href = href;
        anchor.download = fileName;
        anchor.click();
        setTimeout(() => URL.revokeObjectURL(href), 1000);
        return;
    }

    const file = new File(Paths.cache, fileName);
    file.write(json);
    await Sharing.shareAsync(file.uri, {
        mimeType: 'application/json',
        dialogTitle: t('settingsAppearance.themeProfiles.exportProfile'),
    });
}

export const ThemeProfileExportScreen = React.memo(function ThemeProfileExportScreen() {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const copyFeedback = useTemporaryCopyFeedback();
    const params = useLocalSearchParams();
    const [themeProfiles] = useLocalSettingMutable('themeProfiles');
    const profileId = getProfileIdParam(params.profileId);
    const builtInProfile = BUILT_IN_THEME_PROFILES.find((definition) => definition.profile.id === profileId)?.profile ?? null;
    const profile = themeProfiles.profiles.find((entry) => entry.id === profileId) ?? builtInProfile;
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
        await downloadThemeJson(fileName, json);
    }, [fileName, json]);

    return (
        <ItemList testID="settings-theme-profile-export-screen" style={{ paddingTop: 0 }}>
            <ItemGroup title={t('settingsAppearance.themeProfiles.exportProfile')} footer={t('settingsAppearance.themeProfiles.exportFooter')}>
                <Item
                    title={profile ? profile.name : t('settingsAppearance.themeProfiles.noProfiles')}
                    subtitle={profile ? t('settingsAppearance.themeProfiles.exportProfileSubtitle') : t('settingsAppearance.themeProfiles.createProfileSubtitle')}
                    mode="info"
                    icon={<Ionicons name="share-outline" size={28} color={theme.colors.accent.orange} />}
                />
                <Item
                    title={t('settingsAppearance.themeProfiles.exportJson')}
                    mode="info"
                    showDivider={false}
                />
                <View style={styles.jsonExportRow}>
                    <TextInput
                        testID="settings-theme-profile-export-json"
                        value={json}
                        editable={false}
                        multiline
                        style={styles.jsonTextArea}
                    />
                </View>
            </ItemGroup>
            <View style={styles.feedbackRow}>
                <CopiedPill
                    visible={copyFeedback.isCopied('theme-profile')}
                    testID="settings-theme-profile-export-copy-feedback"
                />
            </View>
            <SettingsActionFooter
                primaryLabel={t('settingsAppearance.themeProfiles.copyExportJson')}
                primaryTestID="settings-theme-profile-export-copy"
                primaryDisabled={!json}
                onPrimaryPress={() => { void copy(); }}
                secondaryLabel={t('settingsAppearance.themeProfiles.downloadExportJson')}
                secondaryTestID="settings-theme-profile-export-download"
                onSecondaryPress={() => { void download(); }}
            />
        </ItemList>
    );
});

const stylesheet = StyleSheet.create((theme) => ({
    jsonExportRow: {
        paddingHorizontal: 16,
        paddingBottom: 16,
    },
    jsonTextArea: {
        backgroundColor: theme.colors.surface.inset,
        borderColor: theme.colors.border.surface,
        borderRadius: 14,
        borderWidth: 1,
        color: theme.colors.input.text,
        minHeight: 220,
        paddingHorizontal: 14,
        paddingVertical: 12,
        textAlignVertical: 'top',
        width: '100%',
    },
    feedbackRow: {
        alignItems: 'flex-end',
        paddingHorizontal: 16,
    },
}));
