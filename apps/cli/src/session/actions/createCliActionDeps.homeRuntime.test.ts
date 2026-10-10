import { describe, expect, it } from 'vitest';
import { ActionIdSchema, createActionExecutor } from '@happier-dev/protocol';
import { markRpcRequestDisposition } from '@happier-dev/sync-client';
import { createCliActionDeps } from './createCliActionDeps';

const terminal = { protocolVersion: 1, taskId: 'restart-task', ok: true, data: { healthy: true } } as const;

function createRestartExecutor(options: Readonly<{ waitResult?: unknown; waitError?: unknown; startError?: unknown; methods?: readonly string[] }> = {}) {
  const calls: Array<{ method: string; request: unknown; signal?: AbortSignal }> = [];
  const executor = createActionExecutor(createCliActionDeps({
    token: 'bound', sessionId: '', serverId: 'home', serverHttpBaseUrl: 'https://home.test', mode: 'plain', ctx: null,
    machineActionDirectTargetTransport: {
      machineId: 'machine',
      invoke: async (method, request, invocation) => {
        calls.push({ method, request, signal: invocation?.signal });
        if (method === 'capabilities.detect') return { protocolVersion: 1, results: {
          'tool.systemTasks': { ok: true, checkedAt: 1, data: { available: true,
            kinds: ['relay.runtime.restart.v1'], methods: options.methods ?? ['start', 'wait'] } },
        } };
        if (request && typeof request === 'object' && 'method' in request && request.method === 'start') {
          if (options.startError) throw options.startError;
          return { protocolVersion: 1, ok: true, result: { taskId: terminal.taskId } };
        }
        if (options.waitError) throw options.waitError;
        return { protocolVersion: 1, ok: true, result: options.waitResult ?? terminal };
      },
    },
  }));
  return { executor, calls };
}

describe('CLI connected Machine Home restart Action', () => {
  it('waits for the exact admitted task and retains its terminal result', async () => {
    const { executor, calls } = createRestartExecutor();
    const signal = new AbortController().signal;
    expect(await executor.execute(ActionIdSchema.parse('home.runtime.restart'), {
      machineId: 'machine', channel: 'preview', mode: 'system',
    }, { surface: 'cli', authority: 'present_user', serverId: 'home', signal,
      presentUserConfirmation: { actionId: 'home.runtime.restart' },
    })).toEqual({ ok: true, result: { status: 'completed', taskId: terminal.taskId, result: terminal } });
    expect(calls).toEqual([
      { method: 'capabilities.detect', request: { requests: [{ id: 'tool.systemTasks' }] }, signal },
      { method: 'capabilities.invoke', request: { id: 'tool.systemTasks', method: 'start', params: {
        spec: { protocolVersion: 1, kind: 'relay.runtime.restart.v1', params: {
          target: { kind: 'local' }, channel: 'preview', mode: 'system',
        } },
      } }, signal },
      { method: 'capabilities.invoke', request: { id: 'tool.systemTasks', method: 'wait', params: { taskId: terminal.taskId } }, signal },
    ]);
  });

  it('retains the admitted identity when the completion answer is lost or belongs to another task', async () => {
    for (const options of [{ waitError: new Error('Home disconnected') }, { waitResult: { ...terminal, taskId: 'other' } }]) {
      const { executor } = createRestartExecutor(options);
      expect(await executor.execute(ActionIdSchema.parse('home.runtime.restart'), { machineId: 'machine', channel: 'stable' }, {
        surface: 'cli', authority: 'present_user', serverId: 'home',
        presentUserConfirmation: { actionId: 'home.runtime.restart' },
      })).toEqual({ ok: true, result: { status: 'outcome_unknown', taskId: terminal.taskId } });
    }
  });

  it('does not admit an unobservable restart and distinguishes proven non-dispatch from an unknown start', async () => {
    for (const [options, expected] of [
      [{ methods: ['start'] }, { ok: true, result: { status: 'unavailable', reason: 'system_tasks_unavailable' } }],
      [{ startError: markRpcRequestDisposition(new Error('Not dispatched'), 'notSent') }, { ok: false, errorCode: 'request_not_sent' }],
      [{ startError: markRpcRequestDisposition(new Error('ACK lost'), 'outcomeUnknown') }, { ok: true, result: { status: 'outcome_unknown' } }],
    ] as const) {
      const { executor, calls } = createRestartExecutor(options);
      expect(await executor.execute(ActionIdSchema.parse('home.runtime.restart'), { machineId: 'machine' }, {
        surface: 'cli', authority: 'present_user', serverId: 'home',
        presentUserConfirmation: { actionId: 'home.runtime.restart' },
      })).toMatchObject(expected);
      expect(calls.some(call => call.request && typeof call.request === 'object' && 'method' in call.request
        && call.request.method === 'wait')).toBe(false);
    }
  });
});
