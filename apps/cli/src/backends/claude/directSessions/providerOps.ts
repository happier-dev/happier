import { resolve } from 'node:path';

import { getClaudeDirectSessionActivity } from './getClaudeDirectSessionActivity';
import { getClaudeDirectSessionWorkingDirectory } from './getClaudeDirectSessionWorkingDirectory';
import { listClaudeSessionCandidates } from './listClaudeSessionCandidates';
import { pageClaudeTranscript } from './pageClaudeTranscript';
import { readAfterClaudeTranscript } from './readAfterClaudeTranscript';
import { resolveClaudeConfigDirForDirectSessions, resolveConfiguredClaudeConfigDir } from './resolveClaudeConfigDir';
import { resolveClaudeConfigDirEnvOverlay } from '../utils/resolveClaudeConfigDirEnvOverlay';
import { resolvePathForComparison } from '@/utils/path/normalizePathForComparison';

import { createPollingDirectSessionFollowLease } from '@/api/directSessions/backgroundFollow/createPollingDirectSessionFollowLease';
import {
  mergeDirectSessionEnvironmentVariables,
  type DirectSessionProviderOps,
} from '@/backends/directSessions/providerOps';

export const claudeDirectSessionProviderOps: DirectSessionProviderOps = {
  listCandidates: async ({ source, cursor, limit, searchTerm, searchMode }) => {
    const res = await listClaudeSessionCandidates({ source, cursor, limit, searchTerm, searchMode });
    return { candidates: res.candidates, nextCursor: res.nextCursor ?? null, ...(res.searchIncomplete ? { searchIncomplete: true } : {}) };
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
    return { ...res, nextCursor: res.nextCursor ?? null, truncated: res.truncated === true };
  },
  acquireFollowLease: async ({ source, remoteSessionId }) => createPollingDirectSessionFollowLease({
    readAfterTranscript: ({ cursor, maxBytes, maxItems }) =>
      readAfterClaudeTranscript({ source, remoteSessionId, cursor, maxBytes, maxItems }),
  }),
  resolveTakeoverSpawnOptions: async ({ linked, sessionId }) => {
    const configDir = resolveClaudeConfigDirForDirectSessions({ source: linked.source, env: process.env });
    const [sourceRoot, configuredRoot] = await Promise.all([
      resolvePathForComparison(resolve(configDir)),
      resolvePathForComparison(resolve(resolveConfiguredClaudeConfigDir({ env: process.env }))),
    ]);
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
      // A canonical transcript root does not record whether the native auth
      // environment set CLAUDE_CONFIG_DIR. Keep that environment for its own
      // store; a linked session in a different store still needs its pinned root.
      environmentVariables: mergeDirectSessionEnvironmentVariables([
        sourceRoot === configuredRoot
          ? resolveClaudeConfigDirEnvOverlay(process.env)
          : { CLAUDE_CONFIG_DIR: configDir },
      ]),
    };
  },
};
