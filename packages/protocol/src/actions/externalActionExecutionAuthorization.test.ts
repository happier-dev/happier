import { projectExternalActionMachineRuntimeDemandV1 } from './actionSpecs.js';
import { expect, it } from 'vitest';
import tweetnacl from 'tweetnacl';
import { computeExternalActionRequestEnvelopeDigestV1, readExternalActionBindingAuthority, signExternalActionMachineRequestV1, verifyExternalActionMachineRequestV1, signExternalActionApprovalInputV1, verifyExternalActionApprovalInputV1, signExternalActionMachineRpcRequestV1, verifyExternalActionMachineRpcRequestV1 } from './externalActionExecutionAuthorization.js';
import { computeExternalActionSocketRpcRequestDigestV1 } from './externalActionExecutionAuthorization.js';
import { encodeDeploymentChildExecutionV1, decodeDeploymentChildExecutionV1, projectDeploymentChildExecutionProofV1 } from './externalActionExecutionAuthorization.js';
import { encodeReviewedActionChildHttpProofV1, decodeReviewedActionChildHttpProofV1 } from './externalActionExecutionAuthorization.js';
import { isExternalActionAuthorizationBoundToEnvelope } from './externalActionExecutionAuthorization.js';
import type { ExternalActionExecutionAuthorizationBindingV1, ExternalActionTargetV1 } from './externalActionApi.js';
import { ExternalActionExecutionAuthorizationV1Schema, ExternalActionExecutionAuthorizationRequestV1Schema } from './externalActionApi.js';
import { WorkspaceSyncSourceContextV1Schema, WorkspaceSyncSourceRoutingV1Schema, WorkspaceSyncTargetRoutingV1Schema } from '../rpc/socket.js';
import { RPC_METHODS } from '../rpc/methods.js';
import { sealExternalActionRequestV2 } from './externalActionEncryption.js';
import { DeploymentChildRpcV1Schema } from '../deployments/deploymentChildRpcV1.js';
import { projectDeploymentChildRoutingV1 } from '../deployments/deploymentChildRoutingV1.js';
import { projectExternalActionDeploymentReadEnvelopeAdmissionV1,
  projectExternalActionDeploymentPreparationEnvelopeAdmissionV1,
  projectExternalActionDeploymentNativeEnvelopeAdmissionV1, projectDeploymentNativeAdmissionV1,
  isDeploymentDomainNativeAdmissionV1 } from './externalActionApi.js';
import { projectNativeJsonValueForTransport } from '../json/strictJsonValue.js';
import { DeploymentChildExecutionProofV1Schema } from '../deployments/deploymentChildExecutionProofV1.js';
import { createCanonicalJsonSigningInput } from '../crypto/canonicalJson.js';
import { computeDeploymentEnvironmentUpdateInputDigestV1, computeDeploymentEnvironmentUpdateMetadataDigestV1,
  isDeploymentEnvironmentUpdateNativeAdmissionV1 } from '../deployments/deploymentCandidatePublicationV1.js';

it.each([
  ['account', { authentication: { kind: 'account', tokenEpoch: 1 } }, 'present_user'],
  ['terminal', { authentication: { kind: 'terminal', tokenEpoch: 1 } }, 'account_automation'],
  ['api_token', { principalId: 'principal', credentialId: 'credential', grant: {} }, 'account_automation'],
  ['account native spawn child', { authentication: { kind: 'account', tokenEpoch: 1 }, nativeCredentialSpawnChild: { requestId: 'request', requestEnvelopeDigest: 'a'.repeat(43) } }, 'account_automation'],
] as const)('projects %s binding authority through the canonical owner', (_kind, fields, expected) => {
  const binding = fields as unknown as ExternalActionExecutionAuthorizationBindingV1;
  expect(readExternalActionBindingAuthority(binding)).toBe(expected);
});

it.each(['plain', 'e2ee'] as const)('retains telemetry native scope across its %s authorization envelope', mode => {
  const actionId = 'deployments.environments.telemetry.set';
  const target = { kind: 'machine', machineId: 'controller' } as const;
  const input = { serverId: 'srv_home', environmentId: 'environment', expectedRevision: 4, collector: { machineId: 'collector' } };
  const envelope = mode === 'plain' ? { v: 1, requestId: 'telemetry-request', target, input } as const
    : sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1,
      binding: { serverIdentityId: input.serverId, accountId: 'actor', actionId, requestId: 'telemetry-request', target,
        authentication: { kind: 'account', tokenEpoch: 1 } }, input,
      material: { type: 'dataKey', machineKey: new Uint8Array(32).fill(9) }, randomBytes: n => new Uint8Array(n).fill(2) });
  const native = projectExternalActionDeploymentNativeEnvelopeAdmissionV1({ actionId, envelope });
  const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'telemetry-proof', binding: {
    accountId: 'actor', custodianAccountId: 'actor', authentication: { kind: 'account', tokenEpoch: 1 },
    serverIdentityId: input.serverId, machineId: target.machineId, installationId: 'installation', actionId,
    requestId: envelope.requestId, target, accountEncryptionMode: mode, environmentId: input.environmentId,
    ...(envelope.v === 2 && envelope.machineRuntimeDemand ? { machineRuntimeDemand: envelope.machineRuntimeDemand } : {}),
    deploymentNativeAdmission: native, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
  } });
  const received = ExternalActionExecutionAuthorizationV1Schema.parse(JSON.parse(JSON.stringify(authorization)));
  expect(isExternalActionAuthorizationBoundToEnvelope(received.binding,
    { actionId, machineId: target.machineId, envelope })).toBe(true);
  const changed = projectDeploymentNativeAdmissionV1(actionId, { ...input, collector: { machineId: 'other' } });
  expect(isExternalActionAuthorizationBoundToEnvelope({ ...received.binding, deploymentNativeAdmission: changed },
    { actionId, machineId: target.machineId, envelope })).toBe(false);
});

it('binds private preview template content while preserving the reviewed Environment metadata', () => {
  const previewTemplate = { v: 1, enabled: true, forkPreviews: 'off',
    repository: { kind: 'github', deployment: 'https://github.com', repository: 'owner/app' },
    runtimeTargetLinkId: 'runtime', domain: null, bindingBlueprints: [], data: [] };
  const input = { serverId: 'home', environmentId: 'environment', expectedRevision: 4,
    contentArtifactId: 'current-content', contentHeaderVersion: 1, contentBodyVersion: 1,
    patch: { buildMachineId: 'builder', previewTemplate } };
  const native = projectDeploymentNativeAdmissionV1('deployments.environments.update', input);
  expect(isDeploymentEnvironmentUpdateNativeAdmissionV1(native)).toBe(true);
  if (!isDeploymentEnvironmentUpdateNativeAdmissionV1(native)) throw new Error('Expected authored Environment admission');
  const prepared = { ...input, contentArtifactId: 'prepared-content',
    patch: { buildMachineId: input.patch.buildMachineId } };
  expect(computeDeploymentEnvironmentUpdateMetadataDigestV1(prepared)).toBe(native.authoredMetadataDigest);
  expect(computeDeploymentEnvironmentUpdateInputDigestV1({ ...input,
    patch: { ...input.patch, previewTemplate: { ...previewTemplate, enabled: false } } })).not.toBe(native.inputDigest);
  expect(computeDeploymentEnvironmentUpdateMetadataDigestV1({ ...prepared,
    patch: { buildMachineId: 'foreign-builder' } })).not.toBe(native.authoredMetadataDigest);
});

it.each([
  ['plain', 'runtime'], ['plain', 'builder'], ['e2ee', 'runtime'], ['e2ee', 'builder'],
] as const)('retains preview placement authorization across its HTTP JSON boundary (%s, %s only)', (mode, placement) => {
  const actionId = 'deployments.environments.update';
  const target = { kind: 'machine', machineId: 'controller' } as const;
  const input = { serverId: 'srv_preview', environmentId: 'environment', expectedRevision: 4,
    contentArtifactId: 'content', contentHeaderVersion: 1, contentBodyVersion: 1,
    ...(placement === 'runtime' ? { patch: { previewTemplate: { v: 1, enabled: true, forkPreviews: 'off',
      repository: { kind: 'github', deployment: 'https://github.com', repository: 'owner/app' },
      runtimeTargetLinkId: 'runtime', domain: null, bindingBlueprints: [], data: [] } } }
      : { patch: { buildMachineId: 'builder' } }) };
  const envelope = mode === 'plain' ? { v: 1, requestId: 'preview-placement', target, input } as const
    : sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1,
      binding: { serverIdentityId: input.serverId, accountId: 'actor', actionId, requestId: 'preview-placement', target,
        authentication: { kind: 'account', tokenEpoch: 1 } }, input,
      material: { type: 'dataKey', machineKey: new Uint8Array(32).fill(9) }, randomBytes: n => new Uint8Array(n).fill(2) });
  const native = projectExternalActionDeploymentNativeEnvelopeAdmissionV1({ actionId, envelope });
  const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'preview-proof', binding: {
    accountId: 'actor', custodianAccountId: 'actor', authentication: { kind: 'account', tokenEpoch: 1 },
    serverIdentityId: input.serverId, machineId: target.machineId, installationId: 'installation', actionId,
    requestId: envelope.requestId, target, accountEncryptionMode: mode, environmentId: input.environmentId,
    ...(envelope.v === 2 && envelope.machineRuntimeDemand ? { machineRuntimeDemand: envelope.machineRuntimeDemand } : {}),
    deploymentNativeAdmission: native, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
  } });
  const received = ExternalActionExecutionAuthorizationV1Schema.parse(JSON.parse(JSON.stringify(authorization)));
  expect(isExternalActionAuthorizationBoundToEnvelope(received.binding,
    { actionId, machineId: target.machineId, envelope })).toBe(true);
});

