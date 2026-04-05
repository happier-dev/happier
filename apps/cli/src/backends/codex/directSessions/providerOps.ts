import type { DirectTranscriptRawMessageV1 } from '@happier-dev/protocol';
import { configuration } from '@/configuration';
import { buildCodexSpawnRuntimeAffinityCompatFields } from '@happier-dev/agents';

import {
  mergeDirectSessionEnvironmentVariables,
  type DirectSessionProviderOps,
} from '@/backends/directSessions/providerOps';

import { getCodexDirectSessionWorkingDirectory } from './getCodexDirectSessionWorkingDirectory';
import { listCodexSessionCandidates } from './listCodexSessionCandidates';
import { resolveCodexHomeEntriesForDirectSessionsSource } from './resolveCodexHomeEntriesForDirectSessionsSource';
import { acquireCodexRolloutSessionStore, withCodexRolloutSessionStore } from '../rollout/sessionStore/codexRolloutSessionStoreRegistry';

export const codexDirectSessionProviderOps: DirectSessionProviderOps = {
  listCandidates: async ({ source, cursor, limit, searchTerm }) => {
    const res = await listCodexSessionCandidates({ source, activeServerDir: configuration.activeServerDir, cursor, limit, searchTerm });
    return { candidates: res.candidates, nextCursor: res.nextCursor ?? null };
  },
  getActivity: async ({ source, remoteSessionId }) => {
    const res = await withCodexRolloutSessionStore(
      {
        activeServerDir: configuration.activeServerDir,
        key: {
          providerId: 'codex',
          source,
          remoteSessionId,
        },
      },
      async (store): Promise<Readonly<{ lastActivityAtMs: number | null }>> => {
        const activity = (await store.getActivity()) as Readonly<{ lastActivityAtMs: number | null }> | null;
        return {
          lastActivityAtMs: activity?.lastActivityAtMs ?? null,
        };
      },
    );
    return {
      lastActivityAtMs: typeof res.lastActivityAtMs === 'number' && Number.isFinite(res.lastActivityAtMs) ? res.lastActivityAtMs : null,
      isRunning: false,
    };
  },
  pageTranscript: async ({ source, remoteSessionId, direction, cursor, maxBytes, maxItems }) => {
    const res = await withCodexRolloutSessionStore(
      {
        activeServerDir: configuration.activeServerDir,
        key: {
          providerId: 'codex',
          source,
          remoteSessionId,
        },
      },
      async (store): Promise<Readonly<{
        items: DirectTranscriptRawMessageV1[];
        nextCursor: string | null;
        tailCursor: string | null;
        hasMore: boolean;
        truncated: boolean;
      }>> => {
        const page = await store.pageOlder({ direction, cursor, maxBytes, maxItems });
        return {
          items: Array.from(page.items as readonly DirectTranscriptRawMessageV1[]),
          nextCursor: page.nextCursor,
          tailCursor: page.tailCursor,
          hasMore: page.hasMore,
          truncated: page.truncated,
        };
      },
    );
    return {
      items: res.items,
      nextCursor: res.nextCursor ?? null,
      tailCursor: res.tailCursor ?? null,
      hasMore: res.hasMore,
      truncated: res.truncated === true,
    };
  },
  readAfterTranscript: async ({ source, remoteSessionId, cursor, maxBytes, maxItems }) => {
    const res = await withCodexRolloutSessionStore(
      {
        activeServerDir: configuration.activeServerDir,
        key: {
          providerId: 'codex',
          source,
          remoteSessionId,
        },
      },
      async (store): Promise<Readonly<{
        items: DirectTranscriptRawMessageV1[];
        nextCursor: string | null;
        truncated: boolean;
      }>> => {
        const read = await store.readAfter({ cursor, maxBytes, maxItems });
        return {
          items: Array.from(read.items as readonly DirectTranscriptRawMessageV1[]),
          nextCursor: read.nextCursor,
          truncated: read.truncated,
        };
      },
    );
    return { items: res.items, nextCursor: res.nextCursor ?? null, truncated: res.truncated === true };
  },
  acquireFollowLease: async ({ source, remoteSessionId }) => {
    const lease = await acquireCodexRolloutSessionStore({
      activeServerDir: configuration.activeServerDir,
      key: {
        providerId: 'codex',
        source,
        remoteSessionId,
      },
    });
    return {
      release: lease.release,
      getTailCursor: () => lease.store.getTailCursor(),
      subscribeToTranscriptUpdates: (listener) => lease.store.subscribe(async (event) => {
        await listener({
          items: Array.from(event.items as readonly DirectTranscriptRawMessageV1[]),
          nextCursor: event.nextCursor,
          truncated: event.truncated,
        });
      }),
    };
  },
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
