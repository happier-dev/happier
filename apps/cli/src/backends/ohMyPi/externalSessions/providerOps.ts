import {
  mergeExternalSessionEnvironmentVariables,
  type ExternalSessionProviderOps,
} from '@/session/external/providerOps';
import { ohMyPiExternalSessionSurface } from '@happier-dev/plugins-ohmypi/agent/surfaces/sessions/external/provider';

import { resolveConfiguredOhMyPiAgentDir, resolveOhMyPiAgentDir } from './resolveOhMyPiAgentDir';
import { sourceValidation } from './sourceValidation';
import { withOhMyPiJsonlSessionStore } from '../transcripts/sessionStore';

type OhMyPiSurfaceResult<TValue> =
  | Readonly<{ ok: true; value: TValue }>
  | Readonly<{ ok: false; code?: string; message?: string }>;

type OhMyPiHostTranscriptPage = Awaited<ReturnType<ExternalSessionProviderOps['pageTranscript']>>;
type OhMyPiHostTranscriptReadAfter = Awaited<ReturnType<ExternalSessionProviderOps['readAfterTranscript']>>;
type OhMyPiHostTranscriptItem = OhMyPiHostTranscriptPage['items'][number];
type OhMyPiPluginTranscriptPage = Readonly<{
  items: readonly OhMyPiHostTranscriptItem[];
  nextCursor: string | null;
  tailCursor?: string | null;
  hasMore?: boolean;
  truncated?: boolean;
}>;
type OhMyPiPluginTranscriptReadAfter = Readonly<{
  items: readonly OhMyPiHostTranscriptItem[];
  nextCursor: string | null;
  truncated?: boolean;
}>;

async function unwrapOhMyPiSurfaceResult<TValue>(
  operation: string,
  result: OhMyPiSurfaceResult<TValue> | Promise<OhMyPiSurfaceResult<TValue>>,
): Promise<TValue> {
  const settled = await result;
  if (settled.ok) return settled.value;
  throw new Error(`OhMyPi external-session ${operation} failed: ${settled.message ?? settled.code ?? 'unavailable'}`);
}

async function unwrapOhMyPiOptionalFollowLease<TValue>(
  result: OhMyPiSurfaceResult<TValue> | Promise<OhMyPiSurfaceResult<TValue>>,
): Promise<TValue | null> {
  const settled = await result;
  if (settled.ok) return settled.value;
  if (settled.code === 'follow_not_supported') return null;
  throw new Error(`OhMyPi external-session acquireFollowLease failed: ${settled.message ?? settled.code ?? 'unavailable'}`);
}

function normalizeOhMyPiTranscriptPage(page: OhMyPiPluginTranscriptPage): OhMyPiHostTranscriptPage {
  return {
    items: [...page.items],
    nextCursor: page.nextCursor,
    tailCursor: page.tailCursor ?? null,
    hasMore: page.hasMore === true,
    truncated: page.truncated === true,
  };
}

function normalizeOhMyPiTranscriptReadAfter(page: OhMyPiPluginTranscriptReadAfter): OhMyPiHostTranscriptReadAfter {
  return {
    items: [...page.items],
    nextCursor: page.nextCursor,
    truncated: page.truncated === true,
  };
}

export const ohMyPiExternalSessionProviderOps: ExternalSessionProviderOps = {
  validateSource: ({ source, env }) => sourceValidation({ source, env: env ?? process.env }),
  listCandidates: async ({ source, cursor, limit, searchTerm, searchMode, runtime }) => {
    const res = await unwrapOhMyPiSurfaceResult(
      'listCandidates',
      ohMyPiExternalSessionSurface.listCandidates({
        source,
        cursor,
        limit,
        searchTerm,
        searchMode,
        runtime,
      }),
    );
    return {
      candidates: res.candidates,
      nextCursor: res.nextCursor ?? null,
      ...(res.searchIncomplete === true ? { searchIncomplete: true } : {}),
    };
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
  pageTranscript: async ({ source, remoteSessionId, direction, cursor, maxBytes, maxItems, runtime }) => {
    const page = await unwrapOhMyPiSurfaceResult(
      'pageTranscript',
      ohMyPiExternalSessionSurface.pageTranscript({
        source,
        providerSessionId: remoteSessionId,
        direction,
        cursor,
        maxBytes,
        maxItems,
        runtime,
      }),
    );
    return normalizeOhMyPiTranscriptPage(page);
  },
  readAfterTranscript: async ({ source, remoteSessionId, cursor, maxBytes, maxItems, runtime }) => {
    const readAfterTranscript = ohMyPiExternalSessionSurface.readAfterTranscript;
    if (!readAfterTranscript) {
      throw new Error('OhMyPi external-session readAfterTranscript failed: unavailable');
    }
    const page = await unwrapOhMyPiSurfaceResult(
      'readAfterTranscript',
      readAfterTranscript({
        source,
        providerSessionId: remoteSessionId,
        cursor,
        maxBytes,
        maxItems,
        runtime,
      }),
    );
    return normalizeOhMyPiTranscriptReadAfter(page);
  },
  resolveFollowTranscriptPath: async ({ source, remoteSessionId, reason, linkedSessionId, runtime }) => {
    return await unwrapOhMyPiSurfaceResult(
      'resolveFollowTranscriptPath',
      ohMyPiExternalSessionSurface.resolveFollowTranscriptPath!({
        source,
        providerSessionId: remoteSessionId,
        reason,
        linkedSessionId,
        runtime,
      }),
    );
  },
  acquireFollowLease: async ({ source, remoteSessionId, reason, linkedSessionId, runtime }) => {
    return await unwrapOhMyPiOptionalFollowLease(
      ohMyPiExternalSessionSurface.acquireFollowLease!({
        source,
        providerSessionId: remoteSessionId,
        reason,
        linkedSessionId,
        runtime,
      }),
    );
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
        backendTarget: { kind: 'backend', backendId: 'ohMyPi', sourceKind: 'built_in' },
        existingSessionId: sessionId,
        resume: linked.remoteSessionId,
        approvedNewDirectoryCreation: true,
        transcriptStorage: 'direct',
        environmentVariables: mergeExternalSessionEnvironmentVariables([
          { PI_CODING_AGENT_DIR: agentDir },
        ]),
      };
    });
  },
};
