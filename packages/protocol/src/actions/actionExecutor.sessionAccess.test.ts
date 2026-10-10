import { describe, expect, it, vi } from 'vitest';

import { createActionExecutor, type ActionExecutorDeps } from './actionExecutor.js';
import { bindSessionAccessActionHttpRequestV1 } from './sessionAccessActionFamily.js';
import { SetSessionAccessGrantRequestV1Schema } from '../sessions/access/sessionAccessOperationsV1.js';

const grant = {
  subject: { kind: 'account', accountId: 'recipient' },
  accessLevel: 'edit',
  canApprovePermissions: false,
} as const;

describe('createActionExecutor (Session access)', () => {
  it('routes a validated Session-access intent to the one family dependency', async () => {
    const controller = new AbortController();
    const sessionAccessAction = vi.fn(async () => ({ changed: true, grant }));
    const executor = createActionExecutor({
      sessionAccessAction,
      isActionApprovalRequired: () => false,
    } as unknown as ActionExecutorDeps);

    await expect(executor.execute('session.access.grant.set', { sessionId: 'session-1', ...grant }, {
      surface: 'ui',
      authority: 'present_user',
      actionCaller: { kind: 'host' },
      signal: controller.signal,
    })).resolves.toEqual({ ok: true, result: { changed: true, grant } });

    expect(sessionAccessAction).toHaveBeenCalledWith(expect.objectContaining({
      actionId: 'session.access.grant.set',
      input: { sessionId: 'session-1', ...grant },
      signal: controller.signal,
    }));
  });

  it('rejects an input the strict domain schema refuses before reaching the host', async () => {
    const sessionAccessAction = vi.fn(async () => ({ changed: true, grant }));
    const executor = createActionExecutor({
      sessionAccessAction,
      isActionApprovalRequired: () => false,
    } as unknown as ActionExecutorDeps);

    const result = await executor.execute('session.access.grant.set', {
      sessionId: 'session-1',
      ...grant,
      accessLevel: 'omnipotent',
    }, { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' } });

    expect(result.ok).toBe(false);
    expect(sessionAccessAction).not.toHaveBeenCalled();
  });

  it('reports a host without the family as unsupported rather than silently succeeding', async () => {
    const executor = createActionExecutor({
      isActionApprovalRequired: () => false,
    } as unknown as ActionExecutorDeps);

    await expect(executor.execute('session.access.grants.list', { sessionId: 'session-1' }, {
      surface: 'ui',
      authority: 'present_user',
      actionCaller: { kind: 'host' },
    })).resolves.toEqual({
      ok: false,
      errorCode: 'unsupported_action',
      error: 'unsupported_action:session.access.grants.list',
    });
  });

  /**
   * The binder is the only place an Action input becomes a request, so a caller
   * cannot reach a Session-access route without going through the declared row.
   */
  it('binds each intent to the transport its row declared', () => {
    expect(bindSessionAccessActionHttpRequestV1('session.access.grants.list', { sessionId: 'session-1' }))
      .toEqual({ method: 'POST', path: '/v2/sessions/access-grants/list', body: { sessionId: 'session-1' } });
    expect(bindSessionAccessActionHttpRequestV1('session.access.grant.set', { sessionId: 'session-1', ...grant }))
      .toEqual({
        method: 'POST',
        path: '/v2/sessions/access-grants/set',
        body: { sessionId: 'session-1', ...grant },
      });
  });

  it('refuses to bind an input the declared row rejects', () => {
    expect(() => bindSessionAccessActionHttpRequestV1('session.access.grants.list', { sessionId: '' }))
      .toThrow();
  });

  it('preserves the strict credential condition and the domain grant constraints', () => {
    const input = {
      sessionId: 'session-1', subject: { kind: 'team', teamId: 'team-1' },
      accessLevel: 'edit', canApprovePermissions: false,
      requiredTeamCredential: { resourceId: 'resource-1', expectedResourceRevision: 7, deliveryMode: 'brokered' },
    };
    const request = bindSessionAccessActionHttpRequestV1('session.access.grant.set', input);
    expect(SetSessionAccessGrantRequestV1Schema.parse(request.body)).toEqual(input);
    for (const patch of [
      { accessLevel: 'view', canApprovePermissions: true },
      { requiredTeamCredential: { ...input.requiredTeamCredential, expectedResourceRevision: -1 } },
      { requiredTeamCredential: { ...input.requiredTeamCredential, unchecked: true } },
    ]) {
      expect(() => bindSessionAccessActionHttpRequestV1('session.access.grant.set', { ...input, ...patch })).toThrow();
      expect(SetSessionAccessGrantRequestV1Schema.safeParse({ ...input, ...patch }).success).toBe(false);
    }
  });
});