it.each(['template.instantiate', 'template.updates.apply'] as const)('refuses obsolete requester software carriers while retaining ordinary authorization (%s)', actionId => {
  const authorization = { v: 1, token: 'template-setup-proof', binding: {
    accountId: 'actor', custodianAccountId: 'actor', authentication: { kind: 'account', tokenEpoch: 1 },
    serverIdentityId: 'srv_template', machineId: 'receiver', installationId: 'installation', actionId,
    requestId: 'template-root', target: { kind: 'machine', machineId: 'receiver' },
    admittedMachineRole: 'manage', accountEncryptionMode: 'plain', requestEnvelopeDigest: 'a'.repeat(43),
    templateRequesterSetupAdmission: { kind: 'software', planInputDigest: 'b'.repeat(43) },
  } };
  expect(ExternalActionExecutionAuthorizationV1Schema.safeParse(authorization).success).toBe(false);
  const { templateRequesterSetupAdmission: _setupHint, ...ordinaryBinding } = authorization.binding;
  const ordinaryAuthorization = { ...authorization, binding: ordinaryBinding };
  expect(ExternalActionExecutionAuthorizationV1Schema.safeParse(ordinaryAuthorization).success).toBe(true);
  const request = { v: 1, machineId: ordinaryBinding.machineId, envelope: { v: 1, requestId: ordinaryBinding.requestId,
    target: ordinaryBinding.target, input: {} } };
  expect(ExternalActionExecutionAuthorizationRequestV1Schema.safeParse(request).success).toBe(true);
  expect(ExternalActionExecutionAuthorizationRequestV1Schema.safeParse({ ...request,
    templateRequesterSetupAdmission: { kind: 'software' } }).success).toBe(false);
  expect(ExternalActionExecutionAuthorizationRequestV1Schema.safeParse({ ...request,
    templateRequesterSetupEnrichment: { authorization: ordinaryAuthorization, planInputDigest: 'b'.repeat(43) } }).success).toBe(false);
  const nativeApply = { ...authorization, binding: { ...ordinaryBinding, actionId: 'machines.setup.apply' } };
  expect(ExternalActionExecutionAuthorizationV1Schema.safeParse(nativeApply).success).toBe(true);
  expect(ExternalActionExecutionAuthorizationV1Schema.safeParse({ ...nativeApply, binding: { ...nativeApply.binding,
    templateRequesterSetupApplyAdmission: { parentActionId: actionId, inputDigest: 'c'.repeat(43) } } }).success).toBe(false);
});

it.each(['plain', 'e2ee'] as const)('binds ingress preparation to the admitted Environment (%s)', mode => {
  const actionId = 'deployments.environments.update';
  const target = { kind: 'machine', machineId: 'controller' } as const;
  const input = { serverId: 'srv_ingress', environmentId: 'environment', expectedRevision: 1,
    contentArtifactId: 'current-content', contentHeaderVersion: 1, contentBodyVersion: 1,
    patch: { ingress: { kind: 'cloudflareTunnel' } } };
  const envelope = mode === 'plain' ? { v: 1, requestId: 'ingress-root', target, input } as const
    : sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, binding: { serverIdentityId: 'srv_ingress', accountId: 'actor', actionId,
      requestId: 'ingress-root', target, authentication: { kind: 'account', tokenEpoch: 1 } }, input,
      material: { type: 'dataKey', machineKey: new Uint8Array(32).fill(9) }, randomBytes: n => new Uint8Array(n).fill(2) });
  const native = projectExternalActionDeploymentNativeEnvelopeAdmissionV1({ actionId, envelope });
  expect(native).toMatchObject({ environmentId: input.environmentId, inputDigest: expect.any(String),
    authoredMetadataDigest: expect.any(String) });
  const { binding } = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'ingress-proof', binding: {
    accountId: 'actor', custodianAccountId: 'actor', authentication: { kind: 'account', tokenEpoch: 1 },
    serverIdentityId: 'srv_ingress', machineId: target.machineId, installationId: 'installation', actionId,
    requestId: envelope.requestId, target, accountEncryptionMode: mode, environmentId: input.environmentId,
    deploymentNativeAdmission: native, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
  } });
  expect(binding.deploymentCandidatePublication).toBeUndefined();
  expect(isExternalActionAuthorizationBoundToEnvelope(binding, { actionId, machineId: target.machineId, envelope })).toBe(true);
  for (const replacement of [{ ...input, expectedRevision: 2 }, { ...input, patch: { ingress: null } }]) {
    expect(isExternalActionAuthorizationBoundToEnvelope({ ...binding,
      deploymentNativeAdmission: projectDeploymentNativeAdmissionV1(actionId, replacement) },
    { actionId, machineId: target.machineId, envelope })).toBe(false);
  }
  const { patch: _patch, ...ordinaryUpdate } = input;
  expect(projectDeploymentNativeAdmissionV1(actionId, ordinaryUpdate)).toBeUndefined();
});

it.each(['plain', 'e2ee'] as const)('binds exact Domain public-input custody without receipt candidate publication (%s)', mode => {
  const actionId = 'deployments.domains.add';
  const target = { kind: 'machine', machineId: 'controller' } as const;
  const input = { serverId: 'srv_domain', environmentId: 'environment', domainId: 'domain', expectedRevision: 1,
    targetLinkId: 'runtime', expectedTargetLinkRevision: 1, requestKey: 'request',
    contentArtifactId: 'domain-content', contentHeaderVersion: 1, contentBodyVersion: 1 };
  const envelope = mode === 'plain' ? { v: 1, requestId: 'domain-root', target, input } as const
    : sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, binding: { serverIdentityId: 'srv_domain', accountId: 'actor', actionId,
      requestId: 'domain-root', target, authentication: { kind: 'account', tokenEpoch: 1 } }, input,
      material: { type: 'dataKey', machineKey: new Uint8Array(32).fill(9) }, randomBytes: n => new Uint8Array(n).fill(2) });
  const deploymentNativeAdmission = projectExternalActionDeploymentNativeEnvelopeAdmissionV1({ actionId, envelope });
  const { binding } = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'domain-proof', binding: {
    accountId: 'actor', custodianAccountId: 'actor', authentication: { kind: 'account', tokenEpoch: 1 },
    serverIdentityId: 'srv_domain', machineId: target.machineId, installationId: 'installation', actionId,
    requestId: 'domain-root', target, accountEncryptionMode: mode, environmentId: input.environmentId, deploymentChildRoot: true,
    deploymentNativeAdmission, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
  } });
  expect(binding.deploymentCandidatePublication).toBeUndefined();
  expect(isExternalActionAuthorizationBoundToEnvelope(binding, { actionId, machineId: target.machineId, envelope })).toBe(true);
  const replacement = projectDeploymentNativeAdmissionV1(actionId, { ...input, contentArtifactId: 'another-domain-content' });
  if (!isDeploymentDomainNativeAdmissionV1(replacement)) throw new Error('Expected Domain projection');
  expect(isExternalActionAuthorizationBoundToEnvelope({ ...binding, deploymentNativeAdmission: replacement },
    { actionId, machineId: target.machineId, envelope })).toBe(false);
});

