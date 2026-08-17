import * as React from 'react';
import { View } from 'react-native';
import { useNavigation, useRouter } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import type { CodeEditorHandle } from '@/components/ui/code/editor/codeEditorTypes';
import { MarkdownCodeEditorField } from '@/components/ui/markdown/editor/MarkdownCodeEditorField';
import { useSetting } from '@/sync/domains/state/storage';
import { SETTINGS_TEXT_INPUT_METRICS } from '@/components/ui/forms/settingsTextInputMetrics';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { useLayoutMaxWidthStyle } from '@/components/ui/layout/layout';
import { SettingsActionFooter } from '@/components/ui/settingsSurface/SettingsActionFooter';
import { Text, TextInput } from '@/components/ui/text/Text';
import { Modal } from '@/modal';
import { updateSkillPromptBundleWithEntry, readPromptBundleUtf8Entry } from '@/sync/ops/promptLibrary/promptBundles';
import { t } from '@/text';
import { safeRouterBack } from '@/utils/navigation/safeRouterBack';

import { readSkillBundleArtifactState } from './readSkillBundleArtifactState';

const styles = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        backgroundColor: theme.colors.background.canvas,
    },
    content: {
        padding: 16,
        paddingBottom: 64,
        width: '100%',
        alignSelf: 'center',
    },
    input: {
        backgroundColor: theme.colors.input.background,
        color: theme.colors.input.text,
        borderRadius: 10,
        paddingHorizontal: 12,
        paddingVertical: 10,
        ...SETTINGS_TEXT_INPUT_METRICS,
        marginBottom: 12,
    },
    fieldLabel: {
        color: theme.colors.text.secondary,
        fontSize: 14,
        marginBottom: 8,
    },
    editorContainer: {
        borderRadius: 12,
        overflow: 'hidden',
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        minHeight: 320,
    },
}));

export const SkillBundleSupportingFileEditorScreen = React.memo(function SkillBundleSupportingFileEditorScreen(props: Readonly<{
    artifactId: string;
    path: string | null;
}>) {
    // Composed at render time: the module-scope stylesheet evaluates once, so a
    // baked-in `layout.maxWidth` would freeze the user's content-width preference.
    const contentMaxWidthStyle = useLayoutMaxWidthStyle();
    const contentStyle = React.useMemo(() => [styles.content, contentMaxWidthStyle], [contentMaxWidthStyle]);
    const { theme } = useUnistyles();
    const router = useRouter();
    const navigation = useNavigation();
    const artifactState = React.useMemo(() => readSkillBundleArtifactState(props.artifactId), [props.artifactId]);
    const [path, setPath] = React.useState(props.path ?? '');
    const [content, setContent] = React.useState('');
    const [saving, setSaving] = React.useState(false);
    const wrapLinesInDiffs = useSetting('wrapLinesInDiffs');
    // Flushed before reading `content` on save so the latest rich/raw edit (which
    // may still be debounced inside the active editor surface) is captured.
    const editorRef = React.useRef<CodeEditorHandle | null>(null);

    React.useEffect(() => {
        setPath(props.path ?? '');
        if (!artifactState || !props.path) {
            setContent('');
            return;
        }
        setContent(readPromptBundleUtf8Entry(artifactState.body, props.path) ?? '');
    }, [artifactState, props.path]);

    const canSave = Boolean(artifactState) && path.trim().length > 0 && !saving;

    const save = React.useCallback(async () => {
        if (!artifactState || !canSave) return;
        try {
            setSaving(true);
            // Flush any debounced edit out of the active editor surface, then read
            // the freshest content from its handle (state may not have caught up).
            await editorRef.current?.flushPendingChange();
            const latestContent = editorRef.current?.getValue() ?? content;
            await updateSkillPromptBundleWithEntry({
                artifactId: props.artifactId,
                path: path.trim(),
                content: latestContent,
            });
            safeRouterBack({ router, navigation, fallbackHref: `/settings/prompts/skills/${props.artifactId}` });
        } catch {
            Modal.alert(t('common.error'), t('promptLibrary.saveError'));
        } finally {
            setSaving(false);
        }
    }, [artifactState, canSave, content, navigation, path, props.artifactId, router]);

    return (
        <View style={styles.container}>
            <ItemList containerStyle={contentStyle} keyboardShouldPersistTaps="handled">
                <ItemGroup title={t('promptLibrary.general')}>
                    <View style={{ paddingHorizontal: 16, paddingTop: 12 }}>
                        <Text style={styles.fieldLabel}>{t('promptLibrary.supportingFilePathLabel')}</Text>
                        <TextInput
                            testID="skillSupportingFile.path"
                            placeholder={t('promptLibrary.supportingFilePathPlaceholder')}
                            placeholderTextColor={theme.colors.input.placeholder}
                            value={path}
                            onChangeText={setPath}
                            style={styles.input}
                            autoCapitalize="none"
                            autoCorrect={false}
                        />
                    </View>
                </ItemGroup>

                <ItemGroup title={t('promptLibrary.supportingFileContent')}>
                    <View style={{ padding: 12 }}>
                        <View style={styles.editorContainer}>
                            <MarkdownCodeEditorField
                                resetKey={`${props.artifactId}:${props.path ?? 'new'}`}
                                testID="skillSupportingFile.editor"
                                value={content}
                                filePath={path}
                                onChange={setContent}
                                readOnly={false}
                                editorRef={editorRef}
                                wrapLines={wrapLinesInDiffs !== false}
                            />
                        </View>
                    </View>
                </ItemGroup>

                <SettingsActionFooter
                    primaryLabel={t('common.save')}
                    onPrimaryPress={() => { void save(); }}
                    primaryDisabled={!canSave}
                    primaryTestID="skillSupportingFile.save"
                    secondaryLabel={t('common.cancel')}
                    onSecondaryPress={() => safeRouterBack({ router, navigation, fallbackHref: `/settings/prompts/skills/${props.artifactId}` })}
                    secondaryTestID="skillSupportingFile.cancel"
                />
            </ItemList>
        </View>
    );
});
