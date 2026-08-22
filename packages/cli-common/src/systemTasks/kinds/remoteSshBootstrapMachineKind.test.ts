import { describe, expect, it } from 'vitest';
import { readFile, stat } from 'node:fs/promises';

import { createSystemTasksRunner } from '../interactiveTaskKinds.js';
import {
  createRemoteSshBootstrapMachineTaskKind,
  type RemoteSshBootstrapMachineDeps,
} from './remoteSshBootstrapMachineKind.js';

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
    type RemoteLabel = Parameters<RemoteSshBootstrapMachineDeps['runRemoteCommand']>[0]['label'];

    const mapArgsToRemoteLabel = (args: readonly string[]) => {
      if (args[0] === 'server' && args[1] === 'set') return 'server.configure' as const;
      if (args[0] === 'auth' && args[1] === 'status') return 'auth.status' as const;
      if (args[0] === 'auth' && args[1] === 'request') return 'auth.request' as const;
      if (args[0] === 'auth' && args[1] === 'wait') return 'auth.wait' as const;
      if (args[0] === 'service' && args[1] === 'install') return 'daemon.service.install' as const;
      if (args[0] === 'service' && args[1] === 'start') return 'daemon.service.start' as const;
      if (args[0] === 'daemon' && args[1] === 'service' && args[2] === 'install') return 'daemon.service.install' as const;
      if (args[0] === 'daemon' && args[1] === 'service' && args[2] === 'start') return 'daemon.service.start' as const;
      if (args[0] === 'relay' && args[1] === 'runtime' && args[2] === 'install') return 'relay.runtime.install' as const;
      throw new Error(`Unexpected remote happier args: ${JSON.stringify(args)}`);
    };

    const readFlagValue = (args: readonly string[], flag: string) => {
      const index = args.indexOf(flag);
      if (index < 0) return '';
      return typeof args[index + 1] === 'string' ? String(args[index + 1]) : '';
    };

    let remoteCliInstalled = false;
    const runRemoteCommandBase: RemoteSshBootstrapMachineDeps['runRemoteCommand'] = async ({ label, parsed, data }) => {
      expect(parsed.relay.relayUrl).toBe('https://relay.example.test');

      if (label === 'relay.runtime.install') {
        return { ok: true, data: { relayUrl: 'http://127.0.0.1:9999', mode: 'user' } };
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
        expect(String(data?.publicKey ?? '')).toBe('pub-key');
        return { ok: true, data: { paired: true, machineId: 'remote-machine' } };
      }

      if (label === 'daemon.service.install') {
        return { ok: true, data: { installed: true } };
      }

      if (label === 'daemon.service.start') {
        return { ok: true, data: { started: true } };
      }

      throw new Error(`Unexpected remote command: ${label}`);
    };

    const kind = createRemoteSshBootstrapMachineTaskKind({
      resolveHostTrust: async () => ({ status: 'trusted' }),
      installRemoteCli: async () => {
        remoteCliInstalled = true;
      },
      createHappierJsonExecutor: ({ parsed, auth, knownHostsMode, localServerUrl }) => ({
        runHappierJson: async ({ args }) => {
          const label: RemoteLabel = mapArgsToRemoteLabel(args);
          const publicKey = label === 'auth.wait' ? readFlagValue(args, '--public-key') : '';
          return await runRemoteCommandBase({
            label,
            parsed,
            auth,
            knownHostsMode,
            data: {
              ...(localServerUrl ? { localServerUrl } : {}),
              ...(publicKey ? { publicKey } : {}),
              __viaExecutor: true,
            },
          });
        },
      }),
      approveLocalAuthRequest: async ({ parsed }) => {
        expect(parsed.relay.relayUrl).toBe('http://127.0.0.1:9999');
        expect(parsed.relay.publicRelayUrl).toBe('https://relay.example.test');
      },
      runRemoteCommand: async ({ label, parsed, auth, knownHostsMode, data }) => {
        if (label === 'server.configure' || label === 'auth.request' || label === 'auth.wait' || label === 'daemon.service.install' || label === 'daemon.service.start') {
          expect((data ?? {}).localServerUrl).toBe('http://127.0.0.1:9999');
          expect((data ?? {}).__viaExecutor).toBe(true);
        }
        return await runRemoteCommandBase({
          label,
          parsed,
          auth,
          knownHostsMode,
          data,
        });
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

  it('keeps the original relay target when no public relay URL is available', async () => {
    const invocations: string[] = [];
    const kind = createRemoteSshBootstrapMachineTaskKind({
      resolveHostTrust: async () => ({ status: 'trusted' }),
      installRemoteCli: async () => undefined,
      approveLocalAuthRequest: async ({ parsed }) => {
        expect(parsed.relay.relayUrl).toBe('https://api.happier.dev');
      },
      runRemoteCommand: async ({ label, parsed, data }) => {
        invocations.push(label);
        if (label === 'relay.runtime.install') {
          return { ok: true, data: { relayUrl: 'http://127.0.0.1:9999', mode: 'user' } };
        }

        if (label === 'server.configure' || label === 'auth.request' || label === 'auth.wait' || label === 'daemon.service.install' || label === 'daemon.service.start') {
          expect((data ?? {}).localServerUrl).toBeUndefined();
        }

        expect(parsed.relay.relayUrl).toBe('https://api.happier.dev');

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
              supportsV2: true,
              webappUrl: 'http://127.0.0.1:9999',
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
          relayUrl: 'https://api.happier.dev',
          webappUrl: 'https://app.happier.dev',
        },
        relayRuntime: {
          enabled: true,
          mode: 'user',
        },
        channel: 'dev',
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
    expect(invocations[0]).toBe('relay.runtime.install');
    expect(invocations).toContain('server.configure');
    expect(invocations.indexOf('relay.runtime.install')).toBeLessThan(invocations.indexOf('server.configure'));
    expect(invocations.indexOf('server.configure')).toBeLessThan(invocations.indexOf('auth.request'));
  });

  it('switches to the installed relay runtime when relay.relayUrl is loopback and no public relay URL exists', async () => {
    const kind = createRemoteSshBootstrapMachineTaskKind({
      resolveHostTrust: async () => ({ status: 'trusted' }),
      installRemoteCli: async () => undefined,
      approveLocalAuthRequest: async ({ parsed }) => {
        expect(parsed.relay.relayUrl).toBe('http://127.0.0.1:9999');
      },
      runRemoteCommand: async ({ label, parsed, data }) => {
        if (label === 'relay.runtime.install') {
          return { ok: true, data: { relayUrl: 'http://127.0.0.1:9999', mode: 'user' } };
        }

        if (
          label === 'server.configure'
          || label === 'auth.request'
          || label === 'auth.wait'
          || label === 'daemon.service.install'
          || label === 'daemon.service.start'
        ) {
          expect((data ?? {}).localServerUrl).toBeUndefined();
          expect(parsed.relay.relayUrl).toBe('http://127.0.0.1:9999');
        }

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
              webappUrl: 'http://127.0.0.1:9999',
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
      taskId: 'ssh-task-loopback',
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
        relayRuntime: {
          enabled: true,
          mode: 'user',
        },
        channel: 'dev',
        serviceMode: 'user',
        promptResolution: {
          authApproval: {
            publicKey: 'pub-key',
          },
        },
      },
    });

    const result = await waitForResult(runner, { taskId: 'ssh-task-loopback', cursor: 0 });
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
          return { ok: true, data: { paired: true, machineId: 'machine-runtime-port-1' } };
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

  it('accepts publicdev as an alias for the dev channel label', async () => {
    const kind = createRemoteSshBootstrapMachineTaskKind({
      resolveHostTrust: async () => ({ status: 'trusted' }),
      installRemoteCli: async ({ parsed }) => {
        expect(parsed.channel).toBe('dev');
      },
      approveLocalAuthRequest: async () => undefined,
      runRemoteCommand: async ({ label }) => {
        if (label === 'auth.status') return { ok: true, data: { authenticated: true } };
        if (label === 'auth.request') return { ok: true, data: { publicKey: 'pub', claimSecret: 'secret', stateFile: '/tmp/state.json' } };
        if (label === 'auth.wait') return { ok: true, data: { paired: true, machineId: 'machine-remote-0' } };
        if (label === 'server.configure') return { ok: true, data: { configured: true } };
        if (label === 'daemon.service.install') return { ok: true, data: { installed: true } };
        if (label === 'daemon.service.start') return { ok: true, data: { started: true } };
        return { ok: true, data: {} };
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
          relayUrl: 'https://api.happier.dev',
          webappUrl: 'https://app.happier.dev',
        },
        channel: 'publicdev',
        serviceMode: 'user',
        promptResolution: {
          authApproval: {
            publicKey: 'pub',
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
          return { ok: true, data: { paired: true, machineId: 'machine-remote-0' } };
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
        machineId: 'machine-remote-0',
      },
    });
    expect(invocations).toEqual([
      'daemon.service.list',
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

  it('does not prompt for SSH passwords when ssh.password is provided in params', async () => {
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
            throw new Error('remote cli missing');
          }
          return { ok: true, data: { configured: true } };
        }
        if (label === 'auth.status') {
          return { ok: true, data: { authenticated: true, machineId: 'machine-password-provided' } };
        }
        throw new Error(`Unexpected remote command: ${label}`);
      },
    });

    const runner = createSystemTasksRunner({
      kinds: { 'remote.ssh.bootstrapMachine.v1': kind },
    });

    await runner.start({
      taskId: 'ssh-password-provided',
      kind: 'remote.ssh.bootstrapMachine.v1',
      params: {
        ssh: {
          target: 'dev@example.test',
          auth: 'password',
          password: 'super-secret',
        },
        relay: {
          relayUrl: 'https://relay.example.test',
        },
        serviceMode: 'none',
      },
    });

    const result = await waitForResult(runner, { taskId: 'ssh-password-provided', cursor: 0 });
    expect(result.result?.ok).toBe(true);
    expect(result.events.some((event) => event.type === 'prompt')).toBe(false);
  });

  it('accepts ssh.identityPrivateKey for keyfile auth by materializing a temp identity file for the run', async () => {
    let remoteCliInstalled = false;
    let observedIdentityPath: string | null = null;
    const privateKeyMaterial = '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n';

    const kind = createRemoteSshBootstrapMachineTaskKind({
      resolveHostTrust: async () => ({ status: 'trusted' }),
      installRemoteCli: async () => {
        remoteCliInstalled = true;
      },
      approveLocalAuthRequest: async () => undefined,
      runRemoteCommand: async ({ label, auth }) => {
        if (label === 'server.configure') {
          if (!remoteCliInstalled) {
            throw new Error('remote cli missing');
          }
          if (auth.mode !== 'keyFile') {
            throw new Error('expected keyFile auth');
          }
          observedIdentityPath = auth.privateKeyPath;
          const contents = await readFile(auth.privateKeyPath, 'utf8');
          expect(contents).toContain('abc');
          return { ok: true, data: { configured: true } };
        }
        if (label === 'auth.status') {
          return { ok: true, data: { authenticated: true, machineId: 'machine-key-material' } };
        }
        throw new Error(`Unexpected remote command: ${label}`);
      },
    });

    const runner = createSystemTasksRunner({
      kinds: { 'remote.ssh.bootstrapMachine.v1': kind },
    });

    await runner.start({
      taskId: 'key-material',
      kind: 'remote.ssh.bootstrapMachine.v1',
      params: {
        ssh: {
          target: 'dev@example.test',
          auth: 'keyfile',
          identityPrivateKey: privateKeyMaterial,
        },
        relay: {
          relayUrl: 'https://relay.example.test',
        },
        serviceMode: 'none',
      },
    });

    const result = await waitForResult(runner, { taskId: 'key-material', cursor: 0 });
    expect(result.result?.ok).toBe(true);
    expect(typeof observedIdentityPath).toBe('string');

    if (observedIdentityPath) {
      await expect(stat(observedIdentityPath)).rejects.toBeTruthy();
    }
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

  it('prompts before replacing conflicting remote background services and removes them when approved', async () => {
    const invocations: string[] = [];
    const kind = createRemoteSshBootstrapMachineTaskKind({
      resolveHostTrust: async () => ({ status: 'trusted' }),
      installRemoteCli: async () => undefined,
      approveLocalAuthRequest: async () => undefined,
      runRemoteCommand: async ({ label, data }) => {
        invocations.push(label);
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
              webappUrl: 'https://relay.example.test',
            },
          };
        }
        if (label === 'auth.wait') {
          expect(data).toEqual({ publicKey: 'pub-key' });
          return { ok: true, data: { paired: true, machineId: 'remote-machine' } };
        }
        if (label === 'daemon.service.list') {
          return {
            ok: true,
            data: {
              services: [
                {
                  id: 'service-preview',
                  serviceType: 'daemon',
                  label: 'happier-daemon.preview',
                  ring: 'preview',
                  targetMode: 'pinned',
                  installed: true,
                  running: true,
                },
              ],
            },
          };
        }
        if (label === 'daemon.service.uninstallAll') {
          return { ok: true, data: { removed: 1 } };
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
      taskId: 'ssh-task-conflict',
      kind: 'remote.ssh.bootstrapMachine.v1',
      params: {
        ssh: {
          target: 'dev@example.test',
          auth: 'agent',
        },
        relay: {
          relayUrl: 'https://relay.example.test',
        },
        channel: 'dev',
        serviceMode: 'user',
        promptResolution: {
          authApproval: {
            publicKey: 'pub-key',
          },
        },
      },
    });

    const promptPoll = await waitForPendingPrompt(runner, { taskId: 'ssh-task-conflict', cursor: 0 });
    expect(promptPoll.pendingPrompt).toEqual({
      kind: 'daemon.replaceRemoteBackgroundServices',
      data: {
        targetServerUrl: 'https://relay.example.test',
        targetReleaseChannel: 'dev',
        services: [
          {
            label: 'happier-daemon.preview',
            releaseChannel: 'preview',
            targetMode: 'pinned',
            running: true,
          },
        ],
      },
    });

    await runner.respond({
      taskId: 'ssh-task-conflict',
      answer: { replaceExistingServices: true },
    });

    const finalPoll = await waitForResult(runner, { taskId: 'ssh-task-conflict', cursor: promptPoll.nextCursor });
    expect(finalPoll.result).toEqual({
      protocolVersion: 1,
      taskId: 'ssh-task-conflict',
      ok: true,
      data: {
        publicKey: 'pub-key',
        machineId: 'remote-machine',
      },
    });
    expect(invocations).toEqual([
      'daemon.service.list',
      'daemon.service.uninstallAll',
      'server.configure',
      'auth.status',
      'auth.request',
      'auth.wait',
      'daemon.service.install',
      'daemon.service.start',
    ]);
  });

  it('keeps existing remote background services when replacement is declined', async () => {
    const invocations: string[] = [];
    const kind = createRemoteSshBootstrapMachineTaskKind({
      resolveHostTrust: async () => ({ status: 'trusted' }),
      installRemoteCli: async () => undefined,
      approveLocalAuthRequest: async () => undefined,
      runRemoteCommand: async ({ label, data }) => {
        invocations.push(label);
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
              webappUrl: 'https://relay.example.test',
            },
          };
        }
        if (label === 'auth.wait') {
          expect(data).toEqual({ publicKey: 'pub-key' });
          return { ok: true, data: { paired: true, machineId: 'remote-machine' } };
        }
        if (label === 'daemon.service.list') {
          return {
            ok: true,
            data: {
              services: [
                {
                  id: 'service-preview',
                  serviceType: 'daemon',
                  label: 'happier-daemon.preview',
                  ring: 'preview',
                  targetMode: 'pinned',
                  installed: true,
                  running: true,
                },
              ],
            },
          };
        }
        if (label === 'daemon.service.uninstallAll' || label === 'daemon.service.install' || label === 'daemon.service.start') {
          throw new Error(`Did not expect ${label} when replacement is declined`);
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
      taskId: 'ssh-task-conflict-decline',
      kind: 'remote.ssh.bootstrapMachine.v1',
      params: {
        ssh: {
          target: 'dev@example.test',
          auth: 'agent',
        },
        relay: {
          relayUrl: 'https://relay.example.test',
        },
        channel: 'dev',
        serviceMode: 'user',
        promptResolution: {
          authApproval: {
            publicKey: 'pub-key',
          },
        },
      },
    });

    const promptPoll = await waitForPendingPrompt(runner, { taskId: 'ssh-task-conflict-decline', cursor: 0 });
    expect(promptPoll.pendingPrompt?.kind).toBe('daemon.replaceRemoteBackgroundServices');

    await runner.respond({
      taskId: 'ssh-task-conflict-decline',
      answer: { replaceExistingServices: false },
    });

    const finalPoll = await waitForResult(runner, { taskId: 'ssh-task-conflict-decline', cursor: promptPoll.nextCursor });
    expect(finalPoll.result).toEqual({
      protocolVersion: 1,
      taskId: 'ssh-task-conflict-decline',
      ok: true,
      data: {
        publicKey: 'pub-key',
        machineId: 'remote-machine',
      },
    });
    expect(invocations).toEqual([
      'daemon.service.list',
      'server.configure',
      'auth.status',
      'auth.request',
      'auth.wait',
    ]);
  });

  it('continues waiting for pairing even when local approval cannot be submitted because the operator is not authenticated', async () => {
    const invocations: string[] = [];
    const kind = createRemoteSshBootstrapMachineTaskKind({
      resolveHostTrust: async () => ({ status: 'trusted' }),
      installRemoteCli: async () => undefined,
      approveLocalAuthRequest: async () => {
        throw new Error('Not authenticated. Run `happier auth login` first.');
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
          return { ok: true, data: { publicKey: 'pub-key', supportsV2: true, webappUrl: 'https://relay.example.test' } };
        }
        if (label === 'auth.wait') {
          expect(data).toEqual({ publicKey: 'pub-key' });
          return { ok: true, data: { paired: true, machineId: 'machine-not-auth-1' } };
        }
        throw new Error(`Unexpected remote command: ${label}`);
      },
    });

    const runner = createSystemTasksRunner({
      kinds: { 'remote.ssh.bootstrapMachine.v1': kind },
    });

    await runner.start({
      taskId: 'ssh-task-not-auth',
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
        serviceMode: 'none',
      },
    });

    const firstPoll = await waitForPendingPrompt(runner, { taskId: 'ssh-task-not-auth', cursor: 0 });
    expect(firstPoll.pendingPrompt?.kind).toBe('auth.approveRemoteProvisioning');
    await runner.respond({
      taskId: 'ssh-task-not-auth',
      answer: { approved: true },
    });

    const finalPoll = await waitForResult(runner, { taskId: 'ssh-task-not-auth', cursor: firstPoll.nextCursor });
    expect(finalPoll.result?.ok).toBe(true);
    expect(invocations).toEqual(['server.configure', 'auth.status', 'auth.request', 'auth.wait']);
  });

  it('fails closed when local approval is required but cannot be submitted because the operator is not authenticated', async () => {
    const kind = createRemoteSshBootstrapMachineTaskKind({
      resolveHostTrust: async () => ({ status: 'trusted' }),
      installRemoteCli: async () => undefined,
      approveLocalAuthRequest: async () => {
        throw new Error('Not authenticated. Run `happier auth login` first.');
      },
      runRemoteCommand: async ({ label, data }) => {
        if (label === 'server.configure') {
          return { ok: true, data: { configured: true } };
        }
        if (label === 'auth.status') {
          return { ok: true, data: { authenticated: false } };
        }
        if (label === 'auth.request') {
          return { ok: true, data: { publicKey: 'pub-key', supportsV2: true, webappUrl: 'https://relay.example.test' } };
        }
        if (label === 'auth.wait') {
          expect(data).toEqual({ publicKey: 'pub-key' });
          return { ok: true, data: { paired: true, machineId: 'machine-not-auth-2' } };
        }
        throw new Error(`Unexpected remote command: ${label}`);
      },
    });

    const runner = createSystemTasksRunner({
      kinds: { 'remote.ssh.bootstrapMachine.v1': kind },
    });

    await runner.start({
      taskId: 'ssh-task-not-auth-required',
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
        serviceMode: 'none',
        requireLocalApproval: true,
      },
    });

    const firstPoll = await waitForPendingPrompt(runner, { taskId: 'ssh-task-not-auth-required', cursor: 0 });
    expect(firstPoll.pendingPrompt?.kind).toBe('auth.approveRemoteProvisioning');
    await runner.respond({
      taskId: 'ssh-task-not-auth-required',
      answer: { approved: true },
    });

    const finalPoll = await waitForResult(runner, { taskId: 'ssh-task-not-auth-required', cursor: firstPoll.nextCursor });
    expect(finalPoll.result).toEqual({
      protocolVersion: 1,
      taskId: 'ssh-task-not-auth-required',
      ok: false,
      error: {
        code: 'local_approval_required',
        message: 'Remote setup requires local approval, but this CLI is not authenticated.',
      },
    });
  });

  it('fails closed when relay.relayUrl is loopback and relay runtime install is not enabled', async () => {
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
          relayUrl: 'http://localhost.:3005',
          webappUrl: 'http://localhost.:3005',
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

  it('allows loopback relay URLs when relay runtime install is enabled and keeps the relay target explicit while reconciling remote commands to the installed runtime', async () => {
    const invocations: Array<Readonly<{ label: string; relayUrl: string; localServerUrl?: string }>> = [];
    const approvalCalls: Array<Readonly<{ relayUrl: string }>> = [];
    const kind = createRemoteSshBootstrapMachineTaskKind({
      resolveHostTrust: async () => ({ status: 'trusted' }),
      installRemoteCli: async () => undefined,
      approveLocalAuthRequest: async ({ parsed }) => {
        approvalCalls.push({
          relayUrl: parsed.relay.relayUrl,
        });
      },
      runRemoteCommand: async ({ label, parsed, data }) => {
        invocations.push({
          label,
          relayUrl: parsed.relay.relayUrl,
          ...(typeof data?.localServerUrl === 'string'
            ? { localServerUrl: data.localServerUrl }
            : {}),
        });

        if (label === 'relay.runtime.install') {
          return { ok: true, data: { relayUrl: 'http://10.0.0.5:3005' } };
        }
        if (label === 'server.configure' || label === 'auth.request' || label === 'auth.wait' || label === 'daemon.service.install' || label === 'daemon.service.start') {
          expect((data ?? {}).localServerUrl).toBe('http://10.0.0.5:3005');
        }
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
              supportsV2: true,
              webappUrl: 'http://127.0.0.1:3005',
            },
          };
        }
        if (label === 'auth.wait') {
          return { ok: true, data: { paired: true, machineId: 'machine-loopback-1' } };
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
      taskId: 'ssh-task-loopback-install-relay-runtime',
      kind: 'remote.ssh.bootstrapMachine.v1',
      params: {
        ssh: {
          target: 'dev@example.test',
          auth: 'agent',
        },
        relay: {
          relayUrl: 'http://127.0.0.1:3005',
          webappUrl: 'http://127.0.0.1:3005',
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

    const finalPoll = await waitForResult(runner, { taskId: 'ssh-task-loopback-install-relay-runtime', cursor: 0 });
    expect(finalPoll.result).toEqual({
      protocolVersion: 1,
      taskId: 'ssh-task-loopback-install-relay-runtime',
      ok: true,
      data: {
        publicKey: 'pub-key',
        machineId: 'machine-loopback-1',
        relayRuntime: {
          relayUrl: 'http://10.0.0.5:3005',
          mode: 'user',
        },
      },
    });
    expect(approvalCalls).toEqual([
      {
        relayUrl: 'http://127.0.0.1:3005',
      },
    ]);
    expect(invocations).toEqual([
      { label: 'relay.runtime.install', relayUrl: 'http://127.0.0.1:3005' },
      { label: 'daemon.service.list', relayUrl: 'http://127.0.0.1:3005', localServerUrl: 'http://10.0.0.5:3005' },
      { label: 'server.configure', relayUrl: 'http://127.0.0.1:3005', localServerUrl: 'http://10.0.0.5:3005' },
      { label: 'auth.status', relayUrl: 'http://127.0.0.1:3005', localServerUrl: 'http://10.0.0.5:3005' },
      { label: 'auth.request', relayUrl: 'http://127.0.0.1:3005', localServerUrl: 'http://10.0.0.5:3005' },
      { label: 'auth.wait', relayUrl: 'http://127.0.0.1:3005', localServerUrl: 'http://10.0.0.5:3005' },
      { label: 'daemon.service.install', relayUrl: 'http://127.0.0.1:3005', localServerUrl: 'http://10.0.0.5:3005' },
      { label: 'daemon.service.start', relayUrl: 'http://127.0.0.1:3005', localServerUrl: 'http://10.0.0.5:3005' },
    ]);
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
          return { ok: true, data: { paired: true, machineId: 'machine-remote-relay-1' } };
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
        machineId: 'machine-remote-relay-1',
        relayRuntime: {
          relayUrl: 'http://10.0.0.5:3005',
          mode: 'system',
        },
      },
    });
    expect(invocations.map((entry) => entry.label)).toContain('relay.runtime.install');
  });

  it('keeps the remote CLI/daemon on the original relay target while using the installed relay runtime as the local server URL', async () => {
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
          return { ok: true, data: { paired: true, machineId: 'machine-runtime-port-1' } };
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
      { label: 'daemon.service.list', relayUrl: 'https://relay.example.test' },
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

  it('approves remote pairing against the relay runtime local URL while preserving the public relay URL for canonical targeting', async () => {
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
          return { ok: true, data: { paired: true, machineId: 'machine-runtime-port-1' } };
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
        relayUrl: 'https://relay-runtime.example.test',
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
          return { ok: true, data: { paired: true, machineId: 'machine-runtime-port-1' } };
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
        machineId: 'machine-runtime-port-1',
        relayRuntime: {
          relayUrl: 'http://127.0.0.1:4449',
          mode: 'user',
        },
      },
    });

    expect(invocations).toEqual([
      { label: 'relay.runtime.install', relayUrl: 'https://public.example.test' },
      { label: 'daemon.service.list', relayUrl: 'https://public.example.test' },
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
      'daemon.service.list',
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
