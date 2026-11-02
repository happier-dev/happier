import {
  BrowserContextItemV1Schema,
  BrowserContextSnapshotV1Schema,
  type BrowserContextSnapshotV1,
} from '@happier-dev/protocol/browser/context/v1';
import { describe, expect, it, vi } from 'vitest';

import type { BrowserContextSource } from './capture';
import { createBrowserContextRoutes } from './routes';
import { createBrowserAutomationOwnerRegistry } from '../automation/owners';

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

describe('browser context routes', () => {
  it('refuses host-only annotation start and cancel instead of reporting a daemon no-op success', async () => {
    const route = routes();
    for (const actionId of ['browser.context.annotation.start', 'browser.context.annotation.cancel'] as const) {
      expect(await route.dispatch(actionId, validInput)).toMatchObject({ ok: false,
        errorCode: 'runtime_action_disabled', error: 'runtime_action_disabled:browser:browser_context_action_unbacked' });
    }
  });
  it('does not disclose previously captured context through attach while its view is held', async () => {
    const owners = createBrowserAutomationOwnerRegistry();
    const control = owners.getInputControl(validInput);
    const owner = createBrowserContextRoutes({
      ownerAccountId: 'account_owner', source: fakeSource(), resolveInputControl: owners.getInputControl,
      resolveGate: () => ({ featureEnabled: true, policyAllowed: true, runtimeAvailable: true }),
    });
    expect(await owner.dispatch('browser.context.captureScreenshot', validInput)).toMatchObject({ kind: 'browserScreenshot' });
    await control.beginConfidentialityHold();
    expect(await owner.dispatch('browser.context.attachToComposer', validInput)).toMatchObject({
      ok: false, errorCode: 'runtime_action_disabled',
    });
    expect(await owner.dispatch('browser.context.attachToComposer', {
      ...validInput, browserSessionId: 'other_session', viewId: 'other_view',
    })).toMatchObject({ ok: false, errorCode: 'runtime_action_disabled' });
  });

  it('dispatches capturePage to a published page-reference context item', async () => {
    const result = await routes().dispatch('browser.context.capturePage', validInput);

    expect(BrowserContextItemV1Schema.safeParse(result).success).toBe(true);
    expect((result as { kind?: string }).kind).toBe('browserPageReference');
  });

  it('dispatches captureScreenshot to a screenshot context item', async () => {
    const result = await routes().dispatch('browser.context.captureScreenshot', validInput);

    expect((result as { kind?: string }).kind).toBe('browserScreenshot');
  });

  it('does not claim to execute a mounted-client annotation Action at the daemon', async () => {
    expect(await routes().dispatch('browser.context.annotation.start', {
      browserSessionId: validInput.browserSessionId, viewId: validInput.viewId,
    })).toMatchObject({ ok: false, errorCode: 'runtime_action_disabled' });
  });

  it('attaches and clears the ordinary screenshot after annotation capture aliases retire', async () => {
    const route = routes();
    const item = await route.dispatch('browser.context.captureScreenshot', validInput);
    expect(item).toMatchObject({ kind: 'browserScreenshot', contextId: validInput.contextId });
    const attachment = await route.dispatch('browser.context.attachToAgentTurn', validInput);
    expect(attachment).toMatchObject({ contextId: validInput.contextId, state: 'available' });
    expect(attachment).not.toHaveProperty('structuredBlock');
    expect(await route.dispatch('browser.context.clear', validInput)).toEqual([item]);
    expect(await route.dispatch('browser.context.attachToAgentTurn', validInput)).toMatchObject({ ok: false });
    expect(await route.dispatch('browser.context.captureSelectedElement', validInput)).toMatchObject({
      kind: 'browserSelectedElement', selectorPath: 'main > h1',
    });
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
    expect((result as { error?: string }).error).toContain('browser_context_item_missing');
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
