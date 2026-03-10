import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Stack, useNavigation, useRouter } from 'expo-router';
import { useFocusEffect } from '@react-navigation/native';

import { t } from '@/text';
import { layout } from '@/components/ui/layout/layout';
import { sync } from '@/sync/sync';
import { storage, useSettingMutable } from '@/sync/domains/state/storage';
import { CodeEditor } from '@/components/ui/code/editor/CodeEditor';
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
import { readSkillBundleArtifactState } from '@/components/settings/prompts/skills/readSkillBundleArtifactState';
import { ensurePromptFolderByName, findPromptFolderById, formatPromptTags, normalizePromptTags } from '@/sync/ops/promptLibrary/promptFolders';

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.groupped.background,
  },
  content: {
    padding: 16,
    paddingBottom: 64,
    maxWidth: layout.maxWidth,
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
    color: theme.colors.textSecondary,
    fontSize: 14,
    marginBottom: 8,
  },
  editorContainer: {
    borderRadius: 12,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: theme.colors.divider,
    minHeight: 360,
  },
}));

export const SkillBundleEditorScreen = React.memo((props: Readonly<{ artifactId: string | null }>) => {
  const { theme } = useUnistyles();
  const router = useRouter();
  const navigation = useNavigation();
  const [promptFoldersV1, setPromptFoldersV1] = useSettingMutable('promptFoldersV1');
  const savedArtifactId = props.artifactId;
  const [isLoading, setIsLoading] = React.useState<boolean>(Boolean(props.artifactId));
  const [title, setTitle] = React.useState('');
  const [skillMarkdown, setSkillMarkdown] = React.useState(DEFAULT_SKILL_PROMPT_MARKDOWN);
  const [folderName, setFolderName] = React.useState('');
  const [tagsText, setTagsText] = React.useState('');
  const [saving, setSaving] = React.useState(false);
  const [supportingFiles, setSupportingFiles] = React.useState<Array<{ path: string; contentKind: 'utf8' | 'binary' }>>([]);
  const isTitleDirtyRef = React.useRef(false);
  const isSkillMarkdownDirtyRef = React.useRef(false);
  const isFolderDirtyRef = React.useRef(false);
  const isTagsDirtyRef = React.useRef(false);

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
    const nextFolderName = findPromptFolderById(promptFoldersV1, artifactState.folderId)?.name ?? '';
    const nextTagsText = formatPromptTags(artifactState.tags);

    setSupportingFiles(nextSupportingFiles);
    setTitle((current) => (preserveDirtyFields && isTitleDirtyRef.current ? current : artifactState.title));
    setSkillMarkdown((current) => (preserveDirtyFields && isSkillMarkdownDirtyRef.current ? current : nextSkillMarkdown));
    setFolderName((current) => (preserveDirtyFields && isFolderDirtyRef.current ? current : nextFolderName));
    setTagsText((current) => (preserveDirtyFields && isTagsDirtyRef.current ? current : nextTagsText));
    return true;
  }, [promptFoldersV1]);

  const loadArtifact = React.useCallback(async (artifactId: string, options?: Readonly<{
    preserveDirtyFields?: boolean;
  }>) => {
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
      setTitle('');
      setSkillMarkdown(DEFAULT_SKILL_PROMPT_MARKDOWN);
      setFolderName('');
      setTagsText('');
      isTitleDirtyRef.current = false;
      isSkillMarkdownDirtyRef.current = false;
      isFolderDirtyRef.current = false;
      isTagsDirtyRef.current = false;
      return;
    }

    let cancelled = false;

    (async () => {
      try {
        await loadArtifact(savedArtifactId);
        if (!cancelled) {
          isTitleDirtyRef.current = false;
          isSkillMarkdownDirtyRef.current = false;
          isFolderDirtyRef.current = false;
          isTagsDirtyRef.current = false;
        }
      } catch {
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [loadArtifact, savedArtifactId]);

  useFocusEffect(
    React.useCallback(() => {
      if (!savedArtifactId) return undefined;
      let cancelled = false;
      void (async () => {
        try {
          await loadArtifact(savedArtifactId, { preserveDirtyFields: true });
        } catch {
        } finally {
          if (!cancelled) setIsLoading(false);
        }
      })();
      return () => {
        cancelled = true;
      };
    }, [loadArtifact, savedArtifactId]),
  );

  const canSave = title.trim().length > 0 && hasSkillPromptMarkdownContent(skillMarkdown) && !saving;

  const save = React.useCallback(async () => {
    if (!canSave) return;

    try {
      setSaving(true);
      const ensuredFolder = ensurePromptFolderByName(promptFoldersV1, folderName);
      if (ensuredFolder.promptFoldersV1 !== promptFoldersV1) {
        setPromptFoldersV1(ensuredFolder.promptFoldersV1);
      }
      const tags = normalizePromptTags(tagsText);
      if (!props.artifactId) {
        await createSkillPromptBundle({ title: title.trim(), skillMarkdown, folderId: ensuredFolder.folderId, tags });
      } else {
        await updateSkillPromptBundle({ artifactId: props.artifactId, title: title.trim(), skillMarkdown, folderId: ensuredFolder.folderId, tags });
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
      <Stack.Screen options={{ title: props.artifactId ? t('promptLibrary.editSkill') : t('promptLibrary.newSkill') }} />
      <ItemList containerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <ItemGroup title={t('promptLibrary.general')}>
          <View style={{ paddingHorizontal: 16, paddingTop: 12 }}>
            <Text style={styles.fieldLabel}>{t('promptLibrary.skillNameLabel')}</Text>
            <TextInput
              testID="skillBundle.title"
              placeholder={t('promptLibrary.titlePlaceholder')}
              placeholderTextColor={theme.colors.input.placeholder}
              value={title}
              onChangeText={(nextTitle) => {
                setTitle(nextTitle);
                isTitleDirtyRef.current = true;
              }}
              style={styles.titleInput}
              editable={!isLoading}
            />
          </View>
          <PromptOrganizationFields
            folderName={folderName}
            onChangeFolderName={(nextValue) => {
              setFolderName(nextValue);
              isFolderDirtyRef.current = true;
            }}
            tags={tagsText}
            onChangeTags={(nextValue) => {
              setTagsText(nextValue);
              isTagsDirtyRef.current = true;
            }}
            folderTestID="skillBundle.folderName"
            tagsTestID="skillBundle.tags"
            editable={!isLoading}
          />
        </ItemGroup>

        <ItemGroup title={t('promptLibrary.skillContent')}>
          <View style={{ padding: 12 }}>
            <View style={styles.editorContainer}>
              <CodeEditor
                resetKey={props.artifactId ?? 'new'}
                testID="skillBundle.editor"
                value={skillMarkdown}
                language="markdown"
                onChange={(nextValue) => {
                  setSkillMarkdown(nextValue);
                  isSkillMarkdownDirtyRef.current = true;
                }}
                readOnly={isLoading}
                wrapLines={true}
                showLineNumbers={false}
              />
            </View>
          </View>
        </ItemGroup>

        <ItemGroup title={t('promptLibrary.supportingFiles')}>
          {savedArtifactId ? (
            supportingFiles.length > 0 ? supportingFiles.map((entry, index) => (
              (() => {
                const editPath = `/(app)/settings/prompts/skills/${savedArtifactId}/files/edit?path=${encodeURIComponent(entry.path)}`;
                const actions: ItemAction[] = [];
                if (entry.contentKind === 'utf8') {
                  actions.push({
                    id: 'edit',
                    title: t('common.edit'),
                    icon: 'pencil-outline',
                    onPress: () => router.push(editPath),
                  });
                }
                actions.push({
                  id: 'delete',
                  title: t('common.delete'),
                  icon: 'trash-outline',
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
              onPress={() => router.push(`/(app)/settings/prompts/skills/${savedArtifactId}/files/new`)}
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
