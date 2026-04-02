import { describe, expect, it, vi } from 'vitest';
import { readFile, stat } from 'node:fs/promises';

import { createSystemTasksRunner } from '../interactiveTaskKinds.js';
import { createRemoteSshManageHostTaskKind } from './remoteSshManageHostKind.js';

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

describe('createRemoteSshManageHostTaskKind', () => {
  it('fails closed when SSH host trust is declined', async () => {
    const trustAccept = vi.fn(async () => {});
    const kind = createRemoteSshManageHostTaskKind({
      resolveHostTrust: async () => ({
        status: 'prompt',
        promptKind: 'ssh.trustHost',
        promptMessage: 'Trust host?',
        promptData: {
          host: 'example.test',
          keyType: 'ssh-ed25519',
          fingerprint: 'SHA256:abc',
        },
        accept: trustAccept,
      }),
      testConnection: async () => {
        throw new Error('should not reach connection test when declined');
      },
      installRemoteCli: async () => {
        throw new Error('should not install cli when declined');
      },
      runDaemonServiceCommand: async () => {
        throw new Error('should not run daemon command when declined');
      },
      runRelayRuntimeCommand: async () => {
        throw new Error('should not run relay runtime command when declined');
      },
    });

    const runner = createSystemTasksRunner({
      kinds: { 'remote.ssh.manageHost.v1': kind },
    });

    await runner.start({
      taskId: 'trust-decline',
      kind: 'remote.ssh.manageHost.v1',
      params: {
        action: 'testConnection',
        ssh: {
          target: 'dev@example.test',
          auth: 'agent',
        },
      },
    });

    const firstPoll = await waitForPendingPrompt(runner, { taskId: 'trust-decline', cursor: 0 });
    expect(firstPoll.pendingPrompt).toEqual({
      kind: 'ssh.trustHost',
      data: {
        host: 'example.test',
        keyType: 'ssh-ed25519',
        fingerprint: 'SHA256:abc',
      },
    });

    await runner.respond({
      taskId: 'trust-decline',
      answer: { trusted: false },
    });

    const finalPoll = await waitForResult(runner, { taskId: 'trust-decline', cursor: firstPoll.nextCursor });
    expect(finalPoll.result).toEqual({
      protocolVersion: 1,
      taskId: 'trust-decline',
      ok: false,
      error: {
        code: 'host_trust_declined',
        message: 'SSH host trust was declined.',
      },
    });
    expect(trustAccept).not.toHaveBeenCalled();
  });

  it('prompts for an SSH password when missing and passes it to the install step', async () => {
    const installRemoteCli = vi.fn(async () => {});
    const kind = createRemoteSshManageHostTaskKind({
      resolveHostTrust: async () => ({ status: 'trusted' }),
      testConnection: async () => {
        throw new Error('should not call testConnection during installOrUpdateCli');
      },
      installRemoteCli,
      runDaemonServiceCommand: async () => {
        throw new Error('should not call daemon commands during installOrUpdateCli');
      },
      runRelayRuntimeCommand: async () => {
        throw new Error('should not call relay runtime commands during installOrUpdateCli');
      },
    });

    const runner = createSystemTasksRunner({
      kinds: { 'remote.ssh.manageHost.v1': kind },
    });

    await runner.start({
      taskId: 'password-prompt',
      kind: 'remote.ssh.manageHost.v1',
      params: {
        action: 'installOrUpdateCli',
        ssh: {
          target: 'dev@example.test',
          auth: 'password',
        },
      },
    });

    const firstPoll = await waitForPendingPrompt(runner, { taskId: 'password-prompt', cursor: 0 });
    expect(firstPoll.pendingPrompt).toEqual({
      kind: 'ssh.password',
      data: {
        target: 'dev@example.test',
      },
    });

    await runner.respond({
      taskId: 'password-prompt',
      answer: { password: 'secret-password' },
    });

    const finalPoll = await waitForResult(runner, { taskId: 'password-prompt', cursor: firstPoll.nextCursor });
    expect(finalPoll.result?.ok).toBe(true);
    expect(installRemoteCli).toHaveBeenCalledWith(expect.objectContaining({
      ssh: expect.objectContaining({
        target: 'dev@example.test',
      }),
      auth: {
        mode: 'password',
        password: 'secret-password',
      },
    }));
  });

  it('accepts publicdev as an alias for the dev channel label', async () => {
    const installRemoteCli = vi.fn(async () => {});
    const kind = createRemoteSshManageHostTaskKind({
      resolveHostTrust: async () => ({ status: 'trusted' }),
      testConnection: async () => {
        throw new Error('should not call testConnection during installOrUpdateCli');
      },
      installRemoteCli,
      runDaemonServiceCommand: async () => {
        throw new Error('should not call daemon commands during installOrUpdateCli');
      },
      runRelayRuntimeCommand: async () => {
        throw new Error('should not call relay runtime commands during installOrUpdateCli');
      },
    });

    const runner = createSystemTasksRunner({
      kinds: { 'remote.ssh.manageHost.v1': kind },
    });

    await runner.start({
      taskId: 'channel-alias',
      kind: 'remote.ssh.manageHost.v1',
      params: {
        action: 'installOrUpdateCli',
        channel: 'publicdev',
        ssh: {
          target: 'dev@example.test',
          auth: 'agent',
        },
      },
    });

    const finalPoll = await waitForResult(runner, { taskId: 'channel-alias', cursor: 0 });
    expect(finalPoll.result?.ok).toBe(true);
    expect(installRemoteCli).toHaveBeenCalledWith(expect.objectContaining({
      channel: 'dev',
    }));
  });

  it('runs relay runtime status after resolving host trust', async () => {
    const runRelayRuntimeCommand = vi.fn(async () => ({ installed: false }));
    const kind = createRemoteSshManageHostTaskKind({
      resolveHostTrust: async () => ({ status: 'trusted' }),
      testConnection: async () => {
        throw new Error('should not call testConnection during relayRuntime.status');
      },
      installRemoteCli: async () => {
        throw new Error('should not call installRemoteCli during relayRuntime.status');
      },
      runDaemonServiceCommand: async () => {
        throw new Error('should not call daemon commands during relayRuntime.status');
      },
      runRelayRuntimeCommand,
    });

    const runner = createSystemTasksRunner({
      kinds: { 'remote.ssh.manageHost.v1': kind },
    });

    await runner.start({
      taskId: 'relay-status',
      kind: 'remote.ssh.manageHost.v1',
      params: {
        action: 'relayRuntime.status',
        ssh: {
          target: 'dev@example.test',
          auth: 'agent',
        },
      },
    });

    const finalPoll = await waitForResult(runner, { taskId: 'relay-status', cursor: 0 });
    expect(finalPoll.result?.ok).toBe(true);
    expect(runRelayRuntimeCommand).toHaveBeenCalledWith(expect.objectContaining({
      action: 'status',
      ssh: expect.objectContaining({ target: 'dev@example.test' }),
    }));
  });

  it('threads the requested channel into CLI and daemon-service actions', async () => {
    const installRemoteCli = vi.fn(async () => {});
    const runDaemonServiceCommand = vi.fn(async () => {});

    const kind = createRemoteSshManageHostTaskKind({
      resolveHostTrust: async () => ({ status: 'trusted' }),
      testConnection: async () => {
        throw new Error('should not call testConnection during daemonService.restart');
      },
      installRemoteCli,
      runDaemonServiceCommand,
      runRelayRuntimeCommand: async () => {
        throw new Error('should not call relay runtime commands during daemonService.restart');
      },
    });

    const runner = createSystemTasksRunner({
      kinds: { 'remote.ssh.manageHost.v1': kind },
    });

    await runner.start({
      taskId: 'daemon-channel',
      kind: 'remote.ssh.manageHost.v1',
      params: {
        action: 'daemonService.restart',
        channel: 'dev',
        ssh: {
          target: 'dev@example.test',
          auth: 'agent',
        },
      },
    });

    const finalPoll = await waitForResult(runner, { taskId: 'daemon-channel', cursor: 0 });
    expect(finalPoll.result?.ok).toBe(true);
    expect(installRemoteCli).toHaveBeenCalledWith(expect.objectContaining({
      channel: 'dev',
    }));
    expect(runDaemonServiceCommand).toHaveBeenCalledWith(expect.objectContaining({
      channel: 'dev',
      action: 'restart',
    }));
  });

  it('accepts ssh.identityPrivateKey for keyfile auth by materializing a temp identity file for the run', async () => {
    let observedIdentityPath: string | null = null;
    const privateKeyMaterial = '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n';

    const kind = createRemoteSshManageHostTaskKind({
      resolveHostTrust: async () => ({ status: 'trusted' }),
      testConnection: async ({ auth }) => {
        if (auth.mode !== 'keyFile') {
          throw new Error('expected keyFile auth');
        }
        observedIdentityPath = auth.privateKeyPath;
        const contents = await readFile(auth.privateKeyPath, 'utf8');
        expect(contents).toContain('abc');
      },
      installRemoteCli: async () => {
        throw new Error('should not install cli during testConnection');
      },
      runDaemonServiceCommand: async () => {
        throw new Error('should not run daemon commands during testConnection');
      },
      runRelayRuntimeCommand: async () => {
        throw new Error('should not run relay runtime commands during testConnection');
      },
    });

    const runner = createSystemTasksRunner({
      kinds: { 'remote.ssh.manageHost.v1': kind },
    });

    await runner.start({
      taskId: 'key-material',
      kind: 'remote.ssh.manageHost.v1',
      params: {
        action: 'testConnection',
        ssh: {
          target: 'dev@example.test',
          auth: 'keyfile',
          identityPrivateKey: privateKeyMaterial,
        },
      },
    });

    const finalPoll = await waitForResult(runner, { taskId: 'key-material', cursor: 0 });
    expect(finalPoll.result?.ok).toBe(true);
    expect(typeof observedIdentityPath).toBe('string');

    // Cleanup should remove the temp identity file after the run completes.
    if (observedIdentityPath) {
      await expect(stat(observedIdentityPath)).rejects.toBeTruthy();
    }
  });
});
