import * as React from 'react';
import { FileChangesScopeSchema, type FileChangesScope } from '@happier-dev/protocol/scm';

import type { SessionScmReviewComparison } from '@/components/sessions/panes/details/sessionDetailsTabBuilders';
import { listFilesComparisonScopeOptions } from '@/components/sessions/files/comparison/filesComparison';
import { useCapturedScmComparison } from '@/components/sessions/files/comparison/useCapturedScmComparison';
import { fileChangesComparisonOfScope, resolveFileChangesScope } from './fileChangesScope';

type CaptureParams = Parameters<typeof useCapturedScmComparison>[0];
export type FileChangesScopeView = Readonly<{ changesScope?: FileChangesScope }>;

/**
 * P3's per-tab view is the only scope state. Links supply an initial scope; UI and
 * file.view.set both change that same view. No agent-write subscription belongs here.
 */
export function useFileChangesScope(params: Readonly<{
    host: CaptureParams['host'];
    machine: CaptureParams['machine'];
    identity: CaptureParams['identity'];
    serverId?: CaptureParams['serverId'];
    active?: boolean;
    view?: FileChangesScopeView;
    onChangesScopeChange: (scope: FileChangesScope) => void;
    initialChanges?: SessionScmReviewComparison;
    latestTurnId?: string | null;
    knownComparison?: CaptureParams['knownComparison'];
    refreshLiveDiff?: () => void;
    filePath?: string;
}>) {
    const selection = React.useMemo(() => resolveFileChangesScope({ storedScope: params.view?.changesScope, initialChanges: params.initialChanges,
        sessionId: params.host.sessionId, latestTurnId: params.latestTurnId }),
    [params.view?.changesScope, params.initialChanges, params.host.sessionId, params.latestTurnId]);
    const { current, selector, turnId } = selection;
    const options = React.useMemo(() => listFilesComparisonScopeOptions({ showTurnViewToggle: true,
        showTurnAgentReportedViewToggle: false, showTurnCheckpointViewToggle: false, showSessionViewToggle: true },
    turnId, fileChangesComparisonOfScope(current)).filter(option =>
        option.sourceKind === 'workingTree' || option.sourceKind === 'session'
        || (option.sourceKind === 'turnCheckpoint' && (!option.comparison || (option.comparison.kind === 'turnCheckpoint' && !option.comparison.evidence)))),
    [turnId, current]);
    const captured = useCapturedScmComparison({ host: params.host, machine: params.machine, identity: params.identity,
        serverId: params.serverId, comparison: selector, active: params.active !== false && selection.capture,
        knownComparison: params.knownComparison, filePath: params.filePath });
    const setScope = React.useCallback((scope: FileChangesScope) => {
        params.onChangesScopeChange(FileChangesScopeSchema.parse(scope));
    }, [params.onChangesScopeChange]);
    const refresh = React.useCallback(() => {
        if (selection.capture) captured.retry();
        else params.refreshLiveDiff?.();
    }, [selection.capture, params.refreshLiveDiff, captured.retry]);
    const live = !selection.capture;
    return { options, current, setScope, selector, turnId, comparison: live ? null : captured.comparison,
        loading: live ? false : captured.loading, error: live ? null : captured.error,
        refresh, refreshAfterAction: refresh };
}
