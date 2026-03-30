import type { Credentials } from '@/persistence';
import { readCredentials, readSettings } from '@/persistence';

import { resolveCliPromptStackSystemAppendBlocks } from './resolveCliPromptStackSystemAppendBlocks';

export async function resolveCliVoicePromptStackBlocks(args?: Readonly<{
  credentials?: Credentials | null | undefined;
  settings?: unknown;
  profileId?: string | null | undefined;
  cache?: Map<string, string | null>;
  fetchPromptArtifactRecord?: Parameters<typeof resolveCliPromptStackSystemAppendBlocks>[0]['fetchPromptArtifactRecord'];
}>): Promise<string[]> {
  const credentials = args?.credentials === undefined ? await readCredentials() : (args.credentials ?? null);
  if (!credentials) return [];

  const settings = args?.settings === undefined ? await readSettings() : args.settings;
  return await resolveCliPromptStackSystemAppendBlocks({
    surface: 'voice',
    credentials,
    settings,
    profileId: args?.profileId ?? null,
    cache: args?.cache,
    fetchPromptArtifactRecord: args?.fetchPromptArtifactRecord,
  });
}
