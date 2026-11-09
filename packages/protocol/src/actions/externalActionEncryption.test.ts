import { projectExternalActionMachineRuntimeDemandV1, readExternalActionMachineRuntimeDemandV1 } from './actionSpecs.js';
import { describe, expect, it } from 'vitest';
import { sealAccountScopedBlobCiphertext } from '../crypto/accountScopedCipher.js';
import { computeCanonicalDomainSeparatedDigest } from '../crypto/canonicalDigest.js';
import { computeWorkspaceSyncPolicyDigest } from '../sessions/control/handoff/workspaceSyncSchemas.js';
import {
  EXTERNAL_ACTION_HTTP_BODY_LIMIT_BYTES,
  EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES,
  EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES_V2,
  isExternalActionRequestWithinLimit,
  measureExternalActionResponseEnvelopeUtf8BytesV1,
  projectExternalActionPendingResetStartAdmissionV1,
  isDeploymentPreparationActionIdV1,
  ExternalActionExecutionAuthorizationBindingV1Schema,
  ExternalActionRequestEnvelopeV1Schema,
  createDeploymentCandidatePublicationV1,
  createDeploymentLinkContentArtifactIdV1,
  projectDeploymentNativeAdmissionV1,
  isDeploymentDomainNativeAdmissionV1,
} from './externalActionApi.js';
import { RPC_METHODS } from '../rpc/methods.js';
import { DaemonPluginUiResourceReadRequestSchema, DaemonPluginUiResourceReadResponseSchema, DaemonPluginUiResourceWatchOpenResponseSchema,
  DaemonPluginUiResourceWatchNextRequestSchema, DaemonPluginUiResourceWatchCloseRequestSchema } from '../daemon/contributionRegistryProjection.js';
import { MachineSetupApplyInputV1Schema, MachineSetupCombinedPlanInputV1Schema } from '../machines/managed/actionsV1.js';
import {
  openExternalActionRequestV2,
  openExternalActionResponseV2,
  sealExternalActionRequestV2,
  prepareExternalActionResponseV2,
} from './externalActionEncryption.js';

const material = { type: 'dataKey' as const, machineKey: new Uint8Array(32).fill(9) };
const binding = {
  serverIdentityId: 'srv_test', accountId: 'account-1',
  credentialId: '00000000-0000-4000-8000-000000000001',
  actionId: 'session.message.send', requestId: 'reused-request',
  target: { kind: 'machine' as const, machineId: 'machine-1' },
};
const randomBytes = (length: number) => new Uint8Array(length).fill(2);

