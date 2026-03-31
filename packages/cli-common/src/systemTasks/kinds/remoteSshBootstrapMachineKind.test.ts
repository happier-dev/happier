import { describe, expect, it } from 'vitest';

import { createSystemTasksRunner } from '../interactiveTaskKinds.js';
import { createRemoteSshBootstrapMachineTaskKind } from './remoteSshBootstrapMachineKind.js';

async function waitForPendingPrompt(
  runner: ReturnType<typeof createSystemTasksRunner>,
  params: Readonly<{ taskId: string; cursor: number }>,
) {
  let latest = await runner.poll(params);
  for (let attempt = 0; attempt < 50; attempt += 1) {
    latest = await runner.poll(params);
    if (latest.pendingPrompt) {
      return latest;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`Expected pending prompt for ${params.taskId}: ${JSON.stringify(latest)}`);
}

async function waitForResult(
  runner: ReturnType<typeof createSystemTasksRunner>,
  params: Readonly<{ taskId: string; cursor: number }>,
) {
  let latest = await runner.poll(params);
  for (let attempt = 0; attempt < 50; attempt += 1) {
    latest = await runner.poll(params);
    if (latest.result) {
      return latest;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`Expected final result for ${params.taskId}: ${JSON.stringify(latest)}`);
}

describe('createRemoteSshBootstrapMachineTaskKind', () => {
  it('passes relayRuntime local URL to remote bootstrap commands so the remote CLI/daemon can prefer the locally hosted relay runtime', async () => {
    let remoteCliInstalled = false;
    const kind = createRemoteSshBootstrapMachineTaskKind({
      resolveHostTrust: async () => ({ status: 'trusted' }),
      installRemoteCli: async () => {
        remoteCliInstalled = true;
      },
      approveLocalAuthRequest: async ({ parsed }) => {
        expect(parsed.relay.relayUrl).toBe('http://127.0.0.1:3005');
        expect(parsed.relay.publicRelayUrl).toBe('https://relay.example.test');
      },
      runRemoteCommand: async ({ label, parsed, data }) => {
        expect(parsed.relay.relayUrl).toBe('https://relay.example.test');

        if (label === 'relay.runtime.install') {
          return { ok: true, data: { relayUrl: 'http://127.0.0.1:9999', mode: 'user' } };
        }

        if (label === 'server.configure' || label === 'auth.request' || label === 'auth.wait' || label === 'daemon.service.install' || label === 'daemon.service.start') {
          expect((data ?? {}).localServerUrl).toBe('http://127.0.0.1:9999');
        }

        if (label === 'server.configure') {
          if (!remoteCliInstalled) {
            throw new Error('remote cli missing');
          }
          return { ok: true, data: { configured: true } };
        }

        if (label === 'auth.status') {
          return { ok: true, data: { authenticated: false } };
        }

        if (label === 'auth.request') {
          return {
            ok: true,
            data: {
              publicKey: 'pub-key',
              claimSecret: 'secret-value',
              stateFile: '/tmp/claim-state.json',
              supportsV2: true,
              webappUrl: 'https://relay.example.test',
            },
          };
        }

        if (label === 'auth.wait') {
          return { ok: true, data: { paired: true, machineId: 'remote-machine' } };
        }

        if (label === 'daemon.service.install') {
          return { ok: true, data: { installed: true } };
        }

        if (label === 'daemon.service.start') {
          return { ok: true, data: { started: true } };
        }

        throw new Error(`Unexpected remote command: ${label}`);
      },
    });

    const runner = createSystemTasksRunner({
      kinds: { 'remote.ssh.bootstrapMachine.v1': kind },
    });

    await runner.start({
      taskId: 'ssh-task',
      kind: 'remote.ssh.bootstrapMachine.v1',
      params: {
        ssh: {
          target: 'dev@example.test',
          auth: 'agent',
        },
        relay: {
          relayUrl: 'http://127.0.0.1:3005',
          publicRelayUrl: 'https://relay.example.test',
          webappUrl: 'http://localhost:3005',
        },
        relayRuntime: {
          enabled: true,
          mode: 'user',
        },
        channel: 'preview',
        serviceMode: 'user',
        promptResolution: {
          authApproval: {
            publicKey: 'pub-key',
          },
        },
      },
    });

    const result = await waitForResult(runner, { taskId: 'ssh-task', cursor: 0 });
    expect(result.result?.ok).toBe(true);
    if (!result.result || result.result.ok !== true) {
      throw new Error('Expected remote ssh bootstrap to succeed');
    }
    expect(result.result.data).toEqual({
      publicKey: 'pub-key',
      machineId: 'remote-machine',
      relayRuntime: {
        relayUrl: 'http://127.0.0.1:9999',
        mode: 'user',
      },
    });
  });

  it('prefers relay.publicRelayUrl for remote commands when provided', async () => {
    const kind = createRemoteSshBootstrapMachineTaskKind({
      resolveHostTrust: async () => ({ status: 'trusted' }),
      installRemoteCli: async () => undefined,
      approveLocalAuthRequest: async () => undefined,
      runRemoteCommand: async ({ label, parsed }) => {
        expect(parsed.relay.relayUrl).toBe('https://public.example.test');
        if (label === 'auth.status') {
          return { ok: true, data: { authenticated: false } };
        }
        if (label === 'server.configure') {
          return { ok: true, data: { configured: true } };
        }
        if (label === 'auth.request') {
          return {
            ok: true,
            data: {
              publicKey: 'pub-key',
              claimSecret: 'secret-value',
              stateFile: '/tmp/claim-state.json',
              supportsV2: true,
              webappUrl: 'https://public.example.test',
            },
          };
        }
        if (label === 'auth.wait') {
          return { ok: true, data: { paired: true } };
        }
        throw new Error(`Unexpected remote command: ${label}`);
      },
    });

    const runner = createSystemTasksRunner({
      kinds: { 'remote.ssh.bootstrapMachine.v1': kind },
    });

    await runner.start({
      taskId: 'ssh-task',
      kind: 'remote.ssh.bootstrapMachine.v1',
      params: {
        ssh: {
          target: 'dev@example.test',
          auth: 'agent',
        },
        relay: {
          relayUrl: 'http://127.0.0.1:3005',
          webappUrl: 'http://localhost:3005',
          publicRelayUrl: 'https://public.example.test',
        },
        channel: 'preview',
        serviceMode: 'none',
        promptResolution: {
          authApproval: {
            publicKey: 'pub-key',
          },
        },
      },
    });

    const result = await waitForResult(runner, { taskId: 'ssh-task', cursor: 0 });
    expect(result.result?.ok).toBe(true);
  });

  it('prompts for host trust, redacts auth secrets, and completes the canonical bootstrap flow in order', async () => {
    let remoteCliInstalled = false;
    const invocations: string[] = [];
    const kind = createRemoteSshBootstrapMachineTaskKind({
      resolveHostTrust: async () => ({
        status: 'prompt',
        promptKind: 'ssh.trustHost',
        promptMessage: 'Trust this SSH host?',
        promptData: {
          host: 'example.test',
          keyType: 'ssh-ed25519',
          fingerprint: 'SHA256:abc',
        },
        accept: async () => undefined,
      }),
      installRemoteCli: async ({ parsed }) => {
        expect(parsed.channel).toBe('preview');
        invocations.push('installRemoteCli');
        remoteCliInstalled = true;
      },
      approveLocalAuthRequest: async ({ publicKey }) => {
        invocations.push(`approveLocalAuthRequest:${publicKey}`);
      },
      runRemoteCommand: async ({ label, data }) => {
        invocations.push(label);
        if (label === 'server.configure') {
          if (!remoteCliInstalled) {
            throw new Error('remote happier cli not installed');
          }
          return { ok: true, data: { configured: true } };
        }
        if (label === 'auth.status') {
          return { ok: true, data: { authenticated: false } };
        }
        if (label === 'auth.request') {
          return {
            ok: true,
            data: {
              publicKey: 'pub-key',
              claimSecret: 'secret-value',
              stateFile: '/tmp/claim-state.json',
              supportsV2: true,
              webappUrl: 'https://relay.example.test',
            },
          };
        }
        if (label === 'auth.wait') {
          expect(data).toEqual({ publicKey: 'pub-key' });
          return { ok: true, data: { paired: true } };
        }
        if (label === 'daemon.service.install') {
          return { ok: true, data: { installed: true } };
        }
        if (label === 'daemon.service.start') {
          return { ok: true, data: { started: true } };
        }
        throw new Error(`Unexpected remote command: ${label}`);
      },
    });

    const runner = createSystemTasksRunner({
      now: (() => {
        let ts = 2_000;
        return () => ts++;
      })(),
      kinds: {
        'remote.ssh.bootstrapMachine.v1': kind,
      },
    });

    await runner.start({
      taskId: 'ssh-task',
      kind: 'remote.ssh.bootstrapMachine.v1',
      params: {
        ssh: {
          target: 'dev@example.test',
          auth: 'agent',
        },
        relay: {
          relayUrl: 'https://relay.example.test',
        },
        channel: 'preview',
        serviceMode: 'user',
      },
    });
    const firstPoll = await waitForPendingPrompt(runner, { taskId: 'ssh-task', cursor: 0 });
    expect(firstPoll.pendingPrompt).toEqual({
      kind: 'ssh.trustHost',
      data: {
        host: 'example.test',
        keyType: 'ssh-ed25519',
        fingerprint: 'SHA256:abc',
      },
    });

    await runner.respond({
      taskId: 'ssh-task',
      answer: { trusted: true },
    });

    const secondPoll = await waitForPendingPrompt(runner, { taskId: 'ssh-task', cursor: firstPoll.nextCursor });
    expect(secondPoll.pendingPrompt).toEqual({
      kind: 'auth.approveRemoteProvisioning',
      data: {
        publicKey: 'pub-key',
        supportsV2: true,
        webappUrl: 'https://relay.example.test',
      },
    });

    await runner.respond({
      taskId: 'ssh-task',
      answer: { approved: true },
    });

    const finalPoll = await waitForResult(runner, { taskId: 'ssh-task', cursor: secondPoll.nextCursor });
    expect(finalPoll.result).toEqual({
      protocolVersion: 1,
      taskId: 'ssh-task',
      ok: true,
      data: {
        publicKey: 'pub-key',
        machineId: null,
      },
    });
    expect(invocations).toEqual([
      'server.configure',
      'installRemoteCli',
      'server.configure',
      'auth.status',
      'auth.request',
      'approveLocalAuthRequest:pub-key',
      'auth.wait',
      'daemon.service.install',
      'daemon.service.start',
    ]);
  });

  it('prompts for SSH passwords without leaking the password into emitted prompt events', async () => {
    let remoteCliInstalled = false;
    const kind = createRemoteSshBootstrapMachineTaskKind({
      resolveHostTrust: async () => ({ status: 'trusted' }),
      installRemoteCli: async () => {
        remoteCliInstalled = true;
      },
      approveLocalAuthRequest: async () => undefined,
      runRemoteCommand: async ({ label }) => {
        if (label === 'server.configure') {
          if (!remoteCliInstalled) {
            throw new Error('remote cli should not be required for password prompt handling');
          }
          return { ok: true, data: { configured: true } };
        }
        if (label === 'auth.status') {
          return { ok: true, data: { authenticated: true, machineId: 'machine-password' } };
        }
        throw new Error(`Unexpected remote command: ${label}`);
      },
    });

    const runner = createSystemTasksRunner({
      kinds: { 'remote.ssh.bootstrapMachine.v1': kind },
    });

    await runner.start({
      taskId: 'ssh-password-task',
      kind: 'remote.ssh.bootstrapMachine.v1',
      params: {
        ssh: {
          target: 'dev@example.test',
          auth: 'password',
        },
        relay: {
          relayUrl: 'https://relay.example.test',
        },
        serviceMode: 'none',
      },
    });

    const firstPoll = await waitForPendingPrompt(runner, { taskId: 'ssh-password-task', cursor: 0 });
    expect(firstPoll.pendingPrompt).toEqual({
      kind: 'ssh.password',
      data: {
        target: 'dev@example.test',
      },
    });
    expect(JSON.stringify(firstPoll.events)).not.toContain('super-secret');

    await runner.respond({
      taskId: 'ssh-password-task',
      answer: { password: 'super-secret' },
    });

    const result = await waitForResult(runner, { taskId: 'ssh-password-task', cursor: firstPoll.nextCursor });
    expect(result.result?.ok).toBe(true);
  });

  it('continues when the remote machine is already authenticated', async () => {
    const kind = createRemoteSshBootstrapMachineTaskKind({
      resolveHostTrust: async () => ({
        status: 'prompt',
        promptKind: 'ssh.trustHost',
        promptMessage: 'Trust this SSH host?',
        promptData: {
          host: 'example.test',
          keyType: 'ssh-ed25519',
          fingerprint: 'SHA256:abc',
        },
        accept: async () => undefined,
      }),
      installRemoteCli: async () => {
        throw new Error('should not install cli when already authenticated');
      },
      approveLocalAuthRequest: async () => {
        throw new Error('should not approve when already authenticated');
      },
      runRemoteCommand: async ({ label }) => {
        if (label === 'auth.status') {
          return { ok: true, data: { authenticated: true, machineId: 'machine-already' } };
        }
        if (label === 'server.configure') {
          return { ok: true, data: {} };
        }
        if (label === 'daemon.service.install') {
          return { ok: true, data: {} };
        }
        if (label === 'daemon.service.start') {
          return { ok: true, data: {} };
        }
        throw new Error(`Unexpected remote command: ${label}`);
      },
    });

    const runner = createSystemTasksRunner({
      kinds: {
        'remote.ssh.bootstrapMachine.v1': kind,
      },
    });

    await runner.start({
      taskId: 'ssh-task-authenticated',
      kind: 'remote.ssh.bootstrapMachine.v1',
      params: {
        ssh: {
          target: 'dev@example.test',
          auth: 'agent',
        },
        relay: {
          relayUrl: 'https://relay.example.test',
        },
      },
    });

    const firstPoll = await waitForPendingPrompt(runner, { taskId: 'ssh-task-authenticated', cursor: 0 });
    expect(firstPoll.pendingPrompt?.kind).toBe('ssh.trustHost');

    await runner.respond({
      taskId: 'ssh-task-authenticated',
      answer: { trusted: true },
    });

    const finalPoll = await waitForResult(runner, { taskId: 'ssh-task-authenticated', cursor: firstPoll.nextCursor });
    expect(finalPoll.result).toEqual({
      protocolVersion: 1,
      taskId: 'ssh-task-authenticated',
      ok: true,
      data: {
        machineId: 'machine-already',
      },
    });
  });

  it('fails closed when relay.relayUrl is loopback and no relay.publicRelayUrl is provided', async () => {
    const kind = createRemoteSshBootstrapMachineTaskKind({
      resolveHostTrust: async () => ({ status: 'trusted' }),
      installRemoteCli: async () => {
        throw new Error('should not install cli when relay url is invalid');
      },
      approveLocalAuthRequest: async () => {
        throw new Error('should not approve when relay url is invalid');
      },
      runRemoteCommand: async () => {
        throw new Error('should not run remote commands when relay url is invalid');
      },
    });

    const runner = createSystemTasksRunner({
      kinds: {
        'remote.ssh.bootstrapMachine.v1': kind,
      },
    });

    await runner.start({
      taskId: 'ssh-task-loopback-relay',
      kind: 'remote.ssh.bootstrapMachine.v1',
      params: {
        ssh: {
          target: 'dev@example.test',
          auth: 'agent',
        },
        relay: {
          relayUrl: 'http://127.0.0.1:3005',
          webappUrl: 'http://localhost:3005',
        },
      },
    });

    const finalPoll = await waitForResult(runner, { taskId: 'ssh-task-loopback-relay', cursor: 0 });
    expect(finalPoll.result).toEqual({
      protocolVersion: 1,
      taskId: 'ssh-task-loopback-relay',
      ok: false,
      error: {
        code: 'relay_url_unreachable',
        message: 'Remote setup cannot use a loopback Relay URL. Provide relay.publicRelayUrl.',
      },
    });
  });

  it('runs the optional remote relay runtime install after machine pairing and emits dedicated progress steps', async () => {
    const invocations: Array<Readonly<{ label: string; data?: Record<string, unknown> }>> = [];
    const kind = createRemoteSshBootstrapMachineTaskKind({
      resolveHostTrust: async () => ({
        status: 'prompt',
        promptKind: 'ssh.trustHost',
        promptMessage: 'Trust this SSH host?',
        promptData: {
          host: 'example.test',
          keyType: 'ssh-ed25519',
          fingerprint: 'SHA256:abc',
        },
        accept: async () => undefined,
      }),
      installRemoteCli: async () => undefined,
      approveLocalAuthRequest: async () => undefined,
      runRemoteCommand: async ({ label, data }) => {
        invocations.push({ label, data });
        if (label === 'auth.status') {
          return { ok: true, data: { authenticated: false } };
        }
        if (label === 'server.configure') {
          return { ok: true, data: { configured: true } };
        }
        if (label === 'auth.request') {
          return { ok: true, data: { publicKey: 'pub-key', supportsV2: true, webappUrl: 'https://relay.example.test' } };
        }
        if (label === 'auth.wait') {
          return { ok: true, data: { paired: true } };
        }
        if (label === 'relay.runtime.install') {
          return { ok: true, data: { relayUrl: 'http://10.0.0.5:3005' } };
        }
        throw new Error(`Unexpected remote command: ${label}`);
      },
    });

    const runner = createSystemTasksRunner({
      kinds: {
        'remote.ssh.bootstrapMachine.v1': kind,
      },
    });

    await runner.start({
      taskId: 'ssh-relay-task',
      kind: 'remote.ssh.bootstrapMachine.v1',
      params: {
        ssh: {
          target: 'dev@example.test',
          auth: 'agent',
        },
        relay: {
          relayUrl: 'https://relay.example.test',
        },
        serviceMode: 'none',
        relayRuntime: {
          enabled: true,
          mode: 'system',
          env: {
            PORT: '4455',
          },
          selfHostRelayBinaryOverride: '/tmp/happier-server',
        },
      },
    });
    const firstPoll = await waitForPendingPrompt(runner, { taskId: 'ssh-relay-task', cursor: 0 });
    expect(firstPoll.pendingPrompt?.kind).toBe('ssh.trustHost');
    await runner.respond({ taskId: 'ssh-relay-task', answer: { trusted: true } });

    const secondPoll = await waitForPendingPrompt(runner, { taskId: 'ssh-relay-task', cursor: firstPoll.nextCursor });
    expect(secondPoll.pendingPrompt?.kind).toBe('auth.approveRemoteProvisioning');
    expect(secondPoll.events.map((event) => event.stepId)).toEqual([
      'relay.runtime.install',
      'ssh.installCli',
      'ssh.auth.request',
      'ssh.auth.approval',
    ]);
    await runner.respond({ taskId: 'ssh-relay-task', answer: { approved: true } });

    const finalPoll = await waitForResult(runner, { taskId: 'ssh-relay-task', cursor: secondPoll.nextCursor });

    expect(finalPoll.events.map((event) => event.stepId)).toEqual([
      'ssh.auth.wait',
      'ssh.complete',
    ]);
    expect(finalPoll.result).toEqual({
      protocolVersion: 1,
      taskId: 'ssh-relay-task',
      ok: true,
      data: {
        publicKey: 'pub-key',
        machineId: null,
        relayRuntime: {
          relayUrl: 'http://10.0.0.5:3005',
          mode: 'system',
        },
      },
    });
    expect(invocations.map((entry) => entry.label)).toContain('relay.runtime.install');
  });

  it('does not switch the remote CLI/daemon to the installed relay runtime by default', async () => {
    const invocations: Array<Readonly<{ label: string; relayUrl: string }>> = [];
    const installRemoteCliCalls: Array<Readonly<{ relayUrl: string }>> = [];
    let serverConfigureAttempts = 0;
    const kind = createRemoteSshBootstrapMachineTaskKind({
      resolveHostTrust: async () => ({ status: 'trusted' }),
      installRemoteCli: async ({ parsed }) => {
        installRemoteCliCalls.push({
          relayUrl: parsed.relay.relayUrl,
        });
      },
      approveLocalAuthRequest: async () => undefined,
      runRemoteCommand: async ({ label, parsed }) => {
        invocations.push({
          label,
          relayUrl: parsed.relay.relayUrl,
        });
        if (label === 'auth.status') {
          return { ok: true, data: { authenticated: false } };
        }
        if (label === 'server.configure') {
          if (serverConfigureAttempts++ === 0) {
            return { ok: false, data: {} };
          }
          return { ok: true, data: { configured: true } };
        }
        if (label === 'auth.request') {
          return { ok: true, data: { publicKey: 'pub-key', supportsV2: true, webappUrl: 'https://relay.example.test' } };
        }
        if (label === 'auth.wait') {
          return { ok: true, data: { paired: true } };
        }
        if (label === 'relay.runtime.install') {
          return { ok: true, data: { relayUrl: 'http://10.0.0.5:3005' } };
        }
        if (label === 'daemon.service.install') {
          return { ok: true, data: { installed: true } };
        }
        if (label === 'daemon.service.start') {
          return { ok: true, data: { started: true } };
        }
        throw new Error(`Unexpected remote command: ${label}`);
      },
    });

    const runner = createSystemTasksRunner({
      kinds: {
        'remote.ssh.bootstrapMachine.v1': kind,
      },
    });

    await runner.start({
      taskId: 'ssh-relay-runtime-switch',
      kind: 'remote.ssh.bootstrapMachine.v1',
      params: {
        ssh: {
          target: 'dev@example.test',
          auth: 'agent',
        },
        relay: {
          relayUrl: 'https://relay.example.test',
        },
        serviceMode: 'user',
        relayRuntime: {
          enabled: true,
          mode: 'user',
        },
      },
    });

    const firstPoll = await waitForPendingPrompt(runner, { taskId: 'ssh-relay-runtime-switch', cursor: 0 });
    expect(firstPoll.pendingPrompt?.kind).toBe('auth.approveRemoteProvisioning');
    await runner.respond({
      taskId: 'ssh-relay-runtime-switch',
      answer: { approved: true },
    });

    const finalPoll = await waitForResult(runner, { taskId: 'ssh-relay-runtime-switch', cursor: firstPoll.nextCursor });
    expect(finalPoll.result?.ok).toBe(true);

    expect(invocations).toEqual([
      { label: 'relay.runtime.install', relayUrl: 'https://relay.example.test' },
      { label: 'server.configure', relayUrl: 'https://relay.example.test' },
      { label: 'server.configure', relayUrl: 'https://relay.example.test' },
      { label: 'auth.status', relayUrl: 'https://relay.example.test' },
      { label: 'auth.request', relayUrl: 'https://relay.example.test' },
      { label: 'auth.wait', relayUrl: 'https://relay.example.test' },
      { label: 'daemon.service.install', relayUrl: 'https://relay.example.test' },
      { label: 'daemon.service.start', relayUrl: 'https://relay.example.test' },
    ]);
    expect(installRemoteCliCalls).toEqual([
      { relayUrl: 'https://relay.example.test' },
    ]);
  });

  it('approves remote pairing against the configured relay while keeping the original local relay URL for credentials', async () => {
    const approvalCalls: Array<Readonly<{ relayUrl: string; publicRelayUrl?: string; webappUrl?: string }>> = [];
    const kind = createRemoteSshBootstrapMachineTaskKind({
      resolveHostTrust: async () => ({ status: 'trusted' }),
      installRemoteCli: async () => undefined,
      approveLocalAuthRequest: async ({ parsed }) => {
        approvalCalls.push({
          relayUrl: parsed.relay.relayUrl,
          ...(parsed.relay.publicRelayUrl ? { publicRelayUrl: parsed.relay.publicRelayUrl } : {}),
          ...(parsed.relay.webappUrl ? { webappUrl: parsed.relay.webappUrl } : {}),
        });
      },
      runRemoteCommand: async ({ label }) => {
        if (label === 'relay.runtime.install') {
          return { ok: true, data: { relayUrl: 'https://relay-runtime.example.test' } };
        }
        if (label === 'server.configure') {
          return { ok: true, data: { configured: true } };
        }
        if (label === 'auth.status') {
          return { ok: true, data: { authenticated: false } };
        }
        if (label === 'auth.request') {
          return { ok: true, data: { publicKey: 'pub-key', supportsV2: true, webappUrl: 'https://public-relay.example.test' } };
        }
        if (label === 'auth.wait') {
          return { ok: true, data: { paired: true } };
        }
        return { ok: true, data: {} };
      },
    });

    const runner = createSystemTasksRunner({
      kinds: {
        'remote.ssh.bootstrapMachine.v1': kind,
      },
    });

    await runner.start({
      taskId: 'ssh-relay-runtime-approval',
      kind: 'remote.ssh.bootstrapMachine.v1',
      params: {
        ssh: {
          target: 'dev@example.test',
          auth: 'agent',
        },
        relay: {
          relayUrl: 'http://127.0.0.1:3005',
          webappUrl: 'http://127.0.0.1:3005',
          publicRelayUrl: 'https://public-relay.example.test',
        },
        relayRuntime: {
          enabled: true,
          mode: 'user',
        },
        serviceMode: 'none',
        promptResolution: {
          authApproval: {
            publicKey: 'pub-key',
          },
        },
      },
    });

    const finalPoll = await waitForResult(runner, { taskId: 'ssh-relay-runtime-approval', cursor: 0 });
    expect(finalPoll.result?.ok).toBe(true);
    expect(approvalCalls).toEqual([
      {
        relayUrl: 'http://127.0.0.1:3005',
        publicRelayUrl: 'https://public-relay.example.test',
        webappUrl: 'http://127.0.0.1:3005',
      },
    ]);
  });

  it('derives the installed relay runtime URL from serverPort without switching the remote CLI/daemon by default', async () => {
    const invocations: Array<Readonly<{ label: string; relayUrl: string }>> = [];
    const installRemoteCliCalls: Array<Readonly<{ relayUrl: string }>> = [];
    let serverConfigureAttempts = 0;

    const kind = createRemoteSshBootstrapMachineTaskKind({
      resolveHostTrust: async () => ({ status: 'trusted' }),
      installRemoteCli: async ({ parsed }) => {
        installRemoteCliCalls.push({
          relayUrl: parsed.relay.relayUrl,
        });
      },
      approveLocalAuthRequest: async () => undefined,
      runRemoteCommand: async ({ label, parsed }) => {
        invocations.push({
          label,
          relayUrl: parsed.relay.relayUrl,
        });
        if (label === 'relay.runtime.install') {
          return { ok: true, data: { serverPort: 4449 } };
        }
        if (label === 'server.configure') {
          if (serverConfigureAttempts++ === 0) {
            return { ok: false, data: {} };
          }
          return { ok: true, data: { configured: true } };
        }
        if (label === 'auth.status') {
          return { ok: true, data: { authenticated: false } };
        }
        if (label === 'auth.request') {
          return { ok: true, data: { publicKey: 'pub-key', supportsV2: true, webappUrl: 'https://public.example.test' } };
        }
        if (label === 'auth.wait') {
          return { ok: true, data: { paired: true } };
        }
        if (label === 'daemon.service.install') {
          return { ok: true, data: { installed: true } };
        }
        if (label === 'daemon.service.start') {
          return { ok: true, data: { started: true } };
        }
        throw new Error(`Unexpected remote command: ${label}`);
      },
    });

    const runner = createSystemTasksRunner({
      kinds: {
        'remote.ssh.bootstrapMachine.v1': kind,
      },
    });

    await runner.start({
      taskId: 'ssh-relay-runtime-serverPort',
      kind: 'remote.ssh.bootstrapMachine.v1',
      params: {
        ssh: {
          target: 'dev@example.test',
          auth: 'agent',
        },
        relay: {
          relayUrl: 'http://127.0.0.1:3005',
          webappUrl: 'http://localhost:3005',
          publicRelayUrl: 'https://public.example.test',
        },
        serviceMode: 'user',
        relayRuntime: {
          enabled: true,
          mode: 'user',
        },
        promptResolution: {
          authApproval: {
            publicKey: 'pub-key',
          },
        },
      },
    });

    const finalPoll = await waitForResult(runner, { taskId: 'ssh-relay-runtime-serverPort', cursor: 0 });
    expect(finalPoll.result).toEqual({
      protocolVersion: 1,
      taskId: 'ssh-relay-runtime-serverPort',
      ok: true,
      data: {
        publicKey: 'pub-key',
        machineId: null,
        relayRuntime: {
          relayUrl: 'http://127.0.0.1:4449',
          mode: 'user',
        },
      },
    });

    expect(invocations).toEqual([
      { label: 'relay.runtime.install', relayUrl: 'https://public.example.test' },
      { label: 'server.configure', relayUrl: 'https://public.example.test' },
      { label: 'server.configure', relayUrl: 'https://public.example.test' },
      { label: 'auth.status', relayUrl: 'https://public.example.test' },
      { label: 'auth.request', relayUrl: 'https://public.example.test' },
      { label: 'auth.wait', relayUrl: 'https://public.example.test' },
      { label: 'daemon.service.install', relayUrl: 'https://public.example.test' },
      { label: 'daemon.service.start', relayUrl: 'https://public.example.test' },
    ]);
    expect(installRemoteCliCalls).toEqual([
      { relayUrl: 'https://public.example.test' },
    ]);
  });

  it('skips interactive prompts when matching desktop prompt resolutions are provided', async () => {
    const invocations: string[] = [];
    const kind = createRemoteSshBootstrapMachineTaskKind({
      resolveHostTrust: async () => ({
        status: 'prompt',
        promptKind: 'ssh.trustHost',
        promptMessage: 'Trust this SSH host?',
        promptData: {
          host: 'example.test',
          keyType: 'ssh-ed25519',
          fingerprint: 'SHA256:abc',
        },
        accept: async () => {
          invocations.push('acceptHostTrust');
        },
      }),
      installRemoteCli: async () => {
        throw new Error('should not install cli when remote commands already succeed');
      },
      approveLocalAuthRequest: async ({ publicKey }) => {
        invocations.push(`approveLocalAuthRequest:${publicKey}`);
      },
      runRemoteCommand: async ({ label, data }) => {
        invocations.push(label);
        if (label === 'server.configure') {
          return { ok: true, data: { configured: true } };
        }
        if (label === 'auth.status') {
          return { ok: true, data: { authenticated: false } };
        }
        if (label === 'auth.request') {
          return {
            ok: true,
            data: {
              publicKey: 'pub-key',
              claimSecret: 'secret-value',
              stateFile: '/tmp/claim-state.json',
            },
          };
        }
        if (label === 'auth.wait') {
          expect(data).toEqual({ publicKey: 'pub-key' });
          return { ok: true, data: { machineId: 'machine-remote-1' } };
        }
        if (label === 'daemon.service.install') {
          return { ok: true, data: { installed: true } };
        }
        if (label === 'daemon.service.start') {
          return { ok: true, data: { started: true } };
        }
        throw new Error(`Unexpected remote command: ${label}`);
      },
    });

    const promptCalls: string[] = [];
    const result = await kind.run({
      params: {
        ssh: {
          target: 'dev@example.test',
          auth: 'agent',
        },
        relay: {
          relayUrl: 'https://relay.example.test',
        },
        promptResolution: {
          hostTrust: {
            kind: 'ssh.trustHost',
            fingerprint: 'SHA256:abc',
          },
          authApproval: {
            publicKey: 'pub-key',
          },
        },
      },
      emit: () => undefined,
      prompt: async (prompt) => {
        promptCalls.push(prompt.kind);
        throw new Error(`Unexpected prompt: ${prompt.kind}`);
      },
    });

    expect(promptCalls).toEqual([]);
    expect(result).toEqual({
      publicKey: 'pub-key',
      machineId: 'machine-remote-1',
    });
    expect(invocations).toEqual([
      'acceptHostTrust',
      'server.configure',
      'auth.status',
      'auth.request',
      'approveLocalAuthRequest:pub-key',
      'auth.wait',
      'daemon.service.install',
      'daemon.service.start',
    ]);
  });

  it('fails closed and keeps prompting when auth approval resolution does not match the requested public key', async () => {
    const kind = createRemoteSshBootstrapMachineTaskKind({
      resolveHostTrust: async () => ({
        status: 'prompt',
        promptKind: 'ssh.trustHost',
        promptMessage: 'Trust this SSH host?',
        promptData: {
          host: 'example.test',
          keyType: 'ssh-ed25519',
          fingerprint: 'SHA256:abc',
        },
        accept: async () => undefined,
      }),
      installRemoteCli: async () => undefined,
      approveLocalAuthRequest: async () => {
        throw new Error('should not auto-approve when the prompt resolution is stale');
      },
      runRemoteCommand: async ({ label }) => {
        if (label === 'auth.status') {
          return { ok: true, data: { authenticated: false } };
        }
        if (label === 'server.configure') {
          return { ok: true, data: { configured: true } };
        }
        if (label === 'auth.request') {
          return {
            ok: true,
            data: {
              publicKey: 'pub-key-fresh',
            },
          };
        }
        throw new Error(`Unexpected remote command: ${label}`);
      },
    });

    const promptCalls: string[] = [];
    await expect(kind.run({
      params: {
        ssh: {
          target: 'dev@example.test',
          auth: 'agent',
        },
        relay: {
          relayUrl: 'https://relay.example.test',
        },
        promptResolution: {
          hostTrust: {
            kind: 'ssh.trustHost',
            fingerprint: 'SHA256:abc',
          },
          authApproval: {
            publicKey: 'pub-key-stale',
          },
        },
      },
      emit: () => undefined,
      prompt: async (prompt) => {
        promptCalls.push(prompt.kind);
        throw new Error(`Prompt surfaced: ${prompt.kind}`);
      },
    })).rejects.toThrow('Prompt surfaced: auth.approveRemoteProvisioning');

    expect(promptCalls).toEqual(['auth.approveRemoteProvisioning']);
  });

  it('does not auto-approve remote provisioning without an expected public key', async () => {
    const kind = createRemoteSshBootstrapMachineTaskKind({
      resolveHostTrust: async () => ({ status: 'trusted' }),
      installRemoteCli: async () => undefined,
      approveLocalAuthRequest: async () => {
        throw new Error('should not auto-approve without an expected public key');
      },
      runRemoteCommand: async ({ label }) => {
        if (label === 'auth.status') {
          return { ok: true, data: { authenticated: false } };
        }
        if (label === 'server.configure') {
          return { ok: true, data: { configured: true } };
        }
        if (label === 'auth.request') {
          return {
            ok: true,
            data: {
              publicKey: 'pub-key-fresh',
            },
          };
        }
        throw new Error(`Unexpected remote command: ${label}`);
      },
    });

    const promptCalls: string[] = [];
    await expect(kind.run({
      params: {
        ssh: {
          target: 'dev@example.test',
          auth: 'agent',
        },
        relay: {
          relayUrl: 'https://relay.example.test',
        },
        promptResolution: {
          autoApproveAuthRequest: true,
        },
      },
      emit: () => undefined,
      prompt: async (prompt) => {
        promptCalls.push(prompt.kind);
        throw new Error(`Prompt surfaced: ${prompt.kind}`);
      },
    })).rejects.toThrow('Prompt surfaced: auth.approveRemoteProvisioning');

    expect(promptCalls).toEqual(['auth.approveRemoteProvisioning']);
  });

  it('rejects invalid host-trust resolution kinds instead of coercing them', async () => {
    const kind = createRemoteSshBootstrapMachineTaskKind({
      resolveHostTrust: async () => {
        throw new Error('should not resolve host trust when params are invalid');
      },
      installRemoteCli: async () => {
        throw new Error('should not install remote cli when params are invalid');
      },
      approveLocalAuthRequest: async () => {
        throw new Error('should not approve auth when params are invalid');
      },
      runRemoteCommand: async () => {
        throw new Error('should not run remote commands when params are invalid');
      },
    });

    await expect(kind.run({
      params: {
        ssh: {
          target: 'dev@example.test',
          auth: 'agent',
        },
        relay: {
          relayUrl: 'https://relay.example.test',
        },
        promptResolution: {
          hostTrust: {
            kind: 'ssh.unexpectedKind',
            fingerprint: 'SHA256:abc',
          },
        },
      },
      emit: () => undefined,
      prompt: async () => {
        throw new Error('should not prompt when params are invalid');
      },
    })).rejects.toMatchObject({
      code: 'invalid_params',
      message: 'Unsupported promptResolution.hostTrust.kind.',
    });
  });

  it('treats unsupported SSH auth modes as agent auth (no password prompt)', async () => {
    const observedAuthModes: string[] = [];
    let serverConfigureAttempts = 0;
    const kind = createRemoteSshBootstrapMachineTaskKind({
      resolveHostTrust: async () => ({ status: 'trusted' }),
      installRemoteCli: async ({ auth }) => {
        observedAuthModes.push(auth.mode);
      },
      approveLocalAuthRequest: async () => undefined,
      runRemoteCommand: async ({ label, auth }) => {
        observedAuthModes.push(auth.mode);
        if (label === 'server.configure') {
          if (serverConfigureAttempts++ === 0) {
            return { ok: false, data: {} };
          }
          return { ok: true, data: { configured: true } };
        }
        if (label === 'auth.status') {
          return { ok: true, data: { authenticated: true, machineId: 'machine-remote-1' } };
        }
        if (label === 'daemon.service.install') {
          return { ok: true, data: { installed: true } };
        }
        if (label === 'daemon.service.start') {
          return { ok: true, data: { started: true } };
        }
        throw new Error(`Unexpected remote command: ${label}`);
      },
    });

    const runner = createSystemTasksRunner({
      kinds: {
        'remote.ssh.bootstrapMachine.v1': kind,
      },
    });

    await runner.start({
      taskId: 'ssh-task-password',
      kind: 'remote.ssh.bootstrapMachine.v1',
      params: {
        ssh: {
          target: 'dev@example.test',
          auth: 'unsupported',
        },
        relay: {
          relayUrl: 'https://relay.example.test',
        },
        serviceMode: 'none',
      },
    });

    const finalPoll = await waitForResult(runner, { taskId: 'ssh-task-password', cursor: 0 });
    expect(finalPoll.result?.ok).toBe(true);
    expect(new Set(observedAuthModes)).toEqual(new Set(['agent']));
  });
});
