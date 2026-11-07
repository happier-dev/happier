import * as React from 'react';
import type { CustomModalInjectedProps } from '@/modal/types';
import { t } from '@/text';
import { presentShareSheet, type ShareSheetAnchor } from '../presentShareSheet';
import { TaskShareSheet, type TaskShareSheetProps } from './TaskShareSheet';

type TaskShareModalProps = CustomModalInjectedProps &
  Omit<TaskShareSheetProps, 'onRequestClose' | 'presentation'>;

function TaskShareModal(props: TaskShareModalProps): React.ReactElement {
  const { onClose, setChrome: _setChrome, ...sheet } = props;
  return (
    <TaskShareSheet {...sheet} presentation="full" onRequestClose={onClose} />
  );
}

/** The one share action for a task: popover from its Share control on wide layouts, a sheet on a phone. */
export function showTaskShareSheet(
  params: Omit<TaskShareSheetProps, 'onRequestClose' | 'presentation'> &
    Readonly<{
      title: string;
      anchor?: ShareSheetAnchor;
    }>,
): void {
  const { title, anchor, ...sheet } = params;
  presentShareSheet({
    component: TaskShareModal,
    props: sheet,
    testID: 'task-share-modal',
    title: t('shareSheet.tasks.shareTitle', { name: title }),
    ...(anchor ? { anchor } : {}),
  });
}
