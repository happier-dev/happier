import axios from 'axios';
import { createHash, randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createActionExecutor, createEmptyMachineSetupDesiredV1 } from '@happier-dev/protocol';
import { ed25519, x25519 } from '@noble/curves/ed25519';
import { encodeBase64, sealEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol';
import { encryptWithDataKey } from '@/api/encryption';
import { createDeploymentEnvironmentDetailV1, createDeploymentEnvironmentHeaderV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1 } from '@happier-dev/deployment-protocol';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { createAccountEncryptionCurrentnessFixture } from '@/testkit/backends/sessionFixtures';
import { ExternalActionExecutionAuthorizationRequestV1Schema, ExternalActionExecutionAuthorizationV1Schema, ExternalActionResponseEnvelopeV1Schema,
  projectDeploymentReadAdmissionV1, createDeploymentCandidatePublicationV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { createCliActionDeps } from './createCliActionDeps';
import { createRequesterBoundDeploymentActionDeps } from '@/daemon/externalActions/deploymentActionDeps';
import tweetnacl from 'tweetnacl';
import { createMachineContentCodec } from '@/api/machine/machineStoredContent';
import { MachinePublishedMetadataV1Schema } from '@happier-dev/protocol/machines/machinePublishedContentV1';

afterEach(() => vi.restoreAllMocks());
const token = `header.${Buffer.from(JSON.stringify({ sub: 'deployment-account' })).toString('base64url')}.signature`;
const artifact = { contentArtifactId: 'private-content', contentHeaderVersion: 1, contentBodyVersion: 1 };
function executor() {
  return createActionExecutor(createCliActionDeps({ token, credentials: { token, encryption: null },
    sessionId: 'deployment-session', mode: 'plain', ctx: null,
    serverId: 'deployment-home', serverHttpBaseUrl: 'https://deployment-home.test' }));
}

it.each([['plain', 'session'], ['e2ee', 'session'], ['plain', 'daemon'], ['e2ee', 'daemon']] as const)(
  'lists %s Environment names for an agent on %s using headers without body reads', async (mode, host) => {
  const secret = randomBytes(32);
  const dataKey = randomBytes(32);
  const credentials = { token, encryption: mode === 'plain' ? null : {
    type: 'dataKey' as const, publicKey: x25519.getPublicKey(secret), machineKey: secret,
  } };
  const names = ['odeploy-qa-env-1030', 'Deployment content', 'Stale private title'];
  const items = names.map((_, i) => createDeploymentEnvironmentHeaderV1({ id: `env-${i}`,
    serverId: 'deployment-home', projectSourceId: 'source', ...artifact, contentArtifactId: `content-${i}` }));
  vi.spyOn(axios, 'request').mockResolvedValue({ status: 200, data: { ok: true, items, nextCursor: null } });
  vi.spyOn(axios, 'get').mockImplementation(async url => {
    if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200,
      data: createAccountEncryptionCurrentnessFixture({ mode }) };
    if (url.endsWith('/v1/account/encryption')) return { status: 200, data: { mode, updatedAt: 0 } };
    throw new Error(`Unexpected full Artifact or Environment read: ${url}`);
  });
  const headers = vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
    expect(url).toBe('https://deployment-home.test/v1/artifacts/read');
    expect(body).toMatchObject({ projection: 'headers' });
    const ids = (body as { artifactIds: string[] }).artifactIds;
    return { status: 200, data: { projection: 'headers', items: ids.map(id => {
      const header = { kind: DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, title: names[Number(id.split('-')[1])] };
      return { artifactId: id, ok: true, artifact: { id, ownerAccountId: 'deployment-account', access: 'owner',
        publicAudience: 'none', encryptionMode: mode,
        dataEncryptionKey: mode === 'plain' ? ARTIFACT_PLAIN_DATA_KEY_MARKER
          : encodeBase64(sealEncryptedDataKeyEnvelopeV1({ dataKey, recipientPublicKey: credentials.encryption!.publicKey, randomBytes })),
        header: mode === 'plain' ? encodePlainArtifactStoredContent(header) : encodeBase64(encryptWithDataKey(header, dataKey)),
        headerVersion: id === 'content-2' ? 2 : 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 } };
    }) } };
  });
  const accountDeps = createCliActionDeps({ token, credentials,
    sessionId: 'deployment-session', mode, ctx: null, serverId: 'deployment-home',
    serverHttpBaseUrl: 'https://deployment-home.test' });
  const actions = createActionExecutor(host === 'session' ? accountDeps : { ...accountDeps, ...createRequesterBoundDeploymentActionDeps({
      credentials, serverId: 'deployment-home', serverHttpBaseUrl: 'https://deployment-home.test', machineId: 'reader',
      resolveRequesterIdentity: async () => { throw new Error('A list cannot acquire native deployment identity'); },
      runtime: { async acquire() { throw new Error('A list cannot acquire native runtime'); } },
    }) });
  const result = await actions.execute('deployments.environments.list', { serverId: 'deployment-home', projectSourceId: 'source' },
    { surface: 'mcp', authority: 'account_automation' });
  expect(result).toMatchObject({ ok: true, result: { ok: true, coverage: 'partial', items: [
    { id: items[0]!.id, name: names[0] }, { id: items[1]!.id, name: names[1] }, { id: items[2]!.id },
  ] } });
  expect(JSON.stringify(result)).not.toContain('Stale private title');
  expect(headers.mock.calls.flatMap(([, body]) => (body as { artifactIds: string[] }).artifactIds).sort())
    .toEqual(['content-0', 'content-1', 'content-2']);
});

