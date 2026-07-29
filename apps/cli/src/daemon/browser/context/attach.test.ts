import { describe, expect, it } from 'vitest';
import {
  BrowserContextAttachmentV1Schema,
  BrowserContextItemV1Schema,
  type BrowserContextItemV1,
} from '@happier-dev/protocol';

import { createBrowserContextAttachService, isBrowserContextItemAgentEgressSafe } from './attach';
import { createBrowserContextItemStore } from './store';

function annotationItem(input: Readonly<{
  contextId: string;
  annotationId: string;
  mediaId: string;
  selector?: string;
  region?: Readonly<{ x: number; y: number; width: number; height: number }>;
  stroke?: Readonly<{
    shape: 'freehand';
    points: readonly Readonly<{ x: number; y: number }>[];
  }>;
}>): BrowserContextItemV1 {
  return BrowserContextItemV1Schema.parse({
    v: 1,
    contextId: input.contextId,
    kind: 'browserAnnotation',
    sourceViewId: 'view_1',
    sourceAdapterKind: 'localPreview',
    fidelity: 'injectedPage',
    capturedAtMs: 1_000,
    navigationGeneration: 3,
    lifecycleState: 'available',
    redactionLevel: 'metadataOnly',
    annotationId: input.annotationId,
    browserSessionId: 'browser_session_1',
    media: { mediaId: input.mediaId, mediaKind: 'image', width: 100, height: 80, sizeBytes: 2048 },
    target: input.region
      ? { kind: 'region', rect: input.region }
      : { kind: 'element', selectorPath: input.selector ?? '#target' },
    comment: 'needs spacing',
    ...(input.stroke ? { stroke: input.stroke } : {}),
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
  it('attaches a 3-target annotation as exactly ONE composer card referencing the shared media', () => {
    const store = createBrowserContextItemStore();
    store.record(annotationItem({ contextId: 'c0', annotationId: 'anno_1', mediaId: 'crop_1', selector: '#a' }));
    store.record(annotationItem({ contextId: 'c1', annotationId: 'anno_1', mediaId: 'crop_1', selector: '#b' }));
    store.record(annotationItem({ contextId: 'c2', annotationId: 'anno_1', mediaId: 'crop_1', selector: '#c' }));
    const service = createBrowserContextAttachService({ store });

    const result = service.attach({ annotationId: 'anno_1', destination: 'composer' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // ONE attachment card for the whole group.
    expect(result.attachment.attachmentId).toBe('browser_context_attachment:anno_1');
    expect(result.attachedContextIds).toEqual(['c0', 'c1', 'c2']);
    // Shared reference-only media referenced once.
    expect(result.mediaIds).toEqual(['crop_1']);
  });

  it('attaching by one contextId of the group still yields the single group card', () => {
    const store = createBrowserContextItemStore();
    store.record(annotationItem({ contextId: 'c0', annotationId: 'anno_1', mediaId: 'crop_1', selector: '#a' }));
    store.record(annotationItem({ contextId: 'c1', annotationId: 'anno_1', mediaId: 'crop_1', selector: '#b' }));
    const service = createBrowserContextAttachService({ store });

    const result = service.attach({ contextId: 'c1', destination: 'agentTurn' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.attachment.attachmentId).toBe('browser_context_attachment:anno_1');
    expect([...result.attachedContextIds].sort()).toEqual(['c0', 'c1']);
  });

  it('attaches a schema-validated structured annotation block for model-readable turns', () => {
    const store = createBrowserContextItemStore();
    store.record(annotationItem({ contextId: 'c0', annotationId: 'anno_1', mediaId: 'crop_1', selector: '#save' }));
    store.record(annotationItem({ contextId: 'c1', annotationId: 'anno_1', mediaId: 'crop_1', selector: '[data-testid="cancel"]' }));
    store.record(annotationItem({
      contextId: 'c2',
      annotationId: 'anno_1',
      mediaId: 'crop_1',
      region: { x: 20, y: 10, width: 40, height: 30 },
      stroke: { shape: 'freehand', points: [{ x: 0.1, y: 0.2 }, { x: 0.8, y: 0.7 }] },
    }));
    const service = createBrowserContextAttachService({ store });

    const result = service.attach({ annotationId: 'anno_1', destination: 'agentTurn' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const attachment = BrowserContextAttachmentV1Schema.parse(result.attachment);
    const structuredBlock = (attachment as { structuredBlock?: unknown }).structuredBlock;
    expect(structuredBlock).toMatchObject({
      kind: 'browser.annotation.v1',
      annotationId: 'anno_1',
      comment: 'needs spacing',
      contextIds: ['c0', 'c1', 'c2'],
      elements: [
        { selectorPath: '#save' },
        { selectorPath: '[data-testid="cancel"]' },
      ],
      regions: [
        { rect: { x: 20, y: 10, width: 40, height: 30 } },
      ],
      strokes: [
        { shape: 'freehand', points: [{ x: 0.1, y: 0.2 }, { x: 0.8, y: 0.7 }] },
      ],
      screenshot: {
        media: [{ mediaId: 'crop_1', mediaKind: 'image' }],
        cropRect: { x: 0, y: 0, width: 100, height: 80 },
      },
    });
    expect(JSON.stringify(structuredBlock)).not.toContain('data:image');
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
    expect(result.error).toContain('browser_context_attach_group_missing');
  });

  it('clear releases the shared mediaId once and empties the group', () => {
    const store = createBrowserContextItemStore();
    store.record(annotationItem({ contextId: 'c0', annotationId: 'anno_1', mediaId: 'crop_1', selector: '#a' }));
    store.record(annotationItem({ contextId: 'c1', annotationId: 'anno_1', mediaId: 'crop_1', selector: '#b' }));
    const service = createBrowserContextAttachService({ store });

    const cleared = service.clear({ annotationId: 'anno_1' });
    expect(cleared.releasedMediaIds).toEqual(['crop_1']);
    expect(cleared.clearedItems).toHaveLength(2);
    expect(store.size()).toBe(0);
  });
});
