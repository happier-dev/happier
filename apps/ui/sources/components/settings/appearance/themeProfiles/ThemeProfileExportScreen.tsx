import { useThemeProfileDocument } from '@/sync/store/useThemeProfiles';
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
import { useHappierCopyFeedback } from '@happier-dev/plugin-ui/presentation';
import { t } from '@/text';
import { useClipboardWrite } from '@/hooks/ui/useClipboardWrite';
import { exportThemeProfileToJson } from '@/theme/profiles/themeProfileImportExport';
import { getBuiltInThemeProfileDefinition, isBuiltInThemeProfilePresetId } from '@/theme/profiles/builtInThemeProfiles';
import type { ThemeProfileMode, ThemeProfileV1 } from '@/theme/profiles/themeProfileTypes';
import { readThemePresetSourceReferenceId, resolveThemePresetSourcePreferredMode } from './themeProfilePresetOptions';
import { exportThemeProfileFile } from './themeProfileFileExport';
import { SettingsPageHeader } from '@/components/settings/shell/SettingsPageHeader';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';

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
    const presented = useLayoutPresentationActive();
    const writeClipboard = useClipboardWrite();
    const styles = stylesheet;
    const copyFeedback = useHappierCopyFeedback();
    const params = useLocalSearchParams();
    const profileId = getProfileIdParam(params.profileId);
    const reference = React.useMemo(() => readThemePresetSourceReferenceId(profileId), [profileId]);
    const read = useThemeProfileDocument(reference, presented);
    const profile = read.document?.profile ?? null;
    const builtInDefinition = reference?.kind === 'built-in' ? getBuiltInThemeProfileDefinition(reference.presetId) : undefined;
    // Built-in themes are named by their translated title, not their stored profile name.
    const displayName = builtInDefinition ? t(builtInDefinition.translationKey) : profile?.name;
    const json = React.useMemo(() => (read.document ? exportThemeProfileToJson(read.document, { mode: resolveExportMode(read.document.profile), includeResolvedValues: true }) : ''), [read.document]);
    const fileName = React.useMemo(() => (profile ? `happier-theme-${sanitizeDownloadName(profile.name)}.json` : 'happier-theme.json'), [profile]);

    const copy = React.useCallback(async () => {
        if (!json) return;
        const copied = await writeClipboard(json);
        if (copied) {
            copyFeedback.markCopied('theme-profile');
        }
    }, [copyFeedback, json, writeClipboard]);

    const download = React.useCallback(async () => {
        if (!json) return;
        await exportThemeProfileFile(fileName, json);
    }, [fileName, json]);

    return (
        <ItemList testID="settings-theme-profile-export-screen" style={{ paddingTop: 0 }}>
            <SettingsPageHeader
                description={profile
                    ? t('settingsAppearance.themeProfiles.exportPageDescription')
                    : read.state === 'loading' ? t('common.loading')
                    : read.state === 'failed' ? t('common.error')
                    : t('settingsAppearance.themeProfiles.exportMissingDescription')}
                actions={profile ? (
                    <View style={styles.headerActions}>
                        <CopiedPill
                            visible={copyFeedback.isCopied('theme-profile')}
                            testID="settings-theme-profile-export-copy-feedback"
                        />
                        <RoundButton
                            testID="settings-theme-profile-export-download"
                            display="inverted"
                            title={t('settingsAppearance.themeProfiles.downloadExportJson')}
                            onPress={() => { void download(); }}
                        />
                        <RoundButton
                            testID="settings-theme-profile-export-copy"
                            title={t('settingsAppearance.themeProfiles.copyExportJson')}
                            disabled={!json}
                            onPress={() => { void copy(); }}
                        />
                    </View>
                ) : read.state === 'failed' ? (
                    <RoundButton title={t('common.retry')} onPress={read.retry} />
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