it.each([
  ['plain', 'prepare'], ['plain', 'confirm'], ['e2ee', 'prepare'], ['e2ee', 'confirm'],
] as const)('binds exact restore admission without receipt candidate publication (%s, %s)', (accountMode, mode) => {
  const actionId = 'deployments.backups.restore';
  const target = { kind: 'machine', machineId: 'runtime' } as const;
  const input = { serverId: 'srv_restore', environmentId: 'environment', machineId: target.machineId,
    installationId: 'installation', targetLinkId: 'runtime-link', deploymentId: 'capture-receipt',
    source: { kind: 'repository' as const, snapshotId: 'backup' }, expectedRevision: 3, mode,
    ...(mode === 'confirm' ? { prepareOperationId: 'prepared-restore' } : {}) };
  const envelope = accountMode === 'plain' ? { v: 1, requestId: 'restore-root', target, input } as const
    : sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, binding: { serverIdentityId: 'srv_restore', accountId: 'owner', actionId,
      requestId: 'restore-root', target, authentication: { kind: 'account', tokenEpoch: 1 } }, input,
      material: { type: 'dataKey', machineKey: new Uint8Array(32).fill(9) }, randomBytes: n => new Uint8Array(n).fill(2) });
  const deploymentNativeAdmission = projectExternalActionDeploymentNativeEnvelopeAdmissionV1({ actionId, envelope });
  const { binding } = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'restore-proof', binding: {
    accountId: 'owner', custodianAccountId: 'owner', authentication: { kind: 'account', tokenEpoch: 1 },
    serverIdentityId: 'srv_restore', machineId: target.machineId, installationId: input.installationId, actionId,
    requestId: envelope.requestId, target, accountEncryptionMode: accountMode, environmentId: input.environmentId,
    deploymentNativeAdmission, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
  } });
  expect(binding.deploymentCandidatePublication).toBeUndefined();
  expect(isExternalActionAuthorizationBoundToEnvelope(binding, { actionId, machineId: target.machineId, envelope })).toBe(true);
  expect(isExternalActionAuthorizationBoundToEnvelope({ ...binding, environmentId: 'foreign-environment' },
    { actionId, machineId: target.machineId, envelope })).toBe(false);
  const differentBackup = projectDeploymentNativeAdmissionV1(actionId, { ...input, source: { ...input.source, snapshotId: 'other-backup' } });
  expect(isExternalActionAuthorizationBoundToEnvelope({ ...binding, deploymentNativeAdmission: differentBackup },
    { actionId, machineId: target.machineId, envelope })).toBe(false);
  if (mode === 'confirm') {
    const differentPreparation = projectDeploymentNativeAdmissionV1(actionId, { ...input, prepareOperationId: 'other-preparation' });
    expect(isExternalActionAuthorizationBoundToEnvelope({ ...binding, deploymentNativeAdmission: differentPreparation },
      { actionId, machineId: target.machineId, envelope })).toBe(false);
  }
});

it.each(['plain', 'e2ee'] as const)('binds native teardown to its explicit Environment without candidate publication (%s)', mode => {
  const actionId = 'deployments.teardown';
  const target = { kind: 'machine', machineId: 'receiver' } as const;
  const input = { serverId: 'srv_binding', environmentId: 'environment', expectedRevision: 1,
    targetLinkId: 'runtime', expectedTargetLinkRevision: 1, requestKey: 'cleanup', reason: 'manual',
    contentArtifactId: 'cleanup-receipt', contentHeaderVersion: 1, contentBodyVersion: 1 };
  const envelope = mode === 'plain' ? { v: 1, requestId: 'cleanup-root', target, input } as const
    : sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, binding: { serverIdentityId: 'srv_binding', accountId: 'actor', actionId,
      requestId: 'cleanup-root', target, authentication: { kind: 'account', tokenEpoch: 1 } }, input,
      material: { type: 'dataKey', machineKey: new Uint8Array(32).fill(9) }, randomBytes: n => new Uint8Array(n).fill(2) });
  const { binding } = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'proof', binding: {
    accountId: 'actor', custodianAccountId: 'actor', authentication: { kind: 'account', tokenEpoch: 1 },
    serverIdentityId: 'srv_binding', machineId: target.machineId, installationId: 'installation', actionId,
    requestId: 'cleanup-root', target, accountEncryptionMode: mode, environmentId: input.environmentId,
    requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
  } });
  expect(binding.deploymentCandidatePublication).toBeUndefined();
  expect(isExternalActionAuthorizationBoundToEnvelope(binding, { actionId, machineId: target.machineId, envelope })).toBe(true);
  expect(isExternalActionAuthorizationBoundToEnvelope({ ...binding, environmentId: 'another-environment' },
    { actionId, machineId: target.machineId, envelope })).toBe(false);
});

it.each(['plain', 'e2ee'] as const)('leaves an ordinary qualified Action outside deployment read admission (%s)', mode => {
  const actionId = 'action.invoke';
  const target = { kind: 'machine', machineId: 'receiver' } as const;
  const input = { action: { pluginId: 'acme.reviewed-picker', localId: 'assign' }, input: { issue: 'ISSUE-42', assignee: 'alice' } };
  const envelope = mode === 'plain' ? { v: 1, requestId: 'ordinary-root', target, input } as const
    : sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1,
      binding: { serverIdentityId: 'srv_binding', accountId: 'actor', actionId, requestId: 'ordinary-root', target,
        authentication: { kind: 'account', tokenEpoch: 1 } }, input,
      material: { type: 'dataKey', machineKey: new Uint8Array(32).fill(9) }, randomBytes: n => new Uint8Array(n).fill(2) });
  expect(projectExternalActionDeploymentReadEnvelopeAdmissionV1({ actionId, envelope })).toBeUndefined();
});

it('retains required deployment read metadata and refuses a mismatched real read admission', () => {
  const target = { kind: 'machine', machineId: 'receiver' } as const;
  const envelope = sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1,
    binding: { serverIdentityId: 'srv_binding', accountId: 'actor', actionId: 'deployments.health.read', requestId: 'read-root', target,
      authentication: { kind: 'account', tokenEpoch: 1 } },
    input: { serverId: 'srv_binding', environmentId: 'environment', deploymentId: 'receipt', targetLinkId: 'runtime',
      machineId: target.machineId, installationId: 'installation', service: { kind: 'deployment', machineId: target.machineId,
        environmentId: 'environment', environmentInstanceId: 'instance', composeService: 'web', serviceId: 'instance/web' } },
    material: { type: 'dataKey', machineKey: new Uint8Array(32).fill(9) }, randomBytes: n => new Uint8Array(n).fill(2) });
  expect(projectExternalActionDeploymentReadEnvelopeAdmissionV1({ actionId: 'deployments.health.read', envelope }))
    .toMatchObject({ actionId: 'deployments.health.read' });
  expect(() => projectExternalActionDeploymentReadEnvelopeAdmissionV1({ actionId: 'action.invoke', envelope })).toThrow(TypeError);
  expect(() => projectExternalActionDeploymentReadEnvelopeAdmissionV1({ actionId: 'deployments.health.read',
    envelope: { ...envelope, deploymentReadAdmission: undefined } })).toThrow();
});

it.each(['deployments.prepare', 'deployments.health.read'] as const)(
  'binds the exact closed projection as well as the envelope digest for %s', actionId => {
    const target = { kind: 'machine', machineId: 'receiver' } as const;
    const input = projectNativeJsonValueForTransport(actionId === 'deployments.prepare'
      ? { projectSourceId: 'source', sourceRevision: 1,
        repository: { kind: 'github', deployment: 'https://github.com', repository: 'private/project' },
        baseCommit: 'a'.repeat(40), workspace: { kind: 'workspace-ref', serverId: 'srv_binding', id: 'workspace' },
        sessionRef: { serverId: 'srv_binding', sessionId: 'preparation-session' } }
      : { serverId: 'srv_binding', environmentId: 'environment', deploymentId: 'receipt', targetLinkId: 'runtime',
        machineId: target.machineId, installationId: 'installation', service: { kind: 'deployment', machineId: target.machineId,
          environmentId: 'environment', environmentInstanceId: 'instance', composeService: 'web', serviceId: 'instance/web' } });
    for (const mode of ['plain', 'e2ee'] as const) {
      const envelope = mode === 'plain' ? { v: 1, requestId: 'root', target, input } as const
        : sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, binding: { serverIdentityId: 'srv_binding', accountId: 'actor', actionId,
          requestId: 'root', target, authentication: { kind: 'account', tokenEpoch: 1 } }, input,
          material: { type: 'dataKey', machineKey: new Uint8Array(32).fill(9) }, randomBytes: n => new Uint8Array(n).fill(2) });
      const deploymentReadAdmission = projectExternalActionDeploymentReadEnvelopeAdmissionV1({ actionId, envelope });
      const deploymentPreparationAdmission = projectExternalActionDeploymentPreparationEnvelopeAdmissionV1({ actionId, envelope });
      const { binding } = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'proof', binding: {
        accountId: 'actor', custodianAccountId: 'actor', authentication: { kind: 'account', tokenEpoch: 1 },
        serverIdentityId: 'srv_binding', machineId: target.machineId, installationId: 'installation', actionId,
        requestId: 'root', target, accountEncryptionMode: mode, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
        ...(deploymentReadAdmission ? { deploymentReadAdmission } : {}),
        ...(deploymentPreparationAdmission ? { deploymentPreparationAdmission } : {}),
      } });
      expect(isExternalActionAuthorizationBoundToEnvelope(binding, { actionId, machineId: target.machineId, envelope })).toBe(true);
      const substituted = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'proof', binding: { ...binding,
        ...(deploymentReadAdmission ? { deploymentReadAdmission: { ...deploymentReadAdmission, deploymentId: 'another' } } : {}),
        ...(deploymentPreparationAdmission?.operation === 'prepare' ? { deploymentPreparationAdmission: {
          ...deploymentPreparationAdmission, workspace: { kind: 'workspace-ref', id: 'another' } } } : {}),
      } }).binding;
      expect(isExternalActionAuthorizationBoundToEnvelope(substituted, { actionId, machineId: target.machineId, envelope })).toBe(false);
    }
  });

