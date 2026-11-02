import { describe, expect, it } from 'vitest';

import * as protocol from './v1.js';
import * as projection from './annotationStructuredBlock.js';

const annotation = {
  v: 1, kind: 'browserAnnotation', contextId: 'context', sourceViewId: 'view',
  sourceAdapterKind: 'chromiumSidecar', fidelity: 'cdp', capturedAtMs: 1,
  navigationGeneration: 2, lifecycleState: 'available', redactionLevel: 'metadataOnly',
  annotationId: 'annotation', browserSessionId: 'browser',
  imageRef: { mediaId: 'flattened', mediaKind: 'image', width: 200, height: 100, sizeBytes: 80 },
  marks: { v: 1, image: { width: 200, height: 100, scale: 2 }, marks: [
    { id: 'element', kind: 'element', rect: { x: 20, y: 10, width: 40, height: 20 }, label: 'Submit', color: 'red' },
    { id: 'blur', kind: 'blur', rect: { x: 80, y: 20, width: 40, height: 20 }, size: 'm' },
  ] },
  elements: [{ markId: 'element', selectorPath: '#submit', accessibleName: 'Submit', componentName: 'Checkout',
    sourceLocation: { file: '/src/Checkout.tsx', line: 12, column: 3 } }],
  pageUrl: 'https://example.test/checkout', pageTitle: 'Checkout',
} as const;

describe('browser annotation v2', () => {
  it('preserves the canonical mark identity when joining browser source facts', () => {
    const markId = ' element ';
    const item = protocol.BrowserContextAnnotationItemV2Schema.parse({ ...annotation,
      marks: { ...annotation.marks, marks: [{ ...annotation.marks.marks[0], id: markId }] },
      elements: [{ ...annotation.elements[0], markId }],
    });
    const block = projection.buildBrowserContextAnnotationStructuredBlockV2(item);
    expect(block.elements[0].markId).toBe(block.marks.marks[0].id);
  });
  it('projects one marks document and retains element source facts without legacy carriers', () => {
    expect(protocol).toHaveProperty('BrowserContextAnnotationItemV2Schema');
    const item = protocol.BrowserContextItemV1Schema.parse(annotation);
    if (item.kind !== 'browserAnnotation') throw new Error('Expected annotation item');
    const block = projection.buildBrowserContextAnnotationStructuredBlockV2(item);
    expect(protocol.BrowserContextAnnotationStructuredBlockV2Schema.parse(block)).toEqual({
      v: 2, kind: 'browser.annotation.v2', annotationId: item.annotationId,
      sourceViewId: item.sourceViewId, browserSessionId: item.browserSessionId, contextIds: [item.contextId],
      imageRef: item.imageRef, marks: item.marks, elements: item.elements,
      pageUrl: item.pageUrl, pageTitle: item.pageTitle,
    });
    expect(protocol.BrowserContextItemV1Schema.safeParse({ ...annotation, lifecycleState: 'sensitiveFieldsPresent', disabledReason: 'Sensitive fields' }).success).toBe(false);
    for (const field of ['comment', 'media', 'target', 'stroke', 'styleIntent']) {
      expect(protocol.BrowserContextAnnotationItemV2Schema.safeParse({ ...annotation, [field]: 'legacy' }).success).toBe(false);
      expect(protocol.BrowserContextAnnotationStructuredBlockV2Schema.safeParse({ ...block, [field]: 'legacy' }).success).toBe(false);
    }
  });
});
