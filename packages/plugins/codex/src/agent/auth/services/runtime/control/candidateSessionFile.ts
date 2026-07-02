import {
  resolveCodexConnectedServiceCandidatePersistedSessionFile as resolveCodexConnectedServiceCandidatePersistedSessionFilePolicy,
} from '../../home/sync/sessionFiles.js';
import { resolveConfiguredCodexHomePath } from '../../../../rollout/discovery/homeEntries.js';

export function resolveCodexConnectedServiceCandidatePersistedSessionFile(input: Readonly<{
  metadata: unknown;
  env?: NodeJS.ProcessEnv;
}>): string | null {
  return resolveCodexConnectedServiceCandidatePersistedSessionFilePolicy({
    metadata: input.metadata,
    codexHome: resolveConfiguredCodexHomePath(input.env ?? process.env),
  });
}
