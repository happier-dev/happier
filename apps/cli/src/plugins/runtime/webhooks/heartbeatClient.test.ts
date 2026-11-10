import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import tweetnacl from 'tweetnacl';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ActionsService } from '@happier-dev/plugin-sdk/actions';
import type { HealthCheckSourceConfigV1 } from '@happier-dev/protocol/activity/usageNoticeArtifactV1';
import { sealAutomationTriggerDefinitionStoredEnvelopeV1 } from '@happier-dev/protocol/automations/automationTriggerDefinitionStoredContent';
import type { AutomationEventStoredDefinitionProjectionV1 } from '@happier-dev/protocol';
import { createAutomationEventAdoptedDefinitionSetHostV1 } from '@/plugins/runtime/automations/automationEventAdoptedDefinitionSetHost';
import type { PluginInvocationServicesSeed } from '@/plugins/runtime/invocation/services/types';
import { createSavedHealthChecksHost } from '@/deployments/healthChecks/savedHealthChecks';
import { createPluginHttpService } from '@/plugins/runtime/fetch/service';
import { createGlobalFetchRuntime } from '@/plugins/runtime/fetch/globalFetchRuntime';
import {
  PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1,
  PluginInstallationManifestPublisherHeaderV1Schema,
  createPluginInstallationManifestPublisherSigningInputV1,
  stringifyPluginInstallationManifestCanonicalJsonV1,
} from '@happier-dev/protocol/plugins/installations/manifests';
import {
  PLUGIN_WEBHOOK_HEARTBEAT_ENSURE_PATH_V1,
  PLUGIN_WEBHOOK_HEARTBEAT_READ_PATH_V1,
  PluginWebhookEndpointEnsureInputV1Schema,
  PluginWebhookHeartbeatReadInputV1Schema,
} from '@happier-dev/protocol/plugins/webhooks/endpointV1';
import { configuration, reloadConfiguration } from '@/configuration';
import { readCurrentMachineInstallation } from '@/daemon/identity/currentMachineInstallation';
import { writeSettings, type StoredCredentials } from '@/persistence';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { createPluginWebhookHeartbeatClient } from './heartbeatClient';

const caller = { machineId: 'heartbeat-machine', materializationId: 'health-materialization', pluginId: 'happier.machine.services' };
const endpointId = 'wh_ep_AAECAwQFBgcICQoLDA0ODw';
const enrollRequest = { caller, sourceInstanceId: 'health-source', checkId: '检查'.repeat(1000), heartbeatContributionId: 'heartbeat' };
const readRequest = { caller, sourceInstanceId: enrollRequest.sourceInstanceId, checkId: enrollRequest.checkId, webhookEndpointId: endpointId };

