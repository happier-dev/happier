import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import nacl from 'tweetnacl';
import * as privacyKit from 'privacy-kit';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent,
    computeDeploymentTransitionRequestDigestV1, readDeploymentAccountChangeV1, type DeploymentTransitionInputV1,
    type DeploymentDeployAdmissionInputV1, type DeploymentRollbackAdmissionInputV1, type DeploymentPromoteAdmissionInputV1, type DeploymentTeardownAdmissionInputV1, type DeploymentEnvironmentCreateStorageInputV1 } from '@happier-dev/protocol';
import { createDeploymentEnvironmentV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { MACHINE_PLAIN_DATA_KEY_MARKER, encodePlainMachineStoredContent } from '@happier-dev/protocol/machines/machineStoredContent';
import { signMachineInstallationProof } from '@happier-dev/protocol/machines/identity/installationIdentity';
import { db, getDbProviderFromEnv, initDbMysql, initDbPostgres } from '@/storage/db';
import { inTx, type Tx } from '@/storage/inTx';
import { withAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import type { Fastify } from '@/app/api/types';
import { registerDeploymentRoutes } from '@/app/api/routes/deployments/deploymentRoutes';
import { registerSavedSecretResourceRoutes } from '@/app/api/routes/account/registerSavedSecretResourceRoutes';
import { observeLazyPrismaQuery, withAccountPublicationBeforeTransactionSql } from '@/app/changes/accountPublicationContention.testkit';
import { createSavedSecretResourceInTx } from '@/app/account/savedSecrets/savedSecretResourceService';
import { formatSharedSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { initEncrypt } from '@/modules/encrypt';
import { createArtifact } from '@/app/artifacts/artifactWriteService';
import { readArtifactForCaller } from '@/app/artifacts/artifactAccessService';
import { createProjectSourceInTx } from '@/app/projects/sources/projectSourceService';
import { makeShareEligibleForTest } from '@/testkit/shareEligibility.testkit';
import { transitionDeploymentInTx } from './deploymentService';

const provider = getDbProviderFromEnv(process.env, 'postgres');
describe.skipIf(provider !== 'postgres' && provider !== 'mysql')('deployment transition publication on native providers', () => {
    const serverId = `srv_${'d'.repeat(32)}`;
    const previousIdentity = process.env.HAPPIER_SERVER_IDENTITY_ID;
    const previousSecret = process.env.HANDY_MASTER_SECRET;
    const previousRetries = process.env.HAPPIER_DB_TX_MAX_RETRIES;
    let connected = false;
    beforeAll(async () => {
        const target = provider === 'mysql' ? process.env.HAPPIER_TEST_MYSQL_DATABASE_URL : process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL;
        if (!process.env.HAPPIER_DB_CONTRACT_CONTAINER_ID || !target || process.env.DATABASE_URL !== target) {
            throw new Error('Run with the disposable native DB-contract harness');
        }
        process.env.HAPPIER_SERVER_IDENTITY_ID = serverId;
        process.env.HANDY_MASTER_SECRET ??= 'deployment-transition-native-test-only';
        process.env.HAPPIER_DB_TX_MAX_RETRIES = '0';
        await initEncrypt();
        if (provider === 'mysql') await initDbMysql(); else initDbPostgres();
        await db.$connect();
        connected = true;
    });
    afterAll(async () => {
        if (connected) await db.$disconnect();
        for (const [key, value] of Object.entries({ HAPPIER_SERVER_IDENTITY_ID: previousIdentity,
            HANDY_MASTER_SECRET: previousSecret, HAPPIER_DB_TX_MAX_RETRIES: previousRetries })) {
            if (value === undefined) delete process.env[key]; else process.env[key] = value;
        }
    });

    it.each(['teardown', 'deploy', 'rollback', 'promote'] as const)('admits %s once despite unrelated Account publication and retains Environment exclusion', async operation => {
        if (provider !== 'postgres') return;
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const source = await inTx(tx => createProjectSourceInTx(tx, owner.id, { serverId, requestKey: randomUUID(),
            name: 'Teardown publication', audience: [] }));
        if (!source.ok) throw new Error(source.error);
        const keys = nacl.sign.keyPair();
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: owner.id, metadata: '{}',
            installationId: randomUUID(), installationPublicKey: new Uint8Array(keys.publicKey) } });
        const artifact = await createArtifact({ actorUserId: owner.id, artifactId: randomUUID(),
            header: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ kind: 'deployment-receipt.v1', title: 'Teardown receipt' })),
            body: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ body: JSON.stringify({ steps: [] }) })),
            dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) });
        if (!artifact.ok) throw new Error(artifact.error);
        const content = { contentArtifactId: artifact.artifact.id, contentHeaderVersion: 1, contentBodyVersion: 1 };
        const definition = createDeploymentEnvironmentV1().content;
        if (definition.t !== 'plain') throw new Error('Expected plain Environment fixture');
        const destinationArtifact = operation === 'promote' ? await createArtifact({ actorUserId: owner.id, artifactId: randomUUID(),
            header: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ kind: 'deployment-environment.v1', title: 'Promoted definition' })),
            body: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ body: JSON.stringify(definition.v) })),
            dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) }) : undefined;
        if (destinationArtifact && !destinationArtifact.ok) throw new Error(destinationArtifact.error);
        const destinationContent = destinationArtifact?.ok ? { ...content, contentArtifactId: destinationArtifact.artifact.id } : content;
        const environment = await db.deploymentEnvironment.create({ data: { projectSourceId: source.source.id,
            createdByAccountId: owner.id, protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers',
            controllerMachineId: machine.id, buildMachineId: machine.id, ...destinationContent } });
        const link = await db.deploymentTargetLink.create({ data: { environmentId: environment.id,
            role: 'runtime', sourceKind: 'host', hostTargetId: 'own-server', targetKind: 'ownServer', state: 'configured',
            createdByAccountId: owner.id, ...content,
            machines: { create: [{ machineId: machine.id, installationId: machine.installationId!, position: 0, state: 'active' }] } } });
        await db.deploymentEnvironment.update({ where: { id: environment.id }, data: { runtimeTargetLinkId: link.id } });
        const rollbackSource = operation === 'rollback' ? await db.deployment.create({ data: {
            environmentId: environment.id, targetLinkId: link.id, operation: 'deploy', state: 'succeeded',
            requestKey: randomUUID(), actionOperationId: randomUUID(), requestedByAccountId: owner.id, ...content,
        } }) : undefined;
        const promotionSource = operation === 'promote' ? await db.deploymentEnvironment.create({ data: {
            projectSourceId: source.source.id, createdByAccountId: owner.id, protection: 'nonProduction', purpose: 'standard',
            deployerMode: 'managers', controllerMachineId: machine.id, buildMachineId: machine.id, ...destinationContent,
        } }) : undefined;
        const promotionLink = promotionSource ? await db.deploymentTargetLink.create({ data: {
            environmentId: promotionSource.id, role: 'runtime', sourceKind: 'host', hostTargetId: 'own-server',
            targetKind: 'ownServer', state: 'configured', createdByAccountId: owner.id, ...content,
        } }) : undefined;
        const promotedReceipt = promotionLink ? await db.deployment.create({ data: {
            environmentId: promotionLink.environmentId, targetLinkId: promotionLink.id, operation: 'deploy', state: 'succeeded',
            requestKey: randomUUID(), actionOperationId: randomUUID(), requestedByAccountId: owner.id, ...content,
        } }) : undefined;
        const retainedReceipts = rollbackSource ? 1 : 0;
        // Promotion retains the unchanged definition; only receipt admission advances it.
        const admittedRevision = 2;
        const input = { serverId, environmentId: environment.id, targetLinkId: link.id, expectedRevision: 1,
            expectedTargetLinkRevision: 1, requestKey: randomUUID(), actionOperationId: randomUUID(),
            ...(operation === 'teardown' ? { reason: 'manual' as const } : {}),
            ...(rollbackSource ? { deploymentId: rollbackSource.id } : {}),
            ...(promotionSource && promotedReceipt ? { sourceEnvironmentId: promotionSource.id,
                sourceDeploymentId: promotedReceipt.id, artifact: 'image' as const, destinationContent } : {}),
            ...content } satisfies DeploymentDeployAdmissionInputV1 | DeploymentRollbackAdmissionInputV1 | DeploymentPromoteAdmissionInputV1 | DeploymentTeardownAdmissionInputV1;
        await withAuthenticatedTestApp(registerDeploymentRoutes, async (app: Fastify) => {
            const request = (payload = input) => app.inject({ method: 'POST',
                url: `/v1/deployments/environments/${environment.id}/${operation}`,
                headers: { 'x-test-user-id': owner.id }, payload });
            const atPublication = (sql: string) => sql.includes('FROM "Account"') && sql.includes('FOR NO KEY UPDATE');
            const { result: response, advances } = await withAccountPublicationBeforeTransactionSql(owner.id, atPublication, request);
            expect(response.statusCode, response.body).toBe(200);
            expect(response.json()).toMatchObject({ ok: true, state: 'queued', revision: admittedRevision });
            expect(advances).toBe(1);
            const sequence = (await db.account.findUniqueOrThrow({ where: { id: owner.id } })).seq;
            expect((await request()).json()).toEqual(response.json());
            expect((await db.account.findUniqueOrThrow({ where: { id: owner.id } })).seq).toBe(sequence);
            const competing = await request({ ...input, requestKey: randomUUID(), actionOperationId: randomUUID() });
            expect(competing.statusCode, competing.body).toBe(409);
            expect(competing.json()).toMatchObject({ ok: false, error: 'deployment_in_progress' });
            expect(await db.deployment.count({ where: { environmentId: environment.id } })).toBe(retainedReceipts + 1);
            expect((await db.deploymentEnvironment.findUniqueOrThrow({ where: { id: environment.id } })).revision).toBe(admittedRevision);
            await db.deployment.update({ where: { id: response.json().deploymentId }, data: { state: 'failed' } });
            const next = () => request({ ...input, expectedRevision: admittedRevision, requestKey: randomUUID(), actionOperationId: randomUUID() });
            const concurrent = await Promise.all([next(), next()]);
            expect(concurrent.map(answer => answer.statusCode).sort()).toEqual([200, 409]);
            expect(concurrent.find(answer => answer.statusCode === 409)!.json()).toMatchObject({ error: 'deployment_in_progress' });
            expect(await db.deployment.count({ where: { environmentId: environment.id } })).toBe(retainedReceipts + 2);
            expect((await db.deploymentEnvironment.findUniqueOrThrow({ where: { id: environment.id } })).revision).toBe(admittedRevision + 1);
        });
    });

    it.each([false, true])('creates one Environment despite Account publication and concurrent replay (new Project: %s)', async newProject => {
        if (provider !== 'postgres') return;
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const source = await inTx(tx => createProjectSourceInTx(tx, owner.id, { serverId, requestKey: randomUUID(),
            name: 'Existing install Project', audience: [] }));
        if (!source.ok) throw new Error(source.error);
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: owner.id, metadata: encodePlainMachineStoredContent({}),
            dataEncryptionKey: privacyKit.decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER), installationId: randomUUID() } });
        const definition = createDeploymentEnvironmentV1().content;
        if (definition.t !== 'plain') throw new Error('Expected plain Environment fixture');
        const artifact = await createArtifact({ actorUserId: owner.id, artifactId: randomUUID(),
            header: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ kind: 'deployment-environment.v1', title: 'Install' })),
            body: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ body: JSON.stringify(definition.v) })),
            dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) });
        if (!artifact.ok) throw new Error(artifact.error);
        const input = { serverId, requestKey: randomUUID(), protection: 'nonProduction', purpose: 'standard',
            deployerMode: 'managers', controllerMachineId: machine.id, contentArtifactId: artifact.artifact.id,
            contentHeaderVersion: 1, contentBodyVersion: 1,
            ...(newProject ? { newProject: { requestKey: randomUUID(), name: 'New install Project', owner: { kind: 'account' as const, accountId: owner.id } } }
                : { projectSourceId: source.source.id }) } satisfies DeploymentEnvironmentCreateStorageInputV1;
        await withAuthenticatedTestApp(registerDeploymentRoutes, async (app: Fastify) => {
            const request = (payload: DeploymentEnvironmentCreateStorageInputV1 = input) => app.inject({ method: 'POST', url: '/v1/deployments/environments',
                headers: { 'x-test-user-id': owner.id }, payload });
            const atPublication = (sql: string) => sql.includes('FROM "Account"') && sql.includes('FOR NO KEY UPDATE');
            const { result: response, advances } = await withAccountPublicationBeforeTransactionSql(owner.id, atPublication, request);
            expect(response.statusCode, response.body).toBe(200);
            expect(advances).toBe(1);
            const sequence = (await db.account.findUniqueOrThrow({ where: { id: owner.id } })).seq;
            expect((await request()).json()).toEqual(response.json());
            expect((await db.account.findUniqueOrThrow({ where: { id: owner.id } })).seq).toBe(sequence);
            const next = { ...input, requestKey: randomUUID(),
                ...(newProject ? { newProject: { requestKey: randomUUID(), name: 'Concurrent install Project', owner: { kind: 'account' as const, accountId: owner.id } } } : {}) };
            const concurrent = await Promise.all([request(next), request(next)]);
            expect(concurrent.map(answer => answer.statusCode), concurrent.map(answer => answer.body).join('\n')).toEqual([200, 200]);
            expect(concurrent[0].json()).toEqual(concurrent[1].json());
            expect(await db.deploymentEnvironment.count({ where: { createdByAccountId: owner.id } })).toBe(2);
            expect(await db.projectSource.count({ where: { createdByAccountId: owner.id } })).toBe(newProject ? 3 : 1);
            expect((await request({ ...next, protection: 'production' })).json()).toMatchObject({ ok: false, error: 'deployment_conflict' });
            if (newProject) {
                const sharedProject = { requestKey: randomUUID(), name: 'One Project for two Environments', owner: { kind: 'account' as const, accountId: owner.id } };
                const siblings = await Promise.all([0, 1].map(() => request({ ...input, requestKey: randomUUID(), newProject: sharedProject })));
                expect(siblings.map(answer => answer.statusCode), siblings.map(answer => answer.body).join('\n')).toEqual([200, 200]);
                expect(siblings[0].json().projectSourceId).toBe(siblings[1].json().projectSourceId);
                expect(await db.projectSource.count({ where: { createdByAccountId: owner.id } })).toBe(4);
            }
        });
    });

    it('saves Store bindings despite unrelated Account publication', async () => {
        if (provider !== 'postgres') return;
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const source = await inTx(tx => createProjectSourceInTx(tx, owner.id, { serverId, requestKey: randomUUID(), name: 'Store bindings' }));
        if (!source.ok) throw new Error(source.error);
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: owner.id, metadata: '{}', installationId: randomUUID() } });
        const definition = createDeploymentEnvironmentV1().content;
        if (definition.t !== 'plain') throw new Error('Expected plain Environment fixture');
        const content = async () => {
            const artifact = await createArtifact({ actorUserId: owner.id, artifactId: randomUUID(),
                header: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ kind: 'deployment-environment.v1', title: 'Store bindings' })),
                body: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ body: JSON.stringify({ ...definition.v, bindings: [] }) })),
                dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) });
            if (!artifact.ok) throw new Error(artifact.error);
            return { contentArtifactId: artifact.artifact.id, contentHeaderVersion: 1, contentBodyVersion: 1 };
        };
        const environment = await db.deploymentEnvironment.create({ data: { projectSourceId: source.source.id,
            createdByAccountId: owner.id, protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers',
            controllerMachineId: machine.id, ...await content() } });
        const input = { serverId, environmentId: environment.id, expectedRevision: 1, ...await content(),
            referencedSavedSecretRevisions: [], grants: [] };
        await withAuthenticatedTestApp(registerDeploymentRoutes, async (app: Fastify) => {
            const request = () => app.inject({ method: 'POST', url: `/v1/deployments/environments/${environment.id}/bindings`,
                headers: { 'x-test-user-id': owner.id }, payload: input });
            const atPublication = (sql: string) => sql.includes('FROM "Account"') && sql.includes('FOR NO KEY UPDATE');
            const { result: response, advances } = await withAccountPublicationBeforeTransactionSql(owner.id, atPublication, request);
            expect(response.statusCode, response.body).toBe(200);
            expect(response.json()).toMatchObject({ ok: true, revision: 2 });
            expect(advances).toBe(1);
            expect(await db.deploymentEnvironment.findUniqueOrThrow({ where: { id: environment.id } }))
                .toMatchObject({ revision: 2, contentArtifactId: input.contentArtifactId });
        });
    });

    it('cannot resurrect retired Secret delivery grants when rotation races an admitted binding write', async () => {
        if (provider !== 'postgres') return;
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const donor = await db.account.create({ data: { encryptionMode: 'plain' } });
        await makeShareEligibleForTest(donor.id, owner.id);
        const resourceId = randomUUID();
        const secret = { v: 1 as const, name: 'Binding rotation', kind: 'token' as const, value: 'synthetic-original' };
        expect(await inTx(tx => createSavedSecretResourceInTx(tx, { accountId: donor.id, resourceId,
            displayName: secret.name, kind: secret.kind, encryptionMode: 'plain', accountGrants: [owner.id],
            storedContent: { t: 'plain', v: secret } }))).toMatchObject({ ok: true });
        const source = await inTx(tx => createProjectSourceInTx(tx, owner.id, { serverId,
            requestKey: randomUUID(), name: 'Binding rotation' }));
        if (!source.ok) throw new Error(source.error);
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: owner.id,
            metadata: encodePlainMachineStoredContent({ host: 'Binding rotation', platform: 'linux',
                happyCliVersion: 'test', homeDir: '/home/test', happyHomeDir: '/home/test/.happier' }),
            dataEncryptionKey: privacyKit.decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER), installationId: randomUUID() } });
        const definition = createDeploymentEnvironmentV1().content;
        if (definition.t !== 'plain') throw new Error('Expected plain Environment fixture');
        const content = async (bindings: unknown[]) => {
            const artifact = await createArtifact({ actorUserId: owner.id, artifactId: randomUUID(),
                header: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ kind: 'deployment-environment.v1', title: 'Binding rotation' })),
                body: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ body: JSON.stringify({ ...definition.v, bindings }) })),
                dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) });
            if (!artifact.ok) throw new Error(artifact.error);
            return { contentArtifactId: artifact.artifact.id, contentHeaderVersion: 1, contentBodyVersion: 1 };
        };
        const initialContent = await content([]);
        const environment = await db.deploymentEnvironment.create({ data: { projectSourceId: source.source.id,
            createdByAccountId: owner.id, protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers',
            controllerMachineId: machine.id, referencedSavedSecretRevisions: [], ...initialContent } });
        const link = await db.deploymentTargetLink.create({ data: { environmentId: environment.id,
            role: 'runtime', sourceKind: 'host', hostTargetId: 'own-server', targetKind: 'ownServer', state: 'configured',
            createdByAccountId: owner.id, ...initialContent,
            machines: { create: [{ machineId: machine.id, installationId: machine.installationId!, position: 0, state: 'active' }] } } });
        await db.deploymentEnvironment.update({ where: { id: environment.id }, data: { runtimeTargetLinkId: link.id } });
        const input = { serverId, environmentId: environment.id, expectedRevision: 1,
            ...await content([{ purpose: 'variable', phase: 'runtime', name: 'TOKEN',
                source: { kind: 'secret', ref: formatSharedSavedSecretRefV1(resourceId), resourceRevision: 1 } }]),
            referencedSavedSecretRevisions: [{ resourceId, revision: 1 }], grants: [{ v: 1, kind: 'secret',
                environmentId: environment.id, machineId: machine.id, installationId: machine.installationId!,
                resourceId, resourceRevision: 1, sealedContent: 'synthetic-revision-one-seal' }] };
        await withAuthenticatedTestApp(app => {
            registerDeploymentRoutes(app);
            registerSavedSecretResourceRoutes(app);
        }, async app => {
            const transaction = db.$transaction;
            let firstTransaction = true;
            let bindingPid = 0;
            let rotationPid = 0;
            let suspended = false;
            let pause!: () => void;
            let release!: () => void;
            const paused = new Promise<void>(resolve => { pause = resolve; });
            const released = new Promise<void>(resolve => { release = resolve; });
            // The real grant read follows authoritative Secret capture validation.
            // Pause its SQL consumption, keeping both public route writers real.
            db.$transaction = new Proxy(transaction, { apply(target, receiver, args: unknown[]) {
                const callback = args[0];
                if (typeof callback !== 'function') return Reflect.apply(target, receiver, args);
                const bindingTransaction = firstTransaction;
                firstTransaction = false;
                return Reflect.apply(target, receiver, [async (tx: Tx) => {
                    const [backend] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
                    if (bindingTransaction) bindingPid = backend.pid;
                    else rotationPid = backend.pid;
                    return callback(new Proxy(tx, { get(inner, property, innerReceiver) {
                        if (!bindingTransaction || property !== 'machineSecretGrant') return Reflect.get(inner, property, innerReceiver);
                        return new Proxy(inner.machineSecretGrant, { get(delegate, method, delegateReceiver) {
                            const query = Reflect.get(delegate, method, delegateReceiver);
                            if (method !== 'findMany') return query;
                            return (...values: unknown[]) => observeLazyPrismaQuery(Reflect.apply(query, delegate, values),
                                () => ({ started() {}, settled() {} }), async () => {
                                    if (suspended) return;
                                    suspended = true;
                                    pause();
                                    await released;
                                });
                        } });
                    } }));
                }, ...args.slice(1)]);
            } });
            type HttpResponse = { statusCode: number; body: string };
            let binding: Promise<HttpResponse> | undefined;
            let rotation: Promise<HttpResponse> | undefined;
            let rotationSettled = false;
            try {
                binding = Promise.resolve(app.inject({ method: 'POST',
                    url: `/v1/deployments/environments/${environment.id}/bindings`,
                    headers: { 'x-test-user-id': owner.id }, payload: input }));
                // Surface fixture/admission failures instead of stranding the pause.
                void binding.then(pause, pause);
                await paused;
                if (!suspended) {
                    const response = await binding;
                    throw new Error(`Binding did not reach grant SQL: ${response.statusCode} ${response.body}`);
                }
                rotation = Promise.resolve(app.inject({ method: 'POST', url: '/v1/account/saved-secrets/resources/update',
                    headers: { 'x-test-user-id': donor.id }, payload: { resourceId, expectedRevision: 1,
                        displayName: secret.name, kind: secret.kind,
                        storedContent: { t: 'plain', v: { ...secret, value: 'synthetic-rotated' } } } }))
                    .finally(() => { rotationSettled = true; });
                // The corrected owner blocks rotation at Account admission. The
                // broken owner lets it commit before the paused grant insertion.
                let waiting = false;
                while (!waiting && !rotationSettled) {
                    const [state] = await db.$queryRaw<Array<{ waiting: boolean }>>`
                        SELECT EXISTS(SELECT 1 FROM pg_stat_activity
                            WHERE pid = ${rotationPid} AND ${bindingPid} = ANY(pg_blocking_pids(pid))) AS waiting`;
                    waiting = state.waiting;
                }
                release();
                const bound = await binding;
                expect(bound.statusCode, bound.body).toBe(200);
                const rotated = await rotation;
                expect(rotated.statusCode, rotated.body).toBe(200);
                expect(await db.savedSecretResource.findUniqueOrThrow({ where: { id: resourceId }, select: { revision: true } }))
                    .toEqual({ revision: 2 });
                expect(await db.machineSecretGrant.findMany({ where: { environmentId: environment.id,
                    kind: 'secret', resourceId, resourceRevision: 1 } }),
                'future installed delivery must not recover a retired revision-one seal').toEqual([]);
            } finally {
                release();
                db.$transaction = transaction;
                await Promise.allSettled([binding, rotation]);
            }
        });
    });

    it('settles private receipt content and activation atomically despite unrelated Account publication, and replays the exact signed settle', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const reader = await db.account.create({ data: { encryptionMode: 'plain' } });
        await makeShareEligibleForTest(owner.id, reader.id);
        const source = await inTx(tx => createProjectSourceInTx(tx, owner.id, { serverId, requestKey: randomUUID(),
            name: 'Shared deployment Source', audience: [{ principal: { kind: 'account', accountId: reader.id }, level: 'view' }] }));
        if (!source.ok) throw new Error(source.error);
        const keys = nacl.sign.keyPair();
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: owner.id, metadata: '{}',
            installationId: randomUUID(), installationPublicKey: new Uint8Array(keys.publicKey) } });
        const artifact = await createArtifact({ actorUserId: owner.id, artifactId: randomUUID(),
            header: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ kind: 'deployment-receipt.v1', title: 'Private receipt' })),
            body: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ body: JSON.stringify({ steps: [] }) })),
            dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) });
        if (!artifact.ok) throw new Error(artifact.error);
        const content = { contentArtifactId: artifact.artifact.id, contentHeaderVersion: 1, contentBodyVersion: 1 };
        const environment = await db.deploymentEnvironment.create({ data: { projectSourceId: source.source.id,
            createdByAccountId: owner.id, protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers',
            controllerMachineId: machine.id, ...content } });
        const link = await db.deploymentTargetLink.create({ data: { environmentId: environment.id,
            role: 'runtime', sourceKind: 'host', hostTargetId: 'own-server', targetKind: 'ownServer', state: 'configured',
            createdByAccountId: owner.id, ...content } });
        await db.deploymentEnvironment.update({ where: { id: environment.id }, data: { runtimeTargetLinkId: link.id } });
        const receipt = await db.deployment.create({ data: { environmentId: environment.id, targetLinkId: link.id,
            operation: 'deploy', state: 'queued', requestKey: randomUUID(), actionOperationId: randomUUID(),
            requestedByAccountId: owner.id, acceptedControllerMachineId: machine.id,
            acceptedControllerInstallationId: machine.installationId, ...content } });
        const body: Omit<DeploymentTransitionInputV1, 'proof'> = { serverId, environmentId: environment.id,
            deploymentId: receipt.id, actionOperationId: receipt.actionOperationId, expectedRevision: 1,
            machineId: machine.id, installationId: machine.installationId!, kind: 'stage', state: 'running',
            contentUpdate: { body: encodePlainArtifactStoredContent({ body: JSON.stringify({ steps: ['started'] }) }), expectedBodyVersion: 1 } };
        const proof = signMachineInstallationProof({ payload: { version: 1, machineId: machine.id,
            installationId: machine.installationId!, accountId: owner.id, deploymentTransition: { serverId,
                environmentId: environment.id, deploymentId: receipt.id, actionOperationId: receipt.actionOperationId,
                expectedRevision: 1, requestBodyDigest: computeDeploymentTransitionRequestDigestV1(body) } }, privateKey: keys.secretKey });
        const result = await inTx(tx => transitionDeploymentInTx(tx, owner.id, { ...body, proof }), { isolationLevel: 'Serializable' });
        expect(result).toMatchObject({ ok: true, deploymentId: receipt.id, deploymentRevision: 2, state: 'running' });
        expect(await db.deployment.findUniqueOrThrow({ where: { id: receipt.id } })).toMatchObject({ state: 'running', contentBodyVersion: 2 });
        const readerChanges = await db.accountChange.findMany({ where: { accountId: reader.id, kind: 'account' } });
        expect(readerChanges.map(readDeploymentAccountChangeV1)).toContainEqual(expect.objectContaining({
            environmentId: environment.id, deploymentId: receipt.id,
        }));
        // A Source audience reader opens the Source's receipt content as view (Plan 40 reader role; bccba30f4cd),
        // without owning it.
        expect(await readArtifactForCaller({ actorAccountId: reader.id, artifactId: artifact.artifact.id }))
            .toMatchObject({ ok: true, artifact: { access: 'view' } });

        if (provider !== 'postgres') return;
        const settleBody: Omit<DeploymentTransitionInputV1, 'proof'> = { serverId, environmentId: environment.id,
            deploymentId: receipt.id, actionOperationId: receipt.actionOperationId, expectedRevision: 2,
            machineId: machine.id, installationId: machine.installationId!, kind: 'settle', state: 'succeeded',
            expectedTargetLinkRevision: 1,
            contentArtifactId: content.contentArtifactId, contentHeaderVersion: 1, contentBodyVersion: 2,
            contentUpdate: { body: encodePlainArtifactStoredContent({ body: JSON.stringify({ steps: ['started', 'activated'] }) }),
                expectedBodyVersion: 2 } };
        const signTransition = (input: Omit<DeploymentTransitionInputV1, 'proof'>): DeploymentTransitionInputV1 => ({
            ...input, proof: signMachineInstallationProof({ payload: { version: 1,
                machineId: machine.id, installationId: machine.installationId!, accountId: owner.id,
                deploymentTransition: { serverId, environmentId: environment.id, deploymentId: receipt.id,
                    actionOperationId: input.actionOperationId, expectedRevision: input.expectedRevision,
                    requestBodyDigest: computeDeploymentTransitionRequestDigestV1(input) } }, privateKey: keys.secretKey }) });
        const settle = signTransition(settleBody);
        const atPublication = (sql: string) => sql.includes('FROM "Account"') && sql.includes('FOR NO KEY UPDATE');
        const beforeReceipt = await db.deployment.findUniqueOrThrow({ where: { id: receipt.id } });
        const beforeArtifact = await db.artifact.findUniqueOrThrow({ where: { id: content.contentArtifactId } });
        const beforeLink = await db.deploymentTargetLink.findUniqueOrThrow({ where: { id: link.id } });
        // Real peer commits at Prisma's SQL boundary; no domain logic is replaced.
        await expect(withAccountPublicationBeforeTransactionSql(owner.id, atPublication,
            () => inTx(tx => transitionDeploymentInTx(tx, owner.id, settle), { isolationLevel: 'Serializable' })))
            .rejects.toMatchObject({ code: 'database_transaction_conflict_exhausted' });
        expect(await db.deployment.findUniqueOrThrow({ where: { id: receipt.id } })).toEqual(beforeReceipt);
        expect(await db.artifact.findUniqueOrThrow({ where: { id: content.contentArtifactId } })).toEqual(beforeArtifact);
        expect(await db.deploymentTargetLink.findUniqueOrThrow({ where: { id: link.id } })).toEqual(beforeLink);
        await withAuthenticatedTestApp(registerDeploymentRoutes, async (app: Fastify) => {
            const request = () => app.inject({ method: 'POST',
                url: `/v1/deployments/environments/${environment.id}/deployments/${receipt.id}/transitions`,
                headers: { 'x-test-user-id': owner.id }, payload: settle });
            const { result: response, advances } = await withAccountPublicationBeforeTransactionSql(owner.id, atPublication, request);
            expect(response.statusCode, response.body).toBe(200);
            expect(response.json()).toMatchObject({ ok: true, state: 'succeeded', deploymentRevision: 3 });
            expect(advances).toBe(1);
            const publishedSeq = (await db.account.findUniqueOrThrow({ where: { id: owner.id } })).seq;
            const repeated = await request();
            expect(repeated.statusCode, repeated.body).toBe(200);
            expect(repeated.json()).toEqual(response.json());
            expect((await db.account.findUniqueOrThrow({ where: { id: owner.id } })).seq).toBe(publishedSeq);
            const failedBody = { ...settleBody, state: 'failed' as const };
            delete failedBody.expectedTargetLinkRevision;
            const differentState = await app.inject({ method: 'POST',
                url: `/v1/deployments/environments/${environment.id}/deployments/${receipt.id}/transitions`,
                headers: { 'x-test-user-id': owner.id }, payload: signTransition(failedBody) });
            expect(differentState.statusCode, differentState.body).toBe(409);
            expect(differentState.json()).toMatchObject({ ok: false, error: 'deployment_conflict' });
            const differentOperation = await app.inject({ method: 'POST',
                url: `/v1/deployments/environments/${environment.id}/deployments/${receipt.id}/transitions`,
                headers: { 'x-test-user-id': owner.id },
                payload: signTransition({ ...settleBody, actionOperationId: randomUUID() }) });
            expect(differentOperation.statusCode, differentOperation.body).toBe(404);
            expect((await db.account.findUniqueOrThrow({ where: { id: owner.id } })).seq).toBe(publishedSeq);
        });
        expect(await db.deployment.findUniqueOrThrow({ where: { id: receipt.id } }))
            .toMatchObject({ state: 'succeeded', revision: 3, contentBodyVersion: 3 });
        expect(await db.deploymentTargetLink.findUniqueOrThrow({ where: { id: link.id } }))
            .toMatchObject({ activeDeploymentId: receipt.id, revision: 2, state: 'deployed' });
        expect((await db.artifact.findUniqueOrThrow({ where: { id: content.contentArtifactId } })).bodyVersion).toBe(3);
    });
});
