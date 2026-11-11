import { describe, expect, it } from 'vitest';

import { createActionExecutor, type ActionExecutorDeps } from './actionExecutor.js';
import { getActionSpec } from './actionSpecs.js';
import { AppShellActionOutputSchemas, readNoticeInboxAccountIdV1 } from './appShellActionFamily.js';
import { ExternalActionExecutionAuthorizationV1Schema } from './externalActionApi.js';
import { API_TOKEN_FULL_GRANT_V1 } from '../auth/apiTokenGrant.js';
import { ActionsSettingsV1Schema } from './actionSettings.js';
import { isApprovalRequiredByActionsSettings } from './actionApprovalPolicy.js';
import { ActionIdSchema } from './actionIds.js';

describe('app shell Actions', () => {
  it.each(['account_automation', 'present_user'] as const)(
    'admits the own-Account Voice host with %s authority while refusing foreign and external callers', authority => {
      const context = { surface: 'voice', authority, runtimeAccountId: 'owner', expectedAccountId: 'owner',
        actionCaller: { kind: 'host' } } as const;
      expect(readNoticeInboxAccountIdV1(context)).toBe('owner');
      expect(readNoticeInboxAccountIdV1(context, 'read')).toBe('owner');
      expect(readNoticeInboxAccountIdV1({ ...context, expectedAccountId: 'foreign' })).toBeNull();
      expect(readNoticeInboxAccountIdV1({ ...context, actionCaller: {
        kind: 'session', sessionId: 'worker', starterDepth: 0, turnDepth: 0,
      } })).toBeNull();
      expect(readNoticeInboxAccountIdV1({ ...context, externalActionCredential: {
        accountId: 'owner', principalId: 'api', credentialId: 'token', grant: API_TOKEN_FULL_GRANT_V1,
      } })).toBeNull();
    },
  );
  it('owns notice admission for native and signed own-Account agents while excluding foreign and external credentials', () => {
    const native = { surface: 'agent', authority: 'account_automation', runtimeAccountId: 'owner', expectedAccountId: 'owner',
      actionCaller: { kind: 'session', sessionId: 'worker', starterDepth: 0, turnDepth: 0 } } as const;
    const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'host-validated-proof', binding: {
      serverIdentityId: 'home', accountId: 'owner', authentication: { kind: 'account', tokenEpoch: 0 },
      machineId: 'machine', custodianAccountId: 'owner', installationId: 'installation', actionId: 'inbox.get',
      requestId: 'read-inbox', requestEnvelopeDigest: 'a'.repeat(43), target: { kind: 'machine', machineId: 'machine' },
    } });
    expect(readNoticeInboxAccountIdV1(native)).toBe('owner');
    const signed = { ...native, externalActionExecutionAuthorization: authorization };
    expect(readNoticeInboxAccountIdV1(signed)).toBe('owner');
    expect(readNoticeInboxAccountIdV1({ ...signed, externalActionExecutionAuthorization: { ...authorization,
      binding: { ...authorization.binding, accountId: 'foreign' } } })).toBeNull();
    expect(readNoticeInboxAccountIdV1({ ...signed, externalActionExecutionAuthorization: { ...authorization,
      binding: { ...authorization.binding, custodianAccountId: 'foreign' } } })).toBeNull();
    expect(readNoticeInboxAccountIdV1({ ...native, runtimeAccountId: 'foreign' })).toBeNull();
    expect(readNoticeInboxAccountIdV1({ ...native, externalActionCredential: {
      accountId: 'owner', principalId: 'api', credentialId: 'token', grant: API_TOKEN_FULL_GRANT_V1,
    } })).toBeNull();
  });
  it('accepts canonical Inbox Automation and approval pointers but rejects private approval bodies', () => {
    const snapshot = { status: 'ready', groups: [{ key: 'automation:weekly',
      root: { kind: 'automation', automationId: 'weekly', serverId: 'home-a', runId: 'run-a' },
      items: [{ kind: 'automation_run', key: 'automation-run:run-a', runId: 'run-a' },
        { kind: 'approval', key: 'approval:approval-a', artifactId: 'approval-a' }] }],
      approvalIds: ['approval-a'], automationRunIds: ['run-a'], usageNoticeIds: [], friendRequestIds: [],
      readySessions: [], actionOperations: [], items: [], coverage: { discussions: 'complete' }, isLoading: false, refreshFailed: false };
    const schema = AppShellActionOutputSchemas['inbox.get'];
    expect(schema.parse(snapshot)).toEqual(snapshot);
    expect(schema.safeParse({ ...snapshot, groups: [{ ...snapshot.groups[0],
      items: [{ kind: 'approval', key: 'approval:approval-a', artifactId: 'approval-a', body: 'private' }] }] }).success).toBe(false);
  });
  it.each(['session.work.get', 'inbox.get'] as const)('exposes %s as a strict read with explicit availability', (actionId) => {
    const spec = getActionSpec(actionId);
    expect(spec.executionPlacement).toBe('client');
    expect(spec.sideEffectClass).toBe('read');
    expect(spec.requiredAuthority).toBe('account_automation');
    expect(spec.surfaces.agent).toBe(true);
    expect(spec.inputSchema.safeParse(actionId === 'session.work.get'
      ? { sessionId: 'lead' } : {}).success).toBe(true);
    expect(spec.inputSchema.safeParse({ unknown: true }).success).toBe(false);
    expect(spec.outputSchema?.safeParse({ status: 'unavailable' }).success).toBe(true);
    expect(spec.outputSchema?.safeParse({ status: 'ready', rawStore: {} }).success).toBe(false);
  });
  it('registers ordinary automated Inbox acknowledgement over exact Home addresses', () => {
    const spec = getActionSpec('inbox.mark_all_read');
    expect(spec.requiredAuthority).toBe('account_automation');
    expect(spec.inputSchema.safeParse({ targets: [{ serverId: 'home-a', sessionId: 'session-a' }] }).success).toBe(true);
    expect(spec.inputSchema.safeParse({ targets: [{ sessionId: 'session-a' }] }).success).toBe(false);
    expect(spec.surfaces.agent).toBe(true);
    expect(spec.surfaces.mcp).toBe(true);
  });

  it.each(['agent', 'mcp', 'voice'] as const)('allows %s to mark an Inbox snapshot read without confirmation', async (surface) => {
    const executor = createActionExecutor({
      appShellAction: async () => ({ results: [{ serverId: 'home-a', sessionId: 'session-a', status: 'succeeded' }] }),
    } as unknown as ActionExecutorDeps);
    await expect(executor.execute('inbox.mark_all_read', {
      targets: [{ serverId: 'home-a', sessionId: 'session-a' }],
    }, { surface, authority: 'account_automation' })).resolves.toEqual({
      ok: true, result: { results: [{ serverId: 'home-a', sessionId: 'session-a', status: 'succeeded' }] },
    });
  });

  it.each(['session.work.get', 'inbox.get', 'inbox.mark_all_read'] as const)(
    'retains approval admission for voice %s before the answering owner executes', async actionId => {
      let ownerRead = false;
      const settings = ActionsSettingsV1Schema.parse({ v: 1,
        actions: { [actionId]: { approvalRequiredSurfaces: ['voice'] } } });
      const isActionApprovalRequired: NonNullable<ActionExecutorDeps['isActionApprovalRequired']> = (id, context) =>
        isApprovalRequiredByActionsSettings(id, settings, context);
      const executor = createActionExecutor({ isActionApprovalRequired,
        appShellAction: async () => { ownerRead = true; throw new Error('Owner must not execute before approval'); },
      } as unknown as ActionExecutorDeps);
      const input = actionId === 'session.work.get' ? { sessionId: 'lead' }
        : actionId === 'inbox.mark_all_read' ? { targets: [] } : {};
      expect(await executor.execute(actionId, input, { surface: 'voice', authority: 'account_automation' }))
        .toMatchObject({ ok: false, errorCode: 'approvals_not_supported' });
      expect(ownerRead).toBe(false);
    },
  );

  it('retains exact Home addresses and partial acknowledgement outcomes', async () => {
    const calls: unknown[] = [];
    const executor = createActionExecutor({
      appShellAction: async (args: unknown) => {
        calls.push(args);
        return { results: [
          { serverId: 'home-a', sessionId: 'same-id', status: 'succeeded' },
          { serverId: 'home-b', sessionId: 'same-id', status: 'failed' },
        ] };
      },
      isActionApprovalRequired: () => false,
    } as unknown as ActionExecutorDeps);
    const input = { targets: [
      { serverId: 'home-a', sessionId: 'same-id' },
      { serverId: 'home-b', sessionId: 'same-id' },
    ] };
    const context = { surface: 'ui' as const, authority: 'present_user' as const };
    await expect(executor.execute('inbox.mark_all_read', input, context)).resolves.toEqual({
      ok: true,
      result: { results: [
        { serverId: 'home-a', sessionId: 'same-id', status: 'succeeded' },
        { serverId: 'home-b', sessionId: 'same-id', status: 'failed' },
      ] },
    });
    expect(calls).toEqual([{ actionId: 'inbox.mark_all_read', input, context }]);
  });

  it('refuses draft deletion when its client owner is unavailable', async () => {
    const executor = createActionExecutor({ isActionApprovalRequired: () => false } as unknown as ActionExecutorDeps);
    await expect(executor.execute('session.draft.delete', { draftId: '00000000-0000-4000-8000-000000000001' }, {
      surface: 'ui', authority: 'present_user',
    })).resolves.toMatchObject({ ok: false, errorCode: 'unsupported_action' });
  });
});
