import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useNavigation, useRouter } from 'expo-router';

import { PromptDocBodyV1Schema } from '@happier-dev/protocol';

import { t } from '@/text';
import { layout } from '@/components/ui/layout/layout';
import { sync } from '@/sync/sync';
import { storage, useSetting, useSettingMutable } from '@/sync/domains/state/storage';
import type { CodeEditorHandle } from '@/components/ui/code/editor/codeEditorTypes';
import { MarkdownCodeEditorField } from '@/components/ui/markdown/editor/MarkdownCodeEditorField';
import { SETTINGS_TEXT_INPUT_METRICS } from '@/components/ui/forms/settingsTextInputMetrics';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { SettingsActionFooter } from '@/components/ui/settingsSurface/SettingsActionFooter';
import { Text, TextInput } from '@/components/ui/text/Text';
import { Modal } from '@/modal';
import { createPromptDoc, updatePromptDoc } from '@/sync/ops/promptLibrary/promptDocs';
import { safeRouterBack } from '@/utils/navigation/safeRouterBack';
import { PromptExternalLinksGroup } from '@/components/settings/prompts/shared/PromptExternalLinksGroup';
import { PromptOrganizationFields } from '@/components/settings/prompts/shared/PromptOrganizationFields';
import { ensurePromptFolderByName, findPromptFolderById, formatPromptTags, normalizePromptTags } from '@/sync/ops/promptLibrary/promptFolders';

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.background.canvas,
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

export const PromptDocEditorScreen = React.memo((props: Readonly<{ artifactId: string | null }>) => {
  const { theme } = useUnistyles();
  const router = useRouter();
  const navigation = useNavigation();
  const [promptFoldersV1, setPromptFoldersV1] = useSettingMutable('promptFoldersV1');
  const wrapLinesInDiffs = useSetting('wrapLinesInDiffs');
  const [isLoading, setIsLoading] = React.useState<boolean>(Boolean(props.artifactId));
  const [title, setTitle] = React.useState('');
  const [markdown, setMarkdown] = React.useState('');
  const [folderName, setFolderName] = React.useState('');
  const [tagsText, setTagsText] = React.useState('');
  const [saving, setSaving] = React.useState(false);
  // Flushed before reading `markdown` on save so the latest rich/raw edit (which
  // may still be debounced inside the active editor surface) is captured.
  const editorRef = React.useRef<CodeEditorHandle | null>(null);

  React.useEffect(() => {
    if (!props.artifactId) {
      setIsLoading(false);
      return;
    }

    let cancelled = false;

    (async () => {
      try {
        const local = storage.getState().artifacts[props.artifactId!] ?? null;
        if (local?.body === undefined) {
          const credentials = sync.getCredentials();
          if (!credentials) throw new Error('Not authenticated');
          const full = await sync.fetchArtifactWithBody(props.artifactId!);
          if (full) storage.getState().updateArtifact(full);
        }

        const next = storage.getState().artifacts[props.artifactId!] ?? null;
        const headerTitle = typeof next?.header?.title === 'string' ? next.header.title : next?.title;
        const headerFolder = findPromptFolderById(
          promptFoldersV1,
          typeof next?.header?.folderId === 'string' ? next.header.folderId : null,
        );
        const headerTags = Array.isArray(next?.header?.tags)
          ? next.header.tags.filter((tag): tag is string => typeof tag === 'string')
          : [];
        if (!cancelled) {
          setTitle(headerTitle ?? '');
          setFolderName(headerFolder?.name ?? '');
          setTagsText(formatPromptTags(headerTags));
          const bodyText = typeof next?.body === 'string' ? next.body : null;
          if (bodyText) {
            const parsed = PromptDocBodyV1Schema.safeParse(JSON.parse(bodyText));
            setMarkdown(parsed.success ? parsed.data.markdown : '');
          } else {
            setMarkdown('');
          }
        }
      } catch (err) {
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [promptFoldersV1, props.artifactId]);

  const canSave = title.trim().length > 0 && !saving;

  const save = React.useCallback(async () => {
    if (!canSave) return;

    try {
      setSaving(true);
      // Flush any debounced edit out of the active editor surface, then read the
      // freshest markdown from its handle (state may not have caught up yet).
      await editorRef.current?.flushPendingChange();
      const latestMarkdown = editorRef.current?.getValue() ?? markdown;
      const ensuredFolder = ensurePromptFolderByName(promptFoldersV1, folderName);
      if (ensuredFolder.promptFoldersV1 !== promptFoldersV1) {
        setPromptFoldersV1(ensuredFolder.promptFoldersV1);
      }
      const tags = normalizePromptTags(tagsText);
      if (!props.artifactId) {
        await createPromptDoc({ title: title.trim(), markdown: latestMarkdown, folderId: ensuredFolder.folderId, tags });
      } else {
        await updatePromptDoc({ artifactId: props.artifactId, title: title.trim(), markdown: latestMarkdown, folderId: ensuredFolder.folderId, tags });
      }
      safeRouterBack({ router, navigation, fallbackHref: '/settings/prompts/docs' });
    } catch (err) {
      Modal.alert(t('common.error'), t('promptLibrary.saveError'));
    } finally {
      setSaving(false);
    }
  }, [canSave, folderName, markdown, navigation, promptFoldersV1, props.artifactId, router, setPromptFoldersV1, tagsText, title]);

  return (
    <View style={styles.container}>
      <ItemList containerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <ItemGroup title={t('promptLibrary.general')}>
          <View style={{ paddingHorizontal: 16, paddingTop: 12 }}>
            <Text style={styles.fieldLabel}>{t('promptLibrary.promptNameLabel')}</Text>
            <TextInput
              testID="promptDoc.title"
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
            folderTestID="promptDoc.folderName"
            tagsTestID="promptDoc.tags"
            editable={!isLoading}
          />
        </ItemGroup>

        <ItemGroup title={t('promptLibrary.promptContent')}>
          <View style={{ padding: 12 }}>
            <View style={styles.editorContainer}>
              <MarkdownCodeEditorField
                resetKey={props.artifactId ?? 'new'}
                testID="promptDoc.editor"
                value={markdown}
                language="markdown"
                onChange={setMarkdown}
                readOnly={isLoading}
                editorRef={editorRef}
                wrapLines={wrapLinesInDiffs !== false}
              />
            </View>
          </View>
        </ItemGroup>

        <PromptExternalLinksGroup
          artifactId={props.artifactId}
          libraryKind="doc"
          manageItemTestID="promptDoc.manageExternalAssets"
          manageItemSubtitle={t('promptLibrary.externalAssetsSubtitle')}
          linkTestIDPrefix="promptDoc.link"
        />

        <SettingsActionFooter
          primaryLabel={t('common.save')}
          onPrimaryPress={() => { void save(); }}
          primaryDisabled={!canSave}
          primaryTestID="promptDoc.save"
          secondaryLabel={t('common.cancel')}
          onSecondaryPress={() => safeRouterBack({ router, navigation, fallbackHref: '/settings/prompts/docs' })}
          secondaryTestID="promptDoc.cancel"
        />
      </ItemList>
    </View>
  );
});

PromptDocEditorScreen.displayName = 'PromptDocEditorScreen';
