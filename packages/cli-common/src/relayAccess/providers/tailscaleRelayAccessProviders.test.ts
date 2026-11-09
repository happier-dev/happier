import { describe, expect, it } from 'vitest';

import { createRelayAccessConfigureTaskKind, createRelayAccessDisableTaskKind } from '../../systemTasks/kinds/relayAccessKinds.js';
import {
  runTailscaleFunnelEnable,
  runTailscaleFunnelDisable,
  runTailscaleServeDisable,
  type TailscaleCommandRequest,
  type TailscaleCommandRunner,
} from '../../tailscale/index.js';
import type { RelayAccessConfig, RelayAccessExecutionContext } from '../types.js';
import { tailscaleFunnelRelayAccessProvider } from './tailscaleFunnel/index.js';
import { tailscaleServeRelayAccessProvider } from './tailscaleServe/index.js';

const upstreamUrl = 'http://127.0.0.1:3005';
const providers = [
  { provider: tailscaleServeRelayAccessProvider, config: { provider: { kind: 'builtin', id: 'tailscaleServe' }, config: {}, credentialRefs: [] } },
  { provider: tailscaleFunnelRelayAccessProvider, config: { provider: { kind: 'builtin', id: 'tailscaleFunnel' }, config: {}, credentialRefs: [] } },
] satisfies readonly { provider: typeof tailscaleServeRelayAccessProvider; config: RelayAccessConfig }[];

/** Only the native process boundary is simulated; providers, deadlines and command codecs are real. */
function nativeFixture() {
  const routes = new Map<string, string>();
  const commands: TailscaleCommandRequest[] = [];
  let backendState = 'Running';
  let nativeFailure: Error | undefined;
  let statusFailure: Error | undefined;
  let statusExitCode = 0;
  let now = 100;
  let afterStatus: (() => void) | undefined;
  const runCommand: TailscaleCommandRunner = async (request) => {
    commands.push(request);
    const args = request.args;
    let stdout = '';
    if (args[0] === 'status') {
      if (statusFailure) throw statusFailure;
      stdout = JSON.stringify({ BackendState: backendState, AuthURL: backendState === 'NeedsLogin' ? 'https://login.example.test' : '',
        Self: { DNSName: 'machine.tailnet.ts.net.', TailscaleIPs: ['100.64.0.10'] } });
      afterStatus?.();
    } else if (args[1] === 'status') {
      stdout = [...new Set([...routes.keys()].map(key => key.split(':', 1)[0]))].map(port => [
        `https://machine.tailnet.ts.net${port === '443' ? '' : `:${port}`}`,
        ...[...routes].filter(([key]) => key.startsWith(`${port}:`))
          .map(([key, target]) => `|-- ${key.slice(port!.length + 1)} proxy ${target}`),
      ].join('\n')).join('\n\n') || 'No serve config';
    } else {
      if (nativeFailure) throw nativeFailure;
      const port = args.find(arg => arg.startsWith('--https='))?.slice('--https='.length) ?? '443';
      const path = args.find(arg => arg.startsWith('--set-path='))?.slice('--set-path='.length);
      // Native Tailscale removeWebServe: omitted --set-path removes all mounts on the port.
      // https://github.com/tailscale/tailscale/blob/main/cmd/tailscale/cli/serve_v2.go
      if (args[1] === 'reset') routes.clear();
      else if (args.at(-1) === 'off') {
        for (const key of routes.keys()) if (key.startsWith(`${port}:`) && (path === undefined || key === `${port}:${path}`)) routes.delete(key);
      } else routes.set(`${port}:${path ?? '/'}`, args.at(-1)!);
    }
    return { command: request.command, args, exitCode: args[0] === 'status' ? statusExitCode : 0,
      stdout: args[0] === 'status' && statusExitCode !== 0 ? '' : stdout, stderr: '' };
  };
  const ctx: RelayAccessExecutionContext = { env: { HAPPIER_TAILSCALE_BIN: '/fixture/tailscale' }, upstreamUrl, runCommand };
  return { ctx, commands, routes, runCommand, now: () => now,
    stop: () => { backendState = 'Stopped'; }, requireLogin: () => { backendState = 'NeedsLogin'; },
    daemonUnavailable: () => { statusExitCode = 1; },
    failMutation: (error: Error) => { nativeFailure = error; }, failStatus: (error: Error) => { statusFailure = error; },
    advanceAfterStatus: () => { afterStatus = () => { now = 950; }; },
  };
}

