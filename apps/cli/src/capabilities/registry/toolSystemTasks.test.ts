import {
  SSH_TUNNEL_SYSTEM_TASK_KINDS,
  SYSTEM_TASK_PROTOCOL_VERSION,
} from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';
import { SystemTaskResultSchema } from '@happier-dev/protocol/system/tasks/spec';

import {
  createProtocolSystemTasksRunnerAdapter,
  createSystemTasksCapability,
} from './toolSystemTasks';
import { createDaemonSshTunnelEnsureTaskKind } from '../systemTasks/ssh/daemonSshTunnelSystemTasks';
import { createSystemTasksRunner } from '../systemTasks/systemTasksRunner';

async function waitForResult(
  capability: ReturnType<typeof createSystemTasksCapability>,
  taskId: string,
): Promise<unknown> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const polled = await capability.invoke?.({
      method: 'poll',
      params: { taskId, cursor: 0 },
    });
    if (polled?.ok === true) {
      const result = (polled.result as { result?: unknown }).result;
      if (result) return result;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`Timed out waiting for system task result: ${taskId}`);
}

describe('systemTasksCapability', () => {
  it('waits for the same admitted task to settle and preserves terminal failure', async () => {
    let failRestart!: () => void;
    const restart = new Promise<void>((resolve) => { failRestart = resolve; });
    const runner = createSystemTasksRunner({ kinds: {
      'relay.runtime.restart.v1': { async run() { await restart; throw new Error('Runtime could not start'); } },
    } });
    const capability = createSystemTasksCapability(createProtocolSystemTasksRunnerAdapter(runner, { createTaskId: () => 'restart-task' }));
    await capability.invoke?.({ method: 'start', params: { spec: { protocolVersion: 1, kind: 'relay.runtime.restart.v1', params: {} } } });
    let settled = false;
    const waiting = capability.invoke?.({ method: 'wait', params: { taskId: 'restart-task' } }).then((result) => { settled = true; return result; });
    await Promise.resolve();
    expect(settled).toBe(false);
    failRestart();
    const waited = await waiting;
    expect(waited?.ok).toBe(true);
    if (!waited?.ok) throw new Error('Task completion was not returned');
    expect(SystemTaskResultSchema.parse(waited.result)).toEqual({ protocolVersion: 1, taskId: 'restart-task', ok: false,
      error: { code: 'system_task_failed', message: 'Runtime could not start' } });
  });

  it('advertises the remote cli.update.v1 only where this machine can update its CLI remotely (K5)', async () => {
    const detect = async (canUpdate: boolean) => await createSystemTasksCapability(undefined, () => canUpdate).detect({
      request: { id: 'tool.systemTasks' },
      context: { cliSnapshot: null },
    }) as { kinds: string[] };
    expect((await detect(true)).kinds).toContain('cli.update.v1');
    expect((await detect(false)).kinds).not.toContain('cli.update.v1');
  });

  it('detects the supported methods and kinds', async () => {
    // The remote CLI update kind depends on this host's CLI install; its own test covers it.
    await expect(createSystemTasksCapability(undefined, () => false).detect({
      request: { id: 'tool.systemTasks' },
      context: { cliSnapshot: null },
    })).resolves.toEqual({
      available: true,
      kinds: [
        'local.ssh.discoverConfiguredHosts.v1',
        SSH_TUNNEL_SYSTEM_TASK_KINDS.ensure,
        SSH_TUNNEL_SYSTEM_TASK_KINDS.list,
        SSH_TUNNEL_SYSTEM_TASK_KINDS.release,
        SSH_TUNNEL_SYSTEM_TASK_KINDS.stop,
        'remote.ssh.bootstrapMachine.v1',
        'relay.runtime.installOrUpdate.v1',
        'relay.runtime.start.v1',
        'relay.runtime.restart.v1',
        'relay.runtime.status.v1',
        'relay.runtime.stop.v1',
        'relay.runtime.uninstall.v1',
        'relay.runtime.personal_home.inspect.v1',
        'relay.runtime.personal_home.backup.v1',
        'relay.runtime.personal_home.verify_backup.v1',
        'relay.runtime.personal_home.restore.v1',
        'relay.runtime.personal_home.erase.v1',
        'relay.runtime.personal_home.relocation_destination.stage.v1',
        'relay.runtime.personal_home.relocation_destination.status.v1',
        'relay.runtime.personal_home.relocation_destination.commit.v1',
        'relay.runtime.personal_home.relocation_destination.abort.v1',
      ],
      methods: ['start', 'poll', 'respond', 'wait'],
      taskGroups: [
        {
          id: 'ssh-tunnel-supervisor',
          title: 'SSH tunnel supervisor',
          owner: 'local-daemon',
          surface: 'host-internal-system-task',
          kinds: [
            SSH_TUNNEL_SYSTEM_TASK_KINDS.ensure,
            SSH_TUNNEL_SYSTEM_TASK_KINDS.list,
            SSH_TUNNEL_SYSTEM_TASK_KINDS.release,
            SSH_TUNNEL_SYSTEM_TASK_KINDS.stop,
          ],
        },
      ],
    });
  });

  it('starts an SSH tunnel through the capability protocol adapter and daemon task kind seam', async () => {
    const ensureDaemonSshTunnel = vi.fn(async () => ({
      ok: true as const,
      lease: {
        leaseId: 'lease-1',
        tunnelKey: 'ssh-tunnel:host-a',
        httpBaseUrl: 'http://127.0.0.1:49152',
        localPort: 49152,
        remoteHost: '127.0.0.1',
        remotePort: 3005,
        expiresAt: null,
        status: 'available' as const,
      },
    }));
    const runner = createSystemTasksRunner({
      kinds: {
        [SSH_TUNNEL_SYSTEM_TASK_KINDS.ensure]: createDaemonSshTunnelEnsureTaskKind({ ensureDaemonSshTunnel }),
      },
    });
    const capability = createSystemTasksCapability(createProtocolSystemTasksRunnerAdapter(runner, {
      createTaskId: () => 'task-ssh-tunnel-ensure',
    }));

    await expect(capability.invoke?.({
      method: 'start',
      params: {
        spec: {
          protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
          kind: SSH_TUNNEL_SYSTEM_TASK_KINDS.ensure,
          params: {
            remoteHostId: 'host-a',
            ssh: { target: 'dev@example.test', auth: 'agent' },
            remoteHost: '127.0.0.1',
            remotePort: 3005,
            purpose: 'remote-host-access',
          },
        },
      },
    })).resolves.toEqual({
      ok: true,
      result: { taskId: 'task-ssh-tunnel-ensure' },
    });

    await expect(waitForResult(capability, 'task-ssh-tunnel-ensure')).resolves.toEqual(expect.objectContaining({
      ok: true,
      data: expect.objectContaining({
        ok: true,
        lease: expect.objectContaining({
          tunnelKey: 'ssh-tunnel:host-a',
        }),
      }),
    }));
    expect(ensureDaemonSshTunnel).toHaveBeenCalledWith(expect.objectContaining({
      remoteHostId: 'host-a',
      remoteHost: '127.0.0.1',
      remotePort: 3005,
      purpose: 'remote-host-access',
    }));
  });

  it('delegates start, poll, and respond through the stateful runner', async () => {
    const calls: Array<Readonly<{ method: string; params: Record<string, unknown> }>> = [];
    const capability = createSystemTasksCapability({
      wait: async () => ({ protocolVersion: 1, taskId: 'task-1', ok: true }),
      start: async (params) => {
        calls.push({ method: 'start', params: params as Record<string, unknown> });
        return { taskId: 'task-1' };
      },
      poll: async (params) => {
        calls.push({ method: 'poll', params: params as Record<string, unknown> });
        return {
          events: [],
          nextCursor: 0,
          pendingPrompt: null,
          result: null,
        };
      },
      respond: async (params) => {
        calls.push({ method: 'respond', params: params as Record<string, unknown> });
      },
    });

    await expect(capability.invoke?.({
      method: 'start',
      params: {
        spec: {
          protocolVersion: 1,
          kind: 'relay.runtime.status.v1',
          params: {},
        },
      },
    })).resolves.toEqual({
      ok: true,
      result: { taskId: 'task-1' },
    });

    await expect(capability.invoke?.({
      method: 'poll',
      params: {
        taskId: 'task-1',
        cursor: 0,
      },
    })).resolves.toEqual({
      ok: true,
      result: {
        events: [],
        nextCursor: 0,
        pendingPrompt: null,
        result: null,
      },
    });

    await expect(capability.invoke?.({
      method: 'respond',
      params: {
        taskId: 'task-1',
        answer: { approved: true },
      },
    })).resolves.toEqual({
      ok: true,
      result: { ok: true },
    });

    expect(calls).toEqual([
      {
        method: 'start',
        params: {
          spec: {
            protocolVersion: 1,
            kind: 'relay.runtime.status.v1',
            params: {},
          },
        },
      },
      {
        method: 'poll',
        params: {
          taskId: 'task-1',
          cursor: 0,
        },
      },
      {
        method: 'respond',
        params: {
          taskId: 'task-1',
          answer: { approved: true },
        },
      },
    ]);
  });
});
