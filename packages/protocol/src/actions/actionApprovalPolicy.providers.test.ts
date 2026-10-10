import { describe, expect, it } from 'vitest';
import type { ActionId } from './actionIds.js';

describe('Provider Settings present-user approval policy', () => {
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
      context: { surface: 'ui', authority: 'present_user' } })).toMatchObject({ required: true, flow: 'deferred' });
    const settings = ActionsSettingsV1Schema.parse({ v: 1, actions: {}, approvalWaivedSurfaces: { [actionId]: ['agent'] } });
    expect(resolveActionApprovalRouting({ actionId, spec, input, context, settings }).required).toBe(false);
  }, 60_000);

  it('routes dangerous Provider operations through the canonical UI approval owner', async () => {
    const { getActionSpec } = await import('./actionSpecs.js');
    const { resolveActionApprovalRouting } = await import('./actionApprovalPolicy.js');
    for (const id of ['providers.connections.enabled.set', 'providers.connections.delete', 'providers.probe',
      'providers.connections.start_local', 'providers.models.load', 'providers.models.experimental.confirm',
      'launch_profiles.legacy.convert', 'launch_profiles.legacy.resolve_conflict'] as const satisfies readonly ActionId[]) {
      expect(resolveActionApprovalRouting({ actionId: id, spec: getActionSpec(id),
        context: { surface: 'ui', authority: 'present_user' } })).toMatchObject({ required: true, flow: 'deferred' });
    }
  }, 60_000);
});
