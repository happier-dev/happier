import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fastify, { type FastifyInstance } from 'fastify';
import tweetnacl from 'tweetnacl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FeaturesResponseSchema } from '@happier-dev/protocol';
import { verifyMachineInstallationProof } from '@happier-dev/protocol/machines/identity/installationIdentity';
import type { SocketRpcMachineAdmissionContextV1 } from '@happier-dev/protocol/machines/machineAccessV1';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { createRequesterSessionCredentialCustody, resolveRequesterSessionBootstrap,
  listRequesterSessionCredentialBindings, type RequesterSessionMachineAdmissionBoundary } from '../sessionEncryption/requesterSessionCredentials';
import { readRequesterPendingSessionActivation } from './pendingSessionActivationRecovery';
import { activatePendingInactiveSession } from './activatePendingInactiveSession';
import type { SpawnSessionOptions } from '@/session/shared/spawnSessionContract';
import { createCurrentMachineExecutionOriginContextResolver } from '@/api/machine/resolveCurrentMachineExecutionOriginContext';

const attribution = { serverId: 'local-bob-home-profile', accountId: 'bob', machineId: 'alice-machine', installationId: 'alice-installation' };
const target = { homeId: 'srv_requester_home', accountId: attribution.accountId, machineId: attribution.machineId,
  installationId: attribution.installationId, sessionId: 'bob-session' };
const origin = 'http://bob-home.test';
let app: FastifyInstance | undefined;
let directory: string | undefined;
let restore: (() => void) | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  restore?.(); restore = undefined;
  await app?.close(); app = undefined;
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

