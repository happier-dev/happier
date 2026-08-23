import { createPollingDirectSessionFollowLease } from '@/api/directSessions/backgroundFollow/createPollingDirectSessionFollowLease';
import {
  mergeDirectSessionEnvironmentVariables,
  type DirectSessionProviderOps,
} from '@/backends/directSessions/providerOps';

import { getPiDirectSessionActivity } from './getPiDirectSessionActivity';
import { getPiDirectSessionWorkingDirectory } from './getPiDirectSessionWorkingDirectory';
import { listPiSessionCandidates } from './listPiSessionCandidates';
import { pagePiTranscript } from './pagePiTranscript';
import { readAfterPiTranscript } from './readAfterPiTranscript';
import { resolvePiAgentDir } from './resolvePiAgentDir';

export const piDirectSessionProviderOps: DirectSessionProviderOps = {
  listCandidates: async ({ source, cursor, limit, searchTerm, searchMode }) => {
    const res = await listPiSessionCandidates({ source, cursor, limit, searchTerm, searchMode });
    return {
      candidates: res.candidates,
      nextCursor: res.nextCursor ?? null,
      ...(res.searchIncomplete ? { searchIncomplete: true } : {}),
    };
  },

  getActivity: async ({ source, remoteSessionId }) => {
    const res = await getPiDirectSessionActivity({ source, remoteSessionId, env: process.env });
    return {
      lastActivityAtMs:
        typeof res.lastActivityAtMs === 'number' && Number.isFinite(res.lastActivityAtMs)
          ? res.lastActivityAtMs
          : null,
      // No live process probe in the direct-session model; liveness is owned by the follow-lease.
      isRunning: false,
    };
  },

  pageTranscript: async ({ source, remoteSessionId, direction, cursor, maxBytes, maxItems }) => {
    const res = await pagePiTranscript({ source, remoteSessionId, direction, cursor, maxBytes, maxItems, env: process.env });
    return {
      items: res.items,
      nextCursor: res.nextCursor ?? null,
      tailCursor: res.tailCursor ?? null,
      hasMore: res.hasMore,
      truncated: res.truncated === true,
    };
  },

  readAfterTranscript: async ({ source, remoteSessionId, cursor, maxBytes, maxItems }) => {
    const res = await readAfterPiTranscript({ source, remoteSessionId, cursor, maxBytes, maxItems, env: process.env });
    return { items: res.items, nextCursor: res.nextCursor ?? null, truncated: res.truncated === true };
  },

  acquireFollowLease: async ({ source, remoteSessionId }) =>
    createPollingDirectSessionFollowLease({
      readAfterTranscript: ({ cursor, maxBytes, maxItems }) =>
        readAfterPiTranscript({ source, remoteSessionId, cursor, maxBytes, maxItems, env: process.env }),
    }),

  resolveTakeoverSpawnOptions: async ({ linked, sessionId }) => {
    // Resume the pi session in place (pi --session <uuid>), launched from the session's own working
    // directory (read from the authoritative header cwd, not the ambiguously-encoded dir name).
    // PI_CODING_AGENT_DIR points pi at the same ~/.pi/agent the discovery scanner read from.
    const agentDir = resolvePiAgentDir({ source: linked.source, env: process.env });
    const directory =
      (await getPiDirectSessionWorkingDirectory({
        source: linked.source,
        remoteSessionId: linked.remoteSessionId,
        env: process.env,
      })) ?? linked.sessionPath;
    if (!directory) return null;

    return {
      directory,
      backendTarget: { kind: 'builtInAgent', agentId: 'pi' },
      existingSessionId: sessionId,
      resume: linked.remoteSessionId,
      approvedNewDirectoryCreation: true,
      transcriptStorage: 'direct',
      environmentVariables: mergeDirectSessionEnvironmentVariables([{ PI_CODING_AGENT_DIR: agentDir }]),
    };
  },
};
