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
}>;

export async function readInitialTranscriptSourceWindow<TItem>(params: Readonly<{
  pageOlder: (params: Readonly<{ cursor?: string }>) => Promise<TranscriptSourcePage<TItem>>;
  readAfter: (params: Readonly<{ cursor: string }>) => Promise<TranscriptSourceReadAfter<TItem>>;
  onPageItems?: (page: Readonly<{ items: TItem[]; nextCursor: string | null }>) => Promise<void> | void;
  onTailItems?: (page: Readonly<{ items: TItem[]; nextCursor: string | null }>) => Promise<void> | void;
  shouldContinue?: () => boolean;
}>): Promise<TranscriptSourceWindowState> {
  const page = await params.pageOlder({});
  if (params.shouldContinue && !params.shouldContinue()) {
    return {
      olderCursor: null,
      hasMoreOlder: false,
      tailCursor: null,
    };
  }
  await params.onPageItems?.({
    items: page.items,
    nextCursor: page.tailCursor,
  });

  if (typeof page.tailCursor === 'string' && page.tailCursor.trim().length > 0) {
    return {
      olderCursor: page.nextCursor,
      hasMoreOlder: page.hasMore === true,
      tailCursor: page.tailCursor,
    };
  }

  const tail = await params.readAfter({ cursor: 'tail' });
  if (params.shouldContinue && !params.shouldContinue()) {
    return {
      olderCursor: page.nextCursor,
      hasMoreOlder: page.hasMore === true,
      tailCursor: null,
    };
  }
  await params.onTailItems?.({
    items: tail.items,
    nextCursor: tail.nextCursor,
  });

  return {
    olderCursor: page.nextCursor,
    hasMoreOlder: page.hasMore === true,
    tailCursor: tail.nextCursor,
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
  await params.onItems?.({
    items: tail.items,
    nextCursor: tail.nextCursor,
  });
  return {
    tailCursor: tail.nextCursor,
    truncated: tail.truncated === true,
  };
}

export async function replayTranscriptSourceHistory<TItem>(params: Readonly<{
  pageOlder: (params: Readonly<{ cursor?: string }>) => Promise<TranscriptSourcePage<TItem>>;
  onItems: (items: TItem[]) => Promise<void> | void;
}>): Promise<Readonly<{ tailCursor: string | null }>> {
  const pages: TItem[][] = [];
  let tailCursor: string | null = null;
  let cursor: string | undefined;

  while (true) {
    const page = await params.pageOlder({ cursor });
    tailCursor ??= page.tailCursor;
    if (page.items.length > 0) {
      pages.push(page.items);
    }
    if (!page.hasMore || !page.nextCursor) {
      break;
    }
    cursor = page.nextCursor;
  }

  for (let index = pages.length - 1; index >= 0; index -= 1) {
    const items = pages[index];
    if (!items || items.length === 0) continue;
    await params.onItems(items);
  }

  return { tailCursor };
}

export async function bridgeTranscriptSourceHandoffGap<TItem>(params: Readonly<{
  fromCursor: string | null;
  toCursor: string | null;
  readAfter: (params: Readonly<{ cursor: string }>) => Promise<TranscriptSourceReadAfter<TItem>>;
  onItems: (items: TItem[]) => Promise<void> | void;
}>): Promise<void> {
  if (!params.fromCursor || !params.toCursor || params.fromCursor === params.toCursor) {
    return;
  }

  let cursor = params.fromCursor;
  const visitedCursors = new Set<string>([cursor]);

  while (cursor !== params.toCursor) {
    const page = await params.readAfter({ cursor });
    if (page.items.length > 0) {
      await params.onItems(page.items);
    }
    const nextCursor = page.nextCursor;
    if (!nextCursor || visitedCursors.has(nextCursor)) {
      return;
    }
    cursor = nextCursor;
    visitedCursors.add(cursor);
  }
}
