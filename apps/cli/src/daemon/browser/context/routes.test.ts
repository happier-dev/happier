import {
  BrowserContextItemV1Schema,
  BrowserContextSnapshotV1Schema,
  getActionSpec,
  type BrowserContextSnapshotV1,
  type RuntimeActionIdV1,
} from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';

import type { BrowserContextSource } from './capture';
import { createBrowserContextRoutes } from './routes';

function fakeSource(): BrowserContextSource {
  return {
    capturePage: vi.fn(async () => ({
      ok: true as const,
      url: 'https://browser.example.test/page',
      title: 'Example',
    })),
    captureScreenshot: vi.fn(async () => ({
      ok: true as const,
      media: {
        mediaId: 'media_1',
        mediaKind: 'image' as const,
        width: 800,
        height: 600,
        sizeBytes: 2048,
      },
    })),
    captureSummary: vi.fn(async () => ({ ok: true as const, summary: 'summary text' })),
    captureSelectedElement: vi.fn(async () => ({ ok: true as const, selectorPath: 'main > h1' })),
    captureRegion: vi.fn(async (target) => ({
      ok: true as const,
      rect: target.rect,
      media: {
        mediaId: 'media_region',
        mediaKind: 'image' as const,
        width: target.rect.width,
        height: target.rect.height,
        sizeBytes: 1024,
      },
    })),
    captureElement: vi.fn(async () => ({
      ok: true as const,
      rect: { x: 5, y: 6, width: 100, height: 40 },
      media: {
        mediaId: 'media_element',
        mediaKind: 'image' as const,
        width: 100,
        height: 40,
        sizeBytes: 1024,
      },
    })),
  };
}

function routes(source: BrowserContextSource = fakeSource()) {
  return createBrowserContextRoutes({
    ownerAccountId: 'account_owner',
    source,
    now: () => 1_000,
    // browser.context is enabled in these routing tests. The capture gate is fail-closed by
    // default (GATE-SEC-001), so the happy path threads an explicit permissive gate — exactly
    // as the production route owner does from the live daemon feature-gate.
    resolveGate: () => ({ featureEnabled: true, policyAllowed: true, runtimeAvailable: true }),
  });
}

const validInput = {
  browserSessionId: 'browser_session_1',
  viewId: 'view_1',
  navigationGeneration: 2,
  contextId: 'context_1',
} as const;

const annotationActionInputs = {
  'browser.context.annotation.start': validInput,
  'browser.context.annotation.cancel': validInput,
  'browser.context.annotation.captureRegion': {
    ...validInput,
    rect: { x: 10, y: 20, width: 100, height: 40 },
  },
  'browser.context.annotation.captureElement': {
    ...validInput,
    selector: '#hero',
  },
  'browser.context.annotation.attachComment': {
    ...validInput,
    comment: 'looks off here',
  },
  'browser.context.annotation.attachStroke': {
    ...validInput,
    stroke: {
      shape: 'rectangle',
      points: [{ x: 0.1, y: 0.2 }],
    },
  },
  'browser.context.annotation.attachStyleIntent': {
    ...validInput,
    styleIntent: 'highlight',
  },
} as const satisfies Record<Extract<RuntimeActionIdV1, `browser.context.annotation.${string}`>, unknown>;

