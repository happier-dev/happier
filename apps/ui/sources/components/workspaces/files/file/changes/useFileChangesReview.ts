import * as React from 'react';
import type { FileChangesScope, ScmWorkingEntry } from '@happier-dev/protocol/scm';

import type { SessionScmReviewComparison } from '@/components/sessions/panes/details/sessionDetailsTabBuilders';
import { useSessionTurnNumber } from '@/components/sessions/files/review/sessionTurnNumber';
import {
  useHunkReviewController,
  type HunkReviewActionTarget,
} from '@/components/workspaces/scm/review/hunkReview/useHunkReviewController';
import type { ReviewKeyboardController } from '@/components/workspaces/scm/review/hunkReview/useReviewKeyboard';
import { useCheckoutReachability } from '@/components/workspaces/reachability/checkoutReachability';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import { useSessionSelector } from '@/sync/store/hooks';
import { t } from '@/text';
import { useFileChangesActions } from './useFileChangesActions';
import { buildFileChangesLiveFiles } from './fileChangesNavigation';
import { rangeOfReviewUnit, useHunkDiscard } from '@/components/workspaces/scm/review/hunkReview/useHunkDiscard';
import { useWorkspaceFileOpener } from '@/components/workspaces/files/useWorkspaceFileOpener';
import { askAboutRanges, type AskSelectionTargetContext } from '@/components/ui/code/selection/askAboutRanges';
import { buildCodeLinesFromUnifiedDiff } from '@/components/ui/code/model/buildCodeLinesFromUnifiedDiff';
import { useAskSessionReveal } from '@/components/ui/code/selection/useAskSessionReveal';
import { resolveMachineAbsolutePath } from '@/sync/domains/fileSystem/resolveMachineAbsolutePath';
import { resolvePathRelativeToRoot } from '@/utils/path/resolvePathRelativeToRoot';
import {
  useFileChangesScope,
  type FileChangesScopeView,
} from './useFileChangesScope';

export type FileChangesScopeKind = 'turn' | 'session' | 'workingTree';

export type FileChangesReviewParams = Readonly<{
  scope: WorkspaceScopeBase;
  /** The Session the page was opened from; without one only Uncommitted exists. */
  sessionId?: string | null;
  filePath: string;
  /** The live snapshot diff the page already reads (Uncommitted). */
  liveDiff: string | null;
  /** The open file's actual working-snapshot status, for comparison Discard eligibility. */
  liveEntry?: Pick<ScmWorkingEntry, 'path' | 'kind' | 'hasIncludedDelta'> | null;
  refreshLiveDiff: () => void;
  /** Raw-byte hash of the file the displayed diff was computed on, when known. */
  contentHash?: string | null;
  view?: FileChangesScopeView;
  onChangesScopeChange: (scope: FileChangesScope) => void;
  initialChanges?: SessionScmReviewComparison;
  active: boolean;
  /** The Session's Agent display name, for copy that names it. */
  agentName?: string | null;
  onOpenFile?: (path: string, rootPath?: string) => void;
  /** The project the page belongs to; without a Session, other files open in it. */
  workspaceRefId?: string | null;
  /** The File page's same destination context used by selection Ask without a Session. */
  getAskTargetContext?: () => AskSelectionTargetContext;
  /** Uncommitted: the checkout's changed files in review order, so a reviewed file can lead to the next. */
  changedPaths?: readonly string[];
  hasUnsavedEdits?: () => boolean;
  onReplacedUnsavedEdits?: () => void;
  offerWholeTurnRollback?: (turnId: string) => void;
}>;

/**
 * The File page Changes region: scope, the displayed diff for it, the hunk review controller,
 * Discard / Restore / Undo and the restore menu items. One owner; the page places the strip,
 * the body and (phone) the bar it returns.
 */
