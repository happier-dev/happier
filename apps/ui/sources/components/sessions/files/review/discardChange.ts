import type { ScmComparisonDiscardEntry, ScmChangeDiscardResultEntry } from '@happier-dev/protocol/scm';
import { decodeBase64 } from '@/encryption/base64';
import { machineScmChangeDiscard, type MachineScmCallOptions } from '@/sync/ops/scm/machineScm';
import { workspaceWriteFile } from '@/sync/ops/workspaceFileSystem/fileReadWrite';
import { machineWorkspaceFileReplaceApply } from '@/sync/ops/machineWorkspaceFileReplace';
import type { WorkspaceFileSystemTarget } from '@/sync/ops/workspaceFileSystem/directoryBrowsing';
import { downloadBulkPayloadViaDirectExportToDestination } from '@/sync/domains/transfers/runtime/transferRuntime';
import { publishPresentationNotice, readPresentationNotice, retirePresentationNotice, subscribePresentationNotices,
  type PresentationNotice } from '@/components/sessions/presentation/presentationNotices';
import { sendFileReviewNote } from './sendFileReviewNote';
import { t } from '@/text';

type FailureReason = 'moved_on' | 'update_required' | 'unsupported' | 'unavailable' | 'unknown';
export type DiscardChangeMessages = Readonly<Record<FailureReason | 'discarded' | 'restored' | 'kept_edited' | 'undone' | 'undo_conflict' | 'undo' | 'note_failed' | 'undo_unavailable', string>>;
export type DiscardUndoResult = Readonly<{ success: false }> | Readonly<{ success: true; noteDelivery?: 'queued' | 'failed' }>;
export type DiscardChangeResult =
  | Readonly<{ ok: true; entry: ScmChangeDiscardResultEntry; fileReplaced: boolean; undo?: () => Promise<DiscardUndoResult>; undoUnavailable?: true; retire: () => void; refreshFailed: boolean; noteDelivery?: 'queued' | 'failed' }>
  | Readonly<{ ok: false; reason: FailureReason }>;
export type DiscardChangeParams = Readonly<{
  target: WorkspaceFileSystemTarget;
  entry: Omit<ScmComparisonDiscardEntry, 'includeUndo'>;
  messages: DiscardChangeMessages;
  refresh: () => Promise<void>;
  options?: MachineScmCallOptions;
  sessionTarget?: Readonly<{ sessionId: string; serverId?: string | null }>;
}>;

async function readPreviousBytes(params: DiscardChangeParams, previous: NonNullable<ScmChangeDiscardResultEntry['previous']>): Promise<Uint8Array> {
  if ('inlineBase64' in previous) return decodeBase64(previous.inlineBase64);
  const parts: Uint8Array[] = [];
  let length = 0;
  const result = await downloadBulkPayloadViaDirectExportToDestination({ machineId: params.target.machineId,
    serverId: params.target.serverId, preparedExport: previous.export, releasePreparedExport: true,
    request: { t: 'workspace_file_download_v1', workingDirectory: params.target.rootPath, path: params.entry.path, asZip: false },
    destination: { writeBytes: async bytes => { parts.push(bytes.slice()); length += bytes.length; }, close: async () => {} } });
  if (!result.ok) throw new Error(result.error);
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.length; }
  return bytes;
}

function failureReason(errorCode?: string): FailureReason {
  if (errorCode === 'CHANGE_MOVED_ON' || errorCode === 'FILE_CHANGED') return 'moved_on';
  if (errorCode === 'INVALID_REQUEST') return 'update_required';
  if (errorCode === 'DISCARD_UNSUPPORTED') return 'unsupported';
  if (errorCode === 'COMPARISON_UNAVAILABLE') return 'unavailable';
  return 'unknown';
}

