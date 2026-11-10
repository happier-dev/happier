import type { SessionSpawnNewSelectionV2 } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewSelectionV2';
import type { WorkflowStepExecutionSelection, WorkflowWorkspaceDescriptorV1 } from '@happier-dev/protocol/workflows';

/** Apply resolved placement and admitted permission narrowing without changing the frozen model recipe. */
export function resolveWorkflowSessionLaunch(input: Readonly<{
  launch: SessionSpawnNewSelectionV2;
  selection: Pick<WorkflowStepExecutionSelection, 'permissionMode'>;
  workspace: WorkflowWorkspaceDescriptorV1;
}>): SessionSpawnNewSelectionV2 {
  const { launch, selection, workspace } = input;
  return { ...launch, directory: { kind: 'path', path: workspace.directory },
    ...(selection.permissionMode === 'read-only' ? { permissionMode: 'read-only',
      ...(launch.configuration ? { configuration: { ...launch.configuration,
        permissionIntent: { ...launch.configuration.permissionIntent, value: 'read-only' } } } : {}) } : {}),
  };
}
