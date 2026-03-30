import { describe, expect, it, vi } from 'vitest';

import { createSecureAccessTailscaleHandler } from './secureAccessTailscale.js';

async function collectHandlerRun(
  params: Readonly<{
    handler: ReturnType<typeof createSecureAccessTailscaleHandler>;
    input: Record<string, unknown>;
  }>,
): Promise<Readonly<{
  events: unknown[];
  result: unknown;
}>> {
  const events: unknown[] = [];
  const iterator = params.handler(params.input);

  while (true) {
    const next = await iterator.next();
    if (next.done) {
      return {
        events,
        result: next.value,
      };
    }
    events.push(next.value);
  }
}

describe('createSecureAccessTailscaleHandler', () => {
  it('installs missing tailscale before continuing through the existing secure-access flow', async () => {
    let inspectCalls = 0;
    const ensureInstalled = vi.fn(async () => ({
      outcome: 'ready' as const,
      installedNow: true,
      installerLaunched: true,
      tailscaleBin: '/tmp/tailscale',
    }));
    const inspectState = vi.fn(async () => {
      inspectCalls += 1;
      if (inspectCalls === 1) {
        return {
          installed: false,
          loggedIn: false,
          authUrl: null,
          shareableHttpsUrl: null,
        };
      }
      return {
        installed: true,
        loggedIn: true,
        authUrl: null,
        shareableHttpsUrl: 'https://relay.tailf00.ts.net',
      };
    });

    const deps = {
      inspectState,
      ensureInstalled,
      loginInteractive: vi.fn(async () => {
        throw new Error('login should not run when install finishes into an already-authenticated tailscale state');
      }),
      enableServe: vi.fn(async () => {
        throw new Error('serve enable should not run when the existing shareable URL is already available');
      }),
      resolveInstallPrompt: vi.fn((platform: NodeJS.Platform) => ({ platform, url: 'https://tailscale.com/download/mac' })),
      platform: 'darwin' as const,
    };

    const { events, result } = await collectHandlerRun({
      handler: createSecureAccessTailscaleHandler(deps),
      input: {
        upstreamUrl: 'http://127.0.0.1:3005',
        installPolicy: 'installIfMissing',
      },
    });

    expect(ensureInstalled).toHaveBeenCalledTimes(1);
    expect(inspectState).toHaveBeenCalledTimes(2);
    expect(events).toEqual([
      expect.objectContaining({ type: 'progress', stepId: 'detect' }),
      expect.objectContaining({
        type: 'progress',
        stepId: 'install',
      }),
      expect.objectContaining({
        type: 'progress',
        stepId: 'verify url',
        data: {
          kind: 'tailscaleSecureAccessUrl',
          shareableHttpsUrl: 'https://relay.tailf00.ts.net',
        },
      }),
    ]);
    expect(result).toEqual({
      tailscaleInstalled: true,
      tailscaleLoggedIn: true,
      serveEnabled: true,
      shareableHttpsUrl: 'https://relay.tailf00.ts.net',
      requiresApproval: null,
    });
  });
});
