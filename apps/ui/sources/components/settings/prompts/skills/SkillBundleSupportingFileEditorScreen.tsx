import * as React from 'react';
import { View } from 'react-native';
import { useNavigation, useRouter } from '@/components/appShell/workspace/destinationRoute';
import { StyleSheet } from 'react-native-unistyles';

import type { CodeEditorHandle } from '@/components/ui/code/editor/codeEditorTypes';
import { MarkdownCodeEditorField } from '@/components/ui/markdown/editor/MarkdownCodeEditorField';
import { useSetting } from '@/sync/domains/state/storage';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { SectionContentRow } from '@/components/ui/lists/SectionContentRow';
import { PageHeader } from '@/components/ui/layout/PageHeader';
import { Modal } from '@/modal';
import { updateSkillPromptBundleWithEntry, readPromptBundleUtf8Entry } from '@/sync/ops/promptLibrary/promptBundles';
import { t } from '@/text';
import { safeRouterBack } from '@/utils/navigation/safeRouterBack';
import { captureLazyActionAccountContext, type LazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { createUiPromptLibraryArtifactStore } from '@/sync/ops/promptLibrary/promptLibraryArtifactStore';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import { promptCollectionItemHref } from '@/components/settings/prompts/collection/promptCollectionModel';

import { readSkillBundleArtifactState, type SkillBundleArtifactState } from './readSkillBundleArtifactState';

const styles = StyleSheet.create((theme) => ({
    editorContainer: {
        borderRadius: 10,
        overflow: 'hidden',
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        minHeight: 320,
    },
}));

/** One file of a skill bundle beside its SKILL.md: its path and its text. Saving returns to the skill. */
export const SkillBundleSupportingFileEditorScreen = React.memo(function SkillBundleSupportingFileEditorScreen(props: Readonly<{
    artifactId: string;
    path: string | null;
    serverId?: string | null;
}>) {
    const router = useRouter();
    const navigation = useNavigation();
    const activeScope = useAccountSettingsScope();
    const targetServerId = props.serverId?.trim() || activeScope?.serverId;
    const targetActiveAccountId = targetServerId === activeScope?.serverId ? activeScope?.accountId : undefined;
    const accountRef = React.useRef<LazyActionAccountContext | null>(null);
    const [artifactState, setArtifactState] = React.useState<SkillBundleArtifactState | null>(null);
    const [path, setPath] = React.useState(props.path ?? '');
    const [content, setContent] = React.useState('');
    const [saving, setSaving] = React.useState(false);
    const wrapLinesInDiffs = useSetting('wrapLinesInDiffs');
    // Flushed before reading `content` on save so the latest rich/raw edit (which
    // may still be debounced inside the active editor surface) is captured.
    const editorRef = React.useRef<CodeEditorHandle | null>(null);

    React.useEffect(() => {
        let cancelled = false;
        const controller = new AbortController();
        let context: LazyActionAccountContext | null = null;
        let retirement: Readonly<{ dispose(): void }> | null = null;
        accountRef.current = null;
        setArtifactState(null);
        setPath(props.path ?? '');
        setContent('');
        void (async () => {
            try {
                if (!targetServerId) throw new Error('action_home_not_found');
                context = await captureLazyActionAccountContext(targetServerId, controller.signal);
                if (cancelled) { context.dispose(); return; }
                accountRef.current = context;
                retirement = context.accountLifetime.onRetire(() => {
                    if (cancelled) return;
                    accountRef.current = null; setArtifactState(null); setContent(''); setPath('');
                });
                context.assertCurrent();
                const artifact = await createUiPromptLibraryArtifactStore(context.workflowArtifacts, context)
                    .read(props.artifactId, { signal: controller.signal });
                const admitted = readSkillBundleArtifactState(artifact);
                context.assertCurrent();
                if (cancelled) return;
                if (!admitted) throw new Error('prompt_bundle_invalid_body');
                setArtifactState(admitted);
                setContent(props.path ? readPromptBundleUtf8Entry(admitted.body, props.path) ?? '' : '');
            } catch {
                if (!cancelled) { accountRef.current = null; setArtifactState(null); }
            }
        })();
        return () => {
            cancelled = true; controller.abort(); retirement?.dispose(); context?.dispose();
        };
    }, [props.artifactId, props.path, targetServerId, targetActiveAccountId]);

    const canSave = Boolean(artifactState) && path.trim().length > 0 && !saving;

    const save = React.useCallback(async () => {
        if (!artifactState || !canSave) return;
        const account = accountRef.current;
        try {
            setSaving(true);
            if (!account) throw new Error('action_account_scope_changed');
            account.assertCurrent();
            // Flush any debounced edit out of the active editor surface, then read
            // the freshest content from its handle (state may not have caught up).
            await editorRef.current?.flushPendingChange();
            const latestContent = editorRef.current?.getValue() ?? content;
            account.assertCurrent();
            await updateSkillPromptBundleWithEntry({
                artifactId: props.artifactId,
                path: path.trim(),
                content: latestContent,
                expectedRevision: artifactState.artifact.revision,
            }, createUiPromptLibraryArtifactStore(account.workflowArtifacts, account));
            account.assertCurrent();
            if (accountRef.current !== account) throw new Error('action_account_scope_changed');
            safeRouterBack({ router, navigation, fallbackHref: promptCollectionItemHref('bundle', props.artifactId, { serverId: account.serverId }) });
        } catch {
            Modal.alert(t('common.error'), t('promptLibrary.saveError'));
        } finally {
            setSaving(false);
        }
    }, [artifactState, canSave, content, navigation, path, props.artifactId, router]);

    return (
        <ItemList keyboardShouldPersistTaps="handled">
            <PageHeader
                testID="skillSupportingFile.header"
                alwaysShowTitle
                title={props.path ?? t('promptLibrary.newSupportingFile')}
                description={artifactState?.title
                    ? t('promptLibrary.surface.supportingFileDescription', { skill: artifactState.title })
                    : undefined}
                primaryAction={{
                    testID: 'skillSupportingFile.save',
                    title: t('common.save'),
                    disabled: !canSave,
                    loading: saving,
                    onPress: save,
                }}
            />

            <ItemGroup title={t('promptLibrary.surface.fileSection')}>
                <Item
                    title={t('promptLibrary.supportingFilePathLabel')}
                    subtitle={t('promptLibrary.surface.filePathDescription')}
                    accessoryLayout="adaptive"
                    showChevron={false}
                    rightElement={(
                        <FieldTextInput
                            testID="skillSupportingFile.path"
                            value={path}
                            onChangeText={setPath}
                            accessibilityLabel={t('promptLibrary.supportingFilePathLabel')}
                            placeholder={t('promptLibrary.supportingFilePathPlaceholder')}
                            autoCapitalize="none"
                            autoFocus={!props.path}
                            monospace
                            editable={artifactState !== null}
                        />
                    )}
                />
            </ItemGroup>

            <ItemGroup title={t('promptLibrary.supportingFileContent')}>
                <SectionContentRow>
                    <View style={styles.editorContainer}>
                        <MarkdownCodeEditorField
                            resetKey={`${props.artifactId}:${props.path ?? 'new'}`}
                            testID="skillSupportingFile.editor"
                            value={content}
                            filePath={path}
                            onChange={setContent}
                            readOnly={artifactState === null}
                            editorRef={editorRef}
                            wrapLines={wrapLinesInDiffs !== false}
                        />
                    </View>
                </SectionContentRow>
            </ItemGroup>
        </ItemList>
    );
});
