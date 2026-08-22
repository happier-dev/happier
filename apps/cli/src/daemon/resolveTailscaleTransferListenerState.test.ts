import { describe, expect, it, vi } from 'vitest';

import { resolveTailscaleTransferListenerState } from './resolveTailscaleTransferListenerState';

describe('resolveTailscaleTransferListenerState', () => {
  it('preserves the configured enabled state when tailscale status cannot be resolved', async () => {
    const state = await resolveTailscaleTransferListenerState({
      enabled: true,
      transferPort: 46001,
      servePath: '/__happier/transfer',
      httpsPort: 443,
      runTailscaleStatusJson: vi.fn(async () => {
        throw new Error('tailscale unavailable');
      }),
      runTailscaleServeStatus: vi.fn(),
    });

    expect(state).toEqual({
      enabled: true,
      configured: false,
      active: false,
      available: false,
    });
  });

  it('publishes available but unconfigured when tailscale is installed but not logged in', async () => {
    const state = await resolveTailscaleTransferListenerState({
      enabled: true,
      transferPort: 46001,
      servePath: '/__happier/transfer',
      httpsPort: 443,
      runTailscaleStatusJson: vi.fn(async () => ({
        backendState: 'Stopped',
        authUrl: 'https://login.tailscale.com/a/example',
        dnsName: null,
        tailnetName: null,
        tailscaleIps: [],
        loggedIn: false,
        running: false,
        daemonReachable: true,
      })),
      runTailscaleServeStatus: vi.fn(),
    });

    expect(state).toEqual({
      enabled: true,
      configured: false,
      active: false,
      available: true,
    });
  });

  it('publishes available but unconfigured when tailscale serve does not target the transfer port', async () => {
    const runTailscaleServeStatus = vi.fn(async () => 'https://machine.tailnet.ts.net\n|-- / proxy http://127.0.0.1:3005');

    const state = await resolveTailscaleTransferListenerState({
      enabled: true,
      transferPort: 46001,
      servePath: '/__happier/transfer',
      httpsPort: 443,
      runTailscaleStatusJson: vi.fn(async () => ({
        backendState: 'Running',
        authUrl: null,
        dnsName: 'machine.tailnet.ts.net',
        tailnetName: 'tailnet.ts.net',
        tailscaleIps: ['100.64.0.1'],
        loggedIn: true,
        running: true,
        daemonReachable: true,
      })),
      runTailscaleServeStatus,
    });

    expect(state).toEqual({
      enabled: true,
      configured: false,
      active: false,
      available: true,
    });
    expect(runTailscaleServeStatus).toHaveBeenCalledTimes(1);
  });

  it('publishes unavailable when tailscale serve status cannot be resolved after login', async () => {
    const state = await resolveTailscaleTransferListenerState({
      enabled: true,
      transferPort: 46001,
      servePath: '/__happier/transfer',
      httpsPort: 443,
      runTailscaleStatusJson: vi.fn(async () => ({
        backendState: 'Running',
        authUrl: null,
        dnsName: 'machine.tailnet.ts.net',
        tailnetName: 'tailnet.ts.net',
        tailscaleIps: ['100.64.0.1'],
        loggedIn: true,
        running: true,
        daemonReachable: true,
      })),
      runTailscaleServeStatus: vi.fn(async () => {
        throw new Error('serve status unavailable');
      }),
    });

    expect(state).toEqual({
      enabled: true,
      configured: false,
      active: false,
      available: false,
    });
  });

  it('publishes configured when tailscale serve already targets the transfer port', async () => {
    const state = await resolveTailscaleTransferListenerState({
      enabled: true,
      transferPort: 46001,
      servePath: '/__happier/transfer',
      httpsPort: 443,
      runTailscaleStatusJson: vi.fn(async () => ({
        backendState: 'Running',
        authUrl: null,
        dnsName: 'machine.tailnet.ts.net',
        tailnetName: 'tailnet.ts.net',
        tailscaleIps: ['100.64.0.1'],
        loggedIn: true,
        running: true,
        daemonReachable: true,
      })),
      runTailscaleServeStatus: vi.fn(async () => 'https://machine.tailnet.ts.net\n|-- /__happier/transfer proxy http://127.0.0.1:46001'),
    });

    expect(state).toEqual({
      enabled: true,
      configured: true,
      active: false,
      available: true,
    });
  });

  it('does not treat a different serve path on the same transfer port as configured', async () => {
    const state = await resolveTailscaleTransferListenerState({
      enabled: true,
      transferPort: 46001,
      servePath: '/__happier/transfer',
      httpsPort: 443,
      runTailscaleStatusJson: vi.fn(async () => ({
        backendState: 'Running',
        authUrl: null,
        dnsName: 'machine.tailnet.ts.net',
        tailnetName: 'tailnet.ts.net',
        tailscaleIps: ['100.64.0.1'],
        loggedIn: true,
        running: true,
        daemonReachable: true,
      })),
      runTailscaleServeStatus: vi.fn(async () => 'https://machine.tailnet.ts.net\n|-- / proxy http://127.0.0.1:46001'),
    });

    expect(state).toEqual({
      enabled: true,
      configured: false,
      active: false,
      available: true,
    });
  });

  it('preserves availability when transfer-specific tailscale serve is disabled by runtime config', async () => {
    const runTailscaleServeDisable = vi.fn(async () => undefined);

    const state = await resolveTailscaleTransferListenerState({
      enabled: false,
      transferPort: 46001,
      servePath: '/__happier/transfer',
      httpsPort: 443,
      env: process.env,
      runTailscaleStatusJson: vi.fn(async () => ({
        backendState: 'Running',
        authUrl: null,
        dnsName: 'machine.tailnet.ts.net',
        tailnetName: 'tailnet.ts.net',
        tailscaleIps: ['100.64.0.1'],
        loggedIn: true,
        running: true,
        daemonReachable: true,
      })),
      runTailscaleServeStatus: vi.fn(async () => 'https://machine.tailnet.ts.net\n|-- /__happier/transfer proxy http://127.0.0.1:46001'),
      runTailscaleServeDisable,
    });

    expect(state).toEqual({
      enabled: false,
      configured: false,
      active: false,
      available: true,
    });

    expect(runTailscaleServeDisable).toHaveBeenCalledTimes(1);
    expect(runTailscaleServeDisable).toHaveBeenCalledWith({
      env: process.env,
      servePath: '/__happier/transfer',
      httpsPort: 443,
    });
  });

  it('fails open to reporting the configured state when disabling transfer-specific tailscale serve fails', async () => {
    const runTailscaleServeDisable = vi.fn(async () => {
      throw new Error('permission denied');
    });

    const state = await resolveTailscaleTransferListenerState({
      enabled: false,
      transferPort: 46001,
      servePath: '/__happier/transfer',
      httpsPort: 443,
      env: process.env,
      runTailscaleStatusJson: vi.fn(async () => ({
        backendState: 'Running',
        authUrl: null,
        dnsName: 'machine.tailnet.ts.net',
        tailnetName: 'tailnet.ts.net',
        tailscaleIps: ['100.64.0.1'],
        loggedIn: true,
        running: true,
        daemonReachable: true,
      })),
      runTailscaleServeStatus: vi.fn(async () => 'https://machine.tailnet.ts.net\n|-- /__happier/transfer proxy http://127.0.0.1:46001'),
      runTailscaleServeDisable,
    });

    expect(state).toEqual({
      enabled: false,
      configured: true,
      active: false,
      available: true,
    });
    expect(runTailscaleServeDisable).toHaveBeenCalledTimes(1);
  });
});

