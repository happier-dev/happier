import type { ExecFileOptions } from 'node:child_process';
import { createServer } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MachinePublishedDaemonStateV1Schema, MachinePublishedTransferListenerV1Schema } from '@happier-dev/protocol/machines/machinePublishedContentV1';
import type { DaemonState } from '@/api/types';
import { reloadConfiguration } from '@/configuration';
import { handleServerCliCommand, handleServerCommand } from '@/cli/commands/server';
import { resolveTailscaleTransferListenerState } from '@/daemon/resolveTailscaleTransferListenerState';
import { createDaemonTransferRuntimeState, createDaemonTransferRuntimeStatePublisher } from '@/daemon/transferRuntimeState';
import { createTailscaleTransferServeLifecycle } from '@/machines/transfer/tailscaleTransferServeLifecycle';
import { collectCurrentMachineReachableServerUrlCandidates } from '@/server/reachability/currentMachineReachableServerUrlCandidates';
import { promptForCurrentMachineReachableServerUrl } from '@/server/reachability/promptCurrentMachineReachableServerUrl';
import { doAuth } from '@/ui/auth';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir } from '@/testkit/fs/tempDir';
import { captureConsoleLogAndMuteStdout } from '@/testkit/logger/captureOutput';

const native = vi.hoisted(() => ({
  refusedCommand: 'serve-status' as 'status' | 'serve-status' | 'enable' | 'disable',
  calls: [] as string[][],
}));

// Only the native process boundary is replaced. Discovery, command classification,
// CLI presentation and daemon publication use their real production owners.
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFile(command: string, args: string[], _options: ExecFileOptions,
      callback: (error: Error | null, stdout: string, stderr: string) => void) {
      if (command !== 'qb269-tailscale') throw new Error('Unexpected native command in refusal test');
      native.calls.push(args);
      const child = new actual.ChildProcess();
      const isStatus = args[0] === 'status';
      const isServeStatus = args[0] === 'serve' && args[1] === 'status';
      const refused = native.refusedCommand === 'status' ? isStatus
        : native.refusedCommand === 'serve-status' ? isServeStatus
          : native.refusedCommand === 'enable' ? args.includes('--bg') : args.at(-1) === 'off';
      const stderr = refused
        ? "sending serve config: 401 Unauthorized: must be root, or be an operator and able to run 'sudo tailscale' to serve a path or Unix socket\n/private/secret-path"
        : '';
      const stdout = isStatus ? JSON.stringify({ BackendState: 'Running', TailscaleIPs: ['100.64.0.1'], Self: { DNSName: 'machine.tailnet.ts.net' } })
        : 'https://machine.tailnet.ts.net\n|-- /__happier/transfer proxy http://127.0.0.1:46001';
      queueMicrotask(() => {
        child.exitCode = refused ? 1 : 0;
        callback(refused ? Object.assign(new Error(`native refusal: ${stderr}`), { code: 1 }) : null, refused ? '' : stdout, stderr);
        child.emit('close', child.exitCode, null);
      });
      return child;
    },
  };
});

const failure = {
  code: 'tailscale_operator_authorization_refused',
  retryable: false,
  remediation: expect.stringContaining('sudo'),
};
const diagnostic = { code: failure.code, retryable: false };

afterEach(() => { native.calls.length = 0; });

