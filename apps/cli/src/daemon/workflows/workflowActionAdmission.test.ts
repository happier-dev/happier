import { afterEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import nacl from 'tweetnacl';
import { buildApprovalExecutionOriginV1, createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { EXTERNAL_ACTION_EFFECT_ACTION_HEADER, EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER,
  EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER, ExternalActionExecutionAuthorizationV1Schema,
  type ExternalActionExecutionAuthorizationV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { API_TOKEN_FULL_GRANT_V1, ApiTokenGrantV1Schema } from '@happier-dev/protocol/auth/apiTokenGrant';
import { signExternalActionApprovalInputV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { WorkflowAcceptedSnapshotV1Schema } from '@happier-dev/protocol/workflows/workflowDefinitionV1';
import { createAccountScopedCryptoMaterialSnapshotV1 } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1 } from '@happier-dev/protocol/account/encryptionKeyFingerprintV1';
import { prepareWorkflowRunDataKeyV1, type WorkflowRunReadEncryptionV1 } from '@happier-dev/protocol/workflows/workflowRunDataKeyV1';
import { sealWorkflowAcceptedSnapshotStoredEnvelopeV1, sealWorkflowProgressStoredEnvelopeV1,
  serializeWorkflowStoredContentEnvelopeV1 } from '@happier-dev/protocol/workflows/workflowStoredContentV1';
import { verifyExternalActionExecutionAuthorizationCurrent } from '@/api/externalActionExecutionAuthorization';
import { createDaemonApprovalExecutionOriginCurrentness, createDaemonExternalActionTargetResolver } from '../externalActions/daemonExternalActionTargetResolver';
import { createWorkflowActionAdmissionReader } from './workflowActionAdmission';
import { buildWorkflowActionContext, readWorkflowActionPolicyContext } from './workflowActionContext';
import { createWorkflowRunStorageClient, WORKFLOW_RUN_STORAGE_HTTP_PATH } from './workflowRunStorageClient';
import { createPlainWorkflowRunKeyCensusFixture, createWorkflowRunStorageTestkit } from './workflowRunStorage.testkit';
import type { WorkflowRunStorageOperation } from './workflowRunStorageClient';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import { createWorkflowAcceptedAuthorizationCurrentness } from './daemonRuntime';
import { createAccountEncryptionCurrentnessFixture } from '@/testkit/backends/sessionFixtures';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { accountSettingsParse } from '@happier-dev/protocol';
import { DeploymentTeardownInputV1Schema } from '@happier-dev/protocol/deployments/deploymentActionsV1';

afterEach(() => vi.restoreAllMocks());

async function pausedWorkflow(encrypted = false, dispatch = false, originalAuthorization?: ExternalActionExecutionAuthorizationV1,
  preparedContent?: Readonly<{ contentArtifactId: string; contentHeaderVersion: number; contentBodyVersion: number }>) {
  const runId = '52bd37c4-99c6-41cf-90a5-3a1be2b1e031';
  const accountId = 'owner';
  const invocationId = 'exact-child';
  const requestId = `${runId}/${invocationId}/0`;
  const actionId = 'deployments.teardown' as const;
  const actionInput = { serverId: 'home', environmentId: 'environment', targetLinkId: 'target',
    expectedRevision: 1, expectedTargetLinkRevision: 1, requestKey: 'teardown', reason: 'manual' as const, ...preparedContent };
  const definition = { version: 1, inputs: [], defaults: {}, blocks: [
    { kind: 'action', id: 'teardown', actionId, input: {} },
  ] };
  const accepted = WorkflowAcceptedSnapshotV1Schema.parse({ startedBy: 'user', authoredDefinition: definition, definition,
    materializedLeaves: [{ sourceKey: '$root', blockId: 'teardown', kind: 'action', selection: {},
      authoredWorkspace: { kind: 'inherit' }, executionTarget: { kind: 'session' }, actionId, actionInput,
      actionContract: { inputSchema: { type: 'object' }, outputSchema: {} } }],
    frozenChildren: {}, workDepth: dispatch ? 3 : 0, metadata: null, inputs: {}, machineId: 'host', executionTarget: { kind: 'session' },
    workspaceTarget: { project: { machineId: 'host', directory: '/repo', checkoutRootPath: '/repo' } },
    source: { kind: 'inline' }, origin: { kind: 'direct' },
    authorization: { admittedPermissionCeiling: 'default', principal: originalAuthorization && 'credentialId' in originalAuthorization.binding
      ? { kind: 'api', accountId, principalId: originalAuthorization.binding.principalId,
        credentialId: originalAuthorization.binding.credentialId } : { kind: 'host' },
      ...(originalAuthorization ? { externalActionExecutionAuthorization: originalAuthorization } : {}) } });
  const material = createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee',
    material: { type: 'legacy', secret: new Uint8Array(32).fill(7) } });
  const accountEncryption = { kind: 'available' as const, witness: { mode: 'e2ee' as const, version: 1,
    contentKeyFingerprint: convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(material.contentPublicKeyFingerprint) }, material };
  const preparedKey = encrypted ? prepareWorkflowRunDataKeyV1({ accountId, encryption: accountEncryption,
    randomBytes: length => new Uint8Array(length).fill(3) }) : null;
  const mode = preparedKey ? preparedKey.runCrypto : { mode: 'plain' as const };
  const encryption: WorkflowRunReadEncryptionV1 = encrypted ? accountEncryption : { witness: { mode: 'plain' } };
  const keyCensus = createPlainWorkflowRunKeyCensusFixture({ runId, accountId });
  const keyEnvelope = preparedKey?.recipientKeyEnvelopes[0]?.encryptedDataKey ?? null;
  const acceptedEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({
    ...mode, randomBytes: length => new Uint8Array(length).fill(5),
    binding: { v: 1, purpose: 'accepted_snapshot', accountId, runId }, acceptedSnapshot: accepted }));
  const storage = createWorkflowRunStorageTestkit({ runId, machineId: 'host', accountId,
    state: 'running', origin: { kind: 'direct' }, acceptedEnvelope,
    keyCensus: encrypted ? { ...keyCensus, encryptionMode: 'e2ee', ownerAccountCurrentness: accountEncryption.witness,
      dataEncryptionKey: keyEnvelope, callerDataEncryptionKey: keyEnvelope } : keyCensus });
  if (dispatch) {
    const rootEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({ ...mode,
      randomBytes: length => new Uint8Array(length).fill(6),
      binding: { v: 1, purpose: 'invocation_progress', accountId, runId, recordId: 'root', sequence: '0',
        parentRecordId: null, memberOrdinal: '0', attempt: '0' },
      progress: { kind: 'happier.workflow-progress.v1', blockKind: 'root',
        invocationPath: { blockId: '$root', scope: [] }, attempt: '0', logicalInvocationRecordId: 'root' } }));
    await storage.execute({ operation: 'initialize', runId, expectedRevision: 0,
      checkpointEnvelope: '{}', rootInvocation: { id: 'root', contentEnvelope: rootEnvelope } });
  }
  const progress = { kind: 'happier.workflow-progress.v1' as const, blockKind: 'action' as const,
    invocationPath: { blockId: 'teardown', scope: [] }, attempt: '0', logicalInvocationRecordId: invocationId,
    execution: { kind: 'action' as const, actionId, actionRequestId: requestId, localInputId: 'local', input: actionInput } };
  const contentEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({ ...mode,
    randomBytes: length => new Uint8Array(length).fill(6),
    binding: { v: 1, purpose: 'invocation_progress', accountId, runId, recordId: invocationId, sequence: '1',
      parentRecordId: 'root', memberOrdinal: '0', attempt: '0' }, progress }));
  await storage.execute({ operation: 'invocations.admit', runId, parentAttempt: 0, expectedRevision: storage.run().revision,
    checkpointEnvelope: '{}', invocations: [{ id: invocationId, sequence: '1', parentRecordId: 'root', memberOrdinal: '0', contentEnvelope }] });
  await storage.execute({ operation: 'invocations.fact', runId, invocationId, invocationAttempt: '0',
    expectedContentRevision: '0', expectedLifecycle: 'pending', lifecycle: dispatch ? 'admitting' : 'waiting_for_approval', contentEnvelope });
  if (!dispatch) await storage.execute({ operation: 'transition', runId, expectedRevision: storage.run().revision,
    state: 'paused', checkpointEnvelope: '{}' });
  // Run storage and Home verification terminate at their HTTP boundaries.
  vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
    if (url === 'https://home.example/v1/actions/deployments.teardown/execution-authorization/verify') {
      return { status: 200, data: { ok: true } };
    }
    expect(url).toBe(`https://home.example${WORKFLOW_RUN_STORAGE_HTTP_PATH}`);
    return { status: 200, data: await storage.execute(body as WorkflowRunStorageOperation) };
  });
  const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'issued-root', binding: {
    serverIdentityId: 'identity', accountId, custodianAccountId: accountId, machineId: 'host', installationId: 'installation',
    actionId, authentication: { kind: 'account', tokenEpoch: 0 }, accountEncryptionMode: encrypted ? 'e2ee' : 'plain', requestId,
    requestEnvelopeDigest: 'a'.repeat(43), target: { kind: 'machine', machineId: 'host' },
    workflowActionOrigin: { runId, requestId },
  } });
  const context = { actionRequestId: requestId, externalActionExecutionAuthorization: authorization };
  const readAdmission = createWorkflowActionAdmissionReader({
    storage: createWorkflowRunStorageClient({ token: 'account-token', serverHttpBaseUrl: 'https://home.example' }),
    resolveEncryption: async () => encryption,
  });
  return { runId, accountId, actionId, actionInput, authorization, context, readAdmission, storage, encryption };
}

