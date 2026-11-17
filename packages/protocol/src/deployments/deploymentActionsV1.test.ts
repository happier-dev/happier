import { DeploymentBackupRestoreResultV1Schema } from './deploymentBackupRestoreV1.js';
import { computeActionInputApprovalDigestV1 } from '../actions/decisionAuthority.js';
import { resolveApprovalRequestApproveAdmission } from '../actions/actionApprovalPresentation.js';
import { ApprovalRequestV2Schema } from '../approvals/approvalRequestV1.js';
import { describe, expect, it } from 'vitest';
import { DeploymentEnvironmentListInputV1Schema, DeploymentEnvironmentUpdateInputV1Schema,
  omitDeploymentEnvironmentPrivateContentPatchV1,
  DeploymentTargetLinkHeaderV1Schema, DeploymentTargetLinkInputV1Schema, DeploymentTargetLinkIntentInputV1Schema, DeploymentTargetLinkResultV1Schema,
  DeploymentTargetLinksListInputV1Schema, DeploymentTargetLinksListResultV1Schema,
  DeploymentReceiptResultV1Schema, DeploymentActionInputSchemasV1, DeploymentRollbackInputV1Schema, DeploymentTeardownInputV1Schema,
  DeploymentAccountChangeHintV1Schema, buildDeploymentAccountChangeV1, readDeploymentAccountChangeV1,
  readDeploymentActionOperationRequestIdV1, readDeploymentEnvironmentOperationRequestIdV1 } from './deploymentActionsV1.js';
import { bindHomeDomainHttpRequestV1 } from '../actions/homeDomainHttpBinding.js';
import { getActionSpec, listActionSpecsForSurface, resolveActionPermissionChangingV1,
  resolveActionExecutionPlacementForInput } from '../actions/actionSpecs.js';
import { resolveActionApprovalRouting } from '../actions/actionApprovalPolicy.js';
import { formatSharedSavedSecretRefV1 } from '../account/settings/savedSecretReferenceV1.js';
import { DeploymentDeployAdmissionInputV1Schema } from './deploymentActionsV1.js';
import { DeploymentEnvironmentCreateInputV1Schema, DeploymentEnvironmentCreateStorageInputV1Schema,
  DeploymentEnvironmentHeaderV1Schema } from './deploymentActionsV1.js';
import { DeploymentChildRpcV1Schema, doesDeploymentChildInputMatchRootV1, readDeploymentChildRpcV1 } from './deploymentChildRpcV1.js';
import { buildDeploymentPromoteInputV1 } from './promoteInput.js';
import { projectDeploymentPreparationAdmissionV1 } from './deploymentPreparationAdmissionV1.js';
import { deploymentChildEffectActionIdForRootV1 } from './deploymentActionIdsV1.js';
import { RPC_METHODS } from '../rpc/methods.js';
import { DeploymentChildRoutingV1Schema, projectDeploymentChildRoutingV1 } from './deploymentChildRoutingV1.js';
import { DeploymentBindingsPreparedInputV1Schema } from './deploymentActionsV1.js';
import { captureDeploymentBindingSavedSecretRevisionsV1, matchesDeploymentBindingSavedSecretCapturesV1 } from './deploymentBindingPatchV1.js';
import { EnvironmentSecretBindingV1Schema } from './storedAppInputV1.js';
import { DeploymentTargetLinkProviderContentV1Schema, DeploymentTargetRoleInputSchemasV1,
  DeploymentTargetRoleInputProtocolSchemasV1 } from '../plugins/contributions/deploymentTargetRolesV1.js';
import { PluginUiHostReadReferenceV1Schema } from '../plugins/ui/subscriptions.js';
import { ActionIdSchema } from '../actions/actionIds.js';
import { projectExternalActionDeploymentNativeEnvelopeAdmissionV1, ExternalActionExecutionAuthorizationBindingV1Schema } from '../actions/externalActionApi.js';
import { computeExternalActionRequestEnvelopeDigestV1, isExternalActionAuthorizationBoundToEnvelope } from '../actions/externalActionExecutionAuthorization.js';
import { createDeploymentDomainContentArtifactIdV1, projectDeploymentNativeAdmissionV1,
  isDeploymentDomainNativeAdmissionV1 } from './deploymentCandidatePublicationV1.js';

it('admits an opaque next-page cursor for branch reads while branch mutations stay closed', () => {
  const credentialRef = { service: { pluginId: 'com.example.database', localId: 'database' }, accountId: 'token' };
  const input = { v: 1, serverId: 'home', environmentId: 'environment', expectedRevision: 1,
    targetLinkId: 'data-link', expectedTargetLinkRevision: 2, credentialRef,
    credentialPrincipal: { kind: 'account', accountId: 'owner',
      purpose: { consumer: { pluginId: 'com.example.database', localId: 'parents' }, purpose: 'database.manage' },
      target: { kind: 'account', account: credentialRef } },
    providerIdentity: { providerAccountId: 'team', providerResourceId: 'project', providerEnvironment: 'main' },
    providerEnvironment: { kind: 'custom', id: 'main' } };
  expect(DeploymentTargetRoleInputSchemasV1['branches.list'].parse(input)).toEqual(input);
  const nextPage = { ...input, cursor: 'provider-next-page' };
  expect(DeploymentTargetRoleInputSchemasV1['branches.list'].parse(nextPage)).toEqual(nextPage);
  expect(DeploymentTargetRoleInputProtocolSchemasV1['branches.list'].parse(nextPage)).toEqual(nextPage);
  expect(DeploymentTargetRoleInputSchemasV1['branches.create'].safeParse(nextPage).success).toBe(false);
  expect(DeploymentTargetRoleInputSchemasV1['branches.delete'].safeParse(nextPage).success).toBe(false);
});

describe('existing deployment restart', () => {
  it('routes the exact admitted restore snapshot to its managed controller without disclosing native resource content', () => {
    const offer = { managedId: 'allocation', intentRevision: 0,
      controller: { machineId: 'controller', installationId: 'controller-installation' },
      resource: { contributionRef: { pluginId: 'acme.cloud', localId: 'vm' }, schemaVersion: 1, value: { serverId: 'native-private' } },
      contribution: { pluginId: 'acme.cloud', localId: 'vm' }, coverage: { rootDisk: true, attachedVolumes: false },
      cost: { kind: 'billed', source: 'Native snapshot pricing' }, consistency: 'running' };
    const input = { serverId: 'home', environmentId: 'environment', machineId: 'guest', installationId: 'guest-installation',
      targetLinkId: 'target', deploymentId: 'deployment', source: { kind: 'repository', snapshotId: 'backup' }, expectedRevision: 1,
      mode: 'confirm', prepareOperationId: 'prepared', snapshotReview: offer };
    const child = DeploymentChildRpcV1Schema.parse({ v: 1, kind: 'snapshot', actionId: 'deployments.backups.restore',
      input, machineId: 'controller', installationId: 'controller-installation', actionOperationId: 'restore-operation',
      label: 'Before restore', reason: 'Restore existing database', offer });
    expect(doesDeploymentChildInputMatchRootV1({ rootActionId: 'deployments.backups.restore', rootInput: input, child })).toBe(true);
    expect(doesDeploymentChildInputMatchRootV1({ rootActionId: 'deployments.backups.restore',
      rootInput: { ...input, machineId: 'other' }, child })).toBe(false);
    expect(doesDeploymentChildInputMatchRootV1({ rootActionId: 'deployments.backups.restore',
      rootInput: { ...input, snapshot: false }, child })).toBe(false);
    expect(doesDeploymentChildInputMatchRootV1({ rootActionId: 'deployments.backups.restore',
      rootInput: { ...input, source: { kind: 'upload', transferId: 'other' } }, child })).toBe(false);
    expect(doesDeploymentChildInputMatchRootV1({ rootActionId: 'deployments.backups.restore',
      rootInput: { ...input, destination: { kind: 'volume', service: 'db', volume: 'data' } }, child })).toBe(false);
    expect(doesDeploymentChildInputMatchRootV1({ rootActionId: 'deployments.backups.restore',
      rootInput: { ...input, snapshotReview: { ...offer, managedId: 'other' } }, child })).toBe(false);
    const routing = DeploymentChildRoutingV1Schema.parse(projectDeploymentChildRoutingV1(child));
    expect(routing).toMatchObject({ kind: 'snapshot', managedId: 'allocation', intentRevision: 0, machineId: 'controller' });
    expect(JSON.stringify(routing)).not.toContain('native-private');
    expect(readDeploymentChildRpcV1({ rootActionId: 'deployments.backups.restore', deploymentChildRoot: true,
      effectActionId: 'deployments.backups.restore', method: RPC_METHODS.DAEMON_DEPLOYMENT_CHILD, params: child })).toEqual(child);
  });
  it('recovers the same retained native intent without conflating restore preparation', () => {
    const teardown = { serverId: 'home', environmentId: 'environment', requestKey: 'remove', reason: 'manual' };
    expect(readDeploymentActionOperationRequestIdV1('deployments.teardown', teardown))
      .toBe(readDeploymentEnvironmentOperationRequestIdV1(teardown));
    expect(readDeploymentActionOperationRequestIdV1('deployments.teardown', { ...teardown, requestKey: undefined })).toBeUndefined();
    const restore = { serverId: 'home', environmentId: 'environment', machineId: 'machine', installationId: 'installation',
      targetLinkId: 'target', deploymentId: 'deployment', source: { kind: 'repository', snapshotId: 'backup' }, expectedRevision: 1 };
    const confirmed = readDeploymentActionOperationRequestIdV1('deployments.backups.restore',
      { ...restore, mode: 'confirm', prepareOperationId: 'prepared' });
    expect(confirmed).toEqual(expect.any(String));
    expect(readDeploymentActionOperationRequestIdV1('deployments.backups.restore', { ...restore, mode: 'prepare' })).toBeUndefined();
    expect(readDeploymentActionOperationRequestIdV1('deployments.backups.restore',
      { ...restore, mode: 'confirm', prepareOperationId: 'other-preparation' })).not.toBe(confirmed);
    expect(readDeploymentActionOperationRequestIdV1('deployments.environments.get', teardown)).toBeUndefined();
  });
  it('binds remote native inventory to its Environment and prevents preview from executing native removal', () => {
    const input = { serverId: 'home', environmentId: 'environment', targetLinkId: 'target', reason: 'manual' };
    const review = DeploymentChildRpcV1Schema.parse({ v: 1, kind: 'prepare', actionId: 'deployments.teardown',
      input, machineId: 'machine', installationId: 'installation', expectedRevision: 1, expectedTargetLinkRevision: 1 });
    const preview = { ...input, mode: 'preview' };
    expect(doesDeploymentChildInputMatchRootV1({ rootActionId: 'deployments.teardown', rootInput: preview, child: review })).toBe(true);
    expect(doesDeploymentChildInputMatchRootV1({ rootActionId: 'deployments.teardown',
      rootInput: { ...preview, environmentId: 'foreign' }, child: review })).toBe(false);
    const child = DeploymentChildRpcV1Schema.parse({ v: 1, kind: 'teardown', actionId: 'deployments.teardown',
      input: { ...input, requestKey: 'request', expectedRevision: 1, expectedTargetLinkRevision: 1,
        contentArtifactId: 'artifact', contentHeaderVersion: 1, contentBodyVersion: 1 },
      machineId: 'machine', installationId: 'installation', deploymentId: 'receipt', actionOperationId: 'operation',
      step: 'removeTarget', mode: 'execute' });
    expect(doesDeploymentChildInputMatchRootV1({ rootActionId: 'deployments.teardown', rootInput: preview, child })).toBe(false);
    expect(doesDeploymentChildInputMatchRootV1({ rootActionId: 'deployments.teardown', rootInput: input, child })).toBe(true);
  });
  it('binds exact volume deletion confirmation to the teardown operand while preserving keep by omission', () => {
    const input = { serverId: 'home', environmentId: 'environment', reason: 'manual' };
    const schema = DeploymentActionInputSchemasV1['deployments.teardown'];
    expect(schema.safeParse({ ...input, volumes: [{ name: 'app_data', disposition: 'delete', confirmation: 'app_data' },
      { name: 'app_logs', disposition: 'keep' }] }).success).toBe(true);
    expect(schema.safeParse({ ...input, volumes: [{ name: 'app_data', disposition: 'delete', confirmation: 'app' }] }).success).toBe(false);
    expect(schema.safeParse({ ...input, volumes: [{ name: 'app_data', disposition: 'delete' }] }).success).toBe(false);
    expect(schema.safeParse({ ...input, volumes: [{ name: 'app_data', disposition: 'keep' },
      { name: 'app_data', disposition: 'delete', confirmation: 'app_data' }] }).success).toBe(false);
    expect(schema.safeParse(input).success).toBe(true);
    expect(schema.safeParse({ ...input, mode: 'preview' }).success).toBe(true);
  });
  it('admits authored Domain routing through the same Action while refusing mixed private references', () => {
    const input = { serverId: 'home', environmentId: 'environment', domainId: 'domain', expectedRevision: 1,
      targetLinkId: 'runtime', expectedTargetLinkRevision: 1, requestKey: 'domain-add',
      content: { hostname: 'app.example.test', target: { service: 'web', containerPort: 8080 } } };
    const schema = getActionSpec('deployments.domains.add').inputSchema;
    expect(schema.safeParse(input).success).toBe(true);
    expect(schema.safeParse({ ...input, contentArtifactId: 'private', contentHeaderVersion: 1, contentBodyVersion: 1 }).success).toBe(false);
  });
  it('admits a simple UI teardown request for controller-owned preparation, never for storage', () => {
    const input = { serverId: 'home', environmentId: 'environment', reason: 'manual', requestKey: 'remove' };
    const spec = getActionSpec('deployments.teardown');
    expect(spec.inputSchema.safeParse(input).success).toBe(true);
    expect(resolveActionExecutionPlacementForInput(spec, input, undefined, 'ui')).toBe('machine');
    expect(DeploymentTeardownInputV1Schema.safeParse(input).success).toBe(false);
    expect(spec.inputSchema.safeParse({ ...input, resources: [] }).success).toBe(false);
  });
  it('admits a complete native teardown intent before the controller prepares its receipt', () => {
    const actionArgs = { serverId: 'home', environmentId: 'environment', targetLinkId: 'runtime',
      expectedRevision: 4, expectedTargetLinkRevision: 1, requestKey: 'cleanup', reason: 'manual' };
    const request = ApprovalRequestV2Schema.parse({ v: 2, status: 'open', createdAtMs: 1, updatedAtMs: 1,
      createdBy: { surface: 'system' }, actionId: 'deployments.teardown', actionArgs,
      summary: 'Remove owned workload', executionOriginV1: { v: 1, authority: 'account_automation',
        caller: { kind: 'host' }, requestId: 'cleanup', surface: 'cli', serverId: 'home',
        actionId: 'deployments.teardown' } });
    expect(resolveApprovalRequestApproveAdmission(request)).toMatchObject({ status: 'available' });
    // Revisions may now be supplied by controller preparation; the reason is
    // required for both a simple request and a prepared teardown operand.
    const { reason: _reason, ...incomplete } = actionArgs;
    expect(resolveApprovalRequestApproveAdmission({ ...request, actionArgs: incomplete }))
      .toMatchObject({ status: 'unavailable', reason: 'context_unavailable' });
  });
  it('accepts own-server teardown intent while keeping storage admission artifact-bound', () => {
    const intent = { serverId: 'home', environmentId: 'environment', expectedRevision: 4,
      targetLinkId: 'runtime', expectedTargetLinkRevision: 1, requestKey: 'cleanup', reason: 'manual' };
    expect(DeploymentActionInputSchemasV1['deployments.teardown'].safeParse(intent).success).toBe(true);
    expect(DeploymentTeardownInputV1Schema.safeParse(intent).success).toBe(false);
    expect(DeploymentActionInputSchemasV1['deployments.teardown'].safeParse({ ...intent, resources: [] }).success).toBe(false);
    const spec = getActionSpec('deployments.teardown');
    expect(resolveActionExecutionPlacementForInput(spec, intent, undefined, 'ui')).toBe('machine');
    const prepared = spec.inputSchema.parse({ ...intent, contentArtifactId: 'receipt', contentHeaderVersion: 1, contentBodyVersion: 1 });
    expect(resolveActionExecutionPlacementForInput(spec, prepared, undefined, 'ui')).toBe('machine');
    const detached = spec.inputSchema.parse({ ...intent, detachKeepRunning: true });
    expect(resolveActionExecutionPlacementForInput(spec, detached, undefined, 'ui')).toBe('account');
  });
  it('exposes only an exact existing service generation, with no definition overrides', () => {
    const action = ActionIdSchema.safeParse('deployments.restart');
    expect(action.success).toBe(true);
    if (!action.success) return;
    const spec = getActionSpec(action.data);
    const input = { serverId: 'home', machineId: 'machine', installationId: 'installation',
      environmentId: 'environment', deploymentId: 'deployment', targetLinkId: 'target', expectedGeneration: 'generation',
      service: { kind: 'deployment', machineId: 'machine', environmentId: 'environment',
        environmentInstanceId: 'instance', composeService: 'web', serviceId: 'instance/web' } };
    expect(spec.inputSchema.parse(input)).toEqual(input);
    expect(spec.inputSchema.safeParse({ ...input, definition: { source: 'other' } }).success).toBe(false);
    expect(spec.inputSchema.safeParse({ ...input, environmentId: 'foreign' }).success).toBe(false);
    expect(spec.executionPlacement).toBe('machine');
    const admission = projectExternalActionDeploymentNativeEnvelopeAdmissionV1({ actionId: 'deployments.restart',
      envelope: { v: 1, requestId: 'restart', input } });
    expect(admission).toEqual({ kind: 'restart', actionId: 'deployments.restart', environmentId: 'environment',
      deploymentId: 'deployment', targetLinkId: 'target', machineId: 'machine', installationId: 'installation' });
    const sealed = { v: 2 as const, requestId: 'restart', payload: { t: 'encrypted' as const, c: 'opaque' }, deploymentNativeAdmission: admission };
    expect(projectExternalActionDeploymentNativeEnvelopeAdmissionV1({ actionId: 'deployments.restart', envelope: sealed })).toEqual(admission);
    expect(() => projectExternalActionDeploymentNativeEnvelopeAdmissionV1({ actionId: 'deployments.deploy', envelope: sealed })).toThrow();
    expect(() => projectExternalActionDeploymentNativeEnvelopeAdmissionV1({ actionId: 'deployments.restart', envelope: {
      ...sealed, deploymentNativeAdmission: { environmentId: 'environment' } } })).toThrow();
    const envelope = { v: 1 as const, requestId: 'restart', target: { kind: 'machine' as const, machineId: 'machine' }, input };
    const binding = ExternalActionExecutionAuthorizationBindingV1Schema.parse({ accountId: 'member', custodianAccountId: 'owner',
      authentication: { kind: 'account', tokenEpoch: 0 }, serverIdentityId: 'home', machineId: 'machine', installationId: 'installation',
      actionId: 'deployments.restart', requestId: 'restart', environmentId: 'environment', target: envelope.target,
      admittedMachineRole: 'use', deploymentNativeAdmission: admission, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope) });
    const invocation = { actionId: 'deployments.restart', machineId: 'machine', envelope };
    expect(isExternalActionAuthorizationBoundToEnvelope(binding, invocation)).toBe(true);
    expect(isExternalActionAuthorizationBoundToEnvelope({ ...binding, deploymentNativeAdmission: {
      kind: 'restart', actionId: 'deployments.restart', environmentId: 'environment', deploymentId: 'deployment',
      targetLinkId: 'foreign', machineId: 'machine', installationId: 'installation' } }, invocation)).toBe(false);
  });
});

