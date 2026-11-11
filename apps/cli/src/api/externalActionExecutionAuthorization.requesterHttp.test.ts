import { openManagedControllerActionCodecV1, openExternalActionRequesterAccountContextV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { SESSION_SPAWN_MACHINE_SETUP_CHILDREN_V1 } from '@happier-dev/protocol/machines/managed/actionIdsV1';
import { ExternalActionRequestEnvelopeV2Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { projectExternalActionMachineRuntimeDemandV1 } from '@happier-dev/protocol/actions/actionSpecs';
import axios from 'axios';
import fastify from 'fastify';
import nacl from 'tweetnacl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { API_TOKEN_FULL_GRANT_V1, MachineSetupApplyInputV1Schema, accountSettingsParse, createRoleSourceReaderV1 } from '@happier-dev/protocol';
import { createActionExecutor, type ActionExecutorContext } from '@happier-dev/protocol/actions';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER, EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER,
  ExternalActionExecutionAuthorizationV1Schema, ExternalActionExecutionAuthorizationRequestV1Schema,
  projectExternalActionPendingResetStartAdmissionV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { projectExternalActionHttpError } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1, verifyExternalActionMachineRequestV1, verifyExternalActionMachineRpcRequestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import * as executionAuthorizationOwner from './externalActionExecutionAuthorization';
import { createSessionListActionDeps } from '@/session/actions/sessionListActionDependency';
import { openExternalActionRequestV2, sealExternalActionRequestV2 } from '@happier-dev/protocol/actions/externalActionEncryption';
import { projectDeploymentReadAdmissionV1, projectDeploymentPreparationAdmissionV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { deriveAccountMachineKeyFromRecoverySecret, openAccountScopedBlobCiphertext } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { executeExternalAction } from '@/daemon/externalActions/executeExternalAction';
import { createDaemonExternalActionTargetResolver } from '@/daemon/externalActions/daemonExternalActionTargetResolver';
import { prepareExternalActionRequesterAccountAuthorization, verifyExternalActionExecutionAuthorizationCurrent } from './externalActionExecutionAuthorization';
import { MachineInstallationProofV1Schema, verifyMachineInstallationProof } from '@happier-dev/protocol/machines/identity/installationIdentity';
import { SessionActionRpcOriginV1Schema, SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { logger } from '@/ui/logger';
import { createDaemonPatVerifier } from '@/daemon/auth/daemonPatVerifier';
import { registerDaemonExternalActionRoute } from '@/daemon/externalActions/registerDaemonExternalActionRoute';
import { resolveCliAgentStartContextV1 } from '@/session/actions/resolveCliAgentStartContextV1';
import { invokeHostReviewedChildV1 } from '@happier-dev/protocol/actions/actionExecutor';
import { computeActionInputApprovalDigestV1 } from '@happier-dev/protocol/actions/decisionAuthority';
import { deriveMachineSetupCombinedRunIdV1 } from '@happier-dev/protocol/workflows/workflowInvocationIdentityV1';
import { WORKFLOW_RUN_STORAGE_HTTP_PATH } from '@/daemon/workflows/workflowRunStorageClient';
import { BOT_TEMPLATE_SETUP_APPLY_ROLE_V1 } from '@happier-dev/protocol/bots/templates/botTemplateActionIdsV1';

const keys = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(18));
// Only the Home HTTP boundary is mocked; exercise the real local provenance reader.
const encodeTokenPart = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
const accountToken = `${encodeTokenPart({ alg: 'none' })}.${encodeTokenPart({
  sub: 'bob', tokenEpoch: 7, provenance: { v: 1, kind: 'account', authority: 'present_user' },
})}.signature`;
const target = { kind: 'machine' as const, machineId: 'alice-machine' };
const envelope = { v: 1 as const, requestId: 'bob-open', target, input: { message: 'Opened' } };
const principal = { accountId: 'bob', principalId: 'bob', credentialId: 'bob-service',
  grant: API_TOKEN_FULL_GRANT_V1, authority: 'account_automation' as const };
const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({
  v: 1, token: 'bob-home-proof', binding: {
    accountId: 'bob', principalId: 'bob', credentialId: 'bob-service', grant: principal.grant,
    serverIdentityId: 'srv_bob_home', machineId: target.machineId, custodianAccountId: 'alice',
    installationId: 'alice-installation', actionId: 'notifications.notify_me', requestId: envelope.requestId,
    target, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope), accountEncryptionMode: 'plain',
  },
});

describe('requester HTTP authority on the existing external Action carrier', () => {
  it.each([
    ['external_credential_without_authorization', { context: { externalActionCredential: principal } }],
    ['signing_key_missing', { privateKey: undefined }],
    ['installation_id_missing', { installationId: undefined }],
    ['target_missing', { context: { externalActionExecutionAuthorization: authorization } }],
    ['dependency_home_identity_mismatch', { serverIdentityId: 'another-home' }],
  ] as const)('retains the missing header fact: %s', (reason, change) => {
    const result = executionAuthorizationOwner.resolveExternalActionServerRequestHeaders({
      context: { externalActionExecutionAuthorization: authorization, externalActionTarget: target },
      effectActionId: authorization.binding.actionId, method: 'GET', path: '/v1/account/encryption/currentness',
      daemonToken: 'private-daemon-token', privateKey: keys.secretKey,
      installationId: 'alice-installation', serverIdentityId: 'srv_bob_home', ...change,
    });
    expect(result).toMatchObject({ ok: false, reason, requestId: expect.any(String) });
    expect(JSON.stringify(result)).not.toContain('private-daemon-token');
    expect(JSON.stringify(result)).not.toContain(authorization.token);
  });

  it('carries the header refusal and correlation through a real Session Action failure', async () => {
    const log = vi.spyOn(logger, 'infoFile');
    const sessionTarget = { kind: 'session' as const, sessionId: 'c000000000000000000000011' };
    const sessionAuthorization = ExternalActionExecutionAuthorizationV1Schema.parse({ ...authorization,
      binding: { ...authorization.binding, actionId: 'session.list', target: sessionTarget },
    });
    const executor = createActionExecutor(createSessionListActionDeps({
      credentials: { token: accountToken, encryption: null },
      serverIdentityId: 'srv_bob_home', serverId: 'bob-profile', serverHttpBaseUrl: 'https://bob-home.test',
    }));
    const result = await executor.execute('session.list', {}, {
      surface: 'cli',
      externalActionExecutionAuthorization: sessionAuthorization, externalActionTarget: sessionTarget,
    });
    expect(result).toMatchObject({ error: 'External Action authorization unavailable: signing_key_missing' });
    expect(result).toMatchObject({ ok: false, requestId: authorization.binding.requestId,
      effectAttempted: false, details: { authorizationRefusalReason: 'signing_key_missing' } });
    expect(log.mock.calls.filter(([message]) => message === '[ExternalAction] Header authorization refused'))
      .toEqual([['[ExternalAction] Header authorization refused', {
        reason: 'signing_key_missing', requestId: authorization.binding.requestId,
      }]]);
  });

  it('returns no Template parent without private child admission', () => {
    expect(executionAuthorizationOwner.readAdmittedBotTemplateParentActionIdV1(undefined)).toBeNull();
    expect(executionAuthorizationOwner.readAdmittedBotTemplateParentActionIdV1({ surface: 'api', authority: 'account_automation' })).toBeNull();
  });

  it.each([{ accountEncryptionMode: 'plain' as const, custodianAccountId: 'alice', terminalTransport: false },
    { accountEncryptionMode: 'e2ee' as const, custodianAccountId: 'bob', terminalTransport: false },
    { accountEncryptionMode: 'e2ee' as const, custodianAccountId: 'bob', terminalTransport: true }])('delivers only invocation codec for reviewed setup ($accountEncryptionMode)', async ({ accountEncryptionMode, custodianAccountId, terminalTransport }) => {
    const requestId = crypto.randomUUID();
    const parent = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'captured-parent', binding: {
      accountId: 'bob', authentication: { kind: 'account', tokenEpoch: 7 }, serverIdentityId: 'srv_bob_home',
      machineId: target.machineId, custodianAccountId, installationId: 'alice-installation',
      actionId: 'session.spawn_new', requestId: crypto.randomUUID(), target, admittedMachineRole: 'manage',
      accountEncryptionMode, requestEnvelopeDigest: 'a'.repeat(43),
    } });
    const childInput = MachineSetupApplyInputV1Schema.parse({ homeId: 'srv_bob_home', machineId: target.machineId,
      targets: [{ homeId: 'srv_bob_home', machineId: target.machineId, desiredRevision: 0, recipePlans: [],
        sources: [{ kind: 'direct', setup: { items: [] } }] }] });
    const reviewedChild = { actionId: SESSION_SPAWN_MACHINE_SETUP_CHILDREN_V1.apply.action,
      role: SESSION_SPAWN_MACHINE_SETUP_CHILDREN_V1.apply.role,
      inputDigest: computeActionInputApprovalDigestV1('machines.setup.apply', childInput) };
    const runId = deriveMachineSetupCombinedRunIdV1({ homeId: 'srv_bob_home', accountId: 'bob',
      requestId: parent.binding.requestId, reviewedChild });
    const context = { surface: 'agent', authority: 'account_automation', actionRequestId: requestId,
      executionRunWorkflowRunId: runId, actionCaller: { kind: 'workflowRun', runId, authorization: {
        principal: { kind: 'host' }, admittedPermissionCeiling: 'default',
        externalActionExecutionAuthorization: parent, reviewedChild,
      } } } satisfies ActionExecutorContext;
    vi.spyOn(axios, 'get').mockImplementation(async () => { throw new Error('No fresh Account or Machine lookup for admitted setup'); });
    let delivered = false;
    vi.spyOn(axios, 'post').mockImplementation(async (url, raw) => {
      if (String(url).endsWith('/verify')) return { status: 200, data: { ok: true } };
      const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(raw);
      if (String(url).endsWith('/execution-authorization')) {
        expect(request.executionAuthorization).toEqual(parent);
        expect(request.workflowActionOrigin).toEqual({ runId, requestId, reviewedChild });
        return { status: 200, data: { v: 1, token: 'scoped-setup-leaf', binding: {
          ...parent.binding, actionId: 'machines.setup.apply', requestId,
          workflowActionOrigin: request.workflowActionOrigin,
          deploymentPreparationAdmission: projectDeploymentPreparationAdmissionV1('machines.setup.apply', childInput),
          requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(request.envelope),
        } } };
      }
      delivered = true;
      const opening = { authorization: request.executionAuthorization, machineId: target.machineId,
        installationId: 'alice-installation', serverIdentityId: 'srv_bob_home', installationPrivateKey: keys.secretKey };
      const codec = openManagedControllerActionCodecV1(opening);
      expect(codec?.machineKey).toHaveLength(32);
      if (request.envelope.v === 2) expect(openExternalActionRequestV2({
        projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, envelope: request.envelope,
        binding: { serverIdentityId: parent.binding.serverIdentityId, accountId: parent.binding.accountId,
          authentication: { kind: 'account', tokenEpoch: 7 }, actionId: 'machines.setup.apply', requestId, target },
        material: codec!,
      })?.input).toEqual(childInput);
      expect(codec?.machineKey).not.toEqual(new Uint8Array(32).fill(57));
      expect(openExternalActionRequesterAccountContextV1({ ...opening, purpose: { kind: 'external_action' } })).toBeNull();
      expect(request.executionAuthorization?.binding).toMatchObject({ accountId: 'bob', custodianAccountId,
        admittedMachineRole: 'manage', installationId: 'alice-installation' });
      return { status: 409, data: { error: 'invalid_request', code: 'target_unavailable' } };
    });
    expect(await executionAuthorizationOwner.dispatchOriginalAccountAction({ actionId: 'machines.setup.apply',
      input: childInput, requestId, target, credentials: { token: terminalTransport ? `${encodeTokenPart({ alg: 'none' })}.${encodeTokenPart({
        sub: 'bob', tokenEpoch: 7, provenance: { v: 1, kind: 'terminal', authority: 'account_automation' },
      })}.signature` : accountToken, encryption: accountEncryptionMode === 'plain' ? null : {
        type: 'dataKey', machineKey: new Uint8Array(32).fill(57), publicKey: keys.publicKey } },
      serverHttpBaseUrl: 'https://home.test', serverIdentityId: 'srv_bob_home',
      installedWorkflow: { context, machineId: target.machineId, installationId: 'alice-installation', privateKey: keys.secretKey },
    })).toMatchObject({ ok: false, errorCode: 'target_unavailable' });
    expect(delivered).toBe(true);
  });

  it.each([
    ...[
    { mode: 'plain' as const, publisher: 'alice', denial: 'none' },
    { mode: 'e2ee' as const, publisher: 'alice', denial: 'none' },
    { mode: 'e2ee' as const, publisher: 'bob', denial: 'none' },
    { mode: 'e2ee' as const, publisher: 'alice', denial: 'grant' },
    { mode: 'e2ee' as const, publisher: 'alice', denial: 'revoked' },
    { mode: 'e2ee' as const, publisher: 'alice', denial: 'credential_substitution' },
    { mode: 'e2ee' as const, publisher: 'alice', denial: 'grant_substitution' },
    ].map(row => ({ ...row, origin: 'spawn' as const })),
    { mode: 'plain' as const, publisher: 'alice', denial: 'none', origin: 'direct' as const },
    { mode: 'e2ee' as const, publisher: 'alice', denial: 'none', origin: 'direct' as const },
    { mode: 'e2ee' as const, publisher: 'alice', denial: 'none', origin: 'template' as const },
  ])('preserves retained PAT setup authority and only its invocation codec ($mode/$publisher/$denial/$origin)', async ({ mode, publisher, denial, origin }) => {
    const requestId = crypto.randomUUID();
    const credentialId = crypto.randomUUID();
    const rootActionId = origin === 'direct' ? 'machines.setup.apply' : origin === 'template' ? 'template.instantiate' : 'session.spawn_new';
    const grant = { ...API_TOKEN_FULL_GRANT_V1, approve: false,
      actions: { families: [], ids: denial === 'grant' ? [rootActionId] : [...new Set([rootActionId, 'machines.setup.apply'])] } };
    const parent = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'captured-pat-parent', binding: {
      accountId: 'bob', principalId: 'bob', credentialId, grant,
      serverIdentityId: 'srv_bob_home', machineId: target.machineId, custodianAccountId: publisher,
      installationId: 'alice-installation', actionId: rootActionId, requestId: crypto.randomUUID(), target,
      admittedMachineRole: 'manage', accountEncryptionMode: mode, requestEnvelopeDigest: 'a'.repeat(43),
    } });
    const childInput = MachineSetupApplyInputV1Schema.parse({ homeId: 'srv_bob_home', machineId: target.machineId, targets: [{
      homeId: 'srv_bob_home', machineId: target.machineId, desiredRevision: 0, recipePlans: [],
      sources: [{ kind: 'direct', setup: {} }],
    }] });
    const reviewedChild = origin === 'direct' ? undefined : { actionId: SESSION_SPAWN_MACHINE_SETUP_CHILDREN_V1.apply.action,
      role: origin === 'template' ? BOT_TEMPLATE_SETUP_APPLY_ROLE_V1 : SESSION_SPAWN_MACHINE_SETUP_CHILDREN_V1.apply.role,
      inputDigest: computeActionInputApprovalDigestV1('machines.setup.apply', childInput) };
    const runId = deriveMachineSetupCombinedRunIdV1({ homeId: 'srv_bob_home', accountId: 'bob',
      requestId: parent.binding.requestId, reviewedChild });
    const context = { surface: 'agent', authority: 'account_automation', actionRequestId: requestId,
      executionRunWorkflowRunId: runId, actionCaller: { kind: 'workflowRun', runId, authorization: {
        principal: { kind: 'api', accountId: 'bob', principalId: 'bob', credentialId },
        admittedPermissionCeiling: 'default', externalActionExecutionAuthorization: parent, reviewedChild,
      } } } satisfies ActionExecutorContext;
    const publisherToken = `${encodeTokenPart({ alg: 'none' })}.${encodeTokenPart({ sub: publisher, tokenEpoch: 9,
      provenance: { v: 1, kind: 'terminal', authority: 'account_automation' } })}.signature`;
    vi.spyOn(axios, 'get').mockImplementation(async () => { throw new Error('Admitted PAT Setup must not acquire publisher Account content or refresh grants'); });
    let minted = false;
    let delivered = false;
    let boundaryFailure: unknown;
    vi.spyOn(axios, 'post').mockImplementation(async (url, raw, config) => {
      try {
      if (String(url).endsWith('/verify')) return { status: 200, data: { ok: true } };
      expect(config?.headers?.Authorization).toBe(`Bearer ${publisherToken}`);
      const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(JSON.parse(JSON.stringify(raw)));
      if (String(url).endsWith('/execution-authorization')) {
        minted = true;
        expect(request.executionAuthorization).toEqual(parent);
        expect(request.workflowActionOrigin).toEqual({ runId, requestId, reviewedChild });
        expect(verifyMachineInstallationProof({ publicKey: keys.publicKey, proof: request.installationProof!, payload: {
          version: 1, accountId: publisher, machineId: target.machineId, installationId: 'alice-installation',
          externalActionOrigin: { homeId: 'srv_bob_home', actionId: 'machines.setup.apply', requestId,
            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(request.envelope), origin: request.workflowActionOrigin! },
        } })).toBe(true);
        if (denial === 'grant' || denial === 'revoked') return denial === 'grant'
          ? { status: 403, data: { error: 'credential_scope_denied' } }
          : { status: 401, data: { error: 'invalid_token' } };
        return { status: 200, data: { v: 1, token: 'scoped-pat-setup-leaf', binding: {
          ...parent.binding, actionId: 'machines.setup.apply', requestId, workflowActionOrigin: request.workflowActionOrigin,
          deploymentPreparationAdmission: projectDeploymentPreparationAdmissionV1('machines.setup.apply', childInput),
          requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(request.envelope),
          ...(denial === 'credential_substitution' ? { credentialId: crypto.randomUUID() } : {}),
          ...(denial === 'grant_substitution' ? { grant: API_TOKEN_FULL_GRANT_V1 } : {}),
        } } };
      }
      delivered = true;
      const opening = { authorization: request.executionAuthorization, machineId: target.machineId,
        installationId: 'alice-installation', serverIdentityId: 'srv_bob_home', installationPrivateKey: keys.secretKey };
      const codec = openManagedControllerActionCodecV1(opening);
      expect(codec?.machineKey).toHaveLength(32);
      if (request.envelope.v === 2) expect(openExternalActionRequestV2({
        projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, envelope: request.envelope,
        binding: { serverIdentityId: 'srv_bob_home', accountId: 'bob', credentialId,
          actionId: 'machines.setup.apply', requestId, target }, material: codec!,
      })?.input).toEqual(childInput);
      expect(openExternalActionRequesterAccountContextV1({ ...opening, purpose: { kind: 'external_action' } })).toBeNull();
      expect(request.executionAuthorization?.binding).toMatchObject({ accountId: 'bob', principalId: 'bob',
        credentialId, grant, custodianAccountId: publisher });
      expect(request.executionAuthorization?.binding).not.toHaveProperty('authentication');
      return { status: 409, data: { error: 'invalid_request', code: 'target_unavailable' } };
      } catch (error) { boundaryFailure = error; throw error; }
    });
    const outcome = await executionAuthorizationOwner.dispatchOriginalAccountAction({ actionId: 'machines.setup.apply',
      input: childInput, requestId, target, credentials: { token: publisherToken, encryption: null },
      serverHttpBaseUrl: 'https://home.test', serverIdentityId: 'srv_bob_home',
      installedWorkflow: { context, machineId: target.machineId, installationId: 'alice-installation', privateKey: keys.secretKey },
    });
    if (boundaryFailure) throw boundaryFailure;
    expect(outcome).toMatchObject({ ok: false, errorCode: denial === 'grant' ? 'credential_scope_denied'
      : denial === 'revoked' ? 'invalid_token' : denial === 'none' ? 'target_unavailable' : 'admission_unavailable' });
    expect(minted).toBe(true);
    expect(delivered).toBe(denial === 'none');
  });

  it('keeps public Docker-only encrypted Apply on ordinary requester Account custody without a reviewed child', async () => {
    const machine = { id: target.machineId, managedMachineRef: null, kind: 'persistent', active: true,
      installationId: 'alice-installation', revokedAt: null, replacedByMachineId: null,
      dataEncryptionKey: null, runnerContentKeyBinding: null,
      installationPublicKey: Buffer.from(keys.publicKey).toString('base64'),
      access: { custodian: { accountId: 'bob', displayName: 'Bob' }, role: 'manage',
        resourceMode: 'e2ee', accessState: 'ready' } };
    // Home mode and installed publication are genuine HTTP boundaries. There is
    // no requester Account key or admitted Run child in this public invocation.
    vi.spyOn(axios, 'get').mockImplementation(async url => String(url).endsWith('/v1/account/encryption')
      ? { status: 200, data: { mode: 'e2ee', updatedAt: 1 } }
      : String(url).endsWith('/v1/machines') ? { status: 200, data: [machine] }
      : { status: 200, data: { machine } });
    const post = vi.spyOn(axios, 'post').mockImplementation(async () => { throw new Error('No mint or effect without requester custody'); });
    const input = { homeId: 'srv_bob_home', machineId: target.machineId, targets: [{
      homeId: 'srv_bob_home', machineId: target.machineId, desiredRevision: 0, recipePlans: [],
      sources: [{ kind: 'direct', setup: { items: [{ kind: 'softwareRecipe', selection: {
        ref: { pluginId: 'happier.machine.recipes', recipeId: 'docker-engine', revision: '1' }, inputs: {},
      } }] } }],
    }] };
    expect(await executionAuthorizationOwner.dispatchOriginalAccountAction({ actionId: 'machines.setup.apply', input,
      requestId: 'public-docker-setup', target, credentials: { token: accountToken, encryption: null },
      serverHttpBaseUrl: 'https://home.test', serverIdentityId: 'srv_bob_home',
      authority: 'present_user', invocation: { caller: { kind: 'host' }, surface: 'ui', authority: 'present_user' },
    })).toMatchObject({ ok: false, errorCode: 'content_unavailable' });
    expect(post).not.toHaveBeenCalled();
  });

  it('projects encrypted setup presence from the original CLI Account transport', async () => {
    const machineKey = new Uint8Array(32).fill(57);
    const machine = { id: target.machineId, managedMachineRef: null, kind: 'persistent', active: true,
      installationId: 'installation', revokedAt: null, replacedByMachineId: null, dataEncryptionKey: null, runnerContentKeyBinding: null,
      installationPublicKey: Buffer.from(keys.publicKey).toString('base64'),
      access: { custodian: { accountId: 'bob', displayName: 'Bob' }, role: 'manage', resourceMode: 'e2ee', accessState: 'ready' } };
    vi.spyOn(axios, 'get').mockImplementation(async url => String(url).endsWith('/v1/account/encryption')
      ? { status: 200, data: { mode: 'e2ee', updatedAt: 1 } }
      : String(url).endsWith('/v1/machines') ? { status: 200, data: [machine] } : { status: 200, data: { machine } });
    let received: unknown;
    vi.spyOn(axios, 'post').mockImplementation(async (_url, body) => {
      received = body; return { status: 403, data: { error: 'permission_denied' } };
    });
    const input = { executionTarget: { serverId: 'srv_bob_home', machineId: target.machineId },
      agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
      directory: { kind: 'managed' }, machineSetupPlanInput: { homeId: 'srv_bob_home', machineId: target.machineId,
        sources: [{ kind: 'direct', setup: { scripts: [{ body: 'private CLI setup' }] } }] } };
    const result = await executionAuthorizationOwner.dispatchOriginalAccountAction({ actionId: 'session.spawn_new', input,
      requestId: 'cli-spawn-setup', target, credentials: { token: accountToken,
        encryption: { type: 'dataKey', machineKey, publicKey: nacl.box.keyPair.fromSecretKey(machineKey).publicKey } },
      serverHttpBaseUrl: 'https://home.test', serverIdentityId: 'srv_bob_home' });
    expect(received, JSON.stringify(result)).toBeDefined();
    const envelope = ExternalActionRequestEnvelopeV2Schema.parse(received && typeof received === 'object'
      && 'envelope' in received ? received.envelope : received);
    expect(envelope.sessionSpawnAdmission).toMatchObject({ machineSetupRequested: true });
    expect(JSON.stringify(envelope)).not.toContain('private CLI setup');
  });

  it('projects encrypted Session-authored setup presence before Home spawn admission', async () => {
    const sessionActionOrigin = SessionActionRpcOriginV1Schema.parse({ v: 1,
      caller: { kind: 'session', sessionId: 'lead', starterDepth: 1, turnDepth: 2 },
      sourceTurnId: 'setup-turn', callerPermissionMode: 'yolo', causalPermissionAuthority: null, requestId: 'spawn-setup' });
    const input = { executionTarget: { serverId: 'srv_bob_home', machineId: target.machineId },
      agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
      directory: { kind: 'managed' }, machineSetupPlanInput: { homeId: 'srv_bob_home', machineId: target.machineId,
        sources: [{ kind: 'direct', setup: { scripts: [{ body: 'private setup' }] } }] } };
    let received: unknown;
    vi.spyOn(axios, 'post').mockImplementation(async (_url, body) => {
      received = body; return { status: 403, data: { error: 'permission_denied' } };
    });
    await executionAuthorizationOwner.prepareExternalActionRequesterAccountAuthorizationWithEnvelope({
      actionId: 'session.spawn_new', input, requestId: sessionActionOrigin.requestId,
      sessionActionOrigin, sourceMachineId: target.machineId, target, machineId: target.machineId,
      accountId: 'bob', accountEncryptionMode: 'e2ee', tokenEpochHint: 7, token: accountToken,
      serverId: 'bob-profile', serverIdentityId: 'srv_bob_home', serverHttpBaseUrl: 'https://bob-home.test',
      installationId: 'alice-installation', privateKey: keys.secretKey,
      material: { type: 'dataKey', machineKey: new Uint8Array(32).fill(7) },
    });
    const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(received);
    expect(request.envelope).toMatchObject({ v: 2, sessionSpawnAdmission: { machineSetupRequested: true } });
    expect(JSON.stringify(request.envelope)).not.toContain('private setup');
  });
  it('mints an ordinary Apply root for a software install selection', async () => {
    const input = { sessionRef: { serverId: 'srv_bob_home', sessionId: 'c000000000000000000000011' },
      expectedVersion: '1.1.0', setup: { software: [{ key: 'tools', selection: { action: 'install', inputs: {} } }],
        accounts: [], mcpServers: [] } };
    const requests: Array<ReturnType<typeof ExternalActionExecutionAuthorizationRequestV1Schema.parse>> = [];
    vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
      if (String(url).endsWith('/verify')) return { status: 200, data: { ok: true } };
      const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
      requests.push(request);
      const data = { v: 1, token: 'ordinary-update-root', binding: {
        serverIdentityId: 'srv_bob_home', accountId: 'bob', authentication: { kind: 'account', tokenEpoch: 7 },
        actionId: 'template.updates.apply', requestId: request.envelope.requestId, target, machineId: target.machineId,
        custodianAccountId: 'bob', installationId: 'alice-installation', accountEncryptionMode: 'plain',
        requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(request.envelope),
      } };
      return { status: 200, data: ExternalActionExecutionAuthorizationV1Schema.parse(data) };
    });
    const prepared = await executionAuthorizationOwner.prepareExternalActionRequesterAccountAuthorizationWithEnvelope({
      actionId: 'template.updates.apply', input, requestId: 'apply-with-install', target, machineId: target.machineId,
      accountId: 'bob', accountEncryptionMode: 'plain', tokenEpochHint: 7, token: accountToken,
      serverId: 'bob-profile', serverIdentityId: 'srv_bob_home', serverHttpBaseUrl: 'https://bob-home.test',
      installationId: 'alice-installation', privateKey: keys.secretKey,
    });
    expect(requests).toHaveLength(1);
    expect(prepared?.authorization.binding.actionId).toBe('template.updates.apply');
  });

  it.each(['template.updates.apply', 'action.invoke'] as const)('keeps a restricted %s PAT root signed without private Account custody', async actionId => {
    const grant = { ...API_TOKEN_FULL_GRANT_V1, actions: { families: [], ids: [actionId] } };
    const root = ExternalActionExecutionAuthorizationV1Schema.parse({ ...authorization, binding: {
      ...authorization.binding, actionId, grant,
    } });
    const context: ActionExecutorContext = { surface: 'rpc', authority: 'account_automation',
      externalActionTarget: target, externalActionExecutionAuthorization: root,
      externalActionCredential: { accountId: 'bob', principalId: 'bob', credentialId: 'bob-service', grant } };
    const request = { effectActionId: actionId === 'action.invoke' ? 'machines.presence.read' : actionId,
      method: 'GET', path: actionId === 'action.invoke' ? `/v1/machines/${target.machineId}/presence` : '/v1/artifacts/template-release',
      daemonToken: 'installed-account-token', serverIdentityId: 'srv_bob_home',
      installationId: 'alice-installation', privateKey: keys.secretKey };
    const signed = executionAuthorizationOwner.resolveExternalActionServerRequestHeaders({ context, ...request });
    expect(signed.ok).toBe(true);
    if (!signed.ok) throw new Error('Missing PAT root signature');
    expect(signed.headers).toMatchObject({ [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: root.token,
      [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: expect.any(String) });
    expect(signed.headers).not.toHaveProperty('Authorization');
    expect(signed).not.toHaveProperty('machineRpcAuthorization');
    const projected = await executionAuthorizationOwner.projectExternalActionRequesterHttpAuthorization({
      authorization: root, serverId: 'bob-profile', serverIdentityId: 'srv_bob_home', serverHttpBaseUrl: 'https://bob-home.test',
      target, installationId: 'alice-installation', privateKey: keys.secretKey, rootAdmitted: true,
    });
    const native = await projected?.requesterHttpProjection?.createRequestHeaders(request);
    expect(native).toMatchObject({ [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: root.token,
      [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: expect.any(String) });
    expect(native).not.toHaveProperty('Authorization');
    expect(verifyExternalActionMachineRequestV1({ authorizationToken: root.token, target,
      installationId: root.binding.installationId, requestId: root.binding.requestId,
      effectActionId: request.effectActionId, method: request.method, path: request.path,
      signature: signed.headers[EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER], publicKey: keys.publicKey })).toBe(true);
    expect(executionAuthorizationOwner.resolveExternalActionServerRequestHeaders({ ...request,
      context: { ...context, externalActionExecutionAuthorization: undefined } })).toMatchObject({ ok: false });
    expect(executionAuthorizationOwner.resolveExternalActionServerRequestHeaders({ ...request,
      context: { surface: 'rpc', authority: 'account_automation' } })).toMatchObject({ ok: true,
        headers: { Authorization: 'Bearer installed-account-token' } });
  });

  it('uses the installed Account bearer for an admitted same-Account template Release share child', async () => {
    const actionId = 'template.release' as const;
    const root = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'account-release-root', binding: {
      accountId: 'bob', authentication: { kind: 'account', tokenEpoch: 7 }, serverIdentityId: 'srv_bob_home',
      machineId: target.machineId, custodianAccountId: 'bob', installationId: 'alice-installation',
      actionId, requestId: 'account-release', target, requestEnvelopeDigest: 'a'.repeat(43), accountEncryptionMode: 'plain',
    } });
    const context: ActionExecutorContext = { surface: 'cli', authority: 'account_automation', runtimeAccountId: 'bob',
      externalActionTarget: target, externalActionExecutionAuthorization: root };
    const child = { action: 'artifact.public_link.create' as const, role: 'signed_in_link', input: { artifactId: 'artifact-1' } };
    const headersFor = (context: ActionExecutorContext, daemonToken: string) => executionAuthorizationOwner.resolveExternalActionServerRequestHeaders({
      context, effectActionId: child.action, method: 'POST', path: '/v1/artifact-signed-in-links',
      daemonToken, serverIdentityId: 'srv_bob_home', installationId: 'alice-installation', privateKey: keys.secretKey,
    });
    const run = (daemonToken: string) => invokeHostReviewedChildV1({ parent: { actionId, input: {} }, context, child,
      admittedReview: { action: child.action, role: child.role, surface: 'cli' },
      execute: async (_input, childContext) => headersFor(childContext, daemonToken) });
    expect(await run(accountToken)).toMatchObject({ ok: true, machineRpcAuthorization: 'account',
      headers: { Authorization: `Bearer ${accountToken}` } });
    const aliceToken = `${encodeTokenPart({ alg: 'none' })}.${encodeTokenPart({ sub: 'alice' })}.signature`;
    expect(await run(aliceToken)).toMatchObject({ ok: false });
    const bareRoot = headersFor(context, accountToken);
    expect(bareRoot).not.toHaveProperty('machineRpcAuthorization');
    expect(bareRoot.ok && bareRoot.headers).not.toHaveProperty('Authorization');
  });

  it('keeps the exact reviewed child purpose on signed Workflow storage beneath a scoped parent', async () => {
    const grant = { ...API_TOKEN_FULL_GRANT_V1,
      actions: { families: [], ids: ['template.instantiate', 'machines.setup.apply'] } };
    const root = ExternalActionExecutionAuthorizationV1Schema.parse({ ...authorization, binding: {
      ...authorization.binding, actionId: 'template.instantiate', admittedMachineRole: 'manage', grant,
    } });
    const context: ActionExecutorContext = { surface: 'api', authority: 'account_automation', runtimeAccountId: 'bob',
      externalActionTarget: target, externalActionExecutionAuthorization: root,
      externalActionCredential: { ...principal, grant } };
    const setup = { homeId: root.binding.serverIdentityId, machineId: target.machineId,
      targets: [{ homeId: root.binding.serverIdentityId, machineId: target.machineId,
        sources: [{ kind: 'direct', setup: {} }], desiredRevision: 1, recipePlans: [] }] };
    const reviewedChild = { actionId: 'machines.setup.apply' as const, role: BOT_TEMPLATE_SETUP_APPLY_ROLE_V1,
      inputDigest: computeActionInputApprovalDigestV1('machines.setup.apply', setup) };
    const body = { operation: 'get', publisherMachineId: target.machineId,
      runId: deriveMachineSetupCombinedRunIdV1({ homeId: root.binding.serverIdentityId,
        accountId: root.binding.accountId, requestId: root.binding.requestId, reviewedChild }) };
    const result = await invokeHostReviewedChildV1({ parent: { actionId: root.binding.actionId, input: {} }, context,
      child: { action: 'machines.setup.apply', role: reviewedChild.role, input: setup },
      admittedReview: { action: 'machines.setup.apply', role: reviewedChild.role, surface: 'api' },
      execute: async (_input, childContext) => {
        const carried = executionAuthorizationOwner.resolveExternalActionServerRequestHeaders({ context: childContext,
          effectActionId: 'machines.setup.apply', method: 'POST', path: WORKFLOW_RUN_STORAGE_HTTP_PATH, body,
          daemonToken: 'installed-custodian-must-not-be-spent', serverIdentityId: root.binding.serverIdentityId,
          installationId: root.binding.installationId, privateKey: keys.secretKey });
        expect(carried.ok).toBe(true);
        if (!carried.ok) throw new Error('Missing signed Workflow storage headers');
        expect(carried.headers.Authorization).toBeUndefined();
        expect(carried.headers[EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]).toBe(root.token);
        expect(carried.headers['x-happier-action-effect']).toBe('machines.setup.apply');
        const encoded = carried.headers['x-happier-action-reviewed-child'];
        expect(encoded).toBeTypeOf('string');
        expect(JSON.parse(Buffer.from(encoded!, 'base64url').toString('utf8'))).toEqual(reviewedChild);
        expect(verifyExternalActionMachineRequestV1({ authorizationToken: root.token, target,
          installationId: root.binding.installationId, requestId: root.binding.requestId,
          effectActionId: 'machines.setup.apply', method: 'POST', path: WORKFLOW_RUN_STORAGE_HTTP_PATH, body,
          reviewedChild, signature: carried.headers[EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER], publicKey: keys.publicKey })).toBe(true);
        return { ok: true as const, result: {} };
      } });
    expect(result).toMatchObject({ ok: true });
  });

  it.each(['deployments.environments.create', 'deployments.targets.link'] as const)(
    'carries the issuer-reviewed retention child on ordinary signed HTTP under %s', async actionId => {
    const scoped = ExternalActionExecutionAuthorizationV1Schema.parse({ ...authorization,
      binding: { ...authorization.binding, actionId } });
    const root = { ...contextForReviewedChild(), externalActionExecutionAuthorization: scoped };
    const input = { homeId: scoped.binding.serverIdentityId, managedId: 'allocation', expectedIntentRevision: 4,
      retention: { kind: 'until-delete' as const }, wakeOnAcceptedMessage: true };
    const child = { action: 'machines.managed.retention.update' as const, role: 'target-retention:guest', input };
    const request = { effectActionId: child.action, method: 'POST', path: '/v1/machines/managed/controller/admit-control',
      body: { action: child.action, requestId: scoped.binding.requestId, input } };
    const headersFor = (context: ActionExecutorContext) => executionAuthorizationOwner.resolveExternalActionServerRequestHeaders({
      context, ...request, daemonToken: 'must-not-be-spent', serverIdentityId: scoped.binding.serverIdentityId,
      installationId: scoped.binding.installationId, privateKey: keys.secretKey });
    const result = await invokeHostReviewedChildV1({ parent: { actionId, input: {} }, context: root, child,
      admittedReview: { action: child.action, role: child.role, surface: 'cli' },
      execute: async (_input, context) => {
        const carried = headersFor(context);
        expect(carried.ok).toBe(true);
        if (!carried.ok) throw new Error('Missing scoped child headers');
        expect(carried.headers[EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]).toBe(scoped.token);
        expect(carried.headers.Authorization).toBeUndefined();
        const encoded = carried.headers['x-happier-action-reviewed-child'];
        expect(typeof encoded).toBe('string');
        const reviewedChild = JSON.parse(Buffer.from(encoded!, 'base64url').toString('utf8'));
        expect(reviewedChild).toEqual({ actionId: child.action, role: child.role,
          inputDigest: computeActionInputApprovalDigestV1(child.action, input) });
        expect(verifyExternalActionMachineRequestV1({ authorizationToken: scoped.token, target,
          installationId: scoped.binding.installationId, requestId: scoped.binding.requestId, ...request,
          reviewedChild, signature: carried.headers[EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER], publicKey: keys.publicKey })).toBe(true);
        return { ok: true as const, result: {} };
      } });
    expect(result).toMatchObject({ ok: true });
    const rootHeaders = headersFor(root);
    if (!rootHeaders.ok) throw new Error('Missing scoped root headers');
    expect(rootHeaders.headers).not.toHaveProperty('x-happier-action-reviewed-child');
  });

  it('signs the admitted local reviewed child without replacing root authorization or requester custody', async () => {
    const admitted = await executionAuthorizationOwner.projectExternalActionRequesterHttpAuthorization({
      authorization, target, serverId: 'bob-profile', serverIdentityId: 'srv_bob_home',
      serverHttpBaseUrl: 'https://home.test', installationId: 'alice-installation', privateKey: keys.secretKey,
      rootAdmitted: true,
    });
    if (!admitted?.requesterHttpProjection) throw new Error('Missing requester HTTP projection');
    const root = { ...contextForReviewedChild(), externalActionExecutionAuthorization: admitted };
    const input = { environmentId: 'new-environment', expectedRevision: 1, bindings: [] };
    const child = { action: 'deployments.bindings.set' as const, role: 'copied-bindings', input };
    const parent = { actionId: authorization.binding.actionId, input: envelope.input };
    const request = { effectActionId: child.action, method: 'POST', path: '/v1/deployments/environments/new-environment/bindings', body: input };
    const result = await invokeHostReviewedChildV1({ parent, context: root, child,
      admittedReview: { action: child.action, role: child.role, surface: 'cli' },
      execute: async (_input, childContext) => {
        const carried = childContext.externalActionExecutionAuthorization!;
        expect(carried.binding).toBe(admitted.binding);
        expect(carried.token).toBe(admitted.token);
        expect(childContext.externalActionTarget).toBe(root.externalActionTarget);
        const headers = await carried.requesterHttpProjection!.createRequestHeaders(request);
        const encoded = headers?.['x-happier-action-reviewed-child'];
        expect(typeof encoded).toBe('string');
        const reviewedChild = JSON.parse(Buffer.from(encoded!, 'base64url').toString('utf8'));
        expect(reviewedChild).toEqual({ actionId: child.action, role: child.role,
          inputDigest: computeActionInputApprovalDigestV1(child.action, input) });
        const verification = { authorizationToken: admitted.token, target,
          installationId: 'alice-installation', requestId: admitted.binding.requestId, ...request,
          signature: headers![EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER], publicKey: keys.publicKey };
        expect(verifyExternalActionMachineRequestV1({ ...verification, reviewedChild })).toBe(true);
        expect(verifyExternalActionMachineRequestV1(verification)).toBe(false);
        return { ok: true as const, result: {} };
      } });
    expect(result).toMatchObject({ ok: true });
    expect(await admitted.requesterHttpProjection.createRequestHeaders(request)).not.toHaveProperty('x-happier-action-reviewed-child');
  });

  it('signs an admitted Workflow Session target from its captured Run baseline without a principal refresh predicate', async () => {
    const actionId = 'session.notes.set';
    const requestId = 'run/role-input/0';
    const sessionTarget = { kind: 'session' as const, sessionId: 'owned-session' };
    const start = resolveCliAgentStartContextV1({ sessionId: sessionTarget.sessionId,
      metadata: { machineId: 'publisher', path: '/work' }, machineId: 'publisher', directory: '/work',
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      starterDepth: 0, turnDepth: 0, callerPermissionMode: 'default', settings: accountSettingsParse({}),
      roleSourceInventory: await createRoleSourceReaderV1({})(), accountRoleOverrides: { status: 'ready', overrides: {} },
      runCaller: { runId: 'run', runDepth: 0 } });
    if ('ok' in start) throw new Error('Missing admitted Workflow start baseline');
    const context = { surface: 'agent', authority: 'account_automation', actionRequestId: requestId,
      executionRunWorkflowRunId: 'run', agentStartContext: start, workspaceWrites: 'allow',
      actionCaller: { kind: 'workflowRun', runId: 'run', authorization: { principal: { kind: 'host' },
        admittedPermissionCeiling: 'default' } } } satisfies ActionExecutorContext;
    const get = vi.spyOn(axios, 'get').mockImplementation(async url => {
      expect(String(url)).toBe('https://home.test/v1/account/encryption/currentness');
      return { status: 200, data: { mode: 'plain', version: 1, updatedAt: 1,
        signingKeyFingerprint: null, contentKeyFingerprint: null } };
    });
    let mints = 0;
    vi.spyOn(axios, 'post').mockImplementation(async (url, raw) => {
      if (String(url).endsWith('/verify')) return { status: 200, data: { ok: true } };
      const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(raw);
      mints++;
      expect(request.workflowActionOrigin).toMatchObject({ runId: 'run', requestId,
        sessionAuthority: { authorization: context.actionCaller.authorization, runDepth: 0,
          directory: '/work', workspaceWrites: 'allow' } });
      expect(verifyMachineInstallationProof({ publicKey: keys.publicKey, proof: request.installationProof!, payload: {
        version: 1, machineId: 'publisher', installationId: 'publisher-installation', accountId: 'bob',
        externalActionOrigin: { homeId: 'srv_bob_home', actionId, requestId,
          requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(request.envelope), origin: request.workflowActionOrigin! },
      } })).toBe(true);
      return { status: 200, data: { v: 1, token: 'session-home-proof', binding: {
        accountId: 'bob', custodianAccountId: 'bob', authentication: { kind: 'account', tokenEpoch: 7 },
        accountEncryptionMode: 'plain', serverIdentityId: 'srv_bob_home', machineId: 'publisher',
        installationId: 'publisher-installation', actionId, requestId, target: sessionTarget,
        workflowActionOrigin: request.workflowActionOrigin,
        requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(request.envelope),
      } } };
    });
    const request = { credentials: { token: accountToken, encryption: null }, context, actionId,
      input: { sessionId: sessionTarget.sessionId, notes: 'Admitted notes' }, target: sessionTarget,
      machineId: 'publisher', serverId: 'bob-profile', serverIdentityId: 'srv_bob_home',
      serverHttpBaseUrl: 'https://home.test', installationId: 'publisher-installation', privateKey: keys.secretKey };
    expect(await executionAuthorizationOwner.prepareInstalledWorkflowActionAuthorization(request))
      .toMatchObject({ binding: { target: sessionTarget, workflowActionOrigin: { runId: 'run', requestId } } });
    expect(get).toHaveBeenCalledTimes(1);
    expect(mints).toBe(1);
    expect(await executionAuthorizationOwner.prepareInstalledWorkflowActionAuthorization({ ...request,
      context: { ...context, agentStartContext: { ...start, baseline: { ...start.baseline, machineId: 'another-publisher' } } },
    })).toBeNull();
    expect(await executionAuthorizationOwner.prepareInstalledWorkflowActionAuthorization({ ...request,
      context: { ...context, executionRunWorkflowRunId: 'another-run' },
    })).toBeNull();
    expect(get).toHaveBeenCalledTimes(1);
    expect(mints).toBe(1);
  });

  it.each(['deployments.prepare', 'deployments.publish.prepare'] as const)('retains exact %s admission and refuses substitution before direct Account delivery', async actionId => {
    const input = actionId === 'deployments.prepare' ? { projectSourceId: 'source', sourceRevision: 1,
      workspace: { kind: 'workspace-ref', serverId: 'srv_bob_home', id: 'workspace' },
      repository: { kind: 'github', deployment: 'https://github.com', repository: 'private/project' }, baseCommit: 'a'.repeat(40) }
      : { serverId: 'srv_bob_home', machineId: target.machineId, installationId: 'installation',
        projectSourceId: 'source', sourceRevision: 1, templateRef: { sourceId: 'apps', itemId: 'app', version: '1',
          ref: { kind: 'content', digest: `sha256:${'a'.repeat(64)}` } } };
    // Finite Prepare retains an offline target; Session-create refusal must not become a blanket guard.
    const machine = { id: target.machineId, kind: 'persistent', active: actionId !== 'deployments.prepare', installationId: 'installation',
      revokedAt: null, replacedByMachineId: null, dataEncryptionKey: null, runnerContentKeyBinding: null, installationPublicKey: null,
      access: { custodian: { accountId: 'bob', displayName: 'Bob' }, role: 'manage', resourceMode: 'plain', accessState: 'ready' } };
    vi.spyOn(axios, 'get').mockImplementation(async url => String(url).endsWith('/v1/account/encryption')
      ? { status: 200, data: { mode: 'plain', updatedAt: 1 } }
      : String(url).endsWith('/v1/machines') ? { status: 200, data: [machine] } : { status: 200, data: { machine } });
    let minted = false;
    let delivered = false;
    let substitute = false;
    vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
      if (String(url).endsWith('/execution-authorization')) {
        minted = true;
        const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
        return { status: 200, data: { v: 1, token: 'prepare-proof', binding: {
          accountId: 'bob', authentication: { kind: 'account', tokenEpoch: 7 }, serverIdentityId: 'srv_bob_home',
          machineId: target.machineId, custodianAccountId: 'bob', installationId: 'installation', actionId,
          requestId: 'direct-prepare', target, accountEncryptionMode: 'plain',
          requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(request.envelope),
          deploymentPreparationAdmission: actionId === 'deployments.prepare'
            ? { operation: 'prepare', source: { id: 'source', revision: 1 },
              workspace: { kind: 'workspace-ref', id: substitute ? 'another' : 'workspace' } }
            : { operation: 'catalog', source: { id: substitute ? 'another' : 'source', revision: 1 },
              machineId: target.machineId, installationId: 'installation' },
        } } };
      }
      delivered = true;
      return { status: 200, data: { v: 1, actionId, requestId: 'direct-prepare',
        execution: { ok: true, result: { kind: 'approval_request_created', artifactId: 'prepared-read', actionId } } } };
    });
    const request = { actionId, input, requestId: 'direct-prepare', target,
      credentials: { token: accountToken, encryption: null }, serverHttpBaseUrl: 'https://home.test', serverIdentityId: 'srv_bob_home' };
    expect(await executionAuthorizationOwner.dispatchOriginalAccountAction(request))
      .toMatchObject({ ok: true, result: { kind: 'approval_request_created', artifactId: 'prepared-read', actionId } });
    expect(minted && delivered).toBe(true);
    minted = false;
    delivered = false;
    substitute = true;
    const result = await executionAuthorizationOwner.dispatchOriginalAccountAction(request);
    expect(minted).toBe(true);
    expect(result).toMatchObject({ ok: false, errorCode: 'admission_unavailable' });
    expect(delivered).toBe(false);
  });
  it('retains exact Prepare references through minting and refuses a substituted workspace', async () => {
    const actionId = 'deployments.prepare';
    const prepareInput = { projectSourceId: 'source', sourceRevision: 1,
      workspace: { kind: 'workspace-ref', serverId: 'srv_bob_home', id: 'workspace' },
      repository: { kind: 'github', deployment: 'https://github.com', repository: 'private/project' }, baseCommit: 'a'.repeat(40) };
    const admission = projectDeploymentPreparationAdmissionV1(actionId, prepareInput)!;
    let substitute = false;
    vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
      if (String(url).endsWith('/verify')) return { status: 200, data: { ok: true } };
      const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
      expect(request.envelope).toMatchObject({ deploymentPreparationAdmission: admission });
      expect(JSON.stringify(request.envelope)).not.toContain('private/project');
      return { status: 200, data: { v: 1, token: 'prepare-proof', binding: {
        accountId: 'bob', authentication: { kind: 'account', tokenEpoch: 7 }, serverIdentityId: 'srv_bob_home',
        machineId: target.machineId, custodianAccountId: 'bob', installationId: 'alice-installation', actionId,
        requestId: 'prepare-request', target, accountEncryptionMode: 'e2ee',
        requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(request.envelope),
        deploymentPreparationAdmission: substitute ? { ...admission, workspace: { kind: 'workspace-ref', id: 'another' } } : admission,
      } } };
    });
    const request = { actionId, input: prepareInput, requestId: 'prepare-request', target, machineId: target.machineId,
      accountId: 'bob', accountEncryptionMode: 'e2ee' as const, tokenEpochHint: 7, token: accountToken,
      serverId: 'bob-profile', serverIdentityId: 'srv_bob_home', serverHttpBaseUrl: 'https://home.test',
      installationId: 'alice-installation', privateKey: keys.secretKey,
      material: { type: 'dataKey' as const, machineKey: new Uint8Array(32).fill(19) } };
    expect(await prepareExternalActionRequesterAccountAuthorization(request))
      .toMatchObject({ binding: { deploymentPreparationAdmission: admission } });
    substitute = true;
    expect(await prepareExternalActionRequesterAccountAuthorization(request)).toBeNull();
  });
  it('retains the exact deployment read projection through Home minting without publishing service names', async () => {
    const actionId = 'deployments.health.read';
    const readInput = { serverId: 'srv_bob_home', environmentId: 'environment', deploymentId: 'receipt', targetLinkId: 'runtime',
      machineId: target.machineId, installationId: 'alice-installation', service: { kind: 'deployment', machineId: target.machineId,
        environmentId: 'environment', environmentInstanceId: 'instance', composeService: 'private-service', serviceId: 'instance/private-service' } };
    const material = { type: 'dataKey' as const, machineKey: new Uint8Array(32).fill(19) };
    let substitute = false;
    vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
      if (String(url).endsWith('/verify')) return { status: 200, data: { ok: true } };
      const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
      const admission = projectDeploymentReadAdmissionV1(actionId, readInput)!;
      expect(request.envelope).toMatchObject({ deploymentReadAdmission: admission });
      expect(JSON.stringify(request.envelope)).not.toContain('private-service');
      return { status: 200, data: { v: 1, token: 'deployment-read-proof', binding: {
        accountId: 'bob', authentication: { kind: 'account', tokenEpoch: 7 }, serverIdentityId: 'srv_bob_home',
        machineId: target.machineId, custodianAccountId: 'bob', installationId: 'alice-installation', actionId,
        requestId: 'deployment-read-request', target, accountEncryptionMode: 'e2ee',
        requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(request.envelope),
        deploymentReadAdmission: substitute ? { ...admission, deploymentId: 'another-receipt' } : admission,
      } } };
    });
    const request = { actionId, input: readInput, requestId: 'deployment-read-request', target, machineId: target.machineId,
      accountId: 'bob', accountEncryptionMode: 'e2ee' as const, tokenEpochHint: 7, token: accountToken,
      serverId: 'bob-profile', serverIdentityId: 'srv_bob_home', serverHttpBaseUrl: 'https://home.test',
      installationId: 'alice-installation', privateKey: keys.secretKey, material };
    expect(await prepareExternalActionRequesterAccountAuthorization(request))
      .toMatchObject({ binding: { deploymentReadAdmission: projectDeploymentReadAdmissionV1(actionId, readInput) } });
    substitute = true;
    expect(await prepareExternalActionRequesterAccountAuthorization(request)).toBeNull();
  });
  afterEach(() => vi.restoreAllMocks());

  it.each(['structured', 'legacy'] as const)('dispatches an installed Workflow with %s Account custody using only the publisher key and exact Account-mode read', async kind => {
    const token = kind === 'structured' ? accountToken
      : `${encodeTokenPart({ alg: 'none' })}.${encodeTokenPart({ sub: 'bob' })}.signature`;
    const actionId = 'machines.setup.apply';
    const requestId = 'run/invocation/0';
    const childInput = { homeId: 'srv_bob_home', machineId: target.machineId, sources: [
      { kind: 'accountPreset', presetId: 'reviewed', presetRevision: 1, setup: { scripts: [{ body: 'echo reviewed', affects: 'none' }],  } },
      { kind: 'direct', setup: {} },
    ] };
    const context = { surface: 'agent', authority: 'account_automation', actionRequestId: requestId,
      executionRunWorkflowRunId: 'run', actionCaller: { kind: 'workflowRun', runId: 'run',
        authorization: { principal: { kind: 'host' }, admittedPermissionCeiling: 'default' } } } satisfies ActionExecutorContext;
    const get = vi.spyOn(axios, 'get').mockImplementation(async url => {
      // No Machine inventory, receiver installation lookup or publisher key is needed at the source.
      expect(String(url)).toBe('https://home.test/v1/account/encryption');
      return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
    });
    const post = vi.spyOn(axios, 'post').mockImplementation(async (url, raw) => {
      expect(String(url)).toBe(`https://home.test/v1/actions/${actionId}`);
      const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(raw);
      expect(request).toMatchObject({ machineId: 'publisher', envelope: { v: 1, target, input: childInput },
        workflowActionOrigin: { runId: 'run', requestId } });
      expect(verifyMachineInstallationProof({ publicKey: keys.publicKey, proof: request.installationProof!,
        payload: { version: 1, machineId: 'publisher', installationId: 'publisher-installation', accountId: 'bob',
          externalActionOrigin: { homeId: 'srv_bob_home', actionId, requestId,
            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(request.envelope), origin: request.workflowActionOrigin! } } })).toBe(true);
      return { status: 200, data: { v: 1, actionId, requestId, execution: { ok: true,
        result: { operationId: 'f4114889-b83c-4c13-aad9-818ab1da8534' } } } };
    });
    expect(await executionAuthorizationOwner.dispatchOriginalAccountAction({ actionId, input: childInput, requestId, target,
      credentials: { token, encryption: null }, serverHttpBaseUrl: 'https://home.test', serverIdentityId: 'srv_bob_home',
      installedWorkflow: { context, machineId: 'publisher', installationId: 'publisher-installation', privateKey: keys.secretKey } }))
      .toMatchObject({ ok: true, result: { operationId: expect.any(String) } });
    expect(get).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it.each(['action_not_admitted', 'action_outcome_unknown', 'project_requester_home_unavailable', 'target_not_local', 'target_unavailable'] as const)('preserves original Account correlation for %s and refuses a mismatched reply', async code => {
    const machine = { id: target.machineId, managedMachineRef: null, kind: 'persistent', active: true, installationId: 'installation',
      revokedAt: null, replacedByMachineId: null, dataEncryptionKey: null, runnerContentKeyBinding: null,
      access: { custodian: { accountId: 'bob', displayName: 'Bob' }, role: 'manage', resourceMode: 'plain', accessState: 'ready' } };
    vi.spyOn(axios, 'get').mockImplementation(async url => url.endsWith('/v1/account/encryption')
      ? { status: 200, data: { mode: 'plain', updatedAt: 1 } }
      : url.endsWith(`/v1/machines/${machine.id}`) ? { status: 200, data: { machine } } : { status: 200, data: [machine] });
    const response = (id: string) => {
      const refusal = projectExternalActionHttpError(code, id);
      return { status: refusal.statusCode, data: { ...refusal.payload,
        ...(code === 'action_not_admitted' ? { failureCause: { phase: 'execution_authorization', errorClass: 'Error', errorCode: null, httpStatus: null } } : {}),
        ...(code === 'target_not_local' ? { phase: 'target_installation' } : {}),
        ...(code === 'target_unavailable' ? { diagnostic: { reason: 'machine_offline', requiredFact: 'machine_online', remedy: 'reconnect_machine' } } : {}),
        ...(code === 'action_outcome_unknown' ? { diagnostic: { reason: 'daemon_rpc_refused', errorCode: 'RPC_FORBIDDEN' } } : {}) } };
    };
    vi.spyOn(axios, 'post').mockResolvedValueOnce(response(envelope.requestId)).mockResolvedValueOnce(response('other-request'));
    const request = { actionId: 'notifications.notify_me', input: envelope.input, requestId: envelope.requestId,
      target, credentials: { token: accountToken, encryption: null, credentialProvenance: 'stored_session' as const },
      serverHttpBaseUrl: 'https://home.example', serverIdentityId: 'srv_bob_home' };
    expect(await executionAuthorizationOwner.dispatchOriginalAccountAction(request))
      .toMatchObject({ ok: false, errorCode: code,
        ...(code === 'action_not_admitted' ? { failureCause: { phase: 'execution_authorization', errorClass: 'Error', errorCode: null, httpStatus: null } } : {}),
        ...(code === 'target_unavailable' ? { details: { reason: 'machine_offline', requiredFact: 'machine_online', remedy: 'reconnect_machine' } }
          : code === 'project_requester_home_unavailable' ? {} : { details: { requestId: envelope.requestId,
          ...(code === 'target_not_local' ? { phase: 'target_installation' } : {}),
          ...(code === 'action_outcome_unknown' ? { diagnostic: { reason: 'daemon_rpc_refused', errorCode: 'RPC_FORBIDDEN' } } : {}) } }) });
    expect(await executionAuthorizationOwner.dispatchOriginalAccountAction(request))
      .toMatchObject({ ok: false, errorCode: 'invalid_action_output' });
  });

  it.each(['matching', 'mismatched', 'malformed'] as const)('preserves the Machine availability mint refusal through the original Account Action (%s)', async reply => {
    const actionId = 'machines.vitals.get';
    const requestId = 'machine-availability-mint';
    const diagnostic = { reason: 'machine_offline', requiredFact: 'machine_online', remedy: 'reconnect_machine' };
    const machine = { id: target.machineId, managedMachineRef: null, kind: 'persistent', active: true,
      installationId: 'installation', revokedAt: null, replacedByMachineId: null,
      access: { custodian: { accountId: 'bob', displayName: 'Bob' }, role: 'manage', resourceMode: 'plain', accessState: 'ready' } };
    vi.spyOn(axios, 'get').mockImplementation(async url => url.endsWith('/v1/account/encryption')
      ? { status: 200, data: { mode: 'plain', updatedAt: 1 } }
      : url.endsWith(`/v1/machines/${machine.id}`) ? { status: 200, data: { machine } } : { status: 200, data: [machine] });
    const post = vi.spyOn(axios, 'post').mockImplementation(async url => {
      expect(String(url)).toBe(`https://home.example/v1/actions/${actionId}/execution-authorization`);
      return { status: 409, data: { error: 'invalid_request', code: 'target_unavailable',
        requestId: reply === 'mismatched' ? 'another-request' : requestId,
        diagnostic: reply === 'malformed' ? { ...diagnostic, machineId: 'private-identifier' } : diagnostic } };
    });
    const result = await executionAuthorizationOwner.dispatchOriginalAccountAction({ actionId,
      input: { machineId: target.machineId }, requestId, target,
      credentials: { token: accountToken, encryption: null, credentialProvenance: 'stored_session' },
      serverHttpBaseUrl: 'https://home.example', serverIdentityId: 'srv_bob_home' });
    expect(result).toMatchObject(reply === 'matching'
      ? { ok: false, errorCode: 'target_unavailable', details: diagnostic }
      : { ok: false, errorCode: 'auth_unavailable' });
    if (reply !== 'matching') expect(result).not.toHaveProperty('details');
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('preserves retryable Home mint transport failure during requester preparation', async () => {
    const post = vi.spyOn(axios, 'post').mockRejectedValue(Object.assign(new Error('private connection detail'), { code: 'ECONNRESET' }));
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'bob', tokenEpoch: 7,
      provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.signature`;
    const outcome = await prepareExternalActionRequesterAccountAuthorization({
      actionId: 'session.archive', input: { sessionId: 'session' }, requestId: 'mint-transport',
      target, machineId: target.machineId, accountId: 'bob', accountEncryptionMode: 'plain', tokenEpochHint: 7,
      token, serverId: 'home', serverIdentityId: 'srv_bob_home', serverHttpBaseUrl: 'https://home.test',
      installationId: 'installation', privateKey: keys.secretKey,
    }).catch((error: unknown) => error);
    expect(post).toHaveBeenCalled();
    expect(outcome).toMatchObject({ code: 'project_requester_home_unavailable', retryable: true });
  });

  it.each([503, 'ECONNRESET'] as const)('preserves unavailable Home evidence (%s) instead of rejecting the signed root', async failure => {
    const post = vi.spyOn(axios, 'post');
    if (typeof failure === 'number') post.mockResolvedValue({ status: failure, data: { error: 'database_connection_unavailable' } });
    else post.mockRejectedValue(Object.assign(new Error('private connection detail'), { code: failure }));
    await expect(verifyExternalActionExecutionAuthorizationCurrent({ authorization, effectActionId: authorization.binding.actionId,
      target, privateKey: keys.secretKey, installationId: authorization.binding.installationId,
      serverHttpBaseUrl: 'https://home.test' })).rejects.toMatchObject({ code: 'project_requester_home_unavailable', retryable: true });
  });

  it.each([401, 403])('keeps a definitive Home refusal (%s) closed', async status => {
    const log = vi.spyOn(logger, 'warnLocalFile').mockImplementation(() => {});
    const requestId = '70cc64d3-0386-4914-b7d8-713b7879e99f';
    const nativeAuthorization = ExternalActionExecutionAuthorizationV1Schema.parse({ ...authorization,
      binding: { ...authorization.binding, actionId: 'session.message.send', requestId } });
    vi.spyOn(axios, 'post').mockResolvedValue({ status, data: { error: 'invalid_token' } });
    await expect(verifyExternalActionExecutionAuthorizationCurrent({ authorization: nativeAuthorization, effectActionId: nativeAuthorization.binding.actionId,
      target, privateKey: keys.secretKey, installationId: authorization.binding.installationId,
      serverHttpBaseUrl: 'https://home.test' })).resolves.toBe(false);
    expect(log).toHaveBeenCalledWith('[external-action-phase]', expect.objectContaining({
      phase: 'signed_root_http_status', httpStatus: status, requestId, actionId: 'session.message.send',
    }));
    expect(JSON.stringify(log.mock.calls)).not.toContain(authorization.token);
  });

  it('preserves an authenticated authorization scope refusal instead of reporting an invalid token', async () => {
    vi.spyOn(axios, 'post').mockResolvedValue({ status: 403, data: { error: 'credential_scope_denied' } });
    await expect(executionAuthorizationOwner.mintExternalActionExecutionAuthorization({
      actionId: 'approval.request.decide', machineId: target.machineId, envelope,
      pat: 'terminal-credential', serverHttpBaseUrl: 'https://home.test',
    })).resolves.toEqual({ ok: false, code: 'credential_scope_denied' });
  });

  it('carries the recorded controller refusal through mint and public daemon ingress without dispatch', async () => {
    const machineId = 'eadc2422-b42b-478d-97b1-af9b530d5f08';
    const controllerMachineId = '6b2f67f1-dc3d-40c7-9080-0ec6d4515822';
    const details = { reason: 'controller_placement_mismatch', requiredFact: `controllerMachineId=${controllerMachineId}`,
      remedy: `Run this action on Machine ${controllerMachineId}, or make that controller reachable, then retry` };
    const failureCause = { phase: 'deployment.controller.placement', errorClass: 'Error', errorCode: 'credential_scope_denied', httpStatus: null };
    // Home HTTP is the boundary; the mint parser, PAT verifier and public daemon route remain real.
    const payload = { error: 'credential_scope_denied', details, failureCause };
    const post = vi.spyOn(axios, 'post').mockResolvedValue({ status: 403, data: payload });
    const app = fastify();
    registerDaemonExternalActionRoute(app, {
      currentMachineId: machineId, currentServerId: 'srv_niq7wbpMyJviL4EtO5YlTEd0Us0Ou0nN',
      verifyPat: createDaemonPatVerifier({ accountId: 'bob', introspect: async () => ({ ok: true, ...principal, expiresAt: null }) }),
      executor: createActionExecutor(createUnavailableActionTransportDeps()),
      resolveTarget: createDaemonExternalActionTargetResolver({ credentials: { token: accountToken, encryption: null } }),
      mintExecutionAuthorization: request => executionAuthorizationOwner.mintExternalActionExecutionAuthorization({
        ...request, serverHttpBaseUrl: 'https://home.test' }),
    });
    try {
      const response = await app.inject({ method: 'POST', url: '/v1/actions/deployments.teardown',
        headers: { authorization: `Bearer hap_v1_2c67deea-5ae7-4706-9ad6-b5b992df1cba_${'A'.repeat(43)}` },
        payload: { v: 1, requestId: 'qa-domain-1104-persisted-g-teardown-r76', target: { kind: 'machine', machineId },
          input: { serverId: 'srv_niq7wbpMyJviL4EtO5YlTEd0Us0Ou0nN', environmentId: 'cmw424voq00cbmcskx8q38dvv',
            targetLinkId: 'cmw424vpr00cdmcsk85jcci67', requestKey: 'qa-domain-1104-r76-retained-g-teardown', reason: 'decommission' } } });
      expect.soft([response.statusCode, response.json()]).toEqual([403, payload]);
      expect(post).toHaveBeenCalledTimes(1);
      expect(await executionAuthorizationOwner.deliverExternalActionRequest({ actionId: 'deployments.teardown',
        serverHttpBaseUrl: 'https://home.test', body: {}, envelope, headers: {}, isCurrent: async () => true }))
        .toMatchObject({ ok: false, errorCode: 'credential_scope_denied', details, failureCause });
    } finally { await app.close(); }
  });

  it('settles an insufficient-authority mint refusal once with the canonical code', async () => {
    const post = vi.spyOn(axios, 'post').mockResolvedValue({ status: 403, data: { error: 'present_user_required' } });
    await expect(executionAuthorizationOwner.mintExternalActionExecutionAuthorization({
      actionId: 'machines.terminal.list', machineId: target.machineId, envelope,
      pat: 'terminal-credential', serverHttpBaseUrl: 'https://home.test',
    })).resolves.toEqual({ ok: false, code: 'present_user_required' });
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('carries the Home authority refusal through the daemon public ingress without dispatch or another mint', async () => {
    const refusal = projectExternalActionHttpError('present_user_required');
    const post = vi.spyOn(axios, 'post').mockResolvedValue({ status: refusal.statusCode, data: refusal.payload });
    const app = fastify();
    registerDaemonExternalActionRoute(app, {
      currentMachineId: target.machineId, currentServerId: 'bob-profile',
      verifyPat: createDaemonPatVerifier({ accountId: 'bob', introspect: async () => ({
        ok: true, ...principal, expiresAt: null,
      }) }),
      executor: createActionExecutor(createUnavailableActionTransportDeps()),
      resolveTarget: createDaemonExternalActionTargetResolver({ credentials: { token: accountToken, encryption: null } }),
      mintExecutionAuthorization: request => executionAuthorizationOwner.mintExternalActionExecutionAuthorization({
        ...request, serverHttpBaseUrl: 'https://home.test',
      }),
    });
    try {
      const response = await app.inject({ method: 'POST', url: '/v1/actions/machines.terminal.list',
        headers: { authorization: `Bearer hap_v1_2c67deea-5ae7-4706-9ad6-b5b992df1cba_${'A'.repeat(43)}` },
        payload: { ...envelope, input: { serverId: 'bob-profile', machineId: target.machineId } } });
      expect([response.statusCode, response.json()]).toEqual([403, refusal.payload]);
      expect(post).toHaveBeenCalledTimes(1);
    } finally { await app.close(); }
  });

  it.each(['diagnosed', 'bare', 'unavailable'] as const)('preserves the Machine availability mint refusal through the daemon ingress (%s)', async reply => {
    const diagnostic = { reason: 'machine_revoked', requiredFact: 'machine_registration', remedy: 'register_machine' };
    const requestId = 'daemon-machine-availability';
    vi.spyOn(axios, 'post').mockResolvedValue(reply === 'unavailable'
      ? { status: 503, data: { error: 'auth_unavailable' } }
      : { status: 409, data: { error: 'invalid_request', code: 'target_unavailable', requestId,
        ...(reply === 'diagnosed' ? { diagnostic } : {}) } });
    // Session birth is the OS/process boundary; the real Action admission and dispatch stay in place.
    const sessionSpawnNew = vi.fn(async () => ({ type: 'pending' as const, retryWithSameCreationKey: true, outcome: 'accepted' as const }));
    const app = fastify();
    registerDaemonExternalActionRoute(app, {
      currentMachineId: target.machineId, currentServerId: 'bob-profile',
      verifyPat: createDaemonPatVerifier({ accountId: 'bob', introspect: async () => ({ ok: true, ...principal, expiresAt: null }) }),
      executor: createActionExecutor({ ...createUnavailableActionTransportDeps(), sessionSpawnNew }),
      resolveTarget: createDaemonExternalActionTargetResolver({ credentials: { token: accountToken, encryption: null } }),
      mintExecutionAuthorization: request => executionAuthorizationOwner.mintExternalActionExecutionAuthorization({
        ...request, serverHttpBaseUrl: 'https://home.test',
      }),
    });
    try {
      const response = await app.inject({ method: 'POST', url: '/v1/actions/session.spawn_new',
        headers: { authorization: `Bearer hap_v1_2c67deea-5ae7-4706-9ad6-b5b992df1cba_${'A'.repeat(43)}` },
        payload: { v: 1, requestId, target, input: { creationKey: 'own-start', agentTarget: { kind: 'agent',
          identity: { pluginId: 'happier.agent.codex', localId: 'codex' } }, directory: { kind: 'managed' } } } });
      if (reply === 'diagnosed') {
        expect([response.statusCode, response.json()]).toEqual([409, { error: 'invalid_request', code: 'target_unavailable', requestId, diagnostic }]);
        expect(sessionSpawnNew).not.toHaveBeenCalled();
      } else {
        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({ execution: { ok: true, result: { type: 'pending' } } });
        expect(sessionSpawnNew).toHaveBeenCalledTimes(1);
      }
    } finally { await app.close(); }
  });

  it.each(['scm.diffSummary.result.list', 'providers.models.projection', 'private-authored-action'])
  ('records a safe non-Session mint refusal for %s while preserving the public result', async actionId => {
    const log = vi.spyOn(logger, 'warnLocalFile').mockImplementation(() => {});
    const refusal = projectExternalActionHttpError('target_unavailable');
    const post = vi.spyOn(axios, 'post').mockResolvedValue({ status: refusal.statusCode,
      data: { ...refusal.payload, requestId: 'private-response-request' } });
    await expect(executionAuthorizationOwner.mintExternalActionExecutionAuthorization({
      actionId, machineId: 'private-machine-key',
      envelope: { ...envelope, requestId: 'private-authored-request',
        input: { cwd: '/private/workspace', requesterKey: 'private-requester-key', body: 'private-input' } },
      pat: 'private-terminal-credential', serverHttpBaseUrl: 'https://private-home.test',
    })).resolves.toEqual({ ok: false, code: 'target_unavailable' });
    expect(post).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith('[external-action-phase]', {
      phase: 'authorization_mint_http_status', httpStatus: 409, refusalBranch: 'target_unavailable',
      errorClass: 'PhaseRefused', message: 'External Action phase refused',
      ...(actionId === 'private-authored-action' ? {} : { actionId }),
    });
    expect(JSON.stringify(log.mock.calls)).not.toContain('private-');
  });

  it('records only the status for an unrecognized mint response without leaking its body', async () => {
    const log = vi.spyOn(logger, 'warnLocalFile').mockImplementation(() => {});
    vi.spyOn(axios, 'post').mockResolvedValue({ status: 403,
      data: { error: 'private-refusal-code', token: 'private-response-token', body: 'private-response-body' } });
    await expect(executionAuthorizationOwner.mintExternalActionExecutionAuthorization({
      actionId: 'scm.diffSummary.result.list', machineId: 'private-machine-key', envelope,
      pat: 'private-terminal-credential', serverHttpBaseUrl: 'https://private-home.test',
    })).resolves.toEqual({ ok: false, code: 'invalid_token' });
    expect(log).toHaveBeenCalledWith('[external-action-phase]', {
      phase: 'authorization_mint_http_status', httpStatus: 403, actionId: 'scm.diffSummary.result.list',
      errorClass: 'PhaseRefused', message: 'External Action phase refused',
    });
    expect(JSON.stringify(log.mock.calls)).not.toContain('private-');
  });

  it.each([401, 403])('correlates a native Home mint refusal (%s) without disclosing its proof or response', async status => {
    const log = vi.spyOn(logger, 'warnLocalFile').mockImplementation(() => {});
    const requestId = '45ee9e08-acd9-4df7-a899-426badc7e635';
    vi.spyOn(axios, 'post').mockResolvedValue({ status, data: { error: 'invalid_token', privateDetail: 'private-refusal-body' } });
    expect(await executionAuthorizationOwner.mintExternalActionExecutionAuthorization({
      actionId: 'session.message.send', machineId: target.machineId, envelope: { ...envelope, requestId },
      pat: 'private-original-credential', serverHttpBaseUrl: 'https://home.test',
    })).toEqual({ ok: false, code: 'invalid_token' });
    expect(log).toHaveBeenCalledWith('[external-action-phase]', expect.objectContaining({
      phase: 'authorization_mint_http_status', httpStatus: status, requestId, actionId: 'session.message.send',
    }));
    expect(JSON.stringify(log.mock.calls)).not.toContain('private-original-credential');
    expect(JSON.stringify(log.mock.calls)).not.toContain('private-refusal-body');
  });

  it.each(['plain', 'e2ee'] as const)('prepares signed fresh-reset admission from exactly the %s input', async mode => {
    const reset = { source: { bindingKind: 'account' as const, ref: { service: { pluginId: 'example.usage', localId: 'quota' }, accountId: 'connected' } },
      recordId: 'paug_v1_abcdefgh', meterId: 'weekly', witness: { id: 'accepted', observedAtMs: 100 } };
    const resetTarget = { kind: 'machine' as const, machineId: target.machineId };
    const resetInput = { sessionId: 'session', localId: 'prepared', reset,
      initialInput: { content: mode === 'plain' ? { t: 'plain', v: { private: 'prepared work' } } : { t: 'encrypted', c: 'session-ciphertext' } } };
    const material = { type: 'dataKey' as const, machineKey: new Uint8Array(32).fill(19) };
    vi.spyOn(axios, 'post').mockImplementation(async (_url, body) => {
      if (String(_url).endsWith('/verify')) return { status: 200, data: { ok: true } };
      const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
      const admission = projectExternalActionPendingResetStartAdmissionV1(resetInput);
      if (request.envelope.v === 2) {
        expect(request.envelope).toMatchObject({ pendingResetStartAdmission: admission });
        expect(JSON.stringify(request.envelope)).not.toContain('session-ciphertext');
        expect(openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, envelope: request.envelope, material, binding: {
          serverIdentityId: 'srv_bob_home', accountId: 'bob', authentication: { kind: 'account', tokenEpoch: 7 },
          actionId: 'session.pending.resetStart.set', requestId: 'reset-request', target: resetTarget,
        } })).toEqual({ input: resetInput });
      } else expect(request.envelope.input).toEqual(resetInput);
      return { status: 200, data: { v: 1, token: 'reset-proof', binding: {
        accountId: 'bob', authentication: { kind: 'account', tokenEpoch: 7 },
        serverIdentityId: 'srv_bob_home', machineId: target.machineId, custodianAccountId: 'bob',
        installationId: 'alice-installation', actionId: 'session.pending.resetStart.set', requestId: 'reset-request', target: resetTarget,
        accountEncryptionMode: mode, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(request.envelope),
        pendingResetStartAdmission: admission,
      } } };
    });
    const request = { actionId: 'session.pending.resetStart.set', input: resetInput,
      requestId: 'reset-request', target: resetTarget, machineId: target.machineId, accountId: 'bob', accountEncryptionMode: mode,
      tokenEpochHint: 7, token: accountToken, serverId: 'bob-profile', serverIdentityId: 'srv_bob_home',
      serverHttpBaseUrl: 'https://bob-home.test', installationId: 'alice-installation', privateKey: keys.secretKey,
      ...(mode === 'e2ee' ? { material } : {}) };
    const prepared = await prepareExternalActionRequesterAccountAuthorization(request);
    expect(prepared).toMatchObject({ binding: { pendingResetStartAdmission: projectExternalActionPendingResetStartAdmissionV1(resetInput) } });
    if (!prepared?.requesterHttpProjection) throw new Error('Fresh-reset preparation did not admit requester signing');
    const path = `/v4/connect/qualified/provider-account-usage/history?${new URLSearchParams({ query: JSON.stringify({ recordId: reset.recordId, witness: reset.witness }) })}`;
    const headers = await prepared.requesterHttpProjection.createRequestHeaders({ effectActionId: request.actionId, method: 'GET', path });
    expect(headers?.[EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]).toBe('reset-proof');
    const signature = headers?.[EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER];
    if (!signature) throw new Error('Fresh-reset preparation did not sign its exact witness read');
    expect(verifyExternalActionMachineRequestV1({ authorizationToken: 'reset-proof', effectActionId: request.actionId,
      target: resetTarget, installationId: request.installationId, requestId: request.requestId, method: 'GET', path,
      signature, publicKey: keys.publicKey })).toBe(true);
    const accepted = prepared;
    vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
      if (String(url).endsWith('/verify')) return { status: 200, data: { ok: true } };
      const issued = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
      return { status: 200, data: { v: 1, token: accepted.token, binding: { ...accepted.binding,
        requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(issued.envelope),
        pendingResetStartAdmission: projectExternalActionPendingResetStartAdmissionV1({ ...resetInput, reset: { ...reset, meterId: 'substituted' } }) } } };
    });
    expect(await prepareExternalActionRequesterAccountAuthorization(request)).toBeNull();
    expect(await prepareExternalActionRequesterAccountAuthorization({ ...request,
      input: { ...resetInput, reset: { ...reset, witness: { id: 'accepted', observedAtMs: -1 } } } })).toBeNull();
  });

  it('derives read-only handoff preflight without custody and rejects a changed root digest', async () => {
    const root = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'original-root', binding: {
      accountId: 'bob', authentication: { kind: 'account', tokenEpoch: 7 }, serverIdentityId: 'srv_bob_home',
      machineId: 'source', custodianAccountId: 'alice', installationId: 'source-installation', actionId: 'session.handoff',
      requestId: 'original-request', requestEnvelopeDigest: 'a'.repeat(43), target: { kind: 'machine', machineId: 'source' },
      handoffAdmission: { sessionId: 'same-session', sourceMachineId: 'source', targetMachineId: 'target',
        sourceInstallationId: 'source-installation', targetInstallationId: 'target-installation' },
    } });
    let changeRoot = false;
    vi.spyOn(axios, 'post').mockImplementation(async (url, body, config) => {
      const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
      expect(request.handoffPreflight).toEqual({ authorization: root });
      expect(request.handoffContinuation).toBeUndefined();
      expect(config?.headers).not.toHaveProperty('Authorization');
      expect(verifyExternalActionMachineRequestV1({ authorizationToken: root.token, effectActionId: 'session.handoff',
        target: root.binding.target, installationId: 'source-installation', requestId: root.binding.requestId,
        method: 'POST', path: new URL(String(url)).pathname, body, publicKey: keys.publicKey,
        signature: String(config?.headers?.[EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]) })).toBe(true);
      return { status: 200, data: { v: 1, token: 'preflight-child', binding: { ...root.binding,
        machineId: 'target', installationId: 'target-installation', target: request.envelope.target,
        requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(request.envelope),
        handoffPreflight: { rootRequestId: root.binding.requestId,
          rootRequestEnvelopeDigest: changeRoot ? 'b'.repeat(43) : root.binding.requestEnvelopeDigest },
      } } };
    });
    const prepare = Reflect.get(executionAuthorizationOwner, 'prepareExternalActionHandoffPreflightAuthorization');
    expect(typeof prepare).toBe('function');
    if (typeof prepare !== 'function') return;
    const input = { authorization: root, input: { sessionId: 'same-session', sourceMachineId: 'source', targetMachineId: 'target' },
      machineId: 'target', sourceMachineId: 'source', sourceInstallationId: 'source-installation',
      privateKey: keys.secretKey, serverHttpBaseUrl: 'https://bob-home.test' };
    expect(await prepare(input)).toMatchObject({ token: 'preflight-child' });
    changeRoot = true;
    expect(await prepare(input)).toBeNull();
  });

  it('derives a handoff child from the retained exact root after Session quiescence and refuses a changed root binding', async () => {
    const origin = SessionActionRpcOriginV1Schema.parse({ v: 1,
      caller: { kind: 'session', sessionId: 'same-session', starterDepth: 1, turnDepth: 2 },
      sourceTurnId: 'original-turn', callerPermissionMode: 'default', requestId: 'original-request' });
    const root = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'original-root', binding: {
      accountId: 'bob', authentication: { kind: 'account', tokenEpoch: 7 }, serverIdentityId: 'srv_bob_home',
      machineId: 'source', custodianAccountId: 'alice', installationId: 'source-installation', actionId: 'session.handoff',
      requestId: origin.requestId, requestEnvelopeDigest: 'a'.repeat(43), target: { kind: 'machine', machineId: 'source' },
      sessionActionOrigin: origin, sessionActionSource: { machineId: 'source', installationId: 'source-installation' },
      handoffAdmission: { sessionId: 'same-session', sourceMachineId: 'source', targetMachineId: 'target',
        sourceInstallationId: 'source-installation', targetInstallationId: 'target-installation' },
    } });
    let changeRoot = false;
    const network = vi.spyOn(axios, 'post').mockImplementation(async (url, body, config) => {
      const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
      expect(request.handoffContinuation).toEqual({ authorization: root, handoffId: 'handoff' });
      expect(config?.headers).not.toHaveProperty('Authorization');
      expect(verifyExternalActionMachineRequestV1({ authorizationToken: root.token, effectActionId: 'session.handoff',
        target: root.binding.target, installationId: 'source-installation', requestId: root.binding.requestId,
        method: 'POST', path: new URL(String(url)).pathname, body, publicKey: keys.publicKey,
        signature: String(config?.headers?.[EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]) })).toBe(true);
      return { status: 200, data: { v: 1, token: 'handoff-child', binding: { ...root.binding,
        machineId: 'target', installationId: 'target-installation', target: request.envelope.target,
        actionId: 'session.handoff.status.get', requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(request.envelope),
        handoffContinuation: { rootRequestId: origin.requestId,
          rootRequestEnvelopeDigest: changeRoot ? 'b'.repeat(43) : root.binding.requestEnvelopeDigest, handoffId: 'handoff' },
      } } };
    });
    const prepare = Reflect.get(executionAuthorizationOwner, 'prepareExternalActionHandoffContinuationAuthorization');
    expect(typeof prepare).toBe('function');
    if (typeof prepare !== 'function') return;
    const input = { authorization: root, handoffId: 'handoff', actionId: 'session.handoff.status.get',
      input: { handoffId: 'handoff' }, machineId: 'target', sourceMachineId: 'source',
      sourceInstallationId: 'source-installation', privateKey: keys.secretKey, serverHttpBaseUrl: 'https://bob-home.test' };
    expect(await prepare(input)).toMatchObject({ token: 'handoff-child', binding: { sessionActionOrigin: origin,
      handoffContinuation: { handoffId: 'handoff', rootRequestId: origin.requestId } } });
    changeRoot = true;
    expect(await prepare(input)).toBeNull();
    expect(network).toHaveBeenCalledTimes(2);
  });

  it('signs the exact destination RPC with the explicitly admitted original source installation rather than impersonating the destination', async () => {
    const destination = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(29));
    const origin = SessionActionRpcOriginV1Schema.parse({ v: 1,
      caller: { kind: 'session', sessionId: 'lead', starterDepth: 1, turnDepth: 2 },
      sourceTurnId: 'turn-2', callerPermissionMode: 'read-only', causalPermissionAuthority: null, requestId: 'move' });
    const args = { actionId: 'projects.open', input: { workspace: { serverId: 'bob-profile',
      workspaceId: 'workspace', machineId: target.machineId, rootPath: '/destination' } }, requestId: 'move',
      sessionActionOrigin: origin, sourceMachineId: 'source-machine', target, machineId: target.machineId,
      accountId: 'bob', accountEncryptionMode: 'plain' as const, tokenEpochHint: 7, token: accountToken,
      serverId: 'bob-profile', serverIdentityId: 'srv_bob_home', serverHttpBaseUrl: 'https://bob-home.test',
      installationId: 'source-installation', privateKey: keys.secretKey };
    const events: string[] = [];
    let current = true;
    let retireDuringMint = false;
    // Currentness may read Home. Keep its real asynchronous boundary so this
    // distinguishes duplicate reads around purely local envelope construction.
    vi.spyOn(axios, 'get').mockImplementation(async () => {
      events.push('currentness');
      await new Promise(resolve => setTimeout(resolve, 20));
      return { status: 200, data: { current } };
    });
    const isCurrent = async () => (await axios.get<{ current: boolean }>('https://bob-home.test/currentness')).data.current;
    vi.spyOn(axios, 'post').mockImplementation(async (_url, body) => {
      events.push('mint');
      if (retireDuringMint) current = false;
      const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
      return { status: 200, data: { v: 1, token: 'original-source-proof', binding: {
        accountId: args.accountId, authentication: { kind: 'account', tokenEpoch: 7 },
        serverIdentityId: args.serverIdentityId, machineId: target.machineId, custodianAccountId: 'alice',
        installationId: 'destination-installation', actionId: args.actionId, requestId: args.requestId, target,
        accountEncryptionMode: 'plain', requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(request.envelope),
        sessionActionOrigin: origin, sessionActionSource: { machineId: args.sourceMachineId, installationId: args.installationId },
      } } };
    });
    const admitted = await prepareExternalActionRequesterAccountAuthorization({ ...args, isCurrent });
    expect(admitted).not.toBeNull();
    expect(events).toEqual(['currentness', 'mint', 'currentness']);
    if (!admitted) throw new Error('Original source authorization was not admitted');
    expect(admitted?.requesterHttpProjection).toBeUndefined();
    const createSourceExecution = Reflect.get(executionAuthorizationOwner, 'createExternalActionSourceMachineRpcExecution');
    expect(typeof createSourceExecution).toBe('function');
    if (typeof createSourceExecution !== 'function') return;
    const rpc = { authorization: admitted, effectActionId: args.actionId, target,
      sourceMachineId: args.sourceMachineId, sourceInstallationId: args.installationId,
      method: `${target.machineId}:${RPC_METHODS.PROJECTS_OPEN}`, requestId: 'rpc-move', params: { sealed: 'ciphertext' },
      privateKey: keys.secretKey };
    const execution = createSourceExecution(rpc);
    expect(execution).toMatchObject({ authorization: admitted, installationId: 'destination-installation' });
    if (!execution) throw new Error('Original source execution was not signed');
    const verification = { authorizationToken: admitted!.token, effectActionId: args.actionId, target,
      installationId: 'destination-installation', event: SOCKET_RPC_EVENTS.CALL, method: rpc.method,
      requestId: rpc.requestId, params: rpc.params, signature: execution.machineSignature };
    expect(verifyExternalActionMachineRpcRequestV1({ ...verification, publicKey: keys.publicKey })).toBe(true);
    expect(verifyExternalActionMachineRpcRequestV1({ ...verification, publicKey: destination.publicKey })).toBe(false);
    const domainInput = { serverId: 'bob-profile', environmentId: 'environment', domainId: 'domain' };
    const child = { action: 'deployments.domains.add' as const, role: 'template.domain:web', input: domainInput };
    await invokeHostReviewedChildV1({ parent: { actionId: args.actionId, input: args.input },
      context: { surface: 'cli', runtimeAccountId: 'bob', externalActionExecutionAuthorization: admitted,
        externalActionTarget: target }, child,
      admittedReview: { action: child.action, role: child.role, surface: 'cli' },
      execute: async (_input, context) => {
        const childRpc = { ...rpc, context, effectActionId: child.action };
        const childExecution = createSourceExecution(childRpc);
        const reviewedChild = { actionId: child.action, role: child.role,
          inputDigest: computeActionInputApprovalDigestV1(child.action, domainInput) };
        expect(childExecution?.reviewedChild).toEqual(reviewedChild);
        expect(verifyExternalActionMachineRpcRequestV1({ ...verification, effectActionId: child.action,
          reviewedChild, signature: childExecution.machineSignature, publicKey: keys.publicKey })).toBe(true);
        expect(createSourceExecution({ ...childRpc, context: JSON.parse(JSON.stringify(context)) })?.reviewedChild).toBeUndefined();
        return { ok: true as const, result: {} };
      } });
    expect(createSourceExecution({ ...rpc, sourceMachineId: 'different-source' })).toBeNull();
    expect(createSourceExecution({ ...rpc, sourceInstallationId: 'retired-installation' })).toBeNull();
    events.length = 0;
    current = false;
    expect(await prepareExternalActionRequesterAccountAuthorization({ ...args, isCurrent })).toBeNull();
    expect(events).toEqual(['currentness']);
    events.length = 0;
    current = true;
    retireDuringMint = true;
    expect(await prepareExternalActionRequesterAccountAuthorization({ ...args, isCurrent })).toBeNull();
    expect(events).toEqual(['currentness', 'mint', 'currentness']);
    events.length = 0;
    expect(await prepareExternalActionRequesterAccountAuthorization({ ...args, isCurrent, signal: AbortSignal.abort() })).toBeNull();
    expect(events).toEqual([]);
  });

  it.each(['current', 'changed-origin'] as const)('authenticates the admitted Session origin with the incumbent installation proof and refuses %s mint substitution', async (resultKind) => {
    const sessionActionOrigin = SessionActionRpcOriginV1Schema.parse({ v: 1,
      caller: { kind: 'session', sessionId: 'lead', starterDepth: 1, turnDepth: 2 },
      sourceTurnId: 'turn-2', callerPermissionMode: 'yolo', causalPermissionAuthority: null, requestId: 'session-acquire' });
    const args = { actionId: 'machines.managed.acquire', input: { enrollmentIdentity: { kind: 'existingUser', role: 'personal' }, selection: { kind: 'one-off',
      homeId: 'srv_bob_home', controller: { machineId: target.machineId, installationId: 'alice-installation' },
      launch: { provider: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, name: 'guest', choices: {} },
      retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false } },
      requestId: sessionActionOrigin.requestId, sessionActionOrigin, sourceMachineId: target.machineId, target, machineId: target.machineId,
      accountId: 'bob', accountEncryptionMode: 'plain' as const, tokenEpochHint: 7, token: accountToken,
      serverId: 'bob-profile', serverIdentityId: 'srv_bob_home', serverHttpBaseUrl: 'https://bob-home.test',
      installationId: 'alice-installation', privateKey: keys.secretKey };
    let authenticatedOrigin = false;
    vi.spyOn(axios, 'post').mockImplementation(async (url, body, config) => {
      if (String(url).endsWith('/verify')) return { status: 200, data: { ok: true } };
      expect(config?.headers).toMatchObject({ Authorization: `Bearer ${args.token}` });
      const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
      expect(body).toMatchObject({ sessionActionOrigin, sessionActionSource: { machineId: args.sourceMachineId, installationId: args.installationId } });
      // The intercepted HTTP body is unknown transport data; parse the real
      // proof schema before using it at the installation authentication boundary.
      if (!body || typeof body !== 'object') throw new Error('Missing installation-authenticated HTTP carrier');
      const proof = MachineInstallationProofV1Schema.parse(Reflect.get(body, 'installationProof'));
      const payload = { version: 1 as const, machineId: args.machineId, installationId: args.installationId, accountId: args.accountId,
        externalActionOrigin: { homeId: args.serverIdentityId, actionId: args.actionId, requestId: args.requestId,
          requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(request.envelope), origin: sessionActionOrigin } };
      authenticatedOrigin = verifyMachineInstallationProof({ payload, proof, publicKey: keys.publicKey });
      expect(authenticatedOrigin).toBe(true);
      expect(verifyMachineInstallationProof({ payload: { ...payload, externalActionOrigin: {
        ...payload.externalActionOrigin, origin: { ...sessionActionOrigin, sourceTurnId: 'other-turn' },
      } }, proof, publicKey: keys.publicKey })).toBe(false);
      return { status: 200, data: { v: 1, token: 'session-origin-proof', binding: {
        accountId: args.accountId, authentication: { kind: 'account', tokenEpoch: args.tokenEpochHint },
        serverIdentityId: args.serverIdentityId, machineId: args.machineId, custodianAccountId: 'alice',
        installationId: args.installationId, actionId: args.actionId, requestId: args.requestId, target,
        accountEncryptionMode: 'plain', requestEnvelopeDigest: payload.externalActionOrigin.requestEnvelopeDigest,
        sessionActionOrigin: resultKind === 'current' ? sessionActionOrigin : { ...sessionActionOrigin, sourceTurnId: 'other-turn' },
        sessionActionSource: { machineId: args.sourceMachineId, installationId: args.installationId },
      } } };
    });
    const prepared = await prepareExternalActionRequesterAccountAuthorization(args);
    if (resultKind === 'changed-origin') expect(prepared).toBeNull();
    else expect(prepared).toMatchObject({ token: 'session-origin-proof', binding: { sessionActionOrigin },
      requesterHttpProjection: { accountId: 'bob' } });
    expect(authenticatedOrigin).toBe(true);
  });

  it('mounts exact Home signing ports at real ingress without custodian bearer or private Account material', async () => {
    const network = vi.spyOn(axios, 'post').mockImplementation(async (url) => {
      expect(url).toBe('https://bob-home.test/v1/actions/notifications.notify_me/execution-authorization/verify');
      return { status: 200, data: { ok: true } };
    });
    let captured: ActionExecutorContext | undefined;
    const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(),
      notificationsNotifyMe: async (_input, context) => {
        captured = context;
        const projection = context.externalActionExecutionAuthorization?.requesterHttpProjection;
        const headers = await projection?.createRequestHeaders({ effectActionId: 'notifications.notify_me',
          method: 'POST', path: '/v1/projects/account-rows/list', body: {} });
        expect(headers).not.toHaveProperty('Authorization');
        expect(headers?.[EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]).toBe(authorization.token);
        const signature = headers?.[EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER];
        const valid = signature && verifyExternalActionMachineRequestV1({
          authorizationToken: authorization.token, effectActionId: 'notifications.notify_me', target,
          installationId: 'alice-installation', requestId: envelope.requestId,
          method: 'POST', path: '/v1/projects/account-rows/list', body: {}, publicKey: keys.publicKey, signature,
        });
        return { attemptedChannels: 1, deliveredChannels: valid ? 1 : 0 };
      },
    });
    const result = await executeExternalAction({ actionId: 'notifications.notify_me', envelope, principal,
      currentMachineId: target.machineId, currentServerId: 'bob-profile', currentServerHttpBaseUrl: 'https://bob-home.test',
      currentInstallationId: 'alice-installation', executionAuthorization: authorization,
      externalActionMachineRequestPrivateKey: keys.secretKey,
      verifyExecutionAuthorization: (input) => verifyExternalActionExecutionAuthorizationCurrent({ ...input,
        installationId: 'alice-installation', privateKey: keys.secretKey, serverHttpBaseUrl: 'https://bob-home.test' }),
      resolveTarget: createDaemonExternalActionTargetResolver({ credentials: { token: 'alice-daemon', encryption: null } }), executor,
    });
    expect(result).toMatchObject({ kind: 'response', response: { execution: {
      ok: true, result: { attemptedChannels: 1, deliveredChannels: 1 },
    } } });
    expect(captured?.externalActionExecutionAuthorization?.requesterHttpProjection).toMatchObject({
      accountId: 'bob', serverId: 'bob-profile', serverIdentityId: 'srv_bob_home',
      serverHttpBaseUrl: 'https://bob-home.test', accountEncryptionMode: 'plain',
    });
    expect(captured?.externalActionExecutionAuthorization?.requesterAccountProjection).toBeUndefined();
    expect(JSON.stringify(captured?.externalActionExecutionAuthorization)).not.toContain('requesterHttpProjection');
    expect(network).toHaveBeenCalled();
  });

  it('withholds headers when Home authorization is retired while the currentness response awaits', async () => {
    let retired = false;
    vi.spyOn(axios, 'post').mockImplementation(async () => ({ status: retired ? 403 : 200,
      data: retired ? {} : { ok: true } }));
    const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(),
      notificationsNotifyMe: async (_input, context) => {
        const projection = context.externalActionExecutionAuthorization?.requesterHttpProjection;
        expect(projection).toBeDefined();
        vi.spyOn(axios, 'post').mockImplementation(async () => {
          const status = retired ? 403 : 200;
          retired = true;
          return { status, data: { ok: true } };
        });
        const headers = await projection!.createRequestHeaders({ effectActionId: 'notifications.notify_me',
          method: 'POST', path: '/v1/projects/account-rows/list', body: {} });
        expect(headers).toBeNull();
        expect(headers?.[EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]).toBeUndefined();
        return { attemptedChannels: 1, deliveredChannels: 0 };
      },
    });
    await executeExternalAction({ actionId: 'notifications.notify_me', envelope, principal,
      currentMachineId: target.machineId, currentServerId: 'bob-profile', currentServerHttpBaseUrl: 'https://bob-home.test',
      currentInstallationId: 'alice-installation', executionAuthorization: authorization,
      externalActionMachineRequestPrivateKey: keys.secretKey,
      verifyExecutionAuthorization: (input) => verifyExternalActionExecutionAuthorizationCurrent({ ...input,
        installationId: 'alice-installation', privateKey: keys.secretKey, serverHttpBaseUrl: 'https://bob-home.test' }),
      resolveTarget: createDaemonExternalActionTargetResolver({ credentials: { token: 'alice-daemon', encryption: null } }), executor,
    });
    expect(retired).toBe(true);
  });

  it.each(['plain', 'e2ee', 'legacy'] as const)('prepares original %s Account authority through the existing Home minter', async (credentialKind) => {
    const accountEncryptionMode = credentialKind === 'plain' ? 'plain' as const : 'e2ee' as const;
    const recoverySecret = new Uint8Array(32).fill(21);
    const material = { type: 'dataKey' as const, machineKey: credentialKind === 'legacy'
      ? deriveAccountMachineKeyFromRecoverySecret(recoverySecret) : recoverySecret };
    const args = { actionId: 'notifications.notify_me', input: envelope.input, requestId: envelope.requestId,
      target, machineId: target.machineId, accountId: 'bob', accountEncryptionMode, tokenEpochHint: 7,
      token: accountToken, ...(accountEncryptionMode === 'e2ee' ? { material } : {}),
      serverId: 'bob-profile', serverIdentityId: 'srv_bob_home', serverHttpBaseUrl: 'https://bob-home.test',
      installationId: 'alice-installation', privateKey: keys.secretKey };
    vi.spyOn(axios, 'post').mockImplementation(async (url, body, config) => {
      if (String(url).endsWith('/verify')) return { status: 200, data: { ok: true } };
      const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
      expect(config?.headers).toMatchObject({ Authorization: `Bearer ${args.token}` });
      expect(request.envelope.v).toBe(accountEncryptionMode === 'e2ee' ? 2 : 1);
      if (request.envelope.v === 2) {
        if (credentialKind === 'legacy') {
          expect(openAccountScopedBlobCiphertext({ kind: 'external_action_transport',
            material: { type: 'legacy', secret: recoverySecret }, ciphertext: request.envelope.payload.c })?.value)
            .toMatchObject({ input: envelope.input, authentication: { kind: 'account', tokenEpoch: 7 } });
        }
        expect(openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, envelope: request.envelope, material,
          binding: { serverIdentityId: args.serverIdentityId, accountId: args.accountId,
            authentication: { kind: 'account', tokenEpoch: args.tokenEpochHint }, actionId: args.actionId,
            requestId: args.requestId, target } })?.input).toEqual(envelope.input);
        expect(JSON.stringify(body)).not.toContain('Opened');
      }
      return { status: 200, data: { v: 1, token: 'bob-original-proof', binding: {
        serverIdentityId: args.serverIdentityId, accountId: args.accountId,
        authentication: { kind: 'account', tokenEpoch: args.tokenEpochHint }, actionId: args.actionId,
        requestId: args.requestId, target, machineId: target.machineId, custodianAccountId: 'alice',
        installationId: args.installationId, accountEncryptionMode,
        requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(request.envelope),
      } } };
    });
    if (accountEncryptionMode === 'e2ee') {
      // Exercise fixture sealing outside the owner's fail-closed catch so a
      // malformed crypto fixture reports its actual canonical schema failure.
      sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, binding: { serverIdentityId: args.serverIdentityId, accountId: args.accountId,
        authentication: { kind: 'account', tokenEpoch: args.tokenEpochHint }, actionId: args.actionId,
        requestId: args.requestId, target }, input: args.input, material,
        randomBytes: (length) => new Uint8Array(length).fill(19) });
    }
    const prepared = await prepareExternalActionRequesterAccountAuthorization(args);
    expect(prepared).toMatchObject({ token: 'bob-original-proof', requesterHttpProjection: {
      accountId: 'bob', serverId: 'bob-profile', accountEncryptionMode,
    } });
  });

  it.each(['profile', 'epoch', 'proof'] as const)('refuses original Account %s mismatch without producing HTTP authority', async (mismatch) => {
    const args = { actionId: 'notifications.notify_me', input: envelope.input, requestId: envelope.requestId,
      target, machineId: target.machineId, accountId: 'bob', accountEncryptionMode: 'e2ee' as const,
      tokenEpochHint: 7, token: accountToken,
      material: { type: 'dataKey' as const, machineKey: new Uint8Array(32).fill(21) },
      serverId: 'bob-profile', serverIdentityId: 'srv_bob_home', serverHttpBaseUrl: 'https://bob-home.test',
      installationId: 'alice-installation', privateKey: keys.secretKey };
    vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
      if (String(url).endsWith('/verify')) return { status: 200, data: { ok: true } };
      const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
      return { status: 200, data: { v: 1, token: 'mismatched-proof', binding: {
        serverIdentityId: args.serverIdentityId, accountId: mismatch === 'profile' ? 'mallory' : args.accountId,
        authentication: { kind: 'account', tokenEpoch: mismatch === 'epoch' ? 8 : args.tokenEpochHint },
        actionId: args.actionId, requestId: args.requestId, target, machineId: target.machineId,
        custodianAccountId: 'alice', installationId: args.installationId, accountEncryptionMode: 'e2ee',
        requestEnvelopeDigest: mismatch === 'proof' ? 'a'.repeat(43)
          : computeExternalActionRequestEnvelopeDigestV1(request.envelope),
      } } };
    });
    expect(await prepareExternalActionRequesterAccountAuthorization(args)).toBeNull();
  });

  it('does not downgrade E2EE without material, or retain authority when custody expires during mint', async () => {
    let current = true;
    const args = { actionId: 'notifications.notify_me', input: envelope.input, requestId: envelope.requestId,
      target, machineId: target.machineId, accountId: 'bob', accountEncryptionMode: 'e2ee' as const,
      tokenEpochHint: 7, token: accountToken, serverId: 'bob-profile', serverIdentityId: 'srv_bob_home',
      serverHttpBaseUrl: 'https://bob-home.test', installationId: 'alice-installation', privateKey: keys.secretKey,
      isCurrent: async () => current };
    const network = vi.spyOn(axios, 'post').mockImplementation(async (_url, body) => {
      const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
      current = false;
      return { status: 200, data: { v: 1, token: 'retired-proof', binding: {
        serverIdentityId: args.serverIdentityId, accountId: args.accountId,
        authentication: { kind: 'account', tokenEpoch: args.tokenEpochHint }, actionId: args.actionId,
        requestId: args.requestId, target, machineId: target.machineId, custodianAccountId: 'alice',
        installationId: args.installationId, accountEncryptionMode: args.accountEncryptionMode,
        requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(request.envelope),
      } } };
    });
    expect(await prepareExternalActionRequesterAccountAuthorization(args)).toBeNull();
    expect(network).not.toHaveBeenCalled();
    expect(await prepareExternalActionRequesterAccountAuthorization({ ...args,
      material: { type: 'dataKey', machineKey: new Uint8Array(32).fill(21) } })).toBeNull();
    expect(current).toBe(false);
  });
});

function contextForReviewedChild(): ActionExecutorContext {
  return { surface: 'cli', authority: 'account_automation', runtimeAccountId: 'bob', externalActionTarget: target };
}