describe('Deployment Actions through the default CLI Account front door', () => {
  it('prepares combined setup from fresh host facts with zero fleet metadata openings', async () => {
    const secret = new Uint8Array(32).fill(7);
    const codec = createMachineContentCodec({ encryptionMode: 'e2ee', encryptionVariant: 'legacy', encryptionKey: secret });
    const metadata = codec.encodeStored(MachinePublishedMetadataV1Schema.parse({ host: 'worker', platform: 'linux',
      happyCliVersion: 'test', homeDir: '/home/worker', happyHomeDir: '/home/worker/.happier' }));
    const access = { custodian: { accountId: 'deployment-account', displayName: 'Owner' }, role: 'manage',
      resourceMode: 'e2ee', accessState: 'ready' };
    let selected = { id: 'parent-host', kind: 'persistent', active: true, activeAt: Date.now(),
      revokedAt: null as number | null, replacedByMachineId: null, storageMode: 'e2ee', metadata, access };
    const fleet = Array.from({ length: 128 }, (_, index) => ({ ...selected, id: `other-${index}` }));
    vi.spyOn(axios, 'get').mockImplementation(async (url, config) => {
      expect(config?.headers).toMatchObject({ Accept: 'application/json;happier-machine-projection=host-facts' });
      return { status: 200, data: String(url).endsWith('/v1/machines/parent-host')
        ? { machine: selected } : [selected, ...fleet] };
    });
    const opens = vi.spyOn(tweetnacl.secretbox, 'open');
    const deps = createCliActionDeps({ token, credentials: { token, encryption: { type: 'legacy', secret } },
      sessionId: 'deployment-session', mode: 'plain', ctx: null,
      serverId: 'deployment-home', serverHttpBaseUrl: 'https://deployment-home.test' });
    const input = { homeId: 'deployment-home', machineId: 'parent-host', targets: [{ homeId: 'deployment-home',
      machineId: 'target', desiredRevision: 0, sources: createEmptyMachineSetupDesiredV1().sources, recipePlans: [] }] };
    const context = { surface: 'ui' as const, authority: 'present_user' as const, serverId: 'deployment-home',
      runtimeAccountId: 'deployment-account', actionCaller: { kind: 'host' as const } };
    expect(await deps.prepareMachineSetupApply!({ input, context })).toMatchObject({ input,
      host: { machines: expect.arrayContaining([{ machineId: 'parent-host', online: true }]) } });
    expect(opens).not.toHaveBeenCalled();
    selected = { ...selected, access: { ...access, accessState: 'key_pending' } };
    expect(await deps.prepareMachineSetupApply!({ input, context })).toMatchObject({ ok: false, errorCode: 'machine_unavailable' });
    selected = { ...selected, access, revokedAt: 5 };
    expect(await deps.prepareMachineSetupApply!({ input, context })).toMatchObject({ ok: false, errorCode: 'machine_unavailable' });
    // A fresh last-seen still belongs to the canonical presence grace even when active is false.
    selected = { ...selected, access, revokedAt: null, active: false, activeAt: Date.now() };
    expect(await deps.prepareMachineSetupApply!({ input, context })).toMatchObject({ input,
      host: { machines: expect.arrayContaining([{ machineId: 'parent-host', online: true }]) } });
    selected = { ...selected, activeAt: 0 };
    expect(await deps.prepareMachineSetupApply!({ input, context })).toMatchObject({ ok: false, errorCode: 'machine_unavailable' });
    expect(opens).not.toHaveBeenCalled();
  });
  it('keeps the original draft on its offline controller while another Machine is online', async () => {
    const accountToken = `header.${Buffer.from(JSON.stringify({ sub: 'deployment-account', tokenEpoch: 7,
      provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.signature`;
    const environment = createDeploymentEnvironmentHeaderV1({ id: 'staging', serverId: 'deployment-home', controllerMachineId: 'selected-controller' });
    const machine = { id: 'selected-controller', kind: 'persistent', active: false, installationId: 'selected-installation',
      revokedAt: null, replacedByMachineId: null, storageMode: 'plain',
      installationPublicKey: Buffer.from(ed25519.getPublicKey(new Uint8Array(32).fill(19))).toString('base64'),
      access: { custodian: { accountId: 'deployment-account', displayName: 'Owner' }, role: 'manage', resourceMode: 'plain', accessState: 'ready' } };
    const input = { serverId: 'deployment-home', environmentId: 'staging', expectedRevision: 1, requestKey: 'retained-draft',
      targetLinkId: 'target-link', expectedTargetLinkRevision: 1, ...artifact };
    const original = structuredClone(input);
    vi.spyOn(axios, 'request').mockResolvedValue({ status: 200, data: { ok: true, environment, targetLinks: [] } });
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      if (String(url).endsWith('/v1/account/encryption')) return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
      if (String(url).endsWith('/v1/machines')) return { status: 200, data: [machine, { ...machine, id: 'online-invoker', active: true }] };
      if (String(url).endsWith('/v1/machines/selected-controller')) return { status: 200, data: { machine } };
      throw new Error(`Unexpected controller read: ${String(url)}`);
    });
    const relayedTargets: unknown[] = [];
    const sends = vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
      const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
      relayedTargets.push(request.envelope.target);
      expect(request.envelope).toMatchObject({ input: original });
      if (String(url).endsWith('/execution-authorization')) return { status: 200,
        data: ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'home-proof', binding: {
          accountId: 'deployment-account', authentication: { kind: 'account', tokenEpoch: 7 }, accountEncryptionMode: 'plain',
          serverIdentityId: 'srv_deployment_home', custodianAccountId: 'deployment-account', machineId: machine.id,
          installationId: machine.installationId, actionId: 'deployments.deploy', requestId: 'controller-request', target: request.envelope.target,
          requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(request.envelope),
          deploymentCandidatePublication: createDeploymentCandidatePublicationV1({ accountId: 'deployment-account',
            serverIdentityId: 'srv_deployment_home', actionId: 'deployments.deploy', requestId: 'controller-request',
            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(request.envelope), environmentId: environment.id,
            source: { id: environment.projectSourceId, revision: 1 } }),
        } }) };
      expect(url).toBe('https://deployment-home.test/v1/actions/deployments.deploy');
      return { status: 200, data: ExternalActionResponseEnvelopeV1Schema.parse({ v: 1,
        actionId: new URL(String(url)).pathname.slice('/v1/actions/'.length), requestId: request.envelope.requestId,
        // Home knows the receiver is offline; the deployment placement owner
        // knows why this exact Machine was selected.
        execution: { ok: false, errorCode: 'machine_unavailable', error: 'machine_unavailable' },
      }) };
    });
    // Provider HTTP is a genuine external boundary; Home retains the draft and
    // refuses offline delivery before any Account plugin can send to a provider.
    const provider = vi.spyOn(globalThis, 'fetch');
    const deps = createCliActionDeps({ token: accountToken, credentials: { token: accountToken, encryption: null },
      sessionId: 'deployment-session', mode: 'plain', ctx: null, serverId: 'deployment-home',
      serverIdentityId: 'srv_deployment_home', serverHttpBaseUrl: 'https://deployment-home.test' });
    expect(await deps.deploymentAction!('deployments.deploy', input, { surface: 'ui', authority: 'present_user',
      actionCaller: { kind: 'host' }, actionRequestId: 'controller-request', runtimeAccountId: 'deployment-account' }))
      .toMatchObject({ ok: false, errorCode: 'machine_unavailable', details: { role: 'controller', machineId: 'selected-controller' } });
    expect(sends).toHaveBeenCalledTimes(2);
    expect(relayedTargets).toEqual(Array.from({ length: 2 }, () => ({ kind: 'machine', machineId: 'selected-controller' })));
    expect(provider).not.toHaveBeenCalled();
    expect(input).toEqual(original);
  });

  it.each(['deployments.deploy', 'deployments.rollback', 'deployments.promote', 'deployments.teardown',
    'deployments.targets.link', 'deployments.health.read', 'deployments.drift.read', 'deployments.logs.read'] as const)(
    'relays %s unchanged to its exact Machine with Home admission and no originating storage mutation', async actionId => {
      const isRead = actionId.endsWith('.read');
      const accountToken = `header.${Buffer.from(JSON.stringify({ sub: 'deployment-account', tokenEpoch: 7,
        provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.signature`;
      const controller = { id: isRead ? actionId === 'deployments.logs.read' ? 'selected-builder' : 'selected-runtime' : 'current-controller', kind: 'persistent', active: true,
        installationId: 'current-installation', revokedAt: null, replacedByMachineId: null, storageMode: 'plain',
        installationPublicKey: Buffer.from(ed25519.getPublicKey(new Uint8Array(32).fill(19))).toString('base64'),
        access: { custodian: { accountId: 'deployment-account', displayName: 'Owner' }, role: 'manage', resourceMode: 'plain', accessState: 'ready' } };
      const environment = createDeploymentEnvironmentHeaderV1({ id: 'staging', serverId: 'deployment-home',
        controllerMachineId: isRead ? 'environment-controller' : controller.id, buildMachineId: 'selected-builder' });
      const service = { kind: 'deployment' as const, machineId: controller.id, environmentId: 'staging',
        environmentInstanceId: 'deployment-instance', composeService: 'app', serviceId: 'deployment-instance/app' };
      const input = actionId === 'deployments.targets.link' ? { serverId: 'deployment-home', environmentId: 'staging',
        expectedRevision: 1, requestKey: 'original-intent', role: 'runtime' as const, targetId: 'platform', targetKind: 'platform',
        source: { kind: 'plugin' as const, contribution: { pluginId: 'example.deploy', localId: 'platform' } }, machines: [],
        provider: { credentialPrincipal: { kind: 'account' as const, accountId: 'deployment-account',
          purpose: { consumer: { pluginId: 'example.deploy', localId: 'platform' }, purpose: 'manage' },
          target: { kind: 'account' as const, account: { service: { pluginId: 'example.deploy', localId: 'service' }, accountId: 'credential' } } },
          providerIdentity: { providerAccountId: 'native-account', providerResourceId: 'native-resource', providerEnvironment: 'production' },
          providerEnvironment: { kind: 'production' as const } } }
        : isRead ? { serverId: 'deployment-home', environmentId: 'staging', deploymentId: 'selected-receipt',
        targetLinkId: 'target-link', machineId: controller.id, installationId: controller.installationId,
        ...(actionId === 'deployments.logs.read' ? { kind: 'build' as const } : { service }),
        ...(actionId === 'deployments.drift.read' ? { expectedRevision: 3 } : {}) }
        : { serverId: 'deployment-home', environmentId: 'staging', expectedRevision: 1,
        requestKey: 'original-intent', targetLinkId: 'target-link', expectedTargetLinkRevision: 1, ...artifact,
        ...(actionId === 'deployments.rollback' ? { deploymentId: 'previous' } : {}),
        ...(actionId === 'deployments.promote' ? { sourceEnvironmentId: 'production', sourceDeploymentId: 'source-release',
          artifact: 'image' as const, destinationContent: artifact } : {}),
        ...(actionId === 'deployments.teardown' ? { reason: 'manual' as const } : {}) };
      const result = actionId === 'deployments.targets.link' ? { ok: true, environmentId: 'staging', revision: 2,
        targetLinkId: 'linked-target', targetLinkRevision: 1 }
        : isRead ? { ok: false, error: 'deployment_unavailable' }
        : { ok: true, environmentId: 'staging', revision: 2, deploymentId: 'accepted-receipt', deploymentRevision: 1, state: 'succeeded' };
      // Only Home HTTP is substituted: factory admission, routing, envelope digest,
      // requester-context sealing and response validation remain real.
      const storage = vi.spyOn(axios, 'request').mockImplementation(async config => {
        expect(config.method).toBe('GET'); // An originating client must not reserve a receipt.
        expect(config.url).toBe('https://deployment-home.test/v1/deployments/environments/staging?serverId=deployment-home');
        return { status: 200, data: { ok: true, environment, targetLinks: [] } };
      });
      vi.spyOn(axios, 'get').mockImplementation(async url => {
        if (url === 'https://deployment-home.test/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
        if (url === 'https://deployment-home.test/v1/machines') return { status: 200, data: [controller] };
        if (url === `https://deployment-home.test/v1/machines/${controller.id}`) return { status: 200, data: { machine: controller } };
        throw new Error(`Unexpected Home read: ${url}`);
      });
      const events: string[] = [];
      const transport = vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
        const prepared = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
        expect(prepared.envelope).toEqual({ v: 1, requestId: 'relay-request', target: { kind: 'machine', machineId: controller.id }, input });
        if (String(url).endsWith('/execution-authorization')) {
          events.push('authorize');
          return { status: 200, data: ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'home-proof', binding: {
            accountId: 'deployment-account', authentication: { kind: 'account', tokenEpoch: 7 }, accountEncryptionMode: 'plain',
            serverIdentityId: 'srv_deployment_home', custodianAccountId: 'deployment-account', machineId: controller.id,
            installationId: controller.installationId, actionId, requestId: 'relay-request', target: prepared.envelope.target,
            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(prepared.envelope),
            ...(isRead ? { deploymentReadAdmission: projectDeploymentReadAdmissionV1(actionId, input) } : {}),
            ...(actionId === 'deployments.teardown' ? { environmentId: environment.id } : isRead || actionId === 'deployments.targets.link' ? {}
              : { deploymentCandidatePublication: createDeploymentCandidatePublicationV1({ accountId: 'deployment-account',
                serverIdentityId: 'srv_deployment_home', actionId, requestId: 'relay-request',
                requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(prepared.envelope), environmentId: environment.id,
                source: { id: environment.projectSourceId, revision: 1 } }) }),
          } }) };
        }
        expect(url).toBe(`https://deployment-home.test/v1/actions/${actionId}`);
        expect(prepared.executionAuthorization?.binding).toMatchObject({ actionId, machineId: controller.id, installationId: controller.installationId });
        expect(prepared.executionAuthorization?.requesterAccountContext).toBeDefined();
        events.push('dispatch');
        return { status: 200, data: { v: 1, actionId, requestId: 'relay-request', execution: { ok: true, result } } };
      });
      const deps = createCliActionDeps({ token: accountToken, credentials: { token: accountToken, encryption: null },
        sessionId: 'deployment-session', mode: 'plain', ctx: null, serverId: 'deployment-home',
        serverIdentityId: 'srv_deployment_home', serverHttpBaseUrl: 'https://deployment-home.test' });
      expect(await deps.deploymentAction!(actionId, input, { surface: 'ui', authority: 'present_user',
        actionCaller: { kind: 'host' }, actionRequestId: 'relay-request', runtimeAccountId: 'deployment-account' })).toEqual(result);
      expect(events).toEqual(['authorize', 'dispatch']);
      expect(storage).toHaveBeenCalledTimes(1);
      expect(transport).toHaveBeenCalledTimes(2);
    });

  it('keeps prepared target links on the existing storage path without controller dispatch', async () => {
    const input = { serverId: 'deployment-home', environmentId: 'staging', expectedRevision: 1,
      requestKey: 'prepared-link', role: 'runtime' as const, targetId: 'own-server',
      machines: [{ machineId: 'runtime', installationId: 'installed-runtime' }], ...artifact };
    const result = { ok: true, environmentId: 'staging', revision: 2, targetLinkId: 'linked-target', targetLinkRevision: 1 };
    const requests = vi.spyOn(axios, 'request').mockResolvedValue({ status: 200, data: result });
    const dispatch = vi.spyOn(axios, 'post').mockImplementation(async () => { throw new Error('Prepared links must not dispatch'); });
    const deps = createCliActionDeps({ token, credentials: { token, encryption: null },
      sessionId: 'deployment-session', mode: 'plain', ctx: null, serverId: 'deployment-home',
      serverHttpBaseUrl: 'https://deployment-home.test' });
    expect(await deps.deploymentAction!('deployments.targets.link', input, { surface: 'ui', authority: 'present_user',
      actionCaller: { kind: 'host' }, actionRequestId: 'prepared-link', runtimeAccountId: 'deployment-account' })).toEqual(result);
    expect(requests.mock.calls.map(([request]) => ({ method: request.method, url: request.url, data: request.data })))
      .toEqual([{ method: 'POST', url: 'https://deployment-home.test/v1/deployments/environments/staging/targets', data: input }]);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('creates and pages keyless metadata using the declared storage routes and preserves a non-retryable conflict', async () => {
    // HTTP is the boundary; the registered Action, Home admission and transport binding remain real.
    const detail = createDeploymentEnvironmentDetailV1();
    const document = JSON.stringify({ services: { app: { image: 'example/app:1' } } });
    const content = { ...detail.content, definition: { kind: 'stored', contentRevision: 1, document,
      composeDigest: `sha256:${createHash('sha256').update(document).digest('hex')}`, profiles: [], services: ['app'] } };
    const artifactReads = vi.spyOn(axios, 'get').mockImplementation(async url => {
      if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: createAccountEncryptionCurrentnessFixture() };
      if (url.endsWith('/v1/account/encryption')) return { status: 200, data: { mode: 'plain', updatedAt: 0 } };
      expect(url).toBe(`https://deployment-home.test/v1/artifacts/${artifact.contentArtifactId}`);
      return { status: 200, data: { id: artifact.contentArtifactId, ownerAccountId: 'deployment-account', access: 'owner',
        publicAudience: 'none', encryptionMode: 'plain', dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
        header: encodePlainArtifactStoredContent({ kind: DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, title: 'Stored' }),
        body: encodePlainArtifactStoredContent({ body: JSON.stringify(content) }), headerVersion: 1, bodyVersion: 1,
        seq: 1, createdAt: 1, updatedAt: 1 } };
    });
    const request = vi.spyOn(axios, 'request')
      .mockResolvedValueOnce({ status: 201, data: { ok: true, environmentId: 'staging', revision: 1 } })
      .mockResolvedValueOnce({ status: 200, data: { ok: true, items: [], nextCursor: null } })
      .mockResolvedValueOnce({ status: 409, data: { ok: false, error: 'deployment_conflict' } });
    const actions = executor();
    const input = { serverId: 'deployment-home', projectSourceId: 'source', requestKey: 'create-staging',
      protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers', controllerMachineId: 'guest', ...artifact };
    const context = { surface: 'ui' as const, authority: 'present_user' as const };
    expect(await actions.execute('deployments.environments.create', input, context))
      .toEqual({ ok: true, result: { ok: true, environmentId: 'staging', revision: 1 } });
    expect(await actions.execute('deployments.environments.list', { serverId: 'deployment-home', projectSourceId: 'source', limit: 7 }, context))
      .toEqual({ ok: true, result: { ok: true, items: [], nextCursor: null } });
    expect(await actions.execute('deployments.environments.create', { ...input, requestKey: 'conflict' }, context))
      .toMatchObject({ ok: false, errorCode: 'deployment_conflict', details: { ok: false, error: 'deployment_conflict' } });
    expect(request.mock.calls.map(([config]) => [config.method, config.url])).toEqual([
      ['POST', 'https://deployment-home.test/v1/deployments/environments'],
      ['GET', 'https://deployment-home.test/v1/deployments/environments?serverId=deployment-home&projectSourceId=source&limit=7'],
      ['POST', 'https://deployment-home.test/v1/deployments/environments'],
    ]);
    expect(request.mock.calls[0]?.[0]).toMatchObject({ data: input, headers: { Authorization: `Bearer ${token}` } });
    expect(artifactReads.mock.calls.filter(([url]) => url.endsWith(`/v1/artifacts/${artifact.contentArtifactId}`))).toHaveLength(2);
    request.mockClear();
    expect(await actions.execute('deployments.environments.list', { serverId: 'other-home', projectSourceId: 'source' }, context))
      .toMatchObject({ ok: false, errorCode: 'server_scope_mismatch' });
    expect(request).not.toHaveBeenCalled();
  });
});
