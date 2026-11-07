import { AcpConfigOptionOverridesV1Schema, type AcpConfigOptionOverridesV1 } from '../sessions/metadata/metadataOverridesV1.js';
import type { SessionServerStartSpawnDraftV1 } from '../sessions/creation/sessionSpawnNewInputV2.js';
import type { WorkflowSessionAuthoringSelection } from './workflowV1.js';

/** Projects the canonical Session configuration onto its portable option selection. */
export function buildSessionConfigOptionOverridesFromServerStart(
  configuration: NonNullable<SessionServerStartSpawnDraftV1['configuration']>,
): AcpConfigOptionOverridesV1 | null {
  const entries = Object.entries(configuration.options);
  if (entries.length === 0) return null;
  return AcpConfigOptionOverridesV1Schema.parse({
    v: 1,
    updatedAt: Math.max(...entries.map(([, option]) => option.updatedAtMs)),
    overrides: Object.fromEntries(entries.map(([key, option]) => [key, {
      value: option.value,
      updatedAt: option.updatedAtMs,
    }])),
  });
}

/** The portable selection shared by Workflow authoring and legacy conversion. */
export function buildWorkflowSelectionFromServerStartSpawnDraftV1(
  spawn: SessionServerStartSpawnDraftV1,
): WorkflowSessionAuthoringSelection {
  const windows = spawn.terminal?.windows;
  const overrides = spawn.configuration === undefined
    ? null : buildSessionConfigOptionOverridesFromServerStart(spawn.configuration);
  return {
    agentTarget: spawn.agentTarget,
    ...(spawn.modelSelection === undefined ? {} : { modelSelection: spawn.modelSelection }),
    ...(spawn.profileId === undefined ? {} : { profileId: spawn.profileId }),
    ...(spawn.approvalProfileId === undefined ? {} : { approvalProfileId: spawn.approvalProfileId }),
    ...(spawn.permissionMode === undefined ? {} : { permissionMode: spawn.permissionMode }),
    ...(spawn.agentModeId === undefined ? {} : { acpSessionModeId: spawn.agentModeId }),
    ...(overrides === null ? {} : { sessionConfigOptionOverrides: overrides }),
    ...(spawn.capabilitySelection === undefined ? {} : { capabilitySelection: spawn.capabilitySelection }),
    ...(spawn.connectedServices === undefined ? {} : { connectedServices: spawn.connectedServices }),
    ...(spawn.transcriptStorage === undefined ? {} : { transcriptStorage: spawn.transcriptStorage }),
    ...(spawn.terminal === undefined ? {} : { terminal: spawn.terminal }),
    ...(windows?.launchMode === undefined ? {} : { windowsRemoteSessionLaunchMode: windows.launchMode }),
    ...(windows?.console === undefined ? {} : { windowsRemoteSessionConsole: windows.console }),
    ...(windows?.windowName === undefined ? {} : { windowsTerminalWindowName: windows.windowName }),
  };
}