describe('current Environment edge health read', () => {
  it('carries a current observer fact or no proof, never caller-supplied probe inputs', () => {
    const spec = getActionSpec('deployments.health.current');
    const input = { serverId: 'home', machineId: 'controller', environmentId: 'environment', targetLinkId: 'runtime' };
    expect(spec.inputSchema.parse(input)).toEqual(input);
    expect(spec.inputSchema.safeParse({ ...input, endpoint: 'https://other.test' }).success).toBe(false);
    const observation = { environmentId: 'environment', targetLinkId: 'runtime', targetLinkRevision: 2,
      machineId: 'edge', role: 'edge', status: 'unknown', observedAtMs: 100,
      source: { kind: 'domain', observerMachineId: 'controller' } };
    expect(spec.outputSchema.parse({ ok: true, environmentId: 'environment', targetLinkId: 'runtime', observation }))
      .toHaveProperty('observation.status', 'unknown');
    expect(spec.outputSchema.parse({ ok: true, environmentId: 'environment', targetLinkId: 'runtime', observation: null }))
      .toHaveProperty('observation', null);
    expect(spec.outputSchema.safeParse({ ok: true, environmentId: 'other', targetLinkId: 'runtime', observation }).success).toBe(false);
    expect(PluginUiHostReadReferenceV1Schema.parse({ hostRead: 'deployments.health.edge', input })).toEqual({ hostRead: 'deployments.health.edge', input });
  });
});


describe('Create reviewed Deploy child transport', () => {
  it.each(['catalog', 'preview'] as const)('retains the %s create root and consumes its exact prepared Deploy operand', kind => {
    const rootInput = { serverId: 'home', projectSourceId: 'source', requestKey: 'create', name: 'Web',
      protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers', definition: {
        from: 'catalogApp', templateRef: { sourceId: 'apps', itemId: 'web', version: '1',
          ref: { kind: 'content', digest: `sha256:${'c'.repeat(64)}` } } } };
    const createInput = kind === 'catalog' ? rootInput : {
      serverId: rootInput.serverId, projectSourceId: rootInput.projectSourceId, requestKey: rootInput.requestKey,
      protection: rootInput.protection, purpose: 'preview', deployerMode: rootInput.deployerMode,
      preview: { templateEnvironmentId: 'template', expectedTemplateRevision: 1, pullRequestId: 'pull-request',
        runtimeTargetLinkId: 'template-runtime' } };
    const rootPreparationAdmission = projectDeploymentPreparationAdmissionV1('deployments.environments.create', createInput);
    const input = { serverId: 'home', environmentId: 'allocated', targetLinkId: 'runtime', requestKey: 'create',
      expectedRevision: 2, expectedTargetLinkRevision: 1, contentArtifactId: 'candidate', contentHeaderVersion: 1, contentBodyVersion: 1 };
    const child = DeploymentChildRpcV1Schema.parse({ v: 1, kind: 'build', actionId: 'deployments.deploy', input,
      deploymentId: 'deployment', actionOperationId: 'operation',
      machineId: 'receiver', installationId: 'installed' });
    const reviewedChild = { actionId: child.actionId, role: kind === 'catalog' ? 'template.deploy' : 'preview.deploy',
      inputDigest: computeActionInputApprovalDigestV1(child.actionId, input) };
    const transport = { deploymentChildRoot: true as const, rootActionId: 'deployments.environments.create', rootPreparationAdmission, reviewedChild,
      effectActionId: child.actionId, method: RPC_METHODS.DAEMON_DEPLOYMENT_CHILD, params: child };
    expect(readDeploymentChildRpcV1(transport)).toEqual(child);
    expect(doesDeploymentChildInputMatchRootV1({ ...transport, rootInput: createInput, child })).toBe(true);
    for (const patch of [{ environmentId: 'foreign' }, { targetLinkId: 'foreign' }, { requestKey: 'foreign' },
      { contentArtifactId: 'foreign' }, { contentBodyVersion: 2 }, { expectedRevision: 3 }, { expectedTargetLinkRevision: 2 }]) {
      expect(doesDeploymentChildInputMatchRootV1({ ...transport, rootInput: createInput,
        child: DeploymentChildRpcV1Schema.parse({ ...child, input: { ...input, ...patch } }) })).toBe(false);
    }
    expect(doesDeploymentChildInputMatchRootV1({ ...transport, rootInput: createInput, child, reviewedChild: undefined })).toBe(false);
    expect(doesDeploymentChildInputMatchRootV1({ ...transport, rootInput: createInput, child,
      reviewedChild: { ...reviewedChild, role: 'template.domain:web' } })).toBe(false);
    expect(doesDeploymentChildInputMatchRootV1({ ...transport, rootInput: createInput, child,
      reviewedChild: { ...reviewedChild, role: kind === 'catalog' ? 'preview.deploy' : 'template.deploy' } })).toBe(false);
    expect(doesDeploymentChildInputMatchRootV1({ ...transport, rootInput: createInput, child,
      rootActionId: 'deployments.rollback' })).toBe(false);
    expect(readDeploymentChildRpcV1({ ...transport, rootPreparationAdmission: undefined })).toBeNull();
    if (kind === 'preview') {
      const prepared = DeploymentChildRpcV1Schema.parse({ v: 1, kind: 'prepare', actionId: child.actionId,
        machineId: 'receiver', installationId: 'installed', expectedRevision: 2, expectedTargetLinkRevision: 1,
        input: { serverId: 'home', environmentId: 'allocated', targetLinkId: 'runtime', requestKey: 'create-deploy' },
        previewDomain: { domainId: 'selected-template-domain', url: 'https://pr-17.preview.test' } });
      const rootBinding = ExternalActionExecutionAuthorizationBindingV1Schema.parse({
        accountId: 'owner', custodianAccountId: 'owner', authentication: { kind: 'account', tokenEpoch: 1 },
        serverIdentityId: 'home', machineId: 'controller', installationId: 'controller-installation',
        actionId: transport.rootActionId, target: { kind: 'machine', machineId: 'controller' },
        requestId: 'request', requestEnvelopeDigest: 'a'.repeat(43), accountEncryptionMode: 'plain',
        deploymentChildRoot: true, deploymentPreparationAdmission: rootPreparationAdmission,
      });
      const admitted = { ...transport, rootBinding, rootInput: createInput, child: prepared,
        reviewedChild: { ...reviewedChild, inputDigest: computeActionInputApprovalDigestV1(prepared.actionId, prepared.input) } };
      expect(doesDeploymentChildInputMatchRootV1(admitted)).toBe(true);
      expect(projectDeploymentChildRoutingV1(prepared)).not.toHaveProperty('previewDomain');
      expect(doesDeploymentChildInputMatchRootV1({ ...admitted, rootActionId: 'deployments.rollback' })).toBe(false);
      expect(doesDeploymentChildInputMatchRootV1({ ...admitted,
        reviewedChild: { ...admitted.reviewedChild, role: 'template.deploy' } })).toBe(false);
      expect(doesDeploymentChildInputMatchRootV1({ ...admitted,
        reviewedChild: { ...admitted.reviewedChild, inputDigest: reviewedChild.inputDigest } })).toBe(false);
    }
  });
  it('derives read-only Catalog deployment preparation from the original attempt before its candidate is reviewed', () => {
    const rootInput = { serverId: 'home', projectSourceId: 'source', requestKey: 'environment-allocation', name: 'Web',
      protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers', definition: {
        from: 'catalogApp', templateRef: { sourceId: 'apps', itemId: 'web', version: '1',
          ref: { kind: 'content', digest: `sha256:${'c'.repeat(64)}` } } } };
    const rootPreparationAdmission = projectDeploymentPreparationAdmissionV1('deployments.environments.create', rootInput);
    const child = DeploymentChildRpcV1Schema.parse({ v: 1, kind: 'review', actionId: 'deployments.deploy',
      machineId: 'receiver', installationId: 'installed', input: { serverId: 'home', environmentId: 'allocated',
        targetLinkId: 'runtime', requestKey: 'attempt', expectedRevision: 2, expectedTargetLinkRevision: 1,
        contentArtifactId: 'candidate', contentHeaderVersion: 1, contentBodyVersion: 1 } });
    const derivation = { rootActionId: 'deployments.environments.create', rootInput, rootPreparationAdmission,
      rootRequestId: 'attempt', child };
    expect(doesDeploymentChildInputMatchRootV1(derivation)).toBe(true);
    expect(doesDeploymentChildInputMatchRootV1({ ...derivation, rootRequestId: 'other-attempt' })).toBe(false);
  });
});

