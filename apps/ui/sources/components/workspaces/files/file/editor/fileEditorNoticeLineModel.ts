import type { SurfaceFreshnessAction } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import type { IconName } from '@/components/ui/icons/Icon';
import type { WorkspaceFileEditorHeaderModel } from '@/components/workspaces/files/details/workspaceFileDetails/workspaceFileEditorHeaderModel';
import { t } from '@/text';

export type FileEditorNoticeReachability = Readonly<{
  unreachable: boolean;
  machineName: string;
}>;

export type FileEditorNoticeLineModel = Readonly<{
  key: string;
  reason: string;
  emphasis?: string;
  tone: 'neutral' | 'warning';
  glyph?: IconName;
  actions: readonly SurfaceFreshnessAction[];
}>;

/**
 * The editor's one line under the header (files lab ED2, ED2o, ED2o-back). One cause at a time, in
 * order of what the person must act on: the agent's write (amber, the three ways forward), a save
 * waiting for approval, the Machine not answering (calm; editing goes on), the Machine back (Save is
 * the line's one primary), a refused save, then the quiet notes about drafts and line endings.
 */
export function resolveFileEditorNoticeLine(
  input: Readonly<{
    editor: WorkspaceFileEditorHeaderModel;
    editing: boolean;
    reachability: FileEditorNoticeReachability;
    agentName: string | null;
    onRetryReachability: () => void;
    /** Opens the save's approval review (the Inbox request); absent until the request exists. */
    onOpenApproval?: (() => void) | null;
  }>,
): FileEditorNoticeLineModel | null {
  const { editor, reachability, agentName } = input;
  if (!input.editing) return null;
  if (editor.conflict) {
    const emphasis = agentName
      ? t('files.editing.conflictByAgent', { agent: agentName })
      : t('files.editing.conflictOnDisk');
    return {
      key: 'conflict',
      tone: 'warning',
      emphasis,
      reason: `${emphasis} ${t('files.editing.editsKept')}`,
      actions: [
        {
          label: t('detailsSurface.file.compare'),
          onPress: editor.onCompare,
          emphasis: 'primary',
          testID: 'file-editor-conflict-compare',
        },
        {
          label: t('files.editing.useMine'),
          onPress: () => editor.onResolve('useMine'),
          testID: 'file-editor-conflict-use-mine',
        },
        {
          label: agentName
            ? t('files.editing.useAgents', { agent: agentName })
            : t('files.editing.useTheirs'),
          onPress: () => editor.onResolve('useTheirs'),
          testID: 'file-editor-conflict-use-theirs',
        },
      ],
    };
  }
  if (editor.refusal?.kind === 'awaitingApproval') {
    return {
      key: 'approval',
      tone: 'neutral',
      glyph: 'hourglass',
      reason: t('files.editing.awaitingApproval'),
      actions: input.onOpenApproval
        ? [{ label: t('approvals.review'), onPress: input.onOpenApproval, testID: 'file-editor-approval-review' }]
        : [],
    };
  }
  if (reachability.unreachable) {
    return {
      key: 'offline',
      tone: 'neutral',
      glyph: 'wifi-slash',
      // A save already pressed waits for the Machine and goes through when it answers (the pill reads
      // Saving), so the line no longer asks the person to save later.
      reason: editor.status === 'saving'
        ? t('files.editing.offlineSaving', { machine: reachability.machineName })
        : t('files.editing.offline', { machine: reachability.machineName }),
      actions: [
        {
          label: t('common.retry'),
          onPress: input.onRetryReachability,
          testID: 'file-editor-offline-retry',
        },
      ],
    };
  }
  if (editor.refusal?.kind === 'unreachable' && editor.status === 'dirty') {
    return {
      key: 'back',
      tone: 'neutral',
      glyph: 'check',
      reason: t('files.editing.backOnline', {
        machine: reachability.machineName,
      }),
      actions: [
        {
          label: t('common.save'),
          onPress: editor.onSave,
          emphasis: 'primary',
          testID: 'file-editor-back-save',
        },
      ],
    };
  }
  if (editor.refusal?.kind === 'failed') {
    return {
      key: 'failed',
      tone: 'warning',
      reason: t('files.editing.saveFailed'),
      actions: [
        {
          label: t('common.retry'),
          onPress: editor.onSave,
          testID: 'file-editor-save-retry',
        },
      ],
    };
  }
  if (editor.draftPersistenceFailed) {
    return {
      key: 'draft',
      tone: 'neutral',
      glyph: 'info',
      reason: t('files.editing.draftNotStored'),
      actions: [],
    };
  }
  if (editor.lineEndingNormalization) {
    return {
      key: 'eol',
      tone: 'neutral',
      glyph: 'info',
      actions: [],
      reason: t('files.editing.lineEndings', {
        ending: editor.lineEndingNormalization === 'crlf' ? 'CRLF' : 'LF',
      }),
    };
  }
  return null;
}

