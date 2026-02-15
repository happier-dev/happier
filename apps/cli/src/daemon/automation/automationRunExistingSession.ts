import type { SpawnSessionOptions, SpawnSessionResult } from '@/rpc/handlers/registerSessionHandlers';

export async function runAutomationAgainstExistingSession(params: {
  spawnSession: (options: SpawnSessionOptions) => Promise<SpawnSessionResult>;
  template: SpawnSessionOptions & { existingSessionId: string };
}): Promise<SpawnSessionResult> {
  return await params.spawnSession({
    directory: params.template.directory,
    approvedNewDirectoryCreation: true,
    existingSessionId: params.template.existingSessionId,
    ...(params.template.agent ? { agent: params.template.agent } : {}),
    ...(params.template.profileId !== undefined ? { profileId: params.template.profileId } : {}),
    ...(params.template.environmentVariables ? { environmentVariables: params.template.environmentVariables } : {}),
    ...(params.template.resume ? { resume: params.template.resume } : {}),
    ...(params.template.permissionMode ? { permissionMode: params.template.permissionMode } : {}),
    ...(typeof params.template.permissionModeUpdatedAt === 'number'
      ? { permissionModeUpdatedAt: params.template.permissionModeUpdatedAt }
      : {}),
    ...(params.template.modelId ? { modelId: params.template.modelId } : {}),
    ...(typeof params.template.modelUpdatedAt === 'number'
      ? { modelUpdatedAt: params.template.modelUpdatedAt }
      : {}),
    ...(params.template.terminal ? { terminal: params.template.terminal } : {}),
    ...(params.template.windowsRemoteSessionConsole
      ? { windowsRemoteSessionConsole: params.template.windowsRemoteSessionConsole }
      : {}),
    ...(params.template.experimentalCodexResume !== undefined
      ? { experimentalCodexResume: params.template.experimentalCodexResume }
      : {}),
    ...(params.template.experimentalCodexAcp !== undefined
      ? { experimentalCodexAcp: params.template.experimentalCodexAcp }
      : {}),
  });
}
