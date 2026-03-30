import { getClaudeDirectSessionActivity } from './getClaudeDirectSessionActivity';
import { getClaudeDirectSessionWorkingDirectory } from './getClaudeDirectSessionWorkingDirectory';
import { listClaudeSessionCandidates } from './listClaudeSessionCandidates';
import { pageClaudeTranscript } from './pageClaudeTranscript';
import { readAfterClaudeTranscript } from './readAfterClaudeTranscript';
import { resolveClaudeConfigDirForDirectSessions } from './resolveClaudeConfigDir';

import {
  mergeDirectSessionEnvironmentVariables,
  type DirectSessionProviderOps,
} from '@/backends/directSessions/providerOps';

export const claudeDirectSessionProviderOps: DirectSessionProviderOps = {
  listCandidates: async ({ source, cursor, limit, searchTerm }) => {
    const res = await listClaudeSessionCandidates({ source, cursor, limit, searchTerm });
    return { candidates: res.candidates, nextCursor: res.nextCursor ?? null };
  },
  getActivity: async ({ source, remoteSessionId }) => {
    const res = await getClaudeDirectSessionActivity({ source, remoteSessionId });
    return {
      lastActivityAtMs: typeof res.lastActivityAtMs === 'number' && Number.isFinite(res.lastActivityAtMs) ? res.lastActivityAtMs : null,
      isRunning: false,
    };
  },
  pageTranscript: async ({ source, remoteSessionId, direction, cursor, maxBytes, maxItems }) => {
    const res = await pageClaudeTranscript({ source, remoteSessionId, direction, cursor, maxBytes, maxItems });
    return {
      items: res.items,
      nextCursor: res.nextCursor ?? null,
      tailCursor: res.tailCursor ?? null,
      hasMore: res.hasMore,
      truncated: res.truncated === true,
    };
  },
  readAfterTranscript: async ({ source, remoteSessionId, cursor, maxBytes, maxItems }) => {
    const res = await readAfterClaudeTranscript({ source, remoteSessionId, cursor, maxBytes, maxItems });
    return { items: res.items, nextCursor: res.nextCursor ?? null, truncated: res.truncated === true };
  },
  resolveTakeoverSpawnOptions: async ({ linked, sessionId }) => {
    const configDir = resolveClaudeConfigDirForDirectSessions({ source: linked.source, env: process.env });
    const directory =
      linked.sessionPath ??
      (await getClaudeDirectSessionWorkingDirectory({
        source: linked.source,
        remoteSessionId: linked.remoteSessionId,
        env: process.env,
      }));
    if (!directory) return null;
    return {
      directory,
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      existingSessionId: sessionId,
      resume: linked.remoteSessionId,
      approvedNewDirectoryCreation: true,
      transcriptStorage: 'direct',
      environmentVariables: mergeDirectSessionEnvironmentVariables([{ CLAUDE_CONFIG_DIR: configDir }]),
    };
  },
};
