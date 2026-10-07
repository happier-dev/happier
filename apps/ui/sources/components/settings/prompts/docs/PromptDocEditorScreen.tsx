import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { useNavigation, useRouter } from '@/components/appShell/workspace/destinationRoute';

import { PromptDocBodyV1Schema } from '@happier-dev/protocol/prompts/library/promptDocV2';

import { t } from '@/text';
import { sync } from '@/sync/sync';
import { storage, useSetting, useSettingMutable } from '@/sync/domains/state/storage';
import type { CodeEditorHandle } from '@/components/ui/code/editor/codeEditorTypes';
import { MarkdownCodeEditorField } from '@/components/ui/markdown/editor/MarkdownCodeEditorField';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { SectionContentRow } from '@/components/ui/lists/SectionContentRow';
import type { PageHeaderMenuAction } from '@/components/ui/layout/PageHeaderEntityParts';
import { Modal } from '@/modal';
import { createPromptDoc, updatePromptDoc } from '@/sync/ops/promptLibrary/promptDocs';
import { useUnsavedDraftNavigationGuard } from '@/utils/navigation/useUnsavedDraftNavigationGuard';
import { PromptExternalLinksGroup } from '@/components/settings/prompts/shared/PromptExternalLinksGroup';
import { PromptFolderFieldRow, PromptTagsFieldRow } from '@/components/settings/prompts/shared/PromptOrganizationFields';
import { usePromptEditorDraftField } from '@/components/settings/prompts/shared/usePromptEditorDraftField';
import { PromptEditorHeader } from '@/components/settings/prompts/collection/PromptEditorHeader';
import { publishPromptCollectionDraftTitle } from '@/components/settings/prompts/collection/PromptCollectionList';
import { promptCollectionItemHref, promptCollectionRoot } from '@/components/settings/prompts/collection/promptCollectionModel';
import { usePromptLibraryEntryActions } from '@/components/settings/prompts/collection/usePromptLibraryEntryActions';
import { usePromptLibraryEntryMeta } from '@/components/settings/prompts/collection/usePromptLibraryEntryMeta';
import { ensurePromptFolderByName, findPromptFolderById, formatPromptTags, normalizePromptTags } from '@/sync/ops/promptLibrary/promptFolders';

function readPromptDocMarkdown(bodyText: string | null): string {
  if (!bodyText) return '';
  try {
    const parsed = PromptDocBodyV1Schema.safeParse(JSON.parse(bodyText));
    return parsed.success ? parsed.data.markdown : '';
  } catch {
    return '';
  }
}

const styles = StyleSheet.create((theme) => ({
  editorContainer: {
    borderRadius: 10,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: theme.colors.border.default,
    minHeight: 360,
  },
}));

/**
 * A prompt's editor in the Prompts collection: a saved prompt (`artifactId`) or the new-prompt draft
 * (`null`). Saving a draft opens the saved prompt in its place; saving a prompt keeps it open.
 */