describe('resolveTailscaleTransferListenerState backend liveness', () => {
  it('does not publish a configured listener while the machine is signed in but tailscaled is stopped', async () => {
    // Serve config outlives `tailscale down`, so `tailscale serve status` still
    // prints the transfer mount. Publishing that as configured tells other
    // devices this machine can accept a transfer while nothing is listening.
    const runTailscaleServeStatus = vi.fn(async () => [
      'https://machine.tailnet.ts.net',
      '|-- /__happier/transfer proxy http://127.0.0.1:46001',
    ].join('\n'));

    const state = await resolveTailscaleTransferListenerState({
      enabled: true,
      transferPort: 46001,
      servePath: '/__happier/transfer',
      httpsPort: 443,
      runTailscaleStatusJson: vi.fn(async () => ({
        backendState: 'Stopped',
        authUrl: null,
        dnsName: 'machine.tailnet.ts.net',
        tailnetName: 'tailnet.ts.net',
        tailscaleIps: ['100.64.0.10'],
        loggedIn: true,
        running: false,
        daemonReachable: true,
      })),
      runTailscaleServeStatus,
    });

    expect(state).toEqual({
      enabled: true,
      configured: false,
      active: false,
      available: true,
    });
    expect(runTailscaleServeStatus).not.toHaveBeenCalled();
  });

  it('publishes an unavailable listener when tailscaled never answered', async () => {
    const state = await resolveTailscaleTransferListenerState({
      enabled: true,
      transferPort: 46001,
      servePath: '/__happier/transfer',
      httpsPort: 443,
      runTailscaleStatusJson: vi.fn(async () => ({
        backendState: null,
        authUrl: null,
        dnsName: null,
        tailnetName: null,
        tailscaleIps: [],
        loggedIn: false,
        running: false,
        daemonReachable: false,
      })),
      runTailscaleServeStatus: vi.fn(),
    });

    expect(state).toEqual({
      enabled: true,
      configured: false,
      active: false,
      available: false,
    });
  });
});
