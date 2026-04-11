import {
  mergeDirectSessionEnvironmentVariables,
  type DirectSessionProviderOps,
} from '@/backends/directSessions/providerOps';

import { listOhMyPiSessionCandidates } from './listOhMyPiSessionCandidates';
import { resolveConfiguredOhMyPiAgentDir, resolveOhMyPiAgentDir } from './resolveOhMyPiAgentDir';
import { validateOhMyPiDirectSessionsSource } from './validateOhMyPiDirectSessionsSource';
import { acquireOhMyPiJsonlSessionStore, withOhMyPiJsonlSessionStore } from '../transcripts/sessionStore';

export const ohMyPiDirectSessionProviderOps: DirectSessionProviderOps = {
  validateSource: ({ source, env }) => validateOhMyPiDirectSessionsSource({ source, env }),
  listCandidates: async ({ source, cursor, limit, searchTerm }) => {
    const res = await listOhMyPiSessionCandidates({ source, cursor, limit, searchTerm });
    return { candidates: res.candidates, nextCursor: res.nextCursor ?? null };
  },
  getActivity: async ({ source, remoteSessionId }) => {
    return withOhMyPiJsonlSessionStore({
      key: {
        providerId: 'ohMyPi',
        source,
        remoteSessionId,
      },
    }, async (store) => {
      const res = await store.getActivity();
      return {
        lastActivityAtMs: typeof res?.lastActivityAtMs === 'number' && Number.isFinite(res.lastActivityAtMs) ? res.lastActivityAtMs : null,
        isRunning: res?.isRunning === true,
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
    return withOhMyPiJsonlSessionStore({
      key: {
        providerId: 'ohMyPi',
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
    return withOhMyPiJsonlSessionStore({
      key: {
        providerId: 'ohMyPi',
        source,
        remoteSessionId,
      },
    }, async (store) => {
      const res = await store.readAfter({ cursor, maxBytes, maxItems });
      return {
        items: Array.from(res.items),
        nextCursor: res.nextCursor ?? null,
        truncated: res.truncated === true,
      };
    });
  },
  acquireFollowLease: async ({ source, remoteSessionId }) => {
    const lease = await acquireOhMyPiJsonlSessionStore({
      key: {
        providerId: 'ohMyPi',
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
  canonicalizeLinkedSession: async ({ remoteSessionId, source }) => {
    if (source.kind !== 'ohMyPiAgentDir') {
      return { remoteSessionId, source };
    }
    return {
      remoteSessionId,
      source: {
        ...source,
        agentDir: resolveConfiguredOhMyPiAgentDir(process.env),
      },
    };
  },
  resolveTakeoverSpawnOptions: async ({ linked, sessionId }) => {
    const agentDir = resolveOhMyPiAgentDir({ source: linked.source, env: process.env });
    return withOhMyPiJsonlSessionStore({
      key: {
        providerId: 'ohMyPi',
        source: linked.source,
        remoteSessionId: linked.remoteSessionId,
      },
    }, async (store) => {
      const directory = linked.sessionPath ?? (await store.getWorkingDirectory());
      if (!directory) return null;
      return {
        directory,
        backendTarget: { kind: 'builtInAgent', agentId: 'ohMyPi' },
        existingSessionId: sessionId,
        resume: linked.remoteSessionId,
        approvedNewDirectoryCreation: true,
        transcriptStorage: 'direct',
        environmentVariables: mergeDirectSessionEnvironmentVariables([
          { PI_CODING_AGENT_DIR: agentDir },
        ]),
      };
    });
  },
};
