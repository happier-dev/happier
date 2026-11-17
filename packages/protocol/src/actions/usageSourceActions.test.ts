import { describe, expect, it } from 'vitest';
import { ActionIdSchema } from './actionIds.js';
import { getActionSpec } from './actionSpecs.js';
import { isApprovalRequiredByActionsSettings, resolveActionApprovalRouting } from './actionApprovalPolicy.js';
import { ActionsSettingsV1Schema } from './actionSettings.js';
import { createActionExecutor } from './actionExecutor.js';
import { ApprovalRequestV2Schema, type ApprovalRequest, type ApprovalRequestV2 } from '../approvals/approvalRequestV1.js';
import { decideApprovalRequestTransition } from '../approvals/approvalRequestTransition.js';
import { createUsageSourceActionPort } from './executor/usageSourceActions.js';
import type { UsageSourceV1 } from '../usage/usageSources.js';
import { describeApprovalRequestFields, projectApprovalRequestForPublicRead } from './actionApprovalPresentation.js';

describe('Usage source Action admission', () => {
  it('keeps grouped source status and pending counts with exact selector recovery', async () => {
    const first: UsageSourceV1 = { serverId: 'home', machineId: 'machine', sourceId: 'first',
      agent: { pluginId: 'happier.agent.claude', localId: 'claude' }, root: { kind: 'default', path: '/private/source' },
      consent: 'enabled', status: 'ready', coverage: 'partial', pendingCount: 3, asOfMs: 100, discoveredFileCount: 2 };
    const sources = [first, { ...first, sourceId: 'second', pendingCount: 4, discoveredFileCount: 4 }];
    const executor = createActionExecutor({
      usageSourceAction: createUsageSourceActionPort({ serverId: 'home', assertCurrent() {},
        // Machine RPC is the only mocked boundary.
        rpc: async request => {
          const sourceId = request.actionId === 'usage.sources.get' ? request.input.sourceId : undefined;
          return { sources: sourceId ? sources.filter(source => source.sourceId === sourceId) : sources };
        },
      }),
    });
    expect(await executor.execute('usage.sources.get', { serverId: 'home', machineId: 'machine' },
      { surface: 'agent', authority: 'present_user' })).toEqual({ ok: true, result: { sources: [], summary: {
        sourceCount: 2, groups: [{ agent: first.agent, consent: 'enabled', status: 'ready', coverage: 'partial',
          sourceCount: 2, pendingCount: 7, sources: [{ sourceId: 'first', discoveredFileCount: 2 },
            { sourceId: 'second', discoveredFileCount: 4 }] }],
      } } });
    expect(await executor.execute('usage.sources.get', { serverId: 'home', machineId: 'machine', sourceId: 'second' },
      { surface: 'agent', authority: 'present_user' })).toEqual({ ok: true, result: { sources: [sources[1]] } });
    sources.length = 0;
    expect(await executor.execute('usage.sources.get', { serverId: 'home', machineId: 'machine' },
      { surface: 'agent', authority: 'present_user' })).toEqual({ ok: true,
        result: { sources: [], summary: { sourceCount: 0, groups: [] } } });
  });

  it.each(['claude', 'codex'] as const)('approves %s consent from admitted operands and refuses a different Account decision', async agent => {
    const source: UsageSourceV1 = { serverId: 'home', machineId: 'machine', sourceId: agent + '-root',
      agent: { pluginId: 'happier.agent.' + agent, localId: agent }, root: { kind: 'default', path: '/private/source' },
      consent: 'enabled', status: 'ready', coverage: 'unknown', pendingCount: 0, asOfMs: null };
    const input = { serverId: 'home', machineId: 'machine', sourceId: source.sourceId, enabled: true };
    let stored: ApprovalRequestV2 | null = null;
    const effects: unknown[] = [];
    const createExecutor = (accountId: string) => createActionExecutor({
      // Artifact storage and Machine RPC are boundaries; create, decide, CAS,
      // detached replay and the Usage transport owner all run their real logic.
      approvalsCreate: async ({ request }) => {
        stored = ApprovalRequestV2Schema.parse(JSON.parse(JSON.stringify(request)));
        return { artifactId: 'consent-approval' };
      },
      // Each authenticated Artifact boundary sees only its Account's records.
      approvalsGet: async () => accountId === 'owner' ? structuredClone(stored) : null,
      approvalsUpdate: async ({ request, expectedStatus }) => {
        if (!stored) throw new Error('Missing consent approval');
        const next = ApprovalRequestV2Schema.parse(request);
        const transition = decideApprovalRequestTransition(stored, next, { expectedStatus });
        if (!transition.ok) return transition;
        stored = structuredClone(next);
        return { ok: true };
      },
      isApprovalExecutionOriginCurrent: async () => true,
      usageSourceAction: createUsageSourceActionPort({ serverId: 'home', assertCurrent() {},
        rpc: async request => { effects.push(request.input); return { source }; } }),
    });
    const executor = createExecutor('owner');
    const requester = { surface: 'cli', authority: 'account_automation', actionCaller: { kind: 'host' },
      serverId: 'home', runtimeAccountId: 'owner', actionRequestId: 'consent-request' } as const;
    await expect(executor.execute('usage.sources.consent.set', input, requester)).resolves.toEqual({ ok: true,
      result: { kind: 'approval_request_created', artifactId: 'consent-approval', actionId: 'usage.sources.consent.set' } });
    const open = ApprovalRequestV2Schema.parse(stored);
    expect(open.actionArgs).toEqual(input);
    expect(projectApprovalRequestForPublicRead(open)).toMatchObject({ actionArgs: {
      serverId: 'home', machineId: 'machine', sourceId: source.sourceId,
    } });
    expect(open.preview).toMatchObject({ actionArgs: { serverId: 'home', machineId: 'machine', sourceId: source.sourceId } });
    expect(effects).toEqual([]);
    const person = { surface: 'cli', authority: 'present_user', actionCaller: { kind: 'host' },
      serverId: 'home', runtimeAccountId: 'owner' } as const;
    await expect(createExecutor('another-account').execute('approval.request.decide', { artifactId: 'consent-approval', decision: 'approve' },
      { ...person, runtimeAccountId: 'another-account' })).resolves.toMatchObject({ ok: false, errorCode: 'approval_not_found' });
    expect(ApprovalRequestV2Schema.parse(stored).status).toBe('open');
    expect(effects).toEqual([]);
    const decision = await executor.execute('approval.request.decide', { artifactId: 'consent-approval', decision: 'approve' }, person);
    expect(decision, JSON.stringify(decision)).toMatchObject({ ok: true });
    expect(effects).toEqual([input]);
    expect(ApprovalRequestV2Schema.parse(stored)).toMatchObject({ status: 'executed', execution: { ok: true, result: {} } });
  });

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
      // Private input retains its invocation; live results stay with the original
      // person. Durable automated requests defer the result to the deciding person.
      expect(resolveActionApprovalRouting({ actionId, spec: getActionSpec(actionId), requiredByPolicy: true,
        context: { surface: 'cli', authority: 'present_user' } }).flow)
        .toBe(id === 'usage.sources.history.delete' ? 'deferred' : 'blocking');
      expect(resolveActionApprovalRouting({ actionId, spec: getActionSpec(actionId), requiredByPolicy: true,
        context: { surface: 'cli', authority: 'account_automation' } }).flow)
        .toBe(id === 'usage.sources.root.set' ? 'blocking' : 'deferred');
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
      readActionsSettings: () => settings,
      usageSourceAction: createUsageSourceActionPort({ serverId: 'home', assertCurrent: () => {}, rpc: async () => output }),
    });
    const result = await executor.execute(actionId, input, context);
    if (actionId === 'usage.sources.root.set') {
      // Approval permits the effect, not disclosure of its private result to the Agent.
      expect(result).toMatchObject({ ok: false, errorCode: 'approval_result_held' });
      expect(JSON.stringify(result)).not.toContain('/private/new-root');
    } else {
      expect(result).toMatchObject({ ok: true, result: { kind: 'approval_request_created', artifactId: 'approval', actionId } });
      // A detached CLI approval is decided through the real owner, not a forged approved fixture.
      expect(await executor.execute('approval.request.decide', { artifactId: 'approval', decision: 'approve' }, {
        surface: 'ui', authority: 'present_user', serverId: 'home', runtimeAccountId: 'owner', actionCaller: { kind: 'host' },
      })).toMatchObject({ ok: true });
    }
    expect(persisted.length).toBeGreaterThan(0);
    const open = persisted[0]!;
    const observation = getActionSpec(actionId).projectObservationInput!(input);
    expect(projectApprovalRequestForPublicRead(open)).toMatchObject({ actionArgs: observation });
    if (actionId === 'usage.sources.root.set') {
      expect(describeApprovalRequestFields(open).rows).toContainEqual(expect.objectContaining({
        path: 'sourceId', value: 'old-root',
      }));
      expect(projectApprovalRequestForPublicRead(open)).toMatchObject({
        actionArgs: { serverId: 'home', machineId: 'machine', sourceId: 'old-root' },
      });
    }
    expect(persisted.at(-1)?.status).toBe('executed');
    expect(JSON.stringify(persisted)).not.toContain('/private/new-root');
    expect(persisted.at(-1)?.execution?.result).toEqual({});
  });
});