export const PromptDocEditorScreen = React.memo((props: Readonly<{ artifactId: string | null }>) => {
  const router = useRouter();
  const navigation = useNavigation();
  const isNew = props.artifactId === null;
  const [promptFoldersV1, setPromptFoldersV1] = useSettingMutable('promptFoldersV1');
  const wrapLinesInDiffs = useSetting('wrapLinesInDiffs');
  const entryActions = usePromptLibraryEntryActions('doc');
  const meta = usePromptLibraryEntryMeta(props.artifactId);
  const [isLoading, setIsLoading] = React.useState<boolean>(Boolean(props.artifactId));
  const titleField = usePromptEditorDraftField('');
  const markdownField = usePromptEditorDraftField('');
  const folderField = usePromptEditorDraftField('');
  const tagsField = usePromptEditorDraftField('');
  const {
    value: title,
    setValue: setTitle,
    setPristineValue: setPristineTitle,
    applyExternalValue: applyExternalTitle,
  } = titleField;
  const {
    value: markdown,
    setValue: setMarkdown,
    setPristineValue: setPristineMarkdown,
    applyExternalValue: applyExternalMarkdown,
  } = markdownField;
  const {
    value: folderName,
    setValue: setFolderName,
    setPristineValue: setPristineFolderName,
    applyExternalValue: applyExternalFolderName,
  } = folderField;
  const {
    value: tagsText,
    setValue: setTagsText,
    setPristineValue: setPristineTagsText,
    applyExternalValue: applyExternalTagsText,
  } = tagsField;
  const [saving, setSaving] = React.useState(false);
  // Where to go once the save that asked for it has rendered (so the draft is no longer dirty).
  const [pendingHref, setPendingHref] = React.useState<string | null>(null);
  // Flushed before reading `markdown` on save so the latest rich/raw edit (which
  // may still be debounced inside the active editor surface) is captured.
  const editorRef = React.useRef<CodeEditorHandle | null>(null);
  const promptFoldersRef = React.useRef(promptFoldersV1);
  promptFoldersRef.current = promptFoldersV1;
  const loadedArtifactIdRef = React.useRef<string | null>(null);

  const applyArtifactState = React.useCallback((artifactId: string | null, options?: Readonly<{ preserveDirty?: boolean }>) => {
    if (!artifactId) {
      loadedArtifactIdRef.current = null;
      setPristineTitle('');
      setPristineMarkdown('');
      setPristineFolderName('');
      setPristineTagsText('');
      return;
    }

    const next = storage.getState().artifacts[artifactId] ?? null;
    const headerTitle = typeof next?.header?.title === 'string' ? next.header.title : next?.title;
    const headerFolder = findPromptFolderById(
      promptFoldersRef.current,
      typeof next?.header?.folderId === 'string' ? next.header.folderId : null,
    );
    const headerTags = Array.isArray(next?.header?.tags)
      ? next.header.tags.filter((tag): tag is string => typeof tag === 'string')
      : [];
    const bodyText = typeof next?.body === 'string' ? next.body : null;
    const nextTitle = headerTitle ?? '';
    const nextMarkdown = readPromptDocMarkdown(bodyText);
    const nextFolderName = headerFolder?.name ?? '';
    const nextTagsText = formatPromptTags(headerTags);

    if (options?.preserveDirty === true) {
      applyExternalTitle(nextTitle, { preserveDirty: true });
      applyExternalMarkdown(nextMarkdown, { preserveDirty: true });
      applyExternalFolderName(nextFolderName, { preserveDirty: true });
      applyExternalTagsText(nextTagsText, { preserveDirty: true });
    } else {
      setPristineTitle(nextTitle);
      setPristineMarkdown(nextMarkdown);
      setPristineFolderName(nextFolderName);
      setPristineTagsText(nextTagsText);
    }
    loadedArtifactIdRef.current = artifactId;
  }, [applyExternalFolderName, applyExternalMarkdown, applyExternalTagsText, applyExternalTitle, setPristineFolderName, setPristineMarkdown, setPristineTagsText, setPristineTitle]);

  React.useEffect(() => {
    if (!props.artifactId) {
      applyArtifactState(null);
      setIsLoading(false);
      return;
    }

    let cancelled = false;
    setIsLoading(true);

    (async () => {
      try {
        const local = storage.getState().artifacts[props.artifactId!] ?? null;
        if (local?.body === undefined) {
          const credentials = sync.getCredentials();
          if (!credentials) throw new Error('Not authenticated');
          const full = await sync.fetchArtifactWithBody(props.artifactId!);
          if (full) storage.getState().updateArtifact(full);
        }

        if (!cancelled) {
          applyArtifactState(props.artifactId, { preserveDirty: loadedArtifactIdRef.current === props.artifactId });
        }
      } catch {
        // The fields stay as they are; the editor remains usable once the artifact arrives.
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [applyArtifactState, props.artifactId]);

  React.useEffect(() => {
    if (!props.artifactId || loadedArtifactIdRef.current !== props.artifactId) return;
    applyArtifactState(props.artifactId, { preserveDirty: true });
  }, [applyArtifactState, promptFoldersV1, props.artifactId]);

  React.useEffect(() => {
    if (!isNew) return undefined;
    publishPromptCollectionDraftTitle('doc', title);
    return () => publishPromptCollectionDraftTitle('doc', '');
  }, [isNew, title]);

  const changed = titleField.changed || markdownField.changed || folderField.changed || tagsField.changed;
  // A draft is dirty once anything was typed; saving makes its values pristine, so the saved
  // draft can open in its place without asking.
  const dirty = changed;
  const canSave = title.trim().length > 0 && !saving && !isLoading && (isNew || changed);

  const save = React.useCallback(async (): Promise<boolean> => {
    if (title.trim().length === 0 || saving) return false;

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
        const artifactId = await createPromptDoc({ title: title.trim(), markdown: latestMarkdown, folderId: ensuredFolder.folderId, tags });
        setPristineTitle(title);
        setPristineMarkdown(latestMarkdown);
        setPristineFolderName(folderName);
        setPristineTagsText(tagsText);
        setPendingHref(promptCollectionItemHref('doc', artifactId));
      } else {
        await updatePromptDoc({ artifactId: props.artifactId, title: title.trim(), markdown: latestMarkdown, folderId: ensuredFolder.folderId, tags });
        setPristineTitle(title);
        setPristineMarkdown(latestMarkdown);
        setPristineFolderName(folderName);
        setPristineTagsText(tagsText);
      }
      return true;
    } catch {
      Modal.alert(t('common.error'), t('promptLibrary.saveError'));
      return false;
    } finally {
      setSaving(false);
    }
  }, [folderName, markdown, promptFoldersV1, props.artifactId, saving, setPristineFolderName, setPristineMarkdown, setPristineTagsText, setPristineTitle, setPromptFoldersV1, tagsText, title]);

  const leave = React.useCallback(() => setPendingHref(promptCollectionRoot('doc')), []);
  React.useEffect(() => {
    if (!pendingHref) return;
    setPendingHref(null);
    router.replace(pendingHref as never);
  }, [pendingHref, router]);
  const discard = React.useCallback(() => {
    applyArtifactState(props.artifactId);
  }, [applyArtifactState, props.artifactId]);
  useUnsavedDraftNavigationGuard({
    navigation,
    isDirty: dirty,
    onDiscard: discard,
    onSave: save,
    onLeave: leave,
    tag: 'PromptDocEditorScreen.leave',
  });

  const menuActions = React.useMemo((): readonly PageHeaderMenuAction[] => {
    if (!props.artifactId) {
      return [{ id: 'discard', testID: 'promptDoc.discard', title: t('common.discard'), onSelect: () => { discard(); leave(); } }];
    }
    const artifactId = props.artifactId;
    return [
      { id: 'duplicate', testID: 'promptDoc.duplicate', title: t('common.duplicate'), onSelect: () => entryActions.duplicate(artifactId) },
      { id: 'external', testID: 'promptDoc.externalAssets', title: t('promptLibrary.manageExternalAssets'), onSelect: () => entryActions.manageExternalAssets(artifactId) },
      {
        id: 'delete',
        testID: 'promptDoc.delete',
        title: t('common.delete'),
        onSelect: async () => {
          if (await entryActions.remove(artifactId)) {
            discard();
            leave();
          }
        },
      },
    ];
  }, [discard, entryActions, leave, props.artifactId]);

  return (
    <ItemList keyboardShouldPersistTaps="handled">
      <PromptEditorHeader
        testID="promptDoc.header"
        mark="file-text"
        title={title.trim() || (isNew ? t('promptLibrary.newPrompt') : t('promptLibrary.untitledPrompt'))}
        description={t('promptLibrary.surface.docEditorDescription')}
        meta={meta}
        saveTestID="promptDoc.save"
        saveDisabled={!canSave}
        saving={saving}
        onSave={() => { void save(); }}
        menuActions={menuActions}
      />

      <ItemGroup title={t('promptLibrary.surface.promptSection')} description={t('promptLibrary.surface.promptSectionDescription')}>
        <Item
          title={t('promptLibrary.surface.nameTitle')}
          accessoryLayout="adaptive"
          showChevron={false}
          rightElement={(
            <FieldTextInput
              testID="promptDoc.title"
              value={title}
              onChangeText={setTitle}
              accessibilityLabel={t('promptLibrary.surface.nameTitle')}
              placeholder={t('promptLibrary.titlePlaceholder')}
              autoCapitalize="sentences"
              autoFocus={isNew}
              editable={!isLoading}
            />
          )}
        />
        <PromptFolderFieldRow value={folderName} onChange={setFolderName} testID="promptDoc.folderName" editable={!isLoading} />
        <PromptTagsFieldRow value={tagsText} onChange={setTagsText} testID="promptDoc.tags" editable={!isLoading} />
      </ItemGroup>

      <ItemGroup title={t('promptLibrary.surface.contentSection')} description={t('promptLibrary.surface.docContentDescription')}>
        <SectionContentRow>
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
        </SectionContentRow>
      </ItemGroup>

      <PromptExternalLinksGroup
        artifactId={props.artifactId}
        libraryKind="doc"
        manageItemTestID="promptDoc.manageExternalAssets"
        manageItemSubtitle={t('promptLibrary.surface.manageExternalAssetsDescription')}
        linkTestIDPrefix="promptDoc.link"
      />
    </ItemList>
  );
});

PromptDocEditorScreen.displayName = 'PromptDocEditorScreen';
