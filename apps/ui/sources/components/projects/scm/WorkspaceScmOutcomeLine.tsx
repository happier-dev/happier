import * as React from 'react';
import { Platform } from 'react-native';

import { GitOutcomeLine } from '@/components/sessions/panes/git/GitOutcomeLine';
import { selectScmWriteOperation } from '@/scm/operations/selectScmWriteOperation';
import { useWorkspaceScmInFlightOperation, useWorkspaceScmOperationLog } from '@/sync/domains/state/storage';
import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { executeWorkspaceScmCommitUndoLast } from './executeWorkspaceScmCommit';

/** Both workspace Git placements read the existing project write log and its single lifecycle owner. */
export function WorkspaceScmOutcomeLine(props: Readonly<{
    scope: WorkspaceScopeBase;
    snapshot: ScmWorkingSnapshot | null;
    selectedCount: number;
    writeEnabled: boolean;
    onRefresh: () => Promise<void>;
    onFetch?: () => void;
    onShowConflicts?: () => void;
}>) {
    const inFlight = useWorkspaceScmInFlightOperation(props.scope);
    const log = useWorkspaceScmOperationLog(props.scope);
    const operation = React.useMemo(() => selectScmWriteOperation({
        inFlight, log, machineReachable: true,
    }), [inFlight, log]);
    const undoCommit = props.writeEnabled && props.snapshot?.capabilities?.writeCommitUndoLast === true && !inFlight
        ? (expectedHeadOid: string) => {
            fireAndForget(executeWorkspaceScmCommitUndoLast({
                scope: props.scope, expectedHeadOid, refreshScmData: props.onRefresh,
            }), { tag: 'WorkspaceScmOutcomeLine.undo' });
        }
        : undefined;
    return (
        <GitOutcomeLine
            operation={operation}
            facts={{
                ahead: props.snapshot?.branch.ahead ?? 0,
                behind: props.snapshot?.branch.behind ?? 0,
                selectedCount: props.selectedCount,
                upstream: props.snapshot?.branch.upstream ?? null,
            }}
            machineName={null}
            recovery={{ refresh: () => { void props.onRefresh(); }, fetch: props.onFetch, showConflicts: props.onShowConflicts, undoCommit }}
            haptics={Platform.OS !== 'web'}
        />
    );
}
