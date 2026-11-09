import * as React from 'react';

import { useCheckoutReachability } from '@/components/workspaces/reachability/checkoutReachability';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import type { ReviewBlockHunkReview } from '../ChangedFilesReviewDiffBlock';
import { useHunkDiscard } from './useHunkDiscard';
import type { ScmComparison } from '@happier-dev/protocol/scm/comparison';
import type { ScmReviewedMarks } from '@/components/sessions/files/comparison/useScmReviewedMarks';
import { askAboutRanges } from '@/components/ui/code/selection/askAboutRanges';
import { buildCodeLinesFromUnifiedDiff } from '@/components/ui/code/model/buildCodeLinesFromUnifiedDiff';
import { formatHunk } from '@happier-dev/protocol/diff/hunks';
import { rangeOfReviewUnit } from './useHunkDiscard';
import { usePaneMainColumn } from '@/components/appShell/panes/mainColumn/usePaneMainColumn';
import type { HunkReviewActionTarget } from './useHunkReviewController';
import { t } from '@/text';

/**
 * Review effects for one admitted checkout and captured or live source. The list supplies its one
 * comparison cursor; `discard: false` offers Account-backed Keep without a file mutation.
 */
export function useReviewListHunkReview(
  input: Readonly<{
    scope: WorkspaceScopeBase;
    active?: boolean;
    sessionId?: string | null;
    agentName?: string | null;
    discard: boolean;
    refresh: () => void;
    comparison?: ScmComparison | null;
    marks?: ScmReviewedMarks;
  }>,
): ReviewBlockHunkReview {
  const reachability = useCheckoutReachability(input.scope);
  const sessionId = input.sessionId?.trim() || null;
  const mainColumn = usePaneMainColumn();
  const hunkDiscard = useHunkDiscard({
    scope: input.scope,
    sessionId,
    agentName: input.agentName,
    machineName: reachability.machineName,
    unreachable: reachability.unreachable,
    refresh: input.refresh,
  });
  const host = React.useMemo(
    () => (sessionId ? { sessionId } : { machineId: input.scope.machineId }),
    [sessionId, input.scope.machineId],
  );
  const { discard, discardDisabledReason, undo, undoAvailable, retireUndo } =
    hunkDiscard;
  const onAsk = React.useCallback(async (target: HunkReviewActionTarget) => {
    if (!sessionId) return;
    const unifiedDiff = formatHunk(target.unit.hunk);
    const range = rangeOfReviewUnit(target);
    const deletion = !target.unit.hunk.lines.some(line => line.kind === 'add');
    await askAboutRanges({ workspaceScope: input.scope,
      sessionTarget: { sessionId, revealSessionColumn: () => { if (mainColumn?.hidden) mainColumn.setHidden(false); } },
      filePath: target.path, source: 'diff', savedText: unifiedDiff,
      lines: buildCodeLinesFromUnifiedDiff({ unifiedDiff, hideFilePrelude: true }),
      ranges: [{ startLine: range.rangeStart, endLine: range.rangeEnd, side: deletion ? 'before' : 'after' }],
    });
  }, [sessionId, input.scope, mainColumn]);
  return React.useMemo(
    () => ({
      source: input.comparison ? { kind: 'captured' as const, comparison: input.comparison }
        : { kind: 'live' as const, root: input.scope.rootPath },
      host,
      active: input.active,
      marks: input.marks,
      writeUnavailableReason: reachability.unreachable ? t('walkthrough.notice.offlineA11y') : null,
      serverId: input.scope.serverId ?? null,
      ...(input.discard ? { onDiscard: discard, discardDisabledReason } : {}),
      ...(undoAvailable ? { undo } : {}),
      onReviewAction: retireUndo,
      onOutOfDate: input.refresh,
      ...(sessionId ? { onAsk } : {}),
    }),
    [
      input.scope.rootPath,
      input.active,
      input.scope.serverId,
      input.comparison,
      input.marks,
      reachability.unreachable,
      input.refresh,
      sessionId,
      onAsk,
      host,
      input.discard,
      discard,
      discardDisabledReason,
      undoAvailable,
      undo,
      retireUndo,
    ],
  );
}
