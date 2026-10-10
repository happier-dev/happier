import { describe, expect, it } from 'vitest';
import { ActionIdSchema } from './actionIds.js';
import { getActionSpec } from './actionSpecs.js';
import { isApprovalRequiredByActionsSettings, resolveActionApprovalRouting } from './actionApprovalPolicy.js';
import { ActionsSettingsV1Schema } from './actionSettings.js';
import { createActionExecutor } from './actionExecutor.js';
import { ApprovalRequestV2Schema, type ApprovalRequest } from '../approvals/approvalRequestV1.js';
import { createUsageSourceActionPort } from './executor/usageSourceActions.js';
import type { UsageSourceV1 } from '../usage/usageSources.js';

describe('Usage source Action admission', () => {
  it('admits metadata reads and keeps consent, root edits and scoped deletion behind ordinary approval', () => {
    for (const id of ['usage.sources.discover', 'usage.sources.get', 'usage.sources.dismiss']) {
      expect(ActionIdSchema.safeParse(id).success, id).toBe(true);
      expect(getActionSpec(ActionIdSchema.parse(id)).safety).toBe('safe');
    }
    for (const id of ['usage.sources.consent.set', 'usage.sources.stop', 'usage.sources.root.set', 'usage.sources.history.delete']) {
      expect(ActionIdSchema.safeParse(id).success, id).toBe(true);
      const actionId = ActionIdSchema.parse(id);
      expect(resolveActionApprovalRouting({ actionId, spec: getActionSpec(actionId),
        context: { surface: 'agent', authority: 'account_automation' } }).required).toBe(true);
      if (id !== 'usage.sources.history.delete') {
        expect(resolveActionApprovalRouting({ actionId, spec: getActionSpec(actionId), requiredByPolicy: true,
          context: { surface: 'cli', authority: 'present_user' } }).flow).toBe('blocking');
      }
    }
  });

  it('requires exact Home/Machine/source selection and refuses caller confirmation and Account spoofing', () => {
    const id = ActionIdSchema.parse('usage.sources.consent.set');
    const schema = getActionSpec(id).inputSchema;
    const input = { serverId: 'home', machineId: 'machine', sourceId: 'opaque-root', enabled: true };
    expect(schema.safeParse(input).success).toBe(true);
    expect(schema.safeParse({ ...input, confirmed: true }).success).toBe(false);
    expect(schema.safeParse({ ...input, accountId: 'foreign' }).success).toBe(false);
    expect(schema.safeParse({ ...input, sourceId: '' }).success).toBe(false);
    expect(schema.safeParse({ ...input, machineId: undefined }).success).toBe(false);
    const remove = getActionSpec(ActionIdSchema.parse('usage.sources.history.delete')).inputSchema;
    expect(remove.safeParse({ serverId: 'home', machineId: 'machine', sourceId: 'opaque-root',
      dateRange: { startMs: 20, endMs: 10 } }).success).toBe(false);
  });

  it('refuses a foreign Home and unavailable headless dismissal without dispatching', async () => {
    const executor = createActionExecutor({});
    expect(await executor.execute(ActionIdSchema.parse('usage.sources.discover'),
      { serverId: 'other', machineId: 'machine' }, { surface: 'cli', serverId: 'home' }))
      .toMatchObject({ ok: false, errorCode: 'server_target_mismatch' });
    const dismissed = await executor.execute(ActionIdSchema.parse('usage.sources.dismiss'),
      { serverId: 'home', machineId: 'machine', sourceId: 'opaque-root' }, { surface: 'ui', serverId: 'home' });
    expect(dismissed).toMatchObject({ ok: true, result: { status: 'unavailable' } });
  });

  it('does not project private roots into Action observations', () => {
    const spec = getActionSpec(ActionIdSchema.parse('usage.sources.root.set'));
    expect(spec.projectObservationInput?.({ serverId: 'home', machineId: 'machine', sourceId: 'opaque-root', root: '/private/source' }))
      .toEqual({ serverId: 'home', machineId: 'machine', sourceId: 'opaque-root' });
    expect(spec.projectObservationOutput?.({ source: { root: { path: '/private/source' } } })).toEqual({});
  });

  it.each(['usage.sources.root.set', 'usage.sources.discover', 'usage.sources.get'] as const)(
    'keeps private roots out of durable Approval custody for %s, including policy-forced safe reads', async actionId => {
    const source: UsageSourceV1 = { serverId: 'home', machineId: 'machine', sourceId: 'replacement-root',
      agent: { pluginId: 'happier.agent.codex', localId: 'codex' }, root: { kind: 'override', path: '/private/new-root' },
      consent: 'disabled', status: 'found', coverage: 'unknown', pendingCount: 0, asOfMs: null };
    const persisted: ApprovalRequest[] = [];
    const surface = actionId === 'usage.sources.root.set' ? 'agent' as const : 'cli' as const;
    const settings = ActionsSettingsV1Schema.parse({ v: 1, actions: {
      [actionId]: { approvalRequiredSurfaces: [surface] },
    } });
    const input = { serverId: 'home', machineId: 'machine', ...(actionId === 'usage.sources.root.set'
      ? { sourceId: 'old-root', root: '/private/new-root' }
      : actionId === 'usage.sources.get' ? { sourceId: source.sourceId } : {}) };
    const context = { surface, authority: 'account_automation' as const,
      serverId: 'home', runtimeAccountId: 'owner', actionRequestId: 'source-root-request', actionCaller: { kind: 'host' as const } };
    expect(resolveActionApprovalRouting({ actionId, spec: getActionSpec(actionId), input, settings, context }).required).toBe(true);
    const output = actionId === 'usage.sources.root.set' ? { source } : { sources: [source] };
    // Approval persistence and Machine RPC are boundaries; approval admission/settlement remain real.
    const executor = createActionExecutor({
      approvalsCreate: async ({ request }) => { persisted.push(ApprovalRequestV2Schema.parse(request)); return { artifactId: 'approval' }; },
      approvalsGet: async () => persisted.at(-1) ?? null,
      approvalsUpdate: async ({ request }) => { persisted.push(ApprovalRequestV2Schema.parse(request)); return { ok: true }; },
      approvalsWaitForDecision: async ({ request }) => ({ decision: 'approve', request }),
      isApprovalExecutionOriginCurrent: async () => true,
      isActionApprovalRequired: (id, ctx) => isApprovalRequiredByActionsSettings(id, settings, ctx),
      usageSourceAction: createUsageSourceActionPort({ serverId: 'home', assertCurrent: () => {}, rpc: async () => output }),
    });
    const result = await executor.execute(actionId, input, context);
    if (result.ok && result.result && typeof result.result === 'object'
      && 'kind' in result.result && result.result.kind === 'approval_request_created') {
      // A detached CLI approval is decided through the real owner, not a forged approved fixture.
      expect(await executor.execute('approval.request.decide', { artifactId: 'approval', decision: 'approve' }, {
        surface: 'ui', authority: 'present_user', serverId: 'home', runtimeAccountId: 'owner', actionCaller: { kind: 'host' },
      })).toMatchObject({ ok: true });
    } else {
      expect(result).toEqual({ ok: true, result: output });
    }
    expect(persisted.length).toBeGreaterThan(0);
    expect(persisted.at(-1)?.status).toBe('executed');
    expect(JSON.stringify(persisted)).not.toContain('/private/new-root');
    expect(persisted.at(-1)?.execution?.result).toEqual({});
  });
});
