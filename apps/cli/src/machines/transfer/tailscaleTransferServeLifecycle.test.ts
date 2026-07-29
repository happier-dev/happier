import { describe, expect, it, vi } from 'vitest';

import { createTailscaleTransferServeLifecycle } from './tailscaleTransferServeLifecycle';

describe('createTailscaleTransferServeLifecycle', () => {
  it('enables the owned serve mapping when the shared transfer server starts and disables it when it stops', async () => {
    const runTailscaleServeEnable = vi.fn(async () => ({
      approvalUrl: null,
      httpsUrl: 'https://machine.tailnet.ts.net:8443',
      rawStatus: 'https://machine.tailnet.ts.net:8443\n|-- /__happier/transfer proxy http://127.0.0.1:46001',
    }));
    const runTailscaleServeDisable = vi.fn(async () => undefined);
    const listenerStates: Array<{
      enabled: boolean;
      configured: boolean;
      active: boolean;
      available?: boolean;
    }> = [];

    const lifecycle = createTailscaleTransferServeLifecycle({
      enabled: true,
      servePath: '/__happier/transfer',
      httpsPort: 8443,
      onListenerStateChange: (state) => {
        listenerStates.push(state);
      },
      runTailscaleServeEnable,
      runTailscaleServeDisable,
    });

    await lifecycle.observeDirectTransferServerLifecycleState({
      status: 'running',
      listenerClasses: ['loopback_http'],
      port: 46001,
      publishedTransferCount: 1,
    });

    expect(lifecycle.getHttpsBaseUrlWithServePath()).toBe('https://machine.tailnet.ts.net:8443/__happier/transfer');

    expect(runTailscaleServeEnable).toHaveBeenCalledTimes(1);
    expect(runTailscaleServeEnable).toHaveBeenCalledWith({
      env: process.env,
      upstreamUrl: 'http://127.0.0.1:46001',
      servePath: '/__happier/transfer',
      httpsPort: 8443,
    });
    expect(listenerStates.at(-1)).toEqual({
      enabled: true,
      configured: true,
      active: true,
      available: true,
    });

    await lifecycle.observeDirectTransferServerLifecycleState({
      status: 'stopped',
      listenerClasses: ['loopback_http'],
      publishedTransferCount: 0,
    });

    expect(lifecycle.getHttpsBaseUrlWithServePath()).toBe(null);

    expect(runTailscaleServeDisable).toHaveBeenCalledTimes(1);
    expect(runTailscaleServeDisable).toHaveBeenCalledWith({
      env: process.env,
      servePath: '/__happier/transfer',
      httpsPort: 8443,
    });
    expect(listenerStates.at(-1)).toEqual({
      enabled: true,
      configured: false,
      active: false,
      available: true,
    });
  });

  it('does not re-enable the owned mapping on repeated running updates for the same shared transfer server port', async () => {
    const runTailscaleServeEnable = vi.fn(async () => ({
      approvalUrl: null,
      httpsUrl: 'https://machine.tailnet.ts.net:8443',
      rawStatus: 'https://machine.tailnet.ts.net:8443\n|-- /__happier/transfer proxy http://127.0.0.1:46001',
    }));

    const lifecycle = createTailscaleTransferServeLifecycle({
      enabled: true,
      servePath: '/__happier/transfer',
      httpsPort: 8443,
      runTailscaleServeEnable,
      runTailscaleServeDisable: vi.fn(async () => undefined),
    });

    await lifecycle.observeDirectTransferServerLifecycleState({
      status: 'running',
      listenerClasses: ['loopback_http'],
      port: 46001,
      publishedTransferCount: 1,
    });
    await lifecycle.observeDirectTransferServerLifecycleState({
      status: 'running',
      listenerClasses: ['loopback_http'],
      port: 46001,
      publishedTransferCount: 2,
    });

    expect(runTailscaleServeEnable).toHaveBeenCalledTimes(1);
  });

  it('disables and re-enables the owned mapping when the shared transfer server port changes', async () => {
    const runTailscaleServeEnable = vi.fn(async ({ upstreamUrl }: { upstreamUrl: string }) => ({
      approvalUrl: null,
      httpsUrl: 'https://machine.tailnet.ts.net:8443',
      rawStatus: `https://machine.tailnet.ts.net:8443\n|-- /__happier/transfer proxy ${upstreamUrl}`,
    }));
    const runTailscaleServeDisable = vi.fn(async () => undefined);

    const lifecycle = createTailscaleTransferServeLifecycle({
      enabled: true,
      servePath: '/__happier/transfer',
      httpsPort: 8443,
      runTailscaleServeEnable,
      runTailscaleServeDisable,
    });

    await lifecycle.observeDirectTransferServerLifecycleState({
      status: 'running',
      listenerClasses: ['loopback_http'],
      port: 46001,
      publishedTransferCount: 1,
    });
    await lifecycle.observeDirectTransferServerLifecycleState({
      status: 'running',
      listenerClasses: ['loopback_http'],
      port: 46002,
      publishedTransferCount: 1,
    });

    expect(runTailscaleServeEnable).toHaveBeenCalledTimes(2);
    expect(runTailscaleServeDisable).toHaveBeenCalledTimes(1);
    expect(runTailscaleServeEnable).toHaveBeenNthCalledWith(1, {
      env: process.env,
      upstreamUrl: 'http://127.0.0.1:46001',
      servePath: '/__happier/transfer',
      httpsPort: 8443,
    });
    expect(runTailscaleServeEnable).toHaveBeenNthCalledWith(2, {
      env: process.env,
      upstreamUrl: 'http://127.0.0.1:46002',
      servePath: '/__happier/transfer',
      httpsPort: 8443,
    });
    expect(runTailscaleServeDisable).toHaveBeenCalledWith({
      env: process.env,
      servePath: '/__happier/transfer',
      httpsPort: 8443,
    });
  });

  it('publishes approval-needed serve results as configured but not active', async () => {
    const listenerStates: Array<{
      enabled: boolean;
      configured: boolean;
      active: boolean;
      available?: boolean;
    }> = [];

    const lifecycle = createTailscaleTransferServeLifecycle({
      enabled: true,
      servePath: '/__happier/transfer',
      httpsPort: 8443,
      onListenerStateChange: (state) => {
        listenerStates.push(state);
      },
      runTailscaleServeEnable: vi.fn(async () => ({
        approvalUrl: 'https://login.tailscale.com/f/serve?node=node-123',
        httpsUrl: null,
        rawStatus: 'To authorize your tailnet, visit https://login.tailscale.com/f/serve?node=node-123',
      })),
      runTailscaleServeDisable: vi.fn(async () => undefined),
    });

    await lifecycle.observeDirectTransferServerLifecycleState({
      status: 'running',
      listenerClasses: ['loopback_http'],
      port: 46001,
      publishedTransferCount: 1,
    });

    expect(listenerStates.at(-1)).toEqual({
      enabled: true,
      configured: true,
      active: false,
      available: true,
    });
    expect(lifecycle.getHttpsBaseUrlWithServePath()).toBe(null);
  });

  it('publishes unavailable when the owned mapping is enabled but its status cannot be read back', async () => {
    const listenerStates: Array<{
      enabled: boolean;
      configured: boolean;
      active: boolean;
      available?: boolean;
    }> = [];

    const runTailscaleServeDisable = vi.fn(async () => undefined);
    const lifecycle = createTailscaleTransferServeLifecycle({
      enabled: true,
      servePath: '/__happier/transfer',
      httpsPort: 8443,
      onListenerStateChange: (state) => {
        listenerStates.push(state);
      },
      runTailscaleServeEnable: vi.fn(async () => ({
        approvalUrl: null,
        httpsUrl: null,
        rawStatus: '',
      })),
      runTailscaleServeDisable,
    });

    await lifecycle.observeDirectTransferServerLifecycleState({
      status: 'running',
      listenerClasses: ['loopback_http'],
      port: 46001,
      publishedTransferCount: 1,
    });

    expect(listenerStates.at(-1)).toEqual({
      enabled: true,
      configured: false,
      active: false,
      available: false,
    });
    expect(lifecycle.getHttpsBaseUrlWithServePath()).toBe(null);

    await lifecycle.stop();

    expect(runTailscaleServeDisable).toHaveBeenCalledOnce();
    expect(runTailscaleServeDisable).toHaveBeenCalledWith({
      env: process.env,
      servePath: '/__happier/transfer',
      httpsPort: 8443,
    });
  });

  it('disables the owned mapping when the runtime feature is turned off', async () => {
    const runTailscaleServeEnable = vi.fn(async () => ({
      approvalUrl: null,
      httpsUrl: 'https://machine.tailnet.ts.net:8443',
      rawStatus: 'https://machine.tailnet.ts.net:8443\n|-- /__happier/transfer proxy http://127.0.0.1:46001',
    }));
    const runTailscaleServeDisable = vi.fn(async () => undefined);

    const lifecycle = createTailscaleTransferServeLifecycle({
      enabled: true,
      servePath: '/__happier/transfer',
      httpsPort: 8443,
      runTailscaleServeEnable,
      runTailscaleServeDisable,
    });

    await lifecycle.observeDirectTransferServerLifecycleState({
      status: 'running',
      listenerClasses: ['loopback_http'],
      port: 46001,
      publishedTransferCount: 1,
    });

    await lifecycle.stop();

    expect(runTailscaleServeDisable).toHaveBeenCalledTimes(1);
    expect(runTailscaleServeDisable).toHaveBeenCalledWith({
      env: process.env,
      servePath: '/__happier/transfer',
      httpsPort: 8443,
    });
    expect(lifecycle.getHttpsBaseUrlWithServePath()).toBe(null);
  });
});
