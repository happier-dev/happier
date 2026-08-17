import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useNavigation, useRouter } from 'expo-router';
import { useFocusEffect } from '@react-navigation/native';

import { t } from '@/text';
import { useLayoutMaxWidthStyle } from '@/components/ui/layout/layout';
import { sync } from '@/sync/sync';
import { storage, useSetting, useSettingMutable } from '@/sync/domains/state/storage';
import type { CodeEditorHandle } from '@/components/ui/code/editor/codeEditorTypes';
import { MarkdownCodeEditorField } from '@/components/ui/markdown/editor/MarkdownCodeEditorField';
import { SETTINGS_TEXT_INPUT_METRICS } from '@/components/ui/forms/settingsTextInputMetrics';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { ItemRowActions } from '@/components/ui/lists/ItemRowActions';
import type { ItemAction } from '@/components/ui/lists/itemActions';
import { SettingsActionFooter } from '@/components/ui/settingsSurface/SettingsActionFooter';
import { Text, TextInput } from '@/components/ui/text/Text';
import { Modal } from '@/modal';
import {
  DEFAULT_SKILL_PROMPT_MARKDOWN,
  createSkillPromptBundle,
  hasSkillPromptMarkdownContent,
  listPromptBundleSupportingEntries,
  removeSkillPromptBundleEntry,
  readSkillMarkdownFromPromptBundleBody,
  updateSkillPromptBundle,
} from '@/sync/ops/promptLibrary/promptBundles';
import { safeRouterBack } from '@/utils/navigation/safeRouterBack';
import { PromptExternalLinksGroup } from '@/components/settings/prompts/shared/PromptExternalLinksGroup';
import { PromptOrganizationFields } from '@/components/settings/prompts/shared/PromptOrganizationFields';
import { usePromptEditorDraftField } from '@/components/settings/prompts/shared/usePromptEditorDraftField';
import { readSkillBundleArtifactState } from '@/components/settings/prompts/skills/readSkillBundleArtifactState';
import { ensurePromptFolderByName, findPromptFolderById, formatPromptTags, normalizePromptTags } from '@/sync/ops/promptLibrary/promptFolders';

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
  titleInput: {
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
    minHeight: 360,
  },
}));

