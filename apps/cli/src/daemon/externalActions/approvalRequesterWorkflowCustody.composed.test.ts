import fastify from 'fastify';
import nacl from 'tweetnacl';
import { expect, it, vi } from 'vitest';
import { ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { configuration } from '@/configuration';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { readOrCreateInstallationIdentity } from '@/daemon/identity/store';
import { withConfiguredDaemonTestHome } from '@/daemon/testkit/fakeDaemonLifecycle.testkit';
import { admitRequesterAccountActionContext, prepareRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionProjection';
import { readRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionContext';
import { decodeStoredCredentials, encodeRequesterCredentials, type StoredCredentials } from '@/persistence';
import { sealExternalActionRequesterAccountContextV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { sealAccountScopedBlobCiphertext } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';
import { registerAccountHomeHttp } from '@/session/actions/widgetApproval.testkit';
import { createDaemonApprovalExecutionAuthorizationPreparer } from './approvalExecutionAuthorization';
import { invokeHostReviewedChildV1 } from '@happier-dev/protocol/actions/actionExecutor';
import { isHostRequesterUnrestrictedOwner, selectHostRequesterExecutionIdentity } from '@/daemon/agentIsolation/agentIsolationLaunchPolicy';
import { acquireWorkflowApprovalRequester, retainWorkflowRequesterCredentials } from '@/daemon/workflows/requesterCustody';

it.each([
  { sealed: false, mode: 'plain' as const, workflow: true },
  { sealed: true, mode: 'plain' as const, workflow: true },
  { sealed: true, mode: 'e2ee' as const, workflow: true },
  { sealed: true, mode: 'plain' as const, workflow: false },
])('a stored root retains original custody without borrowing the deciding Account ($mode, sealed=$sealed, workflow=$workflow)', async ({ sealed, mode, workflow }) => {
  await withConfiguredDaemonTestHome({ prefix: 'workflow-approval-custody-' }, async () => {
    const app = fastify();
    const requests: string[] = [];
    app.addHook('onRequest', async request => { requests.push(request.url); });
    const endpoint = 'http://workflow-approval-custody.test';
    const restore = installAxiosFastifyAdapter({ app, origin: endpoint });
    const channel = await createRequesterCurrentnessSocketHarness();
    const accountId = 'owner';
    const homeId = 'srv_workflow';
    const machineId = 'workflow-machine';
    const encryption = mode === 'plain' ? null : { type: 'legacy' as const, secret: nacl.randomBytes(32) };
    const credentials: StoredCredentials = { token: `header.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`, encryption };
    const features = registerAccountHomeHttp(app, { accountId, serverId: homeId, settings: {}, encryptionMode: mode });
    if (encryption) {
      const content = { t: 'encrypted', c: sealAccountScopedBlobCiphertext({ kind: 'account_settings',
        material: encryption, payload: {}, randomBytes: nacl.randomBytes }) };
      app.addHook('preSerialization', async (request, _reply, payload) => request.url === '/v2/account/settings'
        ? { content, version: 1 } : payload);
    }
    app.get('/v1/features', async () => ({ ...features, capabilities: { ...features.capabilities,
      encryption: { storagePolicy: 'optional', allowAccountOptOut: true, defaultAccountMode: mode } } }));
    const fetchBoundary = vi.spyOn(globalThis, 'fetch').mockImplementation(async resource => {
      const url = new URL(resource instanceof Request ? resource.url : String(resource));
      if (url.origin !== endpoint) throw new Error('Unexpected Home');
      const response = await app.inject({ method: 'GET', url: `${url.pathname}${url.search}` });
      return new Response(response.body, { status: response.statusCode, headers: { 'content-type': 'application/json' } });
    });
    const installation = await readOrCreateInstallationIdentity();
    const target = { kind: 'machine' as const, machineId };
    const envelope = { v: 1 as const, requestId: 'workflow-request', target, input: {} };
    const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'workflow-root', binding: {
      serverIdentityId: homeId, accountId, custodianAccountId: accountId,
      authentication: { kind: 'account', tokenEpoch: 1 }, accountEncryptionMode: mode,
      actionId: 'deployments.deploy', requestId: envelope.requestId, machineId,
      installationId: installation.installationId, target, admittedMachineRole: 'manage',
      requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
      ...(workflow ? { workflowActionOrigin: { runId: 'workflow-run', requestId: envelope.requestId } } : {}),
    } });
    const binding = authorization.binding;
    if (!('authentication' in binding)) throw new Error('Expected an Account root');
    // HTTP and the installation filesystem are the only boundaries. The
    // requester admission, private projection and replay preparer stay real.
    let requester: Awaited<ReturnType<typeof admitRequesterAccountActionContext>> | undefined;
    let workflowRequester: Awaited<ReturnType<typeof admitRequesterAccountActionContext>> | undefined;
    let disposePrepared: (() => void | Promise<void>) | undefined;
    try {
      requester = await runWithServerHttpBaseUrl(endpoint, () => admitRequesterAccountActionContext({ authorization: {
        ...authorization, binding: { ...binding, workflowActionOrigin: undefined },
      }, credentials, serverId: configuration.activeServerId, serverIdentityId: homeId,
        serverHttpBaseUrl: endpoint, isCurrent: async () => true })).catch(error => {
          throw new Error(`Requester fixture failed after ${JSON.stringify(requests)}`, { cause: error });
        });
      expect(requester).not.toBeNull();
      if (!requester) throw new Error('Requester admission unavailable');
      const carried = sealExternalActionRequesterAccountContextV1({ authorization, purpose: { kind: 'external_action' },
        credentials: encodeRequesterCredentials(credentials),
        installationPublicKey: Buffer.from(installation.publicKey, 'base64url'), randomBytes: nacl.randomBytes });
      if (sealed) workflowRequester = await runWithServerHttpBaseUrl(endpoint, () => admitRequesterAccountActionContext({
        authorization: carried, credentials, serverId: configuration.activeServerId, serverIdentityId: homeId,
        serverHttpBaseUrl: endpoint, isCurrent: async () => true }));
      if (sealed && !workflowRequester) throw new Error('Workflow requester admission unavailable');
      // A persisted Ask retains only the original encrypted receiver box, never private ports or clear credentials.
      const stored = ExternalActionExecutionAuthorizationV1Schema.parse(JSON.parse(JSON.stringify(workflowRequester?.authorization ?? authorization)));
      if (sealed && workflow) expect(stored.requesterAccountContext).toEqual(carried.requesterAccountContext);
      else expect(stored.requesterAccountContext).toBeUndefined();
      expect(JSON.stringify(stored)).not.toContain(credentials.token);
      const executor = createActionExecutor(createUnavailableActionTransportDeps());
      const prepare = createDaemonApprovalExecutionAuthorizationPreparer({ machineId,
        serverId: configuration.activeServerId, serverBaseUrl: endpoint,
        requesterAccountContext: requester, daemonWorkSignal: new AbortController().signal,
        resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId: homeId, machineId }),
        prepareRequesterAccountContext: request => prepareRequesterAccountActionContext({ authorization: request.authorization,
          purpose: { kind: 'external_action' }, machineId, installationId: installation.installationId,
          installationPrivateKey: Buffer.from(installation.privateKey, 'base64url'), serverId: configuration.activeServerId,
          serverIdentityId: homeId, serverHttpBaseUrl: endpoint, isCurrent: async () => true,
          // The installed ingress has already admitted this receiver's custody.
          isCustodyCurrent: async () => true,
          ownCredentials: credentials,
          createExecutor: () => executor }),
      });
      const prepared = await prepare({ authorization: stored });
      disposePrepared = prepared?.dispose;
      expect(prepared?.authorization).toMatchObject({ token: authorization.token, binding });
      if (sealed && workflow) expect(prepared?.authorization.requesterAccountContext).toEqual(carried.requesterAccountContext);
      else expect(prepared?.authorization.requesterAccountContext).toBeUndefined();
      if (sealed) {
        const expected = decodeStoredCredentials(encodeRequesterCredentials(credentials))!;
        expect(readRequesterAccountActionContext(prepared?.authorization)?.credentials)
          .toMatchObject({ token: expected.token, encryption: expected.encryption });
      } else expect(readRequesterAccountActionContext(prepared?.authorization)).toBeNull();
      if (!prepared) throw new Error('Expected replay authorization');
      const action = { pluginId: 'acme.external', localId: 'upload' };
      // The durable root above has no private ports. Its real replay preparer
      // restores original ingress before the reviewed child wraps HTTP custody.
      await invokeHostReviewedChildV1({ parent: { actionId: 'deployments.deploy', input: {} },
        context: { authority: 'account_automation', surface: 'cli', runtimeAccountId: accountId,
          actionCaller: { kind: 'host' }, externalActionTarget: target,
          externalActionExecutionAuthorization: prepared.authorization },
        child: { action, role: 'uploadDeploy', input: {} }, admittedReview: { action, role: 'uploadDeploy', surface: 'cli' },
        execute: async (_input, context) => {
          const identity = selectHostRequesterExecutionIdentity({ actionContext: context,
            hostHomeServerIdentityId: homeId, hostCustodianAccountId: accountId,
            hostExecutionTarget: { machineId, installationId: installation.installationId } });
          expect(identity).toMatchObject({ kind: 'isolated', separationRequired: false, accountAutomation: true });
          expect(isHostRequesterUnrestrictedOwner(identity)).toBe(true);
          return { ok: true, result: null };
        } });
    } finally { await disposePrepared?.(); await workflowRequester?.dispose(); await requester?.dispose(); await channel.close(); fetchBoundary.mockRestore(); restore(); await app.close(); }
  });
});

