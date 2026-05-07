import type { DirectTranscriptRawMessageV1 } from '@happier-dev/protocol';

import type {
  DirectSessionFollowLease,
  DirectSessionTranscriptUpdateListener,
} from './createManagedDirectSessionFollowLease';

type DirectSessionTranscriptReadAfter = Readonly<{
  items: readonly DirectTranscriptRawMessageV1[];
  nextCursor?: string | null;
  truncated: boolean;
}>;

type DirectSessionPollingFollowLeaseParams = Readonly<{
  readAfterTranscript: (params: Readonly<{
    cursor: string;
    maxBytes: number;
    maxItems: number;
  }>) => Promise<DirectSessionTranscriptReadAfter>;
  env?: NodeJS.ProcessEnv;
}>;

function resolvePollIntervalMs(env: NodeJS.ProcessEnv): number {
  const raw = Number.parseInt(String(env.HAPPIER_DIRECT_SESSIONS_FOLLOW_POLL_MS ?? ''), 10);
  const configured = Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 250;
  return Math.max(10, Math.min(60_000, configured));
}

function resolveMaxBytes(env: NodeJS.ProcessEnv): number {
  const raw = Number.parseInt(String(env.HAPPIER_DIRECT_SESSIONS_FOLLOW_MAX_BYTES ?? ''), 10);
  const configured = Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 512_000;
  return Math.max(1024, Math.min(10 * 1024 * 1024, configured));
}

function resolveMaxItems(env: NodeJS.ProcessEnv): number {
  const raw = Number.parseInt(String(env.HAPPIER_DIRECT_SESSIONS_FOLLOW_MAX_ITEMS ?? ''), 10);
  const configured = Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 200;
  return Math.max(1, Math.min(5000, configured));
}

async function notifyTranscriptListeners(
  listeners: ReadonlySet<DirectSessionTranscriptUpdateListener>,
  update: DirectSessionTranscriptReadAfter,
): Promise<void> {
  await Promise.allSettled(Array.from(listeners, async (listener) => {
    await listener(update);
  }));
}

export async function createPollingDirectSessionFollowLease(
  params: DirectSessionPollingFollowLeaseParams,
): Promise<DirectSessionFollowLease> {
  const env = params.env ?? process.env;
  const pollIntervalMs = resolvePollIntervalMs(env);
  const maxBytes = resolveMaxBytes(env);
  const maxItems = resolveMaxItems(env);
  const listeners = new Set<DirectSessionTranscriptUpdateListener>();

  let tailCursor = await params.readAfterTranscript({
    cursor: 'tail',
    maxBytes,
    maxItems,
  }).then((result) => result.nextCursor ?? null).catch(() => null);
  let released = false;
  let polling = false;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;

  const clearPollTimer = (): void => {
    if (!pollTimer) return;
    clearTimeout(pollTimer);
    pollTimer = null;
  };

  const schedulePoll = (): void => {
    if (released || listeners.size === 0 || pollTimer) return;
    pollTimer = setTimeout(() => {
      pollTimer = null;
      void pollOnce();
    }, pollIntervalMs);
  };

  const pollOnce = async (): Promise<void> => {
    if (released || polling || listeners.size === 0) return;
    polling = true;
    try {
      const result = await params.readAfterTranscript({
        cursor: tailCursor ?? 'tail',
        maxBytes,
        maxItems,
      });
      const items = Array.from(result.items);
      if (typeof result.nextCursor === 'string' || result.nextCursor === null) {
        tailCursor = result.nextCursor ?? tailCursor;
      }
      if (items.length > 0 || result.truncated === true) {
        await notifyTranscriptListeners(listeners, {
          items,
          nextCursor: result.nextCursor ?? null,
          truncated: result.truncated === true,
        });
      }
    } catch {
      // Follow leases are best-effort; the next poll can recover from transient read failures.
    } finally {
      polling = false;
      schedulePoll();
    }
  };

  return {
    release: () => {
      released = true;
      clearPollTimer();
      listeners.clear();
    },
    getTailCursor: () => tailCursor,
    subscribeToTranscriptUpdates: (listener) => {
      if (released) return () => {};
      listeners.add(listener);
      void pollOnce();
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          clearPollTimer();
        }
      };
    },
  };
}
