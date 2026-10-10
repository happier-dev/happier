import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { useNavigation, useRouter } from '@/components/appShell/workspace/destinationRoute';

import { type PromptDocRevisionV1 } from '@happier-dev/protocol/prompts/library/promptDocV2';
import { readPromptDocInLibrary, createPromptDocInLibrary, updatePromptDocInLibrary, type PromptLibraryStoredArtifact } from '@happier-dev/protocol/prompts/library/promptLibraryActionOperations';
import { ArtifactOrganizationMutationFailureV1, readArtifactFolderCatalogV1 } from '@happier-dev/protocol/prompts/library/promptFolderActionsV1';
import { resolveArtifactOrganizationHeaderV1, type ArtifactOrganizationHeaderV1 } from '@happier-dev/protocol/artifacts/artifactOrganizationV1';
import { captureLazyActionAccountContext, type LazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { createUiPromptLibraryArtifactStore } from '@/sync/ops/promptLibrary/promptLibraryArtifactStore';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';

import { t } from '@/text';
import { useSetting } from '@/sync/domains/state/storage';
import { usePromptLibraryCatalogValue } from '@/sync/store/usePromptLibraryCatalog';
import { requireUpdatedPromptLibraryMutation } from '@/sync/api/account/apiPromptLibraryCatalog';
import type { CodeEditorHandle } from '@/components/ui/code/editor/codeEditorTypes';
import { MarkdownCodeEditorField } from '@/components/ui/markdown/editor/MarkdownCodeEditorField';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { SectionContentRow } from '@/components/ui/lists/SectionContentRow';
import type { PageHeaderMenuAction } from '@/components/ui/layout/PageHeaderEntityParts';
import { Modal } from '@/modal';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { ToolDiffView } from '@/components/tools/shell/presentation/ToolDiffView';
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

type EditorDocument = Readonly<{ artifact: PromptLibraryStoredArtifact; title: string; markdown: string;
  organization: ArtifactOrganizationHeaderV1 | null }>;

const styles = StyleSheet.create((theme) => ({
  conflict: {
    marginBottom: 8,
  },
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
export const PromptDocEditorScreen = React.memo((props: Readonly<{ artifactId: string | null; serverId?: string | null }>) => {
  const router = useRouter();
  const navigation = useNavigation();
  const isNew = props.artifactId === null;
  const activeScope = useAccountSettingsScope();
  const targetServerId = props.serverId?.trim() || activeScope?.serverId;
  const targetActiveAccountId = targetServerId === activeScope?.serverId ? activeScope?.accountId : undefined;
  const [editingScope, setEditingScope] = React.useState<ServerAccountScope | null>(null);
  const accountRef = React.useRef<LazyActionAccountContext | null>(null);
  const documentRef = React.useRef<EditorDocument | null>(null);
  const revisionRef = React.useRef<PromptDocRevisionV1 | null>(null);
  const { value: promptFoldersV1, write: writeFolders, status: foldersStatus, stale: foldersStale } = usePromptLibraryCatalogValue('folders', editingScope);
  const wrapLinesInDiffs = useSetting('wrapLinesInDiffs');
  const assertEditingAccountCurrent = React.useCallback(() => {
    if (!accountRef.current) throw new Error('action_account_scope_changed');
    accountRef.current.assertCurrent();
  }, []);
  const entryActions = usePromptLibraryEntryActions('doc', editingScope, { expectedRevision: revisionRef.current ?? undefined,
    assertCurrent: assertEditingAccountCurrent });
  const meta = usePromptLibraryEntryMeta(props.artifactId, { scope: editingScope, header: documentRef.current?.artifact.header ?? null });
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
  // A save refused because the document changed after this draft's reviewed revision (plan 61): the
  // draft stays; reviewing loads the current version beside it and makes the next save an informed one.
  const [conflict, setConflict] = React.useState<null | Readonly<{ phase: 'detected' }> | Readonly<{ phase: 'reviewing'; markdown: string }>>(null);
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

    const next = documentRef.current;
    let organization: ArtifactOrganizationHeaderV1 | null = null;
    if (next && promptFoldersRef.current) {
      try {
        organization = resolveArtifactOrganizationHeaderV1({ artifactId, header: next.artifact.header ?? {},
          owned: next.artifact.owned === true, artifactHeadersById: promptFoldersRef.current.artifactHeadersById });
      } catch { /* Unavailable organization does not discard the admitted document. */ }
    }
    if (next) documentRef.current = { ...next, organization };
    const headerTitle = next?.title;
    const headerFolder = findPromptFolderById(
      promptFoldersRef.current,
      organization?.folderId ?? null,
    );
    const headerTags = organization?.tags ?? [];
    const nextTitle = headerTitle ?? '';
    const nextMarkdown = next?.markdown ?? '';
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
    let cancelled = false;
    const controller = new AbortController();
    let context: LazyActionAccountContext | null = null;
    let retirement: Readonly<{ dispose(): void }> | null = null;
    accountRef.current = null;
    documentRef.current = null;
    revisionRef.current = null;
    setEditingScope(null);
    applyArtifactState(null);
    setIsLoading(true);

    (async () => {
      try {
        if (!targetServerId) throw new Error('action_home_not_found');
        context = await captureLazyActionAccountContext(targetServerId, controller.signal);
        if (cancelled) { context.dispose(); return; }
        accountRef.current = context;
        retirement = context.accountLifetime.onRetire(() => {
          if (cancelled) return;
          accountRef.current = null; documentRef.current = null; revisionRef.current = null;
          setEditingScope(null); applyArtifactState(null); setIsLoading(false);
        });
        context.assertCurrent();
        setEditingScope({ serverId: context.serverId, accountId: context.accountId });
        if (props.artifactId) {
          const store = createUiPromptLibraryArtifactStore(context.workflowArtifacts, context);
          const artifact = await store.read(props.artifactId, { signal: controller.signal });
          // One observed read supplies both admission and display; no cache or
          // second reader can advance the revision the draft was reviewed against.
          const document = await readPromptDocInLibrary({ store: { read: async () => artifact }, artifactId: props.artifactId, signal: controller.signal });
          if (!document.ok || !artifact) throw new Error(document.ok ? 'prompt_doc_not_found' : document.errorCode);
          const folders = await readArtifactFolderCatalogV1({ port: store.organization!, signal: controller.signal });
          context.assertCurrent();
          if (cancelled) return;
          documentRef.current = { artifact, title: document.title, markdown: document.markdown, organization: null };
          revisionRef.current = document.revision;
          promptFoldersRef.current = folders.status === 'ready' ? folders.value : null;
          applyArtifactState(props.artifactId);
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
  }, [applyArtifactState, props.artifactId, targetServerId, targetActiveAccountId]);

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
  const organizationAvailable = promptFoldersV1 !== null && foldersStatus === 'ready' && !foldersStale
    && (isNew || documentRef.current?.organization != null);
  const canSave = (isNew ? organizationAvailable : documentRef.current !== null)
    && title.trim().length > 0 && !saving && !isLoading && (isNew || changed);

  const save = React.useCallback(async (): Promise<boolean> => {
    if ((isNew && !organizationAvailable) || title.trim().length === 0 || saving) return false;

    const account = accountRef.current;
    let submittedMarkdown: string | null = null;
    try {
      setSaving(true);
      if (!account) throw new Error('action_account_scope_changed');
      account.assertCurrent();
      const store = createUiPromptLibraryArtifactStore(account.workflowArtifacts, account);
      // Flush any debounced edit out of the active editor surface, then read the
      // freshest markdown from its handle (state may not have caught up yet).
      await editorRef.current?.flushPendingChange();
      const latestMarkdown = editorRef.current?.getValue() ?? markdown;
      submittedMarkdown = latestMarkdown;
      let organization: ArtifactOrganizationHeaderV1 = {};
      if (organizationAvailable && promptFoldersV1) {
        const ensuredFolder = ensurePromptFolderByName(promptFoldersV1, folderName);
        if (ensuredFolder.promptFoldersV1 !== promptFoldersV1) {
          requireUpdatedPromptLibraryMutation(await writeFolders(ensuredFolder.promptFoldersV1));
        }
        organization = { folderId: ensuredFolder.folderId, tags: normalizePromptTags(tagsText) };
      }
      if (!props.artifactId) {
        const { artifactId } = await createPromptDocInLibrary({ store, request: { title: title.trim(), markdown: latestMarkdown, ...organization } });
        account.assertCurrent();
        setPristineTitle(title);
        setPristineMarkdown(latestMarkdown);
        if (organizationAvailable) {
          setPristineFolderName(folderName);
          setPristineTagsText(tagsText);
        }
        setPendingHref(promptCollectionItemHref('doc', artifactId, { serverId: account.serverId }));
      } else {
        const expectedRevision = revisionRef.current;
        if (!expectedRevision) throw new Error('prompt_doc_review_unavailable');
        const accepted = await updatePromptDocInLibrary({ store, request: { artifactId: props.artifactId, expectedRevision,
          title: title.trim(), markdown: latestMarkdown, ...organization } });
        account.assertCurrent();
        if (!accepted.revision) throw new Error('prompt_doc_update_receipt_unavailable');
        revisionRef.current = accepted.revision;
        setConflict(null);
        if (documentRef.current) documentRef.current = { ...documentRef.current, title: title.trim(), markdown: latestMarkdown,
          ...(organizationAvailable ? { organization } : {}) };
        setPristineTitle(title);
        setPristineMarkdown(latestMarkdown);
        if (organizationAvailable) {
          setPristineFolderName(folderName);
          setPristineTagsText(tagsText);
        }
      }
      return true;
    } catch (error) {
      if (props.artifactId && error && typeof error === 'object' && 'code' in error && error.code === 'version_mismatch') {
        setConflict({ phase: 'detected' });
        return false;
      }
      if (error instanceof ArtifactOrganizationMutationFailureV1 && account && submittedMarkdown !== null) {
        try {
          // A private-row failure cannot erase the content ACK, but a retired
          // editor must not adopt it into another Home or reviewed document.
          if (accountRef.current !== account) throw new Error('action_account_scope_changed');
          account.assertCurrent();
          if (!props.artifactId) {
            applyExternalTitle(title, { preserveDirty: true });
            applyExternalMarkdown(submittedMarkdown, { preserveDirty: true });
            setPendingHref(promptCollectionItemHref('doc', error.details.artifactId, { serverId: account.serverId }));
          } else if (error.details.artifactId === props.artifactId && error.details.contentRevision) {
            revisionRef.current = error.details.contentRevision;
            if (documentRef.current) documentRef.current = { ...documentRef.current, title: title.trim(), markdown: submittedMarkdown };
            applyExternalTitle(title, { preserveDirty: true });
            applyExternalMarkdown(submittedMarkdown, { preserveDirty: true });
          }
        } catch { /* The original captured editor no longer admits this receipt. */ }
      }
      Modal.alert(t('common.error'), t('promptLibrary.saveError'));
      return false;
    } finally {
      setSaving(false);
    }
  }, [applyExternalMarkdown, applyExternalTitle, folderName, markdown, organizationAvailable, promptFoldersV1, props.artifactId, saving, setPristineFolderName, setPristineMarkdown, setPristineTagsText, setPristineTitle, writeFolders, tagsText, title]);

  const reviewCurrentVersion = React.useCallback(async () => {
    const account = accountRef.current;
    if (!account || !props.artifactId) return;
    try {
      account.assertCurrent();
      const store = createUiPromptLibraryArtifactStore(account.workflowArtifacts, account);
      const artifact = await store.read(props.artifactId);
      const current = await readPromptDocInLibrary({ store: { read: async () => artifact }, artifactId: props.artifactId });
      account.assertCurrent();
      if (!current.ok || !artifact) throw new Error(current.ok ? 'prompt_doc_not_found' : current.errorCode);
      // The person now reviews against this revision; the draft itself is untouched.
      revisionRef.current = current.revision;
      if (documentRef.current) documentRef.current = { ...documentRef.current, artifact };
      setConflict({ phase: 'reviewing', markdown: current.markdown });
    } catch {
      Modal.alert(t('common.error'), t('promptLibrary.saveError'));
    }
  }, [props.artifactId]);

  const leave = React.useCallback(() => setPendingHref(promptCollectionRoot('doc')), []);
  const discard = React.useCallback(() => {
    applyArtifactState(props.artifactId);
  }, [applyArtifactState, props.artifactId]);
  const { allowSavedNavigation } = useUnsavedDraftNavigationGuard({
    navigation,
    isDirty: dirty,
    onDiscard: discard,
    onSave: save,
    onLeave: leave,
    tag: 'PromptDocEditorScreen.leave',
  });
  React.useEffect(() => {
    if (!pendingHref) return;
    setPendingHref(null);
    allowSavedNavigation();
    router.replace(pendingHref as never);
  }, [allowSavedNavigation, pendingHref, router]);

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
        onSave={() => save()}
        menuActions={menuActions}
      />

      {conflict ? (
        <View testID="promptDoc.conflict" style={styles.conflict}>
          <SurfaceFreshnessLine
            testID="promptDoc.conflict.line"
            tone="warning"
            reason={t('sessionInstructions.saveConflict')}
            action={conflict.phase === 'detected'
              ? { label: t('sessionInstructions.reviewCurrent'), onPress: () => { void reviewCurrentVersion(); } }
              : undefined}
          />
        </View>
      ) : null}
      {conflict?.phase === 'reviewing' ? (
        <ItemGroup title={t('sessionInstructions.currentVersion')}>
          <SectionContentRow>
            <View testID="promptDoc.conflict.current">
              <ToolDiffView oldText={conflict.markdown} newText={markdown} />
            </View>
          </SectionContentRow>
        </ItemGroup>
      ) : null}

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
        <PromptFolderFieldRow value={folderName} onChange={setFolderName} testID="promptDoc.folderName" editable={!isLoading && organizationAvailable} />
        <PromptTagsFieldRow value={tagsText} onChange={setTagsText} testID="promptDoc.tags" editable={!isLoading && organizationAvailable} />
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
        scope={editingScope}
        libraryKind="doc"
        manageItemTestID="promptDoc.manageExternalAssets"
        manageItemSubtitle={t('promptLibrary.surface.manageExternalAssetsDescription')}
        linkTestIDPrefix="promptDoc.link"
      />
    </ItemList>
  );
});

PromptDocEditorScreen.displayName = 'PromptDocEditorScreen';
