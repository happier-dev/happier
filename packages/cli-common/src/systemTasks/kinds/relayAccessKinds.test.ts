import { describe, expect, it } from 'vitest';
import type { RelayAccessConfig, RelayAccessCommandRunner } from '../../relayAccess/types.js';
import { RelayAccessTaskSnapshotV1Schema } from '@happier-dev/protocol/system/tasks/relayAccessConfigV1';
import { getRelayAccessProvider, createBuiltinRelayAccessSelection as selection } from '../../relayAccess/registry.js';
import { TailscaleCommandError } from '../../tailscale/index.js';
import { createSystemTasksRunner } from '../interactiveTaskKinds.js';
import {
  createRelayAccessConfigureTaskKind, createRelayAccessDisableTaskKind,
  createRelayAccessStatusTaskKind, parseRelayAccessConfigureParams,
} from './relayAccessKinds.js';

const target = { kind: 'local' } as const;
const noPrompt = async (): Promise<never> => { throw new Error('Relay access should not prompt'); };
const accountRefs = [{ purpose: 'tunnel.manage', credentialRef: { kind: 'connectedAccount',
  account: { service: { pluginId: 'happier.deploy.cloudflare', localId: 'cloudflare' }, accountId: 'account-a' } } }] as const;

describe('relay access shared system task kinds', () => {
  it.each(['status', 'configure'] as const)('returns a credential-free terminal %s snapshot without changing persisted LAN input', async operation => {
    const config = selection('lan', { url: 'https://user:password@relay.example.test:8443/relay?token=relay-query-secret#relay-fragment-secret' });
    let persisted = config;
    const deps = { getProvider: getRelayAccessProvider, createExecutionContext: () => ({ env: {}, upstreamUrl: null }) };
    const kind = operation === 'status'
      ? createRelayAccessStatusTaskKind({ ...deps, readConfig: async () => persisted })
      : createRelayAccessConfigureTaskKind({ ...deps, writeConfig: async ({ config: next }) => { persisted = next; } });
    const taskKind = `relay.access.${operation}.v1`;
    const runner = createSystemTasksRunner({ kinds: { [taskKind]: kind } });
    await runner.start({ taskId: 'lan', kind: taskKind,
      params: operation === 'status' ? { target } : { target, config } });
    const result = await runner.wait({ taskId: 'lan' });
    expect(result).toEqual({ protocolVersion: 1, taskId: 'lan', ok: true, data: {
      configured: true, providerId: 'lan',
      selection: selection('lan', { url: 'https://relay.example.test:8443/relay' }),
      status: { state: 'enabled', shareUrl: 'https://relay.example.test:8443/relay', details: null },
    } });
    if (result?.ok) expect(RelayAccessTaskSnapshotV1Schema.safeParse(result.data).success).toBe(true);
    expect(JSON.stringify(result)).not.toContain('password');
    expect(persisted).toEqual(config);
  });

  it('admits descriptor-owned configuration and exact references, refusing legacy identities and raw values', () => {
    for (const config of [selection('localOnly'), selection('lan', { url: 'http://localhost:3000' }),
      selection('tailscaleServe'), selection('tailscaleFunnel'),
      selection('cloudflareNamed', { hostname: 'relay.example.test' }, [...accountRefs])]) {
      expect(parseRelayAccessConfigureParams({ target, config }).config).toEqual(config);
    }
    for (const config of [{ providerId: 'tailscaleServe' },
      { provider: { kind: 'builtin', id: 'cloudflareNamed' }, config: { hostname: 'relay.example.test', token: 'private-token' }, credentialRefs: [] },
      { provider: { kind: 'builtin', id: 'lan' }, config: { url: 'https://relay.test', hostname: 'wrong-field' }, credentialRefs: [] }]) {
      expect(() => parseRelayAccessConfigureParams({ target, config })).toThrow();
    }
    expect(() => parseRelayAccessConfigureParams({ target, providerId: 'lan',
      config: selection('lan', { url: 'https://relay.test' }) })).toThrow();
  });

  it('reports desired Cloudflare references as unverified rather than inventing reachable service evidence', async () => {
    const config = selection('cloudflareNamed', { hostname: 'relay.example.test' }, [...accountRefs]);
    let persisted: RelayAccessConfig | null = null;
    const kind = createRelayAccessConfigureTaskKind({
      writeConfig: async ({ config: next }) => { persisted = next; },
      getProvider: getRelayAccessProvider, createExecutionContext: () => ({ env: {}, upstreamUrl: null }),
    });
    const result = await kind.run({ params: { target, config }, emit: () => {}, prompt: noPrompt });
    expect(result).toEqual({ configured: true, providerId: 'cloudflareNamed', selection: config,
      status: { state: 'unknown', shareUrl: null, details: { reason: 'connector_verification_required' } } });
    expect(persisted).toEqual(config);
  });

  it('preserves native approval outcomes through the real Tailscale codec and command budget', async () => {
    const config = selection('tailscaleServe');
    const controller = new AbortController();
    let persisted: RelayAccessConfig | null = null;
    const requests: Parameters<RelayAccessCommandRunner>[0][] = [];
    // The only fake is the OS command boundary: native status text and command failure.
    const runCommand: RelayAccessCommandRunner = async request => {
      requests.push(request);
      const base = { command: request.command, args: request.args, exitCode: 0, stdout: '', stderr: '' };
      if (request.args.join(' ') === 'serve status') return base;
      if (request.args.join(' ') === 'serve --bg http://127.0.0.1:3005') {
        throw new TailscaleCommandError('approval required', { ...base, exitCode: 1,
          stderr: 'To enable Serve, visit https://login.tailscale.com/f/serve?node=node-123' });
      }
      throw new Error('Unexpected native command');
    };
    const kind = createRelayAccessConfigureTaskKind({
      writeConfig: async ({ config: next }) => { persisted = next; },
      getProvider: getRelayAccessProvider,
      createExecutionContext: ({ upstreamUrl }) => ({ env: { HAPPIER_TAILSCALE_BIN: '/test/tailscale' }, upstreamUrl, runCommand }),
    });
    const result = await kind.run({ params: { target, config, upstreamUrl: 'http://127.0.0.1:3005' },
      signal: controller.signal, emit: () => {}, prompt: noPrompt });
    expect(result).toEqual({ configured: true, providerId: 'tailscaleServe', selection: config,
      status: { state: 'needs_auth', shareUrl: null, details: {
        reason: 'tailscale_serve_approval_required', approvalUrl: 'https://login.tailscale.com/f/serve?node=node-123' } } });
    expect(persisted).toEqual(config);
    expect(requests.every(request => request.signal === controller.signal && Number(request.timeoutMs) > 0)).toBe(true);
  });

  it.each([false, true])('clears configuration only after the native disable succeeds (refused=%s)', async refused => {
    const config = selection('tailscaleServe');
    let persisted: RelayAccessConfig | null = config;
    const controller = new AbortController();
    const runCommand: RelayAccessCommandRunner = async request => {
      expect(request.args).toEqual(['serve', '--https=443', '--set-path=/', 'off']);
      expect(request.signal).toBe(controller.signal);
      const result = { command: request.command, args: request.args, exitCode: refused ? 1 : 0,
        stdout: '', stderr: refused ? 'permission denied' : '' };
      if (refused) throw new TailscaleCommandError('permission denied', result);
      return result;
    };
    const kind = createRelayAccessDisableTaskKind({
      readConfig: async () => persisted, writeConfig: async ({ config: next }) => { persisted = next; },
      getProvider: getRelayAccessProvider,
      createExecutionContext: () => ({ env: { HAPPIER_TAILSCALE_BIN: '/test/tailscale' }, upstreamUrl: null, runCommand }),
    });
    const pending = kind.run({ params: { target }, signal: controller.signal, emit: () => {}, prompt: noPrompt });
    if (refused) {
      await expect(pending).rejects.toThrow('permission denied');
      expect(persisted).toEqual(config);
    } else {
      expect(await pending).toEqual({ configured: false, providerId: null, selection: null,
        status: { state: 'disabled', shareUrl: null, details: null } });
      expect(persisted).toBeNull();
    }
  });
});