describe('accepted Workflow Action approval replay', () => {
  it.each([false, true])('opens native Account replay against sealed authorization, not editable caller policy (encrypted=%s)', async encrypted => {
    const h = await pausedWorkflow(encrypted);
    const read = createWorkflowActionAdmissionReader({ storage: h.storage,
      nativeAccountId: h.accountId, resolveEncryption: async () => h.encryption });
    const context = { actionRequestId: h.context.actionRequestId, runtimeAccountId: h.accountId,
      executionRunWorkflowRunId: h.runId, actionCaller: { kind: 'workflowRun' as const, runId: h.runId,
        authorization: { admittedPermissionCeiling: 'default' as const, principal: { kind: 'host' as const } } } };
    expect(await read({ runId: h.runId, context, phase: 'approval_replay' })).not.toBeNull();
    expect(await read({ runId: h.runId, context: { ...context, actionCaller: { ...context.actionCaller,
      authorization: { ...context.actionCaller.authorization, admittedPermissionCeiling: 'yolo' } } }, phase: 'approval_replay' })).toBeNull();
    expect(await read({ runId: h.runId, context: { ...context, runtimeAccountId: 'other-account' }, phase: 'approval_replay' })).toBeNull();
  });
  it('admits a deployment leaf after its original PAT expires, while new admissions refuse it', async () => {
    const original = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'original-pat-root', binding: {
      serverIdentityId: 'identity', accountId: 'owner', principalId: 'owner', credentialId: 'expired-pat',
      grant: API_TOKEN_FULL_GRANT_V1, custodianAccountId: 'owner', machineId: 'host', installationId: 'installation',
      actionId: 'deployments.teardown', requestId: 'original-request', requestEnvelopeDigest: 'a'.repeat(43),
      target: { kind: 'machine', machineId: 'host' },
    } });
    const h = await pausedWorkflow(false, true, original, {
      contentArtifactId: 'prepared-teardown', contentHeaderVersion: 1, contentBodyVersion: 1,
    });
    DeploymentTeardownInputV1Schema.parse(h.actionInput);
    const credentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: 'owner', tokenEpoch: 0 })).toString('base64url')}.signature`,
      encryption: null, credentialProvenance: 'stored_session' as const };
    const isCurrent = createWorkflowAcceptedAuthorizationCurrentness({ accountId: 'owner',
      // This is the Account token inventory transport boundary. The real
      // evaluator must still refuse this credential for a new admission.
      listAccountApiTokens: async () => ({ tokens: [{ tokenId: 'expired-pat', label: 'Original',
        displayPrefix: 'hap_v1_test', expiresAt: '2000-01-01T00:00:00.000Z', createdAt: '1999-01-01T00:00:00.000Z',
        lastUsedAt: null, hasEncryptionAccess: false, hasUnattendedTeamAccess: false,
        parentTokenId: null, activeChildCount: 0, embedConfig: null, grant: API_TOKEN_FULL_GRANT_V1 }] }),
      resolveCurrentPluginOccurrenceId: async () => null,
      isMediatedSourceCurrent: async () => false });
    const admission = await h.readAdmission({ runId: h.runId, context: h.context });
    if (!admission) throw new Error('Expected admitted deployment leaf');
    expect(await isCurrent({ authorization: admission.accepted.authorization })).toBe(false);
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      expect(url).toBe('https://home.example/v1/account/encryption/currentness');
      return { status: 200, data: createAccountEncryptionCurrentnessFixture({ mode: 'plain' }) };
    });
    const deploymentRequest = vi.spyOn(axios, 'request').mockImplementation(async config => {
      const url = new URL(config.url!);
      expect(url.origin + url.pathname).toBe('https://home.example/v1/deployments/environments/environment');
      expect(url.searchParams.get('serverId')).toBe('identity');
      expect(config.method).toBe('GET');
      expect(config.headers).toMatchObject({
        [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: h.authorization.token,
        [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: 'deployments.environments.get',
        [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: expect.any(String),
      });
      return { status: 404, data: { ok: false, error: 'deployment_unavailable' } };
    });
    const executor = createCliActionExecutorFromCredentials({ credentials,
      serverId: 'home', serverIdentityId: 'identity', serverApiUrl: 'https://home.example',
      externalActionMachineInstallationId: 'installation',
      externalActionMachineRequestPrivateKey: nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(9)).secretKey,
      pluginActionExecutionOwner: 'current_process', workflowAcceptedAuthorizationCurrentness: isCurrent,
      actionsSettingsProvider: createActionSettingsProvider({ accountSettings: accountSettingsParse({
        actionsSettingsV1: { v: 1, approvalWaivedSurfaces: { 'deployments.teardown': ['agent'] } },
      }) }) });
    const context = { ...h.context, surface: 'agent' as const, authority: 'account_automation' as const,
      serverId: 'home', serverIdentityId: 'identity', runtimeAccountId: 'owner',
      externalActionTarget: h.authorization.binding.target };
    // The real deployment owner reads the exact environment for approval scope.
    // Its Home refusal proves the admitted leaf crossed the signed HTTP boundary.
    expect(await executor.execute(h.actionId, h.actionInput, context))
      .toMatchObject({ ok: false, errorCode: 'deployment_unavailable' });
    expect(deploymentRequest).toHaveBeenCalledTimes(1);
    expect(await executor.execute(h.actionId, { ...h.actionInput, environmentId: 'another-environment' }, context))
      .toMatchObject({ ok: false, errorCode: 'admission_unavailable' });
    expect(await executor.execute(h.actionId, h.actionInput, { ...context,
      externalActionExecutionAuthorization: { ...h.authorization, binding: { ...h.authorization.binding, accountId: 'another-account' } },
    })).toMatchObject({ ok: false, errorCode: 'admission_unavailable' });
    await h.storage.execute({ operation: 'transition', runId: h.runId,
      expectedRevision: h.storage.run().revision, state: 'cancelled', checkpointEnvelope: '{}' });
    expect(await executor.execute(h.actionId, h.actionInput, context))
      .toMatchObject({ ok: false, errorCode: 'admission_unavailable' });
    expect(deploymentRequest).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])('retains the PAT root and grant through accepted storage and local invocation (encrypted=%s)', async encrypted => {
    const grant = ApiTokenGrantV1Schema.parse({ ...API_TOKEN_FULL_GRANT_V1,
      actions: { families: [], ids: ['machines.setup.plan'] } });
    const original = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'original-pat-root', binding: {
      serverIdentityId: 'identity', accountId: 'owner', principalId: 'owner', credentialId: 'pat', grant,
      custodianAccountId: 'owner', machineId: 'host', installationId: 'installation',
      actionId: 'machines.setup.plan', requestId: 'original-request', requestEnvelopeDigest: 'a'.repeat(43),
      target: { kind: 'machine', machineId: 'host' },
    } });
    const h = await pausedWorkflow(encrypted, true, original);
    // Read the sealed accepted snapshot first; a process restart has no private requester functions.
    const restored = await h.readAdmission({ runId: h.runId, context: h.context });
    expect(restored).not.toBeNull();
    if (!restored) throw new Error('Expected persisted Workflow admission');
    const context = { ...buildWorkflowActionContext({ runId: h.runId,
      authorization: restored.accepted.authorization }), actionRequestId: h.context.actionRequestId };
    expect(context.externalActionExecutionAuthorization).toEqual(original);
    expect(context.externalActionCredential).toEqual({ accountId: 'owner', principalId: 'owner', credentialId: 'pat', grant });
    expect(context.externalActionTarget).toEqual(original.binding.target);
    expect(context.runtimeAccountId).toBe('owner');
    expect(await createActionExecutor({}).execute(h.actionId, h.actionInput, context))
      .toMatchObject({ ok: false, errorCode: 'credential_scope_denied' });
    expect(await h.readAdmission({ runId: h.runId, context })).not.toBeNull();
    expect(await h.readAdmission({ runId: h.runId, context: { ...context,
      externalActionExecutionAuthorization: { ...original, token: 'another-root' } } })).toBeNull();
    expect(() => buildWorkflowActionContext({ runId: h.runId, authorization: {
      admittedPermissionCeiling: 'default', principal: { kind: 'api', accountId: 'owner', principalId: 'owner', credentialId: 'pat' },
    } })).toThrow('run_access_denied');
  });

  it.each([false, true])('restores protected Session input from the admitted invocation (encrypted=%s)', async encrypted => {
    const h = await pausedWorkflow(encrypted, true);
    const admission = await h.readAdmission({ runId: h.runId, context: h.context });
    expect(admission).not.toBeNull();
    if (!admission) throw new Error('Expected admitted Workflow invocation');
    const policy = await readWorkflowActionPolicyContext({ admission, actionId: h.actionId,
      input: h.actionInput, context: h.context });
    expect(policy?.workflowSessionInput).toEqual({ purpose: 'invocation', runId: h.runId,
      invocationRecordId: 'exact-child', workDepth: 3 });
    expect(await readWorkflowActionPolicyContext({ admission, actionId: h.actionId,
      input: { ...h.actionInput, environmentId: 'other' }, context: h.context })).toBeNull();
  });

  it.each([false, true])('opens an exact paused invocation only for signed approval replay (encrypted=%s)', async encrypted => {
    const h = await pausedWorkflow(encrypted);
    expect(await h.readAdmission({ runId: h.runId, context: h.context })).toBeNull();
    const admission = await h.readAdmission({ runId: h.runId, context: h.context, phase: 'approval_replay' });
    expect(admission?.accepted.authorization.admittedPermissionCeiling).toBe('default');
    expect((await admission?.readActionInvocation('approval_replay'))?.progress.execution)
      .toMatchObject({ actionId: h.actionId, actionRequestId: h.context.actionRequestId });
    expect(await h.readAdmission({ runId: h.runId, phase: 'approval_replay', context: {
      actionRequestId: h.context.actionRequestId, executionRunWorkflowRunId: h.runId,
      actionCaller: { kind: 'workflowRun', runId: h.runId,
        authorization: { admittedPermissionCeiling: 'default', principal: { kind: 'host' } } },
    } })).toBeNull();
  });

  it('compares signed host replay against the accepted ceiling rather than editable approval content', async () => {
    const h = await pausedWorkflow();
    const keys = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(19));
    const origin = buildApprovalExecutionOriginV1({ actionId: h.actionId, input: h.actionInput, targetSessionId: null,
      context: { ...h.context, surface: 'agent', authority: 'account_automation', actionCaller: { kind: 'host' },
        serverId: 'home', serverIdentityId: 'identity', runtimeAccountId: h.accountId, callerPermissionMode: 'default',
        externalActionTarget: { kind: 'machine', machineId: 'host' },
        signExternalActionApprovalInput: ({ actionId, input, target }) => signExternalActionApprovalInputV1({
          authorizationToken: h.authorization.token, actionId, input, target, privateKey: keys.secretKey }) } });
    if (!origin) throw new Error('Expected canonical signed approval origin');
    const current = createDaemonApprovalExecutionOriginCurrentness({ accountId: h.accountId, machineId: 'host', serverId: 'home',
      resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId: 'identity', machineId: 'host' }),
      resolveTarget: createDaemonExternalActionTargetResolver({ credentials: { token: 'account-token', encryption: null } }),
      isAccountCurrent: async () => true,
      listAccountApiTokens: async () => ({ tokens: [] }), externalActionMachinePublicKey: keys.publicKey,
      verifyExternalExecutionAuthorization: args => verifyExternalActionExecutionAuthorizationCurrent({ ...args,
        privateKey: keys.secretKey, installationId: 'installation', serverHttpBaseUrl: 'https://home.example' }),
      readWorkflowActionAdmission: h.readAdmission });
    const beforeReplay = h.storage.operations().length;
    expect(await current({ origin, actionInput: h.actionInput })).toBe(true);
    expect(h.storage.operations().slice(beforeReplay)).toEqual(['get', 'invocations.get']);
    expect(await current({ origin: { ...origin, callerPermissionMode: 'yolo' }, actionInput: h.actionInput })).toBe(false);
    expect(await current({ origin, actionInput: { ...h.actionInput, environmentId: 'other' } })).toBe(false);
  });
});
