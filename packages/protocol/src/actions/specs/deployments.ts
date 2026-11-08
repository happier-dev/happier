import { lazyActionSpecArray } from '../lazyActionSpecValue.js';
import { deploymentTeardownOperationReentryV1 } from '../operations/v1.js';
import type { ActionSpecProjectionMetadata, PreNormalizedActionSpec } from './definition.js';
import { createDeploymentDeployActionCompletionV1 } from '../actionCompletion.js';
import { DeploymentActionInputSchemasV1, DeploymentActionOutputSchemasV1, type DeploymentActionIdV1 } from '../../deployments/deploymentActionsV1.js';
import { deploymentBindingSelectionNarrowing } from '../../deployments/deploymentBindingSelectionNarrowing.js';
import { readRecord } from '../../inputs/inputRecords.js';
import { actionInputServerId } from './definition.js';
import { isDeploymentBackupActionIdV1, isDeploymentBackupReadActionIdV1, isDeploymentDomainRemoveActionIdV1, isDeploymentPromoteActionIdV1 } from '../../deployments/deploymentActionIdsV1.js';
import { isDeploymentNativeReadActionIdV1 } from '../../deployments/deploymentReadAdmissionV1.js';

const deploymentDeployActionCompletionV1 = createDeploymentDeployActionCompletionV1(DeploymentActionOutputSchemasV1['deployments.deploy']);

type DeploymentActionSpec<TId extends DeploymentActionIdV1> = ActionSpecProjectionMetadata & Readonly<{
  id: TId;
  inputSchema: (typeof DeploymentActionInputSchemasV1)[TId];
  outputSchema: (typeof DeploymentActionOutputSchemasV1)[TId];
  approval: { result: 'required' };
  requiredAuthority: 'account_automation';
}>;

