import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { useNavigation, useRouter } from '@/components/appShell/workspace/destinationRoute';
import { useFocusEffect } from '@/components/appShell/workspace/destinationRoute';

import { t } from '@/text';
import { useSetting } from '@/sync/domains/state/storage';
import type { PromptLibraryStoredArtifact } from '@happier-dev/protocol/prompts/library/promptLibraryActionOperations';
import { ArtifactOrganizationMutationFailureV1, readArtifactFolderCatalogV1 } from '@happier-dev/protocol/prompts/library/promptFolderActionsV1';
import { captureLazyActionAccountContext, type LazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { createUiPromptLibraryArtifactStore } from '@/sync/ops/promptLibrary/promptLibraryArtifactStore';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { usePromptLibraryCatalogValue } from '@/sync/store/usePromptLibraryCatalog';
import { requireUpdatedPromptLibraryMutation } from '@/sync/api/account/apiPromptLibraryCatalog';
import type { CodeEditorHandle } from '@/components/ui/code/editor/codeEditorTypes';
import { MarkdownCodeEditorField } from '@/components/ui/markdown/editor/MarkdownCodeEditorField';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { ItemRowActions } from '@/components/ui/lists/ItemRowActions';
import type { ItemAction } from '@/components/ui/lists/itemActions';
import { SectionActionButton } from '@/components/ui/lists/SectionActionButton';
import { SectionContentRow } from '@/components/ui/lists/SectionContentRow';
import type { PageHeaderMenuAction } from '@/components/ui/layout/PageHeaderEntityParts';
import { Modal } from '@/modal';
import {
  DEFAULT_SKILL_PROMPT_MARKDOWN,
  createSkillPromptBundle,
  hasSkillPromptMarkdownContent,
  listPromptBundleSupportingEntries,
  removeSkillPromptBundleEntry,
  readSkillMarkdownFromPromptBundleBody,
  updateSkillPromptBundle,
  upsertPromptBundleUtf8Entry,
} from '@/sync/ops/promptLibrary/promptBundles';
import { useUnsavedDraftNavigationGuard } from '@/utils/navigation/useUnsavedDraftNavigationGuard';
import { PromptExternalLinksGroup } from '@/components/settings/prompts/shared/PromptExternalLinksGroup';
import { PromptFolderFieldRow, PromptTagsFieldRow } from '@/components/settings/prompts/shared/PromptOrganizationFields';
import { PromptEditorHeader } from '@/components/settings/prompts/collection/PromptEditorHeader';
import { publishPromptCollectionDraftTitle } from '@/components/settings/prompts/collection/PromptCollectionList';
import { promptCollectionItemHref, promptCollectionRoot } from '@/components/settings/prompts/collection/promptCollectionModel';
import { usePromptLibraryEntryActions } from '@/components/settings/prompts/collection/usePromptLibraryEntryActions';
import { usePromptLibraryEntryMeta } from '@/components/settings/prompts/collection/usePromptLibraryEntryMeta';
import { usePromptEditorDraftField } from '@/components/settings/prompts/shared/usePromptEditorDraftField';
import { readSkillBundleArtifactState, type SkillBundleArtifactState } from '@/components/settings/prompts/skills/readSkillBundleArtifactState';
import { ensurePromptFolderByName, findPromptFolderById, formatPromptTags, normalizePromptTags } from '@/sync/ops/promptLibrary/promptFolders';

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
 * A skill's editor in the Skills collection: a saved skill (`artifactId`) or the new-skill draft
 * (`null`). Saving a draft opens the saved skill in its place; saving a skill keeps it open.
 */
export const SkillBundleEditorScreen = React.memo((props: Readonly<{ artifactId: string | null; serverId?: string | null }>) => {
  const router = useRouter();
  const navigation = useNavigation();
  const activeScope = useAccountSettingsScope();
  const targetServerId = props.serverId?.trim() || activeScope?.serverId;
  const targetActiveAccountId = targetServerId === activeScope?.serverId ? activeScope?.accountId : undefined;
  const [editingScope, setEditingScope] = React.useState<ServerAccountScope | null>(null);
  const accountRef = React.useRef<LazyActionAccountContext | null>(null);
  const documentRef = React.useRef<SkillBundleArtifactState | null>(null);
  const revisionRef = React.useRef<PromptLibraryStoredArtifact['revision'] | null>(null);
  const { value: promptFoldersV1, write: writeFolders, status: foldersStatus, stale: foldersStale } = usePromptLibraryCatalogValue('folders', editingScope);
  const wrapLinesInDiffs = useSetting('wrapLinesInDiffs');
  const savedArtifactId = props.artifactId;
  const isNew = savedArtifactId === null;
  const assertEditingAccountCurrent = React.useCallback(() => {
    if (!accountRef.current) throw new Error('action_account_scope_changed');
    accountRef.current.assertCurrent();
  }, []);
  const entryActions = usePromptLibraryEntryActions('bundle', editingScope, {
    expectedRevision: revisionRef.current ?? undefined, assertCurrent: assertEditingAccountCurrent,
  });
  const meta = usePromptLibraryEntryMeta(savedArtifactId, { scope: editingScope, header: documentRef.current?.artifact.header ?? null });
  const [isLoading, setIsLoading] = React.useState<boolean>(Boolean(props.artifactId));
  const titleField = usePromptEditorDraftField('');
  const skillMarkdownField = usePromptEditorDraftField(DEFAULT_SKILL_PROMPT_MARKDOWN);
  const folderField = usePromptEditorDraftField('');
  const tagsField = usePromptEditorDraftField('');
  const {
    value: title,
    setValue: setTitle,
    setPristineValue: setPristineTitle,
    applyExternalValue: applyExternalTitle,
  } = titleField;
  const {
    value: skillMarkdown,
    setValue: setSkillMarkdown,
    setPristineValue: setPristineSkillMarkdown,
    applyExternalValue: applyExternalSkillMarkdown,
  } = skillMarkdownField;
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
  const [organizationAvailable, setOrganizationAvailable] = React.useState(true);
  // Where to go once the save that asked for it has rendered (so the draft is no longer dirty).
  const [pendingHref, setPendingHref] = React.useState<string | null>(null);
  const [supportingFiles, setSupportingFiles] = React.useState<Array<{ path: string; contentKind: 'utf8' | 'binary' }>>([]);
  // Flushed before reading `skillMarkdown` on save so the latest rich/raw edit
  // (which may still be debounced inside the active editor surface) is captured.
  const editorRef = React.useRef<CodeEditorHandle | null>(null);
  const promptFoldersRef = React.useRef(promptFoldersV1);
  promptFoldersRef.current = promptFoldersV1;
  const loadedArtifactIdRef = React.useRef<string | null>(null);

  const applyArtifactState = React.useCallback((artifactId: string | null, options?: Readonly<{
    preserveDirtyFields?: boolean;
  }>) => {
    if (!artifactId) {
      loadedArtifactIdRef.current = null;
      setSupportingFiles([]);
      setOrganizationAvailable(true);
      setPristineTitle('');
      setPristineSkillMarkdown(isNew ? DEFAULT_SKILL_PROMPT_MARKDOWN : '');
      setPristineFolderName('');
      setPristineTagsText('');
      return false;
    }
    const artifactState = readSkillBundleArtifactState(documentRef.current?.artifact ?? null, promptFoldersRef.current);
    if (!artifactState) {
      setSupportingFiles([]);
      return false;
    }

    const preserveDirtyFields = options?.preserveDirtyFields === true;
    setOrganizationAvailable(artifactState.organizationAvailable);
    // The reviewed content may include an acknowledged local save; organization
    // alone is refreshed from its independent catalog.
    const reviewed = documentRef.current;
    if (!reviewed) return false;
    documentRef.current = { ...reviewed, folderId: artifactState.folderId, tags: artifactState.tags,
      organizationAvailable: artifactState.organizationAvailable };
    const nextSkillMarkdown = readSkillMarkdownFromPromptBundleBody(reviewed.body) ?? '';
    const nextSupportingFiles = listPromptBundleSupportingEntries(reviewed.body).map((entry) => ({
      path: entry.path,
      contentKind: entry.contentKind,
    }));
    const nextFolderName = findPromptFolderById(promptFoldersRef.current, artifactState.folderId)?.name ?? '';
    const nextTagsText = formatPromptTags(artifactState.tags);

    setSupportingFiles(nextSupportingFiles);
    if (preserveDirtyFields) {
      applyExternalTitle(reviewed.title, { preserveDirty: true });
      applyExternalSkillMarkdown(nextSkillMarkdown, { preserveDirty: true });
      applyExternalFolderName(nextFolderName, { preserveDirty: true });
      applyExternalTagsText(nextTagsText, { preserveDirty: true });
    } else {
      setPristineTitle(reviewed.title);
      setPristineSkillMarkdown(nextSkillMarkdown);
      setPristineFolderName(nextFolderName);
      setPristineTagsText(nextTagsText);
    }
    loadedArtifactIdRef.current = artifactId;
    return true;
  }, [applyExternalFolderName, applyExternalSkillMarkdown, applyExternalTagsText, applyExternalTitle, isNew, setPristineFolderName, setPristineSkillMarkdown, setPristineTagsText, setPristineTitle]);

  const loadArtifact = React.useCallback(async (artifactId: string, options?: Readonly<{
    preserveDirtyFields?: boolean;
  }>) => {
    setIsLoading(true);
    const account = accountRef.current;
    if (!account) throw new Error('action_account_scope_changed');
    account.assertCurrent();
    const artifact = await createUiPromptLibraryArtifactStore(account.workflowArtifacts, account).read(artifactId);
    const admitted = readSkillBundleArtifactState(artifact, promptFoldersRef.current);
    account.assertCurrent();
    if (accountRef.current !== account) throw new Error('action_account_scope_changed');
    if (!admitted) throw new Error('prompt_bundle_invalid_body');
    if (options?.preserveDirtyFields && (titleField.isDirty() || skillMarkdownField.isDirty()
      || folderField.isDirty() || tagsField.isDirty())) return false;
    documentRef.current = admitted;
    revisionRef.current = admitted.artifact.revision;
    return applyArtifactState(artifactId, options);
  }, [applyArtifactState, folderField.isDirty, skillMarkdownField.isDirty, tagsField.isDirty, titleField.isDirty]);

  React.useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    let context: LazyActionAccountContext | null = null;
    let retirement: Readonly<{ dispose(): void }> | null = null;
    accountRef.current = null; documentRef.current = null; revisionRef.current = null;
    setEditingScope(null); applyArtifactState(null); setIsLoading(true);

    (async () => {
      try {
        if (!targetServerId) throw new Error('action_home_not_found');
        context = await captureLazyActionAccountContext(targetServerId, controller.signal);
        if (cancelled) { context.dispose(); return; }
        accountRef.current = context;
        retirement = context.accountLifetime.onRetire(() => {
          if (cancelled) return;
          accountRef.current = null; documentRef.current = null; revisionRef.current = null;
          setEditingScope(null); applyArtifactState(null); setPendingHref(null); setIsLoading(false);
        });
        context.assertCurrent();
        setEditingScope({ serverId: context.serverId, accountId: context.accountId });
        if (savedArtifactId) {
          const store = createUiPromptLibraryArtifactStore(context.workflowArtifacts, context);
          const artifact = await store.read(savedArtifactId, { signal: controller.signal });
          const folders = await readArtifactFolderCatalogV1({ port: store.organization!, signal: controller.signal });
          context.assertCurrent();
          if (cancelled) return;
          promptFoldersRef.current = folders.status === 'ready' ? folders.value : null;
          const admitted = readSkillBundleArtifactState(artifact, promptFoldersRef.current);
          if (!admitted) throw new Error('prompt_bundle_invalid_body');
          documentRef.current = admitted; revisionRef.current = admitted.artifact.revision;
          applyArtifactState(savedArtifactId);
        }
      } catch {
        if (!cancelled) { accountRef.current = null; setEditingScope(null); }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      controller.abort(); retirement?.dispose(); context?.dispose();
    };
  }, [applyArtifactState, savedArtifactId, targetServerId, targetActiveAccountId]);

  useFocusEffect(
    React.useCallback(() => {
      if (!savedArtifactId || loadedArtifactIdRef.current !== savedArtifactId
        || titleField.isDirty() || skillMarkdownField.isDirty() || folderField.isDirty() || tagsField.isDirty()) return undefined;
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
    }, [folderField.isDirty, loadArtifact, savedArtifactId, skillMarkdownField.isDirty, tagsField.isDirty, titleField.isDirty]),
  );

  React.useEffect(() => {
    if (!savedArtifactId || loadedArtifactIdRef.current !== savedArtifactId) return;
    applyArtifactState(savedArtifactId, { preserveDirtyFields: true });
  }, [applyArtifactState, promptFoldersV1, savedArtifactId]);

  React.useEffect(() => {
    if (!isNew) return undefined;
    publishPromptCollectionDraftTitle('bundle', title);
    return () => publishPromptCollectionDraftTitle('bundle', '');
  }, [isNew, title]);

  const changed = titleField.changed || skillMarkdownField.changed || folderField.changed || tagsField.changed;
  // Saving makes the fields pristine, so a saved draft opens in its place without asking.
  const dirty = changed;
  const contentValid = title.trim().length > 0 && hasSkillPromptMarkdownContent(skillMarkdown);
  const organizationWritable = organizationAvailable && promptFoldersV1 !== null && foldersStatus === 'ready' && !foldersStale;
  const canSave = accountRef.current !== null && (isNew ? organizationWritable : documentRef.current !== null)
    && contentValid && !saving && !isLoading && (isNew || changed);

  const save = React.useCallback(async (): Promise<boolean> => {
    if ((isNew && !organizationWritable) || !contentValid || saving) return false;

    const account = accountRef.current;
    let submittedMarkdown: string | null = null;
    const adoptContent = (revision: PromptLibraryStoredArtifact['revision'], markdown: string) => {
      revisionRef.current = revision;
      const reviewed = documentRef.current;
      if (reviewed) {
        const body = { ...reviewed.body, entries: upsertPromptBundleUtf8Entry(reviewed.body.entries, { path: 'SKILL.md', content: markdown }) };
        documentRef.current = { ...reviewed, title: title.trim(), body,
          artifact: { ...reviewed.artifact, revision, body: JSON.stringify(body),
            header: { ...reviewed.artifact.header, title: title.trim(), bundleSchemaId: 'skills.skill_md_v1' } } };
      }
    };
    try {
      setSaving(true);
      if (!account) throw new Error('action_account_scope_changed');
      account.assertCurrent();
      const store = createUiPromptLibraryArtifactStore(account.workflowArtifacts, account);
      // Flush any debounced edit out of the active editor surface, then read the
      // freshest skill markdown from its handle (state may not have caught up yet).
      await editorRef.current?.flushPendingChange();
      const latestSkillMarkdown = editorRef.current?.getValue() ?? skillMarkdown;
      submittedMarkdown = latestSkillMarkdown;
      account.assertCurrent();
      let organization: { folderId?: string | null; tags?: readonly string[] } = {};
      if (organizationWritable && promptFoldersV1) {
        const ensuredFolder = ensurePromptFolderByName(promptFoldersV1, folderName);
        if (ensuredFolder.promptFoldersV1 !== promptFoldersV1) {
          requireUpdatedPromptLibraryMutation(await writeFolders(ensuredFolder.promptFoldersV1));
        }
        organization = { folderId: ensuredFolder.folderId, tags: normalizePromptTags(tagsText) };
      }
      if (!props.artifactId) {
        const artifactId = await createSkillPromptBundle({ title: title.trim(), skillMarkdown: latestSkillMarkdown, ...organization }, store);
        account.assertCurrent();
        setPendingHref(promptCollectionItemHref('bundle', artifactId, { serverId: account.serverId }));
      } else {
        const expectedRevision = revisionRef.current;
        if (!expectedRevision) throw new Error('prompt_bundle_review_unavailable');
        const revision = await updateSkillPromptBundle({ artifactId: props.artifactId, expectedRevision,
          title: title.trim(), skillMarkdown: latestSkillMarkdown, ...organization }, store);
        account.assertCurrent();
        adoptContent(revision, latestSkillMarkdown);
      }
      setPristineTitle(title);
      setPristineSkillMarkdown(latestSkillMarkdown);
      if (organizationWritable) {
        setPristineFolderName(folderName);
        setPristineTagsText(tagsText);
      }
      return true;
    } catch (error) {
      if (error instanceof ArtifactOrganizationMutationFailureV1 && account && submittedMarkdown !== null) {
        try {
          if (accountRef.current !== account) throw new Error('action_account_scope_changed');
          account.assertCurrent();
          if (!props.artifactId) {
            applyExternalTitle(title, { preserveDirty: true });
            applyExternalSkillMarkdown(submittedMarkdown, { preserveDirty: true });
            setPendingHref(promptCollectionItemHref('bundle', error.details.artifactId, { serverId: account.serverId }));
          } else if (error.details.artifactId === props.artifactId && error.details.contentRevision) {
            adoptContent(error.details.contentRevision, submittedMarkdown);
            applyExternalTitle(title, { preserveDirty: true });
            applyExternalSkillMarkdown(submittedMarkdown, { preserveDirty: true });
          }
        } catch { /* A retired editor cannot adopt the original Account's receipt. */ }
      }
      Modal.alert(t('common.error'), t('promptLibrary.saveError'));
      return false;
    } finally {
      setSaving(false);
    }
  }, [applyExternalSkillMarkdown, applyExternalTitle, contentValid, folderName, isNew, organizationWritable, promptFoldersV1, props.artifactId, saving, setPristineFolderName, setPristineSkillMarkdown, setPristineTagsText, setPristineTitle, writeFolders, skillMarkdown, tagsText, title]);

  const leave = React.useCallback(() => setPendingHref(promptCollectionRoot('bundle')), []);
  const discard = React.useCallback(() => {
    if (!savedArtifactId) {
      setPristineTitle('');
      setPristineSkillMarkdown(DEFAULT_SKILL_PROMPT_MARKDOWN);
      setPristineFolderName('');
      setPristineTagsText('');
      return;
    }
    applyArtifactState(savedArtifactId);
  }, [applyArtifactState, savedArtifactId, setPristineFolderName, setPristineSkillMarkdown, setPristineTagsText, setPristineTitle]);
  const { allowSavedNavigation } = useUnsavedDraftNavigationGuard({
    navigation,
    isDirty: dirty,
    onDiscard: discard,
    onSave: save,
    onLeave: leave,
    tag: 'SkillBundleEditorScreen.leave',
  });
  React.useEffect(() => {
    if (!pendingHref) return;
    setPendingHref(null);
    if (pendingHref !== promptCollectionRoot('bundle')) {
      try { assertEditingAccountCurrent(); } catch { return; }
    }
    allowSavedNavigation();
    router.replace(pendingHref as never);
  }, [allowSavedNavigation, assertEditingAccountCurrent, pendingHref, router]);

  const menuActions = React.useMemo((): readonly PageHeaderMenuAction[] => {
    if (!savedArtifactId) {
      return [{ id: 'discard', testID: 'skillBundle.discard', title: t('common.discard'), onSelect: () => { discard(); leave(); } }];
    }
    return [
      { id: 'duplicate', testID: 'skillBundle.duplicate', title: t('common.duplicate'), onSelect: () => entryActions.duplicate(savedArtifactId) },
      { id: 'external', testID: 'skillBundle.externalAssets', title: t('promptLibrary.manageExternalAssets'), onSelect: () => entryActions.manageExternalAssets(savedArtifactId) },
      {
        id: 'delete',
        testID: 'skillBundle.delete',
        title: t('common.delete'),
        onSelect: async () => {
          if (await entryActions.remove(savedArtifactId)) {
            discard();
            leave();
          }
        },
      },
    ];
  }, [discard, entryActions, leave, savedArtifactId]);

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
                const account = accountRef.current;
                const expectedRevision = revisionRef.current;
                if (!account || !expectedRevision) throw new Error('prompt_bundle_review_unavailable');
                account.assertCurrent();
                const revision = await removeSkillPromptBundleEntry({
                  artifactId: savedArtifactId,
                  path,
                  expectedRevision,
                }, createUiPromptLibraryArtifactStore(account.workflowArtifacts, account));
                account.assertCurrent();
                if (accountRef.current !== account) throw new Error('action_account_scope_changed');
                revisionRef.current = revision;
                const reviewed = documentRef.current;
                if (reviewed) {
                  const body = { ...reviewed.body, entries: reviewed.body.entries.filter(entry => entry.path !== path) };
                  documentRef.current = { ...reviewed, body,
                    artifact: { ...reviewed.artifact, revision, body: JSON.stringify(body),
                      header: { ...reviewed.artifact.header, bundleSchemaId: 'skills.skill_md_v1' } } };
                }
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
    <ItemList keyboardShouldPersistTaps="handled">
      <PromptEditorHeader
        testID="skillBundle.header"
        mark="sparkle"
        title={title.trim() || (isNew ? t('promptLibrary.newSkill') : t('promptLibrary.untitledSkill'))}
        description={t('promptLibrary.surface.skillEditorDescription')}
        meta={meta}
        saveTestID="skillBundle.save"
        saveDisabled={!canSave}
        saving={saving}
        onSave={() => { void save(); }}
        menuActions={menuActions}
      />

      <ItemGroup title={t('promptLibrary.surface.skillSection')} description={t('promptLibrary.surface.skillSectionDescription')}>
        <Item
          title={t('promptLibrary.surface.nameTitle')}
          accessoryLayout="adaptive"
          showChevron={false}
          rightElement={(
            <FieldTextInput
              testID="skillBundle.title"
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
        <PromptFolderFieldRow value={folderName} onChange={setFolderName} testID="skillBundle.folderName" editable={!isLoading && organizationWritable} />
        <PromptTagsFieldRow value={tagsText} onChange={setTagsText} testID="skillBundle.tags" editable={!isLoading && organizationWritable} />
      </ItemGroup>

      <ItemGroup title={t('promptLibrary.skillContent')} description={t('promptLibrary.surface.skillContentDescription')}>
        <SectionContentRow>
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
        </SectionContentRow>
      </ItemGroup>

      <ItemGroup
        title={t('promptLibrary.supportingFiles')}
        description={t('promptLibrary.surface.supportingFilesDescription')}
        action={savedArtifactId && editingScope ? (
          <SectionActionButton
            testID="skillBundle.addSupportingFile"
            title={t('promptLibrary.surface.addFile')}
            icon="plus"
            disabled={isLoading || documentRef.current === null}
            onPress={() => {
              try {
                assertEditingAccountCurrent();
                router.push(`/settings/prompts/skills/${savedArtifactId}/files/new?serverId=${encodeURIComponent(editingScope.serverId)}`);
              } catch { Modal.alert(t('common.error'), t('promptLibrary.saveError')); }
            }}
          />
        ) : undefined}
      >
        {savedArtifactId ? (
          supportingFiles.length > 0 ? supportingFiles.map((entry, index) => {
            const editPath = `/settings/prompts/skills/${savedArtifactId}/files/edit?path=${encodeURIComponent(entry.path)}&serverId=${encodeURIComponent(editingScope?.serverId ?? '')}`;
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
          }) : (
            <Item
              testID="skillBundle.supportingFilesEmpty"
              title={t('promptLibrary.supportingFilesEmptyTitle')}
              subtitle={t('promptLibrary.supportingFilesEmptySubtitle')}
              mode="info"
              showChevron={false}
            />
          )
        ) : (
          <Item
            testID="skillBundle.supportingFilesSaveFirst"
            title={t('promptLibrary.supportingFilesSaveFirstTitle')}
            subtitle={t('promptLibrary.supportingFilesSaveFirstSubtitle')}
            mode="info"
            showChevron={false}
          />
        )}
      </ItemGroup>

      <PromptExternalLinksGroup
        artifactId={props.artifactId}
        libraryKind="bundle"
        scope={editingScope}
        manageItemTestID="skillBundle.manageExternalAssets"
        manageItemSubtitle={t('promptLibrary.surface.manageExternalAssetsDescription')}
        linkTestIDPrefix="skillBundle.link"
      />
    </ItemList>
  );
});

SkillBundleEditorScreen.displayName = 'SkillBundleEditorScreen';
