import { describe, expect, it } from 'vitest';
import { ActionIdSchema } from './actionIds.js';
import { getActionSpec } from './actionSpecs.js';
import { createActionExecutor, type ActionExecutorDeps } from './actionExecutor.js';
import { ActionsSettingsV1Schema } from './actionSettings.js';
import { isApprovalRequiredByActionsSettings } from './actionApprovalPolicy.js';

const origin = { serverIdentityId: 'srv_one', sourceRef: { machineId: 'machine', pluginId: 'acme.plugin',
  sourceCustody: { kind: 'development' as const, registeredRootId: 'root' } } };

describe('plugin execution origin Action front door', () => {
  it('admits contextual origins through the existing CLI and MCP client relay without settings writes', async () => {
    const contextualTarget = { commandId: 'current-ui:origin' };
    for (const surface of ['cli', 'mcp'] as const) {
      const requests: unknown[] = [];
      const executor = createActionExecutor({ clientActionExecute: async request => {
        requests.push(request); return { ok: true, result: { status: 'applied' } };
      } });
      expect(await executor.execute('plugins.execution_origin.set', { pluginId: 'acme.plugin', origin, contextualTarget, clientId: 'app-b' },
        { surface, authority: 'account_automation' })).toEqual({ ok: true, result: { status: 'applied' } });
      expect(requests).toEqual([expect.objectContaining({ actionId: 'plugins.execution_origin.set',
        input: { pluginId: 'acme.plugin', origin, contextualTarget, clientId: 'app-b' } })]);
    }
    expect(getActionSpec('plugins.execution_origin.set').inputSchema.safeParse({ pluginId: 'acme.plugin', origin }).success).toBe(true);
    expect(getActionSpec('plugins.execution_origin.set').inputSchema.safeParse({ pluginId: 'acme.plugin', origin,
      contextualTarget: { ...contextualTarget, accountId: 'foreign' } }).success).toBe(false);
  });
  it('discovers and mutates the exact plugin preference through the client owner', async () => {
    for (const [rawId, input, output] of [
      ['plugins.execution_origin.list', { pluginId: 'acme.plugin' }, { status: 'available', storedTarget: null, storedOrigin: null,
        selectedOrigin: origin, selectionSource: 'auto', candidates: [{ origin, version: '1.0.0', selectable: true }] }],
      ['plugins.execution_origin.set', { pluginId: 'acme.plugin', origin }, { status: 'applied' }],
      ['plugins.execution_origin.clear', { pluginId: 'acme.plugin' }, { status: 'applied' }],
    ] as const) {
      const id = ActionIdSchema.parse(rawId);
      const spec = getActionSpec(id);
      expect(spec.executionPlacement).toBe('client');
      expect(spec.requiredAuthority).toBe('account_automation');
      expect(spec.surfaces).toMatchObject({ ui: true, agent: true, mcp: true });
      // The answering client is a system boundary; admission and output parsing stay real.
      const executor = createActionExecutor({ pluginExecutionOriginAction: async (args: { input: unknown }) => {
        expect(args.input).toEqual(input); return output;
      } } as unknown as ActionExecutorDeps);
      expect(await executor.execute(id, input, { surface: 'ui', authority: 'present_user' }))
        .toEqual({ ok: true, result: output });
      expect(spec.inputSchema.safeParse({ ...input, accountId: 'foreign' }).success).toBe(false);
    }
  });

  it('preserves the answering app unavailable reason through the CLI relay result parser', async () => {
    const result = { status: 'unavailable', reason: { code: 'current_ui_context_unavailable', phase: 'selection', retryable: false } };
    const executor = createActionExecutor({ clientActionExecute: async () => ({ ok: true, result }) });
    expect(await executor.execute('plugins.execution_origin.list', { pluginId: 'acme.plugin', contextual: true },
      { surface: 'cli', authority: 'account_automation' })).toEqual({ ok: true, result });
  });

  it('requires a diagnostic for an unavailable list while retaining mutation outcomes', async () => {
    const executor = createActionExecutor({ clientActionExecute: async () => ({ ok: true, result: { status: 'unavailable' } }) });
    expect(await executor.execute('plugins.execution_origin.list', { pluginId: 'acme.plugin' },
      { surface: 'cli', authority: 'account_automation' })).toMatchObject({ ok: false, errorCode: 'invalid_action_output' });
    expect(await executor.execute('plugins.execution_origin.clear', { pluginId: 'acme.plugin' },
      { surface: 'cli', authority: 'account_automation' })).toEqual({ ok: true, result: { status: 'unavailable' } });
  });

  it('rejects cross-plugin origins and keeps mutations under shared confirmation policy', () => {
    const settings = ActionsSettingsV1Schema.parse({ v: 1 });
    const id = ActionIdSchema.parse('plugins.execution_origin.set');
    expect(getActionSpec(id).inputSchema.safeParse({ pluginId: 'other.plugin', origin }).success).toBe(false);
    expect(getActionSpec(id)).toMatchObject({ safety: 'safe', sideEffectClass: 'write' });
    expect(isApprovalRequiredByActionsSettings(id, settings, { surface: 'ui' })).toBe(false);
    expect(isApprovalRequiredByActionsSettings(id, settings, { surface: 'agent' })).toBe(false);
    const asking = ActionsSettingsV1Schema.parse({ v: 1, actions: { [id]: { approvalRequiredSurfaces: ['ui'] } } });
    expect(isApprovalRequiredByActionsSettings(id, asking, { surface: 'ui' })).toBe(true);
    expect(isApprovalRequiredByActionsSettings(ActionIdSchema.parse('plugins.execution_origin.list'), settings,
      { surface: 'agent' })).toBe(false);
  });
});
