import * as React from 'react';
import { Modal } from '@/modal';
import { t } from '@/text';
import { runUnsavedChangesGuard, type ActiveUnsavedChangesGuard } from './runGuardedNavigation';
import { useUnsavedChangesBeforeRemoveGuard } from './useUnsavedChangesBeforeRemoveGuard';
import { promptUnsavedChangesAlert } from '@/utils/ui/promptUnsavedChangesAlert';

/** A route and its Add modal bind the same unsaved decision to their dismissal surfaces. */
export function useAuthoringDraftExitGuard(params: Readonly<{
  isDirty: boolean;
  isDirtyRef: React.MutableRefObject<boolean>;
  onDiscard: () => void;
  onSave?: () => Promise<boolean>;
  onContinue: (action: unknown) => void;
}>) {
  const ignoreRef = React.useRef(false);
  const requestDecision = React.useCallback(() => promptUnsavedChangesAlert(
    (title, message, buttons) => Modal.alert(title, message, buttons), {
      title: t('common.discardChanges'), message: t('common.unsavedChangesWarning'), discardText: t('common.discard'),
      ...(params.onSave ? { saveText: t('common.save') } : {}), keepEditingText: t('common.keepEditing'),
    }), [params.onSave]);
  const guard = React.useMemo<ActiveUnsavedChangesGuard>(() => ({ ...params, ignoreRef, requestDecision,
    tag: 'AuthoringDraft.beforeRemove' }), [params.isDirtyRef, params.onDiscard, params.onSave, requestDecision]);
  useUnsavedChangesBeforeRemoveGuard({ ...params, ignoreRef, requestDecision, tag: guard.tag });
  const requestExit = React.useCallback(() => runUnsavedChangesGuard(guard, () => {}), [guard]);
  return { requestExit, ignoreRef };
}
