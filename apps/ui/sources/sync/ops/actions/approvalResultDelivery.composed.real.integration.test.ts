import { afterAll, beforeAll, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { PENDING_INPUT_PROTOCOL_VERSION_V5 } from '@happier-dev/protocol/clientCompatibility/primitives';
import { ApprovalRequestV2Schema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { buildApprovalRequestArtifactHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { MACHINE_PLAIN_DATA_KEY_MARKER, encodePlainMachineStoredContent } from '@happier-dev/protocol/machines/machineStoredContent';
import { buildSessionCreationCorrespondence } from '@happier-dev/protocol/sessions/creation/sessionCreationCorrespondenceV1';
import { createLightSqliteHarness, type LightSqliteHarness } from '../../../../../server/sources/testkit/lightSqliteHarness';
import { createAuthenticatedTestApp } from '../../../../../server/sources/app/api/testkit/sqliteFastify';
import { sessionPendingRoutes } from '../../../../../server/sources/app/api/routes/session/pendingRoutes';
import { db } from '../../../../../server/sources/storage/db';
import { serveActionHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { createArtifactStoreBoundary } from '@/dev/testkit/harness/artifactStoreBoundary';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createPlainSessionWithDisplayRecordFixture } from '@/dev/testkit/fixtures/sessionDisplayFixtures';
import { storage } from '@/sync/domains/state/storage';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { createDefaultActionExecutor } from './defaultActionExecutor';

const homeIdentity = 'srv_01234567890123456789012345678901';
let database: LightSqliteHarness;
beforeAll(async () => {
    database = await createLightSqliteHarness({ tempDirPrefix: 'happier-approval-delivery-', initAuth: true,
        env: { HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional', HAPPIER_SERVER_IDENTITY_ID: homeIdentity } });
});
afterAll(async () => { if (database) await database.close(); });

it.each(['available', 'update-required', 'unavailable', 'uncommitted'] as const)(
    'publishes a retained approval outcome using the resumed Session target (%s)', async state => {
    const account = await db.account.create({ data: { encryptionMode: 'plain' } });
    const machine = await db.machine.create({ data: { id: randomUUID(), accountId: account.id,
        installationId: randomUUID(), metadata: encodePlainMachineStoredContent({ host: 'resumed-host', platform: 'linux',
            happyCliVersion: 'test', homeDir: '/home/test', happyHomeDir: '/home/test/.happier' }),
        dataEncryptionKey: new Uint8Array(Buffer.from(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64')), operationProtocolCapabilitiesRevision: 1,
        operationProtocolCapabilities: state === 'update-required' ? {} : { sessionInputAdmission: { protocolVersions: [1, 2, 3] } },
        ...(state === 'unavailable' ? { revokedAt: new Date() } : {}) } });
    const session = await db.session.create({ data: { accountId: account.id, tag: randomUUID(), metadata: '{}', encryptionMode: 'plain' } });
    await db.accessKey.create({ data: { accountId: account.id, sessionId: session.id, machineId: machine.id, data: 'test-key' } });
    const target = { homeId: homeIdentity, accountId: account.id, sessionId: session.id,
        machineId: machine.id, installationId: machine.installationId };
    // A Session without a publisher-committed target still needs the sender's
    // Machine to retain the exact admitted tuple on its Pending receipt.
    if (state !== 'uncommitted') {
        await db.session.update({ where: { id: session.id }, data: { runtimeMachineTarget: target } });
    }
    const metadata = { machineId: machine.id, path: '/repo', host: 'resumed-host',
        sessionCreationCorrespondenceV1: buildSessionCreationCorrespondence({
            identity: { callerCreationNamespace: 'approval-delivery', creationKey: randomUUID() },
            recipe: { execution: { machineId: 'retired-birth-machine', directory: { kind: 'path', path: '/repo' } },
                organization: { folderId: null, tagIds: [] },
                agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } } },
        }) };
    const artifacts = createArtifactStoreBoundary({ ownerAccountId: () => account.id, encryptionMode: 'plain' });
    const app = createAuthenticatedTestApp();
    sessionPendingRoutes(app);
    await app.ready();
    // Only HTTP, credentials and Artifact persistence are adapted. Approval
    // replay, Session sender, Pending outbox, admission and SQLite stay real.
    const homes = await serveActionHomes({ homes: [{ key: 'home', serverUrl: `https://${account.id}.approval-delivery.test`,
        serverIdentityId: homeIdentity, accountId: account.id, currentAccount: true }], route: async request => {
        const artifact = artifacts.handle(request.url.pathname + request.url.search, {
            method: request.method, headers: request.headers, ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
        });
        if (artifact) return artifact;
        if (request.url.pathname === '/v1/features' || request.url.pathname === '/v1/features/authenticated') {
            const features = createRootLayoutFeaturesResponse();
            features.capabilities.session.pendingInput = { protocolVersion: PENDING_INPUT_PROTOCOL_VERSION_V5 };
            return Response.json(features);
        }
        if (request.url.pathname === `/v2/sessions/${session.id}`) return Response.json({ session:
            createPlainSessionWithDisplayRecordFixture({ id: session.id, active: true, metadata }) });
        const response = await app.inject({ method: request.method, url: request.url.pathname + request.url.search,
            headers: { 'x-test-user-id': request.accountId ?? '', 'x-happier-account-stored-content-protocol': '4' },
            ...(request.body === undefined ? {} : { payload: request.body }) });
        return new Response(response.body, { status: response.statusCode, headers: { 'Content-Type': 'application/json' } });
    } });
    const home = homes.homes.home!;
    const artifactId = randomUUID();
    const approval = ApprovalRequestV2Schema.parse({ v: 2, status: 'executed', createdAtMs: 1, updatedAtMs: 2,
        createdBy: { surface: 'agent', sessionId: session.id }, requestedSurface: 'agent',
        approval: { flow: 'deferred', result: 'optional' },
        executionOriginV1: { v: 1, authority: 'account_automation', surface: 'agent',
            caller: { kind: 'session', sessionId: session.id, starterDepth: 0, turnDepth: 0 },
            serverId: home.id, serverIdentityId: homeIdentity, accountId: account.id,
            machineId: 'retired-birth-machine', actionId: 'session.status.set_reason', requestId: randomUUID() },
        actionId: 'session.status.set_reason', actionArgs: { reason: 'Completed' }, summary: 'Set status',
        decision: { kind: 'approve', decidedAtMs: 1, authority: 'present_user' },
        execution: { executedAtMs: 2, ok: true, result: { ok: true, sessionId: session.id, reason: 'Completed', version: 2 } },
    });
    try {
        const seeded = await artifacts.handle('/v1/artifacts', { method: 'POST', body: JSON.stringify({ id: artifactId,
            header: encodePlainArtifactStoredContent(buildApprovalRequestArtifactHeaderV1(approval)),
            body: encodePlainArtifactStoredContent({ body: JSON.stringify(approval) }), dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER }) });
        expect(seeded?.ok).toBe(true);
        publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
        storage.getState().applySessions([createSessionFixture({ id: session.id, serverId: home.id, active: true,
            encryptionMode: 'plain', metadata })]);
        const executor = createDefaultActionExecutor({ resolveServerIdForSessionId: () => home.id });
        const replay = () => executor.replayApprovedApprovalRequest({ artifactId, callerAuthority: 'present_user',
            currentAccount: { accountId: account.id, serverId: home.id, serverIdentityId: homeIdentity } });
        if (state === 'update-required' || state === 'unavailable') {
            expect(await replay()).toMatchObject({ ok: false, errorCode: state === 'update-required'
                ? 'session_input_target_update_required' : 'session_input_target_unavailable' });
            expect(await db.sessionPendingMessage.count({ where: { sessionId: session.id } })).toBe(0);
        } else {
            for (let attempt = 0; attempt < 2; attempt++) {
                const result = await replay();
                expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { status: 'executed', execution: { ok: true } } });
            }
            const rows = await db.sessionPendingMessage.findMany({ where: { sessionId: session.id } });
            expect(rows).toHaveLength(1);
            expect(rows[0]).toMatchObject({ localId: `approval-result:${artifactId}`, inputAdmissionReceipt: { admittedTarget: target },
                content: { t: 'plain', v: { content: { type: 'text', text: expect.stringContaining(artifactId) } } } });
        }
        expect(ApprovalRequestV2Schema.parse(JSON.parse(artifacts.readPlainBody(artifactId)!))).toEqual(approval);
    } finally {
        await homes.dispose();
        await app.close();
    }
});
