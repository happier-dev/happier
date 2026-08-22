import {
  SPAWN_SESSION_ERROR_CODES,
  type SpawnSessionOptions,
  type SpawnSessionResult,
} from '@/session/shared/spawnSessionContract';
import { mergeSpawnSessionOptions } from '@/rpc/handlers/spawnSessionOptionsContract';

export async function runAutomationAsNewSession(params: {
  spawnSession: (options: SpawnSessionOptions) => Promise<SpawnSessionResult>;
  runId: string;
  template: SpawnSessionOptions;
}): Promise<SpawnSessionResult> {
  const normalizedRunId = params.runId.trim();
  if (!normalizedRunId) {
    return {
      type: 'error',
      errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
      errorMessage: 'automation run id is required for a new session',
    };
  }
  return await params.spawnSession(
    mergeSpawnSessionOptions(
      params.template,
      {
        approvedNewDirectoryCreation: true,
        spawnNonce: `automation:${normalizedRunId}`,
      },
      { omit: ['pendingFirstInput'] },
    ) as SpawnSessionOptions,
  );
}