describe('native Tailscale operator refusal projections', () => {
  it.each(['add', 'set'] as const)('preserves the cause in server %s JSON without retrying', async subcommand => {
    await withTempDir('happier-tailscale-refusal-', async homeDir => {
      const scope = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_TAILSCALE_BIN', 'HAPPIER_TAILSCALE_AUTO_PUBLIC_URL']);
      const previousExitCode = process.exitCode;
      const output = captureConsoleLogAndMuteStdout();
      try {
        scope.patch({ HAPPIER_HOME_DIR: homeDir, HAPPIER_TAILSCALE_BIN: 'qb269-tailscale', HAPPIER_TAILSCALE_AUTO_PUBLIC_URL: '1' });
        reloadConfiguration();
        native.refusedCommand = 'serve-status';
        process.exitCode = undefined;
        await handleServerCommand([subcommand, ...(subcommand === 'add' ? ['--name', 'Refusal', '--yes'] : []),
          '--server-url', 'http://127.0.0.1:46001', '--no-use', '--json']);
        const envelope = JSON.parse(output.logs.join('\n'));
        expect(envelope).toMatchObject({ ok: false, kind: `server_${subcommand}`, error: { code: failure.code } });
        expect(envelope.error.message).toContain('sudo');
        expect(JSON.stringify(envelope)).not.toContain('/private/secret-path');
        expect(process.exitCode).toBe(1);
        expect(native.calls).toEqual([['serve', 'status']]);
      } finally {
        output.restore();
        process.exitCode = previousExitCode;
        scope.restore();
        reloadConfiguration();
      }
    });
  });

  it('reports the typed discovery cause while retaining reachable LAN candidates', async () => {
    native.refusedCommand = 'serve-status';
    const onTailscaleFailure = vi.fn();
    const candidates = await collectCurrentMachineReachableServerUrlCandidates({
      localServerUrl: 'http://127.0.0.1:46001', env: { HAPPIER_TAILSCALE_BIN: 'qb269-tailscale' },
      onTailscaleFailure,
    }, {
      getNetworkInterfaces: () => ({ eth0: [{ address: '192.168.1.12', family: 'IPv4', internal: false }] }),
      canConnectToTcpEndpoint: async ({ host }) => host === '192.168.1.12',
    });
    expect(candidates).toContainEqual(expect.objectContaining({ url: 'http://192.168.1.12:46001', source: 'lan' }));
    expect(onTailscaleFailure).toHaveBeenCalledExactlyOnceWith(failure);
    expect(native.calls.filter(args => args[0] === 'serve')).toEqual([['serve', 'status']]);
  });

  it('presents discovery remediation while allowing the reachable LAN selection', async () => {
    const scope = createEnvKeyScope(['HAPPIER_TAILSCALE_BIN']);
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      scope.patch({ HAPPIER_TAILSCALE_BIN: 'qb269-tailscale' });
      native.refusedCommand = 'serve-status';
      const selected = await promptForCurrentMachineReachableServerUrl({ localServerUrl: 'http://127.0.0.1:46001' }, {
        getNetworkInterfaces: () => ({ eth0: [{ address: '192.168.1.12', family: 'IPv4', internal: false }] }),
        canConnectToTcpEndpoint: async ({ host }) => host === '192.168.1.12',
        promptInput: async () => '1',
      });
      expect(selected).toBe('http://192.168.1.12:46001');
      expect(warning).toHaveBeenCalledWith(expect.stringContaining(failure.code));
      expect(warning).toHaveBeenCalledWith(expect.stringContaining('sudo'));
      expect(warning.mock.calls.join('\n')).not.toContain('/private/secret-path');
    } finally {
      warning.mockRestore();
      scope.restore();
    }
  });

  it('continues contacting the selected Home after optional auth discovery is refused', async () => {
    await withTempDir('happier-tailscale-auth-refusal-', async homeDir => {
      let contactedHome = false;
      const home = createServer((_request, response) => {
        contactedHome = true;
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ features: {}, capabilities: {} }));
      });
      await new Promise<void>(resolve => home.listen(0, '127.0.0.1', resolve));
      const address = home.address();
      if (!address || typeof address === 'string') throw new Error('Missing test Home address');
      const homeUrl = `http://127.0.0.1:${address.port}`;
      const scope = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_SERVER_URL', 'HAPPIER_WEBAPP_URL', 'HAPPIER_PUBLIC_SERVER_URL',
        'HAPPIER_TAILSCALE_BIN', 'HAPPIER_TAILSCALE_AUTO_PUBLIC_URL', 'HAPPIER_AUTH_METHOD']);
      const output = captureConsoleLogAndMuteStdout();
      const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        scope.patch({ HAPPIER_HOME_DIR: homeDir, HAPPIER_SERVER_URL: homeUrl, HAPPIER_WEBAPP_URL: homeUrl,
          HAPPIER_PUBLIC_SERVER_URL: undefined, HAPPIER_TAILSCALE_BIN: 'qb269-tailscale', HAPPIER_TAILSCALE_AUTO_PUBLIC_URL: '1', HAPPIER_AUTH_METHOD: 'mobile' });
        reloadConfiguration();
        native.refusedCommand = 'serve-status';
        // This Home intentionally lacks identity evidence. Reaching its first
        // contact proves optional discovery did not block ordinary enrollment.
        expect(await doAuth()).toBeNull();
        expect(contactedHome).toBe(true);
        expect(warning).toHaveBeenCalledWith(expect.stringContaining(failure.code));
        expect(warning).toHaveBeenCalledWith(expect.stringContaining('sudo'));
        expect(warning.mock.calls.join('\n')).not.toContain('/private/secret-path');
      } finally {
        warning.mockRestore();
        output.restore();
        scope.restore();
        reloadConfiguration();
        home.closeAllConnections();
        await new Promise<void>((resolve, reject) => home.close(error => error ? reject(error) : resolve()));
      }
    });
  });

  it('shows safe terminal remediation without exposing native output in DEBUG mode', async () => {
    const scope = createEnvKeyScope(['HAPPIER_TAILSCALE_BIN', 'HAPPIER_TAILSCALE_AUTO_PUBLIC_URL', 'DEBUG']);
    const previousExitCode = process.exitCode;
    const output = captureConsoleLogAndMuteStdout();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      scope.patch({ HAPPIER_TAILSCALE_BIN: 'qb269-tailscale', HAPPIER_TAILSCALE_AUTO_PUBLIC_URL: '1', DEBUG: '1' });
      native.refusedCommand = 'serve-status';
      const args = ['server', 'set', '--server-url', 'http://127.0.0.1:46001', '--no-use'];
      await handleServerCliCommand({ args, rawArgv: args, terminalRuntime: null });
      const messages = errors.mock.calls.flat();
      expect(messages.some(message => typeof message === 'string' && message.includes('sudo'))).toBe(true);
      expect(messages.every(message => typeof message === 'string')).toBe(true);
      expect(messages.join('\n')).not.toContain('/private/secret-path');
      expect(native.calls).toEqual([['serve', 'status']]);
    } finally {
      errors.mockRestore();
      output.restore();
      process.exitCode = previousExitCode;
      scope.restore();
    }
  });

  it.each(['status', 'serve-status', 'disable'] as const)('publishes the %s refusal through the strict daemon listener schema', async refusedCommand => {
    native.refusedCommand = refusedCommand;
    const state = await resolveTailscaleTransferListenerState({
      enabled: refusedCommand !== 'disable', transferPort: 46001,
      servePath: '/__happier/transfer', httpsPort: 443,
      env: { HAPPIER_TAILSCALE_BIN: 'qb269-tailscale' },
    });
    const published = MachinePublishedTransferListenerV1Schema.parse(state);
    expect(published).toMatchObject({
      configured: refusedCommand === 'disable', active: false,
      available: refusedCommand === 'disable', diagnostic,
    });
    expect(JSON.stringify(published)).not.toContain('/private/secret-path');
    const initialTransferState = createDaemonTransferRuntimeState({
      directPeer: { featureEnabled: false, serverEnabled: false, bindHost: '127.0.0.1', bindPort: 46001, advertisedHosts: [] },
      tailscaleServe: state,
    });
    expect(initialTransferState.listenerClasses.tailscale_serve_https).toMatchObject({ diagnostic });
    let daemonState: DaemonState | null = null;
    const publisher = createDaemonTransferRuntimeStatePublisher({ initialTransferState });
    await publisher.attachApiMachine({ updateDaemonState: async updater => {
      daemonState = MachinePublishedDaemonStateV1Schema.parse(updater(daemonState));
    } });
    await publisher.publishTailscaleTransferListenerState(state);
    expect(daemonState).toMatchObject({ transfer: { listenerClasses: { tailscale_serve_https: { diagnostic } } } });
    expect(JSON.stringify(daemonState)).not.toContain('remediation');
    expect(native.calls).toEqual([
      ['status', '--json'],
      ...(refusedCommand === 'status' ? [] : [['serve', 'status']]),
      ...(refusedCommand === 'disable' ? [['serve', '--https=443', '--set-path=/__happier/transfer', 'off']] : []),
    ]);
  });

  it.each(['enable', 'disable'] as const)('publishes the lifecycle %s refusal without retrying', async refusedCommand => {
    native.refusedCommand = refusedCommand;
    const states: DaemonState['transfer'][] = [];
    const lifecycle = createTailscaleTransferServeLifecycle({
      enabled: true, servePath: '/__happier/transfer', httpsPort: 443,
      env: { HAPPIER_TAILSCALE_BIN: 'qb269-tailscale' },
      onListenerStateChange: state => {
        states.push(createDaemonTransferRuntimeState({
          directPeer: { featureEnabled: false, serverEnabled: false, bindHost: '127.0.0.1', bindPort: 46001, advertisedHosts: [] },
          tailscaleServe: MachinePublishedTransferListenerV1Schema.parse(state),
        }));
      },
    });
    await lifecycle.observeDirectTransferServerLifecycleState({
      status: 'running', listenerClasses: ['loopback_http'], port: 46001, publishedTransferCount: 1,
    });
    if (refusedCommand === 'disable') {
      await lifecycle.stop();
    }
    expect(states.at(-1)?.listenerClasses.tailscale_serve_https).toMatchObject({ diagnostic, active: false });
    expect(JSON.stringify(states)).not.toContain('remediation');
    expect(native.calls.filter(args => refusedCommand === 'enable' ? args.includes('--bg') : args.at(-1) === 'off')).toHaveLength(1);
    expect(JSON.stringify(states)).not.toContain('/private/secret-path');
  });
});
