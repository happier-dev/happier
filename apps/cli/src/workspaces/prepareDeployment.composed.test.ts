import axios from 'axios';
import { validatePreparedDeploymentHead } from './prepareDeploymentValidation.composed.testkit';
import childProcess from 'child_process';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, onTestFinished, vi } from 'vitest';
import { createActionExecutor, listActionSpecsForSurface, DeploymentPrepareResultV1Schema, FeaturesResponseSchema, type DeploymentPrepareInputV1, type ScmActionId } from '@happier-dev/protocol';
import { emptyConnectedAccountCatalogRecordV1, sealConnectedAccountCatalogContentV1, ConnectedAccountCatalogRowReadResponseV1Schema } from '@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1';
import { createGithubScmHostingProviderAdapter, createGithubRestAdapter } from '@happier-dev/plugins-scm-github';
import type { AgentSessionRuntime, AgentSessionRuntimeContext } from '@happier-dev/plugin-sdk/agents/runtime';
import * as persistence from '@/persistence';
import { SessionMessageContentSchema, UserMessageSchema } from '@/api/types';
import { buildCommittedLaunchMetadata } from '@/agent/runtime/createSessionMetadata';
import { createNativeAgentSessionOperations } from '@/agent/runtime/registry/engineRegistry/nativeAgentSession';
import { prepareSessionCreationTarget } from '@/session/creation/prepareSessionCreationTarget';
import { openSessionStoredContent } from '@/session/transport/encryption/sessionEncryptionContext';
import { resetActiveAccountSettingsSnapshotForTests } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { createBareGitRemoteFixture } from '@/testkit/scm/scmBackendContractFixtures';
import { createDeploymentGitRegistry } from '@/deployments/targets/ownServer/exactCommitRelease.testkit';
import { createScmHostingProviderRegistry } from '@/scm/hostingProviders/registry';
import { executeScmActionOperation } from '@/scm/actions/executeScmActionOperation';
import { isHostGitPush } from '@/scm/gitHostTransport';
import { createDeploymentEnvironmentHeaderV1, createDeploymentTargetLinkHeaderV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { createCliActionDeps } from '@/session/actions/createCliActionDeps';
import { createGitWorkspace, runGit } from '@/scm/rpc/__tests__/testRpcHarness';
import { createPlainProjectAccountRefRow, projectAccountRowsReadHttpResponse } from './projectAccountRows.testkit';
import { withdrawActiveProjectAccountRowsSnapshot } from './projectAccountRows';
import { removeTempDir } from '@/testkit/fs/tempDir';
import nacl from 'tweetnacl';
import { EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER, EXTERNAL_ACTION_EFFECT_ACTION_HEADER, EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER, ExternalActionExecutionAuthorizationRequestV1Schema, ExternalActionExecutionAuthorizationV1Schema, ExternalActionRequestEnvelopeSchema, projectDeploymentPreparationAdmissionV1, projectExternalActionDeploymentPreparationEnvelopeAdmissionV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1, verifyExternalActionMachineRequestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { admitRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionProjection';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';
import { projectExternalActionRequesterHttpAuthorization } from '@/api/externalActionExecutionAuthorization';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createAccountEncryptionCurrentnessFixture, createSessionRecordFixture, createSessionNotificationContextFixture } from '@/testkit/backends/sessionFixtures';
import type { SessionActionRpcOriginV1, SocketRpcMachineAdmissionContextV1 } from '@happier-dev/protocol/socketRpc';
import type { ExternalActionExecutionAuthorizationV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { SessionLookupByTagsRequestV2Schema } from '@happier-dev/protocol/sessions/control/contract';
import { managedMachineActionEndpointPathV1, ManagedListInputV1Schema, ManagedListOutputV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';
import { readPendingLocalId } from '@happier-dev/protocol/sessions/pending/pendingLocalId';

import { createDaemonSessionAccountActionExecutor } from '@/daemon/agentRuntime/createDaemonSessionAccountActionExecutor';
import { readSessionInputRequest } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';

afterEach(() => {
  vi.restoreAllMocks(); syncBuiltinESMExports(); vi.unstubAllGlobals();
  resetActiveAccountSettingsSnapshotForTests(); withdrawActiveProjectAccountRowsSnapshot();
});
// Both composed suites publish into the same daemon controller lifetime.
afterAll(() => pluginReloadController.shutdown());

const token = `header.${Buffer.from(JSON.stringify({ sub: 'prepare-account', tokenEpoch: 1,
  provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.signature`;
const repository = { kind: 'github' as const, deployment: 'https://github.com', repository: 'prepare/app' };
const installationKeys = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(27));
const publicKey = Buffer.from(installationKeys.publicKey).toString('base64');
type BoundRead = Readonly<{ headers: unknown; method: 'GET' | 'POST'; path: string; body?: unknown; effectActionId: string }>;
function verifiesPrepareRead(read: BoundRead) {
  const headers = read.headers && typeof read.headers === 'object' ? read.headers : {};
  return Reflect.get(headers, EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER) === 'prepare-proof'
    && Reflect.get(headers, EXTERNAL_ACTION_EFFECT_ACTION_HEADER) === read.effectActionId
    && verifyExternalActionMachineRequestV1({ authorizationToken: 'prepare-proof', effectActionId: read.effectActionId,
      target: { kind: 'machine', machineId: 'workspace-daemon' }, installationId: 'workspace-installation',
      requestId: 'prepare-request', method: read.method, path: read.path, ...(read.body === undefined ? {} : { body: read.body }),
      signature: String(Reflect.get(headers, EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER) ?? ''), publicKey: installationKeys.publicKey });
}

function fixture(options: Readonly<{ isCredentialCurrent?: () => boolean; signal?: AbortSignal; onSourceRead?: () => void }> = {}) {
  const rootPath = createGitWorkspace('happier-prepare-');
  onTestFinished(() => removeTempDir(rootPath));
  runGit(rootPath, ['commit', '--allow-empty', '-m', 'base']);
  runGit(rootPath, ['remote', 'add', 'origin', 'https://github.com/prepare/app.git']);
  const baseCommit = runGit(rootPath, ['rev-parse', 'HEAD']);
  const workspace = { id: 'workspace', serverId: 'prepare-home', machineId: 'workspace-daemon', rootPath,
    createdAtMs: 1, repositoryIdentity: repository, source: { sourceId: 'source', revision: 3 } };
  const input = { projectSourceId: 'source', sourceRevision: 3, repository, baseCommit,
    workspace: { kind: 'workspace-ref' as const, serverId: workspace.serverId, id: workspace.id } };
  let sourceRevision = 3;
  let includeController = false;
  let requireBoundReads = false;
  let denySource = false;
  let machineCustodianAccountId = 'prepare-account';
  let actionsSettings = normalizeActionsSettingsV1({ v: 1, actions: {} });
  let rawSession = { ...createSessionNotificationContextFixture('prepared-session'),
    ...createSessionRecordFixture({ id: 'prepared-session', active: true, encryptionMode: 'plain',
      machineId: workspace.machineId, metadata: JSON.stringify({ machineId: workspace.machineId, path: rootPath }), dataEncryptionKey: null }) };
  const launches: unknown[] = [];
  const accepted: ReturnType<typeof UserMessageSchema.parse>[] = [];
  const boundReads: BoundRead[] = [];
  const recordReadCustody = (read: typeof boundReads[number]) => {
    if (!requireBoundReads) return;
    boundReads.push(read);
  };
  const environment = createDeploymentEnvironmentHeaderV1({ id: 'staging', serverId: workspace.serverId,
    projectSourceId: 'source', controllerMachineId: 'another-controller' });
  const targetLink = createDeploymentTargetLinkHeaderV1({ environmentId: environment.id });
  const source = () => ({ id: 'source', revision: sourceRevision, name: 'App', audience: [], createdByAccountId: 'prepare-account',
    repository: { provider: { id: 'happier.scm.forge.github/github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' },
      repository: { nameWithOwner: 'prepare/app', cloneUrl: 'https://github.com/prepare/app.git' }, protocol: 'https' } });
  vi.spyOn(axios, 'request').mockImplementation(async config => {
    if (config.method === 'POST' && new URL(String(config.url)).pathname === managedMachineActionEndpointPathV1('machines.managed.list')) {
      ManagedListInputV1Schema.parse(config.data);
      return { status: 200, data: ManagedListOutputV1Schema.parse({ machines: [] }) };
    }
    expect(config.method).toBe('GET');
    const url = new URL(String(config.url));
    const read: BoundRead = { headers: config.headers, method: 'GET', path: `${url.pathname}${url.search}`,
      effectActionId: String(config.url).includes('/v1/projects/sources/') ? 'projects.sources.read' : 'deployments.environments.get' };
    recordReadCustody(read);
    if (String(config.url).includes('/v1/deployments/environments/')) return { status: 200, data: { ok: true, environment, targetLinks: [targetLink] } };
    expect(config.url).toBe('https://prepare-home.test/v1/projects/sources/source?serverId=prepare-home');
    if (denySource) return { status: verifiesPrepareRead(read) ? 403 : 401, data: { error: 'forbidden' } };
    options.onSourceRead?.();
    return { status: 200, data: { ok: true, source: source(), canManage: true } };
  });
  vi.spyOn(axios, 'get').mockImplementation(async url => {
    if (String(url).includes('/v2/sessions/prepared-session')) return { status: 200, data: { session: rawSession } };
    if (String(url).includes('/v1/account/entity-rows/connected-accounts/purposes')) return { status: 200,
      data: ConnectedAccountCatalogRowReadResponseV1Schema.parse({ status: 'present', revision: 1,
        content: sealConnectedAccountCatalogContentV1({ mode: 'plain', material: null,
          record: emptyConnectedAccountCatalogRecordV1('purposes') }) }) };
    if (String(url).includes('/v2/account/settings/history')) return { status: 200, data: { snapshots: [] } };
    if (String(url).includes('/v2/sessions/prepare-caller')) return { status: 200,
      data: { session: { ...createSessionNotificationContextFixture('prepare-caller'),
        ...createSessionRecordFixture({ id: 'prepare-caller', encryptionMode: 'plain', machineId: workspace.machineId,
          metadata: JSON.stringify({ machineId: workspace.machineId, path: rootPath }), dataEncryptionKey: null }) } } };
    if (String(url).endsWith('/v1/account/profile')) return { status: 200, data: { id: 'prepare-account' } };
    if (String(url).endsWith('/v2/account/settings')) return { status: 200,
      data: { content: { t: 'plain', v: { actionsSettingsV1: actionsSettings } }, version: 1 } };
    if (String(url).endsWith('/v1/account/encryption/currentness')) return { status: 200, data: { mode: 'plain', version: 1,
      signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
    if (String(url).endsWith('/v1/account/encryption')) return { status: 200, data: { mode: 'plain', updatedAt: 0 } };
    const machine = { id: workspace.machineId, kind: 'persistent', active: true,
      installationId: 'workspace-installation', installationPublicKey: publicKey,
      revokedAt: null, replacedByMachineId: null, storageMode: 'plain',
      access: { custodian: { accountId: machineCustodianAccountId, displayName: 'Owner' }, role: 'manage', resourceMode: 'plain', accessState: 'ready' } };
    if (String(url).endsWith('/v1/machines')) return { status: 200, data: [machine,
      ...(includeController ? [{ ...machine, id: 'another-controller' }] : [])] };
    if (String(url).endsWith(`/v1/machines/${workspace.machineId}`)) return { status: 200, data: { machine } };
    throw new Error(`Unexpected read: ${url}`);
  });
  const dispatched: unknown[] = [];
  const prepareDispatches: unknown[] = [];
  let loseReply = false;
  let childExecution: unknown = { ok: true, result: { type: 'success', disposition: 'created', sessionId: 'prepared-session',
    executionTarget: { serverId: workspace.serverId, machineId: workspace.machineId },
    organizationPlacement: { sectionId: null, tagIds: [] }, initialInput: { status: 'accepted', localId: 'initial-input' } } };
  const post = vi.spyOn(axios, 'post').mockImplementation(async (url, body, config) => {
    if (String(url) === 'https://prepare-home.test/v2/sessions/lookup-by-tags') {
      SessionLookupByTagsRequestV2Schema.parse(body);
      return { status: 200, data: { sessions: [] } };
    }
    if (String(url) === 'https://prepare-home.test/v2/sessions/prepared-session/pending') {
      if (!body || typeof body !== 'object') throw new Error('Missing pending input');
      const localId = readPendingLocalId(Reflect.get(body, 'localId'));
      if (!localId) throw new Error('Missing pending input identity');
      const content = SessionMessageContentSchema.parse(Reflect.get(body, 'content'));
      accepted.push(UserMessageSchema.parse(openSessionStoredContent({ mode: 'plain', ctx: null, content })));
      return { status: 200, data: { didWrite: true, message: { localId } } };
    }
    if (String(url).endsWith('/verify')) return { status: 200, data: { ok: true } };
    if (String(url).includes('/v1/account/project-rows/')) {
      recordReadCustody({ headers: config?.headers, method: 'POST', path: new URL(String(url)).pathname, body,
        effectActionId: 'deployments.prepare' });
      return projectAccountRowsReadHttpResponse([createPlainProjectAccountRefRow(workspace)], String(url), body);
    }
    if (!String(url).startsWith('https://prepare-home.test/v1/actions/')) {
      throw new Error(`Unexpected POST: ${url}`);
    }
    const actionId = String(url).includes('/deployments.prepare') ? 'deployments.prepare'
      : String(url).includes('/session.message.send') ? 'session.message.send' : 'session.spawn_new';
    // Session input uses the ordinary Account envelope; Machine custody uses
    // the authorization wrapper. Preserve both real HTTP boundary contracts.
    const request = actionId === 'session.message.send'
      ? { envelope: ExternalActionRequestEnvelopeSchema.parse(body), executionAuthorization: undefined }
      : ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
    if (actionId === 'session.message.send') expect(config?.headers?.Authorization).toBe(`Bearer ${token}`);
    if (String(url).endsWith('/execution-authorization')) return { status: 200, data: { v: 1, token: 'session-proof', binding: {
      accountId: 'prepare-account', authentication: { kind: 'account', tokenEpoch: 1 }, accountEncryptionMode: 'plain',
      serverIdentityId: 'prepare-home', custodianAccountId: 'prepare-account', machineId: workspace.machineId,
      installationId: 'workspace-installation', actionId, requestId: 'prepare-request',
      target: request.envelope.target, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(request.envelope),
      ...(actionId === 'deployments.prepare' ? { deploymentPreparationAdmission:
        projectExternalActionDeploymentPreparationEnvelopeAdmissionV1({ actionId, envelope: request.envelope }) } : {}),
    } } };
    if (actionId === 'deployments.prepare') {
      prepareDispatches.push(request.envelope);
      return { status: 200, data: { v: 1, actionId, requestId: 'prepare-request', execution: { ok: true,
        result: { kind: 'handedOff', sessionRef: { serverId: workspace.serverId, sessionId: 'prepared-session' } } } } };
    }
    expect(url).toBe(`https://prepare-home.test/v1/actions/${actionId}`);
    if (actionId === 'session.spawn_new') expect(request.executionAuthorization?.requesterAccountContext).toBeDefined();
    dispatched.push(request.envelope);
    if (loseReply) throw Object.assign(new Error('Connection lost after submission'), { code: 'ECONNRESET' });
    return { status: 200, data: { v: 1, actionId, requestId: 'prepare-request', execution: childExecution } };
  });
  const deps = createCliActionDeps({ token, credentials: { token, encryption: null }, sessionId: '', mode: 'plain', ctx: null,
    serverId: workspace.serverId, serverIdentityId: 'prepare-home', serverHttpBaseUrl: 'https://prepare-home.test',
    isCredentialCurrent: options.isCredentialCurrent,
    machineActionDirectTargetTransport: { machineId: workspace.machineId, invoke: async () => { throw new Error('No remote native effect'); } } });
  const execute = (next: DeploymentPrepareInputV1 = input) => createActionExecutor(deps).execute('deployments.prepare', next,
    { surface: 'ui', authority: 'present_user', serverId: workspace.serverId, runtimeAccountId: 'prepare-account',
      actionCaller: { kind: 'host' }, actionRequestId: 'prepare-request', signal: options.signal,
      externalActionTarget: { kind: 'machine', machineId: workspace.machineId } });
  return { input, execute, dispatched, prepareDispatches, post, rootPath, environment, targetLink, boundReads, launches, accepted,
    setActionsSettings(next: typeof actionsSettings) { actionsSettings = next; },
    denySource() { denySource = true; }, setSourceRevision(value: number) { sourceRevision = value; },
    admit: async (foreignCustodian = false, next: DeploymentPrepareInputV1 = input, origin?: SessionActionRpcOriginV1,
      workflowOrigin?: ExternalActionExecutionAuthorizationV1['binding']['workflowActionOrigin'],
      getCurrentTurnWorkDepth?: (turnId?: string) => number | undefined) => {
      machineCustodianAccountId = foreignCustodian ? 'daemon-owner' : 'prepare-account';
      const socket = await createRequesterCurrentnessSocketHarness();
      onTestFinished(() => socket.close());
      let current = true;
      const envelope = ExternalActionRequestEnvelopeSchema.parse({ v: 1, requestId: 'prepare-request',
        target: { kind: 'machine', machineId: workspace.machineId }, input: next });
      const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'prepare-proof', binding: {
        accountId: 'prepare-account', authentication: { kind: 'account', tokenEpoch: 1 }, accountEncryptionMode: 'plain',
        serverIdentityId: workspace.serverId, custodianAccountId: machineCustodianAccountId, machineId: workspace.machineId,
        installationId: 'workspace-installation', actionId: 'deployments.prepare', requestId: 'prepare-request',
        target: envelope.target, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
        deploymentPreparationAdmission: projectDeploymentPreparationAdmissionV1('deployments.prepare', next),
        ...(origin ? { sessionActionOrigin: origin,
          sessionActionSource: { machineId: workspace.machineId, installationId: 'workspace-installation' } } : {}),
        ...(workflowOrigin ? { workflowActionOrigin: workflowOrigin } : {}),
      } });
      // Home authorization and HTTP/socket endpoints are the boundaries; the
      // private requester admission, custody, Settings and child dispatch stay real.
      const admitted = await admitRequesterAccountActionContext({ authorization, credentials: { token, encryption: null },
        invocation: origin ? { caller: origin.caller, surface: 'agent', authority: 'account_automation' }
          : workflowOrigin ? { caller: { kind: 'workflowRun', runId: workflowOrigin.runId }, surface: 'agent', authority: 'account_automation' }
          : { caller: { kind: 'host' }, surface: 'ui', authority: 'present_user' },
        serverId: workspace.serverId, serverIdentityId: workspace.serverId, serverHttpBaseUrl: 'https://prepare-home.test',
        isCurrent: async () => current });
      if (!admitted) throw new Error('Prepare requester admission unavailable');
      onTestFinished(() => admitted.dispose());
      const carrier = await projectExternalActionRequesterHttpAuthorization({ authorization: admitted.authorization,
        serverId: workspace.serverId, serverIdentityId: workspace.serverId, serverHttpBaseUrl: 'https://prepare-home.test',
        target: { kind: 'machine', machineId: workspace.machineId }, installationId: 'workspace-installation',
        privateKey: installationKeys.secretKey, isCurrent: admitted.isCurrent });
      if (!carrier) throw new Error('Prepare requester HTTP custody unavailable');
      requireBoundReads = true;
      const daemonToken = foreignCustodian
        ? `header.${Buffer.from(JSON.stringify({ sub: machineCustodianAccountId })).toString('base64url')}.signature` : token;
      const receiver = createCliActionDeps({ token: daemonToken, credentials: { token: daemonToken, encryption: null },
        sessionId: '', mode: 'plain', ctx: null, serverId: workspace.serverId, serverIdentityId: workspace.serverId,
        savedSecretOperationContext: admitted.savedSecretOperationContext,
        isCredentialCurrent: admitted.isCurrent,
        ...(getCurrentTurnWorkDepth ? { getCurrentTurnWorkDepth } : {}),
        externalActionMachineInstallationId: 'workspace-installation', externalActionMachineRequestPrivateKey: installationKeys.secretKey,
        sessionSpawnDirectTargetTransport: { machineId: workspace.machineId,
          prepare: (request, options) => prepareSessionCreationTarget({ request, signal: options?.signal }),
          spawnedSession: { spawn: async options => {
            launches.push(options);
            rawSession = { ...rawSession, metadata: JSON.stringify(buildCommittedLaunchMetadata({ options, directory: rootPath })) };
            return { type: 'success', sessionId: 'prepared-session',
              sessionCreationOutcome: { disposition: 'created', organizationPlacement: { folderId: null, tagIds: [] } } };
          }, resolveSpawnSessionByNonce: async () => ({ status: 'not_found' }) },
        },
        machineAdmissionTransport: async request => {
          accepted.push(UserMessageSchema.parse(openSessionStoredContent({ mode: 'plain', ctx: null, content: request.content })));
          return { status: 'accepted', localId: request.localId };
        },
        serverHttpBaseUrl: 'https://prepare-home.test', machineActionDirectTargetTransport: {
          machineId: workspace.machineId, invoke: async () => { throw new Error('No remote native effect'); },
        } });
      const machineAdmission: SocketRpcMachineAdmissionContextV1 = { actorAccountId: 'prepare-account',
        custodianAccountId: machineCustodianAccountId, machineId: workspace.machineId,
        installationId: 'workspace-installation', role: 'manage', encryptionMode: 'plain' };
      const ingress = { machineAdmission, verifyMachineAdmissionCurrent: async () => current };
      return { authorization: carrier, envelope, receiver, ingress, accountSettings: admitted.accountSettingsContext.settings,
        retire() { current = false; }, execute: () => receiver.deploymentPrepare!(next,
        { surface: 'ui', authority: 'present_user', serverId: workspace.serverId, runtimeAccountId: 'prepare-account',
          actionCaller: { kind: 'host' }, actionRequestId: 'prepare-request',
          externalActionTarget: { kind: 'machine', machineId: workspace.machineId },
          externalActionExecutionAuthorization: carrier }) };
    },
    originate: async (requireApproval: boolean) => {
      includeController = true;
      const settings = normalizeActionsSettingsV1({ v: 1, actions: requireApproval
        ? { 'deployments.prepare': { approvalRequiredSurfaces: ['cli'] } } : {} });
      return createCliActionExecutorFromCredentials({ credentials: { token, encryption: null, credentialProvenance: 'stored_session' }, externalActionClient: true,
        serverId: workspace.serverId, serverIdentityId: workspace.serverId, serverApiUrl: 'https://prepare-home.test',
        actionsSettingsProvider: { getActionsSettings: () => settings, getAccountSettings: () => accountSettingsParse({ actionsSettingsV1: settings }) },
      }).execute('deployments.prepare', input, { surface: 'cli', authority: 'present_user', actionRequestId: 'prepare-request' });
    },
    loseReply() { loseReply = true; },
    denyChild() { childExecution = { ok: false, errorCode: 'approval_denied', error: 'approval_denied' }; },
    existingSessionChild(result: unknown = { status: 'accepted', localId: 'prepare-existing-input' }) {
      childExecution = { ok: true, result };
    },
    pendingChild() { childExecution = { ok: true, result: { type: 'pending', retryWithSameCreationKey: true, outcome: 'unknown',
      operation: { serverId: workspace.serverId, machineId: workspace.machineId, operationId: 'spawn-operation' } } }; } };
}

function sessionCallerRegression() {
  it.each([false, true])('hands off a real Session caller without replacing its origin with present-person authority (existing Session: %s)', async existingSession => {
    const f = fixture();
    const input = { ...f.input, ...(existingSession ? { sessionRef: { serverId: 'prepare-home', sessionId: 'prepared-session' } } : {}) };
    let custody: Awaited<ReturnType<typeof f.admit>> | undefined;
    let readCurrentTurnWorkDepth: ((turnId?: string) => number | undefined) | undefined;
    const settings = normalizeActionsSettingsV1({ v: 1, actions: {},
      approvalWaivedSurfaces: { 'deployments.prepare': ['agent'] } });
    f.setActionsSettings(settings);
    const executeSession = createDaemonSessionAccountActionExecutor({
      serverId: 'prepare-home', serverHttpBaseUrl: 'https://prepare-home.test', token,
      credentials: { token, encryption: null }, machineId: 'workspace-daemon',
      prepareExternalActionAuthorization: async ({ sessionActionOrigin }) => {
        custody = await f.admit(false, input, sessionActionOrigin, undefined, turnId => readCurrentTurnWorkDepth?.(turnId));
        return { authorization: custody.authorization, target: { kind: 'machine', machineId: 'workspace-daemon' } };
      },
      createExecutor: getCurrentTurnWorkDepth => {
        readCurrentTurnWorkDepth = getCurrentTurnWorkDepth;
        if (!custody) throw new Error('Session origin must be admitted before Prepare execution');
        const executor = createActionExecutor(custody.receiver);
        return { execute: (actionId, input, context) => executor.execute(actionId, input, {
          ...context, ...custody!.ingress, runtimeAccountId: 'prepare-account', actionsSettings: custody!.accountSettings.actionsSettingsV1,
          // The authenticated Session ingress, rather than authored Prepare input, owns these facts.
          agentStartContext: { caller: { kind: 'session', sessionId: 'prepare-caller', starterDepth: 0, turnDepth: 1 },
            baseline: { machineId: 'workspace-daemon', directory: f.rootPath }, roles: {}, ledSubtreeSessionIds: [],
            callerPermissionCeiling: 'default', workDepthLimit: custody!.accountSettings.workDepthLimit,
            allowLists: custody!.accountSettings.sessionAgentStartAllowListsV1 },
          sessionAgentSpawnPolicyV1: custody!.accountSettings.sessionAgentSpawnPolicyV1,
          originalActionEnvelope: custody!.envelope,
        }) };
      },
    });
    const result = await runWithServerHttpBaseUrl('https://prepare-home.test', () => executeSession({ kind: 'action.execute', requestId: 'prepare-request',
      actionId: 'deployments.prepare', input,
      witness: { turnId: 'prepare-turn', inputId: 'prepare-input', userMessageSeq: 1, userMessageSeqs: [1], workDepth: 1,
        callerPermissionMode: 'default', causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'default' },
        agentStartCaller: { kind: 'session', sessionId: 'prepare-caller', starterDepth: 0, turnDepth: 1 } },
    }, { sessionId: 'prepare-caller', isCurrent: async () => true }));
    expect(result, JSON.stringify({ result, launches: f.launches.length, accepted: f.accepted.length })).toMatchObject({ ok: true, result: { kind: 'handedOff' } });
    expect(f.boundReads.map(read => read.effectActionId)).toEqual(['deployments.prepare', 'projects.sources.read']);
    expect(f.boundReads.every(verifiesPrepareRead)).toBe(true);
    expect(custody?.authorization.binding.sessionActionOrigin?.caller).toEqual({
      kind: 'session', sessionId: 'prepare-caller', starterDepth: 0, turnDepth: 1,
    });
    expect(f.launches).toHaveLength(existingSession ? 0 : 1);
    if (!existingSession) expect(f.launches[0]).toMatchObject({ originSessionId: 'prepare-caller' });
    expect(f.accepted).toHaveLength(1);
    expect(f.accepted[0]?.content.text).toContain(f.input.baseCommit);
    expect(f.accepted[0]?.content.text).toContain('scm.pullRequest.openOrReuse');
    if (existingSession) expect(readSessionInputRequest(f.accepted[0]?.meta)).toMatchObject({
      producer: 'sessionAction', sourceSession: { sourceSessionId: 'prepare-caller', sourceTurnId: 'prepare-turn', sourceInputId: 'prepare-input' },
    });
    expect(f.dispatched).toEqual([]);
  });
}

describe('Prepare routing and signed Account reads', () => {
  it.each([false, true])('resolves the exact workspace Machine through the original outer Account factory with two available Machines (Require: %s)', async requireApproval => {
    const f = fixture();
    const result = await f.originate(requireApproval);
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { kind: 'handedOff' } });
    expect(f.prepareDispatches).toEqual([{ v: 1, requestId: 'prepare-request',
      target: { kind: 'machine', machineId: 'workspace-daemon' }, input: f.input }]);
    expect(f.dispatched).toEqual([]);
    expect(f.post.mock.calls.filter(([url]) => String(url).includes('/project-rows/')).map(([, body]) => body))
      .toEqual([{ key: f.input.workspace }]);
  });

  it('keeps signed read purpose on Source denial and refuses retired custody before SCM or Session effects', async () => {
    const f = fixture();
    f.denySource();
    const requester = await f.admit();
    const result = await requester.execute();
    expect(f.boundReads.map(read => read.effectActionId)).toEqual(['deployments.prepare', 'projects.sources.read']);
    expect(f.boundReads.every(verifiesPrepareRead)).toBe(true);
    expect(result, JSON.stringify(result)).toMatchObject({ ok: false, errorCode: 'action_forbidden' });
    requester.retire();
    expect(await requester.execute()).toMatchObject({ ok: false, errorCode: 'action_forbidden' });
    expect(f.boundReads).toHaveLength(2);
    expect(f.dispatched).toEqual([]);
  });

  it('refuses stale Source before native checkout inspection', async () => {
    const f = fixture();
    f.setSourceRevision(4);
    expect(await f.execute()).toEqual({ ok: true, result: { kind: 'conflict', reason: 'source_changed' } });
    expect(f.dispatched).toEqual([]);
  });

  it('rejects a foreign workspace Home before any reads or child dispatch', async () => {
    const f = fixture();
    expect(await f.execute({ ...f.input, workspace: { ...f.input.workspace, serverId: 'foreign-home' } }))
      .toMatchObject({ ok: false, errorCode: 'server_scope_mismatch' });
    expect(f.post).not.toHaveBeenCalled();
  });
});

