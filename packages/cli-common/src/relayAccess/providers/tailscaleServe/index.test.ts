import { describe, expect, it, vi } from 'vitest';

import { tailscaleServeRelayAccessProvider } from './index.js';

vi.mock('../../../tailscale/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../../tailscale/index.js')>('../../../tailscale/index.js');
  return {
    ...actual,
    runTailscaleStatusJson: vi.fn(),
    runTailscaleServeStatus: vi.fn(),
    runTailscaleServeEnable: vi.fn(),
    runTailscaleServeDisable: vi.fn(),
    runTailscaleServeReset: vi.fn(),
  };
});

describe('tailscaleServeRelayAccessProvider', () => {
  it('returns needs_auth when tailscale is not logged in', async () => {
    const { runTailscaleStatusJson } = await import('../../../tailscale/index.js');
    vi.mocked(runTailscaleStatusJson).mockResolvedValue({
      backendState: 'Stopped',
      authUrl: 'https://login.tailscale.com/a/example',
      dnsName: null,
      tailnetName: null,
      tailscaleIps: [],
      loggedIn: false,
    });

    await expect(
      tailscaleServeRelayAccessProvider.status({ config: { providerId: 'tailscaleServe' }, ctx: { env: process.env, upstreamUrl: null } }),
    ).resolves.toEqual({
      state: 'needs_auth',
      details: {
        backendState: 'Stopped',
        authUrl: 'https://login.tailscale.com/a/example',
      },
    });
  });

  it('returns enabled with the serve https url when serve is configured', async () => {
    const { runTailscaleStatusJson, runTailscaleServeStatus } = await import('../../../tailscale/index.js');
    vi.mocked(runTailscaleStatusJson).mockResolvedValue({
      backendState: 'Running',
      authUrl: null,
      dnsName: 'machine.tailnet.ts.net',
      tailnetName: 'tailnet.ts.net',
      tailscaleIps: [],
      loggedIn: true,
    });
    vi.mocked(runTailscaleServeStatus).mockResolvedValue('https://machine.tailnet.ts.net\n|-- / proxy http://127.0.0.1:3005');

    const res = await tailscaleServeRelayAccessProvider.status({ config: { providerId: 'tailscaleServe' }, ctx: { env: process.env, upstreamUrl: null } });
    expect(res).toMatchObject({
      state: 'enabled',
      shareUrl: 'https://machine.tailnet.ts.net',
    });
  });

  it('returns the share url for the requested upstream even when serve status includes other mappings first', async () => {
    const { runTailscaleStatusJson, runTailscaleServeStatus } = await import('../../../tailscale/index.js');
    vi.mocked(runTailscaleStatusJson).mockResolvedValue({
      backendState: 'Running',
      authUrl: null,
      dnsName: 'machine.tailnet.ts.net',
      tailnetName: 'tailnet.ts.net',
      tailscaleIps: [],
      loggedIn: true,
    });
    vi.mocked(runTailscaleServeStatus).mockResolvedValue([
      'https://other.tailnet.ts.net',
      '|-- / proxy http://127.0.0.1:9999',
      '',
      'https://machine.tailnet.ts.net:8443',
      '|-- /__happier/transfer proxy http://127.0.0.1:3005',
    ].join('\n'));

    const res = await tailscaleServeRelayAccessProvider.status({
      config: { providerId: 'tailscaleServe' },
      ctx: { env: process.env, upstreamUrl: 'http://127.0.0.1:3005' },
    });

    expect(res).toEqual({
      state: 'enabled',
      shareUrl: 'https://machine.tailnet.ts.net:8443',
    });
  });

  it('returns disabled when serve is not configured', async () => {
    const { runTailscaleStatusJson, runTailscaleServeStatus } = await import('../../../tailscale/index.js');
    vi.mocked(runTailscaleStatusJson).mockResolvedValue({
      backendState: 'Running',
      authUrl: null,
      dnsName: 'machine.tailnet.ts.net',
      tailnetName: 'tailnet.ts.net',
      tailscaleIps: [],
      loggedIn: true,
    });
    vi.mocked(runTailscaleServeStatus).mockResolvedValue('No serve config');

    await expect(
      tailscaleServeRelayAccessProvider.status({ config: { providerId: 'tailscaleServe' }, ctx: { env: process.env, upstreamUrl: null } }),
    ).resolves.toEqual({
      state: 'disabled',
    });
  });

  it('configures tailscale serve for the upstream url', async () => {
    const { runTailscaleServeEnable } = await import('../../../tailscale/index.js');
    vi.mocked(runTailscaleServeEnable).mockResolvedValue({
      approvalUrl: null,
      httpsUrl: 'https://machine.tailnet.ts.net',
      rawStatus: 'ok',
    });

    const ctx = { env: process.env, upstreamUrl: 'http://127.0.0.1:3005' };
    const res = await tailscaleServeRelayAccessProvider.configure?.({ config: { providerId: 'tailscaleServe' }, ctx });
    expect(runTailscaleServeEnable).toHaveBeenCalledTimes(1);
    expect(res).toEqual({
      state: 'enabled',
      shareUrl: 'https://machine.tailnet.ts.net',
    });
  });

  it('disables only the configured serve mount instead of resetting all serve config', async () => {
    const { runTailscaleServeDisable, runTailscaleServeReset } = await import('../../../tailscale/index.js');
    vi.mocked(runTailscaleServeDisable).mockResolvedValue(undefined);

    await tailscaleServeRelayAccessProvider.disable?.({
      config: { providerId: 'tailscaleServe' },
      ctx: { env: process.env, upstreamUrl: 'http://127.0.0.1:3005' },
    });

    expect(runTailscaleServeDisable).toHaveBeenCalledTimes(1);
    expect(runTailscaleServeReset).not.toHaveBeenCalled();
  });
});
