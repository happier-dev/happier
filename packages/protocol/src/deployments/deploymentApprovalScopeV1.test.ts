import { describe, expect, it } from 'vitest';
import { createDeploymentApprovalScopeResolverV1, readDeploymentEnvironmentApprovalScopeV1, resolveInitialDeploymentApprovalV1 } from './deploymentApprovalScopeV1.js';
import { DeploymentEnvironmentHeaderV1Schema } from './deploymentActionsV1.js';
import { ActionsSettingsV1Schema, setScopedActionApprovalPreference } from '../actions/actionSettings.js';
import { resolveActionApprovalRouting } from '../actions/actionApprovalPolicy.js';
import { getActionSpec } from '../actions/actionSpecs.js';

function environment(id: string, preview = false) {
  return DeploymentEnvironmentHeaderV1Schema.parse({
    v: 1, id, serverId: 'home', projectSourceId: 'source', revision: 3,
    owner: { kind: 'account', accountId: 'owner' }, protection: 'nonProduction',
    purpose: preview ? 'preview' : 'standard', deployerMode: 'managers', dataEditorMode: 'off', dataAgentAccess: 'read',
    controllerMachineId: 'controller', runtimeTargetLinkId: `${id}-runtime`,
    ...(preview ? { previewTemplateEnvironmentId: 'template', previewRepositoryId: 'source',
      previewPullRequestId: id, previewTargetLinkId: 'template-runtime' } : {}),
    contentArtifactId: `${id}-content`, contentHeaderVersion: 1, contentBodyVersion: 1,
    capabilities: { role: 'manager', read: true, deploy: true, manage: true,
      manageBindings: true, manageTargets: true, delete: true },
    createdByAccountId: 'owner', createdAtMs: 1, updatedAtMs: 1,
  });
}

describe('initial deployment approval', () => {
  it('defaults non-person authoring to Ask without reading an Environment', async () => {
    let reads = 0;
    const initial = { serverId: 'home', environmentId: 'staging',
      read: async () => { reads++; return { ok: true as const, environment: environment('staging'), targetLinks: [] }; } };
    expect(await resolveInitialDeploymentApprovalV1({ ...initial,
      context: { surface: 'agent', authority: 'account_automation', runtimeAccountId: 'owner' } })).toEqual({ ok: true, mode: 'ask' });
    expect(reads).toBe(0);
    expect(await resolveInitialDeploymentApprovalV1({ ...initial, mode: 'automatic',
      context: { surface: 'agent', authority: 'account_automation', runtimeAccountId: 'owner' } })).toEqual({ ok: true, mode: 'automatic' });
    expect(reads).toBe(0);
  });
});

