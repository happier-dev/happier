import { describe, expect, it } from 'vitest';
import { createActionExecutor, type ActionExecutorDeps } from './actionExecutor.js';

const person = { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' }, serverId: 'home' } as const;

describe('host-local Action capabilities', () => {
  it('constructs a capture-only host and invokes Copy through ordinary Action admission', async () => {
    const calls: unknown[] = [];
    // This assignment is also the compile contract: a host supplies only its actual capabilities.
    const capabilities: ActionExecutorDeps = { screenCaptureAction: async request => {
      calls.push({ actionId: request.actionId, input: request.input });
      return { captureRef: 'capture', status: 'copied' };
    } };
    const executor = createActionExecutor(capabilities);
    expect(await executor.execute('screenCapture.copy', { captureRef: 'capture' }, person))
      .toEqual({ ok: true, result: { captureRef: 'capture', status: 'copied' } });
    expect(calls).toEqual([{ actionId: 'screenCapture.copy', input: { captureRef: 'capture' } }]);
    expect(await executor.execute('screenCapture.copy', { captureRef: 'capture', marks: [] }, person))
      .toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
    const cancellation = new AbortController(); cancellation.abort();
    expect(await executor.execute('screenCapture.copy', { captureRef: 'capture' }, { ...person, signal: cancellation.signal }))
      .toMatchObject({ ok: false, errorCode: 'cancelled' });
    expect(calls).toHaveLength(1);
  });

  it.each([
    ['machines.list', {}], ['servers.list', {}], ['paths.list_recent', {}],
    ['agents.backends.list', {}], ['agents.models.list', { agentId: 'claude' }],
    ['review.engines.list', { sessionId: 'session' }], ['session.list', {}],
    ['session.activity.get', { sessionId: 'session' }],
  ] as const)('refuses absent host capability for %s with the canonical unsupported result', async (actionId, input) => {
    expect(await createActionExecutor({}).execute(actionId, input, person))
      .toMatchObject({ ok: false, errorCode: 'unsupported_action' });
  });

  it.each([
    'execution.backends.enabled', 'review.engines.available', 'session.modes.available',
    'agents.models.available', 'sessions.spawn.paths.recent',
    'sessions.spawn.machines.available', 'sessions.spawn.servers.available',
  ])('refuses absent inventory for %s on a capture-only host without reporting empty choices', async optionsSourceId => {
    const executor = createActionExecutor({ screenCaptureAction: async () => ({ captureRef: 'capture', status: 'copied' }) });
    expect(await executor.execute('action.options.resolve', {
      optionsSourceId, draftInput: { sessionId: 'session', agentId: 'claude' },
    }, person)).toMatchObject({ ok: false, errorCode: 'unsupported_action' });
  });
});
