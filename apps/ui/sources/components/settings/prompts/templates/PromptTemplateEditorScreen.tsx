import * as React from 'react';
import { useNavigation, useRouter } from '@/components/appShell/workspace/destinationRoute';

import { PromptInvocationEntryV1Schema, validatePromptInvocationTokenV1 } from '@happier-dev/protocol/prompts/library/promptInvocationsV1';
import { listActionSpecs } from '@happier-dev/protocol/actions/actionSpecs';

import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { Switch } from '@/components/ui/forms/Switch';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { SegmentedChoiceItem } from '@/components/ui/lists/SegmentedChoiceItem';
import type { PageHeaderMenuAction } from '@/components/ui/layout/PageHeaderEntityParts';
import { Modal } from '@/modal';
import { randomUUID } from '@/platform/randomUUID';
import { useArtifacts } from '@/sync/domains/state/storage';
import { usePromptLibraryCatalogValue } from '@/sync/store/usePromptLibraryCatalog';
import { requireUpdatedPromptLibraryMutation } from '@/sync/api/account/apiPromptLibraryCatalog';
import { t } from '@/text';
import { PromptDocSelectionGroup } from '@/components/settings/prompts/shared/PromptDocSelectionGroup';
import { usePromptEditorDraftField } from '@/components/settings/prompts/shared/usePromptEditorDraftField';
import { PromptEditorHeader } from '@/components/settings/prompts/collection/PromptEditorHeader';
import { publishPromptCollectionDraftTitle } from '@/components/settings/prompts/collection/PromptCollectionList';
import { promptCollectionItemHref, promptCollectionRoot } from '@/components/settings/prompts/collection/promptCollectionModel';
import { useUnsavedDraftNavigationGuard } from '@/utils/navigation/useUnsavedDraftNavigationGuard';

type TemplateBehavior = 'insert' | 'insert_on_send' | 'insert_and_send';

/**
 * A slash template's editor in the Templates collection: a saved template (`invocationId`) or the
 * new-template draft (`null`). Saving a draft opens the saved template in its place.
 */
