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
    expect(secondPoll.events.map((event) => event.stepId)).toContain('ssh.auth.request');
    await runner.respond({ taskId: 'ssh-relay-task', answer: { approved: true } });

    const finalPoll = await waitForResult(runner, { taskId: 'ssh-relay-task', cursor: secondPoll.nextCursor });

    expect(finalPoll.events.map((event) => event.stepId)).toEqual([
      'ssh.auth.wait',
      'relay.runtime.install',
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

  it('switches the remote CLI and daemon to the installed relay runtime when enabled', async () => {
    const invocations: Array<Readonly<{ label: string; relayUrl: string }>> = [];
    const kind = createRemoteSshBootstrapMachineTaskKind({
      resolveHostTrust: async () => ({ status: 'trusted' }),
      installRemoteCli: async () => undefined,
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
      { label: 'server.configure', relayUrl: 'https://relay.example.test' },
      { label: 'auth.status', relayUrl: 'https://relay.example.test' },
      { label: 'auth.request', relayUrl: 'https://relay.example.test' },
      { label: 'auth.wait', relayUrl: 'https://relay.example.test' },
      { label: 'relay.runtime.install', relayUrl: 'https://relay.example.test' },
      { label: 'server.configure', relayUrl: 'http://10.0.0.5:3005' },
      { label: 'daemon.service.install', relayUrl: 'http://10.0.0.5:3005' },
      { label: 'daemon.service.start', relayUrl: 'http://10.0.0.5:3005' },
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
});
