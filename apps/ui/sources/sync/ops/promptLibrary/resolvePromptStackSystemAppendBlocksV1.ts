import { resolvePromptStackSystemAppendBlocksV1 as resolvePromptStackSystemAppendBlocksProtocolV1, type PromptStacksV1 } from '@happier-dev/protocol';
import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';

export async function resolvePromptStackSystemAppendBlocksV1(args: Readonly<{
  surface: 'coding' | 'voice';
  promptStacksV1: PromptStacksV1 | null | undefined;
  profileId: string | null | undefined;
  artifactsById: Record<string, DecryptedArtifact | undefined>;
  fetchArtifactWithBody?: (artifactId: string) => Promise<DecryptedArtifact | null>;
  updateArtifact?: (artifact: DecryptedArtifact) => void;
}>): Promise<string[]> {
  const readArtifactBody = async (artifactId: string): Promise<string | null> => {
    const existing = args.artifactsById[artifactId] ?? null;
    if (typeof existing?.body === 'string') return existing.body;
    if (!args.fetchArtifactWithBody) return null;

    const full = await args.fetchArtifactWithBody(artifactId);
    if (full && args.updateArtifact) args.updateArtifact(full);
    if (typeof full?.body === 'string') return full.body;

    const next = args.artifactsById[artifactId] ?? null;
    if (typeof next?.body === 'string') return next.body;
    return null;
  };

  return await resolvePromptStackSystemAppendBlocksProtocolV1({
    surface: args.surface,
    promptStacksV1: args.promptStacksV1,
    profileId: args.profileId,
    readArtifactBody,
  });
}