describe('Domain admitted child transport', () => {
  const capture = { placement: { serverId: 'home', accountId: 'owner', environmentId: 'environment', targetLinkId: 'runtime',
    domainId: 'domain', machineId: 'receiver', installationId: 'installed', actionOperationId: 'operation', requestId: 'request', nativeServer: 'native' },
    content: { contentArtifactId: 'domain-content', contentHeaderVersion: 1, contentBodyVersion: 1 }, desired: true, listener: 'public' };
  const root = { serverId: 'home', environmentId: 'environment', domainId: 'domain', expectedRevision: 1,
    expectedDomainRevision: 1, requestKey: 'request', targetLinkId: 'runtime', expectedTargetLinkRevision: 1,
    ...capture.content };
  it('discovers only the prepared private candidate bound to an authored Domain root', () => {
    const { contentArtifactId: _id, contentHeaderVersion: _header, contentBodyVersion: _body, ...metadata } = root;
    const authored = { ...metadata, content: { hostname: 'app.example.test', target: { service: 'web', containerPort: 8080 },
      healthCheck: { path: '/health', expectStatus: 200 } } };
    const native = projectDeploymentNativeAdmissionV1('deployments.domains.add', authored);
    if (!isDeploymentDomainNativeAdmissionV1(native)) throw new Error('Expected authored Domain admission');
    const rootBinding = ExternalActionExecutionAuthorizationBindingV1Schema.parse({
      accountId: 'owner', custodianAccountId: 'owner', authentication: { kind: 'account', tokenEpoch: 1 },
      serverIdentityId: 'home', machineId: 'controller', installationId: 'controller-installation',
      actionId: 'deployments.domains.add', target: { kind: 'machine', machineId: 'controller' },
      requestId: 'request', requestEnvelopeDigest: 'a'.repeat(43), accountEncryptionMode: 'plain',
      environmentId: 'environment', deploymentChildRoot: true, deploymentNativeAdmission: native,
    });
    const prepared = { ...metadata, contentArtifactId: createDeploymentDomainContentArtifactIdV1({
      ...rootBinding, deploymentNativeAdmission: native }), contentHeaderVersion: 1, contentBodyVersion: 1 };
    const child = DeploymentChildRpcV1Schema.parse({ v: 1, kind: 'domainDiscover', actionId: 'deployments.domains.add',
      machineId: 'receiver', installationId: 'installed', input: prepared });
    const derivation = { rootActionId: rootBinding.actionId, rootInput: authored, rootBinding, child };
    expect(doesDeploymentChildInputMatchRootV1(derivation)).toBe(true);
    expect(doesDeploymentChildInputMatchRootV1({ ...derivation, rootInput: undefined })).toBe(true);
    for (const patch of [{ contentArtifactId: 'foreign' }, { expectedRevision: 2 }, { targetLinkId: 'foreign' },
      { requestKey: 'foreign' }, { contentBodyVersion: 2 }]) {
      expect(doesDeploymentChildInputMatchRootV1({ ...derivation, child: DeploymentChildRpcV1Schema.parse({
        ...child, input: { ...prepared, ...patch } }) })).toBe(false);
    }
    expect(DeploymentChildRpcV1Schema.safeParse({ ...child, input: authored }).success).toBe(false);
    const privateApp = DeploymentChildRpcV1Schema.parse({ ...child, input: { ...child.input, telemetryMachineId: 'collector-child' },
      telemetryApp: { environmentId: 'collector-environment', serviceName: 'private-collector-service', port: 4318 } });
    expect(projectDeploymentChildRoutingV1(privateApp)).toEqual({ ...child, input: privateApp.input });
    expect(DeploymentChildRoutingV1Schema.safeParse(privateApp).success).toBe(false);
    expect(doesDeploymentChildInputMatchRootV1({ ...derivation, child: privateApp })).toBe(true);
  });
  it('keeps the admitted Cloudflare connector grant private while preserving exact native child identity', () => {
    const wire = { v: 1, kind: 'domain', actionId: 'deployments.domains.add',
      input: { serverId: 'home', environmentId: 'environment', domainId: 'domain' },
      machineId: 'receiver', installationId: 'installed', expectedDomainRevision: 2,
      capture, actionOperationId: 'operation' };
    const cloudflareConnector = { tunnelId: 'vendor-tunnel',
      connector: { imageRef: 'cloudflare/cloudflared:2026.10.0', version: '2026.10.0' },
      networkName: 'environment_default', grantRef: 'opaque-home-issued-grant' };
    const job = DeploymentChildRpcV1Schema.parse({ ...wire, cloudflareConnector });
    expect(job).toEqual({ ...wire, cloudflareConnector });
    const routing = projectDeploymentChildRoutingV1(job);
    expect(DeploymentChildRoutingV1Schema.parse(routing)).toEqual(wire);
    expect(JSON.stringify(routing)).not.toContain(cloudflareConnector.grantRef);
    expect(DeploymentChildRoutingV1Schema.safeParse(job).success).toBe(false);
    expect(doesDeploymentChildInputMatchRootV1({ rootActionId: wire.actionId, rootInput: root, child: job })).toBe(true);
    expect(DeploymentChildRpcV1Schema.safeParse({ ...wire, cloudflareConnector: { ...cloudflareConnector, token: 'private-token' } }).success).toBe(false);
    const { grantRef: _grantRef, ...withoutGrant } = cloudflareConnector;
    expect(DeploymentChildRpcV1Schema.safeParse({ ...wire, cloudflareConnector: withoutGrant }).success).toBe(false);
    expect(DeploymentChildRpcV1Schema.safeParse({ ...wire, cloudflareConnector: {
      ...cloudflareConnector, connector: { imageRef: cloudflareConnector.connector.imageRef },
    } }).success).toBe(false);
  });
  it('retains exact Domain capture and root identity without a deployment receipt', () => {
    const input = { serverId: 'home', environmentId: 'environment', domainId: 'domain' };
    const wire = { v: 1, kind: 'domain', actionId: 'deployments.domains.add', input, machineId: 'receiver', installationId: 'installed',
      expectedDomainRevision: 2, capture, actionOperationId: 'operation' };
    const job = readDeploymentChildRpcV1({ deploymentChildRoot: true, rootActionId: wire.actionId, effectActionId: wire.actionId,
      method: RPC_METHODS.DAEMON_DEPLOYMENT_CHILD, params: wire });
    expect(job).toEqual(wire);
    expect(DeploymentChildRoutingV1Schema.parse(projectDeploymentChildRoutingV1(job!))).toEqual(wire);
    const privateJob = DeploymentChildRpcV1Schema.parse({ ...wire, topology: { members: [{ machineId: 'receiver', installationId: 'installed' }], machines: [{ machineId: 'receiver', installationId: 'installed',
      dockerEngineId: 'native-engine', privateNetworks: [], replicas: [], caddy: { status: 'ready', containerId: 'native-container', containerName: 'caddy',
        adminSocketPath: '/run/private/caddy.sock', networkNames: [], servers: [] } }] } });
    expect(projectDeploymentChildRoutingV1(privateJob)).toEqual(wire);
    expect(DeploymentChildRoutingV1Schema.safeParse(privateJob).success).toBe(false);
    expect(doesDeploymentChildInputMatchRootV1({ rootActionId: wire.actionId, rootInput: root, child: job! })).toBe(true);
    // Membership reconciliation retains the reduced native packet; Home proves its exact admitted capture.
    expect(readDeploymentChildRpcV1({ deploymentChildRoot: true, rootActionId: 'deployments.deploy', effectActionId: wire.actionId,
      method: RPC_METHODS.DAEMON_DEPLOYMENT_CHILD, params: wire })).toEqual(wire);
    expect(doesDeploymentChildInputMatchRootV1({ rootActionId: wire.actionId, rootInput: { ...root, domainId: 'foreign' }, child: job! })).toBe(false);
    expect(DeploymentChildRpcV1Schema.safeParse({ ...wire, installationId: 'foreign' }).success).toBe(false);
    expect(DeploymentChildRpcV1Schema.safeParse({ ...wire, actionOperationId: 'foreign' }).success).toBe(false);
    const { actionOperationId: _operation, ...withoutOperation } = wire;
    expect(DeploymentChildRpcV1Schema.safeParse(withoutOperation).success).toBe(false);
    expect(DeploymentChildRpcV1Schema.safeParse({ ...withoutOperation, actionId: 'deployments.domains.verify' }).success).toBe(true);
    const removal = readDeploymentChildRpcV1({ deploymentChildRoot: true, rootActionId: 'deployments.domains.remove', effectActionId: 'deployments.domains.remove',
      method: RPC_METHODS.DAEMON_DEPLOYMENT_CHILD, params: { ...wire, actionId: 'deployments.domains.remove', capture: { ...capture, desired: false } } });
    expect(removal).not.toBeNull();
    expect(doesDeploymentChildInputMatchRootV1({ rootActionId: 'deployments.domains.remove', child: removal!, rootInput: {
      serverId: root.serverId, environmentId: root.environmentId, domainId: root.domainId, expectedRevision: root.expectedRevision,
      expectedDomainRevision: root.expectedDomainRevision, requestKey: root.requestKey,
    } })).toBe(true);
  });
  it('derives catalog-create Domain discovery only from its signed exact child operand', () => {
    const create = { serverId: 'home', projectSourceId: 'source', requestKey: 'create', name: 'Web',
      protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers', definition: {
        from: 'catalogApp', templateRef: { sourceId: 'apps', itemId: 'web', version: '1',
          ref: { kind: 'content', digest: `sha256:${'c'.repeat(64)}` } } } };
    const rootPreparationAdmission = projectDeploymentPreparationAdmissionV1('deployments.environments.create', create);
    const wire = { v: 1, kind: 'domainDiscover', actionId: 'deployments.domains.add', input: root,
      machineId: 'receiver', installationId: 'installed' };
    const reviewedChild = { actionId: wire.actionId, role: 'template.domain:web',
      inputDigest: computeActionInputApprovalDigestV1('deployments.domains.add', root) };
    const transport = { deploymentChildRoot: true as const, rootActionId: 'deployments.environments.create', rootPreparationAdmission, reviewedChild,
      effectActionId: wire.actionId, method: RPC_METHODS.DAEMON_DEPLOYMENT_CHILD, params: wire };
    const job = readDeploymentChildRpcV1(transport);
    expect(job).toEqual(wire);
    const derivation = { ...transport, rootInput: create, child: DeploymentChildRpcV1Schema.parse(wire) };
    expect(doesDeploymentChildInputMatchRootV1(derivation)).toBe(true);
    expect(doesDeploymentChildInputMatchRootV1({ ...derivation, reviewedChild: undefined })).toBe(false);
    expect(doesDeploymentChildInputMatchRootV1({ ...derivation, reviewedChild: { ...reviewedChild,
      inputDigest: computeActionInputApprovalDigestV1('deployments.domains.add', { ...root, contentArtifactId: 'foreign' }) } })).toBe(false);
    expect(doesDeploymentChildInputMatchRootV1({ ...derivation, reviewedChild: { ...reviewedChild,
      actionId: 'deployments.domains.remove' } })).toBe(false);
    expect(readDeploymentChildRpcV1({ ...transport, rootPreparationAdmission: undefined })).toBeNull();
    expect(readDeploymentChildRpcV1({ ...transport, rootPreparationAdmission: rootPreparationAdmission?.operation === 'create'
      ? { ...rootPreparationAdmission, mode: 'preview' } : undefined })).toBeNull();
  });
  it('derives teardown Domain discovery and membership reconciliation from the same Environment root', () => {
    const child = DeploymentChildRpcV1Schema.parse({ v: 1, kind: 'domainDiscover', actionId: 'deployments.domains.remove',
      input: { serverId: root.serverId, environmentId: root.environmentId, domainId: root.domainId,
        expectedRevision: root.expectedRevision, expectedDomainRevision: 2, requestKey: root.requestKey,
        contentArtifactId: root.contentArtifactId, contentHeaderVersion: root.contentHeaderVersion,
        contentBodyVersion: root.contentBodyVersion, targetLinkId: root.targetLinkId,
        expectedTargetLinkRevision: root.expectedTargetLinkRevision }, machineId: 'receiver', installationId: 'installed' });
    const rootInput = { serverId: root.serverId, environmentId: root.environmentId, reason: 'manual' };
    const derivation = { rootActionId: 'deployments.teardown', rootInput, child };
    expect(doesDeploymentChildInputMatchRootV1(derivation)).toBe(true);
    const nativeChild = DeploymentChildRpcV1Schema.parse({ v: 1, kind: 'domain', actionId: 'deployments.domains.remove',
      input: { serverId: root.serverId, environmentId: root.environmentId, domainId: root.domainId },
      machineId: 'receiver', installationId: 'installed', expectedDomainRevision: 2, capture, actionOperationId: 'operation' });
    expect(doesDeploymentChildInputMatchRootV1({ ...derivation, child: nativeChild })).toBe(true);
    // Removing the Environment includes a Domain's retained predecessor capture.
    expect(doesDeploymentChildInputMatchRootV1({ ...derivation, child: nativeChild,
      rootInput: { ...rootInput, targetLinkId: 'replacement-runtime' } })).toBe(true);
    const rootBinding = ExternalActionExecutionAuthorizationBindingV1Schema.parse({
      accountId: 'owner', custodianAccountId: 'owner', authentication: { kind: 'account', tokenEpoch: 1 },
      serverIdentityId: root.serverId, machineId: 'controller', installationId: 'controller-installation',
      actionId: 'deployments.teardown', target: { kind: 'machine', machineId: 'controller' },
      requestId: 'request', requestEnvelopeDigest: 'a'.repeat(43), accountEncryptionMode: 'plain',
      environmentId: root.environmentId, deploymentChildRoot: true,
    });
    expect(doesDeploymentChildInputMatchRootV1({ ...derivation, rootInput: undefined, rootBinding })).toBe(true);
    expect(doesDeploymentChildInputMatchRootV1({ ...derivation, rootInput: undefined,
      rootBinding: { ...rootBinding, environmentId: 'foreign' } })).toBe(false);
    expect(doesDeploymentChildInputMatchRootV1({ ...derivation, rootInput: undefined,
      rootBinding: { ...rootBinding, serverIdentityId: 'foreign' } })).toBe(false);
    expect(doesDeploymentChildInputMatchRootV1({ ...derivation, rootInput: { ...rootInput, environmentId: 'foreign' } })).toBe(false);
    expect(doesDeploymentChildInputMatchRootV1({ ...derivation, rootInput: { ...rootInput, serverId: 'foreign' } })).toBe(false);
    // Partial teardown reconciles routes for remaining members through the existing Add owner.
    expect(doesDeploymentChildInputMatchRootV1({ ...derivation,
      child: DeploymentChildRpcV1Schema.parse({ ...nativeChild, actionId: 'deployments.domains.add' }) })).toBe(true);
    expect(readDeploymentChildRpcV1({ deploymentChildRoot: true, rootActionId: 'deployments.teardown',
      effectActionId: 'deployments.domains.remove', method: RPC_METHODS.DAEMON_DEPLOYMENT_CHILD, params: child })).toEqual(child);
  });
  it('derives teardown Domain discovery and native work from a complete native root', () => {
    const rootInput = { serverId: root.serverId, environmentId: root.environmentId, targetLinkId: root.targetLinkId,
      expectedRevision: root.expectedRevision, expectedTargetLinkRevision: root.expectedTargetLinkRevision,
      reason: 'manual', requestKey: root.requestKey };
    const child = DeploymentChildRpcV1Schema.parse({ v: 1, kind: 'teardown', actionId: 'deployments.teardown',
      input: { ...rootInput, contentArtifactId: root.contentArtifactId,
        contentHeaderVersion: root.contentHeaderVersion, contentBodyVersion: root.contentBodyVersion },
      machineId: 'receiver', installationId: 'installed', deploymentId: 'teardown-receipt',
      actionOperationId: 'teardown-operation', step: 'removeTarget', mode: 'observe' });
    const derivation = { rootActionId: 'deployments.teardown', rootInput, child };
    expect(doesDeploymentChildInputMatchRootV1(derivation)).toBe(true);
    expect(doesDeploymentChildInputMatchRootV1({ ...derivation, rootInput: { ...rootInput, requestKey: 'foreign' } })).toBe(false);
    expect(doesDeploymentChildInputMatchRootV1({ ...derivation, rootInput: { ...rootInput, expectedRevision: root.expectedRevision + 1 } })).toBe(false);
    expect(doesDeploymentChildInputMatchRootV1({ ...derivation, rootInput: { ...rootInput, expectedTargetLinkRevision: root.expectedTargetLinkRevision + 1 } })).toBe(false);
    expect(DeploymentChildRoutingV1Schema.parse(projectDeploymentChildRoutingV1(child)))
      .toMatchObject({ kind: 'teardown', actionId: 'deployments.teardown', mode: 'observe', step: 'removeTarget' });
  });
  it('binds remove discovery to the exact original remove operand without promoting derived references into its root', () => {
    const remove = { serverId: root.serverId, environmentId: root.environmentId, domainId: root.domainId,
      expectedRevision: root.expectedRevision, expectedDomainRevision: 2, requestKey: root.requestKey };
    const wire = { v: 1, kind: 'domainDiscover', actionId: 'deployments.domains.remove', input: { ...remove,
      contentArtifactId: root.contentArtifactId, contentHeaderVersion: root.contentHeaderVersion,
      contentBodyVersion: root.contentBodyVersion, targetLinkId: root.targetLinkId,
      expectedTargetLinkRevision: root.expectedTargetLinkRevision }, machineId: 'receiver', installationId: 'installed' };
    const child = DeploymentChildRpcV1Schema.parse(wire);
    expect(doesDeploymentChildInputMatchRootV1({ rootActionId: wire.actionId, rootInput: remove, child })).toBe(true);
    const rootBinding = ExternalActionExecutionAuthorizationBindingV1Schema.parse({
      accountId: 'owner', custodianAccountId: 'owner', authentication: { kind: 'account', tokenEpoch: 1 },
      serverIdentityId: 'home', machineId: 'controller', installationId: 'controller-installation',
      actionId: wire.actionId, target: { kind: 'machine', machineId: 'controller' },
      requestId: 'request', requestEnvelopeDigest: 'a'.repeat(43), accountEncryptionMode: 'plain',
      environmentId: 'environment', deploymentChildRoot: true,
      deploymentNativeAdmission: projectDeploymentNativeAdmissionV1(wire.actionId, remove),
    });
    expect(doesDeploymentChildInputMatchRootV1({ rootActionId: wire.actionId, rootInput: undefined, rootBinding, child })).toBe(true);
    for (const changed of [{ ...remove, requestKey: 'foreign' }, { ...remove, expectedDomainRevision: 3 },
      { ...remove, domainId: 'foreign' }, { ...remove, expectedRevision: remove.expectedRevision + 1 }]) {
      expect(doesDeploymentChildInputMatchRootV1({ rootActionId: wire.actionId, rootInput: changed, child })).toBe(false);
    }
    expect(DeploymentChildRoutingV1Schema.parse(projectDeploymentChildRoutingV1(child))).toEqual(wire);
    expect(doesDeploymentChildInputMatchRootV1({ rootActionId: 'deployments.domains.add', rootInput: root, child })).toBe(false);
  });
  it('admits pre-capture discovery only under the exact original add root', () => {
    const wire = { v: 1, kind: 'domainDiscover', actionId: 'deployments.domains.add', input: root,
      machineId: 'receiver', installationId: 'installed' };
    const job = readDeploymentChildRpcV1({ deploymentChildRoot: true, rootActionId: wire.actionId, effectActionId: wire.actionId,
      method: RPC_METHODS.DAEMON_DEPLOYMENT_CHILD, params: wire });
    expect(job).toEqual(wire);
    expect(DeploymentChildRoutingV1Schema.parse(projectDeploymentChildRoutingV1(job!))).toEqual(wire);
    expect(doesDeploymentChildInputMatchRootV1({ rootActionId: wire.actionId, rootInput: root, child: job! })).toBe(true);
    expect(doesDeploymentChildInputMatchRootV1({ rootActionId: wire.actionId,
      rootInput: { ...root, contentArtifactId: 'foreign' }, child: job! })).toBe(false);
    expect(readDeploymentChildRpcV1({ deploymentChildRoot: true, rootActionId: 'deployments.domains.remove', effectActionId: wire.actionId,
      method: RPC_METHODS.DAEMON_DEPLOYMENT_CHILD, params: wire })).toBeNull();
  });
});

