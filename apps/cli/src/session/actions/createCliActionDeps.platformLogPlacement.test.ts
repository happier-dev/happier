import axios from 'axios';
import { ed25519 } from '@noble/curves/ed25519';
import { afterEach, expect, it, vi } from 'vitest';
import { createDeploymentEnvironmentHeaderV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { ExternalActionExecutionAuthorizationRequestV1Schema, ExternalActionExecutionAuthorizationV1Schema,
  projectDeploymentReadAdmissionV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { createCliActionDeps } from './createCliActionDeps';

afterEach(() => vi.restoreAllMocks());

// COR6-164/agent-logs-build-{1,2}.json: compact platform logs were refused,
// while adding the Environment controller returned this retained log result.
const retained = { ok: true, environmentId: 'cmwixbwli01oymc06hjziiy00',
  deploymentId: 'cmwixgfni01spmc06jo7d0fp0', targetLinkId: 'cmwixc15k01plmc06g9igvyvc',
  kind: 'build', logs: { kind: 'unavailable', reason: 'unsupported' } } as const;

it.each(['ui', 'cli'] as const)('routes compact platform logs from %s through the retained Environment controller', async surface => {
  const actionId = 'deployments.logs.read';
  const input = { serverId: 'deployment-home', environmentId: retained.environmentId,
    deploymentId: retained.deploymentId, targetLinkId: retained.targetLinkId, kind: retained.kind };
  const token = `header.${Buffer.from(JSON.stringify({ sub: 'deployment-account', tokenEpoch: 7,
    provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.signature`;
  const controller = { id: '6440', kind: 'persistent', active: true, installationId: 'controller-installation',
    revokedAt: null, replacedByMachineId: null, storageMode: 'plain',
    installationPublicKey: Buffer.from(ed25519.getPublicKey(new Uint8Array(32).fill(19))).toString('base64'),
    access: { custodian: { accountId: 'deployment-account', displayName: 'Owner' }, role: 'manage',
      resourceMode: 'plain', accessState: 'ready' } };
  const environment = createDeploymentEnvironmentHeaderV1({ id: retained.environmentId,
    serverId: input.serverId, controllerMachineId: controller.id, buildMachineId: 'd227' });
  // Home HTTP is the only substituted boundary. Placement, requester carriage,
  // root dispatch, schema validation and envelope binding remain real.
  vi.spyOn(axios, 'request').mockImplementation(async config => {
    expect(config.method).toBe('GET');
    expect(config.url).toBe(`https://deployment-home.test/v1/deployments/environments/${environment.id}?serverId=deployment-home`);
    return { status: 200, data: { ok: true, environment, targetLinks: [] } };
  });
  vi.spyOn(axios, 'get').mockImplementation(async url => {
    if (url === 'https://deployment-home.test/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
    if (url === 'https://deployment-home.test/v1/machines') return { status: 200, data: [controller] };
    expect(url).toBe(`https://deployment-home.test/v1/machines/${controller.id}`);
    return { status: 200, data: { machine: controller } };
  });
  const boundaryErrors: unknown[] = [];
  const delivered: unknown[] = [];
  vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
    try {
      const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
      expect(request.envelope).toEqual({ v: 1, requestId: 'platform-log-request',
        target: { kind: 'machine', machineId: controller.id }, input });
      if (String(url).endsWith('/execution-authorization')) return { status: 200,
        data: ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'home-proof', binding: {
          accountId: 'deployment-account', authentication: { kind: 'account', tokenEpoch: 7 }, accountEncryptionMode: 'plain',
          serverIdentityId: 'srv_deployment_home', custodianAccountId: 'deployment-account', machineId: controller.id,
          installationId: controller.installationId, actionId, requestId: request.envelope.requestId,
          target: request.envelope.target, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(request.envelope),
          deploymentReadAdmission: projectDeploymentReadAdmissionV1(actionId, input),
        } }) };
      expect(url).toBe(`https://deployment-home.test/v1/actions/${actionId}`);
      delivered.push(request.envelope.input);
      return { status: 200, data: { v: 1, actionId, requestId: request.envelope.requestId,
        execution: { ok: true, result: retained } } };
    } catch (error) { boundaryErrors.push(error); throw error; }
  });
  const deps = createCliActionDeps({ token, credentials: { token, encryption: null },
    sessionId: 'deployment-session', machineId: 'd227', mode: 'plain', ctx: null, serverId: input.serverId,
    serverIdentityId: 'srv_deployment_home', serverHttpBaseUrl: 'https://deployment-home.test' });
  const actual = await deps.deploymentAction!(actionId, input, { surface, authority: 'present_user',
    actionCaller: { kind: 'host' }, actionRequestId: 'platform-log-request', runtimeAccountId: 'deployment-account',
    defaultSessionMachineId: 'd227' });
  expect(boundaryErrors).toEqual([]);
  expect(actual).toEqual(retained);
  expect(delivered).toEqual([input]);
});
