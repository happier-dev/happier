import { describe, expect, it } from 'vitest';
import { createActionExecutor, type ActionExecutorDeps } from './actionExecutor.js';

const person = { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' }, serverId: 'home' } as const;

describe('host-local Action capabilities', () => {
  it.each([
    ['machines.list', {}], ['servers.list', {}], ['paths.list_recent', {}],
    ['agents.backends.list', {}], ['agents.models.list', { agentId: 'claude' }],
    ['review.engines.list', { sessionId: 'session' }], ['session.list', {}],
    ['session.activity.get', { sessionId: 'session' }],
  ] as const)('refuses absent host capability for %s with the canonical unsupported result', async (actionId, input) => {
    expect(await createActionExecutor({}).execute(actionId, input, person))
      .toMatchObject({ ok: false, errorCode: 'unsupported_action' });
  });

});
