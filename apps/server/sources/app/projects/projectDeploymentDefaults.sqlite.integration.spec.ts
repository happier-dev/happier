import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import * as privacyKit from 'privacy-kit';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent, createActionExecutor,
    bindHomeDomainActionHttpRequestV1, ProjectDeploymentDefaultsSetInputV1Schema,
    ProjectDeploymentDefaultsOutputV1Schema, type ActionExecutorDeps } from '@happier-dev/protocol';
import { db } from '@/storage/db';
import { makeShareEligibleForTest } from '@/testkit/shareEligibility.testkit';
import { inTx } from '@/storage/inTx';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { withAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { observeSqliteRequests } from '@/testkit/observeSqliteRequests';
import { projectSourceRoutes } from '@/app/api/routes/projects/projectSourceRoutes';
import { createProjectSourceInTx } from './sources/projectSourceService';
import { createArtifact } from '@/app/artifacts/artifactWriteService';
import { readArtifactForCallerInTx } from '@/app/artifacts/artifactAccessService';
import { exerciseProjectDefaultsStorage } from './projectDeploymentDefaults.testkit';

describe('shared Project deployment defaults real storage', () => {
    const serverId = `srv_${'a'.repeat(32)}`;
    let harness: LightSqliteHarness;
    beforeAll(async () => { harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-project-defaults-', initEncrypt: true,
        env: { HAPPIER_SERVER_IDENTITY_ID: serverId } }); }, 180_000);
    afterAll(async () => { if (harness) await harness.close(); });

    it.each(['plain', 'e2ee'] as const)('admits the same %s defaults through real Team, Artifact mode and recipient keys', async mode => {
        await exerciseProjectDefaultsStorage(mode, serverId);
    });

    it('shares one Source-admitted leaf under content CAS without rewriting configured Environments', async () => {
        const [owner, member, outsider] = await Promise.all(Array.from({ length: 3 }, () => db.account.create({ data: { encryptionMode: 'plain' } })));
        await makeShareEligibleForTest(owner.id, member.id);
        const created = await inTx(tx => createProjectSourceInTx(tx, owner.id, { serverId, requestKey: randomUUID(), name: 'Shared defaults',
            audience: [{ principal: { kind: 'account', accountId: member.id }, level: 'view' }],
            repository: { provider: { id: 'github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' },
                repository: { nameWithOwner: 'acme/defaults', cloneUrl: 'https://github.com/acme/defaults.git' }, protocol: 'https' } }));
        if (!created.ok) throw new Error(created.error);
        const source = created.source;
        await withAuthenticatedTestApp(projectSourceRoutes, async app => {
            const url = `/v1/projects/${source.id}/deployment-defaults`;
            const headers = (id: string) => ({ 'x-test-user-id': id });
            const initial = await app.inject({ method: 'GET', url: `${url}?serverId=${serverId}`, headers: headers(owner.id) });
            expect(initial.statusCode, initial.body).toBe(200);
            expect(initial.json()).toMatchObject({ ok: true, projectSourceId: source.id, revision: 0, content: null });
            expect(ProjectDeploymentDefaultsOutputV1Schema.parse(initial.json()).ok).toBe(true);
            expect((await app.inject({ method: 'GET', url: `${url}?serverId=${serverId}&owner=forged`, headers: headers(owner.id) })).statusCode).toBe(400);
            const opened = { projectSourceId: source.id, deploymentDefaults: { retainPreviousDeployments: 0 } };
            const artifact = await createArtifact({ actorUserId: owner.id, artifactId: randomUUID(),
                header: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ kind: 'project-deployment-defaults.v1', title: 'Project defaults' })),
                body: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ body: JSON.stringify(opened) })),
                dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) });
            if (!artifact.ok) throw new Error(artifact.error);
            await db.artifactAccountGrant.create({ data: { artifactId: artifact.artifact.id, accountId: member.id, accessLevel: 'view', createdByAccountId: owner.id } });
            const content = { contentArtifactId: artifact.artifact.id, contentHeaderVersion: 1, contentBodyVersion: 1 };
            const machine = await db.machine.create({ data: { id: randomUUID(), accountId: owner.id, metadata: '{}', installationId: randomUUID() } });
            const configured = await db.deploymentEnvironment.create({ data: { projectSourceId: source.id, createdByAccountId: owner.id,
                protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers', controllerMachineId: machine.id, ...content } });
            const payload = { serverId, projectSourceId: source.id, expectedSourceRevision: source.revision, expectedRevision: 0, content };
            expect((await app.inject({ method: 'PUT', url: `/v1/projects/foreign/deployment-defaults`, headers: headers(owner.id), payload })).statusCode).toBe(400);
            expect((await app.inject({ method: 'PUT', url, headers: headers(owner.id), payload: { ...payload, expectedSourceRevision: source.revision + 1 } })).statusCode).toBe(409);
            const actionDeps = {
                // In-process HTTP replaces only the network; Action admission, binding, route and storage stay real.
                homeDomainAction: async ({ actionId, input }) => {
                    const bound = bindHomeDomainActionHttpRequestV1(actionId, input);
                    expect(bound.method).toBe('PUT');
                    const response = await app.inject({ method: 'PUT', url: bound.path, headers: headers(owner.id),
                        payload: ProjectDeploymentDefaultsSetInputV1Schema.parse(bound.body) });
                    return ProjectDeploymentDefaultsOutputV1Schema.parse(response.json());
                },
            } satisfies Partial<ActionExecutorDeps>;
            // This harness invokes only the defaults Home-domain Action. Other
            // executor ports are intentionally absent, not substituted internally.
            const executor = createActionExecutor(actionDeps as ActionExecutorDeps);
            const environmentWrites: unknown[] = [];
            const stop = observeSqliteRequests({ before: request => {
                if (request.model === 'DeploymentEnvironment' && !['findMany', 'findUnique', 'findFirst', 'count'].includes(request.action)) environmentWrites.push(request);
            } });
            try {
                const saved = await app.inject({ method: 'PUT', url, headers: headers(owner.id), payload });
                expect(saved.statusCode, saved.body).toBe(200);
                expect(saved.json()).toMatchObject({ ok: true, projectSourceId: source.id, revision: 1, content });
                expect(ProjectDeploymentDefaultsOutputV1Schema.parse(saved.json()).ok).toBe(true);
                expect(await inTx(tx => readArtifactForCallerInTx(tx, { actorAccountId: member.id, artifactId: artifact.artifact.id }))).toMatchObject({ ok: true });
                const reads: { model?: string; action: string; args: unknown }[] = [];
                const stopReads = observeSqliteRequests({ before: request => { reads.push(request); } });
                const memberRead = await app.inject({ method: 'GET', url: `${url}?serverId=${serverId}`, headers: headers(member.id) });
                stopReads();
                expect(memberRead.json()).toEqual(saved.json());
                expect(reads.filter(read => read.model === 'ProjectDeploymentDefaults')).toHaveLength(1);
                expect(reads.filter(read => read.model === 'Artifact')).toMatchObject([{ action: 'findFirst', args: { where: { id: artifact.artifact.id }, select: { body: false } } }]);
                expect((await app.inject({ method: 'GET', url: `${url}?serverId=${serverId}`, headers: headers(outsider.id) })).statusCode).toBe(404);
                expect((await app.inject({ method: 'GET', url: `${url}?serverId=srv_${'b'.repeat(32)}`, headers: headers(owner.id) })).statusCode).toBe(404);
                expect((await app.inject({ method: 'PUT', url, headers: headers(member.id), payload: { ...payload, expectedRevision: 1 } })).statusCode).toBe(403);
                expect((await app.inject({ method: 'PUT', url, headers: headers(owner.id), payload: { ...payload, projectSourceId: 'foreign' } })).statusCode).toBe(400);
                expect((await app.inject({ method: 'PUT', url, headers: headers(owner.id), payload: { ...payload, owner: owner.id } })).statusCode).toBe(400);
                expect((await app.inject({ method: 'PUT', url, headers: headers(owner.id), payload })).statusCode).toBe(409);
                expect((await app.inject({ method: 'PUT', url, headers: headers(owner.id), payload: { ...payload, expectedRevision: 1,
                    content: { ...content, contentBodyVersion: 2 } } })).statusCode).toBe(409);
                const changes = await db.accountChange.findMany({ where: { entityId: `projects:${source.id}:deploymentDefaults` }, orderBy: { accountId: 'asc' } });
                expect(changes.map(row => row.accountId).sort()).toEqual([owner.id, member.id].sort());
                expect(changes.map(row => row.hint)).toEqual(Array.from({ length: 2 }, () => ({ projectSourceId: source.id, key: 'deploymentDefaults', revision: 1 })));
                const cursors = changes.map(row => row.cursor);
                const equal = await executor.execute('projects.deploymentDefaults.set', { ...payload, expectedRevision: 1 },
                    { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' }, serverId });
                expect(equal).toEqual({ ok: true, result: saved.json() });
                expect((await db.accountChange.findMany({ where: { entityId: `projects:${source.id}:deploymentDefaults` }, orderBy: { accountId: 'asc' } })).map(row => row.cursor)).toEqual(cursors);
                const clear = await app.inject({ method: 'PUT', url, headers: headers(owner.id), payload: { ...payload, expectedRevision: 1, content: null } });
                expect(clear.json()).toMatchObject({ ok: true, revision: 2, content: null });
                expect(environmentWrites).toEqual([]);
                expect(await db.deploymentEnvironment.findUniqueOrThrow({ where: { id: configured.id } })).toEqual(configured);
            } finally { stop(); }
        });
    });
});
