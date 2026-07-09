type ExternalSessionTranscriptReadAfterResult<TItem> = Readonly<{
  items: readonly TItem[];
  nextCursor?: string | null;
  truncated: boolean;
}>;

type ExternalSessionPollingFollowLeaseParams<TItem> = Readonly<{
  readAfterTranscript: (params: Readonly<{
    cursor: string;
    maxBytes: number;
    maxItems: number;
  }>) => Promise<ExternalSessionTranscriptReadAfterResult<TItem>>;
  env?: NodeJS.ProcessEnv;
}>;

type ExternalSessionTranscriptUpdate<TItem> = Readonly<{
  items: TItem[];
  fromCursor: string | null;
  nextCursor: string | null;
  truncated: boolean;
}>;

type ExternalSessionTranscriptUpdateListener<TItem> = (
  update: ExternalSessionTranscriptUpdate<TItem>,
) => void | Promise<void>;

type PollingExternalSessionFollowLease<TItem> = Readonly<{
  release: () => Promise<void>;
  getTailCursor: () => string | null;
  subscribeToTranscriptUpdates: (listener: ExternalSessionTranscriptUpdateListener<TItem>) => () => void;
}>;

function resolvePollIntervalMs(env: NodeJS.ProcessEnv): number {
  const raw = Number.parseInt(String(env.HAPPIER_EXTERNAL_SESSIONS_FOLLOW_POLL_MS ?? ''), 10);
  const configured = Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 250;
  return Math.max(10, Math.min(60_000, configured));
}

function resolveMaxBytes(env: NodeJS.ProcessEnv): number {
  const raw = Number.parseInt(String(env.HAPPIER_EXTERNAL_SESSIONS_FOLLOW_MAX_BYTES ?? ''), 10);
  const configured = Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 512_000;
  return Math.max(1024, Math.min(10 * 1024 * 1024, configured));
}

function resolveMaxItems(env: NodeJS.ProcessEnv): number {
  const raw = Number.parseInt(String(env.HAPPIER_EXTERNAL_SESSIONS_FOLLOW_MAX_ITEMS ?? ''), 10);
  const configured = Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 200;
  return Math.max(1, Math.min(5000, configured));
}

async function notifyTranscriptListeners<TItem>(
  listeners: ReadonlySet<ExternalSessionTranscriptUpdateListener<TItem>>,
  update: ExternalSessionTranscriptUpdate<TItem>,
): Promise<void> {
  await Promise.allSettled(Array.from(listeners, async (listener) => {
    await listener(update);
  }));
}

export async function createPollingExternalSessionFollowLease<TItem>(
  params: ExternalSessionPollingFollowLeaseParams<TItem>,
): Promise<PollingExternalSessionFollowLease<TItem>> {
  const env = params.env ?? process.env;
  const pollIntervalMs = resolvePollIntervalMs(env);
  const maxBytes = resolveMaxBytes(env);
  const maxItems = resolveMaxItems(env);
  const listeners = new Set<ExternalSessionTranscriptUpdateListener<TItem>>();

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

  const schedulePoll = (delayMs = pollIntervalMs): void => {
    if (released || listeners.size === 0 || pollTimer) return;
    pollTimer = setTimeout(() => {
      pollTimer = null;
      void pollOnce();
    }, delayMs);
  };

  const pollOnce = async (): Promise<void> => {
    if (released || polling || listeners.size === 0) return;
    polling = true;
    let shouldDrainTruncatedPage = false;
    try {
      const fromCursor = tailCursor ?? 'tail';
      const result = await params.readAfterTranscript({
        cursor: fromCursor,
        maxBytes,
        maxItems,
      });
      const items = Array.from(result.items) as TItem[];
      const nextCursor = typeof result.nextCursor === 'string' || result.nextCursor === null
        ? result.nextCursor
        : undefined;
      if (nextCursor !== undefined) {
        tailCursor = nextCursor ?? tailCursor;
      }
      shouldDrainTruncatedPage = result.truncated === true
        && typeof nextCursor === 'string'
        && nextCursor !== fromCursor;
      if (items.length > 0 || result.truncated === true) {
        await notifyTranscriptListeners(listeners, {
          items,
          fromCursor,
          nextCursor: result.nextCursor ?? null,
          truncated: result.truncated === true,
        });
      }
    } catch {
      // Follow leases are best-effort; the next poll can recover from transient read failures.
    } finally {
      polling = false;
      schedulePoll(shouldDrainTruncatedPage ? 0 : pollIntervalMs);
    }
  };

  return {
    release: async () => {
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
