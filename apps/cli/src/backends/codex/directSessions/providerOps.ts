import { configuration } from '@/configuration';
import { buildCodexSpawnRuntimeAffinityCompatFields } from '@happier-dev/agents';

import { createPollingDirectSessionFollowLease } from '@/api/directSessions/backgroundFollow/createPollingDirectSessionFollowLease';
import {
  mergeDirectSessionEnvironmentVariables,
  type DirectSessionProviderOps,
} from '@/backends/directSessions/providerOps';

import { getCodexDirectSessionActivity } from './getCodexDirectSessionActivity';
import { getCodexDirectSessionWorkingDirectory } from './getCodexDirectSessionWorkingDirectory';
import { listCodexSessionCandidates } from './listCodexSessionCandidates';
import { pageCodexTranscript } from './pageCodexTranscript';
import { readAfterCodexTranscript } from './readAfterCodexTranscript';
import { resolveCodexHomeEntriesForDirectSessionsSource } from './resolveCodexHomeEntriesForDirectSessionsSource';

export const codexDirectSessionProviderOps: DirectSessionProviderOps = {
  listCandidates: async ({ source, cursor, limit, searchTerm }) => {
    const res = await listCodexSessionCandidates({ source, activeServerDir: configuration.activeServerDir, cursor, limit, searchTerm });
    return { candidates: res.candidates, nextCursor: res.nextCursor ?? null };
  },
  getActivity: async ({ source, remoteSessionId }) => {
    const res = await getCodexDirectSessionActivity({ source, activeServerDir: configuration.activeServerDir, remoteSessionId });
    return {
      lastActivityAtMs: typeof res.lastActivityAtMs === 'number' && Number.isFinite(res.lastActivityAtMs) ? res.lastActivityAtMs : null,
      isRunning: false,
    };
  },
  pageTranscript: async ({ source, remoteSessionId, direction, cursor, maxBytes, maxItems }) => {
    const res = await pageCodexTranscript({
      source,
      activeServerDir: configuration.activeServerDir,
      remoteSessionId,
      direction,
      cursor,
      maxBytes,
      maxItems,
    });
    return {
      items: res.items,
      nextCursor: res.nextCursor ?? null,
      tailCursor: res.tailCursor ?? null,
      hasMore: res.hasMore,
      truncated: res.truncated === true,
    };
  },
  readAfterTranscript: async ({ source, remoteSessionId, cursor, maxBytes, maxItems }) => {
    const res = await readAfterCodexTranscript({
      source,
      activeServerDir: configuration.activeServerDir,
      remoteSessionId,
      cursor,
      maxBytes,
      maxItems,
    });
    return { items: res.items, nextCursor: res.nextCursor ?? null, truncated: res.truncated === true };
    },
    acquireFollowLease: async ({ source, remoteSessionId }) => createPollingDirectSessionFollowLease({
      readAfterTranscript: ({ cursor, maxBytes, maxItems }) =>
        readAfterCodexTranscript({
          source,
          activeServerDir: configuration.activeServerDir,
          remoteSessionId,
          cursor,
          maxBytes,
          maxItems,
        }),
    }),
    resolveTakeoverSpawnOptions: async ({ linked, sessionId }) => {
      const homeEntries = await resolveCodexHomeEntriesForDirectSessionsSource({
        source: linked.source,
        activeServerDir: configuration.activeServerDir,
        env: process.env,
      });
      const codexHome = homeEntries.length === 1 ? homeEntries[0]?.codexHome ?? null : null;
      const directory =
        linked.sessionPath ??
        (await getCodexDirectSessionWorkingDirectory({
        source: linked.source,
        activeServerDir: configuration.activeServerDir,
        remoteSessionId: linked.remoteSessionId,
        env: process.env,
        }));
      if (!directory || !codexHome) return null;
      return {
        directory,
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      existingSessionId: sessionId,
      resume: linked.remoteSessionId,
      approvedNewDirectoryCreation: true,
      transcriptStorage: 'direct',
      ...buildCodexSpawnRuntimeAffinityCompatFields(
        linked.codexBackendMode ? { backendMode: linked.codexBackendMode } : null,
      ),
      environmentVariables: mergeDirectSessionEnvironmentVariables([codexHome ? { CODEX_HOME: codexHome } : null]),
    };
  },
};
