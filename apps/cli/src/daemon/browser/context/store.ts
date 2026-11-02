import type { BrowserContextItemV1 } from '@happier-dev/protocol';

type AnnotationItem = Extract<BrowserContextItemV1, { kind: 'browserAnnotation' }>;
type ContextSource = Readonly<{ browserSessionId: string; viewId: string }>;

export type BrowserContextStoreClearResult = Readonly<{
  removedItems: readonly BrowserContextItemV1[];
  releasedMediaIds: readonly string[];
}>;

/** The daemon retains one item per annotation; marks and element facts live on that item. */
export type BrowserContextItemStore = Readonly<{
  record(item: BrowserContextItemV1, source?: ContextSource): void;
  item(contextId: string): BrowserContextItemV1 | undefined;
  source(contextId: string): ContextSource | undefined;
  annotation(annotationId: string): AnnotationItem | undefined;
  clear(input: Readonly<{ annotationId?: string; contextId?: string }>): BrowserContextStoreClearResult;
  size(): number;
}>;

function mediaIdOf(item: BrowserContextItemV1): string | undefined {
  if (item.kind === 'browserAnnotation') return item.imageRef.mediaId;
  if (item.kind === 'browserScreenshot') return item.media.mediaId;
  return undefined;
}

export function createBrowserContextItemStore(): BrowserContextItemStore {
  const itemsByContextId = new Map<string, Readonly<{ item: BrowserContextItemV1; source?: ContextSource }>>();
  const contextIdByAnnotation = new Map<string, string>();
  const contextIdsByMediaId = new Map<string, Set<string>>();

  function remove(contextId: string): BrowserContextStoreClearResult {
    const item = itemsByContextId.get(contextId)?.item;
    if (!item) return { removedItems: [], releasedMediaIds: [] };
    itemsByContextId.delete(contextId);
    if (item.kind === 'browserAnnotation') contextIdByAnnotation.delete(item.annotationId);
    const mediaId = mediaIdOf(item);
    const releasedMediaIds: string[] = [];
    if (mediaId) {
      const refs = contextIdsByMediaId.get(mediaId);
      refs?.delete(contextId);
      if (refs?.size === 0) {
        contextIdsByMediaId.delete(mediaId);
        releasedMediaIds.push(mediaId);
      }
    }
    return { removedItems: [item], releasedMediaIds };
  }

  return {
    record(item, source) {
      remove(item.contextId);
      if (item.kind === 'browserAnnotation') {
        const previousContextId = contextIdByAnnotation.get(item.annotationId);
        if (previousContextId) remove(previousContextId);
        contextIdByAnnotation.set(item.annotationId, item.contextId);
      }
      itemsByContextId.set(item.contextId, { item, ...(source ? { source } : {}) });
      const mediaId = mediaIdOf(item);
      if (mediaId) {
        const refs = contextIdsByMediaId.get(mediaId) ?? new Set<string>();
        refs.add(item.contextId);
        contextIdsByMediaId.set(mediaId, refs);
      }
    },
    item: contextId => itemsByContextId.get(contextId)?.item,
    source: contextId => itemsByContextId.get(contextId)?.source,
    annotation(annotationId) {
      const contextId = contextIdByAnnotation.get(annotationId);
      const item = contextId ? itemsByContextId.get(contextId)?.item : undefined;
      return item?.kind === 'browserAnnotation' ? item : undefined;
    },
    clear(input) {
      if (input.annotationId) {
        const contextId = contextIdByAnnotation.get(input.annotationId);
        return contextId ? remove(contextId) : { removedItems: [], releasedMediaIds: [] };
      }
      if (input.contextId) return remove(input.contextId);
      const removedItems: BrowserContextItemV1[] = [];
      const releasedMediaIds: string[] = [];
      for (const contextId of itemsByContextId.keys()) {
        const result = remove(contextId);
        removedItems.push(...result.removedItems);
        releasedMediaIds.push(...result.releasedMediaIds);
      }
      return { removedItems, releasedMediaIds };
    },
    size: () => itemsByContextId.size,
  };
}
