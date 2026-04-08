import { listClaudeSessionCandidates } from './listClaudeSessionCandidates';
import { resolveClaudeConfigDir } from './resolveClaudeConfigDir';

import {
  mergeDirectSessionEnvironmentVariables,
  type DirectSessionProviderOps,
} from '@/backends/directSessions/providerOps';

import { acquireClaudeJsonlSessionStore, withClaudeJsonlSessionStore } from '../transcripts/sessionStore';

export const claudeDirectSessionProviderOps: DirectSessionProviderOps = {
  listCandidates: async ({ source, cursor, limit, searchTerm }) => {
    const res = await listClaudeSessionCandidates({ source, cursor, limit, searchTerm });
    return { candidates: res.candidates, nextCursor: res.nextCursor ?? null };
  },
  getActivity: async ({ source, remoteSessionId }) => {
    return withClaudeJsonlSessionStore({
      key: {
        providerId: 'claude',
        source,
        remoteSessionId,
      },
    }, async (store) => {
      const res = await store.getActivity();
      return {
        lastActivityAtMs: typeof res?.lastActivityAtMs === 'number' && Number.isFinite(res.lastActivityAtMs) ? res.lastActivityAtMs : null,
        isRunning: false,
      };
    });
  },
  pageTranscript: async ({ source, remoteSessionId, direction, cursor, maxBytes, maxItems }) => {
    if (direction !== 'older') {
      return {
        items: [],
        nextCursor: null,
        tailCursor: null,
        hasMore: false,
        truncated: false,
      };
    }
    return withClaudeJsonlSessionStore({
      key: {
        providerId: 'claude',
        source,
        remoteSessionId,
      },
    }, async (store) => {
      const res = await store.pageOlder({ cursor, maxBytes, maxItems });
      return {
        items: Array.from(res.items),
        nextCursor: res.nextCursor ?? null,
        tailCursor: res.tailCursor ?? null,
        hasMore: res.hasMore,
        truncated: res.truncated === true,
      };
    });
  },
  readAfterTranscript: async ({ source, remoteSessionId, cursor, maxBytes, maxItems }) => {
    return withClaudeJsonlSessionStore({
      key: {
        providerId: 'claude',
        source,
        remoteSessionId,
      },
    }, async (store) => {
      const res = await store.readAfter({ cursor, maxBytes, maxItems });
      return { items: Array.from(res.items), nextCursor: res.nextCursor ?? null, truncated: res.truncated === true };
    });
  },
  acquireFollowLease: async ({ source, remoteSessionId }) => {
    const lease = await acquireClaudeJsonlSessionStore({
      key: {
        providerId: 'claude',
        source,
        remoteSessionId,
      },
    });
    return {
      release: lease.release,
      getTailCursor: () => lease.store.getTailCursor(),
      subscribeToTranscriptUpdates: (listener) => lease.store.subscribe(async (event) => {
        await listener({
          items: Array.from(event.items),
          nextCursor: event.nextCursor,
          truncated: event.truncated,
        });
      }),
    };
  },
  resolveTakeoverSpawnOptions: async ({ linked, sessionId }) => {
    const configDir = resolveClaudeConfigDir({ source: linked.source, env: process.env });
    return withClaudeJsonlSessionStore({
      key: {
        providerId: 'claude',
        source: linked.source,
        remoteSessionId: linked.remoteSessionId,
      },
    }, async (store) => {
      const directory = linked.sessionPath ?? (await store.getWorkingDirectory());
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
    });
  },
};
