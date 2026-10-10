import type { WorkflowProjectTargetV1 } from '@happier-dev/protocol/workflows';
import type { SessionDirectoryIntentV1 } from '@happier-dev/protocol';

import { resolveWorkspaceRefByScope } from '@/sync/domains/workspaces/workspaceRefs';
import type { WorkspaceRefV1 } from '@/sync/domains/workspaces/workspaceRefModel';
import { normalizeWorkspaceRootPath } from '@/sync/domains/workspaces/workspaceScope';

/**
 * The one owner of the authored Workflow project target.
 *
 * `workspaceRefId` is a binding to an Account WorkspaceRef, and the daemon
 * rejects the admitted Run with `workspace_conflict` when that ref no longer
 * names the selected directory. The editor therefore may not carry the id
 * along with an edited path: a change either proves the same project and keeps
 * the binding, rebinds to the ref that owns the new path, or drops it.
 *
 * This is only the Workflow value-shape adapter. Which Machine, which starting
 * folder and which checkout are New Session's owners — `MachineSelector`, the
 * shared default-directory policy and the one checkout picker — consumed by
 * `WorkflowProjectTargetControl`; this module turns their choice into the
 * Workflow target and keeps its binding truthful.
 */

type ProjectMutationContext = Readonly<{
    /** The Account server the authored target belongs to. */
    serverId: string | null;
    workspaceRefs: ReadonlyArray<WorkspaceRefV1>;
}>;

/** One-shot Session authoring can retain a managed intent; Workflow admission still requires a project. */
export type WorkflowAuthoringTarget = WorkflowProjectTargetV1 | Readonly<{
    machineId: string;
    directory: Extract<SessionDirectoryIntentV1, { kind: 'managed' }>;
    workspaceRefId?: never;
}>;

export function isWorkflowProjectTarget(target: WorkflowAuthoringTarget): target is WorkflowProjectTargetV1 {
    return typeof target.directory === 'string';
}

/**
 * The WorkspaceRef whose root **is** this directory, if the Account holds one.
 *
 * Only exact root identity binds. A ref whose root merely contains the
 * directory describes a different scope than the one the Run would resolve,
 * and guessing it is what produced stale bindings.
 */
export function resolveWorkflowProjectWorkspaceRefId(input: Readonly<{
    machineId: string;
    directory: string;
}> & ProjectMutationContext): string | undefined {
    const rootPath = normalizeWorkspaceRootPath(input.directory);
    const machineId = input.machineId.trim();
    if (rootPath === null || !machineId) return undefined;
    if (!input.serverId) return undefined;
    const result = resolveWorkspaceRefByScope(input.workspaceRefs, { serverId: input.serverId, machineId, rootPath });
    return result.kind === 'resolved' ? result.ref.id : undefined;
}

function withWorkspaceRefId(
    target: Readonly<{ machineId: string; directory: string }>,
    workspaceRefId: string | undefined,
): WorkflowProjectTargetV1 {
    return {
        machineId: target.machineId,
        directory: target.directory,
        ...(workspaceRefId === undefined ? {} : { workspaceRefId }),
    };
}

/**
 * Selects an exact Machine, keeping the directory only when the Machine is
 * unchanged. A different Machine cannot inherit the previous Machine's path or
 * its project binding.
 */
export function selectWorkflowProjectMachine(input: Readonly<{
    current: WorkflowAuthoringTarget | null;
    machineId: string;
    /** Where this Machine starts, resolved by the shared default-directory policy. */
    defaultDirectory: string;
}> & ProjectMutationContext): WorkflowAuthoringTarget {
    if (input.current !== null && input.current.machineId === input.machineId) return input.current;
    if (input.current !== null && !isWorkflowProjectTarget(input.current)) {
        return { machineId: input.machineId, directory: input.current.directory };
    }
    return withWorkspaceRefId(
        { machineId: input.machineId, directory: input.defaultDirectory },
        resolveWorkflowProjectWorkspaceRefId({
            machineId: input.machineId,
            directory: input.defaultDirectory,
            serverId: input.serverId,
            workspaceRefs: input.workspaceRefs,
        }),
    );
}

/**
 * Records an edited or browsed project folder.
 *
 * An unchanged path keeps the existing binding exactly — including a binding
 * this client cannot currently resolve, because an unhydrated Account settings
 * list is not evidence that the ref is gone. Any real change rebinds from the
 * Account's refs, which drops the id when nothing owns the new path.
 */
export function setWorkflowProjectDirectory(input: Readonly<{
    current: WorkflowAuthoringTarget;
    directory: string;
}> & ProjectMutationContext): WorkflowProjectTargetV1 {
    if (isWorkflowProjectTarget(input.current) && input.directory === input.current.directory) return input.current;
    const sameProject = isWorkflowProjectTarget(input.current) && normalizeWorkspaceRootPath(input.directory) !== null
        && normalizeWorkspaceRootPath(input.directory) === normalizeWorkspaceRootPath(input.current.directory);
    const workspaceRefId = sameProject
        ? input.current.workspaceRefId
        : resolveWorkflowProjectWorkspaceRefId({
            machineId: input.current.machineId,
            directory: input.directory,
            serverId: input.serverId,
            workspaceRefs: input.workspaceRefs,
        });
    return withWorkspaceRefId({ machineId: input.current.machineId, directory: input.directory }, workspaceRefId);
}
