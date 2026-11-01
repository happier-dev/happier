import { describe, expect, it } from 'vitest';
import { createActionExecutor, type ActionExecutorDeps } from './actionExecutor.js';
import { getActionSpec } from './actionSpecs.js';
import type { ActionId } from './actionIds.js';
import { ActionsSettingsV1Schema } from './actionSettings.js';
import { isApprovalRequiredByActionsSettings } from './actionApprovalPolicy.js';

const actionsSettings = ActionsSettingsV1Schema.parse({ v: 1, actions: { 'settings.set': { enabled: true } } });

describe('declared settings Actions', () => {
  // No per-setting surface gate: former person-only settings (showToolCalls) follow the
  // same per-Action default Ask and user waiver as every other Settings write.
  it.each([
    { input: { anchor: 'transcript.agentHtmlNetworkPolicy', value: 'allowed' } },
    { input: { anchor: 'transcript.showToolCalls', value: false } },
  ])('asks agents by default and runs a waived write for $input.anchor', async ({ input }) => {
    const writes: unknown[] = [];
    // The answering Settings host is the process boundary; Action admission and policy stay real.
    const executor = createActionExecutor({ settingsDeclarationAction: async ({ input }: Parameters<NonNullable<ActionExecutorDeps['settingsDeclarationAction']>>[0]) => {
      writes.push(input);
      return { anchor: input.anchor, value: input.value };
    }, isActionApprovalRequired: (id, context, admittedInput) =>
      isApprovalRequiredByActionsSettings(id, context.actionsSettings ?? actionsSettings, context, undefined, undefined, admittedInput),
    } as unknown as ActionExecutorDeps);
    for (const surface of ['agent', 'mcp'] as const) {
      expect(await executor.execute('settings.set', input, { surface, actionsSettings }))
        .toMatchObject({ ok: false, errorCode: 'approvals_not_supported' });
      expect(writes).toEqual([]);
    }
    const waived = ActionsSettingsV1Schema.parse({ v: 1,
      approvalWaivedSurfaces: { 'settings.set': ['agent', 'mcp'] } });
    for (const surface of ['agent', 'mcp'] as const) {
      const result = await executor.execute('settings.set', input, { surface, actionsSettings: waived });
      expect(result).toEqual({ ok: true, result: { anchor: input.anchor, value: input.value } });
    }
    expect(writes).toEqual([input, input]);
  });
  it('applies a present user\'s own UI change directly while agents keep the approval default', () => {
    // A person changing their own preference in Settings is not an agent-initiated Action.
    const ui = { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' } } as const;
    for (const id of ['settings.set', 'settings.reset'] as const) {
      const input = id === 'settings.set' ? { anchor: 'appearance.density', value: 'compact' } : { anchor: 'appearance.density' };
      expect(isApprovalRequiredByActionsSettings(id, actionsSettings, ui, undefined, undefined, input), id).toBe(false);
      for (const surface of ['agent', 'mcp', 'voice'] as const) {
        expect(isApprovalRequiredByActionsSettings(id, actionsSettings, { surface }, undefined, undefined, input), `${id}/${surface}`).toBe(true);
      }
      expect(isApprovalRequiredByActionsSettings(id, actionsSettings, { surface: 'ui', authority: 'account_automation', actionCaller: { kind: 'host' } }, undefined, undefined, input), `${id}/automation`).toBe(true);
    }
  });
  it('round-trips compound JSON settings through the same strict Action envelope', async () => {
    const value = { appRail: { orderedIds: ['plugin:removed', 'sessions'], placements: { sessions: 'overflow', 'plugin:removed': 'hidden' } } };
    // The answering UI is the process boundary; Protocol admission and snapshots stay real.
    const executor = createActionExecutor({ settingsDeclarationAction: async ({ input }: Parameters<NonNullable<ActionExecutorDeps['settingsDeclarationAction']>>[0]) => {
      expect(input).toEqual({ anchor: 'appearance.navigationPlacements', value });
      return { anchor: 'appearance.navigationPlacements', value };
    } } as unknown as ActionExecutorDeps);
    const context = { surface: 'ui', actionsSettings, authority: 'present_user', presentUserConfirmation: { actionId: 'settings.set' } } as const;
    expect(await executor.execute('settings.set', { anchor: 'appearance.navigationPlacements', value }, context))
      .toEqual({ ok: true, result: { anchor: 'appearance.navigationPlacements', value } });
    expect(await executor.execute('settings.set', { anchor: 'appearance.navigationPlacements', value, accountId: 'injected' }, context))
      .toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
    expect(await executor.execute('settings.set', { anchor: 'appearance.navigationPlacements', value: { bad: Number.NaN } }, context))
      .toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
  });
  it('admits typed exact operation input and validated result facts', async () => {
    // The answering UI is the process boundary; input/output admission stays real.
    const executor = createActionExecutor({ settingsDeclarationAction: async ({ input }: Parameters<NonNullable<ActionExecutorDeps['settingsDeclarationAction']>>[0]) => {
      expect(input).toEqual({ anchor: 'voiceAdvanced.modelPackInstall', input: { kind: 'model_pack', packId: 'stt-small', machineId: 'machine-a' } });
      return { anchor: 'voiceAdvanced.modelPackInstall', status: 'completed', value: { packId: 'stt-small', installed: true } };
    } } as unknown as ActionExecutorDeps);
    expect(await executor.execute('settings.invoke', {
      anchor: 'voiceAdvanced.modelPackInstall', input: { kind: 'model_pack', packId: 'stt-small', machineId: 'machine-a' },
    }, { surface: 'agent', actionsSettings })).toEqual({ ok: true, result: {
      anchor: 'voiceAdvanced.modelPackInstall', status: 'completed', value: { packId: 'stt-small', installed: true },
    } });
    expect(await executor.execute('settings.invoke', { anchor: 'voiceAdvanced.modelPackInstall',
      input: { kind: 'model_pack', packId: 'stt-small', accountId: 'injected' },
    }, { surface: 'agent', actionsSettings })).toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
  });

  it('discovers settings and invokes the same client settings owner from supported surfaces', async () => {
    const items = [{ anchor: 'appearance.density', pageId: 'appearance', title: 'Density',
      readable: true, writable: true, sensitive: false, storageScope: 'local' }];
    // The UI host is the process boundary; Protocol retains real admission and result validation.
    const deps = { settingsDeclarationAction: async ({ actionId }: { actionId: string }) => (
      actionId === 'settings.list' ? { items } : actionId === 'settings.invoke' ? { anchor: 'appearance.density', status: 'interaction_opened' } : { anchor: 'appearance.density', value: 'compact' }
    ) } as unknown as ActionExecutorDeps;
    const executor = createActionExecutor(deps);
    expect(await executor.execute('settings.list' as ActionId, {}, { surface: 'agent', actionsSettings }))
      .toEqual({ ok: true, result: { items } });
    const unconfirmed = await executor.execute('settings.set' as ActionId, { anchor: 'appearance.density', value: 'compact' }, { surface: 'mcp', actionsSettings });
    expect(unconfirmed, JSON.stringify(unconfirmed))
      .toMatchObject({ ok: false, errorCode: 'approvals_not_supported' });
    expect(await executor.execute('settings.set' as ActionId, { anchor: 'appearance.density', value: 'compact' }, {
      // The answering UI owns direct present-user confirmation; MCP requires an approval transport.
      surface: 'ui', actionsSettings, authority: 'present_user', presentUserConfirmation: { actionId: 'settings.set' },
    }))
      .toEqual({ ok: true, result: { anchor: 'appearance.density', value: 'compact' } });
    expect(await executor.execute('settings.invoke' as ActionId, { anchor: 'appearance.density' }, { surface: 'agent', actionsSettings }))
      .toEqual({ ok: true, result: { anchor: 'appearance.density', status: 'interaction_opened' } });
    for (const id of ['settings.list', 'settings.get', 'settings.set']) {
      expect(getActionSpec(id as ActionId).surfaces).toMatchObject({ ui: true, agent: true, mcp: true, cli: true });
    }
    expect(getActionSpec('settings.invoke').surfaces.cli).toBe(true);
  });

  it('rejects unknown selectors and malformed results without interpreting them as settings values', async () => {
    const executor = createActionExecutor({ settingsDeclarationAction: async () => ({ anchor: 'appearance.density' }) } as unknown as ActionExecutorDeps);
    const malformedInput = await executor.execute('settings.set' as ActionId, { anchor: 'appearance.density', value: 'compact', accountId: 'other' }, { surface: 'mcp', actionsSettings });
    expect(malformedInput, JSON.stringify(malformedInput))
      .toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
    expect(await executor.execute('settings.get' as ActionId, { anchor: 'appearance.density' }, { surface: 'agent', actionsSettings }))
      .toMatchObject({ ok: false, errorCode: 'invalid_action_output' });
  });
});
