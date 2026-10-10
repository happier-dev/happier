import { describe, expect, it, vi } from 'vitest';

import { createActionExecutor, type ActionExecutorDeps } from './actionExecutor.js';
import { getActionSpec, isPluginSurfaceExcludedActionId } from './actionSpecs.js';
import {
  SESSION_ATTENTION_STANDING_HTTP_PATH_V1,
  SessionAttentionSetInputV1Schema,
  buildSessionAttentionStandingHttpPath,
} from '../sessions/organization/attentionAction.js';

describe('session.attention.set (ORC R-10)', () => {
  it('names the existing attention-standing route as its one server transport', () => {
    const spec = getActionSpec('session.attention.set');

    expect(spec.serverTransport).toEqual({
      method: 'PUT',
      path: '/v2/session-organization/attention-standings/:sessionId',
    });
    expect(SESSION_ATTENTION_STANDING_HTTP_PATH_V1).toBe(spec.serverTransport?.path);
    expect(buildSessionAttentionStandingHttpPath('session/1')).toBe(
      '/v2/session-organization/attention-standings/session%2F1',
    );
    expect(spec.inputSchema).toBe(SessionAttentionSetInputV1Schema);
    expect(spec.requiredAuthority).toBe('account_automation');
    expect(spec.surfaces).toMatchObject({ ui: true, cli: true, voice: true, agent: true, mcp: false, plugin: true, api: true });
    expect(isPluginSurfaceExcludedActionId(spec.id)).toBe(false);
  });

  it('writes Settle as standing:false and snooze as remindAt through one port, with the exact Home', async () => {
    // The port is the HTTP boundary to the standing route; the executor's admission is real.
    const sessionAttentionSet = vi.fn(async (args: { request: Record<string, unknown> }) => ({
      standing: 'standing' in args.request
        ? { sessionId: 'session-1', standing: args.request.standing, updatedAt: 10 }
        : { sessionId: 'session-1', standing: false, remindAt: args.request.remindAt, updatedAt: 11 },
    }));
    const executor = createActionExecutor({
      isActionApprovalRequired: () => false,
      sessionAttentionSet,
      resolveServerIdForSessionId: () => 'home-1',
    } as unknown as ActionExecutorDeps);

    await expect(executor.execute('session.attention.set', { sessionId: 'session-1', standing: false }, {
      surface: 'ui',
      authority: 'present_user',
    })).resolves.toEqual({
      ok: true,
      result: { standing: { sessionId: 'session-1', standing: false, updatedAt: 10 } },
    });
    expect(sessionAttentionSet).toHaveBeenLastCalledWith(expect.objectContaining({
      sessionId: 'session-1',
      request: { standing: false },
      serverId: 'home-1',
    }));

    await expect(executor.execute('session.attention.set', { sessionId: 'session-1', remindAt: 5_000 }, {
      surface: 'ui',
      authority: 'present_user',
    })).resolves.toMatchObject({ ok: true, result: { standing: { remindAt: 5_000 } } });
    expect(sessionAttentionSet).toHaveBeenLastCalledWith(expect.objectContaining({ request: { remindAt: 5_000 } }));
  });

  it('refuses a body that changes both or neither field before the route is written', async () => {
    const sessionAttentionSet = vi.fn();
    const executor = createActionExecutor({
      isActionApprovalRequired: () => false,
      sessionAttentionSet,
    } as unknown as ActionExecutorDeps);

    for (const input of [
      { sessionId: 'session-1' },
      { sessionId: 'session-1', standing: false, remindAt: 5_000 },
    ]) {
      await expect(executor.execute('session.attention.set', input, { surface: 'ui', authority: 'present_user' }))
        .resolves.toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
    }
    expect(sessionAttentionSet).not.toHaveBeenCalled();
  });

  it('allows an Agent or automation to settle when the canonical approval policy permits it', async () => {
    const sessionAttentionSet = vi.fn(async () => ({
      standing: { sessionId: 'session-1', standing: false, updatedAt: 10 },
    }));
    const executor = createActionExecutor({
      isActionApprovalRequired: () => false,
      sessionAttentionSet,
    } as unknown as ActionExecutorDeps);

    await expect(executor.execute('session.attention.set', { sessionId: 'session-1', standing: false }, {
      surface: 'agent',
      authority: 'account_automation',
      actionCaller: { kind: 'host' },
      defaultSessionId: 'session-1',
    })).resolves.toMatchObject({ ok: true, result: { standing: { standing: false } } });
    await expect(executor.execute('session.attention.set', { sessionId: 'session-1', standing: false }, {
      surface: 'cli',
      authority: 'account_automation',
      actionCaller: { kind: 'host' },
    })).resolves.toMatchObject({ ok: true, result: { standing: { standing: false } } });
  });
});
