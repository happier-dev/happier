import { describe, expect, it } from 'vitest';
import {
  BrowserContextAttachmentV1Schema,
  BrowserContextItemV1Schema,
  type BrowserContextItemV1,
} from '@happier-dev/protocol/browser/context/v1';

import { createBrowserContextAttachService, isBrowserContextItemAgentEgressSafe } from './attach';
import { createBrowserContextItemStore } from './store';

function annotationItem(input: Readonly<{
  contextId: string;
  annotationId: string;
  mediaId: string;
  selector?: string;
}>): BrowserContextItemV1 {
  return BrowserContextItemV1Schema.parse({
    v: 1, contextId: input.contextId, kind: 'browserAnnotation', sourceViewId: 'view_1',
    sourceAdapterKind: 'localPreview', fidelity: 'injectedPage', capturedAtMs: 1_000,
    navigationGeneration: 3, lifecycleState: 'available', redactionLevel: 'metadataOnly',
    annotationId: input.annotationId, browserSessionId: 'browser_session_1',
    imageRef: { mediaId: input.mediaId, mediaKind: 'image', width: 100, height: 80, sizeBytes: 2048 },
    marks: { v: 1, image: { width: 100, height: 80, scale: 1 }, marks: [
      { id: 'element', kind: 'element', rect: { x: 20, y: 10, width: 40, height: 30 }, label: 'Save', color: 'red' },
      { id: 'blur', kind: 'blur', rect: { x: 10, y: 50, width: 20, height: 10 }, size: 'm' },
    ] },
    elements: [{ markId: 'element', selectorPath: input.selector ?? '#target', componentName: 'Form',
      sourceLocation: { file: '/src/Form.tsx', line: 12, column: 2 } }],
    pageTitle: 'Example', pageUrl: 'https://example.test',
  });
}

function ownerOnlyConsoleSummary(): BrowserContextItemV1 {
  return BrowserContextItemV1Schema.parse({
    v: 1,
    contextId: 'console_owner_full',
    kind: 'browserConsoleSummary',
    sourceViewId: 'view_1',
    sourceAdapterKind: 'localPreview',
    fidelity: 'cdp',
    capturedAtMs: 1_000,
    navigationGeneration: 3,
    lifecycleState: 'available',
    // Full owner fidelity → must never attach to an agent message.
    redactionLevel: 'none',
    summary: 'secret token=abc123 in console',
  });
}

describe('createBrowserContextAttachService (ANNO-4b)', () => {
  it('attaches one annotation item through the strict v2 consumer with all marks and source facts', () => {
    const store = createBrowserContextItemStore();
    const item = annotationItem({ contextId: 'c0', annotationId: 'anno_1', mediaId: 'flattened', selector: '#save' });
    store.record(item);
    const service = createBrowserContextAttachService({ store });
    for (const selector of [{ annotationId: 'anno_1' }, { contextId: 'c0' }]) {
      const result = service.attach({ ...selector, destination: 'agentTurn' });
      expect(result.ok).toBe(true);
      if (!result.ok || item.kind !== 'browserAnnotation') throw new Error('Annotation attach failed');
      expect(result.attachedContextIds).toEqual(['c0']);
      expect(result.mediaIds).toEqual(['flattened']);
      const attachment = BrowserContextAttachmentV1Schema.parse(result.attachment);
      expect(attachment.structuredBlock).toEqual({
        v: 2, kind: 'browser.annotation.v2', annotationId: item.annotationId,
        sourceViewId: item.sourceViewId, browserSessionId: item.browserSessionId, contextIds: [item.contextId],
        imageRef: item.imageRef, marks: item.marks, elements: item.elements, pageTitle: item.pageTitle, pageUrl: item.pageUrl,
      });
      expect(attachment.structuredBlock).not.toHaveProperty('comment');
    }
  });

  it('refuses to attach an owner-only full-fidelity console summary to an agent message', () => {
    const store = createBrowserContextItemStore();
    store.record(ownerOnlyConsoleSummary());
    const service = createBrowserContextAttachService({ store });

    const result = service.attach({ contextId: 'console_owner_full', destination: 'agentTurn' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('browser_context_attach_owner_only');
  });

  it('the egress chokepoint is aligned with the agnostic diagnostics classifier', () => {
    // Annotation items (metadataOnly) are agent-safe; owner-full content is not.
    expect(isBrowserContextItemAgentEgressSafe(
      annotationItem({ contextId: 'c0', annotationId: 'a', mediaId: 'm', selector: '#x' }),
    )).toBe(true);
    expect(isBrowserContextItemAgentEgressSafe(ownerOnlyConsoleSummary())).toBe(false);
  });

  it('fails closed when the group is unknown', () => {
    const store = createBrowserContextItemStore();
    const service = createBrowserContextAttachService({ store });
    const result = service.attach({ annotationId: 'missing', destination: 'composer' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('browser_context_item_missing');
  });

  it('clears one annotation and releases its flattened media reference', () => {
    const store = createBrowserContextItemStore();
    store.record(annotationItem({ contextId: 'c0', annotationId: 'anno_1', mediaId: 'flattened' }));
    const result = createBrowserContextAttachService({ store }).clear({ annotationId: 'anno_1' });
    expect(result.releasedMediaIds).toEqual(['flattened']);
    expect(result.clearedItems).toHaveLength(1);
    expect(store.size()).toBe(0);
  });

});