it.each(['session', 'host'] as const)('replays a guest %s-principal Workflow Ask with its own Run requester custody, never the installed Account', async principalKind => {
  await withConfiguredDaemonTestHome({ prefix: 'workflow-approval-guest-replay-' }, async () => {
    const app = fastify();
    const endpoint = 'http://workflow-approval-guest-replay.test';
    const restore = installAxiosFastifyAdapter({ app, origin: endpoint });
    const channel = await createRequesterCurrentnessSocketHarness();
    const homeId = 'srv_workflow';
    const machineId = 'shared-machine';
    // HTTP is the only boundary: the Run's retained custody belongs to the guest.
    registerAccountHomeHttp(app, { accountId: 'guest', serverId: homeId });
    const fetchBoundary = vi.spyOn(globalThis, 'fetch').mockImplementation(async resource => {
      const url = new URL(resource instanceof Request ? resource.url : String(resource));
      if (url.origin !== endpoint) throw new Error('Unexpected Home');
      const response = await app.inject({ method: 'GET', url: `${url.pathname}${url.search}` });
      return new Response(response.body, { status: response.statusCode, headers: { 'content-type': 'application/json' } });
    });
    const installation = await readOrCreateInstallationIdentity();
    const runId = 'guest-workflow-run';
    const attribution = { serverId: configuration.activeServerId, accountId: 'guest', machineId,
      installationId: installation.installationId };
    const credentials: StoredCredentials = { token: `header.${Buffer.from(JSON.stringify({ sub: 'guest' })).toString('base64url')}.signature`,
      encryption: null };
    const admitted = (accountId: string) => ({ serverId: configuration.activeServerId, homeServerIdentityId: homeId,
      accountId, machineId, runId, requestId: 'guest-request', principal: principalKind === 'host' ? 'host' as const : 'requester' as const });
    const acquire = (accountId: string) => runWithServerHttpBaseUrl(endpoint, () => acquireWorkflowApprovalRequester({
      requester: admitted(accountId), serverHttpBaseUrl: endpoint, happyHomeDir: configuration.happyHomeDir,
      installationId: installation.installationId }));
    let replay: Awaited<ReturnType<typeof acquireWorkflowApprovalRequester>> = null;
    try {
      await app.ready();
      await retainWorkflowRequesterCredentials({ scopeId: runId, credentials, attribution, happyHomeDir: configuration.happyHomeDir,
        homeServerIdentityId: homeId, fromRunClaim: true,
        machineAdmission: { actorAccountId: 'guest', custodianAccountId: 'owner', role: 'use' } });
      // Cross-person refusal: neither the installed owner nor another person can reopen the guest's Run custody.
      expect(await acquire('owner')).toBeNull();
      expect(await acquire('mallory')).toBeNull();

      replay = await acquire('guest');
      expect(replay?.context).toMatchObject({ executionRunWorkflowRunId: runId, actionRequestId: 'guest-request',
        machineAdmission: { actorAccountId: 'guest', custodianAccountId: 'owner', role: 'use', machineId,
          installationId: installation.installationId },
        requesterWorkAttributionV1: attribution });
      expect(replay?.context.requesterSessionBootstrap).toBeDefined();
      expect(replay?.context.admittedHostWorkflowRequester !== undefined).toBe(principalKind === 'host');
      if (!replay) throw new Error('Expected guest replay custody');
      // The receiving authorizer selects the requester from this custody: the guest stays separated
      // from the installed owner Account on the shared Machine.
      const identity = selectHostRequesterExecutionIdentity({ actionContext: { authority: 'account_automation',
        machineAdmission: replay.context.machineAdmission, requesterSessionBootstrap: replay.context.requesterSessionBootstrap,
        verifyMachineAdmissionCurrent: replay.context.verifyMachineAdmissionCurrent,
        localActionContext: { authority: 'account_automation', actionCaller: { kind: 'workflowRun', runId,
          authorization: { admittedPermissionCeiling: 'read-only', principal: principalKind === 'host'
            ? { kind: 'host' } : { kind: 'session', sessionId: 'guest-session' } } } } },
        hostHomeServerIdentityId: homeId, hostCustodianAccountId: 'owner',
        hostExecutionTarget: { machineId, installationId: installation.installationId } });
      expect(identity).toMatchObject({ kind: 'isolated', requester: { accountId: 'guest' }, separationRequired: true });
      expect(isHostRequesterUnrestrictedOwner(identity)).toBe(false);
    } finally { await replay?.release(); await channel.close(); fetchBoundary.mockRestore(); restore(); await app.close(); }
  });
});
