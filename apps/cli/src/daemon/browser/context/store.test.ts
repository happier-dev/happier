import { describe, expect, it } from 'vitest';
import {
  BrowserContextItemV1Schema,
  type BrowserContextItemV1,
} from '@happier-dev/protocol';

import { createBrowserContextItemStore } from './store';

function annotationItem(input: Readonly<{
  contextId: string;
  annotationId: string;
  mediaId: string;
  selector?: string;
}>): BrowserContextItemV1 {
  return BrowserContextItemV1Schema.parse({
    v: 1,
    contextId: input.contextId,
    kind: 'browserAnnotation',
    sourceViewId: 'view_1',
    sourceAdapterKind: 'localPreview',
    fidelity: 'injectedPage',
    capturedAtMs: 1_000,
    navigationGeneration: 2,
    lifecycleState: 'available',
    redactionLevel: 'metadataOnly',
    annotationId: input.annotationId,
    browserSessionId: 'browser_session_1',
    media: { mediaId: input.mediaId, mediaKind: 'image', width: 100, height: 80, sizeBytes: 2048 },
    target: { kind: 'element', selectorPath: input.selector ?? '#a' },
  });
}

describe('createBrowserContextItemStore (ANNO-4b)', () => {
  it('groups N items sharing one annotationId and returns them in insertion order', () => {
    const store = createBrowserContextItemStore();
    store.record(annotationItem({ contextId: 'c0', annotationId: 'anno_1', mediaId: 'm1', selector: '#a' }));
    store.record(annotationItem({ contextId: 'c1', annotationId: 'anno_1', mediaId: 'm1', selector: '#b' }));
    store.record(annotationItem({ contextId: 'c2', annotationId: 'anno_1', mediaId: 'm1', selector: '#c' }));

    const group = store.group('anno_1');
    expect(group.map((item) => item.contextId)).toEqual(['c0', 'c1', 'c2']);
    expect(store.annotationIdForContext('c1')).toBe('anno_1');
    expect(store.size()).toBe(3);
  });

  it('clears a 3-target group atomically and releases the shared mediaId exactly once', () => {
    const store = createBrowserContextItemStore();
    store.record(annotationItem({ contextId: 'c0', annotationId: 'anno_1', mediaId: 'shared' }));
    store.record(annotationItem({ contextId: 'c1', annotationId: 'anno_1', mediaId: 'shared' }));
    store.record(annotationItem({ contextId: 'c2', annotationId: 'anno_1', mediaId: 'shared' }));

    const result = store.clear({ annotationId: 'anno_1' });
    expect(result.removedItems).toHaveLength(3);
    // The shared mediaId is released ONCE, not once per target (no leaked refs, no double-release).
    expect(result.releasedMediaIds).toEqual(['shared']);
    expect(store.size()).toBe(0);
    expect(store.group('anno_1')).toEqual([]);
  });

  it('clearing one contextId of a group removes the whole group (one logical annotation)', () => {
    const store = createBrowserContextItemStore();
    store.record(annotationItem({ contextId: 'c0', annotationId: 'anno_1', mediaId: 'shared' }));
    store.record(annotationItem({ contextId: 'c1', annotationId: 'anno_1', mediaId: 'shared' }));

    const result = store.clear({ contextId: 'c1' });
    expect(result.removedItems.map((i) => i.contextId).sort()).toEqual(['c0', 'c1']);
    expect(result.releasedMediaIds).toEqual(['shared']);
    expect(store.size()).toBe(0);
  });

  it('does not release a mediaId still referenced by a DIFFERENT annotation group', () => {
    const store = createBrowserContextItemStore();
    // Two independent annotations that (pathologically) share a mediaId: clearing one must not
    // release the media the other still references.
    store.record(annotationItem({ contextId: 'a0', annotationId: 'anno_a', mediaId: 'shared' }));
    store.record(annotationItem({ contextId: 'b0', annotationId: 'anno_b', mediaId: 'shared' }));

    const first = store.clear({ annotationId: 'anno_a' });
    expect(first.removedItems).toHaveLength(1);
    expect(first.releasedMediaIds).toEqual([]); // still referenced by anno_b

    const second = store.clear({ annotationId: 'anno_b' });
    expect(second.releasedMediaIds).toEqual(['shared']);
  });

  it('re-recording the same contextId does not double-count the media reference', () => {
    const store = createBrowserContextItemStore();
    store.record(annotationItem({ contextId: 'c0', annotationId: 'anno_1', mediaId: 'm1', selector: '#a' }));
    store.record(annotationItem({ contextId: 'c0', annotationId: 'anno_1', mediaId: 'm1', selector: '#updated' }));
    expect(store.size()).toBe(1);
    expect(store.item('c0')?.kind === 'browserAnnotation' && store.item('c0'));
    const result = store.clear({ contextId: 'c0' });
    expect(result.releasedMediaIds).toEqual(['m1']);
  });

  it('updates annotation metadata in the canonical daemon context store', () => {
    const store = createBrowserContextItemStore();
    store.record(annotationItem({ contextId: 'c0', annotationId: 'anno_1', mediaId: 'm1', selector: '#a' }));

    const commented = store.updateAnnotation({
      contextId: 'c0',
      comment: 'Tighten this spacing',
    });
    expect(commented?.kind).toBe('browserAnnotation');
    expect(commented && commented.kind === 'browserAnnotation' ? commented.comment : undefined).toBe('Tighten this spacing');

    const styled = store.updateAnnotation({
      contextId: 'c0',
      styleIntent: 'highlight',
      stroke: { shape: 'rectangle', points: [{ x: 0.1, y: 0.2 }] },
    });
    expect(styled && styled.kind === 'browserAnnotation' ? styled.styleIntent : undefined).toBe('highlight');
    expect(styled && styled.kind === 'browserAnnotation' ? styled.stroke?.shape : undefined).toBe('rectangle');

    expect(store.updateAnnotation({ contextId: 'missing', comment: 'nope' })).toBeUndefined();
  });
});
