import { describe, expect, it } from 'vitest';
import { ActionIdSchema } from './actionIds.js';
import { getActionSpec } from './actionSpecs.js';
import { createActionExecutor } from './actionExecutor.js';
import { ActionsSettingsV1Schema, isActionEnabledByActionsSettings } from './actionSettings.js';


const operations = [
  ['plugins.account.release.select', { pluginId: 'example.tasks', version: '2.0.0' }, { kind: 'selected', intent: {
    pluginId: 'example.tasks', desiredVersion: '2.0.0', enabled: true, offlineUiHosting: 'disabled', writableCollections: [], revision: 'intent-1',
  } }],
  ['plugins.account.hosting.set', { pluginId: 'example.tasks', enabled: true }, { kind: 'updated' }],
  ['plugins.account.hosting.remove', { pluginId: 'example.tasks' }, { kind: 'updated' }],
  ['plugins.account.cache.clear', { pluginId: 'example.tasks' }, { kind: 'updated' }],
] as const;

describe('Account plugin administration semantic Action admission', () => {
  it.each(operations)('admits the client relay and strict producer/consumer contract (%s)', async (rawId, input, output) => {
    const id = ActionIdSchema.parse(rawId);
    const spec = getActionSpec(id);
    expect(spec.surfaces).toMatchObject({ ui: true, agent: true, mcp: true, cli: true });
    expect(spec.inputSchema.safeParse(input).success).toBe(true);
    expect(spec.inputSchema.safeParse({ ...input, accountId: 'injected-authority' }).success).toBe(false);
    expect(spec.outputSchema?.safeParse(output).success).toBe(true);
    expect(spec.outputSchema?.safeParse({ ...output, ignored: true }).success).toBe(false);
    const executor = createActionExecutor({ readActionsSettings: () => ActionsSettingsV1Schema.parse({ v: 1, approvalWaivedSurfaces: { [id]: ['cli', 'mcp'] } }), clientActionExecute: async request => {
      expect(request).toMatchObject({ actionId: id, input });
      return { ok: true, result: output };
    } });
    for (const surface of ['cli', 'mcp'] as const) {
      expect(await executor.execute(id, input, { surface, authority: 'account_automation' })).toEqual({ ok: true, result: output });
    }
    // The client host is a separate package/process boundary to Protocol.
    // This exercises the registered dispatch branch, not only the relay path.
    const host = createActionExecutor({
      presentUserActionConfirmation: async () => true,
      pluginAccountAdministrationAction: async request => {
        expect(request).toMatchObject({ actionId: id, input });
        return output;
      } });
    expect(await host.execute(id, input, { surface: 'ui', authority: 'present_user' })).toEqual({ ok: true, result: output });
  });
  it.each(operations)('applies Off and native UI Ask before Account plugin effects (%s)', async (rawId, input, output) => {
    const id = ActionIdSchema.parse(rawId);
    const disabled = ActionsSettingsV1Schema.parse({ v: 1, actions: { [id]: { disabledSurfaces: ['ui'] } } });
    let effects = 0;
    const boundary = async () => { effects++; return output; };
    const off = createActionExecutor({
      pluginAccountAdministrationAction: boundary,
      isActionEnabled: (actionId, context) => isActionEnabledByActionsSettings(actionId, disabled, context) });
    expect(await off.execute(id, input, { surface: 'ui', authority: 'present_user' })).toMatchObject({ ok: false, errorCode: 'action_disabled' });
    const asking = ActionsSettingsV1Schema.parse({ v: 1, actions: { [id]: { approvalRequiredSurfaces: ['ui'] } } });
    const deps = { pluginAccountAdministrationAction: boundary,
      readActionsSettings: () => (asking) };
    const context = { surface: 'ui', authority: 'present_user', actionsSettings: asking } as const;
    expect(await createActionExecutor(deps).execute(id, input, context))
      .toMatchObject({ ok: false, errorCode: 'action_interactive_review_required' });
    expect(await createActionExecutor({ ...deps, presentUserActionConfirmation: async () => false }).execute(id, input, context))
      .toMatchObject({ ok: false, errorCode: 'approval_canceled' });
    expect(effects).toBe(0);
    expect(await createActionExecutor({ ...deps, presentUserActionConfirmation: async () => true }).execute(id, input, context))
      .toEqual({ ok: true, result: output });
    expect(effects).toBe(1);
  });
});
