import { describe, expect, it } from 'vitest';
import * as specs from './actionSpecs.js';
import { actionSpecToActionDefinitionV1, projectActionDefinitionForExternalDiscovery } from './actionCatalog.js';
import { isApprovalRequiredByActionsSettings, resolveActionApprovalRouting } from './actionApprovalPolicy.js';

describe('declaration-owned permission-changing disclosure', () => {
  it('admits a direct protection downgrade without classifying it as a permission mutation', () => {
    const spec = specs.getActionSpec('deployments.environments.update');
    const input = { serverId: 'home', environmentId: 'production', expectedRevision: 1,
      contentArtifactId: 'environment-content', contentHeaderVersion: 1, contentBodyVersion: 1,
      patch: { protection: 'nonProduction' } };
    // P40-Ad's static hint consumes the admitted protection edit; P44 alone
    // owns execution-Machine eligibility and exact-head approval at setup/dispatch.
    expect(spec.inputSchema.safeParse(input).success, 'the canonical closed update must admit the protection edit').toBe(true);
    expect(specs.resolveActionPermissionChangingV1(spec, input)).toBe(false);
    expect(resolveActionApprovalRouting({ actionId: spec.id, spec, input,
      context: { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' } } }).required).toBe(false);
  });
  it('projects administrator, isolation and approval mutations but not reads or ordinary preferences', () => {
    for (const id of ['machines.setup.adminAccess.set', 'machines.agentIsolation.set', 'actions.policy.set', 'actions.policy.reset'] as const) {
      const definition = actionSpecToActionDefinitionV1(specs.getActionSpec(id));
      expect(definition).toMatchObject({ permissionChanging: true });
      expect(projectActionDefinitionForExternalDiscovery(definition)).toMatchObject({ permissionChanging: true });
    }
    for (const id of ['machines.setup.adminAccess.inspect', 'machines.agentIsolation.preview', 'actions.policy.get', 'settings.get'] as const) {
      expect(actionSpecToActionDefinitionV1(specs.getActionSpec(id))).not.toMatchObject({ permissionChanging: true });
    }
  });

  it('derives mixed Settings from the admitted declaration, never a caller flag or sensitive label', () => {
    const resolve = specs.resolveActionPermissionChangingV1;
    const mixed = specs.getActionSpec('settings.set');
    expect(resolve(mixed)).toBe(true);
    expect(resolve(mixed, { anchor: 'actions.createSession.allowPermissionModeOverride', value: true })).toBe(true);
    const ordinary = { anchor: 'appearance.themeMode', value: 'dark' };
    expect(resolve(mixed, { ...ordinary, permissionChanging: true })).toBe(false);
    expect(actionSpecToActionDefinitionV1(mixed)).toMatchObject({ permissionChanging: true });
    const narrowed = actionSpecToActionDefinitionV1(mixed, { admittedInput: ordinary });
    expect(narrowed).not.toHaveProperty('permissionChanging');
    expect(projectActionDefinitionForExternalDiscovery(narrowed)).not.toHaveProperty('permissionChangingForInput');
    expect(resolve(specs.getActionSpec('settings.get'), { anchor: 'actions.createSession.allowPermissionModeOverride' })).toBe(false);
    expect(resolve({ ...mixed, permissionChanging: true, permissionChangingForInput: () => false }, {})).toBe(true);
    expect(isApprovalRequiredByActionsSettings('actions.policy.set', { v: 1, actions: {},
      approvalWaivedSurfaces: { 'actions.policy.set': ['agent'] } }, { surface: 'agent' })).toBe(false);
  });
});
