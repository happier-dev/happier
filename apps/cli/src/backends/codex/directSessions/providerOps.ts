import {
  readRuntimeDescriptorV1FromMetadata,
  type DirectSessionsSource,
  type DirectTranscriptRawMessageV1,
  type RuntimeDescriptorV1,
} from '@happier-dev/protocol';
import { configuration } from '../../../configuration';
import {
  buildCodexSpawnRuntimeAffinityCompatFields,
} from '@happier-dev/agents';

import {
  createDirectSessionTranscriptProviderOps,
  mergeDirectSessionEnvironmentVariables,
  type DirectSessionProviderOps,
} from '@/session/directSessions/providerOps';

import { getCodexDirectSessionWorkingDirectory } from './getCodexDirectSessionWorkingDirectory';
import { listCodexSessionCandidates } from './listCodexSessionCandidates';
import { resolveCodexDirectSessionLinkIdentity } from './resolveCodexDirectSessionLinkIdentity';
import { homeEntries } from './homeEntries';
import { sourceValidation } from './sourceValidation';
import { resolveCodexRolloutDirectTranscriptSnapshot } from '../rollout/sessionStore/transcriptHistory';
import { acquireCodexRolloutSessionStore, withCodexRolloutSessionStore } from '../rollout/sessionStore/codexRolloutSessionStoreRegistry';

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export const codexDirectSessionProviderOps: DirectSessionProviderOps = {
  validateSource: ({ source, env }) => sourceValidation({ source, env }),
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
  ...createDirectSessionTranscriptProviderOps<DirectTranscriptRawMessageV1>({
    pageOlder: async ({ source, remoteSessionId, direction, cursor, maxBytes, maxItems }) => {
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
    readAfter: async ({ source, remoteSessionId, cursor, maxBytes, maxItems }) => {
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
  }),
  canonicalizeLinkedSession: async ({ metadata, remoteSessionId, source }) => {
    const directSession = asRecord(metadata.directSessionV1);
    const runtimeDescriptor = (
      readRuntimeDescriptorV1FromMetadata(directSession)
      ?? readRuntimeDescriptorV1FromMetadata(metadata)
    ) as RuntimeDescriptorV1 | null;
    const identity = resolveCodexDirectSessionLinkIdentity({
      remoteSessionId,
      source,
      runtimeDescriptor,
      metadata,
    });

    return {
      remoteSessionId: identity.remoteSessionId,
      source: identity.source,
    };
  },
  resolveLinkIdentity: async ({ remoteSessionId, source, runtimeDescriptor, metadata }) => {
    return resolveCodexDirectSessionLinkIdentity({ remoteSessionId, source, runtimeDescriptor, metadata });
  },
  resolveTakeoverSpawnOptions: async ({ linked, sessionId }) => {
    const snapshot = await resolveCodexRolloutDirectTranscriptSnapshot({
      source: linked.source,
      activeServerDir: configuration.activeServerDir,
      remoteSessionId: linked.remoteSessionId,
      env: process.env,
    });
    const codexHome = snapshot.rolloutHome;
    const fallbackHomeEntries = codexHome ? null : await homeEntries({
      source: linked.source,
      activeServerDir: configuration.activeServerDir,
      env: process.env,
    });
    const fallbackCodexHome = fallbackHomeEntries?.length === 1 ? fallbackHomeEntries[0]?.codexHome ?? null : null;
    const directory =
      linked.sessionPath ??
      (await getCodexDirectSessionWorkingDirectory({
        source: linked.source,
        activeServerDir: configuration.activeServerDir,
        remoteSessionId: linked.remoteSessionId,
        env: process.env,
      }));
    const effectiveCodexHome = codexHome ?? fallbackCodexHome;
    if (!directory || !effectiveCodexHome) return null;
    return {
      directory,
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      existingSessionId: sessionId,
      resume: linked.remoteSessionId,
      approvedNewDirectoryCreation: true,
      transcriptStorage: 'direct',
      ...buildCodexSpawnRuntimeAffinityCompatFields(
        linked.codexBackendMode ? { backendMode: linked.codexBackendMode } : null,
      ),
      environmentVariables: mergeDirectSessionEnvironmentVariables([effectiveCodexHome ? { CODEX_HOME: effectiveCodexHome } : null]),
    };
  },
};