export function useFileChangesReview(params: FileChangesReviewParams) {
  const { scope, filePath } = params;
  const sessionId = params.sessionId?.trim() || null;
  const reachability = useCheckoutReachability(scope);
  const opener = useWorkspaceFileOpener();
  const revealSessionColumn = useAskSessionReveal();
  const latestTurnId = useSessionSelector(
    sessionId ?? '',
    scope.serverId,
    React.useCallback(
      (session: Readonly<{ latestTurnId?: string | null }> | null) =>
        session?.latestTurnId ?? null,
      [],
    ),
  );
  const host = React.useMemo(
    () => (sessionId ? { sessionId } : { machineId: scope.machineId }),
    [sessionId, scope.machineId],
  );
  const machine = React.useMemo(
    () => ({ machineId: scope.machineId, basePath: scope.rootPath }),
    [scope.machineId, scope.rootPath],
  );
  const changes = useFileChangesScope({
    host,
    machine,
    identity: machine,
    serverId: scope.serverId,
    active: params.active,
    view: params.view,
    onChangesScopeChange: params.onChangesScopeChange,
    initialChanges: params.initialChanges,
    latestTurnId,
    refreshLiveDiff: params.refreshLiveDiff,
  });
  const current = changes.current;
  const captured = changes.comparison;
  const live = current.kind === 'workingTree';
  const capturedPath = captured ? resolvePathRelativeToRoot({
    path: resolveMachineAbsolutePath({ ...scope, requestPath: filePath, pathKind: 'workspace_entry' }),
    root: captured.repository.rootPath,
    preservePathSpelling: true,
  }) : null;
  const reviewPath = live ? filePath : capturedPath ?? filePath;
  const reviewScope = React.useMemo(() => captured && !live
    ? { ...scope, rootPath: captured.repository.rootPath } : scope, [scope, captured?.repository.rootPath, live]);
  const capturedFile =
    captured?.inventory.files.find((file) => file.path === capturedPath) ?? null;
  const capturedDiff =
    capturedFile?.evidence.state === 'available'
      ? capturedFile.evidence.unifiedDiff
      : null;
  const unifiedDiff = live ? params.liveDiff : capturedDiff;
  const turnId = changes.turnId;
  const turnNumber = useSessionTurnNumber(sessionId, scope.serverId, turnId);
  const machineName = reachability.machineName;

  const status: 'loading' | 'error' | 'empty' | 'ready' = live
    ? params.liveDiff === null
      ? 'loading'
      : params.liveDiff
        ? 'ready'
        : 'empty'
    : changes.loading && !captured
      ? 'loading'
      : changes.error && !captured
        ? 'error'
        : capturedDiff
          ? 'ready'
          : 'empty';

  // One discard / Undo owner with the Review list (`useHunkDiscard`); this page adds its file's restore.
  const hunkDiscard = useHunkDiscard({
    scope,
    sessionId,
    agentName: params.agentName,
    machineName,
    unreachable: reachability.unreachable,
    refresh: changes.refreshAfterAction,
  });
  const { target, refresh, sessionTarget, remember, retireUndo, undo, undoAvailable, discardDisabledReason } = hunkDiscard;
  const messages = React.useMemo(() => hunkDiscard.messagesFor(filePath), [hunkDiscard.messagesFor, filePath]);
  const readCurrentText = React.useMemo(() => hunkDiscard.readCurrentTextFor(reviewPath, { ...target, rootPath: reviewScope.rootPath }),
    [hunkDiscard.readCurrentTextFor, reviewPath, target, reviewScope.rootPath]);
  React.useEffect(() => retireUndo, [retireUndo, target, filePath]);
  const onDiscard = hunkDiscard.discard;

  // Ask about this change (`/`, row): the one Ask owner builds an anchored draft over the change's lines.
  const onAsk = React.useCallback(async (hunkTarget: HunkReviewActionTarget) => {
    if (!unifiedDiff) return;
    const range = rangeOfReviewUnit(hunkTarget);
    const deletion = !hunkTarget.unit.hunk.lines.some(line => line.kind === 'add');
    await askAboutRanges({
      workspaceScope: reviewScope,
      sessionTarget: sessionId ? { sessionId, revealSessionColumn } : null,
      targetContext: params.getAskTargetContext?.(),
      filePath: hunkTarget.path, source: 'diff', savedText: unifiedDiff,
      lines: buildCodeLinesFromUnifiedDiff({ unifiedDiff, hideFilePrelude: true }),
      ranges: [{ startLine: range.rangeStart, endLine: range.rangeEnd, side: deletion ? 'before' : 'after' }],
    });
  }, [sessionId, unifiedDiff, reviewScope, revealSessionColumn, params.getAskTargetContext]);

  const liveFiles = React.useMemo(
    () => live && params.changedPaths ? buildFileChangesLiveFiles(params.changedPaths, filePath, unifiedDiff ?? '') : undefined,
    [live, params.changedPaths, filePath, unifiedDiff],
  );
  const workspaceRefId = params.workspaceRefId?.trim() || null;
  const liveEntries = React.useMemo(() => live && params.liveEntry ? [params.liveEntry] : undefined, [live, params.liveEntry]);
  const controller = useHunkReviewController({
    liveFiles,
    liveEntries,
    source:
      live || !captured
        ? { kind: 'live', root: scope.rootPath }
        : { kind: 'captured', comparison: captured },
    path: reviewPath,
    unifiedDiff: unifiedDiff ?? '',
    contentHash: params.contentHash ?? null,
    host,
    serverId: scope.serverId,
    onDiscard,
    ...(sessionId || params.getAskTargetContext ? { onAsk } : {}),
    onOutOfDate: changes.refresh,
    discardDisabledReason,
    undo: undoAvailable ? undo : undefined,
    onReviewAction: retireUndo,
    onNavigate: (cursor) => {
      if (cursor.path === reviewPath) return;
      const rootPath = live ? undefined : captured?.repository.rootPath;
      if (params.onOpenFile) { params.onOpenFile(cursor.path, rootPath); return; }
      if (sessionId) void opener.open({ kind: 'session', sessionId, serverId: scope.serverId, path: cursor.path },
        { ...(rootPath ? { rootPath } : {}), view: 'changes', changesScope: current, intent: 'preview' });
      else if (workspaceRefId) void opener.open({ kind: 'project', workspaceRefId, serverId: scope.serverId,
        machineId: scope.machineId, rootPath: reviewScope.rootPath, path: cursor.path },
        { view: 'changes', changesScope: current, intent: 'preview' });
    },
  });
  // The File page numbers changes within this file, as its review line counts them.
  const hunks = React.useMemo(
    () => ({ ...controller.hunks, numberOffset: 0, numberTotal: controller.strip.total }),
    [controller.hunks, controller.strip.total],
  );

  // Whether the shown scope has changes for this file; Discard and Open Changes both read it.
  const changed = live ? Boolean(params.liveDiff) : capturedFile !== null;
  const restore = useFileChangesActions({
    target,
    messages,
    readCurrentText,
    refresh,
    sessionTarget,
    filePath: reviewPath,
    selector: changes.selector,
    comparison: captured,
    changed,
    expectedHash: params.contentHash ?? null,
    deleted: capturedFile?.changeKind === 'deleted',
    hasUnsavedEdits: params.hasUnsavedEdits ?? (() => false),
    onReplacedUnsavedEdits: params.onReplacedUnsavedEdits ?? (() => {}),
    confirmUnsaved: {
      title: t('hunkReview.replaceUnsavedTitle'),
      message: t('hunkReview.replaceUnsavedMessage'),
      confirmText: t('hunkReview.replace'),
    },
    ...(turnNumber !== null
      ? {
          restoreBeforeTurnTitle: t(
            'files.pane.menu.restoreBeforeTurn',
            { turn: turnNumber },
          ),
        }
      : {}),
    offerWholeTurnRollback: params.offerWholeTurnRollback,
  });
  React.useEffect(() => {
    if (restore.result) remember(restore.result);
  }, [restore.result]);

  const keyboard: ReviewKeyboardController = {
    next: controller.next,
    previous: controller.previous,
    keepCurrent: controller.keepCurrent,
    askCurrent: controller.askCurrent,
    discardCurrent: controller.discardCurrent,
    nextFile: controller.nextFile,
    previousFile: controller.previousFile,
    ...(undoAvailable ? { undo } : {}),
  };

  const scopeTabs = React.useMemo(() => {
    const tabs: { id: FileChangesScopeKind; label: string }[] = [];
    if (sessionId && turnId)
      tabs.push({ id: 'turn', label: t('hunkReview.scopeTurn') });
    if (sessionId)
      tabs.push({ id: 'session', label: t('hunkReview.scopeSession') });
    tabs.push({ id: 'workingTree', label: t('hunkReview.scopeUncommitted') });
    return tabs;
  }, [sessionId, turnId]);
  const selectScope = React.useCallback(
    (id: FileChangesScopeKind) => {
      retireUndo();
      if (id === 'turn') {
        if (turnId) changes.setScope({ kind: 'turn', turnId });
        return;
      }
      changes.setScope({ kind: id });
    },
    [changes.setScope, turnId, retireUndo],
  );

  return {
    changesScope: current,
    scopeKind: current.kind as FileChangesScopeKind,
    scopeTabs,
    selectScope,
    turnNumber,
    status,
    error: changes.error,
    unifiedDiff,
    capturedFile,
    comparison: captured,
    live,
    controller,
    hunks,
    reviewUnits: controller.reviewUnits,
    scrollToLineId: controller.revealHunk?.revealLineId,
    keyboard,
    discardDisabledReason: controller.discardDisabledReason,
    machineName,
    reachability,
    menuChanges: restore.changes,
    changed,
    refresh: changes.refresh,
    undoAvailable,
    undo,
  };
}

export type FileChangesReview = ReturnType<typeof useFileChangesReview>;
