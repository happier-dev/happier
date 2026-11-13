import * as React from 'react';

import type { CustomModalInjectedProps } from '@/modal';
import { SessionSelectionModal, type SessionSelectionIdentity } from '@/components/sessions/selection/SessionSelectionModal';
import { t } from '@/text';

export type PromptRuntimePreviewSessionSelection = SessionSelectionIdentity | undefined;

export type PromptRuntimePreviewSessionSelectionModalProps = CustomModalInjectedProps & Readonly<{
  onResolve: (selection: PromptRuntimePreviewSessionSelection) => void;
}>;

export function selectLivePromptPreviewSessions<
  T extends Readonly<{ active?: boolean; presence?: unknown }>,
>(sessions: ReadonlyArray<T>): ReadonlyArray<T> {
  return sessions.filter((session) => session.active === true && session.presence === 'online');
}

export function PromptRuntimePreviewSessionSelectionModal(
  props: PromptRuntimePreviewSessionSelectionModalProps,
) {
  return (
    <SessionSelectionModal
      {...props}
      testID="prompt-runtime-preview-session-selection"
      title={t('promptLibrary.runtimePreviewSessionPickerTitle')}
      subtitle={t('promptLibrary.runtimePreviewSessionPickerSubtitle')}
      searchPlaceholder={t('promptLibrary.runtimePreviewSessionPickerSearch')}
      emptyStateLabel={t('promptLibrary.runtimePreviewSessionPickerEmpty')}
      selectSessions={selectLivePromptPreviewSessions}
      onSelectSession={props.onResolve}
      onDismiss={() => props.onResolve(undefined)}
    />
  );
}
