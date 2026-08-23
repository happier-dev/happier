export type TranscriptSourcePage<TItem> = Readonly<{
  items: TItem[];
  nextCursor: string | null;
  tailCursor: string | null;
  hasMore: boolean;
  truncated: boolean;
}>;

export type TranscriptSourceReadAfter<TItem> = Readonly<{
  items: TItem[];
  nextCursor: string | null;
  truncated: boolean;
}>;

export type TranscriptSourceFollowUpdate<TItem> = Readonly<{
  items: TItem[];
  fromCursor?: string | null;
  nextCursor: string | null;
  truncated: boolean;
}>;

export type TranscriptSourceFollowLease<TItem> = Readonly<{
  release: () => Promise<void>;
  subscribeToTranscriptUpdates?: (
    listener: (update: TranscriptSourceFollowUpdate<TItem>) => void | Promise<void>,
  ) => () => void;
  getTailCursor?: () => string | null;
}>;

export type TranscriptSourceWindowState = Readonly<{
  olderCursor: string | null;
  hasMoreOlder: boolean;
  tailCursor: string | null;
  truncated: boolean;
}>;

export type TranscriptSourceFiniteActionFollowState = Readonly<{
  tailCursor: string;
  stopped: 'inactive' | 'aborted';
}>;

/**
 * Follows a transcript through the finite `transcript.follow` Action contract.
 * The caller owns action invocation, session-status interpretation, output, and
 * poll cadence; this owner keeps the cursor and terminal-drain rules shared.
 */
export async function followTranscriptSourceWithFiniteActions<TItem>(params: Readonly<{
  initialCursor: string;
  leaseId: string;
  follow: (params: Readonly<{ cursor: string; leaseId: string }>) => Promise<TranscriptSourceReadAfter<TItem>>;
  release: (params: Readonly<{ leaseId: string }>) => Promise<void>;
  isSessionActive: () => Promise<boolean>;
  waitForNextPoll: () => Promise<void>;
  onItems?: (page: Readonly<{ items: TItem[]; nextCursor: string }>) => Promise<void> | void;
  shouldContinue?: () => boolean;
}>): Promise<TranscriptSourceFiniteActionFollowState> {
  let cursor = params.initialCursor;
  let finalDrain = false;
  let failed = false;

  try {
    while (params.shouldContinue?.() ?? true) {
      const page = await params.follow({ cursor, leaseId: params.leaseId });
      const nextCursor = page.nextCursor ?? cursor;
      if (!(params.shouldContinue?.() ?? true)) {
        return { tailCursor: nextCursor, stopped: 'aborted' };
      }

      if (page.items.length > 0) {
        await params.onItems?.({ items: page.items, nextCursor });
        if (!(params.shouldContinue?.() ?? true)) {
          return { tailCursor: nextCursor, stopped: 'aborted' };
        }
      }
      cursor = nextCursor;

      if (page.truncated === true || page.items.length > 0) {
        continue;
      }
      if (finalDrain) {
        return { tailCursor: cursor, stopped: 'inactive' };
      }
      if (!await params.isSessionActive()) {
        finalDrain = true;
        continue;
      }

      await params.waitForNextPoll();
    }

    return { tailCursor: cursor, stopped: 'aborted' };
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    try {
      await params.release({ leaseId: params.leaseId });
    } catch (releaseError) {
      if (!failed) throw releaseError;
    }
  }
}

export async function readInitialTranscriptSourceWindow<TItem>(params: Readonly<{
  pageOlder: (params: Readonly<{ cursor?: string }>) => Promise<TranscriptSourcePage<TItem>>;
  readAfter: (params: Readonly<{ cursor: string }>) => Promise<TranscriptSourceReadAfter<TItem>>;
  onPageItems?: (page: Readonly<{ items: TItem[]; nextCursor: string | null }>) => Promise<void> | void;
  onTailItems?: (page: Readonly<{ items: TItem[]; nextCursor: string | null }>) => Promise<void> | void;
  shouldContinue?: () => boolean;
}>): Promise<TranscriptSourceWindowState> {
  const stagedPages: Array<Readonly<{ items: TItem[]; nextCursor: string | null }>> = [];
  const page = await params.pageOlder({});
  if (params.shouldContinue && !params.shouldContinue()) {
    return {
      olderCursor: null,
      hasMoreOlder: false,
      tailCursor: null,
      truncated: false,
    };
  }
  stagedPages.push({
    items: page.items,
    nextCursor: page.tailCursor,
  });

  if (page.truncated === true) {
    return {
      olderCursor: page.nextCursor,
      hasMoreOlder: page.hasMore === true,
      tailCursor: page.tailCursor,
      truncated: true,
    };
  }

  if (typeof page.tailCursor === 'string' && page.tailCursor.trim().length > 0) {
    await params.onPageItems?.(stagedPages[0]);
    return {
      olderCursor: page.nextCursor,
      hasMoreOlder: page.hasMore === true,
      tailCursor: page.tailCursor,
      truncated: false,
    };
  }

  const tail = await params.readAfter({ cursor: 'tail' });
  if (params.shouldContinue && !params.shouldContinue()) {
    return {
      olderCursor: page.nextCursor,
      hasMoreOlder: page.hasMore === true,
      tailCursor: null,
      truncated: false,
    };
  }
  stagedPages.push({
    items: tail.items,
    nextCursor: tail.nextCursor,
  });

  const truncated = tail.truncated === true;
  if (!truncated) {
    await params.onPageItems?.(stagedPages[0]);
    await params.onTailItems?.(stagedPages[1]);
  }

  return {
    olderCursor: page.nextCursor,
    hasMoreOlder: page.hasMore === true,
    tailCursor: tail.nextCursor,
    truncated,
  };
}

export async function catchUpTranscriptSourceWindow<TItem>(params: Readonly<{
  cursor: string;
  readAfter: (params: Readonly<{ cursor: string }>) => Promise<TranscriptSourceReadAfter<TItem>>;
  onItems?: (page: Readonly<{ items: TItem[]; nextCursor: string | null }>) => Promise<void> | void;
  shouldContinue?: () => boolean;
}>): Promise<Readonly<{ tailCursor: string | null; truncated: boolean }>> {
  const tail = await params.readAfter({ cursor: params.cursor });
  if (params.shouldContinue && !params.shouldContinue()) {
    return {
      tailCursor: null,
      truncated: false,
    };
  }
  if (tail.truncated !== true) {
    await params.onItems?.({
      items: tail.items,
      nextCursor: tail.nextCursor,
    });
  }
  return {
    tailCursor: tail.nextCursor,
    truncated: tail.truncated === true,
  };
}
