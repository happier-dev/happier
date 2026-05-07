import {
  mergeDirectSessionEnvironmentVariables,
  type DirectSessionProviderOps,
} from '@/backends/directSessions/providerOps';

import { createPollingDirectSessionFollowLease } from '@/api/directSessions/backgroundFollow/createPollingDirectSessionFollowLease';
import { getOpenCodeDirectSessionActivity } from './getOpenCodeDirectSessionActivity';
import { getOpenCodeDirectSessionWorkingDirectory } from './getOpenCodeDirectSessionWorkingDirectory';
import { listOpenCodeSessionCandidates } from './listOpenCodeSessionCandidates';
import { pageOpenCodeTranscript } from './pageOpenCodeTranscript';
import { readAfterOpenCodeTranscript } from './readAfterOpenCodeTranscript';

export const openCodeDirectSessionProviderOps: DirectSessionProviderOps = {
  listCandidates: async ({ source, cursor, limit, searchTerm }) => {
    const res = await listOpenCodeSessionCandidates({ source, cursor, limit, searchTerm });
    return { candidates: res.candidates, nextCursor: res.nextCursor ?? null };
  },
  getActivity: async ({ source, remoteSessionId }) => {
    const res = await getOpenCodeDirectSessionActivity({ source, remoteSessionId });
    return {
      lastActivityAtMs: typeof res.lastActivityAtMs === 'number' && Number.isFinite(res.lastActivityAtMs) ? res.lastActivityAtMs : null,
      isRunning: res.isBusy === true,
    };
  },
  pageTranscript: async ({ source, remoteSessionId, direction, cursor, maxBytes, maxItems }) => {
    const res = await pageOpenCodeTranscript({ source, remoteSessionId, direction, cursor, maxBytes, maxItems });
    return {
      items: res.items,
      nextCursor: res.nextCursor ?? null,
      tailCursor: res.tailCursor ?? null,
      hasMore: res.hasMore,
      truncated: res.truncated === true,
    };
  },
  readAfterTranscript: async ({ source, remoteSessionId, cursor, maxBytes, maxItems }) => {
    const res = await readAfterOpenCodeTranscript({ source, remoteSessionId, cursor, maxBytes, maxItems });
    return { items: res.items, nextCursor: res.nextCursor ?? null, truncated: res.truncated === true };
  },
  acquireFollowLease: async ({ source, remoteSessionId }) => createPollingDirectSessionFollowLease({
    readAfterTranscript: ({ cursor, maxBytes, maxItems }) =>
      readAfterOpenCodeTranscript({ source, remoteSessionId, cursor, maxBytes, maxItems }),
  }),
  resolveTakeoverSpawnOptions: async ({ linked, sessionId }) => {
    const directory =
      linked.sessionPath ??
      (await getOpenCodeDirectSessionWorkingDirectory({
        source: linked.source,
        remoteSessionId: linked.remoteSessionId,
      }));
    if (!directory) return null;
    const baseUrl = linked.source.kind === 'opencodeServer' && typeof linked.source.baseUrl === 'string'
      ? linked.source.baseUrl.trim()
      : '';
    return {
      directory,
      backendTarget: { kind: 'builtInAgent', agentId: 'opencode' },
      existingSessionId: sessionId,
      resume: linked.remoteSessionId,
      approvedNewDirectoryCreation: true,
      transcriptStorage: 'direct',
      environmentVariables: mergeDirectSessionEnvironmentVariables([
        {
          HAPPIER_OPENCODE_BACKEND_MODE: 'server',
          ...(baseUrl ? { HAPPIER_OPENCODE_SERVER_URL: baseUrl } : {}),
          ...(baseUrl ? { HAPPIER_OPENCODE_SERVER_URL_EXPLICIT: '1' } : {}),
        },
      ]),
    };
  },
};
