import {
  BrowserContextItemV1Schema,
  type BrowserAnnotationStrokeV1,
  type BrowserAnnotationStyleIntentV1,
  type BrowserContextItemV1,
} from '@happier-dev/protocol';

/**
 * ANNO-4b daemon-local browser-context item store. The headless managed-Chromium agent path has no
 * in-app `BrowserContextState` holding captured items, so the daemon retains them here keyed by
 * `contextId` and grouped by `annotationId`. The store is the single owner of the
 * group-by-annotationId invariant on the daemon side: a multi-target annotation (N items sharing one
 * `annotationId` + one cropped `mediaId`) is ONE logical group, attached as ONE composer/agent card,
 * cleared atomically, and its shared `mediaId` is released exactly once.
 *
 * Media references are reference-only (`BrowserScreenshotMediaReferenceV1` carries a `mediaId`, never
 * bytes); the bytes are persisted at capture time via `recording/sessionMediaWriter`. The store
 * tracks which `contextId`s reference each `mediaId` so a clear releases a `mediaId` only when its
 * last referencing item is removed (no premature release while a sibling target still references it,
 * no double-release across the group's N items).
 */
export type BrowserContextStoreClearResult = Readonly<{
  removedItems: readonly BrowserContextItemV1[];
  releasedMediaIds: readonly string[];
}>;

export type BrowserContextItemStore = Readonly<{
  record(item: BrowserContextItemV1): void;
  item(contextId: string): BrowserContextItemV1 | undefined;
  /** Items sharing an `annotationId`, in insertion order. Empty when the group is unknown. */
  group(annotationId: string): readonly BrowserContextItemV1[];
  /** The `annotationId` a `contextId` belongs to, or `undefined` for a non-annotation/unknown item. */
  annotationIdForContext(contextId: string): string | undefined;
  /** Update metadata for an existing annotation item and return the canonical parsed item. */
  updateAnnotation(input: Readonly<{
    contextId: string;
    comment?: string;
    stroke?: BrowserAnnotationStrokeV1;
    styleIntent?: BrowserAnnotationStyleIntentV1;
  }>): BrowserContextItemV1 | undefined;
  /**
   * Atomically remove a group (by `annotationId`) or a single item (by `contextId`). When a
   * `contextId` resolves to an annotation item, its WHOLE group is removed (the group is one logical
   * annotation). Returns the removed items + the `mediaId`s whose last reference was dropped.
   */
  clear(input: Readonly<{ annotationId?: string; contextId?: string }>): BrowserContextStoreClearResult;
  size(): number;
}>;

function mediaIdOf(item: BrowserContextItemV1): string | undefined {
  if (item.kind === 'browserAnnotation' || item.kind === 'browserScreenshot') {
    return item.media.mediaId;
  }
  return undefined;
}

export function createBrowserContextItemStore(): BrowserContextItemStore {
  const itemsByContextId = new Map<string, BrowserContextItemV1>();
  const insertionOrder: string[] = [];
  const contextIdsByAnnotation = new Map<string, string[]>();
  // mediaId -> the set of contextIds that currently reference it (reference counting).
  const contextIdsByMediaId = new Map<string, Set<string>>();

  function indexMedia(item: BrowserContextItemV1): void {
    const mediaId = mediaIdOf(item);
    if (!mediaId) return;
    const refs = contextIdsByMediaId.get(mediaId) ?? new Set<string>();
    refs.add(item.contextId);
    contextIdsByMediaId.set(mediaId, refs);
  }

  function unindexMedia(item: BrowserContextItemV1): string | null {
    const mediaId = mediaIdOf(item);
    if (!mediaId) return null;
    const refs = contextIdsByMediaId.get(mediaId);
    if (!refs) return null;
    refs.delete(item.contextId);
    if (refs.size === 0) {
      contextIdsByMediaId.delete(mediaId);
      return mediaId;
    }
    return null;
  }

  function removeContextIds(contextIds: readonly string[]): BrowserContextStoreClearResult {
    const removedItems: BrowserContextItemV1[] = [];
    const releasedMediaIds: string[] = [];
    for (const contextId of contextIds) {
      const item = itemsByContextId.get(contextId);
      if (!item) continue;
      itemsByContextId.delete(contextId);
      const orderIndex = insertionOrder.indexOf(contextId);
      if (orderIndex >= 0) insertionOrder.splice(orderIndex, 1);
      if (item.kind === 'browserAnnotation') {
        const group = contextIdsByAnnotation.get(item.annotationId);
        if (group) {
          const remaining = group.filter((id) => id !== contextId);
          if (remaining.length === 0) contextIdsByAnnotation.delete(item.annotationId);
          else contextIdsByAnnotation.set(item.annotationId, remaining);
        }
      }
      const released = unindexMedia(item);
      if (released) releasedMediaIds.push(released);
      removedItems.push(item);
    }
    return { removedItems, releasedMediaIds };
  }

  return {
    record(item) {
      const existing = itemsByContextId.get(item.contextId);
      if (existing) {
        // Re-record (re-capture of the same contextId): drop the prior media reference first so the
        // ref set stays accurate, then re-index.
        unindexMedia(existing);
      } else {
        insertionOrder.push(item.contextId);
      }
      itemsByContextId.set(item.contextId, item);
      if (item.kind === 'browserAnnotation') {
        const group = contextIdsByAnnotation.get(item.annotationId) ?? [];
        if (!group.includes(item.contextId)) group.push(item.contextId);
        contextIdsByAnnotation.set(item.annotationId, group);
      }
      indexMedia(item);
    },

    item(contextId) {
      return itemsByContextId.get(contextId);
    },

    group(annotationId) {
      const ids = contextIdsByAnnotation.get(annotationId) ?? [];
      return ids
        .map((id) => itemsByContextId.get(id))
        .filter((item): item is BrowserContextItemV1 => item !== undefined);
    },

    annotationIdForContext(contextId) {
      const item = itemsByContextId.get(contextId);
      return item && item.kind === 'browserAnnotation' ? item.annotationId : undefined;
    },

    updateAnnotation(input) {
      const item = itemsByContextId.get(input.contextId);
      if (!item || item.kind !== 'browserAnnotation') return undefined;
      const next = BrowserContextItemV1Schema.parse({
        ...item,
        ...(input.comment !== undefined ? { comment: input.comment } : {}),
        ...(input.stroke !== undefined ? { stroke: input.stroke } : {}),
        ...(input.styleIntent !== undefined ? { styleIntent: input.styleIntent } : {}),
      });
      itemsByContextId.set(input.contextId, next);
      return next;
    },

    clear(input) {
      if (input.annotationId) {
        const ids = [...(contextIdsByAnnotation.get(input.annotationId) ?? [])];
        return removeContextIds(ids);
      }
      if (input.contextId) {
        const item = itemsByContextId.get(input.contextId);
        // A contextId that names an annotation item clears its WHOLE group atomically.
        if (item && item.kind === 'browserAnnotation') {
          const ids = [...(contextIdsByAnnotation.get(item.annotationId) ?? [])];
          return removeContextIds(ids);
        }
        return removeContextIds([input.contextId]);
      }
      // No selector: clear everything (atomic full reset).
      const all = [...insertionOrder];
      return removeContextIds(all);
    },

    size() {
      return itemsByContextId.size;
    },
  };
}
