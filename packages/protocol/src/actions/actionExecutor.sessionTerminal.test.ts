import { describe, expect, it } from 'vitest';
import { ActionIdSchema } from './actionIds.js';
import { createActionExecutor, type ActionExecutorDeps } from './actionExecutor.js';
import { getActionSpec } from './actionSpecs.js';

describe('session terminal Action contract', () => {
  it('opens a client view through the mounted client boundary and preserves its typed refusal', async () => {
    const id = ActionIdSchema.parse('session.terminals.open');
    const executor = createActionExecutor({ sessionTerminalAction: async () => ({
      ok: false, errorCode: 'terminal_target_unavailable', error: 'terminal_target_unavailable',
    }) } as unknown as ActionExecutorDeps);
    expect(await executor.execute(id, { scopeId: 'home:session', target: { kind: 'workspace_shell' } }, { surface: 'ui', authority: 'present_user' }))
      .toMatchObject({ ok: false, errorCode: 'terminal_target_unavailable' });
    expect(getActionSpec(id).executionPlacement).toBe('client');
    const headless = createActionExecutor({} as ActionExecutorDeps);
    expect(await headless.execute('session.terminals.list', { scopeId: 'home:session' }, { surface: 'agent' }))
      .toMatchObject({ ok: false, errorCode: 'unsupported_action' });
    expect(await executor.execute('session.terminals.list', { scopeId: 'home:session' }, { surface: 'cli' }))
      .toMatchObject({ ok: false, errorCode: 'action_disabled', details: { reason: 'unsupported_surface', surface: 'cli' } });
  });
});
