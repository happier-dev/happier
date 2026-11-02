import { describe, expect, it } from 'vitest';
import { ActionIdSchema } from './actionIds.js';
import { createActionExecutor, type ActionExecutorDeps } from './actionExecutor.js';
import { getActionSpec } from './actionSpecs.js';
import { ActionsSettingsV1Schema } from './actionSettings.js';
import { isApprovalRequiredByActionsSettings } from './actionApprovalPolicy.js';
import { resolveInputOptions } from '../inputs/inputOptions.js';

const context = { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' } } as const;
const inventory = {
  displays: [
    { storageKey: 'laptop', name: 'Built-in Retina', builtIn: true, primary: false, connected: false, inUse: false },
    { storageKey: 'desk', name: 'Studio Display', builtIn: false, primary: true, connected: true, inUse: true },
    { storageKey: 'side', name: 'Side display', builtIn: false, primary: false, connected: true, inUse: false },
    { storageKey: 'away', name: 'Projector', builtIn: false, primary: false, connected: false, inUse: false },
  ], automaticResolvesTo: 'desk',
};

function deps(overrides: Partial<ActionExecutorDeps>): ActionExecutorDeps {
  // Only the exercised native boundary is supplied; admission and option projection stay real.
  return overrides as ActionExecutorDeps;
}

describe('desktop display Action', () => {
  it('returns one native inventory read without capture result approval', async () => {
    const id = ActionIdSchema.parse('desktop.displays.list');
    let reads = 0;
    const executor = createActionExecutor(deps({ desktopDisplaysList: async () => { reads++; return inventory; } }));
    expect(reads).toBe(0);
    expect(await executor.execute(id, {}, context)).toEqual({ ok: true, result: inventory });
    expect(reads).toBe(1);
    const spec = getActionSpec(id);
    expect(spec).toMatchObject({ executionPlacement: 'client', sideEffectClass: 'read', safety: 'safe',
      surfaces: { ui: true, agent: true, mcp: true, rpc: false, cli: false },
      toolExposure: { agent: 'discoverable_only', mcp: 'discoverable_only' } });
    expect(spec.approval.result).not.toBe('required');
    for (const surface of ['agent', 'mcp'] as const) {
      expect(isApprovalRequiredByActionsSettings(id, ActionsSettingsV1Schema.parse({ v: 1 }),
        { surface, authority: 'account_automation' })).toBe(false);
    }
  });

  it('retains unavailable failures and rejects unknown request fields before reading', async () => {
    const id = ActionIdSchema.parse('desktop.displays.list');
    let reads = 0;
    const executor = createActionExecutor(deps({ desktopDisplaysList: async () => {
      reads++; return { ok: false, errorCode: 'unavailable', error: 'desktop_only' };
    } }));
    expect(await executor.execute(id, { refresh: true }, context)).toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
    expect(reads).toBe(0);
    expect(await executor.execute(id, {}, context)).toEqual({ ok: false, errorCode: 'unavailable', error: 'desktop_only' });
  });

  it('projects Automatic, confirmed Built-in, Main and named displays from one read', async () => {
    let reads = 0;
    const resolve = (result: typeof inventory) => resolveInputOptions({
      deps: deps({ desktopDisplaysList: async () => { reads++; return result; } }), ctx: context,
      actionId: null, optionsSourceId: 'desktop.displays.list', input: {},
      readFailure: () => null, resolveSessionId: () => null, reviewScope: () => undefined,
    });
    const resolved = await resolve(inventory);
    expect(resolved).toMatchObject({ ok: true, result: [
      { value: 'automatic', label: 'Automatic', description: 'Studio Display' },
      { value: 'built_in', label: 'Built-in display' },
      { value: 'main', label: 'Display with the Happier window' },
      { value: 'named:laptop', label: 'Built-in Retina', description: 'Not connected' },
      { value: 'named:desk', label: 'Studio Display', description: 'Connected' },
      { value: 'named:side', label: 'Side display', description: 'Connected' },
      { value: 'named:away', label: 'Projector', description: 'Not connected' },
    ] });
    expect(reads).toBe(1);
    const unknownBuiltIn = await resolve({ ...inventory, displays: inventory.displays.map(display => ({ ...display, builtIn: false })) });
    expect(unknownBuiltIn.ok && unknownBuiltIn.result.some(option => option.value === 'built_in')).toBe(false);
  });

  it.each(['agent', 'mcp'] as const)('resolves desktop options from a headless %s caller through the same client Action transport', async surface => {
    const dispatched: string[] = [];
    const executor = createActionExecutor(deps({
      clientActionExecute: async request => {
        dispatched.push(request.actionId);
        return { ok: true, result: inventory };
      },
    }));
    expect(await executor.execute('action.options.resolve', { optionsSourceId: 'desktop.displays.list' },
      { ...context, surface, authority: 'account_automation' }))
      .toMatchObject({ ok: true, result: { options: [
        { value: 'automatic' }, { value: 'built_in' }, { value: 'main' },
        { value: 'named:laptop' }, { value: 'named:desk' }, { value: 'named:side' }, { value: 'named:away' },
      ] } });
    expect(dispatched).toEqual(['desktop.displays.list']);
  });
});