describe('browser context routes', () => {
  it('dispatches capturePage to a published page-reference context item', async () => {
    const result = await routes().dispatch('browser.context.capturePage', validInput);

    expect(BrowserContextItemV1Schema.safeParse(result).success).toBe(true);
    expect((result as { kind?: string }).kind).toBe('browserPageReference');
  });

  it('dispatches captureScreenshot to a screenshot context item', async () => {
    const result = await routes().dispatch('browser.context.captureScreenshot', validInput);

    expect((result as { kind?: string }).kind).toBe('browserScreenshot');
  });

  it('fails screenshot capture closed at the route when no daemon gate is threaded (GATE-SEC-001)', async () => {
    // Defense-in-depth: a route owner constructed without a gate must NOT leak a screenshot.
    const routesNoGate = createBrowserContextRoutes({
      ownerAccountId: 'account_owner',
      source: fakeSource(),
      now: () => 1_000,
    });

    const result = await routesNoGate.dispatch('browser.context.captureScreenshot', validInput);

    expect((result as { kind?: string }).kind).not.toBe('browserScreenshot');
  });

  it('dispatches captureNetworkSummary to a network-summary context item', async () => {
    const result = await routes().dispatch('browser.context.captureNetworkSummary', validInput);

    expect((result as { kind?: string }).kind).toBe('browserNetworkSummary');
  });

  it('dispatches captureConsoleSummary to a console-summary context item', async () => {
    const result = await routes().dispatch('browser.context.captureConsoleSummary', validInput);

    expect((result as { kind?: string }).kind).toBe('browserConsoleSummary');
  });

  it('returns invalid_parameters for input that fails protocol validation', async () => {
    const result = await routes().dispatch('browser.context.capturePage', {
      browserSessionId: '',
      viewId: 'view_1',
    });

    expect(result).toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
  });

  it('fails attach-to-composer closed when no captured group matches (ANNO-4b)', async () => {
    const result = await routes().dispatch('browser.context.attachToComposer', validInput);

    expect(result).toMatchObject({
      ok: false,
      errorCode: 'runtime_action_disabled',
    });
    expect((result as { error?: string }).error).toContain('browser_context_attach_group_missing');
  });

  // ANNO-4b end-to-end: capture a multi-target annotation through the daemon route (distinct
  // contextIds sharing one annotationId) → attach-to-composer groups them into ONE card referencing
  // the shared media → clear removes the group atomically (the cross-boundary path the unit tests
  // alone cannot prove).
  it('captures a multi-target annotation, attaches ONE grouped card, then clears it', async () => {
    const route = routes();
    const group = 'anno_group_1';

    const first = await route.dispatch('browser.context.annotation.captureRegion', {
      browserSessionId: 'browser_session_1',
      viewId: 'view_1',
      navigationGeneration: 2,
      contextId: 'ctx_a',
      annotationId: group,
      rect: { x: 0, y: 0, width: 50, height: 40 },
    });
    expect((first as { kind?: string }).kind).toBe('browserAnnotation');
    expect((first as { annotationId?: string }).annotationId).toBe(group);

    const second = await route.dispatch('browser.context.annotation.captureElement', {
      browserSessionId: 'browser_session_1',
      viewId: 'view_1',
      navigationGeneration: 2,
      contextId: 'ctx_b',
      annotationId: group,
      selector: '#hero',
    });
    expect((second as { annotationId?: string }).annotationId).toBe(group);

    // Attach by the shared annotationId → exactly ONE composer attachment card for the group.
    const attached = await route.dispatch('browser.context.attachToComposer', {
      browserSessionId: 'browser_session_1',
      viewId: 'view_1',
      navigationGeneration: 2,
      contextId: 'ctx_a',
      annotationId: group,
    });
    expect((attached as { v?: number }).v).toBe(1);
    expect((attached as { attachmentId?: string }).attachmentId).toBe(`browser_context_attachment:${group}`);

    // Attach to an agent turn yields the same single grouped card.
    const turn = await route.dispatch('browser.context.attachToAgentTurn', {
      browserSessionId: 'browser_session_1',
      viewId: 'view_1',
      navigationGeneration: 2,
      contextId: 'ctx_b',
      annotationId: group,
    });
    expect((turn as { attachmentId?: string }).attachmentId).toBe(`browser_context_attachment:${group}`);

    // Clear removes the whole group; a subsequent attach fails closed (group gone).
    const cleared = await route.dispatch('browser.context.clear', {
      browserSessionId: 'browser_session_1',
      viewId: 'view_1',
      navigationGeneration: 2,
      contextId: 'ctx_a',
      annotationId: group,
    });
    expect(Array.isArray(cleared)).toBe(true);
    expect((cleared as readonly unknown[]).length).toBe(2);

    const afterClear = await route.dispatch('browser.context.attachToComposer', {
      browserSessionId: 'browser_session_1',
      viewId: 'view_1',
      navigationGeneration: 2,
      contextId: 'ctx_a',
      annotationId: group,
    });
    expect(afterClear).toMatchObject({ ok: false, errorCode: 'runtime_action_disabled' });
  });

  // MCH-5: daemon-side annotation region/element pixel capture for the managed-Chromium engine.
  it('dispatches annotation.captureRegion to a browserAnnotation context item with region target', async () => {
    const result = await routes().dispatch('browser.context.annotation.captureRegion', {
      ...validInput,
      rect: { x: 10, y: 20, width: 100, height: 40 },
    });

    expect(BrowserContextItemV1Schema.safeParse(result).success).toBe(true);
    expect((result as { kind?: string }).kind).toBe('browserAnnotation');
    expect((result as { target?: { kind?: string } }).target?.kind).toBe('region');
  });

  it('dispatches annotation.captureElement to a browserAnnotation context item with element target', async () => {
    const result = await routes().dispatch('browser.context.annotation.captureElement', {
      ...validInput,
      selector: '#hero',
    });

    expect(BrowserContextItemV1Schema.safeParse(result).success).toBe(true);
    expect((result as { kind?: string }).kind).toBe('browserAnnotation');
    expect((result as { target?: { kind?: string } }).target?.kind).toBe('element');
  });

  it('returns invalid_parameters when annotation.captureRegion has no rect', async () => {
    const result = await routes().dispatch('browser.context.annotation.captureRegion', validInput);

    expect(result).toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
  });

  it('surfaces every annotation runtime action consistently on ui and session-agent', () => {
    for (const actionId of [
      'browser.context.annotation.start',
      'browser.context.annotation.cancel',
      'browser.context.annotation.captureRegion',
      'browser.context.annotation.captureElement',
      'browser.context.annotation.attachComment',
      'browser.context.annotation.attachStroke',
      'browser.context.annotation.attachStyleIntent',
    ] as const) {
      expect(getActionSpec(actionId).surfaces.ui).toBe(true);
      expect(getActionSpec(actionId).surfaces.agent).toBe(true);
    }
  });

  it('backs metadata-only annotation actions on the daemon context route', async () => {
    const route = routes();
    await route.dispatch('browser.context.annotation.captureRegion', {
      ...validInput,
      contextId: 'ctx_annotated',
      rect: { x: 10, y: 20, width: 100, height: 40 },
    });

    await expect(route.dispatch('browser.context.annotation.start', validInput)).resolves.toMatchObject({
      v: 1,
      actionId: 'browser.context.annotation.start',
      status: 'started',
    });
    await expect(route.dispatch('browser.context.annotation.cancel', validInput)).resolves.toMatchObject({
      v: 1,
      actionId: 'browser.context.annotation.cancel',
      status: 'cancelled',
    });
    await expect(route.dispatch('browser.context.annotation.attachComment', {
      ...validInput,
      contextId: 'ctx_annotated',
      comment: 'looks off here',
    })).resolves.toMatchObject({
      v: 1,
      actionId: 'browser.context.annotation.attachComment',
      status: 'updated',
      contextId: 'ctx_annotated',
    });
    await expect(route.dispatch('browser.context.annotation.attachStroke', {
      ...validInput,
      contextId: 'ctx_annotated',
      stroke: { shape: 'rectangle', points: [{ x: 0.1, y: 0.2 }] },
    })).resolves.toMatchObject({
      v: 1,
      actionId: 'browser.context.annotation.attachStroke',
      status: 'updated',
      contextId: 'ctx_annotated',
    });
    await expect(route.dispatch('browser.context.annotation.attachStyleIntent', {
      ...validInput,
      contextId: 'ctx_annotated',
      styleIntent: 'highlight',
    })).resolves.toMatchObject({
      v: 1,
      actionId: 'browser.context.annotation.attachStyleIntent',
      status: 'updated',
      contextId: 'ctx_annotated',
    });
  });

  it('does not return browser_context_action_unbacked for surfaced annotation session-agent actions', async () => {
    for (const [actionId, input] of Object.entries(annotationActionInputs)) {
      if (!getActionSpec(actionId as RuntimeActionIdV1).surfaces.agent) continue;
      const result = await routes().dispatch(actionId as RuntimeActionIdV1, input);

      expect(String((result as { error?: string }).error ?? '')).not.toContain('browser_context_action_unbacked');
    }
  });

  it('binds the requester to the route owner account, ignoring caller-supplied identity', async () => {
    const source = fakeSource();
    // Even if a caller smuggles a requesterAccountId, the route owner uses its bound
    // owner account — caller-provided trust is never echoed.
    const result = await routes(source).dispatch('browser.context.capturePage', {
      ...validInput,
      requesterAccountId: 'account_intruder',
    });

    expect(BrowserContextItemV1Schema.safeParse(result).success).toBe(true);
    expect(source.capturePage).toHaveBeenCalledOnce();
  });

  // BA-2 combined rich agent snapshot.
  describe('captureSnapshot (BA-2 combined op)', () => {
    function snapshotSource(): BrowserContextSource {
      return {
        ...fakeSource(),
        captureSnapshot: vi.fn(async () => ({
          ok: true as const,
          url: 'https://example.test/app',
          title: 'App',
          visibleText: 'hello world',
          axNodes: [{ role: 'button', name: 'Go' }],
          interactiveElements: [
            { role: 'button', name: 'Go', selector: '#go', rect: { x: 1, y: 2, width: 30, height: 12 } },
          ],
          consoleSummary: '[error] 1 message',
          media: { mediaId: 'media_snap', mediaKind: 'image' as const, width: 800, height: 600, sizeBytes: 4096 },
        })),
      };
    }

    it('returns a single combined snapshot carrying AX tree, interactive elements, text, console and media', async () => {
      const result = await routes(snapshotSource()).captureSnapshot?.(validInput);
      expect(BrowserContextSnapshotV1Schema.safeParse(result).success).toBe(true);
      const snapshot = result as BrowserContextSnapshotV1;
      expect(snapshot.url).toBe('https://example.test/app');
      expect(snapshot.visibleText).toBe('hello world');
      expect(snapshot.axNodes).toEqual([{ role: 'button', name: 'Go' }]);
      expect(snapshot.interactiveElements[0]).toMatchObject({ role: 'button', selector: '#go' });
      expect(snapshot.consoleSummary).toBe('[error] 1 message');
      expect(snapshot.media?.mediaId).toBe('media_snap');
      // LANE-B egress: full fidelity to the local owner; the egress chokepoint redacts later.
      expect(snapshot.redactionLevel).toBe('none');
    });

    it('binds the snapshot requester to the route owner, ignoring caller-supplied identity', async () => {
      const source = snapshotSource();
      await routes(source).captureSnapshot?.({ ...validInput, requesterAccountId: 'account_intruder' });
      expect(source.captureSnapshot).toHaveBeenCalledWith(
        expect.objectContaining({ browserSessionId: 'browser_session_1', viewId: 'view_1' }),
      );
    });

    it('fails closed (disabled) when the daemon gate denies capture', async () => {
      const denied = createBrowserContextRoutes({
        ownerAccountId: 'account_owner',
        source: snapshotSource(),
        now: () => 1_000,
        resolveGate: () => ({ featureEnabled: false, policyAllowed: true, runtimeAvailable: true }),
      });
      const result = await denied.captureSnapshot?.(validInput);
      expect(result).toMatchObject({ ok: false, errorCode: 'runtime_action_disabled' });
    });

    it('reports the producer honestly unavailable when the source cannot snapshot', async () => {
      // fakeSource() has no captureSnapshot producer.
      const result = await routes().captureSnapshot?.(validInput);
      expect(result).toMatchObject({ ok: false, errorCode: 'runtime_action_disabled' });
      expect((result as { error?: string }).error).toContain('browser snapshot producer unavailable');
    });

    it('rejects a malformed view reference with invalid_parameters', async () => {
      const result = await routes(snapshotSource()).captureSnapshot?.({ viewId: 'view_1' });
      expect(result).toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
    });
  });
});