it('retains exact non-content promotion source references in original signed child routing', () => {
  const promotion = { sourceEnvironmentId: 'source', sourceDeploymentId: 'selected-source',
    artifact: 'image' as const,
    destinationContent: { contentArtifactId: 'destination-definition', contentHeaderVersion: 1, contentBodyVersion: 1 } };
  const job = DeploymentChildRpcV1Schema.parse({ v: 1, kind: 'review', actionId: 'deployments.promote',
    machineId: 'receiver', installationId: 'receiver-installation', input: { serverId: 'home', environmentId: 'destination',
      targetLinkId: 'link', expectedRevision: 1, expectedTargetLinkRevision: 1, requestKey: 'request',
      contentArtifactId: 'candidate', contentHeaderVersion: 1, contentBodyVersion: 1, ...promotion } });
  const routing = projectDeploymentChildRoutingV1(job);
  expect(routing).toMatchObject({ promotion });
  const key = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(27));
  const request = { authorizationToken: 'root', effectActionId: job.actionId, target: { kind: 'machine', machineId: 'controller' } as const,
    installationId: 'controller-installation', method: `receiver:${RPC_METHODS.DAEMON_DEPLOYMENT_CHILD}`,
    requestId: 'promotion-review', params: 'encrypted', deploymentChildRouting: routing };
  const signature = signExternalActionMachineRpcRequestV1({ ...request, privateKey: key.secretKey });
  expect(verifyExternalActionMachineRpcRequestV1({ ...request, signature, publicKey: key.publicKey })).toBe(true);
  expect(verifyExternalActionMachineRpcRequestV1({ ...request, signature, publicKey: key.publicKey,
    deploymentChildRouting: { ...routing, promotion: { ...promotion, sourceDeploymentId: 'unrelated-source' } } })).toBe(false);
});

it('binds non-content deployment child routing to the same signed encrypted RPC request', () => {
  const key = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(28));
  const routing = { v: 1, kind: 'member', actionId: 'deployments.deploy', machineId: 'receiver',
    installationId: 'receiver-installation', deploymentId: 'deployment', actionOperationId: 'operation',
    phase: 'activate', selectedDeploymentId: 'deployment', input: {
      serverId: 'home', environmentId: 'environment', targetLinkId: 'link', expectedRevision: 1,
      expectedTargetLinkRevision: 1, requestKey: 'request', contentArtifactId: 'candidate',
      contentHeaderVersion: 1, contentBodyVersion: 1,
    } } as const;
  const request = { authorizationToken: 'original-controller-root', effectActionId: 'deployments.deploy',
    target: { kind: 'machine', machineId: 'controller' } as const, installationId: 'controller-installation',
    method: `receiver:${RPC_METHODS.DAEMON_DEPLOYMENT_CHILD}`, requestId: 'child-request', params: 'encrypted-params',
    deploymentChildRouting: routing };
  const signature = signExternalActionMachineRpcRequestV1({ ...request, privateKey: key.secretKey });
  expect(verifyExternalActionMachineRpcRequestV1({ ...request, publicKey: key.publicKey, signature })).toBe(true);
  expect(verifyExternalActionMachineRpcRequestV1({ ...request, deploymentChildRouting: { ...routing,
    actionOperationId: 'substituted' }, publicKey: key.publicKey, signature })).toBe(false);
});

it('binds a receiver HTTP request to the retained controller-signed child packet', () => {
  const key = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(29));
  const target = { kind: 'machine', machineId: 'controller' } as const;
  const input = { serverId: 'home', environmentId: 'environment', targetLinkId: 'link', expectedRevision: 1,
    expectedTargetLinkRevision: 1, requestKey: 'request', contentArtifactId: 'candidate', contentHeaderVersion: 1, contentBodyVersion: 1 };
  const originalActionEnvelope = { v: 1, requestId: 'root-request', target, input } as const;
  const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'root', binding: {
    accountId: 'actor', custodianAccountId: 'owner', authentication: { kind: 'account', tokenEpoch: 1 },
    serverIdentityId: 'home', machineId: 'controller', installationId: 'controller-installation',
    actionId: 'deployments.deploy', requestId: 'root-request', target,
    requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(originalActionEnvelope), accountEncryptionMode: 'plain',
  } });
  const routing = { v: 1, kind: 'member', actionId: 'deployments.deploy', input, machineId: 'receiver',
    installationId: 'receiver-installation', deploymentId: 'deployment', actionOperationId: 'operation',
    phase: 'activate', selectedDeploymentId: 'deployment' } as const;
  const deploymentChildExecution = { method: `receiver:${RPC_METHODS.DAEMON_DEPLOYMENT_CHILD}`, requestId: 'child-request',
    params: 'encrypted-child', originalActionEnvelope, externalActionExecution: { v: 1, authorization,
      effectActionId: 'deployments.deploy', target, installationId: 'controller-installation',
      machineSignature: 'a'.repeat(86), deploymentChildRouting: routing } } as const;
  const request = { authorizationToken: authorization.token, effectActionId: 'deployments.deploy', target,
    installationId: 'receiver-installation', requestId: 'root-request', method: 'POST',
    path: '/v1/deployments/environments/environment/deployments/deployment/transitions',
    body: { kind: 'stage', machineId: 'receiver' }, deploymentChildExecution };
  const signature = signExternalActionMachineRequestV1({ ...request, privateKey: key.secretKey });
  const originRequest = { ...request, deploymentArchiveOrigin: { environmentId: 'archive-environment', deploymentId: 'archive-receipt',
    holderMachineId: 'holder', holderInstallationId: 'holder-installation' } };
  const originSignature = signExternalActionMachineRequestV1({ ...originRequest, privateKey: key.secretKey });
  expect(verifyExternalActionMachineRequestV1({ ...originRequest, publicKey: key.publicKey, signature: originSignature })).toBe(true);
  expect(verifyExternalActionMachineRequestV1({ ...originRequest,
    deploymentArchiveOrigin: { ...originRequest.deploymentArchiveOrigin, deploymentId: 'unrelated-receipt' },
    publicKey: key.publicKey, signature: originSignature })).toBe(false);
  expect(verifyExternalActionMachineRequestV1({ ...originRequest,
    deploymentArchiveOrigin: { ...originRequest.deploymentArchiveOrigin, holderInstallationId: 'replaced-installation' },
    publicKey: key.publicKey, signature: originSignature })).toBe(false);
  expect(projectDeploymentChildExecutionProofV1(deploymentChildExecution)).not.toHaveProperty('archiveOrigin');
  expect(verifyExternalActionMachineRequestV1({ ...request, signature, publicKey: key.publicKey })).toBe(true);
  expect(verifyExternalActionMachineRequestV1({ ...request, deploymentChildExecution: { ...deploymentChildExecution,
    requestId: 'other-child' }, signature, publicKey: key.publicKey })).toBe(false);
  const params = 'large-encrypted-pending-deploy'.repeat(40_000);
  const sourceRequest = { authorizationToken: authorization.token, effectActionId: 'deployments.deploy', target,
    installationId: 'controller-installation', method: deploymentChildExecution.method,
    requestId: deploymentChildExecution.requestId, params, deploymentChildRouting: routing };
  const sourceSignature = signExternalActionMachineRpcRequestV1({ ...sourceRequest, privateKey: key.secretKey });
  const sourcePacket = { ...deploymentChildExecution, params, externalActionExecution: {
    ...deploymentChildExecution.externalActionExecution, machineSignature: sourceSignature } };
  const proof = projectDeploymentChildExecutionProofV1(sourcePacket);
  expect(proof).not.toHaveProperty('params');
  expect(proof).not.toHaveProperty('originalActionEnvelope');
  const encoded = encodeDeploymentChildExecutionV1(sourcePacket);
  expect(JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))).toMatchObject({
    externalActionExecution: { authorization: { token: { ref: 'http-authorization' } } },
  });
  expect(encoded).toBe(encodeDeploymentChildExecutionV1({ ...sourcePacket,
    originalActionEnvelope: { ...originalActionEnvelope, input: { ...input, pendingDeploy: params } } }));
  expect(decodeDeploymentChildExecutionV1(encoded)).toBeNull();
  expect(decodeDeploymentChildExecutionV1(encoded, sourcePacket.externalActionExecution.authorization.token)).toEqual(proof);
  const legacyEncoded = Buffer.from(createCanonicalJsonSigningInput(proof)).toString('base64url');
  expect(decodeDeploymentChildExecutionV1(legacyEncoded, authorization.token)).toEqual(proof);
  const malformedReference = { ...proof, externalActionExecution: { ...proof.externalActionExecution,
    authorization: { ...proof.externalActionExecution.authorization,
      token: { ref: 'http-authorization', extra: 'not-a-reference' } } } };
  expect(decodeDeploymentChildExecutionV1(Buffer.from(createCanonicalJsonSigningInput(malformedReference)).toString('base64url'),
    authorization.token)).toBeNull();
  const { params: _params, ...projectedSourceRequest } = sourceRequest;
  expect(verifyExternalActionMachineRpcRequestV1({ ...projectedSourceRequest, paramsPresent: proof.paramsPresent,
    paramsDigest: proof.paramsDigest, signature: sourceSignature, publicKey: key.publicKey })).toBe(true);
  expect(verifyExternalActionMachineRpcRequestV1({ ...projectedSourceRequest, paramsPresent: proof.paramsPresent,
    paramsDigest: 'a'.repeat(43), signature: sourceSignature, publicKey: key.publicKey })).toBe(false);
  const projectedHttp = { ...request, deploymentChildExecution: sourcePacket };
  const httpSignature = signExternalActionMachineRequestV1({ ...projectedHttp, privateKey: key.secretKey });
  expect(verifyExternalActionMachineRequestV1({ ...projectedHttp, deploymentChildExecution: proof,
    signature: httpSignature, publicKey: key.publicKey })).toBe(true);
  const substitutedProof = decodeDeploymentChildExecutionV1(encoded, 'another-authorization-token');
  expect(substitutedProof).not.toBeNull();
  if (!substitutedProof) throw new Error('reference_fixture_required');
  expect(verifyExternalActionMachineRequestV1({ ...projectedHttp, authorizationToken: 'another-authorization-token',
    deploymentChildExecution: substitutedProof, signature: httpSignature, publicKey: key.publicKey })).toBe(false);
  const reviewPacket = { ...sourcePacket, externalActionExecution: { ...sourcePacket.externalActionExecution,
    deploymentChildRouting: { v: 1 as const, kind: 'review' as const, actionId: 'deployments.deploy' as const,
      machineId: 'receiver', installationId: 'receiver-installation', input } } };
  const nativeIncumbentSource = { environmentId: 'environment', sourceDeploymentId: 'actual-incumbent',
    restorationForDeploymentId: 'restored-by', rootFingerprint: 'a'.repeat(64) };
  const annotated = DeploymentChildExecutionProofV1Schema.parse({ ...projectDeploymentChildExecutionProofV1(reviewPacket), nativeIncumbentSource });
  const nativeRequest = { ...request, method: 'GET', body: undefined, deploymentChildExecution: reviewPacket,
    deploymentNativeIncumbentSource: nativeIncumbentSource };
  const nativeSignature = signExternalActionMachineRequestV1({ ...nativeRequest, privateKey: key.secretKey });
  expect(verifyExternalActionMachineRequestV1({ ...nativeRequest, deploymentChildExecution: annotated,
    signature: nativeSignature, publicKey: key.publicKey })).toBe(true);
  expect(verifyExternalActionMachineRequestV1({ ...nativeRequest, deploymentChildExecution: annotated,
    deploymentNativeIncumbentSource: { ...nativeIncumbentSource, rootFingerprint: 'b'.repeat(64) },
    signature: nativeSignature, publicKey: key.publicKey })).toBe(false);
  expect(DeploymentChildExecutionProofV1Schema.safeParse({ ...proof, nativeIncumbentSource }).success).toBe(false);
});

