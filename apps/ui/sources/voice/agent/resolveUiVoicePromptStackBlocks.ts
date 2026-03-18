import { storage } from '@/sync/domains/state/storage';
import { resolvePromptStackSystemAppendBlocksV1 } from '@/sync/ops/promptLibrary/resolvePromptStackSystemAppendBlocksV1';
import { getSyncSingleton } from '@/sync/runtime/getSyncSingleton';

export async function resolveUiVoicePromptStackBlocks(args?: Readonly<{ profileId?: string | null }>): Promise<string[]> {
  const state = storage.getState();
  return await resolvePromptStackSystemAppendBlocksV1({
    surface: 'voice',
    promptStacksV1: state.settings.promptStacksV1,
    profileId: args?.profileId ?? null,
    artifactsById: state.artifacts,
    fetchArtifactWithBody: async (artifactId) => await getSyncSingleton().fetchArtifactWithBody(artifactId),
    updateArtifact: (artifact) => state.updateArtifact(artifact),
  });
}
