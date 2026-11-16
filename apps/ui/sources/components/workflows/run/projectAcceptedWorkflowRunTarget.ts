import type {
    WorkflowProjectTargetV1,
} from '@happier-dev/protocol/workflows/workflowWorkspaceV1';

/**
 * Projects an immutable accepted descriptor back to the signed host target
 * accepted by a deliberate new Run. Historical checkout and invocation facts
 * describe the old Run and must not be presented as authority for the new one.
 */
export function projectAcceptedWorkflowRunTarget(
    project: Readonly<WorkflowProjectTargetV1>,
): WorkflowProjectTargetV1 {
    return {
        machineId: project.machineId,
        directory: project.directory,
        ...(project.workspaceRefId === undefined ? {} : { workspaceRefId: project.workspaceRefId }),
        ...(project.sessionPlacement === undefined ? {} : { sessionPlacement: project.sessionPlacement }),
    };
}
