import * as React from 'react';
import { Platform } from 'react-native';

import { GitOutcomeLine } from '@/components/sessions/panes/git/GitOutcomeLine';
import { selectScmWriteOperation } from '@/scm/operations/selectScmWriteOperation';
import { useWorkspaceScmInFlightOperation, useWorkspaceScmOperationLog } from '@/sync/domains/state/storage';
import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { useProjectAccountWorkspaceRef } from '@/sync/domains/workspaces/projectAccountRows';
import { useProjectSaveAsSource } from '../ProjectSaveAsSourceSheet';
import { useProjectsSourcesComposition } from '../useProjectsSourcesComposition';
import { executeWorkspaceScmCommitUndoLast } from './executeWorkspaceScmCommit';

const NO_OPENED_SOURCES: ReadonlySet<string> = new Set();

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
    const facts = {
        ahead: props.snapshot?.branch.ahead ?? 0,
        behind: props.snapshot?.branch.behind ?? 0,
        selectedCount: props.selectedCount,
        upstream: props.snapshot?.branch.upstream ?? null,
    };
    const recovery = { refresh: () => { void props.onRefresh(); }, fetch: props.onFetch, showConflicts: props.onShowConflicts, undoCommit };
    // Only a refusal that asks for a repository mounts the Sources editor's composition (C4 `connect_repository`).
    if (operation && 'outcome' in operation && operation.outcome?.nextActions.some((next) => next.kind === 'connect_repository')) {
        return <ConnectRepositoryOutcomeLine scope={props.scope} operation={operation} facts={facts} recovery={recovery} />;
    }
    return <GitOutcomeLine operation={operation} facts={facts} machineName={null} recovery={recovery} haptics={Platform.OS !== 'web'} />;
}

/** Push with no repository source: the existing Project Sources editor for this checkout, as on Deployments. */
function ConnectRepositoryOutcomeLine(props: Readonly<{
    scope: WorkspaceScopeBase;
    operation: React.ComponentProps<typeof GitOutcomeLine>['operation'];
    facts: React.ComponentProps<typeof GitOutcomeLine>['facts'];
    recovery: React.ComponentProps<typeof GitOutcomeLine>['recovery'];
}>) {
    const checkout = useProjectAccountWorkspaceRef(props.scope.workspace?.workspaceId ?? null, props.scope.serverId);
    const composition = useProjectsSourcesComposition(NO_OPENED_SOURCES);
    const saveSource = useProjectSaveAsSource(composition);
    const recovery = React.useMemo(() => checkout
        ? { ...props.recovery, connectRepository: () => { void saveSource(checkout); } }
        : props.recovery, [checkout, props.recovery, saveSource]);
    return <GitOutcomeLine operation={props.operation} facts={props.facts} machineName={null} recovery={recovery} haptics={Platform.OS !== 'web'} />;
}