describe('finite heartbeat Home client', () => {
  const env = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_SERVER_URL', 'HAPPIER_LOCAL_SERVER_URL', 'HAPPIER_ACTIVE_SERVER_ID']);
  let home: string;
  let credentials: StoredCredentials | null;
  const requests: Array<{ path: string; authorization: string | undefined; body: unknown; proof: string | undefined }> = [];
  let reply: (request: IncomingMessage, response: ServerResponse) => void;
  const server = createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += String(chunk);
    requests.push({ path: request.url ?? '', authorization: request.headers.authorization,
      body: JSON.parse(raw), proof: request.headers[PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1] as string | undefined });
    reply(request, response);
  });
  let serverHttpBaseUrl: string;

  beforeEach(async () => {
    requests.length = 0;
    home = await createTempDir('happier-heartbeat-client-');
    env.patch({ HAPPIER_HOME_DIR: home, HAPPIER_SERVER_URL: 'https://wrong-ambient-home.invalid',
      HAPPIER_LOCAL_SERVER_URL: '', HAPPIER_ACTIVE_SERVER_ID: '' });
    reloadConfiguration();
    await writeSettings({ schemaVersion: 6, onboardingCompleted: true,
      machineIdByServerId: { [configuration.activeServerId]: caller.machineId } });
    credentials = { token: 'synthetic-heartbeat-account', encryption: null };
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing test listener');
    serverHttpBaseUrl = `http://127.0.0.1:${address.port}`;
    reply = (request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(request.url === PLUGIN_WEBHOOK_HEARTBEAT_ENSURE_PATH_V1
        ? { webhookEndpointId: endpointId, revision: 1, publicUrl: `${serverHttpBaseUrl}/secret-ping-url`, readiness: 'ready' }
        : { kind: 'ready', lastAcceptedAt: null }));
    };
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    env.restore();
    reloadConfiguration();
    await removeTempDir(home);
  });

  it('enrolls another capability contribution for a saved check without aliasing its previous endpoint request', async () => {
    const client = createPluginWebhookHeartbeatClient({ readCredentials: async () => credentials, serverHttpBaseUrl });
    await client.enroll(enrollRequest);
    await client.enroll({ ...enrollRequest, heartbeatContributionId: 'health-uptime-kuma' });
    const first = PluginWebhookEndpointEnsureInputV1Schema.parse(requests[0]?.body &&
      (requests[0].body as { input: unknown }).input);
    const second = PluginWebhookEndpointEnsureInputV1Schema.parse(requests[1]?.body &&
      (requests[1].body as { input: unknown }).input);
    expect(second.idempotencyKey).not.toBe(first.idempotencyKey);
    expect(second.webhookContribution.localId).toBe('health-uptime-kuma');
  });

  const client = () => createPluginWebhookHeartbeatClient({ readCredentials: async () => credentials, serverHttpBaseUrl });

  it('sends exact lifecycle requests with installation proof and keeps URL-bearing responses out of the service result', async () => {
    const input = { operation: 'rotate' as const, webhookEndpointId: endpointId, sourceInstanceId: enrollRequest.sourceInstanceId,
      checkId: enrollRequest.checkId, expectedRevision: 1, idempotencyKey: 'heartbeat-rotate-0001' };
    reply = (_request, response) => response.end(JSON.stringify({ kind: 'rotated', webhookEndpointId: endpointId, revision: 2 }));
    expect(await client().manage({ caller, input })).toEqual({ kind: 'rotated', webhookEndpointId: endpointId, revision: 2 });
    expect(requests).toEqual([expect.objectContaining({ path: '/v1/daemon/plugins/webhooks/heartbeat/manage',
      authorization: 'Bearer synthetic-heartbeat-account', body: { caller, input }, proof: expect.any(String) })]);
    reply = (_request, response) => response.end(JSON.stringify({ kind: 'rotated', webhookEndpointId: endpointId,
      revision: 3, publicUrl: `${serverHttpBaseUrl}/secret-ping-url` }));
    expect(await client().manage({ caller, input })).toEqual({ kind: 'unavailable', code: 'endpoint_unavailable' });
  });

  it('enrolls and reads at the supplied Home with exact installation-signed bodies and current Account credentials', async () => {
    const transport = client();
    await expect(transport.enroll(enrollRequest)).resolves.toEqual({ webhookEndpointId: endpointId });
    credentials = { token: 'synthetic-replacement-account', encryption: null };
    await expect(transport.read(readRequest)).resolves.toEqual({ kind: 'ready', lastAcceptedAt: null });
    expect(requests.map(request => [request.path, request.authorization])).toEqual([
      [PLUGIN_WEBHOOK_HEARTBEAT_ENSURE_PATH_V1, 'Bearer synthetic-heartbeat-account'],
      [PLUGIN_WEBHOOK_HEARTBEAT_READ_PATH_V1, 'Bearer synthetic-replacement-account'],
    ]);
    const enrollment = requests[0].body as { caller: unknown; input: unknown };
    expect(enrollment.caller).toEqual(caller);
    expect(PluginWebhookEndpointEnsureInputV1Schema.parse(enrollment.input)).toMatchObject({
      webhookContribution: { pluginId: caller.pluginId, localId: 'heartbeat' }, targetMaterialization: caller,
      sourceInstanceId: enrollRequest.sourceInstanceId, setup: { kind: 'capabilityUrlV1', checkId: enrollRequest.checkId },
    });
    expect(requests[1].body).toEqual({ caller, input: PluginWebhookHeartbeatReadInputV1Schema.parse({
      sourceInstanceId: readRequest.sourceInstanceId, checkId: readRequest.checkId, webhookEndpointId: endpointId,
    }) });
    const installation = await readCurrentMachineInstallation();
    if (!installation) throw new Error('Missing isolated installation');
    for (const request of requests) {
      const { proof } = PluginInstallationManifestPublisherHeaderV1Schema.parse(JSON.parse(Buffer.from(request.proof ?? '', 'base64url').toString('utf8')));
      expect(proof).toMatchObject({ method: 'POST', path: request.path, machineId: caller.machineId,
        installationId: installation.identity.installationId,
        bodySha256Base64Url: createHash('sha256').update(stringifyPluginInstallationManifestCanonicalJsonV1(request.body)).digest('base64url') });
      const { signatureBase64Url, ...signedProof } = proof;
      expect(tweetnacl.sign.detached.verify(createPluginInstallationManifestPublisherSigningInputV1({ proof: signedProof }),
        Buffer.from(signatureBase64Url, 'base64url'), Buffer.from(installation.identity.publicKey, 'base64url'))).toBe(true);
    }
  });

  it('reuses a bounded enrollment key for the exact source/check/caller and distinguishes changed identities', async () => {
    const transport = client();
    for (const request of [enrollRequest, enrollRequest, { ...enrollRequest, checkId: 'different-check' },
      { ...enrollRequest, sourceInstanceId: 'different-source' },
      { ...enrollRequest, caller: { ...caller, materializationId: 'replacement-materialization' } }]) await transport.enroll(request);
    const keys = requests.map(request => PluginWebhookEndpointEnsureInputV1Schema.parse((request.body as { input: unknown }).input).idempotencyKey);
    expect(keys[0]).toBe(keys[1]);
    expect(new Set(keys).size).toBe(4);
  });

  it('fails before HTTP when Account credentials or installation proof are unavailable', async () => {
    credentials = null;
    await expect(client().enroll(enrollRequest)).rejects.toMatchObject({ code: 'endpoint_unavailable' });
    await expect(client().read(readRequest)).rejects.toMatchObject({ code: 'endpoint_unavailable' });
    credentials = { token: 'synthetic-heartbeat-account', encryption: null };
    await writeSettings({ schemaVersion: 6, onboardingCompleted: true });
    await expect(client().enroll(enrollRequest)).rejects.toMatchObject({ code: 'endpoint_unavailable' });
    await expect(client().read(readRequest)).rejects.toMatchObject({ code: 'endpoint_unavailable' });
    expect(requests).toHaveLength(0);
  });

  it('preserves server unavailability and contains malformed/error responses without disclosing the secret URL', async () => {
    const unavailable = { kind: 'unavailable', code: 'endpoint_unavailable' };
    reply = (_request, response) => response.end(JSON.stringify(unavailable));
    await expect(client().read(readRequest)).resolves.toEqual(unavailable);
    await expect(client().enroll(enrollRequest)).rejects.toMatchObject({ code: 'endpoint_unavailable' });
    reply = (_request, response) => response.writeHead(503).end('secret-ping-url');
    await expect(client().read(readRequest)).resolves.toEqual(unavailable);
    const error: unknown = await client().enroll(enrollRequest).catch((failure: unknown) => failure);
    expect(error).toMatchObject({ code: 'endpoint_unavailable' });
    expect(JSON.stringify(error)).not.toMatch(/secret-ping-url|synthetic-heartbeat-account/);
    reply = (_request, response) => response.end(JSON.stringify({ kind: 'ready', lastAcceptedAt: -1 }));
    await expect(client().read(readRequest)).resolves.toEqual(unavailable);
  });

  it('saves only the enrolled identity and observes waiting/current/late receipts through the real adopted source host', async () => {
    const transport = client();
    let lastAcceptedAt: number | null = null;
    let time = 2200;
    reply = (request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(request.url === PLUGIN_WEBHOOK_HEARTBEAT_ENSURE_PATH_V1
        ? { webhookEndpointId: endpointId, revision: 1, publicUrl: `${serverHttpBaseUrl}/secret-ping-url`, readiness: 'ready' }
        : { kind: 'ready', lastAcceptedAt }));
    };
    const draft: HealthCheckSourceConfigV1 = { v: 1,
      subject: { kind: 'machineService', machineId: caller.machineId, serviceId: 'watched-service' },
      checks: [{ checkId: 'heartbeat', kind: { pluginId: caller.pluginId, localId: 'heartbeat' },
        binding: { kind: 'healthCheck' }, config: { graceMs: 200 }, periodMs: 1000, consecutiveFailuresBeforeAlerting: 1 }] };
    let saved = draft;
    const occurrenceSignal = new AbortController();
    const sourceCustody = { kind: 'managed' as const, immutableGenerationId: 'generation', installSource: 'archive' as const };
    const eventRef = { pluginId: caller.pluginId, localId: 'health-status' };
    const binding = { v: 1 as const, automationId: 'automation', triggerId: 'trigger', triggerRevision: 1,
      triggerKind: 'pluginEvent' as const, eventRef, sourceSelectorId: '11111111-1111-4111-8111-111111111111' };
    const owner = createAutomationEventAdoptedDefinitionSetHostV1({
      credentials: { token: 'synthetic-heartbeat-account', encryption: null }, caller, occurrenceId: 'occurrence', sourceCustody,
      transport: { kind: 'checkpointedPull' }, occurrenceSignal: occurrenceSignal.signal,
      isOccurrenceCurrent: () => true, revalidateCallerMaterialization: async () => true, revalidateCallerOccurrence: async () => true,
      resolveAccountEncryptionCurrentness: async () => ({ mode: 'plain', version: 1, signingKeyFingerprint: 'aemk1_signing',
        contentKeyFingerprint: null, updatedAt: 1, recipientEnvelopeReadiness: { status: 'unavailable', reason: 'plain_account' } }),
      resolveAccountEncryptionMaterial: async () => null,
      // This is the remote stored-definition boundary; source decoding, adoption,
      // saved-selector admission and heartbeat classification remain real.
      readStoredDefinitions: async () => {
        const stored: AutomationEventStoredDefinitionProjectionV1 = {
          automationId: binding.automationId, triggerId: binding.triggerId, triggerRevision: binding.triggerRevision,
          eventRef, sourceSelectorId: binding.sourceSelectorId, sourceContractVersion: 1,
          observationTransport: { kind: 'checkpointedPull', watcherMaterializationRef: caller }, payloadSchema: { type: 'object' },
          storedDefinitionEnvelope: sealAutomationTriggerDefinitionStoredEnvelopeV1({ mode: 'plain', binding,
            definition: { v: 1, sourceInstanceId: 'health-source', sourceConfig: saved, displayLabel: 'Heartbeat',
              filter: null, maximumObservationAgeMs: null } }),
        };
        return { kind: 'page', revision: '1', definitions: [stored], nextCursor: null,
          eventDeclarationRelease: { release: { pluginId: caller.pluginId, version: '0.0.0' }, archiveDigestSha256: `sha256:${'a'.repeat(64)}` } };
      },
    });
    const seed: PluginInvocationServicesSeed = { plugin: { id: caller.pluginId, version: '0.0.0' },
      contribution: { id: 'health-observer', qualifiedId: `${caller.pluginId}/backgroundServices/health-observer` },
      occurrenceId: 'occurrence', sourceCustody, correlationId: 'heartbeat-correlation', surface: 'background',
      signal: occurrenceSignal.signal, resolveCurrentPluginMaterializationRef: () => caller, isOccurrenceCurrent: () => true };
    const installation = await readCurrentMachineInstallation();
    if (!installation) throw new Error('Missing isolated installation');
    const host = createSavedHealthChecksHost({ serverId: 'server', resolveAdoptedDefinitionSet: () => owner,
      readObserver: () => ({ machineId: caller.machineId, installationId: installation.identity.installationId }), now: () => time,
      enrollHeartbeat: transport.enroll, readHeartbeatReceipt: transport.read, openDomainArtifact: async () => null });
    // The machine-detail Action crosses the remote Machine boundary. It names
    // the same admitted watched service; no Environment is manufactured.
    const actions = { execute: async () => ({ kind: 'service', service: {
      serviceId: 'watched-service', name: 'Watched service', authority: 'machine', lifecyclePurpose: 'deployment',
      generation: 'generation', state: 'running', watchId: 'watched-service', watchRevision: '1',
      native: { phase: 'running', readiness: 'not_reported' },
      nativeInstance: { adapter: { pluginId: 'happier.machine.services', localId: 'systemd' }, nativeResourceId: 'example.service' },
      capabilities: { start: true, stop: true, restart: true, logs: true, accounting: false },
    } }) } as unknown as ActionsService;
    const service = host.bind(seed, { actions, http: createPluginHttpService({ adapter: createGlobalFetchRuntime() }) });
    if (!service) throw new Error('Saved heartbeat service must bind');
    saved = await service.setup({ sourceInstanceId: 'health-source', sourceConfig: draft, heartbeatContributionId: 'heartbeat' });
    expect(saved.checks[0]?.config).toEqual({ graceMs: 200, webhookEndpointId: endpointId });
    expect(JSON.stringify(saved)).not.toContain('secret-ping-url');
    expect(await owner.refresh()).toEqual({ kind: 'adopted', revision: '1' });
    const read = (signal?: AbortSignal) => service.read({ sourceInstanceId: 'health-source', checkIds: ['heartbeat'] }, signal ? { signal } : undefined);
    await expect(read()).resolves.toMatchObject([{ result: { status: 'unknown' }, nextEligibleAt: null }]);
    lastAcceptedAt = 1000;
    await expect(read()).resolves.toMatchObject([{ result: { status: 'up' }, nextEligibleAt: 2201 }]);
    time = 2201;
    await expect(read()).resolves.toMatchObject([{ result: { status: 'down' } }]);
    let received!: () => void;
    const requestReceived = new Promise<void>(resolve => { received = resolve; });
    reply = () => received();
    const stopped = new AbortController();
    const pending = read(stopped.signal);
    await Promise.race([requestReceived, pending]);
    stopped.abort(new Error('saved heartbeat stopped'));
    await expect(pending).rejects.toBe(stopped.signal.reason);
    expect(requests.map(request => request.path)).toEqual([
      PLUGIN_WEBHOOK_HEARTBEAT_ENSURE_PATH_V1, ...Array(4).fill(PLUGIN_WEBHOOK_HEARTBEAT_READ_PATH_V1),
    ]);
  });

  it('propagates caller cancellation before request and while a read is in flight', async () => {
    const controller = new AbortController();
    controller.abort(new Error('heartbeat observation stopped'));
    await expect(client().enroll(enrollRequest, controller.signal)).rejects.toBe(controller.signal.reason);
    expect(requests).toHaveLength(0);
    const running = new AbortController();
    let received!: () => void;
    const requestReceived = new Promise<void>(resolve => { received = resolve; });
    reply = () => { received(); };
    const pending = client().read(readRequest, running.signal);
    await Promise.race([requestReceived, pending]);
    running.abort(new Error('heartbeat observation reassigned'));
    await expect(pending).rejects.toBe(running.signal.reason);
    expect(requests).toHaveLength(1);
  });
});
