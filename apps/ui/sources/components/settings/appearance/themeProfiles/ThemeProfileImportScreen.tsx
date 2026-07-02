import * as React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { File } from 'expo-file-system';
import { Pressable, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { StyleSheet } from 'react-native-unistyles';

import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { SettingsActionFooter } from '@/components/ui/settingsSurface/SettingsActionFooter';
import { Text, TextInput } from '@/components/ui/text/Text';
import { useLocalSettingMutable } from '@/sync/domains/state/storage';
import { t } from '@/text';
import { getSupportedThemeProfileImportFormats, importThemeProfileFromJson } from '@/theme/profiles/themeProfileImportExport';
import { nativePickFiles, type NativePickedFile } from '@/utils/files/nativePickFiles';
import { nowThemeProfileTimestamp, upsertThemeProfile } from './themeProfileScreenUtils';

async function readPickedThemeFile(entry: NativePickedFile): Promise<string> {
    if (entry.kind === 'web') {
        return await entry.file.text();
    }

    return await new File(entry.uri).text();
}

export const ThemeProfileImportScreen = React.memo(function ThemeProfileImportScreen() {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const router = useRouter();
    const [themeProfiles, setThemeProfiles] = useLocalSettingMutable('themeProfiles');
    const [json, setJson] = React.useState('');
    const [error, setError] = React.useState<string | null>(null);
    const [warnings, setWarnings] = React.useState(0);
    const supportedImportFormats = React.useMemo(
        () => getSupportedThemeProfileImportFormats().map((format) => format.label).join(', '),
        [],
    );

    const submit = React.useCallback(() => {
        const result = importThemeProfileFromJson(json, {
            now: nowThemeProfileTimestamp(),
            existingProfileIds: new Set(themeProfiles.profiles.map((profile) => profile.id)),
        });
        if (!result.ok) {
            setError(t(`settingsAppearance.themeProfiles.importErrors.${result.error}`));
            setWarnings(0);
            return;
        }
        setError(null);
        setWarnings(result.warnings.length);
        setThemeProfiles(upsertThemeProfile(themeProfiles, result.profile));
        if (result.warnings.length === 0) {
            router.back();
        }
    }, [json, router, setThemeProfiles, themeProfiles]);

    const pickFile = React.useCallback(async () => {
        try {
            const [picked] = await nativePickFiles({ multiple: false });
            if (!picked) return;
            setJson(await readPickedThemeFile(picked));
            setError(null);
            setWarnings(0);
        } catch {
            setError(t('settingsAppearance.themeProfiles.importErrors.invalidJson'));
            setWarnings(0);
        }
    }, []);

    return (
        <ItemList testID="settings-theme-profile-import-screen" style={{ paddingTop: 0 }}>
            <ItemGroup
                title={t('settingsAppearance.themeProfiles.importProfile')}
                footer={t('settingsAppearance.themeProfiles.importFooter', { formats: supportedImportFormats })}
            >
                <View style={styles.jsonEditorRow}>
                    <View style={styles.jsonEditorHeader}>
                        <View style={styles.jsonEditorTitle}>
                            <Ionicons name="code-slash-outline" size={28} color={theme.colors.accent.green} />
                            <Text style={styles.jsonEditorTitleText}>{t('settingsAppearance.themeProfiles.importJson')}</Text>
                        </View>
                        <Pressable
                            testID="settings-theme-profile-import-file"
                            accessibilityRole="button"
                            accessibilityLabel={t('settingsAppearance.themeProfiles.importFile')}
                            onPress={() => { void pickFile(); }}
                            style={({ pressed }) => [styles.fileButton, pressed ? styles.fileButtonPressed : null]}
                        >
                            <Ionicons name="document-attach-outline" size={18} color={theme.colors.text.primary} />
                            <Text style={styles.fileButtonText}>{t('settingsAppearance.themeProfiles.importFile')}</Text>
                        </Pressable>
                    </View>
                    <TextInput
                        testID="settings-theme-profile-import-json"
                        value={json}
                        onChangeText={setJson}
                        multiline
                        autoCapitalize="none"
                        autoCorrect={false}
                        placeholder={t('settingsAppearance.themeProfiles.importJsonPlaceholder')}
                        style={styles.jsonTextArea}
                    />
                </View>
                {error ? (
                    <Text testID="settings-theme-profile-import-error" style={{ color: theme.colors.state.danger.foreground, padding: 16 }}>
                        {error}
                    </Text>
                ) : null}
                {warnings > 0 ? (
                    <Text testID="settings-theme-profile-import-warnings" style={{ color: theme.colors.state.warning.foreground, padding: 16 }}>
                        {t('settingsAppearance.themeProfiles.importWarnings', { count: warnings })}
                    </Text>
                ) : null}
            </ItemGroup>
            <SettingsActionFooter
                primaryLabel={t('settingsAppearance.themeProfiles.importProfile')}
                primaryTestID="settings-theme-profile-import-submit"
                primaryDisabled={json.trim().length === 0}
                onPrimaryPress={submit}
            />
        </ItemList>
    );
});

const stylesheet = StyleSheet.create((theme) => ({
    jsonEditorRow: {
        gap: 12,
        paddingHorizontal: 16,
        paddingVertical: 16,
    },
    jsonEditorHeader: {
        alignItems: 'center',
        flexDirection: 'row',
        justifyContent: 'space-between',
        gap: 12,
    },
    jsonEditorTitle: {
        alignItems: 'center',
        flexDirection: 'row',
        gap: 12,
        minWidth: 0,
    },
    jsonEditorTitleText: {
        color: theme.colors.text.primary,
        fontSize: 16,
        fontWeight: '700',
    },
    fileButton: {
        alignItems: 'center',
        backgroundColor: theme.colors.surface.inset,
        borderColor: theme.colors.border.surface,
        borderRadius: 12,
        borderWidth: 1,
        flexDirection: 'row',
        gap: 8,
        minHeight: 40,
        paddingHorizontal: 12,
    },
    fileButtonPressed: {
        backgroundColor: theme.colors.surface.pressed,
    },
    fileButtonText: {
        color: theme.colors.text.primary,
        fontSize: 13,
        fontWeight: '700',
    },
    jsonTextArea: {
        backgroundColor: theme.colors.surface.inset,
        borderColor: theme.colors.border.surface,
        borderRadius: 14,
        borderWidth: 1,
        color: theme.colors.input.text,
        minHeight: 180,
        paddingHorizontal: 14,
        paddingVertical: 12,
        textAlignVertical: 'top',
        width: '100%',
    },
}));