function deploymentSpec<TId extends DeploymentActionIdV1>(id: TId, title: string, path: string | undefined, read = false): DeploymentActionSpec<TId> {
  const backup = isDeploymentBackupActionIdV1(id);
  const irreversible = id === 'deployments.backups.prune' || id === 'deployments.backups.restore' || id === 'deployments.teardown' || id === 'deployments.targets.unlink' || id === 'deployments.environments.delete' || id === 'deployments.domains.remove';
  const preparedContentRequired = id !== 'deployments.environments.create' && id !== 'deployments.targets.link'
    && id !== 'deployments.rollback' && id !== 'deployments.teardown' && id !== 'deployments.domains.add' && !isDeploymentPromoteActionIdV1(id);
  const previewForInput = id === 'deployments.templates.instantiate' || id === 'deployments.environments.create' || id === 'deployments.teardown'
    ? (input: unknown): boolean => {
      const parsed = DeploymentActionInputSchemasV1[id].safeParse(input);
      return parsed.success && 'mode' in parsed.data && parsed.data.mode === 'preview';
    } : undefined;
  const secretPath = id === 'deployments.bindings.set' ? 'set.[].source.ref'
    : id === 'deployments.templates.instantiate' || id === 'deployments.environments.create' ? 'bindings.[].source.ref' : null;
  const inputHints = backup ? { fields: [
      { path: 'serverId', title: 'Home', widget: 'text', required: true },
      { path: 'environmentId', title: 'Environment', widget: 'text', required: true },
      { path: 'machineId', title: 'Runtime Machine', widget: 'text', required: true },
      { path: 'installationId', title: 'Machine installation', widget: 'text', required: true },
      { path: 'targetLinkId', title: 'Deployment target', widget: 'text', required: true },
      { path: 'deploymentId', title: 'Deployment receipt', widget: 'text', required: true },
      { path: 'expectedRevision', title: 'Environment revision', widget: 'number', required: true },
      { path: 'configRevision', title: 'Backup configuration revision', widget: 'number', required: true },
      ...(id === 'deployments.backups.verify' ? [
        { path: 'backupOperationId', title: 'Exact capture operation', widget: 'text' as const, required: true },
        { path: 'snapshotId', title: 'Exact snapshot', widget: 'text' as const, required: true },
        { path: 'level', title: 'Verification level', widget: 'text' as const, required: true },
      ] : []),
      ...(id === 'deployments.backups.prune' ? [
        { path: 'retention', title: 'Chosen retention policy', widget: 'json' as const, required: true },
      ] : []),
    ] } as const : id === 'deployments.backups.restore' ? { fields: [
      { path: 'mode', title: 'Prepare or confirm restore', widget: 'text', required: true },
      { path: 'serverId', title: 'Home', widget: 'text', required: true },
      { path: 'environmentId', title: 'Environment', widget: 'text', required: true },
      { path: 'machineId', title: 'Runtime Machine', widget: 'text', required: true },
      { path: 'installationId', title: 'Machine installation', widget: 'text', required: true },
      { path: 'targetLinkId', title: 'Current deployment target', widget: 'text', required: true },
      { path: 'deploymentId', title: 'Backup capture receipt', widget: 'text', required: true },
      { path: 'restoreBackupId', title: 'Backup', widget: 'text', required: true },
      { path: 'expectedRevision', title: 'Environment revision', widget: 'number', required: true },
      { path: 'prepareOperationId', title: 'Prepared restore operation', widget: 'text' },
    ] } as const : id === 'deployments.publish.prepare' ? { fields: [
      { path: 'serverId', title: 'Home', widget: 'text', required: true },
      { path: 'machineId', title: 'Runtime Machine', widget: 'text', required: true },
      { path: 'installationId', title: 'Machine installation', widget: 'text', required: true },
      { path: 'projectSourceId', title: 'Existing Project source', widget: 'text' },
      { path: 'sourceRevision', title: 'Existing Source revision', widget: 'number' },
      { path: 'newProject', title: 'New repository-free Project and owner', widget: 'json' },
      { path: 'templateRef', title: 'Pinned catalog app', widget: 'json', required: true },
      { path: 'explicit', title: 'Your creation choices', widget: 'json' },
    ] } as const : id === 'deployments.templates.instantiate' ? { fields: [
      { path: 'mode', title: 'Preview or apply', widget: 'text', required: true },
      { path: 'serverId', title: 'Home', widget: 'text', required: true },
      { path: 'machineId', title: 'Target Machine', widget: 'text', required: true },
      { path: 'projectSourceId', title: 'Existing Project source', widget: 'text' },
      { path: 'newProject', title: 'New repository-free Project and owner', widget: 'json' },
      { path: 'templateRef', title: 'Pinned registry app', widget: 'json', required: true },
      { path: 'environment', title: 'Environment', widget: 'json', required: true },
      { path: 'target', title: 'Runtime target', widget: 'json', required: true },
      { path: 'destination', title: 'Stored definition', widget: 'json', required: true },
      { path: 'bindings', title: 'Variable bindings', widget: 'json', required: true },
      { path: 'generatedSecretAudience', title: 'Generated credential audience', widget: 'json' },
      { path: 'connectTo', title: 'Connect application service', widget: 'json' },
      { path: 'replace', title: 'Explicit key replacements', widget: 'json' },
      { path: 'domainBindings', title: 'Domain bindings', widget: 'json' },
      { path: 'deploy', title: 'Deploy after committing the definition and bindings', widget: 'json' },
    ] } as const : id === 'deployments.bindings.set' ? { fields: [
      { path: 'serverId', title: 'Home', widget: 'text', required: true },
      { path: 'environmentId', title: 'Environment', widget: 'text', required: true },
      { path: 'expectedRevision', title: 'Environment revision', widget: 'number', required: true },
      { path: 'set', title: 'Bindings to set', widget: 'json', required: true },
      { path: 'remove', title: 'Bindings to remove', widget: 'json', required: true },
    ] } as const : id === 'deployments.prepare' ? { fields: [
      { path: 'projectSourceId', title: 'Project source', widget: 'text', required: true },
      { path: 'sourceRevision', title: 'Source revision', widget: 'number', required: true },
      { path: 'repository', title: 'Repository', widget: 'json', required: true },
      { path: 'baseCommit', title: 'Base commit', widget: 'text', required: true },
      { path: 'workspace', title: 'Workspace reference', widget: 'json', required: true },
      { path: 'environmentId', title: 'Environment', widget: 'text' },
      { path: 'target', title: 'Target reference', widget: 'json' },
      { path: 'sessionRef', title: 'Existing Session', widget: 'json' },
      { path: 'importFrom', title: 'Import configuration references', widget: 'json' },
    ] } as const : { fields: [
      { path: 'serverId', title: 'Home', widget: 'text', required: true },
      ...(id === 'deployments.environments.create' || id === 'deployments.environments.list'
        ? [{ path: 'projectSourceId', title: 'Project source', widget: 'text' as const }]
        : [{ path: 'environmentId', title: 'Environment', widget: 'text' as const, required: id !== 'deployments.receipts.get' }]),
      ...(id === 'deployments.environments.list'
        ? [{ path: 'machineId', title: 'Machine', widget: 'text' as const },
          { path: 'environmentIds', title: 'Exact Environment headers', widget: 'json' as const }] : []),
      ...(isDeploymentNativeReadActionIdV1(id) || id === 'deployments.restart' ? [
        { path: 'deploymentId', title: 'Active deployment', widget: 'text' as const, required: true },
        { path: 'targetLinkId', title: 'Deployment target', widget: 'text' as const, required: true },
        { path: 'machineId', title: 'Selected Machine', widget: 'text' as const, required: true },
        { path: 'installationId', title: 'Machine installation', widget: 'text' as const, required: true },
        { path: 'service', title: 'Stable service identity', widget: 'json' as const, required: id !== 'deployments.logs.read' },
        ...(id === 'deployments.restart' ? [{ path: 'expectedGeneration', title: 'Service generation', widget: 'text' as const, required: true }] : []),
        ...(id === 'deployments.drift.read' ? [{ path: 'expectedRevision', title: 'Environment revision', widget: 'number' as const, required: true }] : []),
        ...(id === 'deployments.logs.read' ? [{ path: 'kind', title: 'Build or runtime logs', widget: 'text' as const, required: true },
          { path: 'ref', title: 'Receipt step log reference', widget: 'text' as const },
          { path: 'tail', title: 'Latest masked log window', widget: 'boolean' as const },
          { path: 'cursor', title: 'Native log cursor', widget: 'json' as const }] : []),
      ] : []),
      ...(id === 'deployments.receipts.get' || id === 'deployments.receipts.observe' || id === 'deployments.rollback' || id === 'deployments.cancel'
        ? [{ path: 'deploymentId', title: 'Deployment receipt', widget: 'text' as const, required: true }] : []),
      ...(id === 'deployments.cancel'
        ? [{ path: 'expectedReceiptRevision', title: 'Receipt revision', widget: 'number' as const, required: true }] : []),
      ...(isDeploymentPromoteActionIdV1(id) ? [
        { path: 'sourceEnvironmentId', title: 'Source Environment', widget: 'text' as const, required: true },
        { path: 'sourceDeploymentId', title: 'Source deployment receipt', widget: 'text' as const, required: true },
        { path: 'artifact', title: 'Recorded image or explicit rebuild', widget: 'text' as const, required: true },
        { path: 'requestKey', title: 'Request identity', widget: 'text' as const },
      ] : []),
      ...(id === 'deployments.environments.controller.set'
        ? [{ path: 'expectedRevision', title: 'Environment revision', widget: 'number' as const, required: true },
          { path: 'controllerMachineId', title: 'Controller Machine', widget: 'text' as const, required: true }] : []),
      ...(id === 'deployments.environments.update'
        ? [{ path: 'patch.buildMachineId', title: 'Build Machine', widget: 'text' as const, required: false },
          { path: 'patch.protection', title: 'Protection', widget: 'text' as const, required: false }] : []),
      ...(id === 'deployments.targets.unlink' || id === 'deployments.environments.delete' ? [
        { path: 'expectedRevision', title: 'Environment revision', widget: 'number' as const, required: true },
        { path: 'requestKey', title: 'Request identity', widget: 'text' as const, required: true },
        { path: 'detachKeepRunning', title: 'Detach and keep running', widget: 'boolean' as const },
        ...(id === 'deployments.targets.unlink' ? [
          { path: 'targetLinkId', title: 'Deployment target', widget: 'text' as const, required: true },
          { path: 'expectedTargetLinkRevision', title: 'Target revision', widget: 'number' as const, required: true },
          { path: 'teardownDeploymentId', title: 'Settled teardown receipt', widget: 'text' as const },
        ] : [{ path: 'teardownDeploymentIds', title: 'Settled teardown receipts', widget: 'json' as const }]),
      ] : []),
      ...(id === 'deployments.environments.create'
        ? [{ path: 'mode', title: 'Preview or apply authored creation', widget: 'text' as const },
          { path: 'name', title: 'New Environment name', widget: 'text' as const },
          { path: 'newProject', title: 'New repository-free Project and owner', widget: 'json' as const },
          { path: 'definition', title: 'Repository, catalog App, Compose or image intent', widget: 'json' as const },
          { path: 'bindings', title: 'Catalog variable bindings', widget: 'json' as const },
          { path: 'generatedSecretAudience', title: 'Generated catalog credential audience', widget: 'json' as const },
          { path: 'domainBindings', title: 'Catalog domain bindings', widget: 'json' as const },
          { path: 'controllerMachineId', title: 'Explicit controller choice', widget: 'text' as const },
          { path: 'buildMachineId', title: 'Explicit builder choice', widget: 'text' as const },
          { path: 'retainPreviousDeployments', title: 'Explicit retained-release count', widget: 'number' as const },
          { path: 'firstTargetLink', title: 'First own-server target and prepared content', widget: 'json' as const }] : []),
      ...(id === 'deployments.deploy' ? [{ path: 'targetLinkId', title: 'Deployment target', widget: 'text' as const, required: true }] : []),
      ...(id === 'deployments.domains.add' ? [
        { path: 'content', title: 'Authored Domain routing', widget: 'json' as const },
      ] : []),
      ...(read || id === 'deployments.deploy' || id === 'deployments.restart' || id === 'deployments.cancel' || id === 'deployments.environments.controller.set'
        || id === 'deployments.targets.unlink' || id === 'deployments.environments.delete' || isDeploymentDomainRemoveActionIdV1(id) ? [] : [
        { path: 'contentArtifactId', title: 'Prepared content', widget: 'text' as const, required: preparedContentRequired },
        { path: 'contentHeaderVersion', title: 'Content header revision', widget: 'number' as const, required: preparedContentRequired },
        { path: 'contentBodyVersion', title: 'Content body revision', widget: 'number' as const, required: preparedContentRequired },
      ]),
    ] } as const;
  return {
    id, title, safety: read ? 'safe' : 'danger', sideEffectClass: read ? 'read' : 'write',
    ...(previewForInput ? { safetyForInput: (input: unknown): 'safe' | 'danger' => previewForInput(input) ? 'safe' : 'danger' } : {}),
    ...(id === 'deployments.environments.update' ? { permissionChangingForInput: (input: unknown): boolean => {
      const parsed = DeploymentActionInputSchemasV1['deployments.environments.update'].safeParse(input);
      return parsed.success && (parsed.data.patch?.deployerMode !== undefined || parsed.data.patch?.deployerPrincipals !== undefined);
    } } : {}),
    approval: { result: 'required' }, approvalPolicy: { uiConfirmation: irreversible ? 'policy' : 'direct',
      ...(id === 'deployments.teardown' && previewForInput
        ? { uiConfirmationForInput: (input: unknown): boolean => !previewForInput(input) } : {}) },
    ...(irreversible ? { irreversible: true as const } : {}),
    ...(id === 'deployments.bindings.set' ? { approvalNarrowing: deploymentBindingSelectionNarrowing } : {}),
    ...(id !== 'deployments.environments.create' && id !== 'deployments.environments.list' && id !== 'deployments.publish.prepare'
      ? { approvalScope: 'environment' } : {}),
    executionPlacement: backup || id === 'deployments.prepare' || id === 'deployments.publish.prepare' || id === 'deployments.templates.instantiate' || id === 'deployments.restart' || id === 'deployments.backups.restore' || id === 'deployments.receipts.observe' || id === 'deployments.observation.get' ? 'machine' : 'account', requiredAuthority: 'account_automation', placements: [],
    ...(id === 'deployments.environments.create' ? {
      executionPlacements: ['account', 'machine'],
      executionPlacementForInput: (input: unknown): 'account' | 'machine' => {
        const intent = readRecord(input);
        return intent.copyFrom !== undefined || intent.contentArtifactId === undefined ? 'machine' : 'account';
      },
    } : {}),
    ...(id === 'deployments.teardown' ? { executionPlacements: ['account', 'machine'],
      executionPlacementForInput: (input: unknown): 'account' | 'machine' =>
        readRecord(input).detachKeepRunning === true ? 'account' : 'machine' } : {}),
    ...(id === 'deployments.environments.create'
      ? { originalExecution: { daemonIngressSurfaces: ['cli'] as const } } : backup || id === 'deployments.backups.restore' || id === 'deployments.templates.instantiate'
        ? { originalExecution: { daemonIngressSurfaces: ['ui'] as const } } : {}),
    // Machine placement uses the original Action dispatcher, not a standalone RPC method.
    surfaces: { ui: true, cli: true, agent: true, mcp: true, voice: false, rpc: false },
    bindings: { mcpToolName: id.replaceAll('.', '_'), ...(id === 'deployments.publish.prepare' ? { sdkMethod: 'deployments.preparePublishCatalog' } : {}) },
    cli: { acceptsServerId: true, commands: [{ path: id.split('.'), visibility: 'canonical' }] },
    ...(path === undefined ? {} : { serverTransport: { method: read ? 'GET' : id === 'deployments.environments.update' ? 'PATCH' : 'POST', path, preservePathFieldsInBody: true } }),
    inputSchema: DeploymentActionInputSchemasV1[id], outputSchema: DeploymentActionOutputSchemasV1[id],
    invocationServerIdForInput: actionInputServerId(DeploymentActionInputSchemasV1[id], (input) => {
      const serverId = readRecord(input).serverId;
      return typeof serverId === 'string' ? serverId : undefined;
    }),
    ...(id === 'deployments.deploy' ? { completion: deploymentDeployActionCompletionV1 } : {}),
    // The retry key, target link and prepared-content pins say which request and bytes, not what it does; the
    // request's summary and the host's deploy review say that. Approval reads them under Technical details.
    ...(id === 'deployments.deploy' || id === 'deployments.promote' ? { approvalPresentation: { summary: () => null,
      technicalInputPaths: ['requestKey', 'targetLinkId', 'contentArtifactId', 'contentHeaderVersion', 'contentBodyVersion',
        ...(id === 'deployments.promote' ? ['destinationContent'] : [])] } } : {}),
    // A restore is approved by its consequence; every id only correlates the request with the Environment, the
    // capture receipt and the prepared operation, so they read under Technical details. The Machine stays named.
    ...(id === 'deployments.backups.restore' ? { approvalPresentation: {
      summary: (input: unknown) => readRecord(input).mode === 'confirm'
        ? 'Replace this Environment\'s data with the checked backup. The running code stays as it is.'
        : 'Check the backup and take a safety backup first. Nothing is replaced yet.',
      technicalInputPaths: ['mode', 'serverId', 'environmentId', 'installationId', 'targetLinkId', 'deploymentId',
        'restoreBackupId', 'expectedRevision', 'prepareOperationId'] } } : {}),
    inputHints,
    ...(backup && !isDeploymentBackupReadActionIdV1(id) || id === 'deployments.backups.restore' || id === 'deployments.domains.add' || id === 'deployments.domains.remove' || id === 'deployments.templates.instantiate' || id === 'deployments.deploy' || id === 'deployments.rollback' || id === 'deployments.restart' || id === 'deployments.promote' || id === 'deployments.teardown' ? {
      operation: { version: 1, visibility: 'activity', progress: 'reported', presentation: { onStart: 'current' } },
    } : {}),
    // Review describes the stored ref string; the interactive picker selects a ref/revision pair.
    ...(secretPath ? { approvalPresentation: { inputHints: { fields: [
      ...inputHints.fields,
      { path: secretPath, title: 'Saved Secret', widget: 'text', inputType: { hostType: 'savedSecretReference' } },
    ] } } } : {}),
  } as const satisfies DeploymentActionSpec<TId>;
}

