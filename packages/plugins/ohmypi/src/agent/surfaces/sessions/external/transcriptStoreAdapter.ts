import type {
  ExternalSessionFollowTranscriptPathResolutionV1,
  ExternalSessionTranscriptPageV1,
  ExternalSessionTranscriptRawMessageV1,
  ExternalSessionsSource,
} from '@happier-dev/plugin-sdk/sessions';
import type { ExternalSessionActivityResultV1 } from '@happier-dev/plugin-sdk';

import { readOhMyPiSessionSnapshot } from '../../../transcripts/snapshot.js';
import { resolveOhMyPiSessionFile } from './files.js';
import { resolveOhMyPiAgentDir } from './source.js';
import {
  pageOhMyPiSessionTranscript,
  readAfterOhMyPiSessionTranscript,
} from './transcript.js';

type ProviderStoreKey = Readonly<{
  agentId: string;
  source: ExternalSessionsSource;
  providerSessionId?: string;
  remoteSessionId?: string;
}>;

type PageParams = Readonly<{
  direction?: 'older' | 'newer';
  cursor?: string;
  maxBytes?: number;
  maxItems?: number;
}>;

type ReadAfterParams = Readonly<{
  cursor?: string;
  maxBytes?: number;
  maxItems?: number;
}>;

type StoreLifecycleState =
  | 'hot_attached'
  | 'warm_detached'
  | 'cold_idle'
  | 'disposed';

type StoreUpdateListener = (event: Readonly<{
  items: readonly ExternalSessionTranscriptRawMessageV1[];
  nextCursor: string | null;
  truncated: boolean;
}>) => void | Promise<void>;

type OhMyPiTranscriptStore = Readonly<{
  warm(): Promise<void>;
  dispose(): Promise<void>;
  setLifecycleState(state: StoreLifecycleState): Promise<void>;
  pageOlder(params?: PageParams): Promise<ExternalSessionTranscriptPageV1>;
  readAfter(params?: ReadAfterParams): Promise<Readonly<{
    items: readonly ExternalSessionTranscriptRawMessageV1[];
    nextCursor: string | null;
    truncated: boolean;
  }>>;
  getTailCursor(): string | null;
  subscribe(listener?: StoreUpdateListener): () => void;
  getTitle(): Promise<string | null>;
  getWorkingDirectory(): Promise<string | null>;
  getActivity(): Promise<ExternalSessionActivityResultV1 | null>;
  getPreview(): Promise<string | null>;
}>;

type OhMyPiTranscriptStoreLease = Readonly<{
  key: ProviderStoreKey;
  store: OhMyPiTranscriptStore;
  release(): Promise<void>;
}>;

type CreateOhMyPiExternalSessionTranscriptStoreAdapterParams = Readonly<{
  env?: NodeJS.ProcessEnv;
}>;

function resolveProviderSessionId(key: ProviderStoreKey): string {
  const sessionId = key.providerSessionId ?? key.remoteSessionId;
  if (!sessionId) {
    throw new Error('OhMyPi external-session transcript store requires a provider session id.');
  }
  return sessionId;
}

function resolveMaxBytes(params?: Readonly<{ maxBytes?: number }>): number {
  return Math.max(1024, Math.trunc(params?.maxBytes ?? 1024 * 1024));
}

function resolveMaxItems(params?: Readonly<{ maxItems?: number }>): number {
  return Math.max(1, Math.trunc(params?.maxItems ?? 100));
}

function resolveFollowPollIntervalMs(env: NodeJS.ProcessEnv): number {
  const raw = Number.parseInt(String(env.HAPPIER_EXTERNAL_SESSIONS_OH_MY_PI_FOLLOW_POLL_INTERVAL_MS ?? ''), 10);
  const configured = Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 250;
  return Math.max(25, Math.min(5_000, configured));
}

async function readSnapshotMetadata(params: Readonly<{
  key: ProviderStoreKey;
  env: NodeJS.ProcessEnv;
}>): Promise<Readonly<{
  title: string | null;
  workingDirectory: string | null;
  activity: ExternalSessionActivityResultV1;
}> | null> {
  const providerSessionId = resolveProviderSessionId(params.key);
  const resolved = await resolveOhMyPiSessionFile({
    source: params.key.source,
    env: params.env,
    remoteSessionId: providerSessionId,
  });
  if (!resolved) return null;

  const snapshot = await readOhMyPiSessionSnapshot({
    sessionFilePath: resolved.filePath,
    sessionId: providerSessionId,
  });
  return {
    title: snapshot.title,
    workingDirectory: snapshot.workingDirectory,
    activity: {
      lastActivityAtMs: snapshot.lastActivityAtMs,
      isRunning: false,
    },
  };
}

