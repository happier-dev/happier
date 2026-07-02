import { describe, expect, it } from 'vitest';

type BrowserTargetModule = typeof import('./v1.js');

async function loadBrowserTargetModule(): Promise<BrowserTargetModule | null> {
  return import('./v1.js').catch(() => null);
}

describe('browser view target v1 protocol', () => {
  it('accepts local service preview targets and preserves display identity', async () => {
    const mod = await loadBrowserTargetModule();

    const result = mod?.BrowserViewTargetV1Schema.safeParse({
      kind: 'localServicePreview',
      targetId: 'preview_123',
      sessionId: 'session_123',
      machineId: 'machine_123',
      display: {
        title: 'Kitchen Sink',
        addressLabel: 'localhost:5173',
        folderLabel: 'happier',
      },
    });

    expect(result?.success).toBe(true);
    if (result?.success) {
      expect(result.data.display.title).toBe('Kitchen Sink');
      expect(result.data.display.addressLabel).toBe('localhost:5173');
    }
  });

  it('rejects unknown target kinds instead of accepting unowned browser behavior', async () => {
    const mod = await loadBrowserTargetModule();

    const result = mod?.BrowserViewTargetV1Schema.safeParse({
      kind: 'rawCdp',
      targetId: 'browser_123',
    });

    expect(result?.success).toBe(false);
  });

  it('rejects non-http external URL browser targets', async () => {
    const mod = await loadBrowserTargetModule();

    const result = mod?.BrowserViewTargetV1Schema.safeParse({
      kind: 'externalUrl',
      targetId: 'external_123',
      url: 'javascript:alert(1)',
    });

    expect(result?.success).toBe(false);
  });

  it('accepts local-service-backed target suggestions without duplicating identity fields', async () => {
    const mod = await loadBrowserTargetModule();

    const result = mod?.BrowserTargetSuggestionV1Schema.safeParse({
      suggestionId: 'suggestion_1',
      source: { kind: 'localServiceInventory', serviceId: 'service_1' },
      target: {
        kind: 'localServicePreview',
        targetId: 'preview_123',
        sessionId: 'session_123',
        machineId: 'machine_123',
      },
      display: {
        title: 'Kitchen Sink',
        addressLabel: 'localhost:5173',
        folderLabel: 'happier',
      },
      lastSeenAt: 1_000,
    });

    expect(result?.success).toBe(true);
  });
});
