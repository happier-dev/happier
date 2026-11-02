import type { ActionSpecProjectionMetadata, PreNormalizedActionSpec } from '../actionSpecs.js';
import { DeploymentActionInputSchemasV1, DeploymentActionOutputSchemasV1, type DeploymentActionIdV1 } from '../../deployments/deploymentActionsV1.js';

function deploymentSpec<TId extends DeploymentActionIdV1>(id: TId, title: string, path: string | undefined, read = false) {
  return {
    id, title, safety: read ? 'safe' : 'danger', sideEffectClass: read ? 'read' : 'write',
    ...(id === 'deployments.templates.instantiate' ? { safetyForInput: (input: unknown): 'safe' | 'danger' => {
      const parsed = DeploymentActionInputSchemasV1['deployments.templates.instantiate'].safeParse(input);
      return parsed.success && parsed.data.mode === 'preview' ? 'safe' : 'danger';
    } } : {}),
    approval: { result: 'required' }, approvalPolicy: { uiConfirmation: id === 'deployments.teardown' ? 'policy' : 'direct' },
    ...(id === 'deployments.teardown' ? { irreversible: true as const } : {}),
    ...(id !== 'deployments.environments.create' && id !== 'deployments.environments.list' && id !== 'deployments.publish'
      ? { approvalScope: 'environment' } : {}),
    executionPlacement: id === 'deployments.prepare' || id === 'deployments.templates.instantiate' ? 'machine' : 'account', requiredAuthority: 'account_automation', placements: [],
    originalExecution: { accountRoot: 'allowed' },
    // Machine placement uses the original Action dispatcher, not a standalone RPC method.
    surfaces: { ui: true, cli: true, agent: true, mcp: true, voice: false, rpc: false },
    bindings: { mcpToolName: id.replaceAll('.', '_') },
    cli: { acceptsServerId: true, commands: [{ path: id.split('.'), visibility: 'canonical' }] },
    ...(path === undefined ? {} : { serverTransport: { method: read ? 'GET' : id === 'deployments.environments.update' ? 'PATCH' : 'POST', path, preservePathFieldsInBody: true } }),
    inputSchema: DeploymentActionInputSchemasV1[id], outputSchema: DeploymentActionOutputSchemasV1[id],
    inputHints: id === 'deployments.templates.instantiate' ? { fields: [
      { path: 'mode', title: 'Preview or apply', widget: 'text', required: true },
      { path: 'serverId', title: 'Home', widget: 'text', required: true },
      { path: 'machineId', title: 'Target Machine', widget: 'text', required: true },
      { path: 'projectSourceId', title: 'Project source', widget: 'text', required: true },
      { path: 'templateRef', title: 'Pinned registry app', widget: 'json', required: true },
      { path: 'environment', title: 'Environment', widget: 'json', required: true },
      { path: 'target', title: 'Runtime target', widget: 'json', required: true },
      { path: 'destination', title: 'Stored definition', widget: 'json', required: true },
      { path: 'bindings', title: 'Variable bindings', widget: 'json', required: true },
      { path: 'generatedSecretAudience', title: 'Generated credential audience', widget: 'json' },
      { path: 'connectTo', title: 'Connect application service', widget: 'json' },
      { path: 'replace', title: 'Explicit key replacements', widget: 'json' },
      { path: 'domainBindings', title: 'Domain bindings', widget: 'json' },
    ] } : id === 'deployments.prepare' ? { fields: [
      { path: 'projectSourceId', title: 'Project source', widget: 'text', required: true },
      { path: 'sourceRevision', title: 'Source revision', widget: 'number', required: true },
      { path: 'repository', title: 'Repository', widget: 'json', required: true },
      { path: 'baseCommit', title: 'Base commit', widget: 'text', required: true },
      { path: 'workspace', title: 'Workspace reference', widget: 'json', required: true },
      { path: 'environmentId', title: 'Environment', widget: 'text' },
      { path: 'target', title: 'Target reference', widget: 'json' },
    ] } : id === 'deployments.publish' ? { fields: [
      { path: 'serverId', title: 'Home', widget: 'text', required: true },
      { path: 'hostMachineId', title: 'Runs on Machine', widget: 'text' },
      { path: 'project', title: 'Project', widget: 'json', required: true },
      { path: 'definition', title: 'Definition', widget: 'json', required: true },
      { path: 'destination', title: 'Destination', widget: 'json', required: true },
      { path: 'environment', title: 'Environment', widget: 'json', required: true },
      { path: 'preparedChildren', title: 'Reviewed child inputs', widget: 'json', required: true },
    ] } : { fields: [
      { path: 'serverId', title: 'Home', widget: 'text', required: true },
      ...(id === 'deployments.environments.create' || id === 'deployments.environments.list'
        ? [{ path: 'projectSourceId', title: 'Project source', widget: 'text' as const, required: id === 'deployments.environments.create' }]
        : [{ path: 'environmentId', title: 'Environment', widget: 'text' as const, required: id !== 'deployments.receipts.get' }]),
      ...(id === 'deployments.environments.list'
        ? [{ path: 'machineId', title: 'Machine', widget: 'text' as const }] : []),
      ...(id === 'deployments.health.read' || id === 'deployments.drift.read' || id === 'deployments.logs.read' ? [
        { path: 'deploymentId', title: 'Active deployment', widget: 'text' as const, required: true },
        { path: 'targetLinkId', title: 'Deployment target', widget: 'text' as const, required: true },
        { path: 'machineId', title: 'Selected Machine', widget: 'text' as const, required: true },
        { path: 'installationId', title: 'Machine installation', widget: 'text' as const, required: true },
        { path: 'service', title: 'Stable service identity', widget: 'json' as const, required: id !== 'deployments.logs.read' },
        ...(id === 'deployments.drift.read' ? [{ path: 'expectedRevision', title: 'Environment revision', widget: 'number' as const, required: true }] : []),
        ...(id === 'deployments.logs.read' ? [{ path: 'kind', title: 'Build or runtime logs', widget: 'text' as const, required: true },
          { path: 'cursor', title: 'Native log cursor', widget: 'json' as const }] : []),
      ] : []),
      ...(id === 'deployments.receipts.get' || id === 'deployments.rollback' || id === 'deployments.cancel'
        ? [{ path: 'deploymentId', title: 'Deployment receipt', widget: 'text' as const, required: true }] : []),
      ...(id === 'deployments.cancel'
        ? [{ path: 'expectedReceiptRevision', title: 'Receipt revision', widget: 'number' as const, required: true }] : []),
      ...(id === 'deployments.environments.controller.set'
        ? [{ path: 'expectedRevision', title: 'Environment revision', widget: 'number' as const, required: true },
          { path: 'controllerMachineId', title: 'Controller Machine', widget: 'text' as const, required: true }] : []),
      ...(id === 'deployments.environments.update'
        ? [{ path: 'patch.buildMachineId', title: 'Build Machine', widget: 'text' as const, required: false }] : []),
      ...(id === 'deployments.environments.create'
        ? [{ path: 'firstTargetLink', title: 'First own-server target and prepared content', widget: 'json' as const }] : []),
      ...(id === 'deployments.deploy' ? [{ path: 'targetLinkId', title: 'Deployment target', widget: 'text' as const, required: true }] : []),
      ...(read || id === 'deployments.deploy' || id === 'deployments.cancel' || id === 'deployments.environments.controller.set' ? [] : [
        { path: 'contentArtifactId', title: 'Prepared content', widget: 'text' as const, required: true },
        { path: 'contentHeaderVersion', title: 'Content header revision', widget: 'number' as const, required: true },
        { path: 'contentBodyVersion', title: 'Content body revision', widget: 'number' as const, required: true },
      ]),
    ] },
    ...(id === 'deployments.templates.instantiate' || id === 'deployments.publish' || id === 'deployments.deploy' || id === 'deployments.rollback' || id === 'deployments.promote' || id === 'deployments.teardown' ? {
      operation: { version: 1, visibility: 'activity', progress: 'reported', presentation: { onStart: 'current' } },
    } : {}),
  } as const satisfies ActionSpecProjectionMetadata & Readonly<{
    id: TId; inputSchema: (typeof DeploymentActionInputSchemasV1)[TId]; outputSchema: (typeof DeploymentActionOutputSchemasV1)[TId];
    approval: { result: 'required' };
    requiredAuthority: 'account_automation';
  }>;
}

