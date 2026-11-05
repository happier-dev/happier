import fastify from 'fastify';
import { expect, it, vi } from 'vitest';
import { ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { configuration } from '@/configuration';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { readOrCreateInstallationIdentity } from '@/daemon/identity/store';
import { withConfiguredDaemonTestHome } from '@/daemon/testkit/fakeDaemonLifecycle.testkit';
import { admitRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionProjection';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';
import { registerAccountHomeHttp } from '@/session/actions/widgetApproval.testkit';
import { createDaemonApprovalExecutionAuthorizationPreparer } from './approvalExecutionAuthorization';

it('a stored Workflow root retains its own custody instead of borrowing the deciding Account credential box', async () => {
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
    const credentials = { token: `header.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`, encryption: null };
    const features = registerAccountHomeHttp(app, { accountId, serverId: homeId, settings: {} });
    app.get('/v1/features', async () => ({ ...features, capabilities: { ...features.capabilities,
      encryption: { storagePolicy: 'optional', allowAccountOptOut: true, defaultAccountMode: 'plain' } } }));
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
      authentication: { kind: 'account', tokenEpoch: 1 }, accountEncryptionMode: 'plain',
      actionId: 'deployments.deploy', requestId: envelope.requestId, machineId,
      installationId: installation.installationId, target, admittedMachineRole: 'manage',
      requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
      workflowActionOrigin: { runId: 'workflow-run', requestId: envelope.requestId },
    } });
    const binding = authorization.binding;
    if (!('authentication' in binding)) throw new Error('Expected an Account root');
    // HTTP and the installation filesystem are the only boundaries. The
    // requester admission, private projection and replay preparer stay real.
    let requester: Awaited<ReturnType<typeof admitRequesterAccountActionContext>> | undefined;
    try {
      requester = await runWithServerHttpBaseUrl(endpoint, () => admitRequesterAccountActionContext({ authorization: {
        ...authorization, binding: { ...binding, workflowActionOrigin: undefined },
      }, credentials, serverId: configuration.activeServerId, serverIdentityId: homeId,
        serverHttpBaseUrl: endpoint, isCurrent: async () => true })).catch(error => {
          throw new Error(`Requester fixture failed after ${JSON.stringify(requests)}`, { cause: error });
        });
      expect(requester).not.toBeNull();
      if (!requester) throw new Error('Requester admission unavailable');
      const prepare = createDaemonApprovalExecutionAuthorizationPreparer({ machineId,
        serverId: configuration.activeServerId, serverBaseUrl: endpoint,
        requesterAccountContext: requester, daemonWorkSignal: new AbortController().signal,
        resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId: homeId, machineId }),
      });
      const prepared = await prepare({ authorization });
      expect(prepared?.authorization).toMatchObject({ token: authorization.token,
        binding: { workflowActionOrigin: binding.workflowActionOrigin } });
      expect(prepared?.authorization.requesterAccountContext).toBeUndefined();
      await prepared?.dispose?.();
    } finally { await requester?.dispose(); await channel.close(); fetchBoundary.mockRestore(); restore(); await app.close(); }
  });
});