export const PromptTemplateEditorScreen = React.memo((props: Readonly<{ invocationId: string | null }>) => {
  const router = useRouter();
  const navigation = useNavigation();
  const isNew = props.invocationId === null;
  const artifacts = useArtifacts();
  const { value: invocations, write: writeInvocations, status, stale } = usePromptLibraryCatalogValue('invocations');
  const hasInvocations = invocations !== null;
  const canWriteInvocations = hasInvocations && status === 'ready' && !stale;

  const existingEntry = React.useMemo(() => {
    if (!props.invocationId) return null;
    return invocations?.entries.find((e) => e.id === props.invocationId) ?? null;
  }, [invocations, props.invocationId]);

  const promptDocs = React.useMemo(
    () => artifacts
      .filter((a) => a.header?.kind === 'prompt_doc.v2')
      .map((artifact) => ({
        id: artifact.id,
        title: typeof artifact.header?.title === 'string'
          ? artifact.header.title
          : artifact.title ?? t('promptLibrary.untitledPrompt'),
      })),
    [artifacts],
  );

  const titleField = usePromptEditorDraftField('');
  const tokenField = usePromptEditorDraftField('');
  const targetField = usePromptEditorDraftField<string>('');
  const behaviorField = usePromptEditorDraftField<TemplateBehavior>('insert');
  const allowArgsField = usePromptEditorDraftField<boolean>(false);
  const {
    value: title,
    setValue: setTitle,
    setPristineValue: setPristineTitle,
    applyExternalValue: applyExternalTitle,
  } = titleField;
  const {
    value: token,
    setValue: setToken,
    setPristineValue: setPristineToken,
    applyExternalValue: applyExternalToken,
  } = tokenField;
  const {
    value: targetArtifactId,
    setValue: setTargetArtifactId,
    setPristineValue: setPristineTargetArtifactId,
    applyExternalValue: applyExternalTargetArtifactId,
  } = targetField;
  const {
    value: behavior,
    setValue: setBehavior,
    setPristineValue: setPristineBehavior,
    applyExternalValue: applyExternalBehavior,
  } = behaviorField;
  const {
    value: allowArgs,
    setValue: setAllowArgs,
    setPristineValue: setPristineAllowArgs,
    applyExternalValue: applyExternalAllowArgs,
  } = allowArgsField;
  const [saving, setSaving] = React.useState(false);
  const [tokenError, setTokenError] = React.useState<string | null>(null);
  // Where to go once the save that asked for it has rendered (so the draft is no longer dirty).
  const [pendingHref, setPendingHref] = React.useState<string | null>(null);
  const [targetMenuOpen, setTargetMenuOpen] = React.useState(false);
  const loadedInvocationIdRef = React.useRef<string | null>(null);

  React.useEffect(() => {
    if (!invocations) return;
    if (!existingEntry) {
      if (loadedInvocationIdRef.current === null) return;
      loadedInvocationIdRef.current = null;
      setPristineTitle('');
      setPristineToken('');
      setPristineTargetArtifactId('');
      setPristineBehavior('insert');
      setPristineAllowArgs(false);
      return;
    }

    const preserveDirty = loadedInvocationIdRef.current === existingEntry.id;
    const applyOptions = { preserveDirty };
    applyExternalTitle(existingEntry.title, applyOptions);
    applyExternalToken(existingEntry.token, applyOptions);
    applyExternalTargetArtifactId(existingEntry.target.artifactId, applyOptions);
    applyExternalBehavior(existingEntry.behavior, applyOptions);
    applyExternalAllowArgs(existingEntry.allowArgs, applyOptions);
    loadedInvocationIdRef.current = existingEntry.id;
  }, [
    applyExternalAllowArgs,
    applyExternalBehavior,
    applyExternalTargetArtifactId,
    applyExternalTitle,
    applyExternalToken,
    existingEntry?.allowArgs,
    existingEntry?.behavior,
    existingEntry?.id,
    existingEntry?.target.artifactId,
    existingEntry?.title,
    existingEntry?.token,
    hasInvocations,
    setPristineAllowArgs,
    setPristineBehavior,
    setPristineTargetArtifactId,
    setPristineTitle,
    setPristineToken,
  ]);

  React.useEffect(() => {
    if (!isNew) return undefined;
    publishPromptCollectionDraftTitle('template', title);
    return () => publishPromptCollectionDraftTitle('template', '');
  }, [isNew, title]);

  const changed = titleField.changed || tokenField.changed || targetField.changed || behaviorField.changed || allowArgsField.changed;
  // Saving makes the fields pristine, so a saved draft opens in its place without asking.
  const dirty = changed;
  const complete = title.trim().length > 0 && token.trim().length > 0 && targetArtifactId.trim().length > 0;
  const canSave = canWriteInvocations && complete && !saving && (isNew || changed);

  const updateToken = React.useCallback((next: string) => {
    setTokenError(null);
    setToken(next);
  }, [setToken]);

  const save = React.useCallback(async (): Promise<boolean> => {
    if (!canWriteInvocations || !invocations || !complete || saving) return false;

    const validation = validatePromptInvocationTokenV1({ token, entries: invocations.entries,
      excludingInvocationId: props.invocationId,
      actionTokens: listActionSpecs().filter((spec) => spec.surfaces.ui === true).flatMap((spec) => spec.slash?.tokens ?? []),
    });
    if (!validation.ok) {
      setTokenError(validation.reason === 'reserved' ? t('promptLibrary.templateTokenReserved')
        : validation.reason === 'actionCollision' ? t('promptLibrary.templateTokenConflictsWithAction')
        : validation.reason === 'duplicate' ? t('promptLibrary.templateTokenDuplicate') : t('promptLibrary.saveError'));
      return false;
    }
    const rawToken = validation.token;

    try {
      setSaving(true);
      const id = props.invocationId ?? randomUUID();
      const entry = PromptInvocationEntryV1Schema.parse({
        id,
        token: rawToken,
        title: title.trim(),
        target: existingEntry?.target.artifactId === targetArtifactId.trim()
          ? existingEntry.target
          : { kind: 'doc', artifactId: targetArtifactId.trim() },
        behavior,
        allowArgs,
        availableIn: 'global',
      });

      const nextEntries = props.invocationId
        ? invocations.entries.map((e) => (e.id === props.invocationId ? entry : e))
        : [...invocations.entries, entry];

      requireUpdatedPromptLibraryMutation(await writeInvocations({ ...invocations, entries: nextEntries }));
      setPristineTitle(entry.title);
      setPristineToken(entry.token);
      setPristineTargetArtifactId(entry.target.artifactId);
      setPristineBehavior(entry.behavior);
      setPristineAllowArgs(entry.allowArgs);
      if (!props.invocationId) setPendingHref(promptCollectionItemHref('template', id));
      return true;
    } catch {
      Modal.alert(t('common.error'), t('promptLibrary.saveError'));
      return false;
    } finally {
      setSaving(false);
    }
  }, [allowArgs, behavior, canWriteInvocations, complete, existingEntry, invocations, props.invocationId, saving, writeInvocations, setPristineAllowArgs, setPristineBehavior, setPristineTargetArtifactId, setPristineTitle, setPristineToken, targetArtifactId, title, token]);

  const leave = React.useCallback(() => setPendingHref(promptCollectionRoot('template')), []);
  React.useEffect(() => {
    if (!pendingHref) return;
    setPendingHref(null);
    router.replace(pendingHref as never);
  }, [pendingHref, router]);
  const discard = React.useCallback(() => {
    setTokenError(null);
    setPristineTitle(existingEntry?.title ?? '');
    setPristineToken(existingEntry?.token ?? '');
    setPristineTargetArtifactId(existingEntry?.target.artifactId ?? '');
    setPristineBehavior(existingEntry?.behavior ?? 'insert');
    setPristineAllowArgs(existingEntry?.allowArgs ?? false);
  }, [existingEntry, setPristineAllowArgs, setPristineBehavior, setPristineTargetArtifactId, setPristineTitle, setPristineToken]);
  useUnsavedDraftNavigationGuard({
    navigation,
    isDirty: dirty,
    onDiscard: discard,
    onSave: save,
    onLeave: leave,
    tag: 'PromptTemplateEditorScreen.leave',
  });

  const remove = React.useCallback(async () => {
    if (!props.invocationId || !canWriteInvocations || !invocations) return;
    const confirmed = await Modal.confirm(
      t('promptLibrary.deleteTemplate'),
      t('promptLibrary.deleteTemplateConfirm'),
      { confirmText: t('common.delete'), destructive: true },
    );
    if (!confirmed) return;
    try {
      requireUpdatedPromptLibraryMutation(await writeInvocations({ ...invocations, entries: invocations.entries.filter((e) => e.id !== props.invocationId) }));
      discard();
      leave();
    } catch {
      Modal.alert(t('common.error'), t('promptLibrary.saveError'));
    }
  }, [canWriteInvocations, discard, invocations, leave, props.invocationId, writeInvocations]);

  const menuActions = React.useMemo((): readonly PageHeaderMenuAction[] => (props.invocationId
    ? [{ id: 'delete', testID: 'promptTemplate.delete', title: t('common.delete'), onSelect: remove }]
    : [{ id: 'discard', testID: 'promptTemplate.discard', title: t('common.discard'), onSelect: () => { discard(); leave(); } }]),
  [discard, leave, props.invocationId, remove]);

  const behaviorOptions = React.useMemo(() => [
    { id: 'insert' as const, label: t('promptLibrary.templateBehaviorInsert'), description: t('promptLibrary.surface.behaviorInsertDescription') },
    { id: 'insert_on_send' as const, label: t('promptLibrary.templateBehaviorInsertOnSend'), description: t('promptLibrary.surface.behaviorInsertOnSendDescription') },
    { id: 'insert_and_send' as const, label: t('promptLibrary.templateBehaviorInsertAndSend'), description: t('promptLibrary.surface.behaviorInsertAndSendDescription') },
  ], []);

  return (
    <ItemList keyboardShouldPersistTaps="handled">
      <PromptEditorHeader
        testID="promptTemplate.header"
        mark="lightning"
        title={title.trim() || (isNew ? t('promptLibrary.newTemplate') : existingEntry?.title ?? t('promptLibrary.newTemplate'))}
        description={t('promptLibrary.surface.templateEditorDescription')}
        saveTestID="promptTemplate.save"
        saveDisabled={!canSave}
        saving={saving}
        onSave={() => { void save(); }}
        menuActions={menuActions}
      />

      <ItemGroup title={t('promptLibrary.surface.templateSection')} description={t('promptLibrary.surface.templateSectionDescription')}>
        <Item
          title={t('promptLibrary.surface.nameTitle')}
          accessoryLayout="adaptive"
          showChevron={false}
          rightElement={(
            <FieldTextInput
              testID="promptTemplate.title"
              value={title}
              onChangeText={setTitle}
              accessibilityLabel={t('promptLibrary.surface.nameTitle')}
              placeholder={t('promptLibrary.titlePlaceholder')}
              autoCapitalize="sentences"
              autoFocus={isNew}
            />
          )}
        />
        <Item
          title={t('promptLibrary.templateTokenLabel')}
          subtitle={t('promptLibrary.surface.tokenDescription')}
          accessoryLayout="adaptive"
          showChevron={false}
          rightElement={(
            <FieldTextInput
              testID="promptTemplate.token"
              value={token}
              onChangeText={updateToken}
              accessibilityLabel={t('promptLibrary.templateTokenLabel')}
              placeholder={t('promptLibrary.tokenPlaceholder')}
              autoCapitalize="none"
              monospace
              error={tokenError}
            />
          )}
        />
      </ItemGroup>

      <PromptDocSelectionGroup
        promptDocs={promptDocs}
        selectedArtifactId={targetArtifactId}
        onSelect={setTargetArtifactId}
        menuOpen={targetMenuOpen}
        onMenuOpenChange={setTargetMenuOpen}
      />

      <ItemGroup title={t('promptLibrary.templateBehavior')} description={t('promptLibrary.surface.behaviorSectionDescription')}>
        <SegmentedChoiceItem<TemplateBehavior>
          title={t('promptLibrary.surface.behaviorTitle')}
          options={behaviorOptions}
          value={behavior}
          onChange={setBehavior}
          testIDPrefix="promptTemplate.behavior"
        />
        <Item
          testID="promptTemplate.allowArgs"
          title={t('promptLibrary.templateAllowArgs')}
          subtitle={t('promptLibrary.templateAllowArgsSubtitle')}
          rightElement={<Switch value={allowArgs} onValueChange={setAllowArgs} />}
          showChevron={false}
        />
      </ItemGroup>
    </ItemList>
  );
});

PromptTemplateEditorScreen.displayName = 'PromptTemplateEditorScreen';
