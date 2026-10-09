import { describe, expect, it } from 'vitest';
import { ActionIdSchema, type ActionId } from './actionIds.js';
import { ActionsSettingsV1Schema } from './actionSettings.js';
import { isApprovalRequiredByActionsSettings } from './actionApprovalPolicy.js';
import { createProviderActionExecuteV1 } from '../providers/executeProviderActionV1.js';
import { createProviderErrorV1 } from '../providers/errors.js';
import { applyProviderDefaultModelSelectionV1, SessionModelSelectionV1Schema } from '../providers/selection/v1.js';

const context = { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' } } as const;

describe('Provider Settings Actions', () => {
  it('admits the exact scoped credential operation and preserves a daemon unknown-outcome refusal', async () => {
    const actionId = 'providers.connections.secrets.bind';
    expect(ActionIdSchema.safeParse(actionId).success).toBe(true);
    const { getActionSpec } = await import('./actionSpecs.js');
    const { createActionExecutor } = await import('./actionExecutor.js');
    const spec = getActionSpec(actionId);
    expect(spec.inputSchema.safeParse({ action: 'bindSecret', machineId: 'machine', connectionId: 'connection',
      credentialSlotId: 'apiKey', savedSecretId: null, scope: 'machine' }).success).toBe(true);
    expect(spec.inputSchema.safeParse({ action: 'delete', machineId: 'machine', connectionId: 'connection' }).success).toBe(false);
    expect(spec.inputSchema.safeParse({ action: 'bindSecret', machineId: 'machine', connectionId: 'connection',
      credentialSlotId: 'apiKey', savedSecretId: null, scope: 'machine', accountId: 'foreign' }).success).toBe(false);
    const requests: unknown[] = [];
    const settings = ActionsSettingsV1Schema.parse({ v: 1, actions: {},
      approvalWaivedSurfaces: { [actionId]: ['ui'] } });
    const executor = createActionExecutor({
      isActionApprovalRequired: (id, ctx, input) => isApprovalRequiredByActionsSettings(id, settings, ctx, undefined, undefined, input),
      providerActionExecute: createProviderActionExecuteV1({ assertCurrent: () => {}, setDefault: async () => ({ status: 'applied' }),
        rpc: async ({ request }) => {
          // Only the daemon RPC transport is replaced; parsing, dispatch and outcome handling remain real.
          requests.push(request);
          throw createProviderErrorV1('provider_rpc_mutation_outcome_unknown');
        },
      }),
    });
    const input = { action: 'bindSecret', machineId: 'machine', connectionId: 'connection',
      credentialSlotId: 'apiKey', savedSecretId: null, scope: 'machine' };
    await expect(executor.execute(actionId, input, { ...context, actionsSettings: settings })).resolves.toMatchObject({
      ok: false, errorCode: 'provider_rpc_mutation_outcome_unknown',
    });
    expect(requests).toEqual([{ actionId, input }]);
  }, 60_000);

  it('asks before scoped grants, deletion, probe, process and experimental compatibility, but reads remain safe', async () => {
    const { getActionSpec } = await import('./actionSpecs.js');
    const { resolveActionApprovalRouting } = await import('./actionApprovalPolicy.js');
    for (const id of ['providers.connections.enabled.set', 'providers.connections.delete', 'providers.probe',
      'providers.connections.start_local', 'providers.models.load', 'providers.models.experimental.confirm'] as const satisfies readonly ActionId[]) {
      const spec = getActionSpec(id);
      expect(resolveActionApprovalRouting({ actionId: id, spec,
        context: { surface: 'agent', authority: 'account_automation' } })).toMatchObject({ required: true });
    }
    expect(getActionSpec('providers.connections.describe').safety).toBe('safe');
    expect(getActionSpec('providers.models.projection').inputSchema.safeParse({ machineId: 'machine',
      agentTargetKey: 'agent:codex', forceRefresh: true }).success).toBe(false);
    expect(getActionSpec('providers.models.refresh').safety).toBe('danger');
  }, 60_000);

  it('keeps default intent for an unavailable connection and refuses a different Agent target', async () => {
    const { getActionSpec } = await import('./actionSpecs.js');
    const schema = getActionSpec('providers.defaults.set').inputSchema;
    const selection = SessionModelSelectionV1Schema.parse({ v: 1, ref: { agentTargetKey: 'agent:codex', providerConnectionId: 'unavailable', modelId: 'model' }, updatedAt: 1 });
    expect(schema.safeParse({ agentTargetKey: 'agent:codex', selection }).success).toBe(true);
    expect(schema.safeParse({ agentTargetKey: 'agent:claude', selection }).success).toBe(false);
    expect(schema.safeParse({ agentTargetKey: 'agent:codex', selection: null }).success).toBe(true);
    const other = SessionModelSelectionV1Schema.parse({ ...selection, ref: { ...selection.ref, agentTargetKey: 'agent:claude' } });
    const raw = { unknownPreference: { retained: true }, providerDefaultModelSelectionsByAgentTargetKeyV1: { 'agent:claude': other } };
    let stored: Record<string, unknown> = raw;
    const { createActionExecutor } = await import('./actionExecutor.js');
    const executor = createActionExecutor({
      providerActionExecute: createProviderActionExecuteV1({ assertCurrent: () => {}, rpc: async () => { throw new Error('Default intent must not consult a daemon'); },
        setDefault: async input => { stored = applyProviderDefaultModelSelectionV1(stored, input); return { status: 'applied' }; },
      }),
    });
    expect(await executor.execute('providers.defaults.set', { agentTargetKey: 'agent:codex', selection }, context)).toEqual({ ok: true, result: { status: 'updated' } });
    expect(stored).toEqual({ ...raw, providerDefaultModelSelectionsByAgentTargetKeyV1: { 'agent:claude': other, 'agent:codex': selection } });
    expect(await executor.execute('providers.defaults.set', { agentTargetKey: 'agent:codex', selection: null }, context)).toEqual({ ok: true, result: { status: 'updated' } });
    expect(stored).toEqual(raw);
    expect(() => applyProviderDefaultModelSelectionV1({ providerDefaultModelSelectionsByAgentTargetKeyV1: null }, { agentTargetKey: 'agent:codex', selection })).toThrow();
  }, 60_000);

  it('keeps a dispatched mutation ACK after retirement, but refuses a retired read and malformed mutation ACK', async () => {
    const { createActionExecutor } = await import('./actionExecutor.js');
    let current = true;
    let reply: unknown = { status: 'success', action: 'delete', deletedConnectionId: 'connection' };
    const settings = ActionsSettingsV1Schema.parse({ v: 1, actions: {},
      approvalWaivedSurfaces: { 'providers.connections.delete': ['ui'] } });
    const executor = createActionExecutor({
      isActionApprovalRequired: (id, ctx, input) => isApprovalRequiredByActionsSettings(id, settings, ctx, undefined, undefined, input),
      providerActionExecute: createProviderActionExecuteV1({
        assertCurrent: () => { if (!current) throw Object.assign(new Error('scope-retired'), { code: 'scope-retired' }); },
        rpc: async () => { current = false; return reply; }, setDefault: async () => ({ status: 'applied' }),
      }),
    });
    const waivedContext = { ...context, actionsSettings: settings };
    expect(await executor.execute('providers.connections.delete', { action: 'delete', machineId: 'machine', connectionId: 'connection' }, waivedContext))
      .toEqual({ ok: true, result: reply });
    current = true;
    reply = { unrecognized: true };
    expect(await executor.execute('providers.connections.delete', { action: 'delete', machineId: 'machine', connectionId: 'connection' }, waivedContext))
      .toMatchObject({ ok: false, errorCode: 'provider_rpc_mutation_outcome_unknown' });
    current = true;
    reply = { status: 'error', error: createProviderErrorV1('agent_unavailable') };
    const read = await executor.execute('providers.connections.describe', { machineId: 'machine' }, context);
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.errorCode).not.toBe('provider_rpc_mutation_outcome_unknown');
  }, 60_000);
});
