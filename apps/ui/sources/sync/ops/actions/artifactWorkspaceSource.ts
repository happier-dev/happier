import type { ArtifactActionInputV1 } from '@happier-dev/protocol/artifacts/artifactActionsV1';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import { workspaceFileSystemTargetFromScope } from '@/sync/ops/workspaceFileSystem/workspaceTarget';

/** A source Session is admitted by caller custody, never by Artifact header metadata. */
export function readArtifactWorkspaceSourceSessionId(context: ActionExecutorContext): string | null {
    if (context.actionCaller?.kind === 'session') return context.actionCaller.sessionId;
    if (context.surface !== 'ui' || context.authority !== 'present_user' || context.actionCaller?.kind !== 'host'
        || context.externalActionCredential || context.externalActionExecutionAuthorization || context.rpcSessionAuthorization) return null;
    return context.defaultSessionId?.trim() ? context.defaultSessionId : null;
}

/** The Artifact acquisition input can name a physical Machine folder or its Session. */
export function artifactPublicationWorkspaceFromScope(
    scope: WorkspaceScopeBase,
): NonNullable<ArtifactActionInputV1<'artifact.publish_from_file'>['workspace']> | null {
    const target = workspaceFileSystemTargetFromScope(scope);
    return target.kind === 'managed' ? null : { machineId: target.machineId, rootPath: target.rootPath };
}
