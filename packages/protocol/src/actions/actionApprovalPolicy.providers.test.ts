import { describe, expect, it } from 'vitest';
import type { ActionId } from './actionIds.js';
import { resolveSocketRpcSessionAuthorization } from '../rpc/index.js';

describe('Provider Settings present-user approval policy', () => {
  it('honors declared local confirmation for every Provider, connected-service, pool and Saved Secret UI family', async () => {
    const { PROVIDER_ACTION_IDS_V1 } = await import('../providers/providerActionIdsV1.js');
    const { CONNECTED_SERVICE_CONFIGURATION_ACTION_IDS_V1 } = await import('../connect/configurationActionIdsV1.js');
    const { PERSONAL_SAVED_SECRET_ACTION_IDS_V1 } = await import('../account/settings/personalSavedSecretActionIdsV1.js');
    const { SHARED_SAVED_SECRET_ACTION_IDS_V1 } = await import('../account/settings/savedSecretResourceActionIdsV1.js');
    const { getActionSpec } = await import('./actionSpecs.js');
    const { resolveActionApprovalRouting } = await import('./actionApprovalPolicy.js');
    const family = new Set<ActionId>([...PROVIDER_ACTION_IDS_V1, ...CONNECTED_SERVICE_CONFIGURATION_ACTION_IDS_V1,
      ...PERSONAL_SAVED_SECRET_ACTION_IDS_V1, ...SHARED_SAVED_SECRET_ACTION_IDS_V1]);
    const reached = [...family].filter(actionId => getActionSpec(actionId).surfaces.ui);
    expect(reached.length).toBeGreaterThan(0);
    for (const actionId of reached) {
      const spec = getActionSpec(actionId);
      const context = { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' } } as const;
      const declaredConfirmation = spec.approvalPolicy?.uiConfirmationForInput?.(undefined)
        ?? (spec.approvalPolicy?.uiConfirmation === 'policy'
          || spec.approvalPolicy?.uiConfirmation !== 'direct' && spec.irreversible === true);
      expect(resolveActionApprovalRouting({ actionId, spec, context }).required, actionId).toBe(declaredConfirmation);
      expect(resolveActionApprovalRouting({ actionId, spec, context: {
        ...context, presentUserConfirmation: { actionId },
      } }).required, actionId).toBe(false);
    }
  }, 60_000);
  it.each(['providers.connections.enable_detected', 'providers.connections.endpoint.set', 'teams.credentials.delete'] as const)(
    'retains the designed local confirmation for %s until that exact confirmation completes', async actionId => {
      const { getActionSpec } = await import('./actionSpecs.js');
      const { resolveActionApprovalRouting } = await import('./actionApprovalPolicy.js');
      const context = { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' } } as const;
      const args = { actionId, spec: getActionSpec(actionId), context };
      expect(resolveActionApprovalRouting(args).required).toBe(true);
      expect(resolveActionApprovalRouting({ ...args, context: {
        ...context, presentUserConfirmation: { actionId },
      } }).required).toBe(false);
    }, 60_000,
  );
  it.each(['providers.connections.create_custom', 'providers.probe'] as const)(
    'admits the person’s direct %s while retaining agent and MCP approval', async actionId => {
      const { getActionSpec } = await import('./actionSpecs.js');
      const { resolveActionApprovalRouting } = await import('./actionApprovalPolicy.js');
      const spec = getActionSpec(actionId);
      expect(resolveActionApprovalRouting({ actionId, spec,
        context: { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' } } }).required).toBe(false);
      for (const surface of ['agent', 'mcp'] as const) {
        expect(resolveActionApprovalRouting({ actionId, spec,
          context: { surface, authority: 'account_automation' } }).required).toBe(true);
      }
    }, 60_000,
  );
  it('does not promote Session RPC authority into the person’s direct UI decision', async () => {
    const { getActionSpec } = await import('./actionSpecs.js');
    const { resolveActionApprovalRouting } = await import('./actionApprovalPolicy.js');
    const actionId = 'providers.connections.create_custom';
    const rpcSessionAuthorization = resolveSocketRpcSessionAuthorization('session:abort');
    expect(rpcSessionAuthorization).toBeTruthy();
    expect(resolveActionApprovalRouting({ actionId, spec: getActionSpec(actionId), context: {
      surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' }, rpcSessionAuthorization,
    } }).required).toBe(true);
  }, 60_000);
  it.each(['providers.connections.create_contribution', 'providers.connections.create_custom',
    'providers.connections.enable_detected', 'providers.connections.start_local', 'providers.connections.update',
    'providers.connections.endpoint.set', 'providers.connections.duplicate', 'providers.connections.enabled.set',
    'providers.connections.secrets.bind', 'providers.models.load', 'providers.models.cancel_load',
    'providers.probe', 'providers.legacy.prepare', 'providers.connections.delete',
    'providers.models.experimental.confirm', 'connectedServices.configuration.replace',
    'connectedServices.accounts.revoke', 'secrets.delete'] as const)(
    'retains explicit Ask and automation approval for %s', async actionId => {
      const { getActionSpec } = await import('./actionSpecs.js');
      const { resolveActionApprovalRouting } = await import('./actionApprovalPolicy.js');
      const { ActionsSettingsV1Schema } = await import('./actionSettings.js');
      const spec = getActionSpec(actionId);
      const context = { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' } } as const;
      const settings = ActionsSettingsV1Schema.parse({ v: 1, actions: { [actionId]: { approvalRequiredSurfaces: ['ui'] } } });
      expect(resolveActionApprovalRouting({ actionId, spec, context, settings }).required).toBe(true);
      for (const surface of ['agent', 'mcp', 'cli', 'ui'] as const) {
        expect(resolveActionApprovalRouting({ actionId, spec,
          context: { surface, authority: 'account_automation' } }).required, surface).toBe(true);
      }
      expect(resolveActionApprovalRouting({ actionId, spec, context: { ...context,
        actionCaller: { kind: 'plugin', pluginId: 'unrelated-plugin' } } }).required).toBe(true);
    }, 60_000,
  );
  it('admits guarded first configuration writes while retaining replacement and automation review', async () => {
    const { getActionSpec } = await import('./actionSpecs.js');
    const { resolveActionApprovalRouting } = await import('./actionApprovalPolicy.js');
    const actionId = 'connectedServices.configuration.replace';
    const spec = getActionSpec(actionId);
    for (const target of [
      { service: { pluginId: 'happier.machine.vercel', localId: 'vercel-account' }, modeId: 'token' },
      { target: { kind: 'attempt', attemptId: 'attempt' } },
    ]) {
      const input = { ...target, expectedRevision: null, values: {}, secretValues: {} };
      expect(spec.inputSchema.safeParse(input).success).toBe(true);
      const context = { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' } } as const;
      expect(resolveActionApprovalRouting({ actionId, spec, input, context }).required).toBe(false);
      expect(resolveActionApprovalRouting({ actionId, spec, input: { ...input, expectedRevision: 'existing' }, context }).required).toBe(true);
      expect(resolveActionApprovalRouting({ actionId, spec, input, context: { surface: 'agent', authority: 'account_automation' } }).required).toBe(true);
    }
  }, 60_000);
  it('uses the same safe label-write approval floor for connected-account rename and labels.set', async () => {
    const { getActionSpec } = await import('./actionSpecs.js');
    const { resolveActionApprovalRouting } = await import('./actionApprovalPolicy.js');
    const { ActionsSettingsV1Schema } = await import('./actionSettings.js');
    for (const actionId of ['connectedServices.accounts.rename', 'connectedServices.labels.set'] as const) {
      for (const surface of ['ui', 'agent', 'mcp', 'cli'] as const) {
        const spec = getActionSpec(actionId);
        const context = { surface, authority: surface === 'ui' ? 'present_user' as const : 'account_automation' as const };
        expect(resolveActionApprovalRouting({ actionId, spec, context }).required, `${actionId}/${surface}`).toBe(false);
        const settings = ActionsSettingsV1Schema.parse({ v: 1, actions: { [actionId]: { approvalRequiredSurfaces: [surface] } } });
        expect(resolveActionApprovalRouting({ actionId, spec, context, settings }).required).toBe(true);
      }
    }
  }, 60_000);
  it('keeps the reached preference and experimental approvals configurable and waivable', async () => {
    const { getActionSpec } = await import('./actionSpecs.js');
    const { resolveActionApprovalRouting } = await import('./actionApprovalPolicy.js');
    const { ActionsSettingsV1Schema } = await import('./actionSettings.js');
    for (const actionId of ['settings.set', 'providers.connections.update', 'models.favorite.set',
      'session.model.unarm', 'providers.models.experimental.confirm'] as const) {
      for (const surface of ['ui', 'agent', 'mcp', 'cli'] as const) {
        const context = { surface, authority: surface === 'ui' ? 'present_user' as const : 'account_automation' as const };
        const spec = getActionSpec(actionId);
        const waived = ActionsSettingsV1Schema.parse({ v: 1, approvalWaivedSurfaces: { [actionId]: [surface] } });
        expect(resolveActionApprovalRouting({ actionId, spec, context, settings: waived }).required, `${actionId}/${surface}`).toBe(false);
        const ask = ActionsSettingsV1Schema.parse({ v: 1, actions: { [actionId]: { approvalRequiredSurfaces: [surface] } } });
        expect(resolveActionApprovalRouting({ actionId, spec, context, settings: ask }).required, `${actionId}/${surface}`).toBe(true);
      }
    }
  }, 60_000);
  it('keeps display-only updates safe but fails malformed or consequential updates closed', async () => {
    const { getActionSpec } = await import('./actionSpecs.js');
    const { resolveActionApprovalRouting } = await import('./actionApprovalPolicy.js');
    const actionId = 'providers.connections.update';
    const spec = getActionSpec(actionId);
    const rename = { action: 'update', connectionId: 'pc_gateway', expectedRevision: 2, displayName: 'My gateway' };
    for (const surface of ['agent', 'ui', 'cli', 'mcp'] as const) {
      const context = { surface, authority: 'account_automation' } as const;
      expect(resolveActionApprovalRouting({ actionId, spec, input: rename, context }).required).toBe(false);
      for (const input of [undefined, { ...rename, gatewayPlacement: null }, { ...rename, claudeHelperModels: {} },
        { ...rename, template: {} }, { ...rename, unexpected: true }]) {
        expect(resolveActionApprovalRouting({ actionId, spec, input, context }).required).toBe(true);
      }
    }
  }, 60_000);
  it('exposes every Provider and routing action family to agents with approval on credential and subscription mutations', async () => {
    const { getActionSpec } = await import('./actionSpecs.js');
    const { resolveActionApprovalRouting } = await import('./actionApprovalPolicy.js');
    const dangerous = [
      'providers.connections.create_contribution', 'providers.connections.create_custom',
      'providers.connections.update', 'providers.connections.delete',
      'providers.connections.endpoint.set', 'providers.connections.secrets.bind',
      'providers.connections.enabled.set', 'connectedServices.configuration.replace',
    ] as const satisfies readonly ActionId[];
    const preferencesAndReads = [
      'providers.models.manual.add', 'providers.models.manual.remove',
      'providers.models.visibility.set', 'providers.models.source_visibility.set',
      'providers.defaults.set', 'connectedServices.configuration.get', 'session.model.set',
      'execution.run.start', 'review.start', 'subagents.plan.start',
      'subagents.delegate.start', 'voice_agent.start',
    ] as const satisfies readonly ActionId[];
    for (const id of [...dangerous, ...preferencesAndReads]) {
      const spec = getActionSpec(id);
      expect(spec.surfaces.agent, id).toBe(true);
      expect(spec.surfaces.cli, id).toBe(true);
      expect(spec.surfaces.mcp, id).toBe(true);
    }
    for (const id of dangerous) {
      expect(resolveActionApprovalRouting({ actionId: id, spec: getActionSpec(id),
        context: { surface: 'agent', authority: 'account_automation' } }), id)
        .toMatchObject({ required: true });
    }
    for (const id of preferencesAndReads) {
      expect(resolveActionApprovalRouting({ actionId: id, spec: getActionSpec(id),
        context: { surface: 'agent', authority: 'account_automation' } }), id)
        .toMatchObject({ required: false });
    }
  }, 60_000);

  it('requires approval for gateway routing changes and honors the existing per-surface waiver', async () => {
    const { getActionSpec } = await import('./actionSpecs.js');
    const { resolveActionApprovalRouting } = await import('./actionApprovalPolicy.js');
    const { ActionsSettingsV1Schema } = await import('./actionSettings.js');
    const actionId = 'providers.connections.update';
    const spec = getActionSpec(actionId);
    const input = spec.inputSchema.parse({ action: 'update', connectionId: 'pc_gateway', expectedRevision: 2,
      deployment: { kind: 'managedLocal', purposeBindingDefaults: {
        upstream: { kind: 'group', service: { pluginId: 'example.auth', localId: 'subscription' }, groupId: 'pool' },
      } }, gatewayPlacement: { kind: 'machine', machineId: 'hub' }, claudeHelperModels: { fast: 'fast-model' } });
    const context = { surface: 'agent', authority: 'account_automation' } as const;
    expect(resolveActionApprovalRouting({ actionId, spec, input, context }).required).toBe(true);
    expect(resolveActionApprovalRouting({ actionId, spec, input,
      context: { surface: 'ui', authority: 'present_user' } })).toMatchObject({ required: false });
    const settings = ActionsSettingsV1Schema.parse({ v: 1, actions: {}, approvalWaivedSurfaces: { [actionId]: ['agent'] } });
    expect(resolveActionApprovalRouting({ actionId, spec, input, context, settings }).required).toBe(false);
  }, 60_000);

  it('retains declared local confirmation for irreversible and explicit Provider operations', async () => {
    const { getActionSpec } = await import('./actionSpecs.js');
    const { resolveActionApprovalRouting } = await import('./actionApprovalPolicy.js');
    for (const id of ['providers.connections.delete', 'providers.models.experimental.confirm',
      'launch_profiles.legacy.convert', 'launch_profiles.legacy.resolve_conflict'] as const satisfies readonly ActionId[]) {
      expect(resolveActionApprovalRouting({ actionId: id, spec: getActionSpec(id),
        context: { surface: 'ui', authority: 'present_user' } })).toMatchObject({ required: true });
    }
  }, 60_000);
});
