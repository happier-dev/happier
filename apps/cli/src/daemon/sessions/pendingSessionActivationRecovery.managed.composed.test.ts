import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import tweetnacl from 'tweetnacl';
import { MACHINE_PLAIN_DATA_KEY_MARKER, decodeBase64, encodePlainMachineStoredContent } from '@happier-dev/protocol';
import { createLightSqliteHarness, type LightSqliteHarness } from '../../../../server/sources/testkit/lightSqliteHarness';
import { db } from '../../../../server/sources/storage/db';
import { inTx } from '../../../../server/sources/storage/inTx';
import { auth } from '../../../../server/sources/app/auth/auth';
import { setEligibleMachineAccessGrantInTx } from '../../../../server/sources/testkit/machineAccessGrant.testkit';
import { resolveMachineAccess } from '../../../../server/sources/app/machines/machineAccess';
import { createSessionMachineAccessKeyInTx } from '../../../../server/sources/app/accessKeys/sessionMachineAccessKeyMutations';
import { enqueuePendingMessage, updatePendingRequestedAction } from '../../../../server/sources/app/session/pending/pendingMessageService';
import { createPresentUserSessionAccessAuthentication } from '../../../../server/sources/app/session/access/sessionAccessAuthentication.testkit';
import { readManagedWakeTargets } from '../../../../server/sources/app/machines/managed/managedWake';
import { getOrCreateServerIdentityId } from '../../../../server/sources/app/serverIdentity/serverIdentity';
import { createAuthenticatedTestApp } from '../../../../server/sources/app/api/testkit/sqliteFastify';
import { registerSessionListingRoutes } from '../../../../server/sources/app/api/routes/session/registerSessionListingRoutes';
import { registerSessionReadBatchRoute } from '../../../../server/sources/app/api/routes/session/registerSessionReadBatchRoute';
import { sessionPendingRoutes } from '../../../../server/sources/app/api/routes/session/pendingRoutes';
import { registerAccountEncryptionRoutes } from '../../../../server/sources/app/api/routes/account/registerAccountEncryptionRoutes';
import { registerAccountProfileRoute } from '../../../../server/sources/app/api/routes/account/registerAccountProfileRoute';
import { registerAccountSettingsRoutes } from '../../../../server/sources/app/api/routes/account/registerAccountSettingsRoutes';
import { machinesRoutes } from '../../../../server/sources/app/api/routes/machines/machinesRoutes';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';
import { createCurrentMachineExecutionOriginContextResolver } from '@/api/machine/resolveCurrentMachineExecutionOriginContext';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createRequesterSessionCredentialCustody, createRequesterSessionRuntimeContextResolver,
  resolveRequesterSessionBootstrapFromCustody } from '../sessionEncryption/requesterSessionCredentials';
import { activateRequesterPendingSession, createPendingSessionActivationRecovery } from './pendingSessionActivationRecovery';
import { activatePendingInactiveSession } from './activatePendingInactiveSession';