it('binds the controller proof when its admitted receiver signs an archive phase on another holder', () => {
  const key = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(30));
  const target = { kind: 'machine', machineId: 'controller' } as const;
  const input = { serverId: 'home', environmentId: 'environment', targetLinkId: 'link', expectedRevision: 1,
    expectedTargetLinkRevision: 1, requestKey: 'request', contentArtifactId: 'candidate', contentHeaderVersion: 1, contentBodyVersion: 1 };
  const envelope = { v: 1, requestId: 'root-request', target, input } as const;
  const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'root', binding: {
    accountId: 'actor', custodianAccountId: 'owner', authentication: { kind: 'account', tokenEpoch: 1 },
    serverIdentityId: 'home', machineId: 'controller', installationId: 'controller-installation',
    actionId: 'deployments.deploy', requestId: 'root-request', target,
    requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope), accountEncryptionMode: 'plain',
  } });
  const sourcePacket = { method: `receiver:${RPC_METHODS.DAEMON_DEPLOYMENT_CHILD}`, requestId: 'child-request', params: 'encrypted-child',
    originalActionEnvelope: envelope, externalActionExecution: { v: 1, authorization, effectActionId: 'deployments.deploy',
      target, installationId: 'controller-installation', machineSignature: 'a'.repeat(86), deploymentChildRouting: {
        v: 1, kind: 'member', actionId: 'deployments.deploy', input, machineId: 'receiver', installationId: 'receiver-installation',
        deploymentId: 'deployment', actionOperationId: 'operation', phase: 'activate', selectedDeploymentId: 'deployment',
      } } } as const;
  const request = { authorizationToken: authorization.token, effectActionId: 'daemon.filesystem.download', target,
    installationId: 'receiver-installation', method: `holder:${RPC_METHODS.DAEMON_FILESYSTEM_DOWNLOAD}`, requestId: 'archive-read',
    params: { rootPath: '/deployment-root/environment/image-archives/deployment', path: 'archive.tar' }, deploymentChildExecution: sourcePacket };
  const signature = signExternalActionMachineRpcRequestV1({ ...request, privateKey: key.secretKey });
  expect(verifyExternalActionMachineRpcRequestV1({ ...request, signature, publicKey: key.publicKey })).toBe(true);
  const changed = { ...request, deploymentChildExecution: { ...sourcePacket, requestId: 'another-child' } };
  expect(verifyExternalActionMachineRpcRequestV1({ ...changed, signature, publicKey: key.publicKey })).toBe(false);
});

it.each(['machine', 'session'] as const)('binds an original %s-targeted envelope to its exact root and execution Machine', kind => {
  const target: ExternalActionTargetV1 = kind === 'session'
    ? { kind, sessionId: 'session' } : { kind, machineId: 'machine' };
  const envelope = { v: 1 as const, requestId: 'request', target, input: { sessionId: 'session' } };
  const binding = { serverIdentityId: 'home', accountId: 'account', custodianAccountId: 'account',
    machineId: 'machine', installationId: 'installation', actionId: 'session.fork', requestId: envelope.requestId,
    target, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
    authentication: { kind: 'terminal', tokenEpoch: 1 } } satisfies ExternalActionExecutionAuthorizationBindingV1;
  const input = { actionId: binding.actionId, machineId: binding.machineId, envelope };
  expect(isExternalActionAuthorizationBoundToEnvelope(binding, input)).toBe(true);
  expect(isExternalActionAuthorizationBoundToEnvelope(binding, { ...input, machineId: 'another-machine' })).toBe(false);
  expect(isExternalActionAuthorizationBoundToEnvelope(binding, { ...input, actionId: 'session.message.send' })).toBe(false);
  expect(isExternalActionAuthorizationBoundToEnvelope(binding, { ...input, envelope: { ...envelope, requestId: 'another-request' } })).toBe(false);
  expect(isExternalActionAuthorizationBoundToEnvelope(binding, { ...input, envelope: { ...envelope, input: {} } })).toBe(false);
  const changedTarget: ExternalActionTargetV1 = kind === 'session'
    ? { kind, sessionId: 'another-session' } : { kind, machineId: 'another-machine' };
  expect(isExternalActionAuthorizationBoundToEnvelope(binding, { ...input, envelope: { ...envelope, target: changedTarget } })).toBe(false);
});

