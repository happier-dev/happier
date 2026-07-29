import { BrowserContextItemV1Schema } from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';

import {
  createBrowserContextCaptureService,
  type BrowserContextSource,
} from './capture';

function fakeSource(overrides: Partial<BrowserContextSource> = {}): BrowserContextSource {
  return {
    capturePage: vi.fn(async () => ({
      ok: true as const,
      url: 'https://browser.example.test/page?token=secret&q=keep',
      title: 'Example Page',
      faviconUrl: 'https://browser.example.test/favicon.ico',
      targetKind: 'externalUrl' as const,
    })),
    captureScreenshot: vi.fn(async () => ({
      ok: true as const,
      media: {
        mediaId: 'media_screenshot_1',
        mediaKind: 'image' as const,
        width: 1024,
        height: 768,
        sizeBytes: 4096,
      },
    })),
    captureSummary: vi.fn(async () => ({
      ok: true as const,
      summary: 'Body text summary',
      truncated: false,
    })),
    captureSelectedElement: vi.fn(async () => ({
      ok: true as const,
      selectorPath: 'body > main > h1',
      accessibleName: 'Heading',
    })),
    ...overrides,
  };
}

const baseRequest = {
  requesterAccountId: 'account_owner',
  browserSessionId: 'browser_session_1',
  viewId: 'view_1',
  navigationGeneration: 3,
  contextId: 'context_1',
} as const;

// The permissive gate the daemon route owner threads in production when browser.context is
// enabled. Happy-path tests opt into it EXPLICITLY: omitting resolveGate now fails closed
// (GATE-SEC-001 — the default is fail-closed, matching OWNER-GATE "missing ⇒ disabled").
const allowGate = () => ({ featureEnabled: true, policyAllowed: true, runtimeAvailable: true });

