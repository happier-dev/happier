import { expect, it, onTestFinished, vi } from 'vitest';
import axios from 'axios';
import tweetnacl from 'tweetnacl';
import { ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { computeActionInputApprovalDigestV1 } from '@happier-dev/protocol/actions/decisionAuthority';
import { projectDeploymentNativeAdmissionV1 } from '@happier-dev/protocol/deployments/deploymentCandidatePublicationV1';
import { BACKUP_RECEIVER_SETUP_CHILDREN_V1 } from '@happier-dev/protocol/machines/managed/actionIdsV1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { createHostReviewedChildPortV1, readHostAdmittedReviewedChildV1 } from '@happier-dev/protocol/actions/executor/deploymentRoleChild';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { SESSION_PROJECT_FILES_OPEN_CHILDREN_V1, buildSessionProjectFilesSourceOpenInputV1 } from '@happier-dev/protocol/sessions/creation/sessionProjectFilesOpenV1';
import { SessionSpawnNewInputV2Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewInputV2';
import { admitRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionProjection';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';
import { createExternalActionSourceMachineRpcExecution, isReviewedMachineRpcChild, projectExternalActionRequesterHttpAuthorization } from './externalActionExecutionAuthorization';

// The receiver opens forwarded custody after the seal owner admitted the recipient;
// its HTTP projection must not re-decide (and narrow) that family list.
it.each(['deployments.backups.configure', 'projects.setup.set'] as const)(
  'projects receiver HTTP custody for a forwarded %s child the seal owner admitted', async rootActionId => {
    const homeId = 'srv_home';
    const target = { kind: 'machine' as const, machineId: 'source' };
    const rootInput = { serverId: homeId, environmentId: 'environment', expectedRevision: 3, intent: 'test' as const,
      destinationSetup: { kind: 'anotherMachine' as const, machineId: 'receiver', expectedInstallationId: 'receiver-installation', receiverInputs: {} },
      configuration: { configRevision: 1, destinationRef: { pluginId: 'happier.backup.local', localId: 'open' }, occurrenceId: 'destination',
        config: { path: '/private/repository' }, credentialBindings: [],
        sources: [{ kind: 'dump' as const, sourceId: 'database', service: 'postgres', consistency: 'logical' as const }],
        ownership: { environmentId: 'environment', prefix: 'owner-prefix' }, retention: { kind: 'keepEverything' as const } } };
    const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'home-root', binding: {
      accountId: 'person', custodianAccountId: 'person', authentication: { kind: 'account', tokenEpoch: 1 },
      accountEncryptionMode: 'plain', serverIdentityId: homeId, machineId: 'source', installationId: 'source-installation',
      actionId: rootActionId, requestId: 'root-request', requestEnvelopeDigest: 'A'.repeat(43), target,
      ...(rootActionId === 'deployments.backups.configure' ? { environmentId: 'environment',
        deploymentNativeAdmission: projectDeploymentNativeAdmissionV1(rootActionId, rootInput) } : {}),
    } });
    const params = { homeId, machineId: 'receiver' };
    const projected = await projectExternalActionRequesterHttpAuthorization({ authorization, serverId: homeId,
      serverIdentityId: homeId, serverHttpBaseUrl: 'https://home.invalid', target, installationId: 'receiver-installation',
      privateKey: tweetnacl.sign.keyPair().secretKey, isCurrent: async () => true,
      forwardedMove: { credentials: { token: 'person-private', encryption: null }, isCurrent: async () => true,
        method: RPC_METHODS.MACHINE_SETUP_PLAN, reviewedChild: { actionId: 'machines.setup.plan',
          role: BACKUP_RECEIVER_SETUP_CHILDREN_V1.plan.role, inputDigest: computeActionInputApprovalDigestV1('machines.setup.plan', params) } } });
    expect(projected?.binding).toEqual(authorization.binding);
    // Without a forwarded child the receiver still has no custody for another installation's root.
    expect(await projectExternalActionRequesterHttpAuthorization({ authorization, serverId: homeId,
      serverIdentityId: homeId, serverHttpBaseUrl: 'https://home.invalid', target, installationId: 'receiver-installation',
      privateKey: tweetnacl.sign.keyPair().secretKey, isCurrent: async () => true })).toBeNull();
  });

it('scopes forwarded session_project_files_source custody to exact source attach and refuses unauthorized paths or tampered operands', async () => {
  const homeId = 'srv_home';
  const controllerTarget = { kind: 'machine' as const, machineId: 'controller' };
  const spawnInput = SessionSpawnNewInputV2Schema.parse({
    executionTarget: { serverId: homeId, machineId: 'controller' },
    directory: { kind: 'path', path: '/boat/project' },
    agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
    sessionPlacement: {
      kind: 'machine',
      target: { serverId: homeId, machineId: 'controller' },
      projectFilesSource: { target: { serverId: homeId, machineId: 'boat' }, directory: '/boat/project' },
      projectFiles: { kind: 'copy_once' },
    },
  });
  const sourceOpenInput = buildSessionProjectFilesSourceOpenInputV1(spawnInput.sessionPlacement!)!;
  const envelope = { v: 1 as const, requestId: 'spawn-request', target: controllerTarget, input: spawnInput };
  const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({
    v: 1, token: 'home-root', binding: {
      accountId: 'person', custodianAccountId: 'person', authentication: { kind: 'account', tokenEpoch: 1 },
      accountEncryptionMode: 'plain', serverIdentityId: homeId, machineId: 'controller',
      installationId: 'controller-installation', actionId: 'session.spawn_new', requestId: 'spawn-request',
      requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope), target: controllerTarget,
    },
  });
  const reviewedChild = {
    actionId: SESSION_PROJECT_FILES_OPEN_CHILDREN_V1.source.action,
    role: SESSION_PROJECT_FILES_OPEN_CHILDREN_V1.source.role,
    inputDigest: computeActionInputApprovalDigestV1('projects.open', sourceOpenInput),
  };

  // Receiver HTTP projection on Boat: allows only Project Open attach Account endpoints, refuses everything else.
  const projected = await projectExternalActionRequesterHttpAuthorization({
    authorization, serverId: homeId, serverIdentityId: homeId, serverHttpBaseUrl: 'https://home.invalid',
    target: controllerTarget, installationId: 'boat-installation', privateKey: tweetnacl.sign.keyPair().secretKey,
    isCurrent: async () => true,
    forwardedMove: {
      credentials: { token: 'person-private', encryption: null }, isCurrent: async () => true,
      method: RPC_METHODS.PROJECTS_OPEN, reviewedChild,
    },
  });
  expect(projected?.requesterHttpProjection).toBeDefined();
  const headers = (method: string, path: string, effectActionId = 'projects.open') =>
    projected!.requesterHttpProjection!.createRequestHeaders({ method, path, effectActionId });
  expect(await headers('GET', '/v1/account/encryption')).toEqual({ Authorization: 'Bearer person-private' });
  expect(await headers('POST', '/v1/account/project-rows/list')).toEqual({ Authorization: 'Bearer person-private' });
  expect(await headers('POST', '/v1/account/project-rows/mutate')).toEqual({ Authorization: 'Bearer person-private' });
  expect(await headers('POST', '/v2/sessions')).toBeNull();
  expect(await headers('POST', '/v1/artifacts')).toBeNull();
  expect(await headers('GET', '/v1/machines/other')).toBeNull();
  expect(await headers('POST', '/v1/account/project-rows/mutate', 'session.spawn_new')).toBeNull();

  // Sender signing + receiver operand verification: admits exact reviewed child, refuses tampered operands.
  let admittedContext: Record<string, unknown> | undefined;
  const port = createHostReviewedChildPortV1({
    actionId: 'session.spawn_new', input: spawnInput, reviewAdmitted: true,
    context: { runtimeAccountId: 'person', externalActionExecutionAuthorization: authorization, externalActionTarget: controllerTarget },
    plan: { children: [{ ...SESSION_PROJECT_FILES_OPEN_CHILDREN_V1.source, input: sourceOpenInput }] },
    policies: [{ ...SESSION_PROJECT_FILES_OPEN_CHILDREN_V1.source, surface: 'cli' }],
    execute: async (_input, childContext) => { admittedContext = childContext as Record<string, unknown>; return { ok: true, result: null }; },
  });
  expect(await port.invoke({ ...SESSION_PROJECT_FILES_OPEN_CHILDREN_V1.source, input: sourceOpenInput })).toEqual({ ok: true, result: null });
  expect(readHostAdmittedReviewedChildV1(admittedContext)).toMatchObject(reviewedChild);

  const key = tweetnacl.sign.keyPair().secretKey;
  expect(createExternalActionSourceMachineRpcExecution({
    context: admittedContext, authorization, effectActionId: 'projects.open', target: controllerTarget,
    sourceMachineId: 'controller', sourceInstallationId: 'controller-installation',
    method: `boat:${RPC_METHODS.PROJECTS_OPEN}`, requestId: 'req-1', params: sourceOpenInput, privateKey: key,
  })).not.toBeNull();
  expect(createExternalActionSourceMachineRpcExecution({
    context: { runtimeAccountId: 'person' }, authorization, effectActionId: 'projects.open', target: controllerTarget,
    sourceMachineId: 'controller', sourceInstallationId: 'controller-installation',
    method: `boat:${RPC_METHODS.PROJECTS_OPEN}`, requestId: 'req-1', params: sourceOpenInput, privateKey: key,
  })).toBeNull();

  const currentness = await createRequesterCurrentnessSocketHarness();
  onTestFinished(async () => { vi.restoreAllMocks(); await currentness.close(); });
  vi.spyOn(axios, 'get').mockImplementation(async url => {
    if (url === 'https://home.invalid/v1/account/profile') return { status: 200, data: { id: 'person' } };
    if (url === 'https://home.invalid/v2/account/settings') return { status: 200, data: { content: { t: 'plain', v: {} }, version: 1 } };
    return { status: 200, data: { mode: 'plain', version: 1, settingsVersion: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
  });
  vi.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: { ok: true } });
  const admitted = await admitRequesterAccountActionContext({
    authorization, serverIdentityId: homeId, serverId: homeId,
    credentials: { token: 'person-private', encryption: null },
    serverHttpBaseUrl: 'https://home.invalid', isCurrent: async () => true,
  });
  if (!admitted) throw new Error('Requester custody was not established');
  onTestFinished(() => admitted.dispose());
  expect(await isReviewedMachineRpcChild('session_project_files_source', {
    authorization: admitted.authorization, envelope, actionId: 'projects.open', machineId: 'boat', params: sourceOpenInput,
    method: RPC_METHODS.PROJECTS_OPEN, reviewedChild,
  })).toBe(true);
  expect(await isReviewedMachineRpcChild('session_project_files_source', {
    authorization: admitted.authorization, envelope, actionId: 'projects.open', machineId: 'boat',
    params: { ...sourceOpenInput, source: { kind: 'folder', path: '/boat/tampered' } },
    method: RPC_METHODS.PROJECTS_OPEN, reviewedChild,
  })).toBe(false);
  expect(await isReviewedMachineRpcChild('session_project_files_source', {
    authorization: admitted.authorization, envelope, actionId: 'projects.open', machineId: 'elsewhere',
    params: { ...sourceOpenInput, machineId: 'elsewhere' },
    method: RPC_METHODS.PROJECTS_OPEN, reviewedChild,
  })).toBe(false);
});