it.each([1, 2] as const)('binds the installed TARGET decryption attestation to the original Project envelope v%s and logical SOURCE', version => {
  const key = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(27));
  const target = { kind: 'machine' as const, machineId: 'chosen-target' };
  const input = { serverId: `srv_${'a'.repeat(32)}`, machineId: target.machineId,
    source: { kind: 'workspace' as const, workspaceId: 'source-ref', checkout: { serverId: `srv_${'a'.repeat(32)}`,
      workspaceId: 'source-ref', machineId: 'source-child', rootPath: '/child/source' } },
    materialization: { kind: 'sync' as const, targetPath: '/child/target', workspaceAction: { kind: 'copy_once' as const } } };
  const originalActionEnvelope = version === 1 ? { v: 1 as const, requestId: 'original-open', target, input }
    : sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, binding: { serverIdentityId: input.serverId, accountId: 'requester',
      credentialId: '11111111-1111-4111-8111-111111111111', actionId: 'projects.open', requestId: 'original-open', target },
      input, material: { type: 'dataKey', machineKey: new Uint8Array(32).fill(24) }, randomBytes: tweetnacl.randomBytes });
  const workspaceSyncSourceRouting = { ...WorkspaceSyncSourceRoutingV1Schema.parse({ v: 1, phase: 'prepare',
    operationId: 'source-loan-not-root-request', accountServerId: input.serverId, sourceMachineId: 'source-child',
    sourceRootPath: '/child/source', sourceContext: { machineAdmission: { actorAccountId: 'requester',
      custodianAccountId: 'source-custodian', machineId: 'source-child', installationId: 'source-installation',
      role: 'use', encryptionMode: 'plain' }, callerAuthority: 'account_automation' } }), originalActionEnvelope };
  const request = { authorizationToken: 'unchanged-project-root', effectActionId: 'projects.open', target,
    installationId: 'chosen-target-installation', requestId: 'original-open', event: 'rpc-call' as const,
    method: `physical-writer:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_MATERIALIZE_FOR_OPEN}`,
    params: 'sealed-original-open-body', workspaceSyncSourceRouting };
  const signature = signExternalActionMachineRpcRequestV1({ ...request, privateKey: key.secretKey });
  expect(verifyExternalActionMachineRpcRequestV1({ ...request, signature, publicKey: key.publicKey })).toBe(true);
  for (const routing of [
    { ...workspaceSyncSourceRouting, originalActionEnvelope: { ...originalActionEnvelope, requestId: 'another-root' } },
    { ...workspaceSyncSourceRouting, originalActionEnvelope: { ...originalActionEnvelope,
      target: { kind: 'machine' as const, machineId: 'physical-writer' } } },
    { ...workspaceSyncSourceRouting, sourceMachineId: 'another-source' },
    { ...workspaceSyncSourceRouting, sourceRootPath: '/child/another-source' },
    { ...workspaceSyncSourceRouting, operationId: 'another-loan' },
  ]) expect(verifyExternalActionMachineRpcRequestV1({ ...request, workspaceSyncSourceRouting: routing,
    signature, publicKey: key.publicKey })).toBe(false);
  const { workspaceSyncSourceRouting: _routing, ...withoutRouting } = request;
  expect(verifyExternalActionMachineRpcRequestV1({ ...withoutRouting, signature, publicKey: key.publicKey })).toBe(false);
  expect(verifyExternalActionMachineRpcRequestV1({ ...request, signature,
    publicKey: tweetnacl.sign.keyPair().publicKey })).toBe(false);
});

it('binds the physical SOURCE writer TARGET purpose to the unchanged root and exact retained routing snapshot', () => {
  const key = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(19));
  const sourceContext = WorkspaceSyncSourceContextV1Schema.parse({ machineAdmission: { actorAccountId: 'requester',
    custodianAccountId: 'source-custodian', machineId: 'source-child', installationId: 'child-installation', role: 'use', encryptionMode: 'plain' },
    callerAuthority: 'account_automation', callerInputConstraints: { models: null, permissionModes: ['default'] } });
  const source = { ...WorkspaceSyncSourceRoutingV1Schema.parse({ v: 1, phase: 'prepare', operationId: 'retained-source-loan',
    accountServerId: `srv_${'a'.repeat(32)}`, sourceMachineId: 'source-child', sourceRootPath: '/child/source', sourceSessionId: 'moved-session' }), sourceContext };
  const { targetContext: _targetContext, ...target } = WorkspaceSyncTargetRoutingV1Schema.parse({ v: 1, phase: 'preflight',
    operationId: 'target-preflight', accountServerId: source.accountServerId, targetMachineId: 'chosen-target', targetRootPath: '/target',
    targetContext: { ...sourceContext, machineAdmission: { ...sourceContext.machineAdmission,
      machineId: 'chosen-target', installationId: 'target-installation', custodianAccountId: 'target-custodian' } } });
  const workspaceSyncSourceWriterTargetRouting = { v: 1 as const, source, target,
    sourceWriter: { machineId: 'physical-writer', installationId: 'physical-writer-installation' } };
  const request = { authorizationToken: 'original-child-root', effectActionId: 'session.handoff',
    target: { kind: 'machine' as const, machineId: 'source-child' }, installationId: 'physical-writer-installation',
    event: 'rpc-call' as const, method: `chosen-target:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_REPLACEMENT_PREFLIGHT}`,
    requestId: 'original-request', params: 'opaque-target-preflight', workspaceSyncSourceWriterTargetRouting };
  const signature = signExternalActionMachineRpcRequestV1({ ...request, privateKey: key.secretKey });
  expect(verifyExternalActionMachineRpcRequestV1({ ...request, signature, publicKey: key.publicKey })).toBe(true);
  for (const changedRouting of [
    { ...workspaceSyncSourceWriterTargetRouting, source: { ...source, operationId: 'another-source-loan' } },
    { ...workspaceSyncSourceWriterTargetRouting, source: { ...source, sourceRootPath: '/child/other' } },
    { ...workspaceSyncSourceWriterTargetRouting, source: { ...source, sourceContext: { ...sourceContext,
      callerInputConstraints: { models: null, permissionModes: null } } } },
    { ...workspaceSyncSourceWriterTargetRouting, target: { ...target, targetRootPath: '/foreign-target' } },
    { ...workspaceSyncSourceWriterTargetRouting, target: { ...target, operationId: 'another-target-operation' } },
    { ...workspaceSyncSourceWriterTargetRouting, target: { ...target, phase: 'release' as const } },
    { ...workspaceSyncSourceWriterTargetRouting, sourceWriter: { machineId: 'foreign-writer', installationId: 'physical-writer-installation' } },
    { ...workspaceSyncSourceWriterTargetRouting, sourceWriter: { machineId: 'physical-writer', installationId: 'replaced-writer-installation' } },
  ]) {
    const tampered = { ...request, workspaceSyncSourceWriterTargetRouting: changedRouting, signature, publicKey: key.publicKey };
    expect(verifyExternalActionMachineRpcRequestV1(tampered)).toBe(false);
  }
  const withoutPurpose = { ...request, workspaceSyncSourceWriterTargetRouting: undefined, signature, publicKey: key.publicKey };
  expect(verifyExternalActionMachineRpcRequestV1(withoutPurpose)).toBe(false);
  expect(verifyExternalActionMachineRpcRequestV1({ ...request, signature,
    publicKey: tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(20)).publicKey })).toBe(false);
});

it('binds the installed physical TARGET seed request to both retained Project snapshots', () => {
  const key = tweetnacl.sign.keyPair();
  const sourceContext = WorkspaceSyncSourceContextV1Schema.parse({ machineAdmission: { actorAccountId: 'requester',
    custodianAccountId: 'source-custodian', machineId: 'source-child', installationId: 'source-installation', role: 'use', encryptionMode: 'plain' },
    callerAuthority: 'present_user' });
  const source = { ...WorkspaceSyncSourceRoutingV1Schema.parse({ v: 1, phase: 'prepare', operationId: 'source-operation',
    accountServerId: 'home', sourceMachineId: 'source-child', sourceRootPath: '/child/source' }), sourceContext };
  const target = WorkspaceSyncTargetRoutingV1Schema.parse({ v: 1, phase: 'prepare', operationId: 'target-operation',
    accountServerId: 'home', targetMachineId: 'chosen-target', targetRootPath: '/child/target',
    targetContext: { ...sourceContext, machineAdmission: { ...sourceContext.machineAdmission,
      machineId: 'chosen-target', installationId: 'target-installation', custodianAccountId: 'target-custodian' } } });
  const { targetContext: _context, ...targetPhase } = target;
  const workspaceSyncSeedRouting = { v: 1 as const, sourceWriterTarget: { v: 1 as const, source, target: targetPhase,
    sourceWriter: { machineId: 'physical-source', installationId: 'source-writer-installation' } }, target };
  const request = { authorizationToken: 'original-project-root', effectActionId: 'projects.open',
    target: { kind: 'machine' as const, machineId: 'chosen-target' }, installationId: 'physical-target-installation',
    method: `physical-source:${RPC_METHODS.DAEMON_DIRECT_TRANSFER_EXPORT_PREPARE}`, requestId: 'seed-request', params: 'sealed-seed-request', workspaceSyncSeedRouting };
  const signature = signExternalActionMachineRpcRequestV1({ ...request, privateKey: key.secretKey });
  expect(verifyExternalActionMachineRpcRequestV1({ ...request, signature, publicKey: key.publicKey })).toBe(true);
  for (const changed of [
    { ...workspaceSyncSeedRouting, target: { ...target, targetContext: { ...target.targetContext,
      machineAdmission: { ...target.targetContext.machineAdmission, installationId: 'replaced-target' } } } },
    { ...workspaceSyncSeedRouting, sourceWriterTarget: { ...workspaceSyncSeedRouting.sourceWriterTarget,
      sourceWriter: { machineId: 'foreign-source', installationId: 'source-writer-installation' } } },
  ]) {
    const tampered = { ...request, workspaceSyncSeedRouting: changed, signature, publicKey: key.publicKey };
    expect(verifyExternalActionMachineRpcRequestV1(tampered)).toBe(false);
  }
  const withoutSeedPurpose = { ...request, workspaceSyncSeedRouting: undefined, signature, publicKey: key.publicKey };
  expect(verifyExternalActionMachineRpcRequestV1(withoutSeedPurpose)).toBe(false);
  expect(() => signExternalActionMachineRpcRequestV1({ ...request,
    method: `physical-source:${RPC_METHODS.DAEMON_DIRECT_TRANSFER_EXPORT_RELEASE}`, privateKey: key.secretKey })).toThrow();
});