describe('browser context capture service', () => {
  it('captures a page reference item with the URL redacted by the sidecar owner', async () => {
    const source = fakeSource();
    const service = createBrowserContextCaptureService({
      ownerAccountId: 'account_owner',
      source,
      now: () => 1_000,
      resolveGate: allowGate,
    });

    const result = await service.capturePage(baseRequest);

    expect(result.status).toBe('captured');
    if (result.status !== 'captured') return;
    expect(BrowserContextItemV1Schema.safeParse(result.item).success).toBe(true);
    expect(result.item.kind).toBe('browserPageReference');
    expect(result.item.lifecycleState).toBe('available');
    expect(result.item.sourceAdapterKind).toBe('chromiumSidecar');
    // CDP ids / raw query values never leave the daemon — the redaction owner keeps
    // only safe query keys (no values), and drops unsafe telemetry keys entirely.
    if (result.item.kind === 'browserPageReference') {
      expect(result.item.url).toBe('https://browser.example.test/page?q');
      expect(result.item.url).not.toContain('secret');
      expect(result.item.url).not.toContain('keep');
      expect(result.item.origin).toBe('https://browser.example.test');
    }
    expect(source.capturePage).toHaveBeenCalledWith({
      browserSessionId: 'browser_session_1',
      viewId: 'view_1',
      navigationGeneration: 3,
    });
  });

  it('captures a screenshot item from source media', async () => {
    const service = createBrowserContextCaptureService({
      ownerAccountId: 'account_owner',
      source: fakeSource(),
      now: () => 2_000,
      resolveGate: allowGate,
    });

    const result = await service.captureScreenshot(baseRequest);

    expect(result.status).toBe('captured');
    if (result.status !== 'captured') return;
    expect(result.item.kind).toBe('browserScreenshot');
    expect(result.item.capturedAtMs).toBe(2_000);
  });

  it('captures a summary item for network/console/page summaries', async () => {
    const service = createBrowserContextCaptureService({
      ownerAccountId: 'account_owner',
      source: fakeSource(),
      now: () => 3_000,
    });

    const result = await service.captureSummary({
      ...baseRequest,
      kind: 'browserNetworkSummary',
    });

    expect(result.status).toBe('captured');
    if (result.status !== 'captured') return;
    expect(result.item.kind).toBe('browserNetworkSummary');
    if (
      result.item.kind === 'browserNetworkSummary'
      || result.item.kind === 'browserConsoleSummary'
      || result.item.kind === 'browserPageTextSummary'
      || result.item.kind === 'browserDomSnapshotSummary'
    ) {
      expect(result.item.summary).toBe('Body text summary');
    }
  });

  it('denies capture when the requester is not the lease owner', async () => {
    const source = fakeSource();
    const service = createBrowserContextCaptureService({
      ownerAccountId: 'account_owner',
      source,
      now: () => 4_000,
    });

    const result = await service.capturePage({
      ...baseRequest,
      requesterAccountId: 'account_intruder',
    });

    expect(result.status).toBe('denied');
    expect(source.capturePage).not.toHaveBeenCalled();
  });

  it('publishes an unavailable summary item when the source reports the adapter is unavailable', async () => {
    const service = createBrowserContextCaptureService({
      ownerAccountId: 'account_owner',
      source: fakeSource({
        captureSummary: vi.fn(async () => ({
          ok: false as const,
          reason: 'adapter_unavailable' as const,
        })),
      }),
      now: () => 5_000,
    });

    const result = await service.captureSummary({
      ...baseRequest,
      kind: 'browserConsoleSummary',
    });

    expect(result.status).toBe('unavailable');
    if (result.status !== 'unavailable') return;
    expect(result.item.lifecycleState).toBe('adapterUnavailable');
    expect(result.item.disabledReason).toBeTruthy();
    expect(BrowserContextItemV1Schema.safeParse(result.item).success).toBe(true);
  });

  it('defaults to fail-closed for page capture when no daemon gate is threaded (GATE-SEC-001)', async () => {
    const source = fakeSource();
    // No resolveGate provided. A sensitive capture gate MUST fail closed by default — the
    // permissive happy path is opt-in (allowGate), never the fallback. No captured URL may leak.
    const service = createBrowserContextCaptureService({
      ownerAccountId: 'account_owner',
      source,
      now: () => 9_000,
    });

    const result = await service.capturePage(baseRequest);

    expect(result.status).toBe('captured');
    if (result.status !== 'captured') return;
    expect(result.item.lifecycleState).toBe('policyDenied');
    expect(result.item.redactionLevel).toBe('blocked');
    if (result.item.kind === 'browserPageReference') {
      expect(result.item.url).toBeUndefined();
    }
  });

  it('fails a page capture closed when the threaded daemon gate reports the feature disabled', async () => {
    const source = fakeSource();
    const service = createBrowserContextCaptureService({
      ownerAccountId: 'account_owner',
      source,
      now: () => 7_000,
      // The single-owner daemon feature-gate is consulted at publish time. A server that
      // disables browser.context after the route owner was constructed must fail closed.
      resolveGate: () => ({ featureEnabled: false, policyAllowed: true, runtimeAvailable: true }),
    });

    const result = await service.capturePage(baseRequest);

    // The page reference is published as policy-denied: no captured URL leaves the daemon.
    expect(result.status).toBe('captured');
    if (result.status !== 'captured') return;
    expect(result.item.lifecycleState).toBe('policyDenied');
    expect(result.item.redactionLevel).toBe('blocked');
    if (result.item.kind === 'browserPageReference') {
      expect(result.item.url).toBeUndefined();
    }
    expect(BrowserContextItemV1Schema.safeParse(result.item).success).toBe(true);
  });

  it('fails a screenshot capture closed without leaking media when the threaded gate is disabled', async () => {
    const service = createBrowserContextCaptureService({
      ownerAccountId: 'account_owner',
      source: fakeSource(),
      now: () => 8_000,
      resolveGate: () => ({ featureEnabled: false, policyAllowed: true, runtimeAvailable: true }),
    });

    const result = await service.captureScreenshot(baseRequest);

    expect(result.status).toBe('unavailable');
    if (result.status !== 'unavailable') return;
    expect(result.item.kind).not.toBe('browserScreenshot');
    expect(result.item.disabledReason).toBeTruthy();
  });

  it('blocks a screenshot capture without leaking media when the source reports capture failed', async () => {
    const service = createBrowserContextCaptureService({
      ownerAccountId: 'account_owner',
      source: fakeSource({
        captureScreenshot: vi.fn(async () => ({
          ok: false as const,
          reason: 'capture_failed' as const,
        })),
      }),
      now: () => 6_000,
    });

    const result = await service.captureScreenshot(baseRequest);

    expect(result.status).toBe('unavailable');
    if (result.status !== 'unavailable') return;
    expect(result.item.kind).not.toBe('browserScreenshot');
    expect(result.item.lifecycleState).toBe('captureFailed');
  });
});
