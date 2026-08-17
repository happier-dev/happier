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