it('binds a Session input authorization to actual RPC bytes rather than an invented encryption envelope', () => {
  const digestRpc = computeExternalActionSocketRpcRequestDigestV1;
  const request = { method: 'session-a:session.userMessage.send', requestId: 'rpc-a', params: 'opaque-session-ciphertext', target: { kind: 'session' as const, sessionId: 'session-a' } };
  const digest = digestRpc(request);
  expect(digest).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  for (const changed of [ { method: 'session-a:abort' }, { requestId: 'rpc-b' }, { params: 'other-ciphertext' },
    { target: { kind: 'session' as const, sessionId: 'session-b' } },
  ]) expect(digestRpc({ ...request, ...changed })).not.toBe(digest);
  expect(digestRpc({ ...request, params: { a: 1, b: 2 } })).toBe(digestRpc({ ...request, params: { b: 2, a: 1 } }));
  expect(digestRpc({ ...request, params: undefined })).not.toBe(digestRpc({ ...request, params: null }));
});

it('binds auxiliary RPC to its exact invocation, installation, correlation and opaque payload', () => {
  const key = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(9));
  const request = { authorizationToken: 'parent', effectActionId: 'session.list', target: { kind: 'machine' as const, machineId: 'machine-1' }, installationId: 'installation-1', event: 'rpc-call' as const, method: 'machine-1:read', requestId: 'rpc-1', params: 'encrypted-payload' };
  const signature = signExternalActionMachineRpcRequestV1({ ...request, privateKey: key.secretKey });
  expect(verifyExternalActionMachineRpcRequestV1({ ...request, signature, publicKey: key.publicKey })).toBe(true);
  for (const changed of [{ authorizationToken: 'other' }, { installationId: 'other' }, { event: 'other-event' as const }, { method: 'machine-2:read' }, { requestId: 'rpc-2' }, { params: 'other-ciphertext' }, { target: { kind: 'session' as const, sessionId: 'other' } }]) {
    expect(verifyExternalActionMachineRpcRequestV1({ ...request, ...changed, signature, publicKey: key.publicKey })).toBe(false);
  }
  expect(verifyExternalActionMachineRequestV1({ ...request, method: 'POST', path: request.method, body: request.params, signature, publicKey: key.publicKey })).toBe(false);
});

it('binds protected machine input admission to its own event and complete unsigned payload', () => {
  const key = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(5));
  const request = { authorizationToken: 'invocation', effectActionId: 'session.message.send',
    target: { kind: 'session' as const, sessionId: 'session-1' }, installationId: 'installation-1',
    event: 'session-pending-enqueue-by-machine-v1' as const, method: 'session-pending-enqueue-by-machine-v1',
    requestId: 'request-1', params: { v: 1, sessionId: 'session-1', targetMachineId: 'machine-1',
      localId: 'input-1', content: { t: 'encrypted', c: 'ciphertext' }, requestedAction: 'send_now' } };
  const signature = signExternalActionMachineRpcRequestV1({ ...request, privateKey: key.secretKey });
  expect(verifyExternalActionMachineRpcRequestV1({ ...request, signature, publicKey: key.publicKey })).toBe(true);
  expect(verifyExternalActionMachineRpcRequestV1({ ...request, event: 'rpc-call', signature, publicKey: key.publicKey })).toBe(false);
  expect(verifyExternalActionMachineRpcRequestV1({ ...request,
    params: { ...request.params, localId: 'input-2' }, signature, publicKey: key.publicKey })).toBe(false);
  expect(verifyExternalActionMachineRpcRequestV1({ ...request, event: 'other-event', signature, publicKey: key.publicKey })).toBe(false);
  expect(() => signExternalActionMachineRpcRequestV1({ ...request, event: 'other-event', privateKey: key.secretKey })).toThrow();
});

it('keeps approval input signatures separate from network request signatures', () => {
  const key = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(8));
  const approval = { authorizationToken: 'invocation', actionId: 'teams.archive', target: { kind: 'machine' as const, machineId: 'machine-1' }, input: { teamId: 'team-1' } };
  const signature = signExternalActionApprovalInputV1({ ...approval, privateKey: key.secretKey });
  expect(verifyExternalActionApprovalInputV1({ ...approval, signature, publicKey: key.publicKey })).toBe(true);
  expect(verifyExternalActionApprovalInputV1({ ...approval, input: { teamId: 'team-2' }, signature, publicKey: key.publicKey })).toBe(false);
  expect(verifyExternalActionMachineRequestV1({ authorizationToken: 'invocation', effectActionId: 'teams.archive', target: approval.target, installationId: 'installation-1', requestId: 'request-1', method: 'POST', path: 'teams.archive', body: approval.input, signature, publicKey: key.publicKey })).toBe(false);
});

it('binds the shared requester and Bot identity into the existing approval signature', () => {
  const key = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(31));
  const approval = { authorizationToken: 'original-bot-invocation', actionId: 'session.message.send',
    target: { kind: 'session' as const, sessionId: 'destination' }, input: { sessionId: 'destination', message: 'hello' },
    requesterConfirmation: { requestRef: 'bob-request', requesterAccountId: 'bob', executionAccountId: 'alice',
      personaSessionRef: { serverId: 'home', sessionId: 'bot-session' }, inputDigest: 'd'.repeat(43) } };
  const signature = signExternalActionApprovalInputV1({ ...approval, privateKey: key.secretKey });
  expect(verifyExternalActionApprovalInputV1({ ...approval, signature, publicKey: key.publicKey })).toBe(true);
  for (const subject of [
    { ...approval.requesterConfirmation, requesterAccountId: 'carol' },
    { ...approval.requesterConfirmation, executionAccountId: 'bob' },
    { ...approval.requesterConfirmation, requestRef: 'later-bob-request' },
    { ...approval.requesterConfirmation, personaSessionRef: { serverId: 'home', sessionId: 'another-bot' } },
    { ...approval.requesterConfirmation, inputDigest: 'e'.repeat(43) },
    undefined,
  ]) expect(verifyExternalActionApprovalInputV1({ ...approval, requesterConfirmation: subject,
    signature, publicKey: key.publicKey })).toBe(false);
});

it('binds resolved Session targets independently of an unchanged selector input', () => {
  const key = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(32));
  const approval = { authorizationToken: 'original-bot-invocation', actionId: 'session.message.send',
    target: { kind: 'session' as const, sessionId: 'bot' }, input: { sessionId: 'workers', message: 'exact write' },
    sessionTargetsV1: { actionId: 'session.message.send', field: 'sessionId', selector: true,
      targets: [{ serverId: 'home', sessionId: 'reviewed-worker' }] } };
  const signature = signExternalActionApprovalInputV1({ ...approval, privateKey: key.secretKey });
  expect(verifyExternalActionApprovalInputV1({ ...approval, signature, publicKey: key.publicKey })).toBe(true);
  expect(verifyExternalActionApprovalInputV1({ ...approval,
    sessionTargetsV1: { ...approval.sessionTargetsV1, targets: [{ serverId: 'home', sessionId: 'unreviewed-worker' }] },
    signature, publicKey: key.publicKey })).toBe(false);
});

it('binds Machine possession to the invocation and exact downstream request', () => {
  const key = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7));
  const request = { authorizationToken: 'home-authorization', effectActionId: 'teams.rename', target: { kind: 'machine' as const, machineId: 'machine-1' }, installationId: 'installation-1', requestId: 'request-1', method: 'POST', path: '/v1/teams/t/rename', body: { name: 'Acme', revision: 2 }, idempotencyKey: 'manual-retry' };
  const signature = signExternalActionMachineRequestV1({ ...request, privateKey: key.secretKey });
  expect(verifyExternalActionMachineRequestV1({ ...request, signature, publicKey: key.publicKey })).toBe(true);
  expect(verifyExternalActionMachineRequestV1({ ...request, body: { revision: 2, name: 'Acme' }, signature, publicKey: key.publicKey })).toBe(true);
  for (const changed of [
    { authorizationToken: 'other-invocation' }, { effectActionId: 'teams.archive' }, { installationId: 'installation-2' }, { requestId: 'request-2' }, { method: 'DELETE' }, { path: '/v1/teams/other/rename' }, { body: { name: 'Other', revision: 2 } },
    { target: { kind: 'machine' as const, machineId: 'machine-2' } },
    { idempotencyKey: 'another-retry' }, { idempotencyKey: undefined },
  ]) expect(verifyExternalActionMachineRequestV1({ ...request, ...changed, signature, publicKey: key.publicKey })).toBe(false);
  expect(verifyExternalActionMachineRequestV1({ ...request, signature, publicKey: tweetnacl.sign.keyPair().publicKey })).toBe(false);
  expect(verifyExternalActionMachineRequestV1({ ...request, signature: 'malformed', publicKey: key.publicKey })).toBe(false);
  const absentBody = { ...request, body: undefined };
  const absentBodySignature = signExternalActionMachineRequestV1({ ...absentBody, privateKey: key.secretKey });
  expect(verifyExternalActionMachineRequestV1({ ...absentBody, body: null, signature: absentBodySignature, publicKey: key.publicKey })).toBe(false);
});