/** One present-user facade over scm.change.discard; selected-hunk Undo uses the restore Action. */
export async function discardChange(params: DiscardChangeParams): Promise<DiscardChangeResult> {
  const key = `file-review:${params.target.serverId ?? ''}:${params.target.machineId}:${params.target.rootPath}:${params.entry.path}`;
  let previousBytes: Uint8Array | undefined;
  let retired = false;
  let ownedNotice: PresentationNotice | null = null;
  let unsubscribe: (() => void) | undefined;
  const retire = () => {
    retired = true;
    previousBytes = undefined;
    unsubscribe?.();
    unsubscribe = undefined;
    if (ownedNotice && readPresentationNotice() === ownedNotice) retirePresentationNotice(key);
  };
  retirePresentationNotice(key);
  const notice = (message: string, severity: 'info' | 'error' = 'info') => publishPresentationNotice({ key, message, severity, sticky: true });
  const refresh = async () => { try { await params.refresh(); return true; } catch { return false; } };
  let response: Awaited<ReturnType<typeof machineScmChangeDiscard>>;
  try {
    response = await machineScmChangeDiscard(params.target.machineId, { cwd: params.target.rootPath,
      entries: [{ ...params.entry, includeUndo: true }] }, { ...params.options, serverId: params.target.serverId,
      ...(params.sessionTarget ? { authorization: { kind: 'session.write', sessionId: params.sessionTarget.sessionId } } : {}) });
  } catch {
    notice(params.messages.unknown, 'error');
    await refresh();
    return { ok: false, reason: 'unknown' };
  }
  if (!response.success) {
    const reason = failureReason(response.errorCode);
    notice(params.messages[reason], 'error');
    await refresh();
    return { ok: false, reason };
  }
  const entry = response.entries?.find(result => result.path === params.entry.path);
  if (!entry || entry.status === 'refused') {
    const reason = entry ? failureReason(entry.errorCode) : 'unknown';
    notice(params.messages[reason], 'error');
    await refresh();
    return { ok: false, reason };
  }
  const restore = !params.entry.changeKeys && !params.entry.changeRefs;
  let undo: (() => Promise<DiscardUndoResult>) | undefined;
  let undoUnavailable = false;
  if (entry.status !== 'recreated' && entry.status !== 'kept_edited' && (entry.inverseEdits || entry.previous)) {
    if (!entry.inverseEdits && entry.previous) {
      // The notice can outlive a transfer capability. Own the exact preimage
      // now, release its publication, and retain bytes only with this result.
      try { previousBytes = await readPreviousBytes(params, entry.previous); }
      catch { undoUnavailable = true; }
    }
    let pending: Promise<DiscardUndoResult> | undefined;
    if (!undoUnavailable) undo = () => pending ??= (async () => {
      if (retired) return { success: false };
      const retainedPrevious = previousBytes;
      retire();
      try {
        if (entry.inverseEdits) {
          if (entry.hashAfter === null) { notice(params.messages.undo_unavailable, 'error'); return { success: false }; }
          const result = await machineWorkspaceFileReplaceApply(params.target.machineId, {
            rootPath: params.target.rootPath,
            operation: { kind: 'restore', files: [{ path: params.entry.path, expectedHash: entry.hashAfter, edits: entry.inverseEdits }] },
          }, { serverId: params.target.serverId, onApprovalPending: approval => {
            publishPresentationNotice({ key, message: t('approvals.waitingForYou'), severity: 'info', sticky: true, approval });
          } });
          const restored = result.ok ? result.results.find(file => file.path === params.entry.path) : undefined;
          if (restored?.status !== 'restored') {
            notice(restored?.status === 'changed' ? params.messages.undo_conflict : params.messages.unknown, 'error');
            await refresh();
            return { success: false };
          }
        } else {
          if (!retainedPrevious) { notice(params.messages.undo_unavailable, 'error'); return { success: false }; }
          const result = await workspaceWriteFile(params.target, params.entry.path, retainedPrevious, entry.hashAfter, {
            onApprovalPending: approval => {
              publishPresentationNotice({ key, message: t('approvals.waitingForYou'), severity: 'info', sticky: true, approval });
            },
          });
          if (!result.success) {
            notice(['hash_mismatch', 'expected_file_absent', 'expected_file_missing'].includes(result.errorCode ?? '')
              ? params.messages.undo_conflict : params.messages.unknown, 'error');
            await refresh();
            return { success: false };
          }
        }
      } catch { notice(params.messages.unknown, 'error'); await refresh(); return { success: false }; }
      notice(params.messages.undone);
      await refresh();
      if (params.sessionTarget) {
        let queued = false;
        try { queued = (await sendFileReviewNote({ target: params.sessionTarget, action: 'undo', paths: [params.entry.path],
          undoes: restore ? 'restore' : 'discard',
          ...(params.entry.against.source.kind === 'turnCheckpoint' && typeof params.entry.against.source.turnId === 'string'
            ? { turnId: params.entry.against.source.turnId } : {}) })).ok; } catch { queued = false; }
        if (!queued) notice(params.messages.note_failed, 'error');
        return { success: true, noteDelivery: queued ? 'queued' : 'failed' };
      }
      return { success: true };
    })();
  }
  const message = undoUnavailable ? params.messages.undo_unavailable : response.noteDelivery?.status === 'failed' ? params.messages.note_failed
    : entry.status === 'kept_edited' ? params.messages.kept_edited : restore ? params.messages.restored : params.messages.discarded;
  ownedNotice = { key, severity: undoUnavailable || response.noteDelivery?.status === 'failed' ? 'error' : 'info', sticky: true, message,
    ...(undo ? { undo: { label: params.messages.undo, run: undo } } : {}) };
  publishPresentationNotice(ownedNotice);
  if (undo) unsubscribe = subscribePresentationNotices(() => {
    if (readPresentationNotice() !== ownedNotice) retire();
  });
  return { ok: true, entry, fileReplaced: entry.status !== 'kept_edited', ...(undo ? { undo } : {}), retire, refreshFailed: !await refresh(),
    ...(undoUnavailable ? { undoUnavailable: true } : {}),
    ...(response.noteDelivery ? { noteDelivery: response.noteDelivery.status } : {}) };
}