export const SkillBundleEditorScreen = React.memo((props: Readonly<{ artifactId: string | null }>) => {
  // Composed at render time: the module-scope stylesheet evaluates once, so a
  // baked-in `layout.maxWidth` would freeze the user's content-width preference.
  const contentMaxWidthStyle = useLayoutMaxWidthStyle();
  const contentStyle = React.useMemo(() => [styles.content, contentMaxWidthStyle], [contentMaxWidthStyle]);
  const { theme } = useUnistyles();
  const router = useRouter();
  const navigation = useNavigation();
  const [promptFoldersV1, setPromptFoldersV1] = useSettingMutable('promptFoldersV1');
  const wrapLinesInDiffs = useSetting('wrapLinesInDiffs');
  const savedArtifactId = props.artifactId;
  const [isLoading, setIsLoading] = React.useState<boolean>(Boolean(props.artifactId));
  const {
    value: title,
    setValue: setTitle,
    setPristineValue: setPristineTitle,
    applyExternalValue: applyExternalTitle,
  } = usePromptEditorDraftField('');
  const {
    value: skillMarkdown,
    setValue: setSkillMarkdown,
    setPristineValue: setPristineSkillMarkdown,
    applyExternalValue: applyExternalSkillMarkdown,
  } = usePromptEditorDraftField(DEFAULT_SKILL_PROMPT_MARKDOWN);
  const {
    value: folderName,
    setValue: setFolderName,
    setPristineValue: setPristineFolderName,
    applyExternalValue: applyExternalFolderName,
  } = usePromptEditorDraftField('');
  const {
    value: tagsText,
    setValue: setTagsText,
    setPristineValue: setPristineTagsText,
    applyExternalValue: applyExternalTagsText,
  } = usePromptEditorDraftField('');
  const [saving, setSaving] = React.useState(false);
  const [supportingFiles, setSupportingFiles] = React.useState<Array<{ path: string; contentKind: 'utf8' | 'binary' }>>([]);
  // Flushed before reading `skillMarkdown` on save so the latest rich/raw edit
  // (which may still be debounced inside the active editor surface) is captured.
  const editorRef = React.useRef<CodeEditorHandle | null>(null);
  const promptFoldersRef = React.useRef(promptFoldersV1);
  promptFoldersRef.current = promptFoldersV1;
  const loadedArtifactIdRef = React.useRef<string | null>(null);

  const applyArtifactState = React.useCallback((artifactId: string, options?: Readonly<{
    preserveDirtyFields?: boolean;
  }>) => {
    const artifactState = readSkillBundleArtifactState(artifactId);
    if (!artifactState) {
      setSupportingFiles([]);
      return false;
    }

    const preserveDirtyFields = options?.preserveDirtyFields === true;
    const nextSkillMarkdown = readSkillMarkdownFromPromptBundleBody(artifactState.body) ?? '';
    const nextSupportingFiles = listPromptBundleSupportingEntries(artifactState.body).map((entry) => ({
      path: entry.path,
      contentKind: entry.contentKind,
    }));
    const nextFolderName = findPromptFolderById(promptFoldersRef.current, artifactState.folderId)?.name ?? '';
    const nextTagsText = formatPromptTags(artifactState.tags);

    setSupportingFiles(nextSupportingFiles);
    if (preserveDirtyFields) {
      applyExternalTitle(artifactState.title, { preserveDirty: true });
      applyExternalSkillMarkdown(nextSkillMarkdown, { preserveDirty: true });
      applyExternalFolderName(nextFolderName, { preserveDirty: true });
      applyExternalTagsText(nextTagsText, { preserveDirty: true });
    } else {
      setPristineTitle(artifactState.title);
      setPristineSkillMarkdown(nextSkillMarkdown);
      setPristineFolderName(nextFolderName);
      setPristineTagsText(nextTagsText);
    }
    loadedArtifactIdRef.current = artifactId;
    return true;
  }, [applyExternalFolderName, applyExternalSkillMarkdown, applyExternalTagsText, applyExternalTitle, setPristineFolderName, setPristineSkillMarkdown, setPristineTagsText, setPristineTitle]);

  const loadArtifact = React.useCallback(async (artifactId: string, options?: Readonly<{
    preserveDirtyFields?: boolean;
  }>) => {
    setIsLoading(true);
    const local = storage.getState().artifacts[artifactId] ?? null;
    if (local?.body === undefined) {
      const credentials = sync.getCredentials();
      if (!credentials) throw new Error('Not authenticated');
      const full = await sync.fetchArtifactWithBody(artifactId);
      if (full) storage.getState().updateArtifact(full);
    }

    return applyArtifactState(artifactId, options);
  }, [applyArtifactState]);

  React.useEffect(() => {
    if (!savedArtifactId) {
      setIsLoading(false);
      setSupportingFiles([]);
      loadedArtifactIdRef.current = null;
      setPristineTitle('');
      setPristineSkillMarkdown(DEFAULT_SKILL_PROMPT_MARKDOWN);
      setPristineFolderName('');
      setPristineTagsText('');
      return;
    }

    let cancelled = false;

    (async () => {
      try {
        const loaded = await loadArtifact(savedArtifactId);
        if (!cancelled && loaded) {
          setIsLoading(false);
        }
      } catch {
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [loadArtifact, savedArtifactId, setPristineFolderName, setPristineSkillMarkdown, setPristineTagsText, setPristineTitle]);

  useFocusEffect(
    React.useCallback(() => {
      if (!savedArtifactId) return undefined;
      let cancelled = false;
      void (async () => {
        try {
          const loaded = await loadArtifact(savedArtifactId, { preserveDirtyFields: loadedArtifactIdRef.current === savedArtifactId });
          if (!cancelled && loaded) {
            setIsLoading(false);
          }
        } catch {
        }
      })();
      return () => {
        cancelled = true;
      };
    }, [loadArtifact, savedArtifactId]),
  );

  React.useEffect(() => {
    if (!savedArtifactId || loadedArtifactIdRef.current !== savedArtifactId) return;
    applyArtifactState(savedArtifactId, { preserveDirtyFields: true });
  }, [applyArtifactState, promptFoldersV1, savedArtifactId]);

  const canSave = title.trim().length > 0 && hasSkillPromptMarkdownContent(skillMarkdown) && !saving;

  const save = React.useCallback(async () => {
    if (!canSave) return;

    try {
      setSaving(true);
      // Flush any debounced edit out of the active editor surface, then read the
      // freshest skill markdown from its handle (state may not have caught up yet).
      await editorRef.current?.flushPendingChange();
      const latestSkillMarkdown = editorRef.current?.getValue() ?? skillMarkdown;
      const ensuredFolder = ensurePromptFolderByName(promptFoldersV1, folderName);
      if (ensuredFolder.promptFoldersV1 !== promptFoldersV1) {
        setPromptFoldersV1(ensuredFolder.promptFoldersV1);
      }
      const tags = normalizePromptTags(tagsText);
      if (!props.artifactId) {
        await createSkillPromptBundle({ title: title.trim(), skillMarkdown: latestSkillMarkdown, folderId: ensuredFolder.folderId, tags });
      } else {
        await updateSkillPromptBundle({ artifactId: props.artifactId, title: title.trim(), skillMarkdown: latestSkillMarkdown, folderId: ensuredFolder.folderId, tags });
      }
      safeRouterBack({ router, navigation, fallbackHref: '/settings/prompts/skills' });
    } catch (err) {
      Modal.alert(t('common.error'), t('promptLibrary.saveError'));
    } finally {
      setSaving(false);
    }
  }, [canSave, folderName, navigation, promptFoldersV1, props.artifactId, router, setPromptFoldersV1, skillMarkdown, tagsText, title]);

  const removeSupportingFile = React.useCallback((path: string) => {
    if (!savedArtifactId) return;

    Modal.alert(
      t('promptLibrary.deleteSupportingFileTitle'),
      t('promptLibrary.deleteSupportingFileConfirm'),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('common.delete'),
          style: 'destructive',
          onPress: () => {
            void (async () => {
              try {
                await removeSkillPromptBundleEntry({
                  artifactId: savedArtifactId,
                  path,
                });
                setSupportingFiles((current) => current.filter((entry) => entry.path !== path));
              } catch {
                Modal.alert(t('common.error'), t('promptLibrary.saveError'));
              }
            })();
          },
        },
      ],
    );
  }, [savedArtifactId]);

  return (
    <View style={styles.container}>
      <ItemList containerStyle={contentStyle} keyboardShouldPersistTaps="handled">
        <ItemGroup title={t('promptLibrary.general')}>
          <View style={{ paddingHorizontal: 16, paddingTop: 12 }}>
            <Text style={styles.fieldLabel}>{t('promptLibrary.skillNameLabel')}</Text>
            <TextInput
              testID="skillBundle.title"
              placeholder={t('promptLibrary.titlePlaceholder')}
              placeholderTextColor={theme.colors.input.placeholder}
              value={title}
              onChangeText={setTitle}
              style={styles.titleInput}
              editable={!isLoading}
            />
          </View>
          <PromptOrganizationFields
            folderName={folderName}
            onChangeFolderName={setFolderName}
            tags={tagsText}
            onChangeTags={setTagsText}
            folderTestID="skillBundle.folderName"
            tagsTestID="skillBundle.tags"
            editable={!isLoading}
          />
        </ItemGroup>

        <ItemGroup title={t('promptLibrary.skillContent')}>
          <View style={{ padding: 12 }}>
            <View style={styles.editorContainer}>
              <MarkdownCodeEditorField
                resetKey={props.artifactId ?? 'new'}
                testID="skillBundle.editor"
                value={skillMarkdown}
                filePath="SKILL.md"
                onChange={setSkillMarkdown}
                readOnly={isLoading}
                editorRef={editorRef}
                wrapLines={wrapLinesInDiffs !== false}
              />
            </View>
          </View>
        </ItemGroup>

        <ItemGroup title={t('promptLibrary.supportingFiles')}>
          {savedArtifactId ? (
            supportingFiles.length > 0 ? supportingFiles.map((entry, index) => (
              (() => {
                const editPath = `/settings/prompts/skills/${savedArtifactId}/files/edit?path=${encodeURIComponent(entry.path)}`;
                const actions: ItemAction[] = [];
                if (entry.contentKind === 'utf8') {
                  actions.push({
                    id: 'edit',
                    title: t('common.edit'),
                    icon: 'pencil',
                    onPress: () => router.push(editPath),
                  });
                }
                actions.push({
                  id: 'delete',
                  title: t('common.delete'),
                  icon: 'trash',
                  destructive: true,
                  onPress: () => removeSupportingFile(entry.path),
                });

                return (
                  <Item
                    key={entry.path}
                    testID={`skillBundle.supportingFile.${index}`}
                    title={entry.path}
                    subtitle={entry.contentKind === 'binary'
                      ? t('promptLibrary.supportingFileBinarySubtitle')
                      : t('promptLibrary.supportingFileTextSubtitle')}
                    onPress={entry.contentKind === 'utf8' ? () => router.push(editPath) : undefined}
                    rightElement={(
                      <ItemRowActions
                        title={entry.path}
                        compactActionIds={entry.contentKind === 'utf8' ? ['edit', 'delete'] : ['delete']}
                        actions={actions}
                      />
                    )}
                  />
                );
              })()
            )) : (
              <Item
                testID="skillBundle.supportingFilesEmpty"
                title={t('promptLibrary.supportingFilesEmptyTitle')}
                subtitle={t('promptLibrary.supportingFilesEmptySubtitle')}
                showChevron={false}
              />
            )
          ) : (
            <Item
              testID="skillBundle.supportingFilesSaveFirst"
              title={t('promptLibrary.supportingFilesSaveFirstTitle')}
              subtitle={t('promptLibrary.supportingFilesSaveFirstSubtitle')}
              showChevron={false}
            />
          )}
        </ItemGroup>

        {savedArtifactId ? (
          <ItemGroup>
            <Item
              testID="skillBundle.addSupportingFile"
              title={t('promptLibrary.addSupportingFile')}
              subtitle={t('promptLibrary.addSupportingFileSubtitle')}
              onPress={() => router.push(`/settings/prompts/skills/${savedArtifactId}/files/new`)}
            />
          </ItemGroup>
        ) : null}

        <PromptExternalLinksGroup
          artifactId={props.artifactId}
          libraryKind="bundle"
          manageItemTestID="skillBundle.manageExternalAssets"
          manageItemSubtitle={t('promptLibrary.externalAssetsSubtitle')}
          linkTestIDPrefix="skillBundle.link"
        />

        <SettingsActionFooter
          primaryLabel={t('common.save')}
          onPrimaryPress={() => { void save(); }}
          primaryDisabled={!canSave}
          primaryTestID="skillBundle.save"
          secondaryLabel={t('common.cancel')}
          onSecondaryPress={() => safeRouterBack({ router, navigation, fallbackHref: '/settings/prompts/skills' })}
          secondaryTestID="skillBundle.cancel"
        />
      </ItemList>
    </View>
  );
});

SkillBundleEditorScreen.displayName = 'SkillBundleEditorScreen';