function createOhMyPiTranscriptStore(params: Readonly<{
  key: ProviderStoreKey;
  env: NodeJS.ProcessEnv;
}>): OhMyPiTranscriptStore {
  const listeners = new Set<StoreUpdateListener>();
  let tailCursor: string | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let pollInFlight = false;
  let disposed = false;

  async function pageOlder(pageParams?: PageParams): Promise<ExternalSessionTranscriptPageV1> {
    const page = await pageOhMyPiSessionTranscript({
      source: params.key.source,
      env: params.env,
      providerSessionId: resolveProviderSessionId(params.key),
      direction: pageParams?.direction ?? 'older',
      cursor: pageParams?.cursor,
      maxBytes: resolveMaxBytes(pageParams),
      maxItems: resolveMaxItems(pageParams),
    });
    tailCursor = page.tailCursor ?? tailCursor;
    return page;
  }

  async function readAfter(readParams?: ReadAfterParams): Promise<Readonly<{
    items: readonly ExternalSessionTranscriptRawMessageV1[];
    nextCursor: string | null;
    truncated: boolean;
  }>> {
    const page = await readAfterOhMyPiSessionTranscript({
      source: params.key.source,
      env: params.env,
      providerSessionId: resolveProviderSessionId(params.key),
      cursor: readParams?.cursor ?? tailCursor ?? 'tail',
      maxBytes: resolveMaxBytes(readParams),
      maxItems: resolveMaxItems(readParams),
    });
    tailCursor = page.nextCursor ?? tailCursor;
    return {
      items: page.items,
      nextCursor: page.nextCursor,
      truncated: page.truncated ?? false,
    };
  }

  async function poll(): Promise<void> {
    if (pollInFlight || disposed || listeners.size === 0) return;
    pollInFlight = true;
    try {
      const previousTailCursor = tailCursor;
      const page = await readAfter({
        cursor: previousTailCursor ?? 'tail',
        maxBytes: 1024 * 1024,
        maxItems: 100,
      });
      if (previousTailCursor === null || page.items.length === 0) return;
      await Promise.all([...listeners].map((listener) => listener(page)));
    } finally {
      pollInFlight = false;
    }
  }

  function stopPolling(): void {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  function startPolling(): void {
    if (pollTimer || disposed) return;
    void poll();
    pollTimer = setInterval(() => {
      void poll();
    }, resolveFollowPollIntervalMs(params.env));
    pollTimer.unref?.();
  }

  async function dispose(): Promise<void> {
    disposed = true;
    listeners.clear();
    stopPolling();
  }

  return Object.freeze({
    warm: async () => undefined,
    dispose,
    setLifecycleState: async (state) => {
      if (state === 'disposed') {
        await dispose();
      }
    },
    pageOlder,
    readAfter,
    getTailCursor: () => tailCursor,
    subscribe: (listener) => {
      if (listener) {
        listeners.add(listener);
        startPolling();
      }
      return () => {
        if (listener) {
          listeners.delete(listener);
        }
        if (listeners.size === 0) {
          stopPolling();
        }
      };
    },
    getTitle: async () => (await readSnapshotMetadata(params))?.title ?? null,
    getWorkingDirectory: async () => (await readSnapshotMetadata(params))?.workingDirectory ?? null,
    getActivity: async () => (await readSnapshotMetadata(params))?.activity ?? {
      lastActivityAtMs: null,
      isRunning: false,
    },
    getPreview: async () => null,
  });
}

export function createOhMyPiExternalSessionTranscriptStoreAdapter(
  params: CreateOhMyPiExternalSessionTranscriptStoreAdapterParams = {},
) {
  const env = params.env ?? process.env;
  return Object.freeze({
    agentId: 'ohMyPi',
    withStore: async <TResult>(
      input: ProviderStoreKey,
      handler: (store: OhMyPiTranscriptStore) => Promise<TResult>,
    ): Promise<TResult> => {
      const store = createOhMyPiTranscriptStore({ key: input, env });
      try {
        await store.warm();
        return await handler(store);
      } finally {
        await store.dispose();
      }
    },
    acquireStore: async (input: ProviderStoreKey): Promise<OhMyPiTranscriptStoreLease> => {
      const store = createOhMyPiTranscriptStore({ key: input, env });
      await store.warm();
      return {
        key: input,
        store,
        release: async () => {
          await store.dispose();
        },
      };
    },
    resolveFollowTranscriptPath: async (
      input: ProviderStoreKey,
    ): Promise<ExternalSessionFollowTranscriptPathResolutionV1 | null> => {
      const providerSessionId = resolveProviderSessionId(input);
      const resolved = await resolveOhMyPiSessionFile({
        source: input.source,
        env,
        remoteSessionId: providerSessionId,
      });
      return resolved ? { path: resolved.filePath, sourceId: providerSessionId } : null;
    },
    getProviderHome: async (input: ProviderStoreKey): Promise<string | null> => {
      try {
        return resolveOhMyPiAgentDir({ source: input.source, env });
      } catch {
        return null;
      }
    },
  });
}