describe('managed Pending rearm through Home and daemon reconnect', () => {
  let database: LightSqliteHarness;
  beforeAll(async () => {
    database = await createLightSqliteHarness({ tempDirPrefix: 'happier-managed-pending-recovery-', initAuth: true,
      env: { HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional' } });
  }, 120_000);
  afterAll(async () => { if (database) await database.close(); });

  it('settles a cold guest activation refusal in the original requester Pending custody', async () => {
    const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
    const custodian = await db.account.create({ data: { encryptionMode: 'plain' } });
    const homeId = await getOrCreateServerIdentityId();
    const keyPair = tweetnacl.sign.keyPair();
    const installationId = randomUUID();
    const guest = await db.machine.create({ data: {
      id: randomUUID(), accountId: custodian.id, installationId, active: true,
      installationPublicKey: new Uint8Array(keyPair.publicKey),
      metadata: encodePlainMachineStoredContent({ host: 'restarted-guest', platform: 'linux', happyCliVersion: 'test',
        homeDir: '/home/guest', happyHomeDir: '/home/guest/.happier' }),
      dataEncryptionKey: new Uint8Array(decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64')),
      operationProtocolCapabilitiesRevision: 1,
      operationProtocolCapabilities: { sessionInputAdmission: { protocolVersions: [1, 2] },
        requesterExecutionIsolation: { protocolVersions: [1] } },
    } });
    expect(await inTx(tx => setEligibleMachineAccessGrantInTx(tx, { actorAccountId: custodian.id,
      machineId: guest.id, principal: { kind: 'account', accountId: owner.id }, level: 'view',
    }))).toMatchObject({ kind: 'saved', readiness: 'ready' });
    expect(await resolveMachineAccess({ actorAccountId: owner.id, machineId: guest.id }))
      .toMatchObject({ role: 'use', accessState: 'ready' });
    const session = await db.session.create({ data: { accountId: owner.id, tag: randomUUID(),
      encryptionMode: 'plain', active: false,
      metadata: JSON.stringify({ machineId: guest.id, path: '/workspace', flavor: 'codex', codexSessionId: 'retained-native-session',
        runtimeDescriptorV1: { v: 1, agentId: 'codex', agent: {} } }),
    } });
    expect(await inTx(tx => createSessionMachineAccessKeyInTx(tx, { accountId: owner.id,
      sessionId: session.id, machineId: guest.id, data: MACHINE_PLAIN_DATA_KEY_MARKER }))).toMatchObject({ ok: true });
    const credentials = { token: await auth.createToken(owner.id, undefined, { kind: 'account', authority: 'present_user' }), encryption: null };
    const daemonToken = await auth.createToken(custodian.id, undefined, { kind: 'account', authority: 'present_user' });
    const serverHttpBaseUrl = resolveServerHttpBaseUrl();
    const serverId = 'cold-requester-home';
    const attribution = { serverId, accountId: owner.id, machineId: guest.id, installationId };
    const directory = await mkdtemp(join(tmpdir(), 'cold-managed-pending-'));
    const app = createAuthenticatedTestApp({ authentication: 'real' });
    const homeRequests: { path: string; status: number }[] = [];
    let malformedSessionRead = false;
    let malformedResponses = 0;
    app.addHook('onSend', async (request, _reply, payload) => {
      if (malformedSessionRead && request.url.split('?')[0] === `/v2/sessions/${session.id}`
        && request.headers.authorization === `Bearer ${credentials.token}`) {
        malformedResponses += 1;
        return JSON.stringify({ invalidSessionProjection: true });
      }
      return payload;
    });
    app.addHook('onResponse', async (request, reply) => { homeRequests.push({ path: request.url, status: reply.statusCode }); });
    registerSessionListingRoutes(app); registerSessionReadBatchRoute(app); sessionPendingRoutes(app);
    registerAccountEncryptionRoutes(app); registerAccountProfileRoute(app); registerAccountSettingsRoutes(app); machinesRoutes(app);
    await app.ready();
    const restore = installAxiosFastifyAdapter({ app, origin: new URL(serverHttpBaseUrl).origin });
    const channel = await createRequesterCurrentnessSocketHarness();
    const boundary = { machineId: guest.id, daemonToken, isHomeCurrent: () => true,
      readInstallation: () => ({ installationId, privateKey: keyPair.secretKey }), getObservedServerIdentityId: () => homeId };
    try {
      await createRequesterSessionCredentialCustody({ happyHomeDir: directory, sessionId: session.id, attribution,
        credentials, homeServerIdentityId: homeId, machineAdmission: { custodianAccountId: custodian.id, role: 'use' } });

      // Stop/Start retains installation and requester custody; the stopped
      // runner is represented by the empty tracked-Session map below.
      await db.machine.update({ where: { id: guest.id }, data: { active: false } });
      await db.machine.update({ where: { id: guest.id }, data: { active: true } });
      const localId = randomUUID();
      expect(await enqueuePendingMessage({ actorUserId: owner.id, authentication: createPresentUserSessionAccessAuthentication(),
        sessionId: session.id, localId, targetMachineId: guest.id, requestedAction: { v: 1, kind: 'send_now' },
        content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'Reply only Woke.' } } },
      })).toMatchObject({ ok: true });
      const accepted = await db.session.findUniqueOrThrow({ where: { id: session.id } });
      expect(accepted.pendingActivationStatus).toBe('waiting');
      // The unchanged Use grant and installation can recover the original private
      // birth. A later definite Home refusal must not become an endless Queued row.
      const bootstrap = await resolveRequesterSessionBootstrapFromCustody({ happyHomeDir: directory, serverId,
        sessionId: session.id, serverHttpBaseUrl, expectedAttribution: attribution, machineAdmissionBoundary: boundary });
      expect(bootstrap, JSON.stringify(homeRequests)).not.toBeNull();
      await bootstrap?.dispose();
      const resolveRuntime = createRequesterSessionRuntimeContextResolver({ trackedSessions: new Map(),
        getCreateRuntime: () => async () => { throw new Error('Refused Home admission must not construct a runtime'); },
        recoverBootstrap: input => resolveRequesterSessionBootstrapFromCustody({ happyHomeDir: directory, serverId,
          sessionId: input.sessionId, expectedAttribution: input.attribution, serverHttpBaseUrl,
          machineAdmissionBoundary: boundary, signal: input.signal, onRecoveryRefused: input.onRecoveryRefused }),
      });
      const activate = () => activateRequesterPendingSession({ machineId: guest.id, binding: { sessionId: session.id, attribution },
        hint: { sessionId: session.id, requestId: localId, requestedAt: accepted.pendingActivationRequestedAt!.getTime(),
          pendingVersion: accepted.pendingVersion, source: 'live' },
        resolveRequesterSessionRuntimeContext: resolveRuntime, releaseRequesterSessionRuntimeContext: context => context.dispose(),
        resolveCurrentMachineExecutionOriginContext: createCurrentMachineExecutionOriginContextResolver({ serverUrl: serverHttpBaseUrl,
          resolveCurrentMachineId: () => guest.id, resolveCurrentServerIdentityId: () => homeId }),
        spawnSessionForInternalResume: async () => { throw new Error('Refused Home admission must not launch a runner'); },
      });
      // A malformed network projection is unavailable evidence, not a Home
      // authorization refusal; accepted custody remains available for recovery.
      malformedSessionRead = true;
      await activate();
      expect(malformedResponses).toBeGreaterThan(0);
      expect(await db.sessionPendingMessage.findMany({ where: { sessionId: session.id } }))
        .toMatchObject([{ localId, status: 'queued', deliveryState: null, deliveryBlockedReason: null }]);
      expect(await db.session.findUniqueOrThrow({ where: { id: session.id } }))
        .toMatchObject({ pendingActivationStatus: 'waiting' });
      malformedSessionRead = false;
      await db.accessKey.delete({ where: { accountId_machineId_sessionId: {
        accountId: owner.id, machineId: guest.id, sessionId: session.id,
      } } });
      await activate();
      expect(await db.sessionPendingMessage.findMany({ where: { sessionId: session.id } }))
        .toMatchObject([{ localId, status: 'queued', deliveryState: 'blocked', deliveryBlockedReason: 'session_input_target_unavailable' }]);
      expect(await db.session.findUniqueOrThrow({ where: { id: session.id } }))
        .toMatchObject({ pendingActivationStatus: 'failed' });
    } finally {
      await channel.close(); restore(); await app.close(); await rm(directory, { recursive: true, force: true });
    }
  });

  it('keeps an accepted guest wake available when another owner daemon scans a Session without resume metadata', async () => {
    const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
    const custodian = await db.account.create({ data: { encryptionMode: 'plain' } });
    const homeId = await getOrCreateServerIdentityId();
    const machine = (accountId: string, active: boolean) => db.machine.create({ data: {
      id: randomUUID(), accountId, installationId: randomUUID(), active,
      metadata: encodePlainMachineStoredContent({ host: 'wake-fixture', platform: 'linux', happyCliVersion: 'test',
        homeDir: '/home/wake', happyHomeDir: '/home/wake/.happier' }),
      installationPublicKey: tweetnacl.sign.keyPair().publicKey,
      dataEncryptionKey: new Uint8Array(decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64')),
      operationProtocolCapabilitiesRevision: 1,
      operationProtocolCapabilities: { sessionInputAdmission: { protocolVersions: [1, 2] } },
    } });
    const controller = await machine(custodian.id, true);
    const guest = await machine(custodian.id, false);
    const other = await machine(owner.id, true);
    for (const target of [controller, guest]) expect(await inTx(tx => setEligibleMachineAccessGrantInTx(tx, {
      actorAccountId: custodian.id, machineId: target.id, principal: { kind: 'account', accountId: owner.id }, level: 'admin',
    }))).toMatchObject({ kind: 'saved', readiness: 'ready' });
    const managed = await db.managedMachine.create({ data: {
      homeId, custodianAccountId: custodian.id, controllerMachineId: controller.id,
      controllerInstallationId: controller.installationId!, enrolledMachineId: guest.id,
      admittedActionRequestId: randomUUID(), admittedInput: {}, allocation: 'bound', creationState: 'active',
      launch: { provider: { pluginId: 'fixture.compute', localId: 'vm' }, schemaVersion: 1, name: 'Guest', choices: {} },
      resource: { contributionRef: { pluginId: 'fixture.compute', localId: 'vm' }, schemaVersion: 1, value: {} },
      desired: 'stop', retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: true,
      observation: { observedAt: 1, availability: 'present', power: 'stopped', storage: 'retained' },
    } });
    const session = await db.session.create({ data: { accountId: owner.id, tag: randomUUID(), metadata: '{}',
      encryptionMode: 'plain', active: false } });
    expect(await inTx(tx => createSessionMachineAccessKeyInTx(tx, { accountId: owner.id,
      sessionId: session.id, machineId: guest.id, data: 'fixture-encrypted-key' }))).toMatchObject({ ok: true });
    const input = { actorUserId: owner.id, authentication: createPresentUserSessionAccessAuthentication(),
      sessionId: session.id, localId: randomUUID(), targetMachineId: guest.id,
      requestedAction: { v: 1, kind: 'enqueue' },
      content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'retained original input' } } } } as const;
    expect(await enqueuePendingMessage(input)).toMatchObject({ ok: true });
    expect(await updatePendingRequestedAction({ ...input, resumeWhenAvailable: true })).toMatchObject({ ok: true });
    const census = () => readManagedWakeTargets({ actorAccountId: custodian.id,
      request: { homeId, controller: { machineId: controller.id, installationId: controller.installationId! } } });
    expect((await census()).targets).toMatchObject([{ managedId: managed.id }]);
    const before = await db.session.findUniqueOrThrow({ where: { id: session.id } });
    const credentials = { token: await auth.createToken(owner.id, undefined, { kind: 'account', authority: 'present_user' }), encryption: null };
    const app = createAuthenticatedTestApp({ authentication: 'real' });
    registerSessionListingRoutes(app); registerSessionReadBatchRoute(app); sessionPendingRoutes(app); registerAccountEncryptionRoutes(app);
    await app.ready();
    const restore = installAxiosFastifyAdapter({ app, origin: new URL(resolveServerHttpBaseUrl()).origin });
    const results: Awaited<ReturnType<typeof activatePendingInactiveSession>>[] = [];
    try {
      for (const machineId of [other.id, controller.id]) {
        const recovery = createPendingSessionActivationRecovery({ token: credentials.token,
          activate: async hint => { results.push(await activatePendingInactiveSession({ credentials,
            machineId, sessionId: hint.sessionId, requestId: hint.requestId, pendingVersion: hint.pendingVersion,
            spawnSessionForInternalResume: async () => { throw new Error('Foreign daemon must not spawn the guest'); } })); },
          warn: (_message, _hint, error) => { throw error; },
        });
        await recovery.recoverAfterConnect();
      }
      expect(results).toEqual([
        { status: 'not-needed', reason: 'target-mismatch' }, { status: 'not-needed', reason: 'target-mismatch' },
      ]);
      const after = await db.session.findUniqueOrThrow({ where: { id: session.id } });
      expect(after.pendingActivationStatus).toBe('waiting');
      expect(after.pendingActivationRequestedAt).toEqual(before.pendingActivationRequestedAt);
      expect((await census()).targets).toMatchObject([{ managedId: managed.id,
        origin: { pendingRequestId: input.localId, requestedAt: before.pendingActivationRequestedAt!.getTime() } }]);
      expect(await db.sessionPendingMessage.findMany({ where: { sessionId: session.id } }))
        .toMatchObject([{ localId: input.localId, status: 'queued' }]);
      // Even an exact-guest runtime report cannot settle compute's pending
      // wake. Once compute runs, its genuine metadata refusal can settle it.
      expect(await activatePendingInactiveSession({ credentials, machineId: guest.id,
        sessionId: session.id, requestId: input.localId, pendingVersion: before.pendingVersion,
        spawnSessionForInternalResume: async () => { throw new Error('Missing resume metadata must not spawn'); } }))
        .toMatchObject({ status: 'not-needed', reason: 'authorization-stale' });
      expect((await census()).targets).toMatchObject([{ managedId: managed.id }]);
      await db.managedMachine.update({ where: { id: managed.id }, data: {
        observation: { observedAt: 2, availability: 'present', power: 'running', storage: 'retained' },
      } });
      expect(await activatePendingInactiveSession({ credentials, machineId: guest.id,
        sessionId: session.id, requestId: input.localId, pendingVersion: before.pendingVersion,
        spawnSessionForInternalResume: async () => { throw new Error('Missing resume metadata must not spawn'); } }))
        .toMatchObject({ status: 'rejected', reason: 'identity-unavailable' });
      expect(await db.session.findUniqueOrThrow({ where: { id: session.id } }))
        .toMatchObject({ pendingActivationStatus: 'failed' });
      expect(await db.sessionPendingMessage.findMany({ where: { sessionId: session.id } }))
        .toMatchObject([{ localId: input.localId, status: 'queued', deliveryState: 'blocked',
          deliveryBlockedReason: 'session_input_target_unavailable' }]);
      expect((await census()).targets).toEqual([]);
    } finally { restore(); await app.close(); }
  });
});
