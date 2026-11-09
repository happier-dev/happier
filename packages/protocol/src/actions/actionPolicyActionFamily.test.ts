import { describe, expect, it } from 'vitest';
import { ActionsSettingsV1Schema } from './actionSettings.js';
import { ActionPolicyInputSchemas } from './actionPolicyActionFamily.js';
import { applyActionPolicyMutation, readActionAudiencePolicy, setActionAudiencePolicy } from './actionAudiencePolicy.js';
import { getActionSpec } from './actionSpecs.js';
import { zodSchemaToJsonSchemaObject } from './actionInputJsonSchema.js';

describe('exact Action audience policy', () => {
  it('stores foreign HTML choices independently from ordinary policy and defaults Actions and Resources off', () => {
    const initial = ActionsSettingsV1Schema.parse({ v: 1, actions: {
      'session.message.send': { disabledSurfaces: ['mcp'], approvalRequiredSurfaces: ['cli'] },
    } });
    for (const actionId of ['session.message.send', 'session.stop', 'acme.preview/actions/open', 'acme.preview/resources/status']) {
      const target = { actionId, audience: 'foreign_session_html' as const };
      expect(readActionAudiencePolicy(initial, actionId, target.audience)).toMatchObject({ enabled: false, mode: 'default' });
      const allowed = applyActionPolicyMutation(initial, ActionPolicyInputSchemas['actions.policy.set'].parse({ ...target, mode: 'allowed' }));
      expect(allowed.result).toMatchObject({ enabled: true, mode: 'allowed' });
      expect(allowed.settings.actions).toEqual(initial.actions);
      const roundTrip = ActionsSettingsV1Schema.parse(JSON.parse(JSON.stringify(allowed.settings)));
      expect(readActionAudiencePolicy(roundTrip, actionId, target.audience)).toMatchObject({ enabled: true });
      const reset = applyActionPolicyMutation(roundTrip, ActionPolicyInputSchemas['actions.policy.set'].parse({ ...target, mode: 'default' }));
      expect(reset.result).toMatchObject({ enabled: false, mode: 'default' });
      expect(ActionPolicyInputSchemas['actions.policy.set'].safeParse({ ...target, mode: 'allowed', scope: { kind: 'environment', environmentId: 'project' } }).success).toBe(false);
    }
  });
  it('admits exact scoped approval edits and explicit orphan removal without changing global enablement', () => {
    const scope = { kind: 'environment', environmentId: 'staging' } as const;
    const sibling = { actionId: 'future.action', scope: { kind: 'machine', machineId: 'deleted' },
      approvalRequiredSurfaces: ['agent'], approvalWaivedSurfaces: [] };
    const initial = ActionsSettingsV1Schema.parse({ v: 1, actions: { 'session.stop': {
      enabled: false, approvalRequiredSurfaces: ['agent'],
    } }, scopedApprovalPreferences: [sibling] });
    const target = { actionId: 'session.stop', audience: 'agent', scope } as const;
    const allowed = applyActionPolicyMutation(initial, ActionPolicyInputSchemas['actions.policy.set'].parse({ ...target, mode: 'allowed' }));
    expect(allowed.result).toMatchObject({ ...target, mode: 'allowed', actionEnabled: false, enabled: false });
    expect(allowed.settings.actions).toEqual(initial.actions);
    expect(allowed.settings.scopedApprovalPreferences).toEqual([sibling, { actionId: target.actionId, scope,
      approvalRequiredSurfaces: [], approvalWaivedSurfaces: ['agent'] }]);
    const reset = applyActionPolicyMutation(allowed.settings,
      ActionPolicyInputSchemas['actions.policy.set'].parse({ ...target, mode: 'default' }));
    expect(reset.settings.scopedApprovalPreferences).toEqual([sibling]);
    const removed = applyActionPolicyMutation(reset.settings, ActionPolicyInputSchemas['actions.policy.set'].parse({
      actionId: sibling.actionId, change: { kind: 'scoped_approval_remove', scope: sibling.scope },
    }));
    expect(removed.settings.scopedApprovalPreferences).toEqual([]);
    expect(removed.settings.actions).toEqual(initial.actions);
    expect(ActionPolicyInputSchemas['actions.policy.set'].safeParse({ ...target, mode: 'off' }).success).toBe(false);
    expect(ActionPolicyInputSchemas['actions.policy.set'].safeParse({ ...target, mode: 'allowed',
      scope: { ...scope, machineId: 'spoof' } }).success).toBe(false);
  });
  it('admits the existing Settings controls as typed policy intents without raw policy operands', async () => {
    const schema = getActionSpec('actions.policy.set').inputSchema;
    for (const change of [
      { kind: 'enabled', enabled: false },
      { kind: 'audience_enabled', audience: 'agent', enabled: false },
      { kind: 'placement', placement: 'session_header', enabled: false },
      { kind: 'placement_policy', placement: 'slash_command', mode: 'ask_first' },
      { kind: 'tool_exposure', surface: 'mcp', mode: 'discoverable_only' },
      { kind: 'plugin_host_capture', pluginId: 'acme.capture', approvalRequired: false },
    ]) {
      const input = { actionId: 'capture.view', change };
      expect(schema.safeParse(input).success, JSON.stringify(change)).toBe(true);
      expect(schema.safeParse({ ...input, actionsSettingsV1: { v: 1, actions: {} } }).success).toBe(false);
      expect(schema.safeParse({ ...input, change: { ...change, extra: true } }).success).toBe(false);
    }
    const { applyActionPolicyMutation } = await import('./actionAudiencePolicy.js');
    let settings = ActionsSettingsV1Schema.parse({ v: 1, actions: {
      'capture.view': { disabledSurfaces: ['cli'], futurePolicy: { retained: true } },
      'session.stop': { enabled: false },
    }, pluginHostCaptureApprovalWaived: ['neighbor.plugin'] });
    for (const change of [
      { kind: 'enabled', enabled: false },
      { kind: 'audience_enabled', audience: 'agent', enabled: false },
      { kind: 'placement', placement: 'agent_input_chips', enabled: true },
      { kind: 'placement_policy', placement: 'slash_command', mode: 'ask_first' },
      { kind: 'tool_exposure', surface: 'mcp', mode: 'discoverable_only' },
      { kind: 'plugin_host_capture', pluginId: 'acme.capture', approvalRequired: false },
    ]) {
      const input = ActionPolicyInputSchemas['actions.policy.set'].parse({
        actionId: change.kind === 'tool_exposure' ? 'settings.get' : 'capture.view', change,
      });
      const applied = applyActionPolicyMutation(settings, input);
      settings = applied.settings;
      expect(applied.result).toEqual(input);
    }
    expect(settings.actions['capture.view']).toMatchObject({ enabled: false, disabledSurfaces: ['cli', 'agent'],
      enabledPlacements: ['agent_input_chips'], approvalRequiredSurfaces: ['ui'], futurePolicy: { retained: true } });
    expect(settings.actions['settings.get']?.toolExposureModes).toEqual({ mcp: 'discoverable_only' });
    expect(settings.actions['session.stop']?.enabled).toBe(false);
    expect(settings.pluginHostCaptureApprovalWaived).toEqual(['neighbor.plugin', 'acme.capture']);
  });

  it('preserves a contributed Action and opaque neighbour while resetting only the requested audience', () => {
    const actionId = 'example.sources/actions/merge-v1';
    const settings = ActionsSettingsV1Schema.parse({ v: 1, actions: {
      [actionId]: { enabled: false, disabledSurfaces: ['cli', 'agent'], approvalRequiredSurfaces: ['mcp'],
        futurePolicy: { retained: true } },
      'future.action': { enabled: false, futurePreference: 'retained' },
    } });
    expect(ActionPolicyInputSchemas['actions.policy.set'].parse({ actionId, audience: 'agent', mode: 'allowed' }))
      .toEqual({ actionId, audience: 'agent', mode: 'allowed' });
    const allowed = setActionAudiencePolicy(settings, actionId, 'agent', 'allowed');
    expect(readActionAudiencePolicy(allowed, actionId, 'agent')).toEqual({ actionId, audience: 'agent', mode: 'allowed',
      actionEnabled: false, enabled: false });
    const reset = setActionAudiencePolicy(allowed, actionId, 'agent', 'default');
    expect(reset.actions[actionId]).toMatchObject({ enabled: false, disabledSurfaces: ['cli'], approvalRequiredSurfaces: ['mcp'],
      futurePolicy: { retained: true } });
    expect(reset.actions['future.action']).toEqual(settings.actions['future.action']);
    expect(reset.approvalWaivedSurfaces?.[actionId]).toBeUndefined();
  });

  it('publishes strict discoverable schemas without admitting raw policy or an unknown host Action', () => {
    const input = { actionId: 'prompt_doc.update', audience: 'agent', mode: 'allowed' };
    const schema = getActionSpec('actions.policy.set').inputSchema;
    expect(schema.safeParse(input).success).toBe(true);
    expect(schema.safeParse({ ...input, actionId: 'unknown.action' }).success).toBe(false);
    expect(schema.safeParse({ ...input, confirmed: true }).success).toBe(false);
    expect(schema.safeParse({ ...input, actionsSettingsV1: { v: 1, actions: {} } }).success).toBe(false);
    expect(zodSchemaToJsonSchemaObject(schema)).toMatchObject({ anyOf: expect.arrayContaining([
      expect.objectContaining({ type: 'object', additionalProperties: false,
        properties: expect.objectContaining({ actionId: expect.objectContaining({ type: 'string' }),
          audience: expect.objectContaining({ type: 'string' }), mode: expect.objectContaining({ type: 'string' }) }) }),
    ]) });
  });
});