describe('exact preview list demand', () => {
  it('preserves exact receipt filters in the existing list GET', () => {
    const input = { serverId: 'home', environmentId: 'environment', state: 'failed', actorAccountId: 'account', operation: 'rollback' };
    const request = bindHomeDomainHttpRequestV1({ transport: { method: 'GET', path: '/v1/deployments/environments/:environmentId/deployments' },
      inputSchema: DeploymentActionInputSchemasV1['deployments.receipts.list'], input });
    const url = new URL(request.path, 'https://home.test');
    expect(url.pathname).toBe('/v1/deployments/environments/environment/deployments');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ state: 'failed', actorAccountId: 'account', operation: 'rollback' });
    expect(DeploymentActionInputSchemasV1['deployments.receipts.list'].safeParse({ ...input, operation: 'unknown' }).success).toBe(false);
  });

  it('carries the exact template Environment selector through the existing list GET without PR ids', () => {
    const input = { serverId: 'home', previewTemplateEnvironmentId: 'template-environment' };
    const parsed = DeploymentEnvironmentListInputV1Schema.parse(input);
    const request = bindHomeDomainHttpRequestV1({ transport: { method: 'GET', path: '/v1/deployments/environments' },
      inputSchema: DeploymentEnvironmentListInputV1Schema, input: parsed });
    expect(new URL(request.path, 'https://home.test').searchParams.get('previewTemplateEnvironmentId')).toBe(input.previewTemplateEnvironmentId);
    expect(DeploymentEnvironmentListInputV1Schema.safeParse({ ...input, projection: 'activity' }).success).toBe(false);
  });
  it('carries a separate bodyless activity change without replacing the ordinary receipt wake', () => {
    const activity = { projectSourceId: 'source', environmentId: 'environment', activityChanged: true as const, revision: 2 };
    expect(DeploymentAccountChangeHintV1Schema.safeParse({ deployment: activity }).success).toBe(true);
    const ordinary = buildDeploymentAccountChangeV1({ projectSourceId: 'source', environmentId: 'environment', deploymentId: 'receipt', revision: 2 });
    const changed = buildDeploymentAccountChangeV1(activity);
    expect(ordinary.entityId).toBe('deployment-receipt:environment:receipt:source');
    expect(changed.entityId).not.toBe(ordinary.entityId);
    expect(readDeploymentAccountChangeV1(changed)).toEqual({ projectSourceId: 'source', environmentId: 'environment', activityChanged: true });
    expect(readDeploymentAccountChangeV1({ kind: changed.kind, entityId: changed.entityId }))
      .toEqual({ projectSourceId: 'source', environmentId: 'environment', activityChanged: true });
  });

  it('carries an admitted repository relation and exact PR ids through the existing list GET', () => {
    const input = { serverId: 'home', previewRepositoryId: 'source-repository', previewPullRequestIds: ['pr:17', 'pr:18'] };
    expect(DeploymentEnvironmentListInputV1Schema.safeParse(input).success).toBe(true);
    const request = bindHomeDomainHttpRequestV1({ transport: { method: 'GET', path: '/v1/deployments/environments' },
      inputSchema: DeploymentEnvironmentListInputV1Schema, input });
    const query = new URL(request.path, 'https://home.test').searchParams;
    expect(query.get('previewRepositoryId')).toBe(input.previewRepositoryId);
    expect(query.getAll('previewPullRequestIds')).toEqual(input.previewPullRequestIds);
    expect(DeploymentEnvironmentListInputV1Schema.safeParse({ ...input, previewPullRequestIds: [] }).success).toBe(false);
    expect(DeploymentEnvironmentListInputV1Schema.safeParse({ serverId: input.serverId,
      previewPullRequestIds: input.previewPullRequestIds }).success).toBe(false);
  });
  it('encodes the exact repository identity and PR selector through the public Home GET binder', () => {
    const input = { serverId: 'home', previewRepository: { kind: 'github' as const,
      deployment: 'https://github.com', repository: 'acme/preview' }, previewPullRequestIds: ['17'] };
    const request = bindHomeDomainHttpRequestV1({ transport: { method: 'GET', path: '/v1/deployments/environments' },
      inputSchema: DeploymentEnvironmentListInputV1Schema, input });
    const query = new URL(request.path, 'https://home.test').searchParams;
    expect(JSON.parse(query.get('previewRepository')!)).toEqual(input.previewRepository);
    expect(query.getAll('previewPullRequestIds')).toEqual(['17']);
  });
});

describe('private provider link preparation intent', () => {
  it('admits complete provider content only at the Action boundary and keeps storage reference-only', () => {
    const input = { serverId: 'home', environmentId: 'environment', expectedRevision: 1, requestKey: 'link-data',
      targetId: 'managed-data', role: 'data', source: { kind: 'plugin', contribution: { pluginId: 'example.data', localId: 'database' } },
      targetKind: 'database', machines: [], provider: {
        credentialPrincipal: { kind: 'account', accountId: 'owner',
          purpose: { consumer: { pluginId: 'example.data', localId: 'link' }, purpose: 'manage' },
          target: { kind: 'account', account: { service: { pluginId: 'example.data', localId: 'service' }, accountId: 'credential' } } },
        providerIdentity: { providerAccountId: 'organization', providerResourceId: 'project', providerEnvironment: 'branch' },
        providerEnvironment: { kind: 'custom', id: 'branch' },
      } };
    expect(DeploymentTargetLinkProviderContentV1Schema.parse(input.provider)).toEqual(input.provider);
    // Both arms of the prior Action contract reject this valid private operand.
    expect(DeploymentTargetLinkIntentInputV1Schema.safeParse(input)).toMatchObject({ success: false,
      error: { issues: [expect.objectContaining({ code: 'unrecognized_keys', keys: ['provider'] })] } });
    expect(DeploymentTargetLinkInputV1Schema.safeParse(input).success).toBe(false);
    expect(DeploymentActionInputSchemasV1['deployments.targets.link'].parse(input)).toEqual(input);
    const reference = { contentArtifactId: 'private-content', contentHeaderVersion: 1, contentBodyVersion: 1 };
    expect(DeploymentTargetLinkInputV1Schema.safeParse({ ...input, ...reference }).success).toBe(false);
    const { provider, ...storage } = input;
    expect(DeploymentTargetLinkInputV1Schema.parse({ ...storage, ...reference })).toEqual({ ...storage, ...reference });
    expect(DeploymentActionInputSchemasV1['deployments.targets.link'].safeParse(storage).success).toBe(false);
    expect(DeploymentActionInputSchemasV1['deployments.targets.link'].safeParse({ ...input,
      provider: { ...provider, credentialPrincipal: undefined } }).success).toBe(false);
    expect(DeploymentActionInputSchemasV1['deployments.targets.link'].safeParse({ ...input,
      role: 'runtime', source: { kind: 'host', id: input.targetId }, targetKind: 'ownServer',
      machines: [{ machineId: 'runtime', installationId: 'installed' }] }).success).toBe(false);
  });
});

describe('repository-free create intent', () => {
  it('admits the existing catalogApp pin with a reviewed unsaved Project owner and refuses two Project authorities', () => {
    const input = { serverId: 'home', requestKey: 'create-app', name: 'App', mode: 'preview',
      protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers',
      newProject: { name: 'App project', owner: { kind: 'team', teamId: 'team' }, requestKey: 'create-app-project' },
      definition: { from: 'catalogApp', templateRef: { sourceId: 'apps', itemId: 'app', version: '1',
        ref: { kind: 'content', digest: `sha256:${'a'.repeat(64)}` } } },
      firstTargetLink: { machines: [{ machineId: 'target', installationId: 'installed' }] } };
    expect(DeploymentActionInputSchemasV1['deployments.environments.create'].safeParse(input).success).toBe(true);
    expect(DeploymentActionInputSchemasV1['deployments.environments.create'].safeParse({ ...input, projectSourceId: 'existing' }).success).toBe(false);
    expect(DeploymentActionInputSchemasV1['deployments.environments.create'].safeParse({ ...input,
      newProject: { ...input.newProject, owner: undefined } }).success).toBe(false);
  });
});