describe('requester pending reconnect through protected custody and the Home network boundary', () => {
  it('recovers an exact retained requester target after a missed hint and refuses grant or target changes without Alice content reads', async () => {
    directory = await mkdtemp(join(tmpdir(), 'requester-pending-reconnect-'));
    const credentials = { token: 'bob-private', encryption: null } as const;
    await createRequesterSessionCredentialCustody({ happyHomeDir: directory, sessionId: target.sessionId, attribution, credentials });
    const discovery = await listRequesterSessionCredentialBindings({ happyHomeDir: directory,
      serverId: attribution.serverId, machineId: attribution.machineId, installationId: attribution.installationId });
    expect(discovery).toEqual({ status: 'ready', bindings: [{ sessionId: target.sessionId, attribution }] });
    app = fastify();
    const keyPair = tweetnacl.sign.keyPair();
    let grant = true;
    let receiptTarget = target;
    let observedHomeId = target.homeId;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      expect(String(input)).toBe(`${origin}/v1/features`);
      return new Response(JSON.stringify(FeaturesResponseSchema.parse({ features: {},
        capabilities: { serverIdentity: { serverIdentityId: observedHomeId } } })), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        });
    });
    const reads: Array<{ path: string; bearer: string | undefined }> = [];
    app.addHook('onRequest', async request => { reads.push({ path: request.url, bearer: request.headers.authorization }); });
    app.get('/v1/account/profile', async () => ({ id: 'bob' }));
    app.get('/v1/account/encryption/currentness', async () => ({ mode: 'plain', version: 1,
      signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 }));
    app.get('/v2/account/settings', async () => ({ content: { t: 'plain', v: {} }, version: 1 }));
    app.get('/v1/machines/alice-machine/access', async (_request, reply) => grant ? {
      machineId: attribution.machineId, custodian: { accountId: 'alice', displayName: 'Alice' },
      access: { custodian: { accountId: 'alice', displayName: 'Alice' }, role: 'use', resourceMode: 'plain', accessState: 'ready' },
      canManage: false, grants: [], ownDirectGrant: true, ownAccessSources: [],
    } : reply.code(403).send({ kind: 'refused', code: 'access_denied' }));
    app.post('/v1/machines/alice-machine/admission/verify', async (request, reply) => {
      const body = request.body as { context: SocketRpcMachineAdmissionContextV1;
        purpose: { kind: 'requester_session_currentness'; sessionId: string };
        proof: Parameters<typeof verifyMachineInstallationProof>[0]['proof'] };
      const valid = body.purpose?.kind === 'requester_session_currentness' && body.purpose.sessionId === target.sessionId
        && verifyMachineInstallationProof({ publicKey: keyPair.publicKey, proof: body.proof,
        payload: { version: 1, accountId: 'alice', machineId: attribution.machineId,
          installationId: attribution.installationId, rpcAdmission: { context: body.context, purpose: body.purpose } } });
      return valid && grant ? { v: 1, ok: true } : reply.code(403).send({ error: 'access_denied' });
    });
    app.get('/v1/access-keys/bob-session/alice-machine', async () => ({ accessKey: { id: 'exact-existing-tuple' } }));
    app.get('/v2/sessions/bob-session/pending', async () => ({ pending: [{ localId: 'input-1', messageRole: 'user',
      status: 'queued', deliveryState: null, requestedAction: { v: 1, kind: 'send_now' } }] }));
    app.get('/v2/sessions/bob-session', async () => ({ session: createSessionRecordFixture({ id: target.sessionId,
      encryptionMode: 'plain', metadata: JSON.stringify({ machineId: attribution.machineId, path: '/workspace',
        flavor: 'codex', codexSessionId: 'native-bob-session', backendTarget: { kind: 'builtInAgent', agentId: 'codex' } }),
      dataEncryptionKey: null, share: null, pendingCount: 1, pendingVersion: 9,
      pendingActivationAuthorization: { status: 'waiting', requestId: 'input-1', requestedAt: 12, admittedTarget: receiptTarget },
    }) }));
    await app.ready();
    restore = installAxiosFastifyAdapter({ app, origin });
    const boundary: RequesterSessionMachineAdmissionBoundary = { machineId: attribution.machineId, daemonToken: 'alice-daemon',
      isHomeCurrent: () => true, readInstallation: () => ({ installationId: attribution.installationId, privateKey: keyPair.secretKey }) };
    const bootstrap = await resolveRequesterSessionBootstrap({ happyHomeDir: directory, sessionId: target.sessionId,
      attribution, serverHttpBaseUrl: origin, machineAdmissionBoundary: boundary });
    expect(bootstrap).not.toBeNull();
    if (!bootstrap) throw new Error('Missing real requester bootstrap');
    const resolveCurrentMachineExecutionOriginContext = createCurrentMachineExecutionOriginContextResolver({ serverUrl: origin,
      resolveCurrentMachineId: () => boundary.machineId });
    const recovery = { sessionId: target.sessionId, bootstrap, resolveCurrentMachineExecutionOriginContext };
    expect(await readRequesterPendingSessionActivation(recovery)).toEqual({
      sessionId: target.sessionId, target, requestId: 'input-1', requestedAt: 12, pendingVersion: 9, source: 'scan',
    });
    const spawned: SpawnSessionOptions[] = [];
    // The process launch is the boundary; private reads, metadata decoding and target admission stay real.
    const activation = { credentials, requester: bootstrap, expectedTarget: target, machineId: attribution.machineId,
      resolveCurrentMachineExecutionOriginContext,
      sessionId: target.sessionId, requestId: 'input-1', pendingVersion: 9,
      spawnSession: async (options: SpawnSessionOptions) => { spawned.push(options); return { type: 'success' as const, sessionId: target.sessionId }; } };
    expect(await activatePendingInactiveSession(activation)).toEqual({ status: 'activated' });
    expect(spawned).toHaveLength(1);
    expect(spawned[0]).toMatchObject({ existingSessionId: target.sessionId, machineId: attribution.machineId,
      requesterWorkAttributionV1: attribution, executionAuthorization: { requestId: 'input-1', requestedAt: 12 } });
    observedHomeId = 'srv_replacement_home';
    expect(await readRequesterPendingSessionActivation(recovery)).toBeNull();
    expect(await activatePendingInactiveSession(activation)).toEqual({ status: 'not-needed', reason: 'authorization-stale' });
    observedHomeId = target.homeId;
    receiptTarget = { ...target, installationId: 'replacement' };
    expect(await readRequesterPendingSessionActivation(recovery)).toBeNull();
    expect(await activatePendingInactiveSession(activation)).toEqual({ status: 'not-needed', reason: 'authorization-stale' });
    receiptTarget = target;
    grant = false;
    expect(await readRequesterPendingSessionActivation(recovery)).toBeNull();
    expect(await activatePendingInactiveSession(activation)).toEqual({ status: 'not-needed', reason: 'authorization-stale' });
    expect(spawned).toHaveLength(1);
    expect(reads.filter(read => !read.path.endsWith('/admission/verify')).every(read => read.bearer === 'Bearer bob-private')).toBe(true);
    expect(reads.filter(read => read.path.endsWith('/admission/verify')).every(read => read.bearer === 'Bearer alice-daemon')).toBe(true);
  });
});
