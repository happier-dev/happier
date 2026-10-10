import * as React from 'react';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { File } from 'expo-file-system';
import { useUnistyles } from 'react-native-unistyles';

import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { Item } from '@/components/ui/lists/Item';
import { SectionContentRow } from '@/components/ui/lists/SectionContentRow';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { useLocalSettingMutable } from '@/sync/domains/state/storage';
import { t } from '@/text';
import { getSupportedThemeProfileImportFormats, importThemeProfileFromJson } from '@/theme/profiles/themeProfileImportExport';
import { nativePickFiles, type NativePickedFile } from '@/utils/files/nativePickFiles';
import { nowThemeProfileTimestamp, upsertThemeProfile } from './themeProfileScreenUtils';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { SettingsPageHeader } from '@/components/settings/shell/SettingsPageHeader';

async function readPickedThemeFile(entry: NativePickedFile): Promise<string> {
    if (entry.kind === 'web') {
        return await entry.file.text();
    }

    return await new File(entry.uri).text();
}

export const ThemeProfileImportScreen = React.memo(function ThemeProfileImportScreen() {
    const { theme } = useUnistyles();
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
        <ItemList testID="settings-theme-profile-import-screen" style={{ paddingTop: 0 }} keyboardShouldPersistTaps="handled">
            <SettingsPageHeader
                description={t('settingsAppearance.themeProfiles.importPageDescription')}
                primaryAction={{
                    testID: 'settings-theme-profile-import-submit',
                    title: t('settingsAppearance.themeProfiles.importAction'),
                    disabled: json.trim().length === 0,
                    onPress: submit,
                }}
            />
            <ItemGroup
                title={t('settingsAppearance.themeProfiles.importJson')}
                description={t('settingsAppearance.themeProfiles.importFooter', { formats: supportedImportFormats })}
                action={(
                    <RoundButton
                        testID="settings-theme-profile-import-file"
                        size="small"
                        display="inverted"
                        title={t('settingsAppearance.themeProfiles.importFile')}
                        leading={<Icon name="file-arrow-up" size={ICON_SIZE.sm} color={theme.colors.text.secondary} />}
                        textStyle={{ color: theme.colors.text.secondary }}
                        onPress={() => { void pickFile(); }}
                    />
                )}
            >
                <SectionContentRow>
                    <FieldTextInput
                        testID="settings-theme-profile-import-json"
                        value={json}
                        onChangeText={setJson}
                        accessibilityLabel={t('settingsAppearance.themeProfiles.importJson')}
                        placeholder={t('settingsAppearance.themeProfiles.importJsonPlaceholder')}
                        multiline
                        minLines={10}
                        monospace
                        error={error}
                    />
                </SectionContentRow>
                {warnings > 0 ? (
                    <Item
                        testID="settings-theme-profile-import-warnings"
                        title={t('settingsAppearance.themeProfiles.importedWithWarnings')}
                        subtitle={t('settingsAppearance.themeProfiles.importWarnings', { count: warnings })}
                        subtitleLines={0}
                        showChevron={false}
                        rightElement={(
                            <RoundButton
                                testID="settings-theme-profile-import-done"
                                size="small"
                                display="inverted"
                                title={t('common.done')}
                                onPress={() => router.back()}
                            />
                        )}
                    />
                ) : null}
            </ItemGroup>
        </ItemList>
    );
});