describe('deployment child promotion routing', () => {
  it('derives activation from the retained compact selection without borrowing another promotion', () => {
    const selection = { serverId: 'home', environmentId: 'destination', sourceEnvironmentId: 'source',
      sourceDeploymentId: 'selected', artifact: 'image' as const };
    for (const intent of [selection, { ...selection, requestKey: 'promotion' }]) {
      const prepared = buildDeploymentPromoteInputV1(intent, { requestKey: 'promotion', expectedRevision: 4,
        targetLinkId: 'destination-runtime', expectedTargetLinkRevision: 2,
        candidate: { contentArtifactId: 'candidate', contentHeaderVersion: 1, contentBodyVersion: 1 },
        destinationContent: { contentArtifactId: 'destination-content', contentHeaderVersion: 1, contentBodyVersion: 1 } });
      const child = DeploymentChildRpcV1Schema.parse({ v: 1, kind: 'member', actionId: 'deployments.promote',
        machineId: 'destination-controller', installationId: 'installed', input: prepared,
        deploymentId: 'promotion-receipt', actionOperationId: 'promotion-operation', phase: 'activate',
        selectedDeploymentId: 'promotion-receipt' });
      const derivation = { rootActionId: 'deployments.promote', rootInput: intent, child };
      expect(doesDeploymentChildInputMatchRootV1(derivation)).toBe(true);
      for (const patch of [{ serverId: 'foreign' }, { environmentId: 'foreign' }, { sourceEnvironmentId: 'foreign' },
        { sourceDeploymentId: 'foreign' }, { artifact: 'rebuild' }, ...('requestKey' in intent ? [{ requestKey: 'foreign' }] : [])]) {
        expect(doesDeploymentChildInputMatchRootV1({ ...derivation, rootInput: { ...intent, ...patch } })).toBe(false);
      }
      // Prepared roots retain the destination/link CAS captured by review.
      expect(doesDeploymentChildInputMatchRootV1({ ...derivation, rootInput: prepared })).toBe(true);
      for (const patch of [{ targetLinkId: 'foreign' }, { expectedRevision: 5 }, { expectedTargetLinkRevision: 3 }]) {
        expect(doesDeploymentChildInputMatchRootV1({ ...derivation, rootInput: { ...prepared, ...patch } })).toBe(false);
      }
    }
  });
});

describe('deployment child rollback routing', () => {
  it('retains the exact rollback selection through the signed routing schema and refuses missing or borrowed selections', () => {
    const job = DeploymentChildRpcV1Schema.parse({ v: 1, kind: 'review', actionId: 'deployments.rollback',
      machineId: 'receiver', installationId: 'installed', input: { serverId: 'home', environmentId: 'environment',
        targetLinkId: 'runtime', expectedRevision: 2, expectedTargetLinkRevision: 1, requestKey: 'rollback',
        contentArtifactId: 'candidate', contentHeaderVersion: 1, contentBodyVersion: 1, deploymentId: 'selected' } });
    const routing = projectDeploymentChildRoutingV1(job);
    expect(DeploymentChildRoutingV1Schema.parse(routing)).toMatchObject({ input: { deploymentId: 'selected' } });
    const { deploymentId: _selected, ...withoutSelection } = { ...routing.input, deploymentId: 'selected' };
    expect(DeploymentChildRoutingV1Schema.safeParse({ ...routing, input: withoutSelection }).success).toBe(false);
    expect(DeploymentChildRoutingV1Schema.safeParse({ ...routing, actionId: 'deployments.deploy' }).success).toBe(false);
    const intent = { serverId: 'home', environmentId: 'environment', deploymentId: 'selected', requestKey: 'rollback' };
    expect(DeploymentActionInputSchemasV1['deployments.rollback'].parse(intent)).toEqual(intent);
    expect(DeploymentRollbackInputV1Schema.safeParse(intent).success).toBe(false);
    expect(doesDeploymentChildInputMatchRootV1({ child: job, rootInput: intent })).toBe(true);
    for (const patch of [{ environmentId: 'other' }, { deploymentId: 'other' }, { requestKey: 'other' }, { restoreBackupId: 'other' }]) {
      expect(doesDeploymentChildInputMatchRootV1({ child: job, rootInput: { ...intent, ...patch } })).toBe(false);
    }
  });
});

describe('Environment binding authored patch', () => {
  it('carries exact required binding identities only privately and non-content routing summaries through prepared input', () => {
    const source = { kind: 'secret', ref: formatSharedSavedSecretRefV1('credential'), resourceRevision: 3 };
    const identities = [
      { purpose: 'variable', name: 'BUILD_TOKEN', phase: 'build', grantRef: '00000000-0000-4000-8000-000000000001' },
      { purpose: 'variable', name: 'RUNTIME_TOKEN', phase: 'runtime', grantRef: '00000000-0000-4000-8000-000000000002' },
    ];
    const bindings = [...identities,
      { purpose: 'registry', targetLinkId: 'runtime', registryOrigin: 'https://private-registry.example.com', access: 'pushPull' },
      { purpose: 'dataRole', service: 'private-service-sentinel', role: 'readOnlyPassword' },
    ].map(identity => EnvironmentSecretBindingV1Schema.parse({ ...identity, source }));
    const captures = captureDeploymentBindingSavedSecretRevisionsV1(bindings);
    const routing = [
      { purpose: 'dataRole' },
      { purpose: 'registry', targetLinkId: 'runtime', access: 'pushPull' },
      { purpose: 'variable', phase: 'build' },
      { purpose: 'variable', phase: 'runtime' },
    ];
    expect(captures).toEqual([{ resourceId: 'credential', revision: 3, requiredBindings: routing }]);
    for (const privateContent of ['BUILD_TOKEN', 'RUNTIME_TOKEN', '00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000002', 'private-registry.example.com', 'private-service-sentinel']) {
      expect(JSON.stringify(captures)).not.toContain(privateContent);
    }
    expect(captureDeploymentBindingSavedSecretRevisionsV1([...bindings].reverse().concat(bindings))).toEqual(captures);
    const prepared = { serverId: 'home', environmentId: 'environment', expectedRevision: 1,
      contentArtifactId: 'content', contentHeaderVersion: 1, contentBodyVersion: 1,
      referencedSavedSecretRevisions: captures };
    expect(DeploymentBindingsPreparedInputV1Schema.parse(prepared)).toEqual(prepared);
    expect(DeploymentBindingsPreparedInputV1Schema.safeParse({ ...prepared,
      referencedSavedSecretRevisions: [{ ...captures[0], requiredBindings: [routing[0], routing[0]] }] }).success).toBe(false);
    const legacy = { ...prepared, referencedSavedSecretRevisions: [{ resourceId: 'credential', revision: 3 }] };
    expect(DeploymentBindingsPreparedInputV1Schema.parse(legacy)).toEqual(legacy);
    expect(matchesDeploymentBindingSavedSecretCapturesV1(captures, legacy.referencedSavedSecretRevisions)).toBe(true);
    expect(matchesDeploymentBindingSavedSecretCapturesV1(captures, [{ resourceId: 'credential', revision: 3,
      requiredBindings: [{ purpose: 'variable', phase: 'build' }] }])).toBe(false);
    expect(DeploymentBindingsPreparedInputV1Schema.safeParse({ ...prepared,
      referencedSavedSecretRevisions: [{ resourceId: 'credential', revision: 3,
        requiredBindings: [{ purpose: 'variable', phase: 'build', name: 'PRIVATE_NAME' }] }] }).success).toBe(false);
  });

  it('narrows only pending sources while preserving scope, row order, count and nonpending rows', () => {
    const spec = getActionSpec('deployments.bindings.set');
    const pending = { purpose: 'variable', name: 'API_TOKEN', phase: 'runtime', source: { kind: 'secret', ref: 'person_selects' } };
    const plain = { purpose: 'variable', name: 'PORT', phase: 'runtime', source: { kind: 'value', value: '3000' } };
    const original = { serverId: 'home', environmentId: 'environment', expectedRevision: 1,
      set: [pending, plain], remove: [{ purpose: 'domainCredential', domainId: 'domain', role: 'basicAuth' }] };
    const exact = { ...pending, source: { kind: 'secret', ref: formatSharedSavedSecretRefV1('credential'), resourceRevision: 3 } };
    const chosen = { ...original, set: [exact, plain] };
    expect(spec.approvalNarrowing?.narrow(original, chosen)).toEqual(chosen);
    for (const invalid of [original, { ...chosen, serverId: 'foreign' }, { ...chosen, environmentId: 'foreign' },
      { ...chosen, expectedRevision: 2 }, { ...chosen, remove: [] }, { ...chosen, set: [plain, exact] },
      { ...chosen, set: [exact] }, { ...chosen, set: [exact, plain, { ...plain, name: 'EXTRA' }] },
      { ...chosen, set: [exact, { ...plain, source: { kind: 'value', value: '3001' } }] },
      { ...chosen, set: [{ ...exact, phase: 'build' }, plain] },
      { ...chosen, set: [{ ...exact, source: { ...exact.source, ref: 'personal-secret' } }, plain] },
      { ...chosen, set: [{ ...exact, source: { ...exact.source, resourceRevision: 0 } }, plain] }]) {
      expect(spec.approvalNarrowing?.narrow(original, invalid)).toBeNull();
    }
    expect(spec.approvalNarrowing?.narrow(chosen, chosen)).toBeNull();
    const signedAddress = { purpose: 'dataRole', service: ' database ', role: 'readOnlyPassword', source: pending.source };
    const addressInput = { ...original, set: [signedAddress] };
    const exactAddress = { ...signedAddress, source: exact.source };
    const addressChoice = { ...addressInput, set: [exactAddress] };
    expect(spec.approvalNarrowing?.narrow(addressInput, addressChoice)).toEqual(addressChoice);
    expect(spec.approvalNarrowing?.narrow(addressInput, { ...addressChoice, set: [{ ...exactAddress, service: 'database' }] })).toBeNull();
    const signedReference = { ...plain, source: { kind: 'reference', environmentId: 'source', export: ' database ', via: 'auto' } };
    expect(spec.approvalNarrowing?.narrow({ ...original, set: [pending, signedReference] },
      { ...chosen, set: [exact, { ...signedReference, source: { ...signedReference.source, export: 'database' } }] })).toBeNull();
  });

  it('admits pending choices only as authored input and rejects duplicate purpose identities across set/remove', () => {
    const schema = getActionSpec('deployments.bindings.set').inputSchema;
    const binding = { purpose: 'variable', name: 'API_TOKEN', phase: 'runtime',
      source: { kind: 'secret', ref: 'person_selects' } };
    const patch = { serverId: 'home', environmentId: 'environment', expectedRevision: 1, set: [binding], remove: [] };
    expect(schema.safeParse(patch).success).toBe(true);
    expect(schema.safeParse({ ...patch, set: [binding, binding] }).success).toBe(false);
    expect(schema.safeParse({ ...patch, remove: [{ purpose: 'variable', name: 'API_TOKEN', phase: 'runtime' }] }).success).toBe(false);
    expect(schema.safeParse({ ...patch, set: [{ ...binding, source: { ...binding.source, resourceRevision: 1 } }] }).success).toBe(false);
    expect(schema.safeParse({ ...patch, contentArtifactId: 'overlay', contentHeaderVersion: 1, contentBodyVersion: 1 }).success).toBe(false);
    const exact = { ...binding, source: { kind: 'secret', ref: formatSharedSavedSecretRefV1('credential'), resourceRevision: 3 } };
    expect(schema.safeParse({ ...patch, set: [exact] }).success).toBe(true);
    expect(schema.safeParse({ ...patch, set: [{ ...exact, source: { ...exact.source, resourceRevision: 0 } }] }).success).toBe(false);
  });
});

