import { describe, expect, it } from 'vitest';
import { ActionIdSchema } from './actionIds.js';
import { getActionSpec } from './actionSpecs.js';
import { bindHomeDomainActionHttpRequestV1, HomeDomainActionIdV1Schema } from './homeDomainActionFamily.js';
import { createActionExecutor, type ActionExecutorDeps } from './actionExecutor.js';
import { isApprovalRequiredByActionsSettings, resolveActionApprovalRouting } from './actionApprovalPolicy.js';
import { ActionsSettingsV1Schema, isActionEnabledByActionsSettings, normalizeActionsSettingsV1 } from './actionSettings.js';

describe('self Account profile Actions', () => {
  it.each([
    { id: 'account.username.check', path: '/v1/account/username/check', input: { username: 'candidate' },
      result: { username: 'candidate', availability: 'unavailable', suggestions: ['candidate1', 'candidate2'] }, safety: 'safe' },
    { id: 'account.username.release', path: '/v1/account/username/release', input: {},
      result: { username: null, released: true, reservedUntilMs: 30 * 24 * 60 * 60 * 1_000 }, safety: 'danger' },
  ])('binds $id to its closed domain request and acknowledgement', ({ id, path, input, result, safety }) => {
    const actionId = ActionIdSchema.parse(id);
    const spec = getActionSpec(actionId);
    expect(spec.safety).toBe(safety);
    expect(spec.inputSchema.safeParse({ ...input, accountId: 'other' }).success).toBe(false);
    expect(spec.outputSchema?.safeParse(result).success).toBe(true);
    expect(spec.outputSchema?.safeParse({ ...result, ownerAccountId: 'other' }).success).toBe(false);
    expect(bindHomeDomainActionHttpRequestV1(HomeDomainActionIdV1Schema.parse(id), input))
      .toEqual({ method: 'POST', path, body: input });
    // External MCP has no admitted Home-family approval transport yet.
    expect(spec.surfaces).toMatchObject({ ui: true, agent: true, cli: true, plugin: true, mcp: false });
  });

  it('admits direct UI release and asks automation, with surface-specific waivers; checking is safe', () => {
    const actionId = ActionIdSchema.parse('account.username.release');
    const checkId = ActionIdSchema.parse('account.username.check');
    for (const surface of ['ui', 'agent', 'cli', 'plugin'] as const) {
      const context = { surface, authority: 'present_user' as const };
      const settings = normalizeActionsSettingsV1({ v: 1, actions: {} });
      expect(isApprovalRequiredByActionsSettings(actionId, settings, context)).toBe(surface !== 'ui');
      if (surface === 'ui') {
        expect(resolveActionApprovalRouting({ actionId, spec: getActionSpec(actionId), settings, context })
          .uiConfirmationRequired ?? false).toBe(false);
        expect(resolveActionApprovalRouting({ actionId, spec: getActionSpec(actionId), context,
          settings: normalizeActionsSettingsV1({ v: 1, actions: { [actionId]: { approvalRequiredSurfaces: ['ui'] } } }),
        })).toMatchObject({ required: false, uiConfirmationRequired: true });
      }
      expect(isApprovalRequiredByActionsSettings(checkId, settings, context)).toBe(false);
      const waived = normalizeActionsSettingsV1({ v: 1, actions: {}, approvalWaivedSurfaces: { [actionId]: [surface] } });
      expect(isApprovalRequiredByActionsSettings(actionId, waived, context)).toBe(false);
      const off = normalizeActionsSettingsV1({ v: 1, actions: { [actionId]: { enabled: false } },
        approvalWaivedSurfaces: { [actionId]: [surface] } });
      expect(isActionEnabledByActionsSettings(actionId, off, { surface })).toBe(false);
    }
  });

  it('refuses release when Off even if its CLI approval is waived', async () => {
    let writes = 0;
    // The answering HTTP service is the boundary; real Action admission decides whether it is reached.
    const executor = createActionExecutor({ homeDomainAction: async () => {
      writes += 1;
      return { username: null, released: true, reservedUntilMs: 2_592_000_000 };
    } } as unknown as ActionExecutorDeps);
    const actionId = ActionIdSchema.parse('account.username.release');
    const actionsSettings = normalizeActionsSettingsV1({ v: 1,
      actions: { [actionId]: { enabled: false } }, approvalWaivedSurfaces: { [actionId]: ['cli'] } });
    expect(await executor.execute(actionId, {}, { surface: 'cli', authority: 'present_user', actionsSettings }))
      .toMatchObject({ ok: false, errorCode: 'action_disabled' });
    expect(writes).toBe(0);
  });

  it.each(['account.name.set', 'account.username.set'] as const)('returns durable approval custody for the Agent self-write %s', actionId => {
    const spec = getActionSpec(actionId);
    expect(resolveActionApprovalRouting({ actionId, spec, context: {
      surface: 'agent', authority: 'account_automation',
      actionCaller: { kind: 'session', sessionId: 'requester', starterDepth: 0, turnDepth: 0 },
    } })).toMatchObject({ required: true, flow: 'deferred', result: 'required' });
  });
  it('reads only the caller’s safe profile through the existing route and drops unrelated profile material', async () => {
    const actionId = ActionIdSchema.parse('account.profile.get');
    const spec = getActionSpec(actionId);
    expect(spec).toMatchObject({ safety: 'safe', sideEffectClass: 'read', executionPlacement: 'account', requiredAuthority: 'account_automation' });
    expect(spec.approval).toMatchObject({ result: 'required' });
    expect(spec.inputSchema.safeParse({ accountId: 'another-account' }).success).toBe(false);
    expect(bindHomeDomainActionHttpRequestV1(HomeDomainActionIdV1Schema.parse(actionId), {})).toEqual({ method: 'GET', path: '/v1/account/profile' });
    const profile = { id: 'self', timestamp: 1, firstName: 'Legacy', lastName: 'Name', username: 'self', avatar: null,
      connectedServices: ['unrelated'], privateFutureField: 'never disclose' };
    // Only the answering HTTP service is substituted; the Action parser and settlement stay real.
    const executor = createActionExecutor({ homeDomainAction: async () => profile } as unknown as ActionExecutorDeps);
    expect(await executor.execute(actionId, {}, { surface: 'agent', authority: 'account_automation', actionCaller: { kind: 'host' } }))
      .toEqual({ ok: true, result: { id: 'self', timestamp: 1, name: 'Legacy Name', firstName: 'Legacy', lastName: 'Name', username: 'self', avatar: null } });
  });

  it.each([
    ['account.name.set', '/v1/account/profile', { name: 'Leeroy Brun' }],
    ['account.username.set', '/v1/account/username', { username: 'leeroybrun' }],
  ])('admits %s only for the caller through its canonical route and result-bearing approval', (id, path, input) => {
    const actionId = ActionIdSchema.parse(id);
    const spec = getActionSpec(actionId);
    expect(spec.surfaces.agent).toBe(true);
    expect(spec.safety).toBe('danger');
    expect(spec.sideEffectClass).toBe('write');
    expect(spec.approval).toMatchObject({ result: 'required' });
    expect(spec.inputSchema.safeParse({ ...input, accountId: 'other' }).success).toBe(false);
    expect(bindHomeDomainActionHttpRequestV1(HomeDomainActionIdV1Schema.parse(id), input)).toEqual({ method: 'POST', path, body: input });
  });

  it('executes the name write through the admitted Home transport and returns the acknowledged profile', async () => {
    const result = { name: 'Captain', firstName: 'Captain', lastName: null, timestamp: 1 };
    // This dependency is the host HTTP transport; all catalog and executor logic remains real.
    const executor = createActionExecutor({
      readActionsSettings: context => context.actionsSettings ?? ActionsSettingsV1Schema.parse({ v: 1,
        approvalWaivedSurfaces: { 'account.name.set': [context.surface] } }),

      homeDomainAction: async () => result,
      interceptActionExecution: async ({ input }) => ({ status: 'continue', input }),
    } as unknown as ActionExecutorDeps);
    expect(await executor.execute(ActionIdSchema.parse('account.name.set'), { name: 'Captain' }, {
      surface: 'agent', authority: 'account_automation', actionCaller: { kind: 'host' },
    })).toEqual({ ok: true, result });
  });
});