describe('preview template approval scope', () => {
  it('uses the projected main template for a named companion while preserving its own stricter approval', async () => {
    // The canonical header reader supplies this derived template relationship, not a stored companion preview row.
    const companion = { ...environment('companion'), previewCompanionOfEnvironmentId: 'main-preview',
      previewTemplateEnvironmentId: 'template' };
    const admitted = readDeploymentEnvironmentApprovalScopeV1(companion);
    expect(admitted).toEqual({ scope: { kind: 'environment', environmentId: companion.id, inheritedEnvironmentId: 'template' } });
    // Home approval metadata is the boundary; its strict parser and resolver stay real.
    const resolve = createDeploymentApprovalScopeResolverV1(async () => { throw new Error('Expected the metadata read'); },
      async () => ({ ok: true, environment: { id: companion.id, projectSourceId: companion.projectSourceId,
        purpose: companion.purpose, previewCompanionOfEnvironmentId: companion.previewCompanionOfEnvironmentId,
        previewTemplateEnvironmentId: companion.previewTemplateEnvironmentId } }));
    expect(await resolve({ actionId: 'deployments.deploy', input: { serverId: 'home', environmentId: companion.id },
      context: {}, phase: 'prepare' })).toEqual(admitted);
    if ('ok' in admitted || !admitted.scope) throw new Error('Expected companion template scope');
    const settings = setScopedActionApprovalPreference({ settings: ActionsSettingsV1Schema.parse({ v: 1 }),
      actionId: 'deployments.deploy', scope: { kind: 'environment', environmentId: 'template' }, surface: 'agent', mode: 'waived' });
    expect(resolveActionApprovalRouting({ actionId: 'deployments.deploy', spec: getActionSpec('deployments.deploy'),
      input: {}, context: { surface: 'agent' }, settings, approvalScope: admitted.scope }).required).toBe(false);
    const stricter = setScopedActionApprovalPreference({ settings, actionId: 'deployments.deploy',
      scope: { kind: 'environment', environmentId: companion.id }, surface: 'agent', mode: 'required' });
    expect(resolveActionApprovalRouting({ actionId: 'deployments.deploy', spec: getActionSpec('deployments.deploy'),
      input: {}, context: { surface: 'agent' }, settings: stricter, approvalScope: admitted.scope }).required).toBe(true);
  });
  it('retains the typed Environment validation refusal before a Link replay', async () => {
    const refusal = { ok: false as const, error: 'deployment_invalid' as const,
      diagnostic: { step: 'target_link.environment_read' as const, field: 'serverId', rule: 'invalid_type' as const } };
    // The Home metadata response is the boundary; the scope resolver stays real.
    const resolve = createDeploymentApprovalScopeResolverV1(async () => refusal);
    expect(await resolve({ actionId: 'deployments.targets.link',
      input: { serverId: 'home', environmentId: 'staging' }, context: {}, phase: 'replay' }))
      .toEqual({ ok: false, errorCode: 'deployment_invalid', error: 'deployment_invalid', details: refusal });
  });

  it('uses one live template preference for two children without child preference rows', async () => {
    const template = environment('template');
    const children = [environment('pr-one', true), environment('pr-two', true)];
    const rows = new Map([template, ...children].map(row => [row.id, row]));
    // The metadata transport is the boundary; resolver and preference routing stay real.
    const resolve = createDeploymentApprovalScopeResolverV1(async (_action, input) => {
      const id = (input as { environmentId: string }).environmentId;
      const row = rows.get(id);
      return row ? { ok: true, environment: row, targetLinks: [] }
        : { ok: false, errorCode: 'deployment_unavailable', error: 'deployment_unavailable' };
    });
    const scope = { kind: 'environment', environmentId: template.id } as const;
    let settings = setScopedActionApprovalPreference({ settings: ActionsSettingsV1Schema.parse({ v: 1 }),
      actionId: 'deployments.deploy', scope, surface: 'agent', mode: 'waived' });
    for (const child of children) {
      const admitted = await resolve({ actionId: 'deployments.deploy',
        input: { serverId: 'home', environmentId: child.id }, context: {}, phase: 'prepare' });
      expect(admitted).toEqual({ scope: { kind: 'environment', environmentId: child.id,
        inheritedEnvironmentId: template.id } });
      if ('ok' in admitted || !admitted.scope) throw new Error('Expected admitted template scope');
      expect(resolveActionApprovalRouting({ actionId: 'deployments.deploy', spec: getActionSpec('deployments.deploy'),
        input: {}, context: { surface: 'agent' }, settings, approvalScope: admitted.scope }).required).toBe(false);
      const stricter = setScopedActionApprovalPreference({ settings, actionId: 'deployments.deploy',
        scope: { kind: 'environment', environmentId: child.id }, surface: 'agent', mode: 'required' });
      expect(resolveActionApprovalRouting({ actionId: 'deployments.deploy', spec: getActionSpec('deployments.deploy'),
        input: {}, context: { surface: 'agent' }, settings: stricter, approvalScope: admitted.scope }).required).toBe(true);
    }
    settings = setScopedActionApprovalPreference({ settings, actionId: 'deployments.deploy', scope,
      surface: 'agent', mode: 'required' });
    for (const child of children) {
      const admitted = await resolve({ actionId: 'deployments.deploy',
        input: { serverId: 'home', environmentId: child.id }, context: {}, phase: 'dispatch' });
      if ('ok' in admitted || !admitted.scope) throw new Error('Expected admitted template scope');
      expect(resolveActionApprovalRouting({ actionId: 'deployments.deploy', spec: getActionSpec('deployments.deploy'),
        input: {}, context: { surface: 'agent' }, settings, approvalScope: admitted.scope }).required).toBe(true);
    }
    const unrelated = environment('unrelated');
    rows.set(unrelated.id, unrelated);
    expect(await resolve({ actionId: 'deployments.deploy', input: { serverId: 'home', environmentId: unrelated.id },
      context: {}, phase: 'prepare' })).toEqual({ scope: { kind: 'environment', environmentId: unrelated.id } });
  });
});

describe('database Action approval scope (P3 U3)', () => {
  const editsApply = 'happier.database/actions/edits/apply';
  const deploymentTarget = { kind: 'deployment_service', environment: { serverId: 'home', environmentId: 'staging',
    projectSourceId: 'source' }, deploymentId: 'deployment', targetLinkId: 'staging-runtime', serviceId: 'db', database: 'app' };
  const manualTarget = { kind: 'manual', accountId: 'owner', installationId: 'installation', projectKey: 'project',
    savedSecretId: 'secret', workspace: { serverId: 'home', machineId: 'machine', workspaceId: 'workspace', rootPath: '/project' } };

  it('reads the Environment named by a deployment database target and carries its agent level', async () => {
    const reads: unknown[] = [];
    // The Environment read is the Home boundary; the resolver stays real.
    const resolve = createDeploymentApprovalScopeResolverV1(async (_action, input) => {
      reads.push(input);
      return { ok: true, environment: { ...environment('staging'), dataEditorMode: 'managers', dataAgentAccess: 'none' }, targetLinks: [] };
    });
    expect(await resolve({ actionId: editsApply, input: { operation: 'edits.apply', target: deploymentTarget },
      context: {}, phase: 'prepare' })).toEqual({ scope: { kind: 'environment', environmentId: 'staging' },
      targetApproval: { databaseAgentLevel: 'none' } });
    expect(reads).toEqual([{ serverId: 'home', environmentId: 'staging' }]);
  });

  it('admits a Machine-local database target as global-only without an Environment read', async () => {
    let reads = 0;
    const resolve = createDeploymentApprovalScopeResolverV1(async () => { reads++; throw new Error('No Environment read expected'); });
    expect(await resolve({ actionId: editsApply, input: { operation: 'edits.apply', target: manualTarget },
      context: {}, phase: 'prepare' })).toEqual({ scope: null });
    expect(reads).toBe(0);
  });

  it('refuses a deployment database target that names another Project', async () => {
    const resolve = createDeploymentApprovalScopeResolverV1(async () => ({ ok: true,
      environment: { ...environment('staging'), projectSourceId: 'other' }, targetLinks: [] }));
    expect(await resolve({ actionId: editsApply, input: { operation: 'edits.apply', target: deploymentTarget },
      context: {}, phase: 'prepare' })).toMatchObject({ ok: false, errorCode: 'deployment_access_denied' });
  });
});