describe('Prepare native workspace to normal Session handoff', () => {
  sessionCallerRegression();
  let runtime: Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>> | null = null;
  // Real product-build source admission and publication, without mocking SCM.
  beforeAll(async () => {
    runtime = await createAdmittedPluginRuntimeFixture({ controller: pluginReloadController,
      runtimeOptions: {
        pluginIds: ['happier.scm.backend.git', 'happier.scm.forge.github', 'happier.agent.claude'],
      },
    });
    expect(runtime.registry.activatedPluginIds.has('happier.scm.forge.github'),
      JSON.stringify(runtime.registry.pluginDiagnosticsByPluginId['happier.scm.forge.github'])).toBe(true);
    expect(runtime.registry.contributes.agentDefinitionsById.get('claude'),
      JSON.stringify(runtime.registry.pluginDiagnosticsByPluginId['happier.agent.claude'])).toBeDefined();
  });
  afterAll(async () => {
    await runtime?.dispose();
  });

  it('hands off optional target references without reading deployment authority or relocating the Session', async () => {
    const f = fixture();
    const input = { ...f.input, target: { environmentId: f.environment.id, targetLinkId: f.targetLink.id,
      expectedTargetLinkRevision: f.targetLink.revision + 1 } };
    // The canonical Action owner already admitted its configurable approval
    // scope. The receiver performs only the Source/workspace handoff reads.
    const receiver = await f.admit(false, input);
    expect(await receiver.execute()).toMatchObject({ kind: 'handedOff' });
    expect(vi.mocked(axios.request).mock.calls.filter(([config]) => String(config.url).includes('/v1/deployments/')))
      .toEqual([]);
    expect(f.dispatched).toEqual([expect.objectContaining({
      target: { kind: 'machine', machineId: 'workspace-daemon' },
      input: expect.objectContaining({ executionTarget: { serverId: 'prepare-home', machineId: 'workspace-daemon' } }),
    })]);
  });

  it('hands a personal Source without an Environment to the admitted workspace Session and settles with its ref', async () => {
    const f = fixture();
    const result = await f.execute();
    expect(result).toEqual({ ok: true, result: { kind: 'handedOff', sessionRef: { serverId: 'prepare-home', sessionId: 'prepared-session' } } });
    if (!result.ok) throw new Error('Expected handoff');
    expect(DeploymentPrepareResultV1Schema.safeParse(result.result).success).toBe(true);
    expect(f.dispatched).toHaveLength(1);
    expect(f.dispatched[0]).toMatchObject({ target: { kind: 'machine', machineId: 'workspace-daemon' },
      input: { executionTarget: { serverId: 'prepare-home', machineId: 'workspace-daemon' }, directory: { kind: 'path', path: f.rootPath } } });
    const encoded = JSON.stringify(f.dispatched[0]);
    expect(encoded).toContain(f.input.baseCommit);
    expect(encoded).toContain('scm.remote.push');
    expect(encoded).toContain('scm.pullRequest.openOrReuse');
    expect(encoded).not.toContain(token);
    expect(f.post.mock.calls.filter(([url]) => String(url).includes('/project-rows/')).map(([, body]) => body))
      .toEqual([{ key: f.input.workspace }]);
  });

  it('checks the admitted handoff once while later Session admission remains with its owner', async () => {
    let admissionReads = 0;
    const f = fixture({ isCredentialCurrent: () => ++admissionReads === 1 });
    expect(await f.execute()).toMatchObject({ ok: true, result: { kind: 'handedOff' } });
    expect(admissionReads).toBe(1);
    expect(f.dispatched).toHaveLength(1);
  });

  it('keeps local cancellation after Source inspection without dispatching a Session', async () => {
    const controller = new AbortController();
    const f = fixture({ signal: controller.signal, onSourceRead: () => controller.abort() });
    expect(await f.execute()).toMatchObject({ ok: false, errorCode: 'cancelled' });
    expect(f.dispatched).toEqual([]);
  });

  it('retains the independent disclosure refusal for a genuine foreign custodian without creating a Session', async () => {
    const f = fixture();
    const requester = await f.admit(true);
    const result = await requester.execute();
    expect(result, JSON.stringify(result)).toMatchObject({ ok: false, errorCode: 'requester_credential_disclosure_required' });
    expect(f.dispatched).toEqual([]);
  });

  it('hands imported configuration references to the normal new Session without reading configuration values', async () => {
    const f = fixture();
    const importFrom = { tool: 'Existing app manager', configurationPaths: ['deploy/app.json', 'compose.previous.yaml'] };
    const input = { ...f.input, importFrom };
    expect(await f.execute(input)).toMatchObject({ ok: true, result: { kind: 'handedOff' } });
    expect(f.dispatched).toEqual([expect.objectContaining({
      input: expect.objectContaining({ initialInput: { text: expect.stringContaining(JSON.stringify(input)) } }),
    })]);
    expect(f.dispatched).toHaveLength(1);
    expect(f.prepareDispatches).toEqual([]);
  });

  it.each([{ status: 'accepted', signed: false }, { status: 'alreadyAccepted', signed: true }] as const)(
    'continues the exact existing Session through ordinary message admission ($status; signed=$signed)', async ({ status, signed }) => {
    const f = fixture();
    f.existingSessionChild({ status, localId: 'prepare-existing-input' });
    const sessionRef = { serverId: 'prepare-home', sessionId: 'existing-preparation-session' };
    const input = { ...f.input, sessionRef };
    const result = signed ? await (await f.admit(false, input)).execute() : await f.execute(input);
    expect(result).toEqual(signed ? { kind: 'handedOff', sessionRef } : { ok: true, result: { kind: 'handedOff', sessionRef } });
    if (signed) {
      expect(f.boundReads.map(read => read.effectActionId)).toEqual(['deployments.prepare', 'projects.sources.read']);
      expect(f.boundReads.every(verifiesPrepareRead)).toBe(true);
    }
    expect(f.dispatched).toEqual([expect.objectContaining({
      target: { kind: 'session', sessionId: sessionRef.sessionId },
      input: expect.objectContaining({ sessionId: sessionRef.sessionId, reply: 'none',
        message: expect.stringContaining(f.input.baseCommit) }),
    })]);
  });

  it('keeps an existing Session approval and an unknown accepted-input outcome independent without spawning a replacement', async () => {
    const f = fixture();
    const sessionRef = { serverId: 'prepare-home', sessionId: 'existing-preparation-session' };
    const deferred = { kind: 'approval_request_created', artifactId: 'session-send-approval', actionId: 'session.message.send' };
    f.existingSessionChild(deferred);
    expect(await f.execute({ ...f.input, sessionRef })).toEqual({ ok: true, result: deferred });
    f.existingSessionChild({ status: 'outcomeUnknown', localId: 'prepare-existing-input', code: 'transport_unavailable' });
    expect(await f.execute({ ...f.input, sessionRef })).toMatchObject({ ok: false, errorCode: 'outcome_unknown' });
    expect(f.dispatched).toHaveLength(2);
    for (const packet of f.dispatched) expect(packet).toMatchObject({ target: { kind: 'session', sessionId: sessionRef.sessionId } });
  });

  it('rejects an existing Session from a different Home before handoff', async () => {
    const f = fixture();
    expect(await f.execute({ ...f.input, sessionRef: { serverId: 'foreign-home', sessionId: 'foreign-session' } }))
      .toMatchObject({ ok: false, errorCode: 'server_scope_mismatch' });
    expect(f.dispatched).toEqual([]);
  });

  it('refuses inline import configuration values rather than placing them in Session input', async () => {
    const f = fixture();
    const input = { ...f.input, importFrom: { tool: 'Previous manager', configurationPaths: ['app.json'],
      configuration: { password: 'must-not-enter-a-session' } } };
    expect(await f.execute(input)).toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
    expect(f.dispatched).toEqual([]);
  });

  it('refuses changed local base before dispatching a Session', async () => {
    const f = fixture();
    runGit(f.rootPath, ['commit', '--allow-empty', '-m', 'concurrent base']);
    expect(await f.execute()).toEqual({ ok: true, result: { kind: 'conflict', reason: 'base_changed' } });
    expect(f.dispatched).toEqual([]);
  });

  it('keeps child denial distinct and never retries a Session handoff', async () => {
    const f = fixture();
    f.denyChild();
    expect(await f.execute()).toMatchObject({ ok: false, errorCode: 'approval_denied' });
    expect(f.dispatched).toHaveLength(1);
  });

  it('keeps Dockerfile-only Prepare on the workspace daemon when the target Environment controller differs', async () => {
    const f = fixture();
    writeFileSync(join(f.rootPath, 'Dockerfile'), 'FROM scratch\nCOPY app /app\nENTRYPOINT ["/app"]\n');
    runGit(f.rootPath, ['add', 'Dockerfile']);
    runGit(f.rootPath, ['commit', '-m', 'Dockerfile-only app']);
    const baseCommit = runGit(f.rootPath, ['rev-parse', 'HEAD']);
    expect(readdirSync(f.rootPath).filter(file => /^(?:docker-)?compose\.ya?ml$/.test(file))).toEqual([]);
    expect(await f.execute({ ...f.input, baseCommit, target: { environmentId: f.environment.id,
      targetLinkId: f.targetLink.id, expectedTargetLinkRevision: f.targetLink.revision } }))
      .toMatchObject({ ok: true, result: { kind: 'handedOff' } });
    expect(f.dispatched).toEqual([expect.objectContaining({
      target: { kind: 'machine', machineId: 'workspace-daemon' },
      input: expect.objectContaining({ executionTarget: { serverId: 'prepare-home', machineId: 'workspace-daemon' },
        directory: { kind: 'path', path: f.rootPath } }),
    })]);
    expect(f.prepareDispatches).toEqual([]);
  });

  it('returns the Session owner operation for pending acceptance and never starts another create', async () => {
    const f = fixture();
    f.pendingChild();
    expect(await f.execute()).toEqual({ ok: true, result: { kind: 'partial', reason: 'child_failed',
      childOperationRefs: [{ serverId: 'prepare-home', machineId: 'workspace-daemon', operationId: 'spawn-operation' }] } });
    expect(f.dispatched).toHaveLength(1);
  });

  it('preserves an unknown submitted Session outcome without repeating the create', async () => {
    const f = fixture();
    f.loseReply();
    expect(await f.execute()).toMatchObject({ ok: false, errorCode: 'outcome_unknown' });
    expect(f.dispatched).toHaveLength(1);
  });

});