describe('deployment semantic preparation', () => {
  it('requires committed retry identity for prepared copies without changing ordinary creation', () => {
    const ordinary = { serverId: 'home', projectSourceId: 'destination', requestKey: 'duplicate',
      protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers', controllerMachineId: 'controller',
      contentArtifactId: 'content', contentHeaderVersion: 1, contentBodyVersion: 1 };
    const source = { environmentId: 'production', expectedRevision: 7 };
    const prepared = { ...ordinary, copyFrom: { ...source, choices: { secrets: [], values: [], data: [] } },
      copyPlan: { bindings: [] } };
    const publicInput = getActionSpec('deployments.environments.create').inputSchema;
    expect(publicInput.safeParse(ordinary).success).toBe(true);
    expect(DeploymentEnvironmentCreateStorageInputV1Schema.safeParse(ordinary).success).toBe(true);
    expect.soft(publicInput.safeParse(prepared).success).toBe(false);
    expect.soft(DeploymentEnvironmentCreateStorageInputV1Schema.safeParse({ ...ordinary, copyFrom: source }).success).toBe(false);
    expect(publicInput.safeParse({ ...prepared, copyIntentCommitment: 'A'.repeat(43) }).success).toBe(true);
    expect(DeploymentEnvironmentCreateStorageInputV1Schema.safeParse({ ...ordinary, copyFrom: source,
      copyIntentCommitment: 'A'.repeat(43) }).success).toBe(true);
  });

  it('creates a repository-backed platform Environment without Compose and keeps native first links explicit', () => {
    const input = { serverId: 'home', projectSourceId: 'source', requestKey: 'platform-create', name: 'Static site',
      protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers',
      definition: { from: 'repository', ref: 'main' } };
    const schema = getActionSpec('deployments.environments.create').inputSchema;
    expect(schema.safeParse(input).success).toBe(true);
    expect(schema.safeParse({ ...input, firstTargetLink: {
      machines: [{ machineId: 'runtime', installationId: 'installation' }] } }).success).toBe(false);
    expect(schema.safeParse({ ...input, definition: undefined }).success).toBe(false);
    expect(schema.safeParse({ ...input, definition: { ...input.definition, compose: { path: 'compose.yaml',
      profiles: [], services: [] } }, firstTargetLink: {
      machines: [{ machineId: 'runtime', installationId: 'installation' }] } }).success).toBe(true);
    expect(schema.safeParse({ ...input, definition: { ...input.definition, provider: 'vercel' } }).success).toBe(false);
  });

  it('admits explicit Duplicate choices without a caller-authored replacement definition', () => {
    const input = { serverId: 'home', projectSourceId: 'destination', requestKey: 'duplicate', name: 'Staging',
      protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers',
      copyFrom: { environmentId: 'production', expectedRevision: 7, choices: { secrets: [], values: [], data: [] } } };
    const schema = getActionSpec('deployments.environments.create').inputSchema;
    expect(schema.safeParse(input).success).toBe(true);
    const spec = getActionSpec('deployments.environments.create');
    expect(resolveActionExecutionPlacementForInput(spec, input, undefined, 'ui')).toBe('machine');
    expect(resolveActionExecutionPlacementForInput(spec, { ...input, mode: 'preview' }, undefined, 'ui')).toBe('machine');
    expect(schema.safeParse({ ...input, copyFrom: { environmentId: 'production', expectedRevision: 7 } }).success).toBe(false);
    expect(schema.safeParse({ ...input, copyFrom: { ...input.copyFrom, choices: { values: [], data: [] } } }).success).toBe(false);
  });

  it('keeps preview PR identity within its portable stored character boundary without truncating valid Unicode ids', () => {
    const prepared = { serverId: 'home', projectSourceId: 'source', requestKey: 'preview', protection: 'nonProduction',
      purpose: 'preview', deployerMode: 'managers', controllerMachineId: 'controller',
      contentArtifactId: 'content', contentHeaderVersion: 1, contentBodyVersion: 1,
      preview: { templateEnvironmentId: 'template', expectedTemplateRevision: 1, runtimeTargetLinkId: 'runtime' } };
    for (const character of ['a', '🙂']) {
      const valid = character.repeat(191);
      expect(DeploymentEnvironmentCreateInputV1Schema.parse({ ...prepared,
        preview: { ...prepared.preview, pullRequestId: valid } }).preview?.pullRequestId).toBe(valid);
      expect(DeploymentEnvironmentHeaderV1Schema.shape.previewPullRequestId.parse(valid)).toBe(valid);
      const oversized = character.repeat(192);
      expect(DeploymentEnvironmentCreateInputV1Schema.safeParse({ ...prepared,
        preview: { ...prepared.preview, pullRequestId: oversized } }).success).toBe(false);
      expect(DeploymentEnvironmentHeaderV1Schema.shape.previewPullRequestId.safeParse(oversized).success).toBe(false);
    }
  });

  it('retains a named preview companion through authored admission, prepared storage and exact list demand', () => {
    const actionId = 'deployments.environments.create';
    const repository = { kind: 'github', deployment: 'https://github.com', repository: 'acme/app' };
    const reference = { templateEnvironmentId: 'template', expectedTemplateRevision: 7,
      pullRequestId: 'pr:17', runtimeTargetLinkId: 'runtime' };
    const authored = { serverId: 'home', projectSourceId: 'source', requestKey: 'companion',
      protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers',
      previewCompanionOfEnvironmentId: 'main-preview', preview: { ...reference, headSha: 'a'.repeat(40),
        provenance: { v: 1, templateEnvironmentId: 'template', runtimeTargetLinkId: 'runtime', repository,
          pullRequestId: 'pr:17', pullRequestNumber: 17, author: { id: 'author', login: 'contributor' },
          headRepository: repository } } };
    const schema = getActionSpec(actionId).inputSchema;
    const parsed = schema.parse(authored);
    expect(parsed).toMatchObject({ previewCompanionOfEnvironmentId: 'main-preview', name: '', preview: authored.preview });
    expect(projectDeploymentPreparationAdmissionV1(actionId, parsed)).toMatchObject({
      operation: 'create', previewCompanionOfEnvironmentId: 'main-preview', preview: reference });
    const prepared = { serverId: 'home', projectSourceId: 'source', requestKey: 'companion',
      protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers', controllerMachineId: 'controller',
      previewCompanionOfEnvironmentId: 'main-preview', preview: reference,
      contentArtifactId: 'fresh-content', contentHeaderVersion: 1, contentBodyVersion: 1 };
    expect(DeploymentEnvironmentCreateStorageInputV1Schema.parse(prepared)).toEqual(prepared);
    expect(DeploymentEnvironmentCreateStorageInputV1Schema.safeParse({ ...prepared, purpose: 'preview' }).success).toBe(false);
    expect(schema.safeParse({ ...authored, definition: { from: 'image', image: 'postgres:17', port: 5432 } }).success).toBe(false);
    const input = { serverId: 'home', previewCompanionOfEnvironmentId: 'main-preview' };
    const spec = getActionSpec('deployments.environments.list');
    if (!spec.serverTransport) throw new Error('Environment list transport missing');
    const request = bindHomeDomainHttpRequestV1({ transport: spec.serverTransport, inputSchema: spec.inputSchema, input });
    expect(new URL(request.path, 'https://home.test').searchParams.get('previewCompanionOfEnvironmentId')).toBe('main-preview');
  });

  it('admits authored compose/image create intent without accepting a prepared-content overlay', () => {
    const schema = getActionSpec('deployments.environments.create').inputSchema;
    const metadata = { serverId: 'home', projectSourceId: 'source', requestKey: 'create',
      protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers', controllerMachineId: 'controller', name: 'App' };
    for (const definition of [
      { from: 'compose', document: 'services: {app: {image: nginx:1}}', profiles: [], services: ['app'] },
      { from: 'image', image: 'nginx:1', port: 8080 },
    ]) {
      const input = { ...metadata, definition };
      expect(schema.parse(input)).toEqual(input);
      expect(resolveActionExecutionPlacementForInput(getActionSpec('deployments.environments.create'), input, undefined, 'ui')).toBe('machine');
      expect(schema.safeParse({ ...input, contentArtifactId: 'overlay', contentHeaderVersion: 1, contentBodyVersion: 1 }).success).toBe(false);
      expect(schema.safeParse({ ...input, definition: { ...definition, kind: 'stored', contentRevision: 1 } }).success).toBe(false);
    }
    for (const port of [0, 65536, 1.5, '8080']) {
      expect(schema.safeParse({ ...metadata, definition: { from: 'image', image: 'nginx:1', port } }).success).toBe(false);
    }
    const { name: _name, ...preparedMetadata } = metadata;
    const prepared = { ...preparedMetadata, contentArtifactId: 'existing', contentHeaderVersion: 1, contentBodyVersion: 1 };
    expect(schema.parse(prepared)).toEqual(prepared);
    expect(resolveActionExecutionPlacementForInput(getActionSpec('deployments.environments.create'), prepared, undefined, 'ui')).toBe('account');
  });

  it('admits a selected Domain first deploy before original template preparation', () => {
    const actionId = 'deployments.templates.instantiate';
    const input = getActionSpec(actionId).inputSchema.parse({ mode: 'apply', serverId: 'home', machineId: 'machine',
      projectSourceId: 'source', templateRef: { sourceId: 'apps', itemId: 'web', version: '1',
        ref: { kind: 'content', digest: `sha256:${'a'.repeat(64)}` } },
      environment: { kind: 'create', requestKey: 'install', name: 'Web', controllerMachineId: 'machine',
        protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers' },
      target: { kind: 'new', installationId: 'installed' }, destination: { kind: 'stored' }, bindings: [],
      domainBindings: [{ templateDomainId: 'web', hostname: 'web.example.test' }] });
    const admission = projectDeploymentPreparationAdmissionV1(actionId, input);
    expect(deploymentChildEffectActionIdForRootV1(actionId, admission)).toBe('deployments.deploy');
    expect(admission).toMatchObject({ deploy: { requestKey: 'install' } });
    expect(deploymentChildEffectActionIdForRootV1(actionId,
      projectDeploymentPreparationAdmissionV1(actionId, { ...input, mode: 'preview' }))).toBeUndefined();
    expect(deploymentChildEffectActionIdForRootV1(actionId,
      projectDeploymentPreparationAdmissionV1(actionId, { ...input, domainBindings: [] }))).toBeUndefined();
    expect(projectDeploymentPreparationAdmissionV1(actionId, { ...input, deploy: { requestKey: 'explicit' } }))
      .toMatchObject({ deploy: { requestKey: 'explicit' } });
    const child = DeploymentChildRpcV1Schema.parse({ v: 1, kind: 'prepare', actionId: 'deployments.deploy',
      machineId: 'machine', installationId: 'installed', expectedRevision: 1, expectedTargetLinkRevision: 1,
      input: { serverId: 'home', environmentId: 'allocated-environment', targetLinkId: 'allocated-link', requestKey: 'install' } });
    expect(doesDeploymentChildInputMatchRootV1({ rootActionId: actionId, rootInput: input, child })).toBe(true);
    for (const rootInput of [{ ...input, mode: 'preview' }, { ...input, domainBindings: [] },
      { ...input, deploy: { requestKey: 'other' } }, { ...input, serverId: 'foreign' }]) {
      expect(doesDeploymentChildInputMatchRootV1({ rootActionId: actionId, rootInput, child })).toBe(false);
    }
  });

  it('places repository template changes at the admitted workspace rather than the runtime controller', async () => {
    const { resolveDeploymentTemplateExecutionMachineIdV1 } = await import('./deploymentTemplateInstantiationV1.js');
    const input = getActionSpec('deployments.templates.instantiate').inputSchema.parse({ mode: 'preview',
      serverId: 'home', machineId: 'runtime', projectSourceId: 'source',
      templateRef: { sourceId: 'apps', itemId: 'database', version: '2',
        ref: { kind: 'content', digest: `sha256:${'a'.repeat(64)}` } },
      environment: { kind: 'existing', environmentId: 'environment', expectedRevision: 2 },
      target: { kind: 'existing', targetLinkId: 'runtime', expectedRevision: 3, installationId: 'installed' },
      destination: { kind: 'repositoryPullRequest', workspace: { kind: 'workspace-ref', serverId: 'home', id: 'checkout' },
        sourceRevision: 4, repository: { kind: 'github', deployment: 'https://github.com', repository: 'owner/app' },
        baseCommit: 'a'.repeat(40), baseBranch: 'main', branchName: 'add-database', composePath: 'compose.yaml', title: 'Add database' },
      bindings: [] });
    const selected = await resolveDeploymentTemplateExecutionMachineIdV1(input,
      async () => { throw new Error('Repository placement must not require the runtime controller'); },
      async request => request.workspace.id === 'checkout' ? { ok: true, machineId: 'checkout-machine' }
        : { ok: false, errorCode: 'workspace_unavailable', error: 'workspace_unavailable' });
    expect(selected).toEqual({ ok: true, machineId: 'checkout-machine' });
    expect(projectDeploymentPreparationAdmissionV1('deployments.templates.instantiate', input))
      .toMatchObject({ workspace: { kind: 'workspace-ref', id: 'checkout' } });
    expect(projectDeploymentPreparationAdmissionV1('deployments.templates.instantiate', {
      ...input, destination: { kind: 'stored' },
    })).not.toHaveProperty('workspace');
    expect(getActionSpec('deployments.templates.instantiate').inputSchema.safeParse({ ...input,
      destination: { ...input.destination, cwd: '/caller-controlled-path' } }).success).toBe(false);
  });

  it('admits pinned opaque template intent with a read-only preview and reviewed apply', () => {
    const spec = listActionSpecsForSurface('agent').find(row => String(row.id) === 'deployments.templates.instantiate');
    expect(spec, 'The public template Action must admit its own strict semantic intent').toBeDefined();
    if (!spec) return;
    const input = { mode: 'preview', serverId: 'home', machineId: 'machine', projectSourceId: 'source',
      templateRef: { sourceId: 'apps', itemId: 'database', version: '1',
        ref: { kind: 'content', digest: `sha256:${'a'.repeat(64)}` } },
      environment: { kind: 'existing', environmentId: 'environment', expectedRevision: 2 },
      target: { kind: 'existing', targetLinkId: 'runtime', expectedRevision: 3, installationId: 'installation' },
      destination: { kind: 'stored', contentRevision: 1, composeDigest: `sha256:${'b'.repeat(64)}` },
      bindings: [{ purpose: 'variable', name: 'DB_PASSWORD', phase: 'runtime',
        source: { kind: 'secret', ref: formatSharedSavedSecretRefV1('password'), resourceRevision: 1 } }] };
    expect(spec.inputSchema.parse(input)).toEqual(input);
    expect(spec.inputSchema.safeParse({ ...input, bindings: [...input.bindings, ...input.bindings] }).success).toBe(false);
    // Add preparation owns the current definition; agent reads expose only its Artifact reference.
    expect(spec.inputSchema.safeParse({ ...input, destination: { kind: 'stored' } }).success).toBe(true);
    expect(spec.inputSchema.safeParse({ ...input, destination: { kind: 'stored' }, bindings: [{ purpose: 'variable',
      name: 'DB_PASSWORD', phase: 'runtime', source: { kind: 'generated', key: 'DB_PASSWORD' } }] }).success).toBe(true);
    expect(spec.inputSchema.safeParse({ ...input, templateRef: { ...input.templateRef, ref: undefined } }).success).toBe(false);
    expect(spec.inputSchema.safeParse({ ...input, bindings: [{ ...input.bindings[0],
      source: { kind: 'secret', value: 'plaintext-must-not-enter-the-Action' } }] }).success).toBe(false);
    expect(spec.inputSchema.safeParse({ ...input, environment: { ...input.environment, content: {} } }).success).toBe(false);
    expect(spec.serverTransport).toBeUndefined();
    expect(spec.executionPlacement).toBe('machine');
    expect(resolveActionApprovalRouting({ actionId: spec.id, spec, input, context: { surface: 'agent' } }).required).toBe(false);
    expect(resolveActionApprovalRouting({ actionId: spec.id, spec, input: { ...input, mode: 'apply' },
      context: { surface: 'agent' } }).required).toBe(true);
  });

  it('admits ids-only intent at the Action while requiring complete prepared provenance at storage', () => {
    const intent = { serverId: 'home', environmentId: 'environment', targetLinkId: 'runtime' };
    const schema = getActionSpec('deployments.deploy').inputSchema;
    expect(schema.parse(intent)).toEqual(intent);
    expect(DeploymentDeployAdmissionInputV1Schema.safeParse({ ...intent, actionOperationId: 'operation' }).success).toBe(false);
    expect(schema.safeParse({ ...intent, contentArtifactId: 'partial' }).success).toBe(false);
    expect(schema.safeParse({ ...intent, expectedRevision: 1 }).success).toBe(false);
    const prepared = { ...intent, expectedRevision: 1, expectedTargetLinkRevision: 1, requestKey: 'request',
      contentArtifactId: 'candidate', contentHeaderVersion: 1, contentBodyVersion: 1 };
    expect(schema.parse(prepared)).toEqual(prepared);
    expect(DeploymentDeployAdmissionInputV1Schema.parse({ ...prepared, actionOperationId: 'operation' }))
      .toEqual({ ...prepared, actionOperationId: 'operation' });
  });

  it('re-admits retained pending provenance against the current revision of the same link', () => {
    const pendingDeploy = { t: 'plain', v: {
      sourceIntent: { kind: 'stored', contentRevision: 1, composeDigest: `sha256:${'a'.repeat(64)}`,
        document: 'services: {}', profiles: [], services: [] },
      requestKey: 'request', targetLinkId: 'runtime', actionOperationId: 'operation',
    } };
    const input = { serverId: 'home', environmentId: 'environment', expectedRevision: 3,
      targetLinkId: 'runtime', expectedTargetLinkRevision: 2, requestKey: 'request', actionOperationId: 'operation',
      contentArtifactId: 'candidate', contentHeaderVersion: 1, contentBodyVersion: 1,
      whenBusy: 'supersede', pendingDeploy };
    expect(DeploymentDeployAdmissionInputV1Schema.parse(input)).toEqual(input);
    for (const mismatch of [{ requestKey: 'other' }, { targetLinkId: 'other' }, { actionOperationId: 'other' }]) {
      expect(DeploymentDeployAdmissionInputV1Schema.safeParse({ ...input, ...mismatch }).success).toBe(false);
    }
  });  it('retains exact compact and PR source operands through preparation without exposing them as routing metadata', () => {
    const schema = getActionSpec('deployments.deploy').inputSchema;
    const compact = { serverId: 'home', environmentId: 'environment', sha: 'a'.repeat(40),
      requestKey: 'push-A', whenBusy: 'supersede' };
    expect(schema.parse(compact)).toEqual(compact);
    expect(schema.safeParse({ ...compact, requestKey: undefined }).success).toBe(false);
    const sourceIntent = { kind: 'repository', projectSourceId: 'source', sourceRevision: 2, sha: compact.sha,
      compose: { path: 'compose.yaml', profiles: [], services: ['app'] }, pullRequestHead: { number: 42 } };
    const { sha: _sha, ...identity } = compact;
    for (const input of [compact, { ...identity, sourceIntent }]) {
      expect(schema.parse(input)).toEqual(input);
      const job = DeploymentChildRpcV1Schema.parse({ v: 1, kind: 'prepare', actionId: 'deployments.deploy',
        machineId: 'builder', installationId: 'installed', expectedRevision: 1, expectedTargetLinkRevision: 1,
        input: { ...input, targetLinkId: 'runtime' } });
      expect(doesDeploymentChildInputMatchRootV1({ rootInput: input, child: job })).toBe(true);
      expect(projectDeploymentChildRoutingV1(job)).toMatchObject({ input: {
        serverId: 'home', environmentId: 'environment', targetLinkId: 'runtime' } });
      expect(projectDeploymentChildRoutingV1(job).input).not.toHaveProperty('sha');
      expect(projectDeploymentChildRoutingV1(job).input).not.toHaveProperty('sourceIntent');
      for (const patch of [{ requestKey: 'other' }, { whenBusy: 'refuse' },
        ...('sha' in input ? [{ sha: 'b'.repeat(40) }] : [{ sourceIntent: { ...sourceIntent, pullRequestHead: { number: 43 } } }])]) {
        const substituted = DeploymentChildRpcV1Schema.parse({ ...job, input: { ...job.input, ...patch } });
        expect(doesDeploymentChildInputMatchRootV1({ rootInput: input, child: substituted })).toBe(false);
      }
      const effect = DeploymentChildRpcV1Schema.parse({ v: 1, kind: 'review', actionId: 'deployments.deploy',
        machineId: 'receiver', installationId: 'installed', input: { serverId: 'home', environmentId: 'environment',
          targetLinkId: 'runtime', expectedRevision: 1, expectedTargetLinkRevision: 1, requestKey: 'push-A', whenBusy: 'supersede',
          contentArtifactId: 'candidate', contentHeaderVersion: 1, contentBodyVersion: 1 } });
      expect(doesDeploymentChildInputMatchRootV1({ rootInput: input, child: effect })).toBe(true);
      for (const patch of [{ requestKey: 'other' }, { whenBusy: 'refuse' }]) {
        expect(doesDeploymentChildInputMatchRootV1({ rootInput: input,
          child: DeploymentChildRpcV1Schema.parse({ ...effect, input: { ...effect.input, ...patch } }) })).toBe(false);
      }
    }
    expect(schema.safeParse({ ...compact, sourceIntent }).success).toBe(false);
  });
});

describe('deployment admission results', () => {
  it('retains an exact pending operation without fabricating a receipt', () => {
    const pending = { ok: true, environmentId: 'environment', revision: 3,
      kind: 'pending', actionOperationId: 'operation' };
    expect(DeploymentReceiptResultV1Schema.parse(pending)).toEqual(pending);
    const { actionOperationId: _operation, ...missingOperation } = pending;
    expect(DeploymentReceiptResultV1Schema.safeParse(missingOperation).success).toBe(false);
    expect(DeploymentReceiptResultV1Schema.safeParse({ ...pending, deploymentId: 'active-receipt' }).success).toBe(false);
    const receipt = { ok: true, environmentId: 'environment', revision: 3,
      deploymentId: 'receipt', deploymentRevision: 1, state: 'queued' };
    expect(DeploymentReceiptResultV1Schema.parse(receipt)).toEqual(receipt);
  });
});

describe('deployment build placement update', () => {
  it('accepts the existing migration policy and explicit removal through Environment update', () => {
    const input = { serverId: 'home', environmentId: 'environment', expectedRevision: 1,
      contentArtifactId: 'content', contentHeaderVersion: 1, contentBodyVersion: 1 };
    const policy = { migration: { service: 'app', argv: ['migrate', ''], pendingCheck: { argv: ['pending'] } },
      backupBeforeMigration: false, migrationFailurePolicy: 'rollbackCodeOnly' };
    expect(DeploymentEnvironmentUpdateInputV1Schema.parse({ ...input, patch: { ownServer: policy } }).patch?.ownServer).toEqual(policy);
    expect(DeploymentEnvironmentUpdateInputV1Schema.parse({ ...input, patch: { ownServer: { migration: null } } }).patch?.ownServer)
      .toEqual({ migration: null });
    expect(omitDeploymentEnvironmentPrivateContentPatchV1({ ownServer: policy })).toEqual({ ownServer: {
      backupBeforeMigration: false, migrationFailurePolicy: 'rollbackCodeOnly' } });
  });
  it('authors exact private exports and stored source while refusing public exposure and invalid selections', () => {
    const serviceExport = { key: 'database', service: 'db', containerPort: 5432, scheme: 'postgres',
      exposure: 'privateNetwork', privateNetwork: 'network-a' };
    const input = { serverId: 'home', environmentId: 'environment', expectedRevision: 1,
      contentArtifactId: 'environment-content', contentHeaderVersion: 1, contentBodyVersion: 1,
      patch: { ownServer: { serviceExports: [serviceExport] }, definition: { from: 'compose',
        document: 'services: {db: {image: "postgres:17"}}', profiles: [], services: ['db'] } } };
    expect(DeploymentEnvironmentUpdateInputV1Schema.parse(input)).toEqual(input);
    const irohExport = { ...serviceExport, exposure: 'loopback', privateNetwork: undefined, transport: { kind: 'iroh' } };
    const irohInput = { ...input, patch: { ownServer: { serviceExports: [irohExport] } } };
    expect(DeploymentEnvironmentUpdateInputV1Schema.parse(irohInput)).toEqual(irohInput);
    const dualInput = { ...input, patch: { ownServer: { serviceExports: [{ ...serviceExport, transport: { kind: 'iroh' } }] } } };
    expect(DeploymentEnvironmentUpdateInputV1Schema.parse(dualInput)).toEqual(dualInput);
    expect(omitDeploymentEnvironmentPrivateContentPatchV1(irohInput.patch)).toEqual({});
    expect(omitDeploymentEnvironmentPrivateContentPatchV1(input.patch)).toEqual({});
    expect(omitDeploymentEnvironmentPrivateContentPatchV1({ ...input.patch,
      ownServer: { ...input.patch.ownServer, rollout: 'startFirst' } })).toEqual({ ownServer: { rollout: 'startFirst' } });
    for (const serviceExports of [
      [{ ...serviceExport, exposure: 'public', privateNetwork: undefined }],
      [{ ...serviceExport, exposure: 'loopback', privateNetwork: undefined }],
      [{ ...irohExport, exposure: 'public' }],
      [{ ...irohExport, privateNetwork: 'network-a' }],
      [{ ...irohExport, transport: { kind: 'other' } }],
      [{ ...serviceExport, privateNetwork: undefined }],
      [{ ...serviceExport, containerPort: 0 }],
      [serviceExport, serviceExport],
    ]) expect(DeploymentEnvironmentUpdateInputV1Schema.safeParse({ ...input,
      patch: { ownServer: { serviceExports } } }).success).toBe(false);
  });

  it('carries a build Machine patch through the existing strict content CAS transport', () => {
    const input = { serverId: 'home', environmentId: 'environment', expectedRevision: 1,
      contentArtifactId: 'environment-content', contentHeaderVersion: 1, contentBodyVersion: 1,
      patch: { buildMachineId: 'future-builder' } };
    const parsed = DeploymentEnvironmentUpdateInputV1Schema.parse(input);
    const transport = getActionSpec('deployments.environments.update').serverTransport!;
    expect(bindHomeDomainHttpRequestV1({ transport, inputSchema: DeploymentEnvironmentUpdateInputV1Schema, input: parsed }))
      .toMatchObject({ method: 'PATCH', path: '/v1/deployments/environments/environment', body: input });
    expect(DeploymentEnvironmentUpdateInputV1Schema.safeParse({ ...input,
      patch: { buildMachineId: 'future-builder', controllerMachineId: 'other-controller' } }).success).toBe(false);
  });
});

describe('deployment input-choice reads', () => {
  it('keeps retained cleanup demand on Environment get, separate from receipt history', () => {
    const input = { serverId: 'home', environmentId: 'environment', includeRetainedTargetLinkCleanup: true };
    expect(DeploymentActionInputSchemasV1['deployments.environments.get'].parse(input)).toEqual(input);
    expect(DeploymentActionInputSchemasV1['deployments.receipts.list'].safeParse(input).success).toBe(false);
  });

  it('preserves explicit retained Source inventory demand through the canonical read transport', () => {
    const input = { serverId: 'home', projectSourceId: 'source', includeDeleted: true as const };
    const parsed = DeploymentEnvironmentListInputV1Schema.parse(input);
    const transport = getActionSpec('deployments.environments.list').serverTransport!;
    expect(bindHomeDomainHttpRequestV1({ transport, inputSchema: DeploymentEnvironmentListInputV1Schema, input: parsed }))
      .toEqual({ method: 'GET', path: '/v1/deployments/environments?serverId=home&projectSourceId=source&includeDeleted=true', body: undefined });
    expect(DeploymentEnvironmentListInputV1Schema.safeParse({ serverId: 'home', includeDeleted: true }).success).toBe(false);
    expect(DeploymentEnvironmentListInputV1Schema.safeParse({ ...input, includeDeleted: false }).success).toBe(false);
  });

  it('admits a single exact Machine list without requiring a Source inventory', () => {
    expect(DeploymentEnvironmentListInputV1Schema.parse({ serverId: 'home', machineId: 'machine' }))
      .toEqual({ serverId: 'home', machineId: 'machine' });
    expect(DeploymentEnvironmentListInputV1Schema.parse({ serverId: 'home', projectSourceId: 'source', machineId: 'machine' }))
      .toEqual({ serverId: 'home', projectSourceId: 'source', machineId: 'machine' });
    expect(DeploymentEnvironmentListInputV1Schema.parse({ serverId: 'home' })).toEqual({ serverId: 'home' });
  });
});

describe('deployment target link identity and readable-scope transport', () => {
  const artifact = { contentArtifactId: 'link-content', contentHeaderVersion: 1, contentBodyVersion: 1 };
  const intent = { serverId: 'home', environmentId: 'environment', expectedRevision: 1,
    requestKey: 'link-intent', ...artifact };
  const plugin = { kind: 'plugin', contribution: { pluginId: 'example.deploy', localId: 'runtime' } };
  const header = { v: 1, id: 'link', environmentId: 'environment', revision: 1,
    source: plugin, role: 'runtime', targetKind: 'platform', state: 'configured',
    machines: [], members: [], ...artifact, createdByAccountId: 'creator', createdAtMs: 1, updatedAtMs: 1 };

  it('returns only an admitted existing-link destination for the typed duplicate refusal', () => {
    const existing = { ok: false, error: 'provider_scope_already_linked',
      environment: { serverId: 'home', projectSourceId: 'source', environmentId: 'existing' }, targetLinkId: 'existing-link' };
    expect(DeploymentTargetLinkResultV1Schema.parse(existing)).toEqual(existing);
    expect(DeploymentTargetLinkResultV1Schema.safeParse({ ...existing, providerResourceId: 'private-resource' }).success).toBe(false);
    expect(DeploymentTargetLinkResultV1Schema.safeParse({ ...existing, environment: { environmentId: 'existing' } }).success).toBe(false);
  });

  it('admits plugin runtime/data links without a fabricated host or own-server membership', () => {
    for (const role of ['runtime', 'data']) {
      expect(DeploymentTargetLinkHeaderV1Schema.parse({ ...header, role })).toEqual({ ...header, role });
      const input = { ...intent, targetId: 'example.deploy/platform', source: plugin, targetKind: 'platform', role, machines: [] };
      expect(DeploymentTargetLinkInputV1Schema.parse(input)).toEqual(input);
      expect(DeploymentTargetLinkInputV1Schema.parse({ ...input, machineId: 'controller', installationId: 'current-installation' }))
        .toMatchObject({ machineId: 'controller', installationId: 'current-installation' });
    }
    for (const placement of [{ machineId: 'machine' }, { installationId: 'installation' },
      { machineId: 'machine', installationId: 'installation', machines: [{ machineId: 'machine', installationId: 'installation' }] }]) {
      expect(DeploymentTargetLinkInputV1Schema.safeParse({ ...intent, targetId: 'example.deploy/platform',
        source: plugin, targetKind: 'platform', role: 'runtime', machines: [], ...placement }).success).toBe(false);
    }
    expect(DeploymentTargetLinkHeaderV1Schema.safeParse({ ...header, hostTargetId: 'fake-host' }).success).toBe(false);
    expect(DeploymentTargetLinkHeaderV1Schema.safeParse({ ...header, source: { ...plugin, id: 'fake-host' } }).success).toBe(false);
  });

  it('preserves S0 host input and requires its sole ordered nonempty Machine relation', () => {
    const host = { ...intent, targetId: 'own-server', role: 'runtime', machines: [{ machineId: 'machine', installationId: 'installation' }] };
    expect(DeploymentTargetLinkInputV1Schema.parse(host)).toEqual(host);
    const { contentArtifactId: _artifact, contentHeaderVersion: _header, contentBodyVersion: _body, ...plainIntent } = host;
    expect(DeploymentActionInputSchemasV1['deployments.targets.link'].parse(plainIntent)).toEqual(plainIntent);
    expect(DeploymentTargetLinkInputV1Schema.safeParse(plainIntent).success).toBe(false);
    for (const patch of [{ machines: [] }, { role: 'data' }, { machineId: 'machine', installationId: 'installation' },
      { machines: [...host.machines, ...host.machines] }]) {
      expect(DeploymentTargetLinkInputV1Schema.safeParse({ ...host, ...patch }).success).toBe(false);
    }
  });

  it('pins the selected link revision when replacing membership without accepting an orphan revision', () => {
    const host = { ...intent, targetId: 'own-server', role: 'runtime', machines: [{ machineId: 'machine', installationId: 'installation' }] };
    const replacement = { ...host, replacesLinkId: 'previous-link', expectedTargetLinkRevision: 4 };
    expect(DeploymentTargetLinkInputV1Schema.parse(replacement)).toEqual(replacement);
    expect(DeploymentTargetLinkInputV1Schema.safeParse({ ...host, replacesLinkId: 'previous-link' }).success).toBe(false);
    expect(DeploymentTargetLinkInputV1Schema.safeParse({ ...host, expectedTargetLinkRevision: 4 }).success).toBe(false);
  });

  it('pages one explicit Account or Team readable scope without accepting a private provider tuple', () => {
    for (const scope of [{ kind: 'account', accountId: 'account' }, { kind: 'team', teamId: 'team' }]) {
      const input = { serverId: 'home', scope, cursor: 'link-before', limit: 20 };
      expect(DeploymentTargetLinksListInputV1Schema.parse(input)).toEqual(input);
      const selected = { ...input, selection: { source: plugin, targetKind: 'platform' } };
      expect(DeploymentTargetLinksListInputV1Schema.parse(selected)).toEqual(selected);
      expect(DeploymentTargetLinksListInputV1Schema.safeParse({ ...input,
        selection: { source: plugin } }).success).toBe(false);
      expect(DeploymentTargetLinksListInputV1Schema.safeParse({ ...input,
        providerIdentity: { providerAccountId: 'private', providerResourceId: 'resource', providerEnvironment: 'production' } }).success).toBe(false);
    }
    expect(DeploymentTargetLinksListInputV1Schema.safeParse({ serverId: 'home' }).success).toBe(false);
    expect(DeploymentTargetLinksListInputV1Schema.safeParse({ serverId: 'home', scope: { kind: 'group', teamId: 'team', groupId: 'group' } }).success).toBe(false);
    const page = { ok: true, items: [], nextCursor: 'next-readable-link', coverage: 'partial' };
    expect(DeploymentTargetLinksListResultV1Schema.parse(page)).toEqual(page);
    expect(DeploymentTargetLinksListResultV1Schema.safeParse({ ...page, providerIdentity: 'private' }).success).toBe(false);
  });
});

describe('chosen deployment principal policy', () => {
  it('carries exact Account/Team/Group references through create/update while rejecting ambiguous authority', () => {
    const principals = [{ kind: 'account', accountId: 'selected' }, { kind: 'team', teamId: 'team' },
      { kind: 'group', teamId: 'team', groupId: 'group' }];
    const create = getActionSpec('deployments.environments.create').inputSchema;
    const input = { serverId: 'home', projectSourceId: 'source', requestKey: 'create', protection: 'production',
      purpose: 'standard', deployerMode: 'chosen', controllerMachineId: 'controller', contentArtifactId: 'private',
      contentHeaderVersion: 1, contentBodyVersion: 1, deployerPrincipals: principals };
    expect(create.parse(input)).toEqual(input);
    const update = { serverId: 'home', environmentId: 'environment', expectedRevision: 1,
      contentArtifactId: 'private', contentHeaderVersion: 1, contentBodyVersion: 1,
      patch: { deployerMode: 'chosen', deployerPrincipals: principals } };
    expect(DeploymentEnvironmentUpdateInputV1Schema.parse(update)).toEqual(update);
    expect(resolveActionPermissionChangingV1(getActionSpec('deployments.environments.update'), update)).toBe(true);
    expect(resolveActionPermissionChangingV1(getActionSpec('deployments.environments.update'), { ...update, patch: { buildMachineId: 'builder' } })).toBe(false);
    expect(DeploymentEnvironmentUpdateInputV1Schema.parse({ ...update, patch: { deployerPrincipals: [] } }).patch)
      .toEqual({ deployerPrincipals: [] });
    for (const bad of [[principals[0], principals[0]], [{ principalKind: 'teamGroup', principalId: 'group' }],
      [{ kind: 'group', groupId: 'group' }], [{ kind: 'account', accountId: 'selected', role: 'manager' }]]) {
      expect(create.safeParse({ ...input, deployerPrincipals: bad }).success).toBe(false);
    }
    // Same id in distinct principal namespaces is intentional and remains two exact selections.
    expect(create.safeParse({ ...input, deployerPrincipals: [principals[0], { kind: 'team', teamId: 'selected' }] }).success).toBe(true);
  });
});

describe('recorded data teardown intent', () => {
  it('accepts an exact Workflow creation reference without caller-authored native identity or credentials', () => {
    const input = { serverId: 'home', environmentId: 'preview', expectedRevision: 3,
      targetLinkId: 'data-link', expectedTargetLinkRevision: 2, requestKey: 'cleanup-request', reason: 'previewClosed',
      dataCreation: { runId: 'ae814b24-35be-4ceb-a4fa-fbf100541818', invocationId: 'created-data-invocation' } };
    const schema = getActionSpec('deployments.teardown').inputSchema;
    expect(schema.parse(input)).toEqual(input);
    for (const untrusted of [
      { providerIdentity: { providerAccountId: 'account-B', providerResourceId: 'project-B', providerEnvironment: 'branch-B' } },
      { credentialRef: { service: { pluginId: 'foreign.plugin', localId: 'account' }, accountId: 'account-B' } },
      { dataCreation: { ...input.dataCreation, providerEnvironment: { kind: 'custom', id: 'branch-B' } } },
      { dataCreation: { runId: input.dataCreation.runId } },
    ]) expect(schema.safeParse({ ...input, ...untrusted }).success).toBe(false);
    const { dataCreation: _creation, ...withoutCreation } = input;
    // Content-free native intent is resolved by the own-server host, not a data target.
    expect(schema.safeParse(withoutCreation).success).toBe(true);
    // The existing explicitly prepared native arm is a distinct supported path.
    const prepared = { ...withoutCreation, contentArtifactId: 'native-content', contentHeaderVersion: 1, contentBodyVersion: 1 };
    expect(schema.parse(prepared)).toEqual(prepared);
  });
});


it('captures backup credential roles while accepting legacy role-less prepared captures', () => {
  const source = { kind: 'secret', ref: formatSharedSavedSecretRefV1('backup-key'), resourceRevision: 1 };
  const bindings = ['repositoryPassword', 'accessKeyId'].map(role => EnvironmentSecretBindingV1Schema.parse({
    purpose: 'backupDestination', configKey: 'destination', role, source }));
  const captured = captureDeploymentBindingSavedSecretRevisionsV1(bindings);
  expect(captured).toEqual([{ resourceId: 'backup-key', revision: 1, requiredBindings: [
    { purpose: 'backupDestination', role: 'accessKeyId' }, { purpose: 'backupDestination', role: 'repositoryPassword' },
  ] }]);
  expect(matchesDeploymentBindingSavedSecretCapturesV1(captured, [{ resourceId: 'backup-key', revision: 1,
    requiredBindings: [{ purpose: 'backupDestination' }] }])).toBe(true);
  expect(matchesDeploymentBindingSavedSecretCapturesV1(captured, [{ resourceId: 'backup-key', revision: 1,
    requiredBindings: [{ purpose: 'backupDestination', role: 'accessKeyId' }] }])).toBe(false);
});


it('binds telemetry native admission to the exact collector, revision and destructive confirmation', () => {
  const actionId = 'deployments.environments.telemetry.set';
  const input = { serverId: 'home', environmentId: 'environment', expectedRevision: 3,
    collector: { machineId: 'collector' }, rotate: true, confirmDelete: true };
  const native = projectDeploymentNativeAdmissionV1(actionId, input);
  expect(native).toMatchObject({ kind: 'telemetry', actionId, environmentId: 'environment', expectedRevision: 3,
    collector: { machineId: 'collector' }, rotate: true, confirmDelete: true, inputDigest: expect.any(String) });
  for (const replacement of [{ collector: { machineId: 'other' } }, { expectedRevision: 4 }]) {
    expect(projectDeploymentNativeAdmissionV1(actionId, { ...input, ...replacement })).not.toEqual(native);
  }
  const { confirmDelete: _confirmation, ...withoutConfirmation } = input;
  expect(projectDeploymentNativeAdmissionV1(actionId, withoutConfirmation)).not.toEqual(native);
  expect(() => projectDeploymentNativeAdmissionV1(actionId, { ...input, token: 'never-authority' })).toThrow();
});

it('binds backup re-key admission to the replacement without permitting configuration changes', () => {
  const input = { serverId: 'home', environmentId: 'environment', expectedRevision: 3, intent: 'rekeyAndSave',
    replacement: { ref: formatSharedSavedSecretRefV1('new-password'), resourceRevision: 1 } };
  const schema = DeploymentActionInputSchemasV1['deployments.backups.configure'];
  expect(schema.parse(input)).toEqual(input);
  for (const extra of [{ configuration: {} }, { backupBindings: [] },
    { destinationSetup: { kind: 'anotherMachine', machineId: 'receiver', expectedInstallationId: 'installed', receiverInputs: {} } }]) {
    expect(schema.safeParse({ ...input, ...extra }).success).toBe(false);
  }
  const native = projectDeploymentNativeAdmissionV1('deployments.backups.configure', input);
  const other = projectDeploymentNativeAdmissionV1('deployments.backups.configure', { ...input,
    replacement: { ...input.replacement, ref: formatSharedSavedSecretRefV1('different-password') } });
  expect(native).toMatchObject({ kind: 'backupConfigure', intent: 'rekeyAndSave', environmentId: 'environment', expectedRevision: 3 });
  if (!native || !('kind' in native) || native.kind !== 'backupConfigure'
    || !other || !('kind' in other) || other.kind !== 'backupConfigure') throw new Error('Expected backup Configure admissions');
  expect(native.inputDigest).not.toEqual(other.inputDigest);
});

// Draft inspection must not mint Domain identity or publish private route input.
it('binds a draft DNS child to its exact preview and projects only admission references', () => {
  const input = { mode: 'preview', serverId: 'home', environmentId: 'environment', targetLinkId: 'target',
    expectedRevision: 1, expectedTargetLinkRevision: 2, requestKey: 'dns-attempt',
    content: { hostname: 'private.example.test', target: { service: 'api', containerPort: 8080 } } };
  const child = DeploymentChildRpcV1Schema.parse({ v: 1, kind: 'domainDns', actionId: 'deployments.domains.verify',
    machineId: 'edge', installationId: 'edge-installation', input });
  expect(DeploymentActionInputSchemasV1['deployments.domains.verify'].parse(input)).toEqual(input);
  expect(projectDeploymentNativeAdmissionV1(child.actionId, input)).toEqual({ kind: 'domainDns', actionId: child.actionId,
    environmentId: input.environmentId, targetLinkId: input.targetLinkId, expectedRevision: input.expectedRevision,
    expectedTargetLinkRevision: input.expectedTargetLinkRevision, requestKey: input.requestKey });
  expect(projectDeploymentNativeAdmissionV1(child.actionId, { serverId: input.serverId, environmentId: input.environmentId,
    domainId: 'attached-domain', expectedRevision: 1, expectedDomainRevision: 2, requestKey: 'attached-attempt' }))
    .toMatchObject({ kind: 'domain', environmentId: input.environmentId, domainId: 'attached-domain' });
  expect(doesDeploymentChildInputMatchRootV1({ rootActionId: child.actionId, rootInput: input, child })).toBe(true);
  expect(doesDeploymentChildInputMatchRootV1({ rootActionId: child.actionId, rootInput: { ...input,
    content: { ...input.content, hostname: 'other.example.test' } }, child })).toBe(false);
  expect(doesDeploymentChildInputMatchRootV1({ rootActionId: child.actionId, rootInput: { ...input, targetLinkId: 'other' }, child })).toBe(false);
  const routing = DeploymentChildRoutingV1Schema.parse(projectDeploymentChildRoutingV1(child));
  expect(routing).toMatchObject({ kind: 'domainDns', machineId: 'edge', installationId: 'edge-installation',
    input: { environmentId: 'environment', targetLinkId: 'target', expectedRevision: 1, expectedTargetLinkRevision: 2 } });
  expect(JSON.stringify(routing)).not.toContain('private.example.test');
  expect(routing.input).not.toHaveProperty('content');
  expect(DeploymentChildRoutingV1Schema.safeParse({ ...routing, input: { ...routing.input, content: input.content } }).success).toBe(false);
  expect(DeploymentActionInputSchemasV1['deployments.domains.verify'].safeParse({ ...input, domainId: 'invented' }).success).toBe(false);
});

describe('restore integrity availability', () => {
  it('retains an activated but unchecked restore and requires its remedy', () => {
    const result = { kind: 'restored', verified: false, nextAction: 'installAmcheckAndRunIntegrityCheck', evidence: {},
      integrity: { kind: 'unavailable', reason: 'amcheck_extension_missing', nextAction: 'installAmcheckAndRunIntegrityCheck' } };
    expect(DeploymentBackupRestoreResultV1Schema.parse(result)).toEqual(result);
    expect(DeploymentBackupRestoreResultV1Schema.safeParse({ ...result, integrity: undefined }).success).toBe(false);
    expect(DeploymentBackupRestoreResultV1Schema.safeParse({ ...result, verified: true }).success).toBe(false);
  });
});
