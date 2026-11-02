import { describe, expect, it } from 'vitest';
import {
  BrowserContextItemV1Schema,
  type BrowserContextItemV1,
} from '@happier-dev/protocol/browser/context/v1';

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
    imageRef: { mediaId: input.mediaId, mediaKind: 'image', width: 100, height: 80, sizeBytes: 2048 },
    marks: { v: 1, image: { width: 100, height: 80, scale: 1 }, marks: [
      { id: 'element', kind: 'element', rect: { x: 1, y: 1, width: 20, height: 10 }, label: 'Element', color: 'red' },
    ] },
    elements: [{ markId: 'element', selectorPath: input.selector ?? '#a' }],
  });
}

describe('createBrowserContextItemStore (ANNO-4b)', () => {
  it('stores one annotation document and releases only its flattened image reference', () => {
    const annotationId = 'v2-annotation';
    const item = BrowserContextItemV1Schema.parse({
      v: 1, kind: 'browserAnnotation', contextId: 'v2-context', sourceViewId: 'view', sourceAdapterKind: 'chromiumSidecar',
      fidelity: 'cdp', capturedAtMs: 1, navigationGeneration: 2, lifecycleState: 'available', redactionLevel: 'metadataOnly',
      annotationId, browserSessionId: 'browser',
      imageRef: { mediaId: 'flattened', mediaKind: 'image', width: 100, height: 80, sizeBytes: 20 },
      marks: { v: 1, image: { width: 100, height: 80, scale: 1 }, marks: [
        { id: 'box', kind: 'element', rect: { x: 10, y: 10, width: 20, height: 20 }, color: 'red', label: 'Submit' },
      ] },
      elements: [{ markId: 'box', selectorPath: '#submit', sourceLocation: { file: '/src/Form.tsx', line: 10 } }],
    });
    const store = createBrowserContextItemStore();
    store.record(item);
    expect(store.item(item.contextId)).toEqual(item);
    const removed = store.clear({ annotationId });
    expect(removed).toEqual({ removedItems: [item], releasedMediaIds: ['flattened'] });
    expect(store.size()).toBe(0);
  });
  it('does not release a mediaId still referenced by a different annotation', () => {
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
    expect(store.item('c0')).toMatchObject({
      kind: 'browserAnnotation',
      elements: [{ selectorPath: '#updated' }],
    });
    const result = store.clear({ contextId: 'c0' });
    expect(result.releasedMediaIds).toEqual(['m1']);
  });
});
