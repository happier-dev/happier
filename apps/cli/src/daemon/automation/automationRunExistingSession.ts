import type { SpawnSessionOptions, SpawnSessionResult } from '@/rpc/handlers/registerSessionHandlers';
import { mergeSpawnSessionOptions } from '@/rpc/handlers/spawnSessionOptionsContract';

export async function runAutomationAgainstExistingSession(params: {
  spawnSession: (options: SpawnSessionOptions) => Promise<SpawnSessionResult>;
  template: SpawnSessionOptions & { existingSessionId: string };
}): Promise<SpawnSessionResult> {
  return await params.spawnSession(
    mergeSpawnSessionOptions(
      params.template,
      { approvedNewDirectoryCreation: true },
    ) as SpawnSessionOptions,
  );
}