describe('whole external Action encryption', () => {
  it('binds Browser Session routing to the sealed operands before execution', () => {
    const browserBinding = { ...binding, actionId: 'browser.view.open' };
    const input = { browserSessionId: 'owner-session', viewId: 'view' };
    const request = sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1,
      binding: browserBinding, input, material, randomBytes });
    expect(request).toMatchObject({ browserSessionId: 'owner-session' });
    const open = (envelope: unknown) => openExternalActionRequestV2({
      projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1,
      binding: browserBinding, envelope, material });
    expect(open(request)?.input).toEqual(input);
    expect(open({ ...request, browserSessionId: 'guest-session' })).toBeNull();
    const { browserSessionId: _session, ...missingProjection } = request;
    expect(open(missingProjection)).toBeNull();
  });
  it.each(['deployments.bindings.set', 'deployments.environments.controller.set', 'deployments.cancel', 'deployments.restart'] as const)(
    'binds the selected %s Environment while keeping authored values encrypted', actionId => {
    const bindingRequest = { ...binding, actionId };
    const input = actionId === 'deployments.environments.controller.set'
      ? { serverId: 'home', environmentId: 'environment', expectedRevision: 2, controllerMachineId: 'private-value' }
      : actionId === 'deployments.cancel'
      ? { serverId: 'home', environmentId: 'environment', deploymentId: 'private-value', expectedReceiptRevision: 2 }
      : actionId === 'deployments.restart'
      ? { serverId: 'home', environmentId: 'environment', deploymentId: 'private-value', targetLinkId: 'link',
        machineId: 'machine-1', installationId: 'installation', expectedGeneration: 'generation',
        service: { kind: 'deployment', machineId: 'machine-1', environmentId: 'environment',
          environmentInstanceId: 'instance', composeService: 'web', serviceId: 'instance/web' } }
      : { serverId: 'home', environmentId: 'environment', expectedRevision: 2,
        set: [{ purpose: 'variable', name: 'PUBLIC_LABEL', phase: 'runtime', source: { kind: 'value', value: 'private-value' } }], remove: [] };
    const request = sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1,
      binding: bindingRequest, input, material, randomBytes });
    expect(request.deploymentMetadataEnvironmentId).toBe(input.environmentId);
    expect(JSON.stringify(request)).not.toContain('private-value');
    expect(openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1,
      envelope: request, binding: bindingRequest, material })).toEqual({ input });
    expect(openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1,
      envelope: { ...request, deploymentMetadataEnvironmentId: 'unrelated' }, binding: bindingRequest, material })).toBeNull();
    const { deploymentMetadataEnvironmentId: _environment, ...missing } = request;
    expect(openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1,
      envelope: missing, binding: bindingRequest, material })).toBeNull();
  });

  it('keeps managed guest diagnostics encrypted while binding its exact resource for admission', () => {
    const recoveryBinding = { ...binding, actionId: 'machines.managed.inspect' };
    const input = { homeId: 'home', managedId: 'resource', includeGuestDiagnostics: true };
    const request = sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, binding: recoveryBinding, input, material, randomBytes });
    expect(request.managedAdmission).toEqual({ actionId: recoveryBinding.actionId,
      input: { homeId: input.homeId, managedId: input.managedId } });
    expect(openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, envelope: request, binding: recoveryBinding, material })).toEqual({ input });
    const substituted = { ...request, managedAdmission: { actionId: recoveryBinding.actionId,
      input: { homeId: input.homeId, managedId: 'unrelated' } } };
    expect(openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, envelope: substituted, binding: recoveryBinding, material })).toBeNull();
    const { managedAdmission: _admission, ...missing } = request;
    expect(openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, envelope: missing, binding: recoveryBinding, material })).toBeNull();
  });

  it.each([
    { actionId: 'daemon.filesystem.listDirectory', expected: undefined },
    { actionId: 'session.message.send', expected: 'required' },
    { actionId: 'daemon.filesystem.readFile', expected: 'required' },
  ] as const)('admits sealed runtime demand only for a declared finite root: $actionId', ({ actionId, expected }) => {
    const envelope = sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1,
      binding: { ...binding, actionId }, input: { rootPath: '/work', path: '.', message: 'private' }, material, randomBytes });
    const projected = { ...envelope, machineRuntimeDemand: 'required' as const };
    expect(readExternalActionMachineRuntimeDemandV1(actionId, projected)).toBe(expected);
    // Home reads the declared capability; the receiving opener still binds the
    // projection to this exact encrypted operand (Send requires explicit now).
    expect(openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1,
      envelope: projected, binding: { ...binding, actionId }, material }))
      .toEqual(actionId === 'daemon.filesystem.readFile' ? { input: { rootPath: '/work', path: '.', message: 'private' } } : null);
  });
  it.each([
    { actionId: 'session.open', target: { kind: 'session' as const, sessionId: 'chosen' }, input: { sessionId: 'chosen', intent: 'resume' }, demanded: true },
    { actionId: 'session.open', target: { kind: 'session' as const, sessionId: 'chosen' }, input: { sessionId: 'chosen' }, demanded: false },
    { actionId: 'session.message.send', target: { kind: 'session' as const, sessionId: 'chosen' }, input: { sessionId: 'chosen', message: 'private input' }, demanded: false },
    { actionId: 'session.message.send', target: { kind: 'session' as const, sessionId: 'chosen' }, input: { sessionId: 'chosen', message: 'private input', requestedAction: { v: 1, kind: 'send_now' } }, demanded: true },
    { actionId: 'daemon.filesystem.readFile', target: binding.target, input: { rootPath: '/work', path: 'private-file' }, demanded: true },
    { actionId: 'daemon.filesystem.listDirectory', target: binding.target, input: { rootPath: '/work', path: '.' }, demanded: false },
  ])('projects only explicit pre-effect runtime demand for $actionId ($demanded)', ({ actionId, target, input, demanded }) => {
    const root = { ...binding, actionId, target };
    const envelope = sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, binding: root, input, material, randomBytes });
    expect(envelope).toMatchObject(demanded ? { machineRuntimeDemand: 'required' } : {});
    if (!demanded) expect(envelope).not.toHaveProperty('machineRuntimeDemand');
    expect(openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, binding: root, envelope, material })?.input).toEqual(input);
    const forged = { ...envelope, machineRuntimeDemand: demanded ? undefined : 'required' };
    expect(openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, binding: root, envelope: forged, material })).toBeNull();
  });

  it.each(['projects.script.run', 'projects.compute.exec', 'localServices.launcher.start', 'projects.service.relocate'] as const)(
    'binds preparation source identifiers outside sealed %s content', actionId => {
      const preparationBinding = { ...binding, actionId };
      const workspace = { serverId: binding.serverIdentityId, machineId: 'source-machine',
        workspaceId: 'source-workspace', rootPath: '/private/source' };
      const input = actionId === 'projects.script.run' ? { workspace, selection: { kind: 'named', name: 'test' } }
        : actionId === 'projects.compute.exec' ? { workspace, executable: 'git', argv: ['status'], cwd: workspace.rootPath }
          : actionId === 'projects.service.relocate' ? { sourceMachineId: workspace.machineId,
            workspace: { serverId: workspace.serverId, refId: workspace.workspaceId }, serviceName: 'web', requestId: 'reviewed-move',
            currentTarget: { kind: 'managed_service', machineId: binding.target.machineId, managedServiceId: 'native-web' },
            destination: { kind: 'workers', destination: { kind: 'machine', machineId: binding.target.machineId } },
            selectedTarget: { machineId: binding.target.machineId }, desiredPlacement: {
              workspace: { serverId: workspace.serverId, refId: workspace.workspaceId }, serviceName: 'web', expectedRevision: 0,
              expected: { kind: 'absent' }, value: { runsOn: { kind: 'workers', destination: { kind: 'machine', machineId: binding.target.machineId } }, unavailable: 'fail' } } }
          : { machineId: binding.target.machineId, targetId: 'project-service:web', workspace,
            declaration: { workspaceRefId: workspace.workspaceId, selection: { kind: 'manifest', name: 'web' } } };
      const envelope = sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, binding: preparationBinding, input, material, randomBytes });
      expect(envelope).toMatchObject({ workspaceSyncAdmission: {
        sourceMachineId: workspace.machineId, sourceWorkspaceRefId: workspace.workspaceId } });
      expect(JSON.stringify(envelope)).not.toContain('/private/');
      expect(openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, envelope, binding: preparationBinding, material })).toEqual({ input });
      for (const workspaceSyncAdmission of [undefined, { sourceMachineId: 'foreign-machine',
        sourceWorkspaceRefId: workspace.workspaceId }]) {
        expect(openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, envelope: { ...envelope, workspaceSyncAdmission },
          binding: preparationBinding, material })).toBeNull();
      }
    });
  it('binds Link Environment routing without exposing sealed provider content', () => {
    const linkBinding = { ...binding, actionId: 'deployments.targets.link' };
    const input = { serverId: binding.serverIdentityId, environmentId: 'admitted-environment',
      provider: { private: 'sealed-provider-content' } };
    const envelope = sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, binding: linkBinding, input, material, randomBytes });
    expect(Reflect.get(envelope, 'deploymentLinkEnvironmentId')).toBe(input.environmentId);
    expect(JSON.stringify(envelope)).not.toContain('sealed-provider-content');
    expect(openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, envelope, binding: linkBinding, material })).toEqual({ input });
    for (const deploymentLinkEnvironmentId of ['another-environment', undefined]) {
      expect(openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, envelope: { ...envelope, deploymentLinkEnvironmentId },
        binding: linkBinding, material })).toBeNull();
    }
  });
  it.each(['copy_once', 'create_relationship', 'relationship'] as const)('binds only source identifiers outside sealed Sync content (%s)', kind => {
    const syncBinding = { ...binding, actionId: 'projects.open' };
    const policy = { v: 1 as const, selection: 'all_files' as const, extraIgnorePatterns: [], extraIncludePatterns: [] };
    const input = { serverId: binding.serverIdentityId, machineId: binding.target.machineId,
      source: { kind: 'workspace', workspaceId: 'source-workspace', checkout: {
        serverId: binding.serverIdentityId, workspaceId: 'source-workspace', machineId: 'source-machine', rootPath: '/private/source' } },
      materialization: { kind: 'sync', targetPath: '/private/target', workspaceAction: {
        kind, ...(kind === 'create_relationship' ? { mode: 'keep_both_in_sync', flushBeforeCommit: true } : {}),
        ...(kind === 'relationship' ? { relationshipId: 'existing-relationship', flushBeforeCommit: true }
          : { contentPolicy: { ...policy, policyDigest: computeWorkspaceSyncPolicyDigest(policy) } }) } } };
    const envelope = sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, binding: syncBinding, input, material, randomBytes });
    expect(envelope).toMatchObject({ workspaceSyncAdmission: {
      sourceMachineId: 'source-machine', sourceWorkspaceRefId: 'source-workspace',
      ...(kind === 'relationship' ? { relationshipId: 'existing-relationship' } : {}) } });
    expect(JSON.stringify(envelope)).not.toContain('/private/');
    expect(openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, envelope, binding: syncBinding, material })).toEqual({ input });
    for (const sourceMachineId of ['foreign-machine', undefined]) {
      const tampered = { ...envelope, workspaceSyncAdmission: sourceMachineId
        ? { sourceMachineId, sourceWorkspaceRefId: 'source-workspace' } : undefined };
      expect(openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, envelope: tampered, binding: syncBinding, material })).toBeNull();
    }
  });
  it('binds an operation Environment projection without choosing an Environment from the token grant', () => {
    const operationBinding = { ...binding, actionId: 'action.operations.get' };
    const input = { serverId: binding.serverIdentityId, machineId: binding.target.machineId,
      operationId: 'original-operation', environmentId: 'selected-environment' };
    const envelope = sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, binding: operationBinding, input, material, randomBytes });
    expect(envelope.deploymentNativeAdmission).toEqual({ environmentId: input.environmentId });
    expect(openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, envelope, binding: operationBinding, material })).toEqual({ input });
    expect(openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, envelope: { ...envelope,
      deploymentNativeAdmission: { environmentId: 'another-environment' } }, binding: operationBinding, material })).toBeNull();
    const { environmentId: _environmentId, ...ordinary } = input;
    const ordinaryEnvelope = sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, binding: operationBinding, input: ordinary, material, randomBytes });
    expect(ordinaryEnvelope.deploymentNativeAdmission).toBeUndefined();
    expect(openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, envelope: ordinaryEnvelope, binding: operationBinding, material })).toEqual({ input: ordinary });
  });
  it('keeps same-token content access exclusively in the bound encrypted request', () => {
    const deploymentBinding = { ...binding, actionId: 'deployments.deploy' };
    const input = { serverId: binding.serverIdentityId, environmentId: 'environment-a', requestKey: 'deploy-request' };
    const apiTokenContentAccess = { contentPublicKey: 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=',
      wrappingSecret: 'AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI' };
    const args = { binding: deploymentBinding, input, material, randomBytes, apiTokenContentAccess };
    const envelope = sealExternalActionRequestV2({ ...args, projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1 });
    expect(openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, envelope, binding: deploymentBinding, material }))
      .toEqual({ input, apiTokenContentAccess });
    expect(JSON.stringify(envelope)).not.toContain(apiTokenContentAccess.wrappingSecret);
    expect(openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, envelope, binding: { ...deploymentBinding, credentialId: '00000000-0000-4000-8000-000000000002' }, material })).toBeNull();
    const ordinaryEnvelope = sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, ...args, binding });
    expect(openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, envelope: ordinaryEnvelope, binding, material }))
      .toEqual({ input, apiTokenContentAccess });
    expect(JSON.stringify(ordinaryEnvelope)).not.toContain(apiTokenContentAccess.wrappingSecret);
    expect(openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, envelope: ordinaryEnvelope,
      binding: { ...binding, credentialId: '00000000-0000-4000-8000-000000000002' }, material })).toBeNull();
    expect(() => sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, ...args, binding: {
      serverIdentityId: binding.serverIdentityId, accountId: binding.accountId, actionId: deploymentBinding.actionId,
      requestId: binding.requestId, target: binding.target, authentication: { kind: 'account', tokenEpoch: 1 },
    } })).toThrow();
    expect(ExternalActionRequestEnvelopeV1Schema.safeParse({ v: 1, requestId: binding.requestId,
      target: binding.target, input, apiTokenContentAccess }).success).toBe(false);
  });
  it('gives a changed Source snapshot a fresh native candidate identity', () => {
    const scope = { serverIdentityId: 'home', accountId: 'owner', actionId: 'deployments.deploy', requestId: 'request',
      requestEnvelopeDigest: 'digest', environmentId: 'environment', source: { id: 'source', revision: 1 } };
    const original = createDeploymentCandidatePublicationV1(scope);
    expect(createDeploymentCandidatePublicationV1(scope)).toEqual(original);
    expect(createDeploymentCandidatePublicationV1({ ...scope, source: { ...scope.source, revision: 2 } }).contentArtifactId)
      .not.toBe(original.contentArtifactId);
  });

  it('confines Link publication identity to its signed invocation and Environment', () => {
    const scope = { serverIdentityId: 'home', accountId: 'owner', actionId: 'deployments.targets.link',
      requestId: 'opaque-request', requestEnvelopeDigest: 'digest', deploymentLinkAdmission: { environmentId: 'environment' } };
    const original = createDeploymentLinkContentArtifactIdV1(scope);
    expect(createDeploymentLinkContentArtifactIdV1(scope)).toBe(original);
    expect(original).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-b[0-9a-f]{3}-[0-9a-f]{12}$/u);
    for (const key of ['accountId', 'serverIdentityId', 'actionId', 'requestId', 'requestEnvelopeDigest'] as const) {
      expect(createDeploymentLinkContentArtifactIdV1({ ...scope, [key]: `${scope[key]}-other` })).not.toBe(original);
    }
    expect(createDeploymentLinkContentArtifactIdV1({ ...scope, deploymentLinkAdmission: { environmentId: 'other' } })).not.toBe(original);
  });

  it.each(['deployments.deploy', 'deployments.domains.add', 'deployments.domains.remove', 'deployments.domains.verify'])(
    'projects %s Environment custody and rejects a changed encrypted projection', actionId => {
    const nativeBinding = { ...binding, actionId };
    const base = { serverId: 'srv_test', environmentId: 'environment-a', requestKey: 'candidate-request' };
    const input = actionId === 'deployments.deploy' ? base : actionId === 'deployments.domains.add'
      ? { ...base, domainId: 'domain-a', expectedRevision: 1, expectedDomainRevision: 1, targetLinkId: 'runtime',
        expectedTargetLinkRevision: 1, contentArtifactId: 'domain-content', contentHeaderVersion: 1, contentBodyVersion: 1 }
      : { ...base, domainId: 'domain-a', expectedRevision: 1, expectedDomainRevision: 1 };
    const envelope = sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, binding: nativeBinding, input, material, randomBytes });
    expect(envelope).toMatchObject({ deploymentNativeAdmission: { environmentId: input.environmentId } });
    expect(envelope.deploymentNativeAdmission).toEqual(projectDeploymentNativeAdmissionV1(actionId, input));
    expect(openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, envelope, binding: nativeBinding, material })).toEqual({ input });
    expect(openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, envelope: { ...envelope, deploymentNativeAdmission: { environmentId: 'environment-b' } },
      binding: nativeBinding, material })).toBeNull();
    const { deploymentNativeAdmission: _admission, ...missing } = envelope as typeof envelope & { deploymentNativeAdmission?: unknown };
    expect(openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, envelope: missing, binding: nativeBinding, material })).toBeNull();
    if (actionId !== 'deployments.deploy' && isDeploymentDomainNativeAdmissionV1(envelope.deploymentNativeAdmission)) {
      expect(openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, envelope: { ...envelope, deploymentNativeAdmission: {
        ...envelope.deploymentNativeAdmission, domainId: 'domain-b' } }, binding: nativeBinding, material })).toBeNull();
      const replacement = projectDeploymentNativeAdmissionV1(actionId, { ...input, requestKey: 'another-request' });
      expect(openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, envelope: { ...envelope, deploymentNativeAdmission: replacement },
        binding: nativeBinding, material })).toBeNull();
    }
  });

  it('requires the full native identity for OPEN, joined reads and disposal', () => {
    const input = { serverId: 'home', machineId: 'machine-1', serviceId: 'worker' };
    const resource = { hostRead: 'machines.services.logs', input, expectedGeneration: 'generation',
      sourceRevision: 'actual-native-source' };
    const { sourceRevision: _sourceRevision, ...withoutRevision } = resource;
    const candidate = { method: RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_WATCH_OPEN,
      params: { machineId: input.machineId, subscriptionId: 'watch', resource } };
    const plain = { v: 1, requestId: binding.requestId, target: binding.target, input, resourceContinuation: candidate };
    expect(ExternalActionRequestEnvelopeV1Schema.safeParse(plain).success).toBe(true);
    const { resourceContinuation } = ExternalActionRequestEnvelopeV1Schema.parse(plain);
    const args = { binding: { ...binding, actionId: 'machines.services.logs.read' }, input,
      resourceContinuation, material, randomBytes };
    const request = sealExternalActionRequestV2({ ...args, projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1 });
    expect(openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, envelope: request, binding: args.binding, material }))
      .toEqual({ input, resourceContinuation });
    expect(ExternalActionRequestEnvelopeV1Schema.safeParse({ ...plain, resourceContinuation: {
      ...candidate, params: { ...candidate.params, resource: withoutRevision },
    } }).success).toBe(false);
    const readSelector = { machineId: input.machineId, resource };
    expect(DaemonPluginUiResourceReadRequestSchema.safeParse(readSelector).success).toBe(true);
    expect(DaemonPluginUiResourceReadRequestSchema.safeParse({ ...readSelector,
      subscriptionId: 'watch' }).success).toBe(false);
    for (const [schema, selector] of [
      [DaemonPluginUiResourceReadRequestSchema, readSelector],
      [DaemonPluginUiResourceWatchNextRequestSchema, { ...readSelector, subscriptionId: 'watch' }],
      [DaemonPluginUiResourceWatchCloseRequestSchema, { ...readSelector, subscriptionId: 'watch' }],
    ] as const) {
      expect(schema.safeParse({ ...selector, resource: withoutRevision }).success).toBe(false);
      expect(schema.safeParse({ ...selector, actorAccountId: 'forged' }).success).toBe(false);
    }
    const snapshot = { ok: true, resource, contentType: 'application/json',
      bytesBase64: 'e30=', digest: `sha256:${'0'.repeat(64)}` };
    expect(DaemonPluginUiResourceReadResponseSchema.safeParse(snapshot).success).toBe(true);
    expect(DaemonPluginUiResourceWatchOpenResponseSchema.safeParse({ ok: true,
      subscriptionId: 'watch', digest: snapshot.digest }).success).toBe(true);
    expect(DaemonPluginUiResourceWatchOpenResponseSchema.safeParse({ ...snapshot,
      subscriptionId: 'watch' }).success).toBe(false);
  });

  it('binds encrypted Discussion repair admission to the exact root Discussion', () => {
    const discussionBinding = { ...binding, actionId: 'discussion.get' };
    const input = { discussionId: 'discussion-a' };
    const request = sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, binding: discussionBinding, input, material, randomBytes });
    expect(request).toMatchObject({ discussionId: input.discussionId });
    expect(openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, envelope: request, binding: discussionBinding, material })).toEqual({ input });
    expect(openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, envelope: { ...request, discussionId: 'discussion-b' },
      binding: discussionBinding, material })).toBeNull();
    const { discussionId: _discussionId, ...missing } = request;
    expect(openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, envelope: missing, binding: discussionBinding, material })).toBeNull();
  });

  it.each([
    RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_READ,
    RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_WATCH_OPEN,
    RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_WATCH_NEXT,
    RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_WATCH_CLOSE,
  ])('protects the exact native logs Resource continuation for %s', method => {
    const input = { serverId: 'home', machineId: 'machine-1', serviceId: 'worker',
      cursor: { sourceRevision: 'source', token: 'position' } };
    const resource = { hostRead: 'machines.services.logs' as const, input,
      expectedGeneration: 'generation', sourceRevision: 'source' };
    const candidate = { method, params: { machineId: input.machineId, resource,
      ...(method === RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_READ ? {} : { subscriptionId: 'watch' }) } };
    const plain = { v: 1, requestId: binding.requestId, target: binding.target, input, resourceContinuation: candidate };
    expect(ExternalActionRequestEnvelopeV1Schema.safeParse(plain).success).toBe(true);
    const { resourceContinuation } = ExternalActionRequestEnvelopeV1Schema.parse(plain);
    const args = { binding: { ...binding, actionId: 'machines.services.logs.read' }, input,
      resourceContinuation, material, randomBytes };
    const request = sealExternalActionRequestV2({ ...args, projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1 });
    expect(request).not.toHaveProperty('resourceContinuation');
    expect(openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, envelope: request, binding: args.binding, material }))
      .toEqual({ input, resourceContinuation });
    expect(ExternalActionRequestEnvelopeV1Schema.safeParse({ ...plain, resourceContinuation: {
      ...resourceContinuation, params: { ...resourceContinuation.params, authority: 'present_user' },
    } }).success).toBe(false);
  });

  it.each([
    { actionId: 'machines.managed.inspect', input: { homeId: 'home', managedId: 'resource' } },
    { actionId: 'machines.managed.bootstrap.retry', input: { homeId: 'home', managedId: 'resource', expectedIntentRevision: 3 } },
    { actionId: 'action.operations.list', input: { serverId: 'profile', machineId: 'machine-1', managed: { homeId: 'home', managedId: 'resource' } } },
    { actionId: 'action.operations.get', input: { serverId: 'profile', machineId: 'machine-1', operationId: 'operation',
      managed: { homeId: 'home', managedId: 'resource' } } },
  ])('binds the exact $actionId recovery resource without disclosing other operands', ({ actionId, input }) => {
    const recoveryBinding = { ...binding, actionId };
    const request = sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, binding: recoveryBinding, input, material, randomBytes });
    const projected = 'managed' in input ? { ...input.managed, ...('operationId' in input ? { operationId: input.operationId } : {}) }
      : input;
    expect(request.managedAdmission).toEqual({ actionId, input: projected });
    const root = { serverIdentityId: projected.homeId, accountId: binding.accountId,
      authentication: { kind: 'account', tokenEpoch: 0 }, actionId, requestId: binding.requestId, target: binding.target,
      machineId: binding.target.machineId, installationId: 'installation', custodianAccountId: 'custodian',
      requestEnvelopeDigest: 'a'.repeat(43), managedAdmission: request.managedAdmission };
    expect(ExternalActionExecutionAuthorizationBindingV1Schema.safeParse(root).success).toBe(true);
    expect(ExternalActionExecutionAuthorizationBindingV1Schema.safeParse({ ...root, actionId: 'machines.managed.delete' }).success).toBe(false);
    expect(openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, envelope: request, binding: recoveryBinding, material })).toEqual({ input });
    const substituted = { ...request, managedAdmission: { actionId, input: { ...projected, managedId: 'unrelated' } } };
    expect(openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, envelope: substituted, binding: recoveryBinding, material })).toBeNull();
    const { managedAdmission: _admission, ...missing } = request;
    expect(openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, envelope: missing, binding: recoveryBinding, material })).toBeNull();
    const arbitrary = { ...request, managedAdmission: { actionId: 'machines.managed.delete', input } };
    expect(openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, envelope: arbitrary, binding: recoveryBinding, material })).toBeNull();
  });

  it('binds only exact Environment app-update demand and rejects substituted or missing admission', () => {
    const appBinding = { ...binding, actionId: 'registries.updates.check' };
    const input = { kind: 'app', environments: [{ environmentId: 'instantiated', expectedRevision: 3 }] };
    const request = sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, binding: appBinding, input, material, randomBytes });
    expect(request).toMatchObject({ registryAppUpdateAdmission: { environments: input.environments } });
    expect(openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, envelope: request, binding: appBinding, material })).toEqual({ input });
    for (const replacement of [{ environments: [{ environmentId: 'other', expectedRevision: 3 }] },
      { environments: [{ environmentId: 'instantiated', expectedRevision: 4 }] },
      { environments: [...input.environments, { environmentId: 'unrequested', expectedRevision: 1 }] }]) {
      expect(openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, envelope: { ...request, registryAppUpdateAdmission: replacement },
        binding: appBinding, material })).toBeNull();
    }
    const { registryAppUpdateAdmission: _admission, ...missing } = request;
    expect(openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, envelope: missing, binding: appBinding, material })).toBeNull();
    const skillInput = { kind: 'skill', keys: ['skill'] };
    const skillRequest = sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, binding: appBinding, input: skillInput, material, randomBytes });
    expect(skillRequest).not.toHaveProperty('registryAppUpdateAdmission');
    expect(openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, envelope: skillRequest, binding: appBinding, material })).toEqual({ input: skillInput });
  });

  it('binds copy-only create preparation to the exact source revision without exposing selected values', () => {
    const createBinding = { ...binding, actionId: 'deployments.environments.create' };
    const input = { serverId: binding.serverIdentityId, projectSourceId: 'destination', requestKey: 'duplicate',
      name: 'Staging', protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers',
      copyFrom: { environmentId: 'source-environment', expectedRevision: 7, choices: {
        secrets: [], data: [], values: [{ binding: { purpose: 'variable', name: 'PRIVATE_VALUE', phase: 'runtime' },
          kind: 'remap', source: { kind: 'value', value: 'private-copy-value' } }],
      } } };
    const admission = { operation: 'create', mode: 'apply', source: { id: 'destination' },
      requestKey: 'duplicate', protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers',
      copyFrom: { environmentId: 'source-environment', expectedRevision: 7 } };
    const { name: _name, ...preparedMetadata } = input;
    for (const createInput of [input, { ...preparedMetadata, controllerMachineId: binding.target.machineId,
      contentArtifactId: 'independent-content', contentHeaderVersion: 1, contentBodyVersion: 1,
      copyPlan: { bindings: [] }, copyIntentCommitment: 'A'.repeat(43) }]) {
      const request = sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, binding: createBinding, input: createInput, material, randomBytes });
      expect(request).toMatchObject({ deploymentPreparationAdmission: admission });
      expect(JSON.stringify(request)).not.toContain('private-copy-value');
      expect(JSON.stringify(request)).not.toContain('PRIVATE_VALUE');
      expect(openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, envelope: request, binding: createBinding, material })).toEqual({ input: createInput });
      for (const copyFrom of [{ environmentId: 'another', expectedRevision: 7 },
        { environmentId: 'source-environment', expectedRevision: 8 }]) {
        expect(openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, envelope: { ...request,
          deploymentPreparationAdmission: { ...admission, copyFrom } }, binding: createBinding, material })).toBeNull();
      }
      const { deploymentPreparationAdmission: _admission, ...missing } = request;
      expect(openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, envelope: missing, binding: createBinding, material })).toBeNull();
    }
  });

  it('binds Prepare reference-only read admission without exposing repository or workspace paths', () => {
    const prepareBinding = { ...binding, actionId: 'deployments.prepare' };
    const input = { projectSourceId: 'source', sourceRevision: 1,
      workspace: { kind: 'workspace-ref', serverId: binding.serverIdentityId, id: 'workspace' },
      repository: { kind: 'github', deployment: 'https://github.com', repository: 'private/project' },
      baseCommit: 'a'.repeat(40), environmentId: 'staging' };
    const admission = { operation: 'prepare', source: { id: 'source', revision: 1 },
      workspace: { kind: 'workspace-ref', id: 'workspace' }, environment: { id: 'staging' } };
    const request = sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, binding: prepareBinding, input, material, randomBytes });
    expect(request).toMatchObject({ deploymentPreparationAdmission: admission });
    expect(JSON.stringify(request)).not.toContain('private/project');
    expect(openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, envelope: request, binding: prepareBinding, material })).toEqual({ input });
    for (const replacement of [{ ...admission, source: { id: 'another', revision: 1 } },
      { ...admission, source: { id: 'source', revision: 2 } }, { ...admission, environment: { id: 'another' } },
      { ...admission, workspace: { kind: 'workspace-ref', id: 'another' } }, { ...admission, serverId: 'another' }]) {
      expect(openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, envelope: { ...request, deploymentPreparationAdmission: replacement },
        binding: prepareBinding, material })).toBeNull();
    }
    const { deploymentPreparationAdmission: _admission, ...missing } = request;
    expect(openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, envelope: missing, binding: prepareBinding, material })).toBeNull();
  });

  it.each(['machines.setup.plan', 'machines.setup.apply'] as const)(
    'binds only the prepared app references of %s without changing ordinary setup admission', actionId => {
      const child = { sourceIndex: 0, itemIndex: 0, actionId: 'deployments.deploy', input: {
        serverId: binding.serverIdentityId, environmentId: 'staging', expectedRevision: 4,
        targetLinkId: 'runtime', expectedTargetLinkRevision: 2, requestKey: 'reviewed-deploy',
        contentArtifactId: 'candidate', contentHeaderVersion: 2, contentBodyVersion: 3,
      } };
      const sources = [{ kind: 'direct', setup: { items: [{ kind: 'app', definition: {
        name: 'Private app title', project: { kind: 'existing', projectSourceId: 'source' }, bindings: [],
        definition: { from: 'compose', document: 'services: { private: { image: private/image } }', profiles: [], services: [] },
      } }] } }];
      const root = { homeId: binding.serverIdentityId, machineId: binding.target.machineId };
      const input = actionId === 'machines.setup.apply'
        ? MachineSetupApplyInputV1Schema.parse({ ...root, targets: [{ ...root, sources, desiredRevision: 0, recipePlans: [], appChildren: [child] }] })
        : MachineSetupCombinedPlanInputV1Schema.parse({ ...root, targets: [{ ...root, mode: 'effects', sources, appChildren: [child] }] });
      const setupBinding = { ...binding, actionId };
      const request = sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, binding: setupBinding, input, material, randomBytes });
      const reference = { machineId: root.machineId, environment: { id: 'staging', revision: 4 },
        target: { id: 'runtime', revision: 2 }, candidate: { contentArtifactId: 'candidate', contentHeaderVersion: 2, contentBodyVersion: 3 } };
      const admission = { operation: 'setup', deployments: [reference] };
      expect(request).toMatchObject({ deploymentPreparationAdmission: admission });
      expect(JSON.stringify(request)).not.toContain('Private app title');
      expect(JSON.stringify(request)).not.toContain('private/image');
      expect(openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, envelope: request, binding: setupBinding, material })).toEqual({ input });
      for (const changed of [{ ...reference, machineId: 'unreviewed' },
        { ...reference, environment: { id: 'another', revision: 4 } },
        { ...reference, candidate: { ...reference.candidate, contentBodyVersion: 4 } }]) {
        expect(openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, envelope: { ...request,
          deploymentPreparationAdmission: { operation: 'setup', deployments: [changed] } }, binding: setupBinding, material })).toBeNull();
      }
      const { deploymentPreparationAdmission: _admission, ...missing } = request;
      expect(openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, envelope: missing, binding: setupBinding, material })).toBeNull();
      const plainSetup = { ...root, targets: input.targets.map(({ appChildren: _children, ...target }) => target) };
      const ordinary = sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, binding: setupBinding, input: plainSetup, material, randomBytes });
      expect(ordinary).not.toHaveProperty('deploymentPreparationAdmission');
      expect(openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, envelope: ordinary, binding: setupBinding, material })).toEqual({ input: plainSetup });
      expect(isDeploymentPreparationActionIdV1(actionId)).toBe(false);
    });

  it.each(['machines.setup.plan', 'machines.setup.apply'] as const)(
    'binds the exact catalog app Source of %s without exposing private app operands', actionId => {
      const root = { homeId: binding.serverIdentityId, machineId: binding.target.machineId };
      const templateRef = { sourceId: 'catalog', itemId: 'dashboard', version: '1',
        ref: { kind: 'gitTree', repo: 'https://private.example/apps.git', path: 'dashboard', commit: 'abc', treeSha: 'def' } };
      const bindings = [{ purpose: 'variable', name: 'PRIVATE_VALUE', phase: 'runtime',
        source: { kind: 'value', value: 'private-runtime-value' } }];
      const sources = [{ kind: 'direct', setup: { items: [{ kind: 'app', definition: {
        name: 'Private catalog app title', project: { kind: 'existing', projectSourceId: 'source' }, bindings,
        definition: { from: 'catalogApp', templateRef },
      } }] } }];
      const child = { sourceIndex: 0, itemIndex: 0, actionId: 'deployments.templates.instantiate', input: {
        mode: 'apply', serverId: root.homeId, machineId: root.machineId, projectSourceId: 'source', templateRef,
        environment: { kind: 'create', name: 'Private catalog app title', requestKey: 'create-environment',
          protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers', controllerMachineId: root.machineId },
        target: { kind: 'new', installationId: 'installation' }, destination: { kind: 'stored' }, bindings,
        deploy: { requestKey: 'reviewed-deploy' },
      } };
      const input = actionId === 'machines.setup.apply'
        ? MachineSetupApplyInputV1Schema.parse({ ...root, targets: [{ ...root, sources, desiredRevision: 0, recipePlans: [], appChildren: [child] }] })
        : MachineSetupCombinedPlanInputV1Schema.parse({ ...root, targets: [{ ...root, mode: 'effects', sources, appChildren: [child] }] });
      const setupBinding = { ...binding, actionId };
      const request = sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, binding: setupBinding, input, material, randomBytes });
      const admission = { operation: 'setup', deployments: [],
        catalogSources: [{ machineId: root.machineId, source: { id: 'source' } }] };
      expect(request.deploymentPreparationAdmission).toEqual(admission);
      for (const privateValue of ['Private catalog app title', 'private-runtime-value', 'PRIVATE_VALUE', templateRef.ref.repo]) {
        expect(JSON.stringify(request)).not.toContain(privateValue);
      }
      expect(openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, envelope: request, binding: setupBinding, material })).toEqual({ input });
      expect(openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, envelope: { ...request, deploymentPreparationAdmission: { ...admission,
        catalogSources: [{ machineId: root.machineId, source: { id: 'another-source' } }] } },
        binding: setupBinding, material })).toBeNull();
      const { deploymentPreparationAdmission: _admission, ...missing } = request;
      expect(openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, envelope: missing, binding: setupBinding, material })).toBeNull();
      if (actionId === 'machines.setup.plan') {
        const scalarInput = { ...root, mode: 'effects', sources, appChildren: [child] };
        const scalar = sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, binding: setupBinding, input: scalarInput, material, randomBytes });
        expect(scalar.deploymentPreparationAdmission).toEqual(admission);
        expect(openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, envelope: scalar, binding: setupBinding, material })).toEqual({ input: scalarInput });
        for (const privateValue of ['Private catalog app title', 'private-runtime-value', 'PRIVATE_VALUE', templateRef.ref.repo]) {
          expect(JSON.stringify(scalar)).not.toContain(privateValue);
        }
      }
    });

  it.each(['deployments.health.read', 'deployments.drift.read', 'deployments.logs.read'] as const)(
    'binds non-content deployment read admission to the encrypted %s input', actionId => {
      const references = { serverId: binding.serverIdentityId, environmentId: 'environment', deploymentId: 'receipt',
        targetLinkId: 'runtime', machineId: binding.target.machineId, installationId: 'installation' };
      const operation = actionId === 'deployments.drift.read' ? { expectedRevision: 1 }
        : actionId === 'deployments.logs.read' ? { kind: 'runtime' } : {};
      const input = { ...references, ...operation, service: { kind: 'deployment', machineId: binding.target.machineId,
        environmentId: 'environment', environmentInstanceId: 'instance', composeService: 'private-service-name',
        serviceId: 'instance/private-service-name' } };
      const readBinding = { ...binding, actionId };
      const request = sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, binding: readBinding, input, material, randomBytes });
      const { serverId: _serverId, ...routing } = references;
      const admission = { actionId, ...routing, ...operation };
      expect(request).toMatchObject({ deploymentReadAdmission: admission });
      expect(JSON.stringify(request)).not.toContain('private-service-name');
      expect(openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, envelope: request, binding: readBinding, material })).toEqual({ input });
      for (const replacement of [
        { ...admission, environmentId: 'another' }, { ...admission, deploymentId: 'another' },
        { ...admission, targetLinkId: 'another' }, { ...admission, machineId: 'another' },
        { ...admission, installationId: 'another' }, { ...admission, serverId: 'another' },
        { ...admission, serviceName: 'leaked' },
      ]) expect(openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, envelope: { ...request, deploymentReadAdmission: replacement },
        binding: readBinding, material })).toBeNull();
      const { deploymentReadAdmission: _admission, ...missing } = request;
      expect(openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, envelope: missing, binding: readBinding, material })).toBeNull();
    });
  it('binds current edge routing to encrypted input without accepting caller-supplied proof', () => {
    const input = { serverId: binding.serverIdentityId, environmentId: 'environment', targetLinkId: 'runtime',
      machineId: binding.target.machineId };
    const readBinding = { ...binding, actionId: 'deployments.health.current' };
    const request = sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, binding: readBinding, input, material, randomBytes });
    expect(request.deploymentReadAdmission).toEqual({ actionId: readBinding.actionId,
      environmentId: input.environmentId, targetLinkId: input.targetLinkId, machineId: input.machineId });
    expect(openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, envelope: request, binding: readBinding, material })).toEqual({ input });
    for (const replacement of [undefined, { ...request.deploymentReadAdmission, environmentId: 'another' },
      { ...request.deploymentReadAdmission, targetLinkId: 'another' },
      { ...request.deploymentReadAdmission, machineId: 'another' },
      { ...request.deploymentReadAdmission, observation: { status: 'up' } }]) {
      expect(openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, envelope: { ...request, deploymentReadAdmission: replacement },
        binding: readBinding, material })).toBeNull();
    }
  });
  it('preserves pre-effect refusal evidence through the encrypted public envelope', () => {
    const request = sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, binding, input: {}, material, randomBytes });
    const execution = { ok: false as const, effectAttempted: false,
      errorCode: 'target_unavailable', error: 'target_unavailable' };
    const prepared = prepareExternalActionResponseV2({ binding, request, execution, material,
      executedMachineId: binding.target.machineId, randomBytes });
    expect(openExternalActionResponseV2({ envelope: prepared.response, binding, request, material }))
      .toEqual(execution);
  });

  it('binds approval decision admission to the encrypted input without exposing private operands', () => {
    const approvalBinding = { ...binding, actionId: 'approval.request.decide' };
    const input = { artifactId: 'private-draft-artifact', decision: 'approve', originServerId: 'device-home',
      narrowedInput: { privateText: 'Never expose this narrowed operand' } };
    const request = sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, binding: approvalBinding, input, material, randomBytes });
    expect(request).toMatchObject({ approvalDecisionAdmission: { artifactId: input.artifactId, decision: input.decision } });
    expect(JSON.stringify(request)).not.toContain(input.narrowedInput.privateText);
    expect(JSON.stringify(request)).not.toContain(input.originServerId);
    expect(openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, envelope: request, binding: approvalBinding, material })).toEqual({ input });
    for (const admission of [
      { artifactId: 'another-artifact', decision: 'approve' },
      { artifactId: input.artifactId, decision: 'reject' },
      { artifactId: input.artifactId, decision: 'approve', privateText: 'forged' },
    ]) expect(openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, envelope: { ...request, approvalDecisionAdmission: admission },
      binding: approvalBinding, material })).toBeNull();
    // Existing clients can still decide and perform unrelated Actions. Only
    // the new signed settlement purpose requires the new admission at Home.
    const { approvalDecisionAdmission: _admission, ...legacy } = request;
    expect(openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, envelope: legacy, binding: approvalBinding, material })).toEqual({ input });
    const unrelated = sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, binding, input: {}, material, randomBytes });
    expect(openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, envelope: { ...unrelated,
      approvalDecisionAdmission: { artifactId: input.artifactId, decision: input.decision } }, binding, material })).toBeNull();
  });
  it('reports only the failed opening phase while preserving opaque public refusal', () => {
    const request = sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, binding, material, randomBytes, input: { privateInput: 'private-content' } });
    const failures: unknown[] = [];
    expect(openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, envelope: request, binding,
      material: { type: 'dataKey', machineKey: new Uint8Array(32).fill(3) },
      onFailure: failure => { failures.push(failure); },
    })).toBeNull();
    expect(failures).toEqual([{ phase: 'ciphertext_open' }]);
    failures.length = 0;
    expect(openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, envelope: request, binding: { ...binding, accountId: 'different' }, material,
      onFailure: failure => { failures.push(failure); },
    })).toBeNull();
    expect(failures).toEqual([{ phase: 'plaintext_binding' }]);
    expect(JSON.stringify(failures)).not.toContain('private-content');
    expect(openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, envelope: request, binding, material })).toEqual({ input: { privateInput: 'private-content' } });
  });
  it('retains narrowing mounted provenance beside E2EE content through the root codec', () => {
    const pluginInvocation = { kind: 'mountedPluginSurface' as const, mountedBinding: {
      pluginId: 'happier.inspector', contributionLocalId: 'inspector-app', occurrenceId: 'occurrence',
      sourceCustody: { kind: 'development' as const, registeredRootId: 'inspector-root' },
      materializationRef: { machineId: binding.target.machineId, pluginId: 'happier.inspector', materializationId: 'installed' },
    } };
    const input = { privateInput: 'account content' };
    const request = sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, binding, material, randomBytes, input, pluginInvocation });
    expect(request.pluginInvocation).toEqual(pluginInvocation);
    expect(JSON.stringify(request)).not.toContain(input.privateInput);
    expect(openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, envelope: request, binding, material })).toEqual({ input });
  });
  it('binds fresh reset preparatory facts to the encrypted input without exposing initial content', () => {
    const reset = { source: { bindingKind: 'account' as const, ref: { service: { pluginId: 'example.usage', localId: 'quota' }, accountId: 'connected' } },
      recordId: 'paug_v1_abcdefgh', meterId: 'weekly', witness: { id: 'accepted', observedAtMs: 100 } };
    const resetBinding = { ...binding, actionId: 'session.pending.resetStart.set', target: { kind: 'session' as const, sessionId: 'session' } };
    const input = { sessionId: 'session', localId: 'prepared', reset,
      initialInput: { content: { t: 'encrypted' as const, c: 'private-session-ciphertext' } } };
    const request = sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, binding: resetBinding, input, material, randomBytes });
    expect(request).toMatchObject({ pendingResetStartAdmission: projectExternalActionPendingResetStartAdmissionV1(input) });
    expect(JSON.stringify(request)).not.toContain('weekly');
    expect(JSON.stringify(request)).not.toContain('private-session-ciphertext');
    expect(openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, envelope: request, binding: resetBinding, material })).toEqual({ input });
    // Strict JSON preserves lone UTF-16 surrogates; digest encoding must not
    // collapse distinct accepted identities into TextEncoder's replacement character.
    const surrogateInput = { ...input, reset: { ...reset, meterId: '\ud800' } };
    const surrogateRequest = sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, binding: resetBinding, input: surrogateInput, material, randomBytes });
    expect(openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, envelope: { ...surrogateRequest,
      pendingResetStartAdmission: projectExternalActionPendingResetStartAdmissionV1({ ...surrogateInput,
        reset: { ...reset, meterId: '\ufffd' } }) }, binding: resetBinding, material })).toBeNull();
    for (const substituted of [
      { sessionId: 'another', localId: input.localId, reset },
      { sessionId: input.sessionId, localId: 'another', reset },
      { sessionId: input.sessionId, localId: input.localId, reset: { ...reset, meterId: 'another' } },
      { sessionId: input.sessionId, localId: input.localId, reset: { ...reset, witness: { ...reset.witness, id: 'another' } } },
      { ...input, reset: { ...reset, source: { ...reset.source, ref: { ...reset.source.ref, accountId: 'another' } } } },
      { ...input, reset: { ...reset, recordId: 'paug_v1_anotherrecord' } },
      { ...input, reset: { ...reset, witness: { ...reset.witness, observedAtMs: 101 } } },
    ]) expect(openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, envelope: { ...request,
      pendingResetStartAdmission: projectExternalActionPendingResetStartAdmissionV1(substituted) }, binding: resetBinding, material })).toBeNull();
    const { pendingResetStartAdmission: _admission, ...missing } = request;
    expect(openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, envelope: missing, binding: resetBinding, material })).toBeNull();
  });
  it('retains terminal authentication kind across encrypted finite requests and responses without an Account upgrade', () => {
    const { credentialId: _credentialId, ...routing } = binding;
    const terminal = { ...routing, actionId: 'projects.script.run', authentication: { kind: 'terminal' as const, tokenEpoch: 7 } };
    const account = { ...terminal, authentication: { kind: 'account' as const, tokenEpoch: 7 } };
    const input = { privateCommand: 'caller-owned finite work' };
    const request = sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, binding: terminal, input, material, randomBytes });
    expect(openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, envelope: request, binding: terminal, material })).toEqual({ input });
    expect(openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, envelope: request, binding: account, material })).toBeNull();
    const response = prepareExternalActionResponseV2({ binding: terminal, request,
      executedMachineId: binding.target.machineId, execution: { ok: true, result: { finite: true } }, material, randomBytes });
    expect(openExternalActionResponseV2({ envelope: response.response, binding: terminal, request, material }))
      .toEqual({ ok: true, result: { finite: true } });
    expect(openExternalActionResponseV2({ envelope: response.response, binding: account, request, material })).toBeNull();
  });
  it('binds ordinary Account ciphertext to the exact authentication epoch without a PAT alias', () => {
    const { credentialId: _credentialId, ...routing } = binding;
    const accountBinding = { ...routing, authentication: { kind: 'account' as const, tokenEpoch: 7 } };
    const input = { privateStartupInstructions: 'Do not expose this to the Home' };
    const request = sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, binding: accountBinding, input, material, randomBytes });
    expect(openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, envelope: request, binding: accountBinding, material })).toEqual({ input });
    expect(openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, envelope: request, binding: { ...accountBinding,
      authentication: { kind: 'account', tokenEpoch: 8 } }, material })).toBeNull();
    expect(openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, envelope: request, binding, material })).toBeNull();
    const response = prepareExternalActionResponseV2({ binding: accountBinding, request,
      executedMachineId: binding.target.machineId, execution: { ok: true, result: { managedId: 'waiting' } }, material, randomBytes });
    expect(openExternalActionResponseV2({ envelope: response.response, binding: accountBinding, request, material }))
      .toEqual({ ok: true, result: { managedId: 'waiting' } });
  });
  it('preserves the complete decoded V1 request budget for domain input', () => {
      const target = binding.target;
      const input = { blob: '' };
      const baseEnvelope = { v: 1 as const, requestId: binding.requestId, target, input };
      const baseBytes = new TextEncoder().encode(JSON.stringify(baseEnvelope)).byteLength;
      const padding = 'x'.repeat(EXTERNAL_ACTION_HTTP_BODY_LIMIT_BYTES - baseBytes);
      const completeInput = { blob: padding };
      const completeTarget = target;
      const completeEnvelope = {
        v: 1 as const,
        requestId: binding.requestId,
        target: completeTarget,
        input: completeInput,
      };

      expect(new TextEncoder().encode(JSON.stringify(completeEnvelope)).byteLength)
        .toBe(EXTERNAL_ACTION_HTTP_BODY_LIMIT_BYTES);
      expect(isExternalActionRequestWithinLimit(completeEnvelope)).toBe(true);

      const completeBinding = { ...binding, target: completeTarget };
      const sealed = sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1,
        binding: completeBinding,
        input: completeInput,
        material,
        randomBytes,
      });
      const opened = openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1,
        envelope: sealed,
        binding: completeBinding,
        material,
      });

      expect(opened).not.toBeNull();
      expect((opened?.input as { blob: string }).blob).toHaveLength(padding.length);
  }, 120_000);

  it('preserves the decoded reset input budget with compact exact facts for Home admission', () => {
    const target = { kind: 'session' as const, sessionId: 'session' };
    const reset = { source: { bindingKind: 'account' as const, ref: { service: { pluginId: 'example.usage', localId: 'quota' }, accountId: 'connected' } },
      recordId: 'paug_v1_abcdefgh', meterId: '', witness: { id: 'accepted', observedAtMs: 100 } };
    const input = { sessionId: 'session', localId: 'prepared', reset };
    const bytes = new TextEncoder().encode(JSON.stringify({ v: 1, requestId: binding.requestId, target, input })).byteLength;
    input.reset.meterId = 'x'.repeat(EXTERNAL_ACTION_HTTP_BODY_LIMIT_BYTES - bytes);
    const resetBinding = { ...binding, actionId: 'session.pending.resetStart.set', target };
    const sealed = sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, binding: resetBinding, input, material, randomBytes });
    expect(isExternalActionRequestWithinLimit(sealed)).toBe(true);
    expect(openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, envelope: sealed, binding: resetBinding, material })).toEqual({ input });
  }, 120_000);

  it('rejects before transmission when duplicated visible routing metadata exceeds the V2 body ceiling', () => {
    const target = {
      kind: 'machine' as const,
      machineId: 'machine-1',
      project: { machineId: 'machine-1', directory: '', workspaceRefId: 'workspace-1' },
    };
    const baseEnvelope = { v: 1 as const, requestId: binding.requestId, target, input: {} };
    const baseBytes = new TextEncoder().encode(JSON.stringify(baseEnvelope)).byteLength;
    const completeTarget = {
      ...target,
      project: {
        ...target.project,
        directory: 'x'.repeat(EXTERNAL_ACTION_HTTP_BODY_LIMIT_BYTES - baseBytes),
      },
    };

    expect(isExternalActionRequestWithinLimit({
      ...baseEnvelope,
      target: completeTarget,
    })).toBe(true);
    expect(() => sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1,
      binding: { ...binding, target: completeTarget },
      input: {},
      material,
      randomBytes,
    })).toThrowError('External Action request exceeds its protected wire limit');
  }, 120_000);

  it('preserves the complete decoded V1 response budget', () => {
    const request = sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, binding, input: {}, material, randomBytes });
    const fixedResponseBytes = measureExternalActionResponseEnvelopeUtf8BytesV1({
      v: 1,
      actionId: binding.actionId,
      requestId: binding.requestId,
      execution: { ok: true, result: '' },
    });
    const result = 'y'.repeat(
      EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES - fixedResponseBytes,
    );
    const response = prepareExternalActionResponseV2({
      binding,
      request,
      executedMachineId: binding.target.machineId,
      execution: { ok: true, result },
      material,
      randomBytes,
    });
    const openedResponse = openExternalActionResponseV2({
      envelope: response.response,
      binding,
      request,
      material,
    });

    expect(response.byteLength).toBeLessThanOrEqual(
      EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES_V2,
    );
    expect(openedResponse?.ok).toBe(true);
    if (openedResponse?.ok) {
      expect(openedResponse.result).toHaveLength(result.length);
    }
  }, 30_000);

  it('rejects an authenticated response that exceeds the existing decoded response budget', () => {
    const request = sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, binding, input: {}, material, randomBytes });
    const fixed = measureExternalActionResponseEnvelopeUtf8BytesV1({ v: 1, actionId: binding.actionId,
      requestId: binding.requestId, execution: { ok: true, result: '' } });
    const c = sealAccountScopedBlobCiphertext({ kind: 'external_action_transport', material, randomBytes,
      payload: { ...binding, v: 2, direction: 'response', executedMachineId: 'machine-1',
        requestPayloadDigest: computeCanonicalDomainSeparatedDigest('happier:external_action_request:v2', [request.payload.c]),
        execution: { ok: true, result: 'x'.repeat(EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES - fixed + 1) } } });
    expect(openExternalActionResponseV2({ envelope: { v: 2, actionId: binding.actionId, requestId: binding.requestId,
      payload: { t: 'encrypted', c } }, binding, request, material })).toBeNull();
  }, 30_000);

  it('protects complete input and result and binds a response to exact ciphertext', () => {
    const input = { sessionId: 'session-1', message: 'private request sentinel' };
    const request = sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, binding, input, material, randomBytes });
    expect(JSON.stringify(request)).not.toContain(input.message);
    expect(openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, envelope: request, binding, material })).toEqual({ input });
    const execution = { ok: false as const, errorCode: 'conflict', error: 'private error sentinel',
      details: { document: 'private conflict sentinel' } };
    const response = prepareExternalActionResponseV2({ binding, request, executedMachineId: 'machine-1',
      execution, material, randomBytes });
    expect(response.body).not.toContain('sentinel');
    expect(openExternalActionResponseV2({ envelope: response.response, binding, request, material })).toEqual(execution);
    const changed = sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, binding, input: { ...input, message: 'other' }, material, randomBytes });
    expect(openExternalActionResponseV2({ envelope: response.response, binding, request: changed, material })).toBeNull();
    const resealed = sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, binding, input, material,
      randomBytes: (length) => new Uint8Array(length).fill(3) });
    expect(openExternalActionResponseV2({ envelope: response.response, binding, request: resealed, material })).toBeNull();
  });

  it.each(['serverIdentityId', 'accountId', 'credentialId', 'actionId', 'requestId'] as const)(
    'rejects a different authenticated %s', (field) => {
      const request = sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, binding, input: {}, material, randomBytes });
      expect(openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, envelope: request, binding: { ...binding, [field]: 'different' }, material })).toBeNull();
    },
  );

  it('rejects target swapping, wrong key, unknown fields and response direction as input', () => {
    const request = sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, binding, input: {}, material, randomBytes });
    expect(openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, envelope: { ...request, target: { kind: 'session', sessionId: 'other' } }, binding, material })).toBeNull();
    expect(openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, envelope: request, binding, material: { type: 'dataKey', machineKey: new Uint8Array(32).fill(1) } })).toBeNull();
    for (const extra of [{ direction: 'response' }, { authority: 'present_user' }]) {
      const c = sealAccountScopedBlobCiphertext({ kind: 'external_action_transport', material, randomBytes,
        payload: { v: 2, direction: 'request', ...binding, input: {}, ...extra } });
      expect(openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, envelope: { ...request, payload: { t: 'encrypted', c } }, binding, material })).toBeNull();
    }
  });

  it('binds every Machine target field inside the encrypted request', () => {
    const projectBinding = { ...binding, target: { ...binding.target, project: { machineId: 'machine-1', directory: '/repo/a', workspaceRefId: 'workspace-1' } } };
    const request = sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, binding: projectBinding, input: {}, material, randomBytes });
    expect(openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, envelope: request, binding: projectBinding, material })).toEqual({ input: {} });
    for (const target of [
      { kind: 'machine' as const, machineId: 'machine-2', project: { ...projectBinding.target.project, machineId: 'machine-2' } },
      { ...projectBinding.target, project: { ...projectBinding.target.project, directory: '/repo/b' } },
      { ...projectBinding.target, project: { ...projectBinding.target.project, workspaceRefId: 'workspace-2' } },
      { kind: 'machine' as const, machineId: 'machine-1' },
      { kind: 'session' as const, sessionId: 'session-1' },
    ]) {
      expect(openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, envelope: request, binding: { ...projectBinding, target }, material })).toBeNull();
    }
  });

  it('retains nested stored ciphertext and protects approval results', () => {
    const request = sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, binding, input: {}, material, randomBytes });
    for (const result of [
      { content: { t: 'encrypted', c: 'stored ciphertext stays byte exact' } },
      { kind: 'approval_request_created', artifactId: 'private-artifact', actionId: binding.actionId },
    ]) {
      const prepared = prepareExternalActionResponseV2({ binding, request, executedMachineId: 'machine-1',
        execution: { ok: true, result }, material, randomBytes });
      expect(openExternalActionResponseV2({ envelope: prepared.response, binding, request, material }))
        .toEqual({ ok: true, result });
    }
    expect(computeCanonicalDomainSeparatedDigest('happier:external_action_request:v2', [request.payload.c])).toHaveLength(43);
  });
});