it('binds a reviewed child to the exact Machine HTTP signature without changing ordinary request bytes', () => {
  const key = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7));
  const request = { authorizationToken: 'home-root', effectActionId: 'deployments.bindings.set',
    target: { kind: 'machine' as const, machineId: 'machine-1' }, installationId: 'installation-1',
    requestId: 'copy-root', method: 'POST', path: '/v1/deployments/environments/new/bindings', body: { revision: 1 } };
  const ordinarySignature = signExternalActionMachineRequestV1({ ...request, privateKey: key.secretKey });
  const childRequest = { ...request, reviewedChild: { actionId: 'deployments.bindings.set',
    role: 'copied-bindings', inputDigest: 'A'.repeat(43) } };
  const signature = signExternalActionMachineRequestV1({ ...childRequest, privateKey: key.secretKey });
  const encoded = encodeReviewedActionChildHttpProofV1(childRequest.reviewedChild);
  expect(decodeReviewedActionChildHttpProofV1(encoded)).toEqual(childRequest.reviewedChild);
  expect(decodeReviewedActionChildHttpProofV1(`${encoded}=`)).toBeNull();
  for (const malformed of [
    { ...childRequest.reviewedChild, input: { privateContent: 'must-not-travel' } },
    { ...childRequest.reviewedChild, inputDigest: 'not-a-digest' },
  ]) {
    expect(decodeReviewedActionChildHttpProofV1(Buffer.from(JSON.stringify(malformed)).toString('base64url'))).toBeNull();
  }
  expect(signature).not.toBe(ordinarySignature);
  expect(verifyExternalActionMachineRequestV1({ ...childRequest, signature, publicKey: key.publicKey })).toBe(true);
  expect(verifyExternalActionMachineRequestV1({ ...request, signature, publicKey: key.publicKey })).toBe(false);
  for (const changed of [
    { actionId: 'deployments.bindings.remove' }, { role: 'other-child' }, { inputDigest: 'B'.repeat(43) },
  ]) {
    expect(verifyExternalActionMachineRequestV1({ ...request,
      reviewedChild: { ...childRequest.reviewedChild, ...changed }, signature, publicKey: key.publicKey })).toBe(false);
  }
  expect(verifyExternalActionMachineRequestV1({ ...childRequest, signature: ordinarySignature, publicKey: key.publicKey })).toBe(false);
});

it('binds the exact project member of a Machine target in every signature', () => {
  const key = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(6));
  const target = { kind: 'machine' as const, machineId: 'machine-1', project: { machineId: 'machine-1', directory: '/repo/a', workspaceRefId: 'workspace-1' } };
  const request = { authorizationToken: 'home-authorization', effectActionId: 'workflow.run.start', target, installationId: 'installation-1', requestId: 'request-1', method: 'POST', path: '/v1/workflows/runs', body: {} };
  const signature = signExternalActionMachineRequestV1({ ...request, privateKey: key.secretKey });
  expect(verifyExternalActionMachineRequestV1({ ...request, signature, publicKey: key.publicKey })).toBe(true);
  expect(verifyExternalActionMachineRequestV1({ ...request, target: { ...target, project: { ...target.project, directory: '/repo/b' } }, signature, publicKey: key.publicKey })).toBe(false);

  const rpc = { ...request, event: 'rpc-call' as const, method: 'machine-1:workflow', params: {} };
  const rpcSignature = signExternalActionMachineRpcRequestV1({ ...rpc, privateKey: key.secretKey });
  expect(verifyExternalActionMachineRpcRequestV1({ ...rpc, target: { ...target, project: { ...target.project, workspaceRefId: 'workspace-2' } }, signature: rpcSignature, publicKey: key.publicKey })).toBe(false);
});

it('digests the complete original V1 or opaque V2 envelope without input disclosure', () => {
  const envelope = { v: 2 as const, requestId: 'request-1', target: { kind: 'machine' as const, machineId: 'machine-1' }, payload: { t: 'encrypted' as const, c: 'opaque-ciphertext' } };
  const digest = computeExternalActionRequestEnvelopeDigestV1(envelope);
  expect(digest).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  expect(computeExternalActionRequestEnvelopeDigestV1({ ...envelope, payload: { t: 'encrypted', c: 'other' } })).not.toBe(digest);
  expect(computeExternalActionRequestEnvelopeDigestV1({ ...envelope, requestId: 'request-2' })).not.toBe(digest);
  expect(computeExternalActionRequestEnvelopeDigestV1({ v: 1, requestId: 'request-1', target: envelope.target, input: { title: 'private' } })).not.toBe(digest);
  const projectEnvelope = { ...envelope, target: { ...envelope.target, project: { machineId: 'machine-1', directory: '/repo/a' } } };
  const projectDigest = computeExternalActionRequestEnvelopeDigestV1(projectEnvelope);
  expect(computeExternalActionRequestEnvelopeDigestV1({ ...projectEnvelope, target: { ...projectEnvelope.target, project: { ...projectEnvelope.target.project, directory: '/repo/b' } } })).not.toBe(projectDigest);
});

it('authenticates the exact reviewed-child operand proof on the existing Machine RPC signature', () => {
  const key = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(91));
  const reviewedChild = { actionId: 'deployments.domains.add', role: 'create.domain', inputDigest: 'a'.repeat(43) };
  const request = { authorizationToken: 'admitted-create-root', effectActionId: 'deployments.domains.add',
    target: { kind: 'machine' as const, machineId: 'controller' }, installationId: 'controller-installation',
    method: `receiver:${RPC_METHODS.DAEMON_DEPLOYMENT_CHILD}`, requestId: 'domain-child',
    params: 'encrypted-private-domain-input', reviewedChild };
  const signature = signExternalActionMachineRpcRequestV1({ ...request, privateKey: key.secretKey });
  expect(verifyExternalActionMachineRpcRequestV1({ ...request, publicKey: key.publicKey, signature })).toBe(true);
  const { reviewedChild: _proof, ...unsigned } = request;
  expect(verifyExternalActionMachineRpcRequestV1({ ...unsigned, publicKey: key.publicKey, signature })).toBe(false);
  for (const patch of [{ inputDigest: 'b'.repeat(43) }, { actionId: 'deployments.domains.remove' }, { role: 'other' }]) {
    expect(verifyExternalActionMachineRpcRequestV1({ ...request, reviewedChild: { ...reviewedChild, ...patch },
      publicKey: key.publicKey, signature })).toBe(false);
  }
});

it.each(['plain', 'e2ee'] as const)('binds draft DNS root references and keeps private hostname sealed (%s)', mode => {
  const actionId = 'deployments.domains.verify', target = { kind: 'machine' as const, machineId: 'controller' };
  const input = { mode: 'preview' as const, serverId: 'srv_dns', environmentId: 'environment', targetLinkId: 'runtime',
    expectedRevision: 1, expectedTargetLinkRevision: 2, requestKey: 'dns-attempt',
    content: { hostname: 'private-draft.test', target: { service: 'web', containerPort: 8080 } } };
  const envelope = mode === 'plain' ? { v: 1 as const, requestId: 'dns-root', target, input }
    : sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1,
      binding: { serverIdentityId: input.serverId, accountId: 'actor', actionId, requestId: 'dns-root', target,
        authentication: { kind: 'account', tokenEpoch: 1 } }, input,
      material: { type: 'dataKey', machineKey: new Uint8Array(32).fill(9) }, randomBytes: n => new Uint8Array(n).fill(2) });
  const deploymentNativeAdmission = projectExternalActionDeploymentNativeEnvelopeAdmissionV1({ actionId, envelope });
  expect(JSON.stringify(deploymentNativeAdmission)).not.toContain(input.content.hostname);
  if (mode === 'e2ee') expect(JSON.stringify(envelope)).not.toContain(input.content.hostname);
  const { binding } = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'dns-proof', binding: {
    accountId: 'actor', custodianAccountId: 'actor', authentication: { kind: 'account', tokenEpoch: 1 },
    serverIdentityId: input.serverId, machineId: target.machineId, installationId: 'installation', actionId,
    requestId: 'dns-root', target, accountEncryptionMode: mode, environmentId: input.environmentId, deploymentChildRoot: true,
    deploymentNativeAdmission, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
  } });
  expect(binding.deploymentCandidatePublication).toBeUndefined();
  expect(isExternalActionAuthorizationBoundToEnvelope(binding, { actionId, machineId: target.machineId, envelope })).toBe(true);
  const replacement = projectDeploymentNativeAdmissionV1(actionId, { ...input, requestKey: 'another-attempt' });
  expect(isExternalActionAuthorizationBoundToEnvelope({ ...binding, deploymentNativeAdmission: replacement },
    { actionId, machineId: target.machineId, envelope })).toBe(false);
});
