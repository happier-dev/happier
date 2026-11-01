import * as React from 'react';

import {
  discardChange,
  type DiscardChangeMessages,
  type DiscardChangeResult,
} from '@/components/sessions/files/review/discardChange';
import { describeDiffHunkRange } from '@/components/ui/code/diff/hunks/DiffHunkRow';
import { decodeBase64 } from '@/encryption/base64';
import { workspaceReadFile } from '@/sync/ops/workspaceFileSystem/fileReadWrite';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import { t } from '@/text';
import type { HunkReviewActionTarget } from './useHunkReviewController';
import { readPresentationNotice, subscribePresentationNotices } from '@/components/sessions/presentation/presentationNotices';

function decodeUtf8(base64: string): string {
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
    decodeBase64(base64),
  );
}

/** The changed lines a review unit lands on (new side; old side for a pure deletion), for its label and Ask. */
export function rangeOfReviewUnit(
  target: HunkReviewActionTarget,
): Readonly<{ rangeStart: number; rangeEnd: number }> {
  const hunk = target.unit.hunk;
  let o = hunk.oldStart;
  let n = hunk.newStart;
  let added: [number, number] | null = null;
  let removed: [number, number] | null = null;
  for (const line of hunk.lines) {
    if (line.kind === 'add') added = added ? [added[0], n] : [n, n];
    if (line.kind === 'remove') removed = removed ? [removed[0], o] : [o, o];
    if (line.kind !== 'add') o += 1;
    if (line.kind !== 'remove') n += 1;
  }
  const range = added ?? removed ?? [hunk.newStart, hunk.newStart];
  return { rangeStart: range[0], rangeEnd: range[1] };
}

/**
 * Discard one review unit through `scm.change.discard` and keep its Undo until the next review action.
 * One owner for every review surface (File page Changes, the Review list); restore reuses its messages.
 */
export function useHunkDiscard(
  input: Readonly<{
    scope: WorkspaceScopeBase;
    sessionId: string | null;
    agentName?: string | null;
    machineName: string;
    /** The checkout's Machine is not answering: Discard says why instead of failing. */
    unreachable: boolean;
    refresh: () => void;
  }>,
) {
  const { scope, sessionId, machineName } = input;
  const target = React.useMemo(
    () => ({
      machineId: scope.machineId,
      rootPath: scope.rootPath,
      serverId: scope.serverId,
    }),
    [scope.machineId, scope.rootPath, scope.serverId],
  );
  const readCurrentTextFor = React.useCallback(
    (path: string, fileTarget = target) => async () => {
      const read = await workspaceReadFile(fileTarget, path);
      if (!read.success) throw new Error(read.error);
      return decodeUtf8(read.content);
    },
    [target],
  );
  const agent = input.agentName?.trim() || t('hunkReview.agentFallback');
  const messagesFor = React.useCallback(
    (path: string): DiscardChangeMessages => ({
      moved_on: t('hunkReview.noticeMovedOn'),
      update_required: t('hunkReview.noticeUpdateRequired', {
        machine: machineName,
      }),
      unsupported: t('hunkReview.noticeUnsupported'),
      unavailable: t('hunkReview.noticeUnavailable'),
      unknown: t('hunkReview.noticeUnknown'),
      discarded: t('hunkReview.noticeDiscarded'),
      restored: t('hunkReview.noticeRestored', {
        name: path.split('/').pop() ?? path,
      }),
      kept_edited: t('hunkReview.noticeKeptEdited'),
      undone: t('hunkReview.noticeUndone'),
      undo_conflict: t('hunkReview.noticeUndoConflict'),
      undo: t('hunkReview.undo'),
      note_failed: t('hunkReview.noticeNoteFailed', { agent }),
      undo_unavailable: t('hunkReview.noticeUndoUnavailable'),
    }),
    [machineName, agent],
  );
  const latestRefresh = React.useRef(input.refresh);
  latestRefresh.current = input.refresh;
  const refresh = React.useCallback(async () => {
    latestRefresh.current();
  }, []);
  const sessionTarget = React.useMemo(
    () => (sessionId ? { sessionId, serverId: scope.serverId } : undefined),
    [sessionId, scope.serverId],
  );

  const [latestResult, setLatestResult] = React.useState<DiscardChangeResult | null>(null);
  // File/lifetime cleanup stays stable when a new inverse is remembered.
  const latestResultRef = React.useRef(latestResult);
  latestResultRef.current = latestResult;
  const currentNotice = React.useSyncExternalStore(subscribePresentationNotices, readPresentationNotice, readPresentationNotice);
  const undoAvailable = Boolean(latestResult?.ok && latestResult.undo && currentNotice?.undo?.run === latestResult.undo);
  React.useEffect(() => {
    if (!latestResult?.ok || !latestResult.undo || undoAvailable) return;
    latestResult.retire();
    latestResultRef.current = null;
    setLatestResult(null);
  }, [latestResult, undoAvailable]);
  const retireUndo = React.useCallback(() => {
    const result = latestResultRef.current;
    latestResultRef.current = null;
    setLatestResult(null);
    if (result?.ok) result.retire();
  }, []);
  const remember = React.useCallback((result: DiscardChangeResult) => {
    latestResultRef.current = result;
    setLatestResult(result);
  }, []);
  const undo = React.useCallback(() => {
    const result = latestResultRef.current;
    if (!result?.ok || !result.undo || readPresentationNotice()?.undo?.run !== result.undo) return;
    latestResultRef.current = null;
    setLatestResult(null);
    void result.undo();
  }, []);

  const discardDisabledReason = input.unreachable
    ? t('hunkReview.discardNeeds', { machine: machineName })
    : null;
  const discard = React.useCallback(
    async (hunkTarget: HunkReviewActionTarget) => {
      const against =
        hunkTarget.source.kind === 'captured'
          ? {
              source: hunkTarget.source.comparison.source,
              comparisonId: hunkTarget.source.comparison.id,
              ...(sessionId ? { sessionId } : {}),
            }
          : { source: { kind: 'workingTree' as const } };
      const range = describeDiffHunkRange(rangeOfReviewUnit(hunkTarget));
      const fileTarget = {
        ...target,
        rootPath: hunkTarget.source.kind === 'captured'
          ? hunkTarget.source.comparison.repository.rootPath
          : hunkTarget.source.root,
      };
      const result = await discardChange({
        target: fileTarget,
        entry: {
          kind: 'comparison',
          path: hunkTarget.path,
          against,
          changeKeys: [hunkTarget.changeKey],
          ...(hunkTarget.expectedHash
            ? { expectedHash: hunkTarget.expectedHash }
            : {}),
        },
        messages: {
          ...messagesFor(hunkTarget.path),
          discarded: t('hunkReview.noticeDiscardedAt', { range }),
        },
        readCurrentText: readCurrentTextFor(hunkTarget.path, fileTarget),
        refresh,
        sessionTarget,
      });
      remember(result);
    },
    [
      target,
      sessionId,
      messagesFor,
      readCurrentTextFor,
      refresh,
      sessionTarget,
      remember,
    ],
  );

  return {
    target,
    discard,
    discardDisabledReason,
    undo,
    undoAvailable,
    retireUndo,
    remember,
    messagesFor,
    readCurrentTextFor,
    refresh,
    sessionTarget,
  };
}