describe('tailscale relay access providers through native commands', () => {
  it.each(providers)('$provider.descriptor.id retains operator refusal through the configured task result without polling', async ({ provider, config }) => {
    const requests: string[][] = [];
    const refusal = "sending serve config: 401 Unauthorized: must be root, or be an operator and able to run 'sudo tailscale' to serve a path or Unix socket";
    const runCommand: TailscaleCommandRunner = async request => {
      requests.push([...request.args]);
      return { ...request, stdout: '', exitCode: request.args[1] === 'status' ? 0 : 1,
        stderr: request.args[1] === 'status' ? '' : `${refusal}\n/private/alice token=secret-value` };
    };
    const task = createRelayAccessConfigureTaskKind({ writeConfig: async () => {}, getProvider: () => provider,
      createExecutionContext: () => ({ env: { HAPPIER_TAILSCALE_BIN: '/fixture/tailscale' }, upstreamUrl, runCommand }) });
    const result = await task.run({ params: { target: { kind: 'local' }, config, upstreamUrl },
      emit: () => {}, prompt: async () => { throw new Error('Unexpected approval prompt'); } });
    expect(result.status).toMatchObject({ state: 'error', details: {
      code: 'tailscale_operator_authorization_refused', retryable: false, message: expect.stringContaining('sudo'),
    } });
    expect(requests.at(-1)?.at(-1)).toBe(upstreamUrl);
    expect(requests.filter(args => args.includes('--bg'))).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain('/private/alice');
    expect(JSON.stringify(result)).not.toContain('secret-value');
  });

  it.each(providers)('does not invent authentication or a live route when the native daemon never answered', async ({ provider, config }) => {
    const f = nativeFixture();
    f.routes.set('443:/', upstreamUrl);
    f.daemonUnavailable();
    const result = await provider.status({ config, ctx: f.ctx });
    expect(result.state).toBe('error');
    expect(result.details).toMatchObject({ code: 'provider_command_failed' });
    expect(result.shareUrl).toBeUndefined();
  });
  it.each(providers)('$provider.descriptor.id distinguishes authentication, stopped native state and active routes', async ({ provider, config }) => {
    const f = nativeFixture();
    f.routes.set('443:/', upstreamUrl);
    await expect(provider.status({ config, ctx: f.ctx })).resolves.toMatchObject({ state: 'enabled', shareUrl: 'https://machine.tailnet.ts.net' });
    f.stop();
    await expect(provider.status({ config, ctx: f.ctx })).resolves.toMatchObject({ state: 'disabled' });
    f.requireLogin();
    await expect(provider.status({ config, ctx: f.ctx })).resolves.toMatchObject({ state: 'needs_auth' });
  });

  it.each(providers)('$provider.descriptor.id reports absent routes and selects the requested upstream among other listeners', async ({ provider, config }) => {
    const f = nativeFixture();
    await expect(provider.status({ config, ctx: f.ctx })).resolves.toMatchObject({ state: 'disabled' });
    f.routes.set('443:/', 'http://127.0.0.1:9999');
    f.routes.set('8443:/', upstreamUrl);
    await expect(provider.status({ config, ctx: f.ctx })).resolves.toEqual({ state: 'enabled', shareUrl: 'https://machine.tailnet.ts.net:8443' });
  });

  it.each(providers)('$provider.descriptor.id configures its actual native mapping inside the supplied deadline and signal', async ({ provider, config }) => {
    const f = nativeFixture();
    const signal = new AbortController().signal;
    await expect(provider.configure?.({ config, ctx: f.ctx, deadline: { startedAt: 0, deadlineAt: 1000, now: f.now }, signal }))
      .resolves.toEqual({ state: 'enabled', shareUrl: 'https://machine.tailnet.ts.net' });
    expect(f.routes.get('443:/')).toBe(upstreamUrl);
    expect(f.commands.length).toBeGreaterThan(0);
    for (const command of f.commands) {
      expect(command.signal).toBe(signal);
      expect(command.timeoutMs).toBe(900);
    }
  });

  it.each(providers)('$provider.descriptor.id uses one remaining deadline for its serial status commands', async ({ provider, config }) => {
    const f = nativeFixture();
    f.routes.set('443:/', upstreamUrl);
    f.advanceAfterStatus();
    await provider.status({ config, ctx: f.ctx, deadline: { startedAt: 0, deadlineAt: 1000, now: f.now } });
    expect(f.commands.map(command => command.timeoutMs)).toEqual([900, 50]);
  });

  it.each(providers)('$provider.descriptor.id removes only its root mount while preserving foreign, transfer and other-port routes', async ({ provider, config }) => {
    const f = nativeFixture();
    f.routes.set('443:/', upstreamUrl);
    f.routes.set('443:/other', 'http://127.0.0.1:9999');
    f.routes.set('443:/__happier/transfer', 'http://127.0.0.1:46001');
    f.routes.set('8443:/', 'http://127.0.0.1:8888');
    await provider.disable?.({ config, ctx: f.ctx });
    expect([...f.routes]).toEqual([
      ['443:/other', 'http://127.0.0.1:9999'],
      ['443:/__happier/transfer', 'http://127.0.0.1:46001'],
      ['8443:/', 'http://127.0.0.1:8888'],
    ]);
    expect(f.commands.map(command => command.args)).toEqual([['kind' in config.provider && config.provider.id === 'tailscaleServe' ? 'serve' : 'funnel', '--https=443', '--set-path=/', 'off']]);
  });

  it.each(providers)('$provider.descriptor.id keeps the persisted Home selection when native disable fails', async ({ provider, config }) => {
    const f = nativeFixture();
    const failure = new Error('native disable rejected');
    f.failMutation(failure);
    let persisted: RelayAccessConfig | null = config;
    const kind = createRelayAccessDisableTaskKind({ readConfig: async () => persisted,
      writeConfig: async ({ config: next }) => { persisted = next; }, getProvider: () => provider,
      createExecutionContext: ({ upstreamUrl: selected }) => ({ ...f.ctx, upstreamUrl: selected }),
    });
    await expect(kind.run({ params: { target: { kind: 'local' } }, emit: () => {}, prompt: async () => { throw new Error('unexpected prompt'); } }))
      .rejects.toBe(failure);
    expect(persisted).toEqual(config);
  });

  it('preserves an unrelated Funnel root when configuring Serve', async () => {
    const f = nativeFixture();
    f.routes.set('443:/', 'http://127.0.0.1:9999');
    const result = await tailscaleServeRelayAccessProvider.configure?.({ config: providers[0]!.config, ctx: f.ctx });
    expect(result?.state).toBe('error');
    expect(f.routes.get('443:/')).toBe('http://127.0.0.1:9999');
    expect(f.commands.every(command => command.args[1] === 'status')).toBe(true);
  });

  it('keeps native diagnostic bytes out of the public status result', async () => {
    const f = nativeFixture();
    f.failStatus(new Error('stderr: token=secret-token-123 home=/Users/alice/.config/tailscale'));
    const status = await tailscaleServeRelayAccessProvider.status({ config: providers[0]!.config, ctx: f.ctx });
    expect(status).toMatchObject({ state: 'error', details: { code: 'provider_command_failed', phase: 'tailscale.status' } });
    expect(JSON.stringify(status.details)).not.toContain('secret-token-123');
    expect(JSON.stringify(status.details)).not.toContain('/Users/alice');
  });

  it.each([
    { kind: 'Serve', disable: runTailscaleServeDisable },
    { kind: 'Funnel', disable: runTailscaleFunnelDisable },
  ])('keeps a non-root $kind removal scoped to its selected port and path', async ({ disable }) => {
    const f = nativeFixture();
    f.routes.set('8443:/owned', upstreamUrl);
    f.routes.set('8443:/other', 'http://127.0.0.1:9999');
    f.routes.set('443:/owned', 'http://127.0.0.1:8888');
    await disable({ tailscaleBin: '/fixture/tailscale', httpsPort: 8443, servePath: '/owned' }, { runCommand: f.runCommand });
    expect([...f.routes]).toEqual([['8443:/other', 'http://127.0.0.1:9999'], ['443:/owned', 'http://127.0.0.1:8888']]);
  });

  it('pins a Funnel enable to its selected HTTPS port and path', async () => {
    const f = nativeFixture();
    f.routes.set('443:/', 'http://127.0.0.1:9999');
    const params = { tailscaleBin: '/fixture/tailscale', httpsPort: 8443, servePath: '/owned', upstreamUrl };
    const result = await runTailscaleFunnelEnable(params, { runCommand: f.runCommand });
    expect([...f.routes]).toEqual([['443:/', 'http://127.0.0.1:9999'], ['8443:/owned', upstreamUrl]]);
    expect(result.httpsUrl).toBe('https://machine.tailnet.ts.net:8443');
  });
});