/** Storage declarations and real daemon effects share this single Action front door. */
function createDeploymentActionSpecsV1() {
  return [
  { ...deploymentSpec('deployments.domains.add', 'Add or update deployment domain', '/v1/deployments/environments/:environmentId/domains'),
    requesterAccountContentDemandForInput: () => true,
    approvalPresentation: {
      summary: () => 'Configure this Domain. For own-server ingress, this may replace an unchanged Happier Caddy startup seed with the selected public or private configuration. When Tunnel ingress needs Caddy setup, it uses a private seed and may recreate a failed, never-started Happier Caddy container. Custom seed files require reconciliation; live routes and certificate state are retained.',
    } },
  { ...deploymentSpec('deployments.domains.remove', 'Remove deployment domain', '/v1/deployments/environments/:environmentId/domains/:domainId/remove'), requesterAccountContentDemandForInput: () => true },
  { ...deploymentSpec('deployments.domains.verify', 'Verify deployment domain', undefined, true), requesterAccountContentDemandForInput: () => true },
  deploymentSpec('deployments.domains.get', 'Read deployment domain', '/v1/deployments/environments/:environmentId/domains/:domainId', true),
  deploymentSpec('deployments.domains.list', 'List deployment domains', '/v1/deployments/environments/:environmentId/domains', true),
  { ...deploymentSpec('deployments.publish.prepare', 'Prepare catalog app publishing', undefined, true), requesterAccountContentDemandForInput: () => true },
  { ...deploymentSpec('deployments.templates.instantiate', 'Instantiate deployment template', undefined), requesterAccountContentDemandForInput: () => true },
  deploymentSpec('deployments.prepare', 'Ask an agent to prepare deployment', undefined),
  { ...deploymentSpec('deployments.health.read', 'Read deployed service health', undefined, true), requesterAccountContentDemandForInput: () => true },
  deploymentSpec('deployments.health.current', 'Read current Environment edge health', undefined, true),
  { ...deploymentSpec('deployments.drift.read', 'Read deployed service drift', undefined, true), requesterAccountContentDemandForInput: () => true },
  { ...deploymentSpec('deployments.logs.read', 'Read deployment logs', undefined, true), requesterAccountContentDemandForInput: (input: unknown) => readRecord(input).kind === 'build' },
  { ...deploymentSpec('deployments.environments.create', 'Create deployment environment', '/v1/deployments/environments'), requesterAccountContentDemandForInput: () => true },
  { ...deploymentSpec('deployments.environments.update', 'Update deployment environment', '/v1/deployments/environments/:environmentId'), requesterAccountContentDemandForInput: () => true },
  deploymentSpec('deployments.environments.controller.set', 'Change environment controller', '/v1/deployments/environments/:environmentId/controller'),
  { ...deploymentSpec('deployments.targets.link', 'Link deployment target', '/v1/deployments/environments/:environmentId/targets'), requesterAccountContentDemandForInput: (input: unknown) => !('contentArtifactId' in readRecord(input)) },
  deploymentSpec('deployments.targets.unlink', 'Unlink deployment target', '/v1/deployments/environments/:environmentId/targets/:targetLinkId/unlink'),
  deploymentSpec('deployments.environments.delete', 'Delete deployment environment', '/v1/deployments/environments/:environmentId/delete'),
  { ...deploymentSpec('deployments.deploy', 'Deploy environment', '/v1/deployments/environments/:environmentId/deploy'), requesterAccountContentDemandForInput: () => true },
  { ...deploymentSpec('deployments.rollback', 'Roll back deployment', '/v1/deployments/environments/:environmentId/rollback'), requesterAccountContentDemandForInput: () => true },
  deploymentSpec('deployments.restart', 'Restart deployed service', undefined),
  { ...deploymentSpec('deployments.backups.restore', 'Restore deployment backup', undefined), requesterAccountContentDemandForInput: () => true },
  { ...deploymentSpec('deployments.backups.test', 'Test backup destination', undefined, true), requesterAccountContentDemandForInput: () => true },
  { ...deploymentSpec('deployments.backups.history', 'Read backup history', undefined, true), requesterAccountContentDemandForInput: () => true },
  { ...deploymentSpec('deployments.backups.inventory', 'List deployment backups', undefined, true), requesterAccountContentDemandForInput: () => true },
  { ...deploymentSpec('deployments.backups.run', 'Back up deployment', undefined), requesterAccountContentDemandForInput: () => true },
  { ...deploymentSpec('deployments.backups.verify', 'Verify deployment backup', undefined, true), requesterAccountContentDemandForInput: () => true },
  { ...deploymentSpec('deployments.backups.prune', 'Apply backup retention', undefined), requesterAccountContentDemandForInput: () => true },
  deploymentSpec('deployments.cancel', 'Cancel deployment', '/v1/deployments/environments/:environmentId/deployments/:deploymentId/transitions'),
  { ...deploymentSpec('deployments.promote', 'Promote deployment', '/v1/deployments/environments/:environmentId/promote'), requesterAccountContentDemandForInput: () => true },
  { ...deploymentSpec('deployments.teardown', 'Tear down deployment resources', '/v1/deployments/environments/:environmentId/teardown'), operationReentry: deploymentTeardownOperationReentryV1, requesterAccountContentDemandForInput: (input: unknown) => !('detachKeepRunning' in readRecord(input)) },
  deploymentSpec('deployments.environments.get', 'Read deployment environment', '/v1/deployments/environments/:environmentId', true),
  deploymentSpec('deployments.receipts.get', 'Read deployment receipt', '/v1/deployments/receipts/:deploymentId', true),
  { ...deploymentSpec('deployments.receipts.observe', 'Observe provider deployment receipt', undefined, true), requesterAccountContentDemandForInput: () => true },
  { ...deploymentSpec('deployments.observation.get', 'Read recorded deployment observation', undefined, true), requesterAccountContentDemandForInput: () => true },
  { ...deploymentSpec('deployments.bindings.set', 'Set environment bindings', '/v1/deployments/environments/:environmentId/bindings'), requesterAccountContentDemandForInput: () => true },
  deploymentSpec('deployments.environments.list', 'List deployment environments', '/v1/deployments/environments', true),
  deploymentSpec('deployments.receipts.list', 'List deployment receipts', '/v1/deployments/environments/:environmentId/deployments', true),
] as const satisfies readonly PreNormalizedActionSpec[];
}

export const DEPLOYMENT_ACTION_SPECS_V1: ReturnType<typeof createDeploymentActionSpecsV1> = lazyActionSpecArray(createDeploymentActionSpecsV1);
