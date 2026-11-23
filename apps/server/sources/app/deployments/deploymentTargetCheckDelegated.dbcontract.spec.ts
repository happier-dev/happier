import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import nacl from 'tweetnacl';
import {
    computeExternalActionRequestEnvelopeDigestV1,
    encodeExternalActionResolvedTargetV1,
    EXTERNAL_ACTION_EFFECT_ACTION_HEADER,
    EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER,
    EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER,
    EXTERNAL_ACTION_RESOLVED_TARGET_HEADER,
    signExternalActionMachineRequestV1,
} from '@happier-dev/protocol/actions';
import { projectExternalActionDeploymentPreparationEnvelopeAdmissionV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { DEPLOYMENT_TARGET_CHECK_ACTION_ID_V1 } from '@happier-dev/protocol/deployments/deploymentActionIdsV1';
import { DeploymentTargetCheckInputV1Schema } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { PROJECT_SOURCE_READ_ACTION_ID_V1 } from '@happier-dev/protocol/actions/specs/projectSourcesActionIdsV1';
import { projectSourceRoutes } from '@/app/api/routes/projects/projectSourceRoutes';
import { registerDeploymentRoutes } from '@/app/api/routes/deployments/deploymentRoutes';
import { withAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { auth } from '@/app/auth/auth';
import { createProjectSourceInTx } from '@/app/projects/sources/projectSourceService';
import { initEncrypt } from '@/modules/encrypt';
import { db, getDbProviderFromEnv, initDbPostgres } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';

describe.skipIf(getDbProviderFromEnv(process.env, 'sqlite') === 'mysql')('delegated Target Check', () => {
    const serverId = `srv_${'d'.repeat(32)}`;
    const postgres = getDbProviderFromEnv(process.env, 'sqlite') === 'postgres';
    let sqlite: LightSqliteHarness | undefined;
    const originalIdentity = process.env.HAPPIER_SERVER_IDENTITY_ID;
    const originalSecret = process.env.HANDY_MASTER_SECRET;

    beforeAll(async () => {
        if (!postgres) {
            sqlite = await createLightSqliteHarness({
                tempDirPrefix: 'happier-target-check-',
                initEncrypt: true,
                initAuth: true,
                env: { HAPPIER_SERVER_IDENTITY_ID: serverId },
            });
            return;
        }
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
            || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error('An explicit isolated PostgreSQL test connection is required');
        }
        process.env.HAPPIER_SERVER_IDENTITY_ID = serverId;
        process.env.HANDY_MASTER_SECRET ??= 'target-check-delegated-test-only';
        await initEncrypt();
        await auth.init();
        initDbPostgres();
        await db.$connect();
    }, 180_000);

    afterAll(async () => {
        if (sqlite) await sqlite.close();
        if (postgres && process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
            && process.env.DATABASE_URL === process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) await db.$disconnect();
        if (originalIdentity === undefined) delete process.env.HAPPIER_SERVER_IDENTITY_ID;
        else process.env.HAPPIER_SERVER_IDENTITY_ID = originalIdentity;
        if (originalSecret === undefined) delete process.env.HANDY_MASTER_SECRET;
        else process.env.HANDY_MASTER_SECRET = originalSecret;
    });

    it.each(['requester', 'foreign custodian'] as const)('limits the Source owner’s Link candidates with a %s signer', async signer => {
        const actor = await db.account.create({ data: { encryptionMode: 'plain' } });
        const team = await db.team.create({ data: { name: 'Another visible team' } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: actor.id, role: 'owner' } });
        const opened = await inTx(tx => createProjectSourceInTx(tx, actor.id, {
            serverId, requestKey: crypto.randomUUID(), name: 'Selected Source', audience: [],
        }));
        if (!opened.ok) throw new Error('Expected a saved Source');
        const custodian = signer === 'requester' ? actor : await db.account.create({ data: { encryptionMode: 'plain' } });
        const signing = nacl.sign.keyPair();
        const installationId = crypto.randomUUID();
        const machine = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: custodian.id,
            metadata: '{}', installationId, installationPublicKey: new Uint8Array(signing.publicKey) } });
        if (signer === 'foreign custodian') {
            await db.machineGrant.create({ data: { principalKind: 'account', machineId: machine.id,
                accountId: actor.id, accessLevel: 'admin', createdByAccountId: custodian.id } });
        }
        const target = { kind: 'machine' as const, machineId: machine.id };
        const contribution = { pluginId: 'fixture.deploy', localId: 'platform' };
        const input = DeploymentTargetCheckInputV1Schema.parse({
            serverId, projectSourceId: opened.source.id, target: contribution, fields: {},
            credentialRef: { service: { pluginId: contribution.pluginId, localId: 'credential' }, accountId: 'provider' },
        });
        const actionId = DEPLOYMENT_TARGET_CHECK_ACTION_ID_V1;
        const envelope = { v: 1 as const, requestId: crypto.randomUUID(), target, input };
        const authorization = await auth.mintExternalActionExecutionAuthorization({
            serverIdentityId: serverId, accountId: actor.id,
            authentication: { kind: 'account', tokenEpoch: actor.tokenEpoch },
            actionId, target, machineId: machine.id, requestId: envelope.requestId,
            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
            deploymentPreparationAdmission: projectExternalActionDeploymentPreparationEnvelopeAdmissionV1({ actionId, envelope }),
        }, { input });
        expect(authorization.binding).toMatchObject({ accountId: actor.id, custodianAccountId: custodian.id });
        const path = '/v1/deployments/targets/list';
        const selection = { source: { kind: 'plugin', contribution }, targetKind: 'platform' };
        await withAuthenticatedTestApp(app => {
            registerDeploymentRoutes(app);
            projectSourceRoutes(app);
        }, async app => {
            const call = (effectActionId: string, method: 'GET' | 'POST', path: string, body?: unknown) =>
                app.inject({ method, url: path, ...(body === undefined ? {} : { payload: JSON.stringify(body) }), headers: {
                    ...(body === undefined ? {} : { 'content-type': 'application/json' }),
                    [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: authorization.token,
                    [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: effectActionId,
                    [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(target),
                    [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({
                        authorizationToken: authorization.token, effectActionId, target, installationId,
                        requestId: envelope.requestId, method, path, body, privateKey: signing.secretKey,
                    }),
                } });
            const list = (scope: unknown, selection?: unknown) => call(actionId, 'POST', path,
                { serverId, scope, ...(selection === undefined ? {} : { selection }) });
            const admitted = await list(opened.source.owner, selection);
            if (signer === 'foreign custodian') {
                expect(admitted.statusCode, admitted.body).toBe(401);
                return;
            }
            expect(admitted.statusCode, admitted.body).toBe(200);
            expect(admitted.json()).toEqual({ ok: true, items: [], nextCursor: null, coverage: 'complete' });
            expect((await list({ kind: 'team', teamId: team.id }, selection)).statusCode).toBe(401);
            const anotherTarget = { ...selection, source: { ...selection.source, contribution: { ...contribution, localId: 'another' } } };
            expect((await list(opened.source.owner, anotherTarget)).statusCode).toBe(401);
            expect((await list(opened.source.owner)).statusCode).toBe(401);
            const sourceRead = await call(PROJECT_SOURCE_READ_ACTION_ID_V1, 'GET',
                `/v1/projects/sources/${encodeURIComponent(opened.source.id)}?serverId=${encodeURIComponent(serverId)}`);
            expect(sourceRead.statusCode, sourceRead.body).toBe(200);
        }, { authentication: 'real' });
    });
});