/** Storage declarations and real daemon effects share this single Action front door. */
export const DEPLOYMENT_ACTION_SPECS_V1 = [
  deploymentSpec('deployments.targets.unlink', 'Unlink deployment target', '/v1/deployments/environments/:environmentId/targets/:targetLinkId/unlink'),
  deploymentSpec('deployments.publish.prepare', 'Prepare catalog app publishing', undefined, true),
  deploymentSpec('deployments.environments.delete', 'Delete deployment environment', '/v1/deployments/environments/:environmentId/delete'),
  deploymentSpec('deployments.domains.add', 'Add or update deployment domain', '/v1/deployments/environments/:environmentId/domains'),
  deploymentSpec('deployments.domains.remove', 'Remove deployment domain', '/v1/deployments/environments/:environmentId/domains/:domainId/remove'),
  deploymentSpec('deployments.domains.verify', 'Verify deployment domain', undefined, true),
  deploymentSpec('deployments.domains.get', 'Read deployment domain', '/v1/deployments/environments/:environmentId/domains/:domainId', true),
  deploymentSpec('deployments.domains.list', 'List deployment domains', '/v1/deployments/environments/:environmentId/domains', true),
  deploymentSpec('deployments.templates.instantiate', 'Instantiate deployment template', undefined),
  deploymentSpec('deployments.publish', 'Publish reviewed deployment', undefined),
  deploymentSpec('deployments.prepare', 'Ask an agent to prepare deployment', undefined),
  deploymentSpec('deployments.health.read', 'Read deployed service health', undefined, true),
  deploymentSpec('deployments.drift.read', 'Read deployed service drift', undefined, true),
  deploymentSpec('deployments.logs.read', 'Read deployment logs', undefined, true),
  deploymentSpec('deployments.environments.create', 'Create deployment environment', '/v1/deployments/environments'),
  deploymentSpec('deployments.environments.update', 'Update deployment environment', '/v1/deployments/environments/:environmentId'),
  deploymentSpec('deployments.environments.controller.set', 'Change environment controller', '/v1/deployments/environments/:environmentId/controller'),
  deploymentSpec('deployments.targets.link', 'Link deployment target', '/v1/deployments/environments/:environmentId/targets'),
  deploymentSpec('deployments.deploy', 'Deploy environment', '/v1/deployments/environments/:environmentId/deploy'),
  deploymentSpec('deployments.rollback', 'Roll back deployment', '/v1/deployments/environments/:environmentId/rollback'),
  deploymentSpec('deployments.cancel', 'Cancel deployment', '/v1/deployments/environments/:environmentId/deployments/:deploymentId/transitions'),
  deploymentSpec('deployments.promote', 'Promote deployment', '/v1/deployments/environments/:environmentId/promote'),
  deploymentSpec('deployments.teardown', 'Tear down deployment resources', '/v1/deployments/environments/:environmentId/teardown'),
  deploymentSpec('deployments.environments.get', 'Read deployment environment', '/v1/deployments/environments/:environmentId', true),
  deploymentSpec('deployments.receipts.get', 'Read deployment receipt', '/v1/deployments/receipts/:deploymentId', true),
  deploymentSpec('deployments.bindings.set', 'Set environment bindings', '/v1/deployments/environments/:environmentId/bindings'),
  deploymentSpec('deployments.environments.list', 'List deployment environments', '/v1/deployments/environments', true),
  deploymentSpec('deployments.receipts.list', 'List deployment receipts', '/v1/deployments/environments/:environmentId/deployments', true),
] as const satisfies readonly PreNormalizedActionSpec[];
