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
import { useThemeActionExecution } from './useThemeActionExecution';
import { THEME_ACTION_IDS } from '@happier-dev/protocol/actions/themeActionIdsV1';
import { isActionApprovalDeclinedErrorCode, readActionErrorCodeV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { resolveActionExecutionErrorMessage } from '@/sync/ops/actions/resolveActionExecutionFailureMessage';
import { t } from '@/text';
import { getSupportedThemeProfileImportFormats, importThemeProfileFromJson } from '@/theme/profiles/themeProfileImportExport';
import { nativePickFiles, type NativePickedFile } from '@/utils/files/nativePickFiles';
import { nowThemeProfileTimestamp } from './themeProfileScreenUtils';
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
    const executeTheme = useThemeActionExecution();
    const [json, setJson] = React.useState('');
    const [pickedFiles, setPickedFiles] = React.useState<readonly NativePickedFile[]>([]);
    const pickedFile = pickedFiles[0];
    const [error, setError] = React.useState<string | null>(null);
    const [warnings, setWarnings] = React.useState(0);
    const supportedImportFormats = React.useMemo(
        () => getSupportedThemeProfileImportFormats().map((format) => format.label).join(', '),
        [],
    );

    const submit = React.useCallback(async () => {
        const result = await importThemeProfileFromJson(json, {
            now: nowThemeProfileTimestamp(),
            ...(pickedFile ? { resource: {
                id: pickedFile.kind === 'native' ? pickedFile.uri : new URL(pickedFile.file.webkitRelativePath || pickedFile.file.name, 'file:///selected/').href,
                read: async (relativePath: string, fromResourceId: string) => {
                    if (pickedFile.kind === 'web') {
                        const id = new URL(relativePath, fromResourceId).href;
                        const selected = pickedFiles.find(entry => entry.kind === 'web'
                            && new URL(entry.file.webkitRelativePath || entry.file.name, 'file:///selected/').href === id);
                        if (!selected) throw new Error('Included file was not selected');
                        return { id, text: await readPickedThemeFile(selected) };
                    }
                    const file = new File(new File(fromResourceId).parentDirectory, relativePath);
                    return { id: file.uri, text: await file.text() };
                },
            } } : {}),
        });
        if (!result.ok) {
            setError('resourceId' in result && result.error !== 'invalid_theme'
                ? t(`settingsAppearance.themeProfiles.importErrors.${result.error}`, { path: result.relativePath ?? result.resourceId })
                : t(`settingsAppearance.themeProfiles.importErrors.${result.error}`));
            setWarnings(0);
            return;
        }
        setError(null);
        try { await executeTheme(THEME_ACTION_IDS.save, { document: result.document }); }
        catch (error) {
            if (!isActionApprovalDeclinedErrorCode(readActionErrorCodeV1(error)))
                setError(resolveActionExecutionErrorMessage(error, t('common.requestFailed')));
            return;
        }
        setWarnings(result.warnings.length);
        if (result.warnings.length === 0) {
            router.back();
        }
    }, [executeTheme, json, pickedFile, pickedFiles, router]);

    const pickFile = React.useCallback(async () => {
        try {
            const files = await nativePickFiles({ multiple: true });
            const picked = files[0];
            if (!picked) return;
            setJson(await readPickedThemeFile(picked));
            setPickedFiles(files);
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