describe('Prepare Session source through the canonical SCM PR owner', () => {
  let runtime: Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>>;
  beforeAll(async () => {
    runtime = await createAdmittedPluginRuntimeFixture({ controller: pluginReloadController,
      runtimeOptions: { pluginIds: ['happier.scm.backend.git', 'happier.scm.forge.github', 'happier.agent.claude'] } });
    expect(runtime.registry.contributes.agentDefinitionsById.get('claude'),
      JSON.stringify(runtime.registry.pluginDiagnosticsByPluginId['happier.agent.claude'])).toBeDefined();
  });
  afterAll(async () => { await runtime?.dispose(); });

  it.each([
    { forgeState: 'available', importTool: false, validation: 'unavailable' },
    { forgeState: 'authentication-refused', importTool: false, validation: 'unavailable' },
    { forgeState: 'available', importTool: true, validation: 'unavailable' },
    { forgeState: 'available', importTool: false, validation: 'ownServer' },
    { forgeState: 'available', importTool: false, validation: 'movedHead' },
  ] as const)('admits a Session-authored proposal with head-bound validation evidence (forge=$forgeState; import=$importTool; validation=$validation)', async ({ forgeState, importTool, validation }) => {
    const accountId = 'prepare-pr-account';
    const token = `header.${Buffer.from(JSON.stringify({ sub: accountId, tokenEpoch: 1,
      provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.signature`;
    const credentials = { token, encryption: null };
    vi.spyOn(persistence, 'readStoredCredentials').mockResolvedValue(credentials);
    const serverId = 'prepare-pr-home';
    const machineId = 'prepare-pr-machine';
    const installation = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(29));
    const sessionId = 'cmv3prepareprsessionaaaaa';
    const rootPath = createGitWorkspace('happier-prepare-pr-');
    const remote = createBareGitRemoteFixture('happier-prepare-pr-remote-');
    onTestFinished(async () => { await removeTempDir(rootPath); await removeTempDir(remote.remotePath); });
    const dockerfile = 'FROM node:22-alpine\nWORKDIR /app\nCOPY app.js /app/app.js\nCMD ["node", "app.js"]\n';
    // The fixture already has valid build instructions; Prepare must retain them.
    execFileSync(process.execPath, ['-e', 'require("node:fs").writeFileSync(process.argv[1], process.argv[2])', join(rootPath, 'Dockerfile'), dockerfile]);
    runGit(rootPath, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
    runGit(rootPath, ['add', 'Dockerfile']);
    runGit(rootPath, ['commit', '-m', 'Dockerfile-only app']);
    const baseCommit = runGit(rootPath, ['rev-parse', 'HEAD']);
    runGit(rootPath, ['remote', 'add', 'origin', 'https://github.com/prepare/app.git']);
    runGit(rootPath, ['push', remote.remotePath, 'main']);
    runGit(rootPath, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
    runGit(rootPath, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main']);
    const repository = { kind: 'github' as const, deployment: 'https://github.com', repository: 'prepare/app' };
    const workspace = { id: 'prepare-pr-workspace', serverId, machineId, rootPath, createdAtMs: 1,
      repositoryIdentity: repository, source: { sourceId: 'prepare-pr-source', revision: 1 } };
    const input = { projectSourceId: workspace.source.sourceId, sourceRevision: workspace.source.revision,
      repository, baseCommit, ...(importTool ? { importFrom: { tool: 'Existing app manager',
        configurationPaths: ['deploy.previous.json'] } } : {}), workspace: { kind: 'workspace-ref' as const, serverId, id: workspace.id } };
    let rawSession = createSessionRecordFixture({ id: sessionId, active: true, encryptionMode: 'plain', machineId,
      metadata: JSON.stringify({ machineId, path: rootPath }), dataEncryptionKey: null });
    const accepted: ReturnType<typeof UserMessageSchema.parse>[] = [];
    let launches = 0;
    let purposeReads = 0;
    const spawnDeps = createCliActionDeps({ token, credentials, sessionId: '', mode: 'plain', ctx: null, serverId,
      machineActionDirectTargetTransport: { machineId, invoke: async () => { throw new Error('No Session native effect'); } },
      sessionSpawnDirectTargetTransport: { machineId,
        prepare: (request, options) => prepareSessionCreationTarget({ request, signal: options?.signal }),
        // Runner launch and Home persistence are external boundaries. The actual
        // creator composes metadata, checks correspondence and admits the input.
        spawnedSession: { spawn: async options => {
          launches++;
          rawSession = { ...rawSession, metadata: JSON.stringify(buildCommittedLaunchMetadata({ options, directory: rootPath })) };
          return { type: 'success', sessionId,
            sessionCreationOutcome: { disposition: 'created', organizationPlacement: { folderId: null, tagIds: [] } } };
        }, resolveSpawnSessionByNonce: async () => ({ status: 'not_found' }) },
      },
      machineAdmissionTransport: async request => {
        accepted.push(UserMessageSchema.parse(openSessionStoredContent({ mode: 'plain', ctx: null, content: request.content })));
        return { status: 'accepted', localId: request.localId };
      },
    });
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      const path = new URL(String(url)).pathname;
      if (path === '/v1/account/entity-rows/connected-accounts/purposes') { purposeReads++; return { status: 200,
        data: ConnectedAccountCatalogRowReadResponseV1Schema.parse({ status: 'present', revision: 1,
          content: sealConnectedAccountCatalogContentV1({ mode: 'plain', material: null,
            record: emptyConnectedAccountCatalogRecordV1('purposes') }) }) }; }
      if (path === '/v2/account/settings/history') return { status: 200, data: { snapshots: [] } };
      if (path === '/v1/account/profile') return { status: 200, data: { id: accountId } };
      if (path === '/v2/account/settings') return { status: 200, data: { content: { t: 'plain', v: {} }, version: 1 } };
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: createAccountEncryptionCurrentnessFixture({ mode: 'plain' }) };
      if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 0 } };
      const machine = { id: machineId, kind: 'persistent', active: true, installationId: 'prepare-pr-installation',
        installationPublicKey: Buffer.from(installation.publicKey).toString('base64'), revokedAt: null, replacedByMachineId: null,
        storageMode: 'plain', access: { custodian: { accountId, displayName: 'Owner' }, role: 'manage', resourceMode: 'plain', accessState: 'ready' } };
      if (path === '/v1/machines') return { status: 200, data: [machine] };
      if (path === `/v1/machines/${machineId}`) return { status: 200, data: { machine } };
      if (path === `/v2/sessions/${sessionId}`) return { status: 200, data: { session: rawSession } };
      throw new Error(`Unexpected Home GET ${path}`);
    });
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async url => String(url).endsWith('/v1/account/profile')
      ? Response.json({ id: accountId }) : String(url).endsWith('/features') ? Response.json(FeaturesResponseSchema.parse({ features: {}, capabilities: {
        serverIdentity: { serverIdentityId: serverId }, encryption: { storagePolicy: 'optional', allowAccountOptOut: true, defaultAccountMode: 'plain' },
      } })) : Promise.reject(new Error('Unexpected fetch path: ' + new URL(String(url)).pathname))));
    vi.spyOn(axios, 'request').mockImplementation(async config => {
      expect(config.method).toBe('GET');
      expect(new URL(String(config.url)).pathname).toBe(`/v1/projects/sources/${workspace.source.sourceId}`);
      return { status: 200, data: { ok: true, canManage: true, source: { id: workspace.source.sourceId, revision: 1,
        name: 'Prepare app', audience: [], createdByAccountId: accountId,
        repository: { provider: { id: 'happier.scm.forge.github/github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' },
          repository: { nameWithOwner: 'prepare/app', cloneUrl: 'https://github.com/prepare/app.git' }, protocol: 'https' } } } };
    });
    const childActions: string[] = [];
    vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith('/verify')) return { status: 200, data: { ok: true } };
      if (path.includes('/v1/account/project-rows/')) return projectAccountRowsReadHttpResponse([createPlainProjectAccountRefRow(workspace)], String(url), body);
      if (path.endsWith('/lookup-by-tags')) return { status: 200, data: { sessions: [] } };
      if (path === '/v2/sessions/' + sessionId + '/pending') {
        if (!body || typeof body !== 'object') throw new Error('Expected Pending input request');
        const content = SessionMessageContentSchema.parse(Reflect.get(body, 'content'));
        accepted.push(UserMessageSchema.parse(openSessionStoredContent({ mode: 'plain', ctx: null, content })));
        return { status: 200, data: { didWrite: true, terminal: false, suppressed: false } };
      }
      const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
      expect(path.startsWith('/v1/actions/session.spawn_new')).toBe(true);
      if (path.endsWith('/execution-authorization')) return { status: 200, data: { v: 1, token: 'prepare-pr-proof', binding: {
        accountId, authentication: { kind: 'account', tokenEpoch: 1 }, accountEncryptionMode: 'plain', serverIdentityId: serverId,
        custodianAccountId: accountId, machineId, installationId: 'prepare-pr-installation', actionId: 'session.spawn_new',
        requestId: 'prepare-pr-request', target: request.envelope.target,
        requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(request.envelope),
      } } };
      childActions.push('session.spawn_new');
      // The substituted HTTP hop invokes the public Session Action, rather than
      // returning a fabricated successful Session result to Prepare.
      const execution = await createActionExecutor(spawnDeps).execute('session.spawn_new', request.envelope.input,
        { surface: 'ui', authority: 'present_user', serverId, runtimeAccountId: accountId, actionCaller: { kind: 'host' },
          actionsSettings: normalizeActionsSettingsV1({ v: 1, actions: {} }),
          actionRequestId: request.envelope.requestId });
      return { status: 200, data: { v: 1, actionId: 'session.spawn_new', requestId: 'prepare-pr-request', execution } };
    });
    const prepareDeps = createCliActionDeps({ token, credentials, sessionId: '', mode: 'plain', ctx: null, serverId,
      serverIdentityId: serverId, serverHttpBaseUrl: 'https://prepare-pr-home.test',
      machineActionDirectTargetTransport: { machineId, invoke: async () => { throw new Error('No Prepare native effect'); } } });
    const handoff = await createActionExecutor(prepareDeps).execute('deployments.prepare', input,
      { surface: 'ui', authority: 'present_user', serverId, runtimeAccountId: accountId, actionCaller: { kind: 'host' },
        actionRequestId: 'prepare-pr-request', externalActionTarget: { kind: 'machine', machineId } });
    expect(handoff, JSON.stringify({ handoff, childActions, launches, acceptedInputs: accepted.length }))
      .toEqual({ ok: true, result: { kind: 'handedOff', sessionRef: { serverId, sessionId } } });
    expect(launches).toBe(1);
    expect(purposeReads).toBeGreaterThan(0);
    expect(accepted).toHaveLength(1);
    expect(runGit(rootPath, ['rev-parse', 'HEAD'])).toBe(baseCommit);
    const brief = accepted[0]!.content.text;
    const selection = JSON.parse(brief.match(/```json\s*([\s\S]*?)```/)?.[1] ?? 'null');
    expect(selection).toEqual(input);
    if (importTool) {
      // The Agent consumes a public Action reference, not a private native recipe.
      const restoreActionId = brief.match(/\bdeployments\.backups\.\w+\b/u)?.[0];
      const restoreSpec = listActionSpecsForSurface('agent').find(spec => spec.id === restoreActionId);
      expect(restoreSpec, 'Import handoff must name the admitted public restore Action').toMatchObject({
        id: 'deployments.backups.restore', safety: 'danger', sideEffectClass: 'write', approvalScope: 'environment',
      });
    }

    // Restore fetch before the real HTTP forge. Only Home HTTP, Agent process
    // and the forge credential store are substituted; SCM internals stay real.
    vi.unstubAllGlobals();
    const pullRequests: Array<Record<string, unknown>> = [];
    let creations = 0;
    let forgePostRequests = 0;
    const forge = createServer(async (request, response) => {
      expect(request.headers.authorization).toBe('Bearer synthetic-forge-token');
      if (request.method === 'POST') forgePostRequests++;
      if (request.method === 'POST' && forgeState === 'authentication-refused') {
        response.writeHead(401, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ message: 'Bad credentials' }));
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      if (request.method === 'POST') {
        let text = ''; for await (const chunk of request) text += Buffer.from(chunk).toString();
        const draft = JSON.parse(text) as Record<string, unknown>;
        const pr = { number: 17, title: draft.title, body: draft.body, state: 'open', draft: false,
          html_url: 'https://github.com/prepare/app/pull/17', base: { ref: 'main', sha: baseCommit },
          head: { ref: 'prepare/deployment', sha: runGit(remote.remotePath, ['rev-parse', 'refs/heads/prepare/deployment']), repo: { full_name: 'prepare/app' } } };
        pullRequests.push(pr); creations++; response.end(JSON.stringify(pr));
      } else response.end(JSON.stringify(pullRequests));
    });
    await new Promise<void>(resolve => forge.listen(0, '127.0.0.1', resolve));
    onTestFinished(async () => { forge.closeAllConnections(); await new Promise<void>((resolve, reject) => forge.close(error => error ? reject(error) : resolve())); });
    const address = forge.address();
    if (!address || typeof address === 'string') throw new Error('Forge did not listen');
    const providerRegistry = createScmHostingProviderRegistry({ providers: [{ id: 'github', pluginId: 'happier.scm.forge.github',
      kind: 'github', displayName: 'GitHub', capabilities: ['detect', 'pullRequest'], authService: 'github-account' }],
      runtimeRegistrations: [{ pluginId: 'happier.scm.forge.github', occurrenceId: 'prepare-pr-forge', registration: {
        id: 'github', adapter: { routing: createGithubScmHostingProviderAdapter(), pullRequests: createGithubRestAdapter({
          fetcher: (url, init) => fetch(`http://127.0.0.1:${address.port}${new URL(url).pathname}${new URL(url).search}`, init),
        }) },
      } }] });
    // Genuine OS/process boundary: host Git push retains its private metadata
    // view and upstream policy; only the external receiver is local to the test.
    const actualSpawn = childProcess.spawn;
    vi.spyOn(childProcess, 'spawn').mockImplementation((command, args, options) => {
      const isGit = /(?:^|[/\\])git(?:\.exe)?$/.test(command);
      return actualSpawn(command, isGit && isHostGitPush({ bin: 'git', args: [...(args ?? [])] })
        ? ['-c', 'remote.origin.pushurl=' + remote.remotePath, ...(args ?? [])] : isGit && args?.includes('fetch')
          ? ['-c', 'remote.origin.url=' + remote.remotePath, ...args.map(arg => arg === 'https://github.com/prepare/app.git' ? remote.remotePath : arg)] : args, options);
    });
    syncBuiltinESMExports();
    const registry = createDeploymentGitRegistry({ resolveScmHostingProviderRegistry: async () => providerRegistry,
      resolveScmHostingTokenMaterialization: async () => ({ kind: 'available', token: 'synthetic-forge-token' }) });
    const actions: string[] = [];
    const scm = createActionExecutor({ scmActionExecute: async args => {
      actions.push(args.actionId);
      return executeScmActionOperation({ actionId: args.actionId, input: args.input, registry, workingDirectory: rootPath,
        sessionId, actionContext: args.context, executeCanonicalAction: args.executeCanonicalAction });
    } });
    const perform = async (actionId: ScmActionId, actionInput: unknown) => {
      const result = await scm.execute(actionId, actionInput, { surface: 'ui', authority: 'present_user', serverId,
        defaultSessionId: sessionId, runtimeAccountId: accountId, actionCaller: { kind: 'host' } });
      expect(result, actionId + ": " + JSON.stringify(result)).toMatchObject({ ok: true, result: { success: true } });
      return result;
    };
    const provider: AgentSessionRuntime = { async send(request) {
      expect(JSON.stringify(request)).toContain(JSON.stringify(brief));
      await perform('scm.branch.create', { cwd: rootPath, name: 'prepare/deployment', startPoint: baseCommit, checkout: true });
      // A deterministic substitute for the external Agent process authors the
      // files. This checks host/SCM semantics, not model reasoning or validation.
      execFileSync(process.execPath, ['-e', `const fs=require('node:fs'),p=require('node:path');
        for (const [name,text] of Object.entries(JSON.parse(process.argv[2]))) fs.writeFileSync(p.join(process.argv[1],name),text);`, rootPath,
        JSON.stringify({
          'app.js': 'require("node:http").createServer((q,s)=>s.end("ok")).listen(8080);\n',
          'compose.yaml': 'services:\n  app:\n    build: .\n    ports: ["8080:8080"]\n    healthcheck:\n      test: ["CMD", "node", "-e", "fetch(\'http://127.0.0.1:8080\').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]\n',
        })]);
      await perform('scm.commit.create', { cwd: rootPath, message: 'Propose deployment source', scope: { kind: 'all-pending' } });
      // Redirect only the Git transport to its local bare boundary. The logical
      // hosted Source selection is unchanged before handoff and PR inspection.
      await perform('scm.remote.push', { cwd: rootPath, remote: 'origin', branch: 'prepare/deployment' });
      let head = runGit(rootPath, ['rev-parse', 'HEAD']);
      const reviewedHead = head;
      let validationSummary = validation === 'unavailable'
        ? 'Validation unavailable: no reviewed validation target. No merge or Production deployment requested.'
        : await validatePreparedDeploymentHead({ sha: reviewedHead, runtime, installation, credentials, serverId, machineId, accountId, workspace });
      if (validation === 'movedHead') {
        writeFileSync(join(rootPath, 'app.js'), readFileSync(join(rootPath, 'app.js'), 'utf8') + '// Changed after validation\n');
        await perform('scm.commit.create', { cwd: rootPath, message: 'Advance the proposal after reviewed validation', scope: { kind: 'all-pending' } });
        await perform('scm.remote.push', { cwd: rootPath, remote: 'origin', branch: 'prepare/deployment' });
        head = runGit(rootPath, ['rev-parse', 'HEAD']);
        expect(head).not.toBe(reviewedHead);
        validationSummary = `Validation unavailable: pushed head moved from ${reviewedHead} to ${head}. Renew review and validation.`;
      }
      const prInput = { cwd: rootPath, base: 'main', head: 'prepare/deployment', title: 'Prepare app for deployment',
        body: `Configuration proposed at ${head}. ${validationSummary}` };
      if (forgeState === 'available') {
        expect(await perform('scm.pullRequest.openOrReuse', prInput)).toMatchObject({ result: { result: 'created', pullRequest: { headSha: head, state: 'open' } } });
        expect(await perform('scm.pullRequest.openOrReuse', prInput)).toMatchObject({ result: { result: 'reused', pullRequest: { headSha: head, state: 'open' } } });
      } else {
        expect(await scm.execute('scm.pullRequest.openOrReuse', prInput, { surface: 'ui', authority: 'present_user', serverId,
          defaultSessionId: sessionId, runtimeAccountId: accountId, actionCaller: { kind: 'host' } }))
          .toMatchObject({ ok: true, result: { success: false, errorCode: 'REMOTE_AUTH_REQUIRED' } });
      }
      return { status: 'admitted' };
    }, watch: () => ({ dispose() {} }), dispose() {} };
    const native = createNativeAgentSessionOperations(provider, sessionId, undefined, undefined, undefined, undefined, undefined,
      { context: {} as AgentSessionRuntimeContext, // This boundary Agent uses no SDK services.
        cwd: rootPath, connectedAccounts: [], capabilities: { open: ['create'], delivery: ['newTurn'], cancel: false },
        cancellation: { declared: false }, configuration: { declared: false }, compaction: { capability: null } });
    onTestFinished(() => native.resetOrDisposeRuntime());
    await native.sendTurnPrompt(brief, { localId: 'prepare-pr-input', turnId: 'prepare-pr-turn',
      agentStartCaller: { kind: 'session', sessionId, starterDepth: 0, turnDepth: 0 } });
    expect(readFileSync(join(rootPath, 'Dockerfile'), 'utf8')).toBe(dockerfile);
    const head = runGit(rootPath, ['rev-parse', 'HEAD']);
    expect(head).not.toBe(baseCommit);
    expect(runGit(remote.remotePath, ['rev-parse', 'refs/heads/prepare/deployment'])).toBe(head);
    expect(runGit(remote.remotePath, ['rev-parse', 'refs/heads/main'])).toBe(baseCommit);
    expect(runGit(rootPath, ['diff', '--name-only', 'main...HEAD']).split('\n')).toEqual(['app.js', 'compose.yaml']);
    expect(forgePostRequests).toBe(1);
    expect(creations).toBe(forgeState === 'available' ? 1 : 0);
    if (forgeState === 'available') expect(pullRequests[0]).toMatchObject({ state: 'open', head: { sha: head },
      body: expect.stringContaining('Configuration proposed at ' + head + '. ' + (validation === 'ownServer' ? 'Validation succeeded:' : 'Validation unavailable:')) });
    else expect(pullRequests).toEqual([]);
    if (validation === 'movedHead') {
      expect(pullRequests[0]?.body).toContain('Validation unavailable: pushed head moved');
      expect(pullRequests[0]?.body).not.toContain('Validation succeeded:');
    }
    expect(childActions).toEqual(['session.spawn_new']);
    expect(actions).toEqual(['scm.branch.create', 'scm.commit.create', 'scm.remote.push',
      ...(validation === 'movedHead' ? ['scm.commit.create', 'scm.remote.push'] : []), 'scm.pullRequest.openOrReuse',
      ...(forgeState === 'available' ? ['scm.pullRequest.openOrReuse'] : [])]);
    expect(JSON.stringify({ brief, pullRequests })).not.toContain(token);
    expect(JSON.stringify({ brief, pullRequests })).not.toContain('synthetic-forge-token');
    // Validation text uses the actual deploy receipt for the reviewed head. Docker IO is a boundary fixture, not external-engine qualification.
    // Reuse the owning native integration harness: review, build and activation each get its existing 60s test budget.
  }, 3 * 60_000);
});
