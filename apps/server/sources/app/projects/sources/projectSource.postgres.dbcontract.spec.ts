import { randomUUID } from 'node:crypto';
import { PrismaClient, type Prisma } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PROJECT_SOURCES_ACCOUNT_CHANGE_ENTITY_ID_V1, type ProjectSourceGrantV1 } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import { db, getDbProviderFromEnv, initDbPostgres } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { createProjectSourceInTx, readProjectSourceInTx, updateProjectSourceInTx, listProjectSourcesInTx,
    resolveProjectSourcesAccessInTx, resolveProjectSourceAccessInTx } from './projectSourceService';
import { encryptIdentityProviderSecrets } from '@/app/auth/providers/managed/identityProviderSecretCipher';
import { readTeamAuthenticationConnectionDescriptorsInTx } from '@/app/auth/providers/identityProviderCatalog';
import { teamIdentityConnectionReferenceKey } from '@/app/teams/identity/teamIdentityConnectionLifecycle';
import * as privacyKit from 'privacy-kit';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol';
import { MACHINE_PLAIN_DATA_KEY_MARKER, encodePlainMachineStoredContent } from '@happier-dev/protocol/machines/machineStoredContent';
import { createDeploymentEnvironmentDetailV1, createDeploymentV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { initEncrypt } from '@/modules/encrypt';
import { createArtifact } from '@/app/artifacts/artifactWriteService';
import { createDeploymentEnvironmentInTx } from '@/app/deployments/deploymentEnvironmentService';
import { deleteDeploymentEnvironmentInTx } from '@/app/deployments/deploymentDispositionService';
import { readDeploymentEnvironmentInTx, listDeploymentEnvironmentsInTx, readDeploymentReceiptInTx, listDeploymentReceiptsInTx } from '@/app/deployments/deploymentReadService';
import { projectSourceRoutes } from '@/app/api/routes/projects/projectSourceRoutes';
import { withAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';

const repository = { provider: { id: 'happier.scm.forge.github/github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' },
    repository: { nameWithOwner: 'acme/repo', cloneUrl: 'https://github.com/acme/repo.git', visibility: 'private' }, protocol: 'https' };

describe.skipIf(getDbProviderFromEnv(process.env, 'postgres') !== 'postgres')('Source audience publication SQL costs', () => {
    let connected = false;
    beforeAll(async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
            || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error('Run with the disposable PostgreSQL DB-contract harness');
        }
        initDbPostgres();
        await db.$connect();
        connected = true;
    });
    afterAll(async () => { if (connected) await db.$disconnect(); });

    it('admits a Source page with current Team and Group lifetimes in one data statement', async () => {
        const actor = await db.account.create({ data: { encryptionMode: 'plain' } });
        const team = await db.team.create({ data: { name: 'Captured Source page' } });
        const membership = await db.teamMembership.create({ data: { teamId: team.id, accountId: actor.id, role: 'member' } });
        const group = await db.teamGroup.create({ data: { teamId: team.id, name: 'Readers', nameKey: randomUUID() } });
        await db.teamGroupMembership.create({ data: { teamId: team.id, teamGroupId: group.id, teamMembershipId: membership.id, nativeContribution: true } });
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const source = await db.projectSource.create({ data: { name: 'Group Source', createdByAccountId: owner.id,
            owner: { kind: 'account', accountId: owner.id },
            audience: [{ principal: { kind: 'group', teamId: team.id, groupId: group.id }, level: 'view' }], attachments: [] } });
        const statements: Prisma.QueryEvent[] = [];
        const client = new PrismaClient({ log: [{ emit: 'event', level: 'query' }] });
        client.$on('query', event => statements.push(event));
        await client.$connect();
        try {
            for (const suspended of [false, true]) {
                if (suspended) await db.teamMembership.update({ where: { id: membership.id }, data: { status: 'suspended' } });
                statements.length = 0;
                const result = await client.$transaction(tx => resolveProjectSourcesAccessInTx(tx, actor.id, [source.id]));
                expect(result.get(source.id)?.ok).toBe(!suspended);
                expect(statements.filter(event => /^(?:SELECT|WITH)\b/.test(event.query.trimStart()))).toHaveLength(1);
            }
        } finally { await client.$disconnect(); }
    });

    it('uses the exact current managed Team credential in one captured statement', async () => {
        process.env.HANDY_MASTER_SECRET ??= 'source-capture-disposable-contract';
        await initEncrypt();
        const env = { HAPPIER_PUBLIC_SERVER_URL: 'https://source-capture.example.test' };
        const actor = await db.account.create({ data: { encryptionMode: 'plain' } });
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const team = await db.team.create({ data: { name: 'Captured SSO' } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: actor.id, role: 'member' } });
        const providerId = randomUUID();
        const encryptedSecrets = encryptIdentityProviderSecrets({ id: providerId, kind: 'oidc',
            secrets: { v: 1, kind: 'oidc', clientSecret: 'fixture-secret'.repeat(8) } });
        // PostgreSQL wraps base64 after 57 input bytes; exercise the real encoded secret boundary.
        expect(encryptedSecrets.byteLength).toBeGreaterThan(57);
        await db.identityProviderInstance.create({ data: { id: providerId, ownerTeamId: team.id, kind: 'oidc',
            displayName: 'SSO', enabled: true, firstEnabledAt: new Date('2026-09-06T00:00:00Z'),
            config: { v: 1, kind: 'oidc', issuer: 'https://identity.example.test', clientId: 'happier',
                clientAuthenticationMethod: 'client_secret_post', scopes: 'openid profile email', httpTimeoutSeconds: 30,
                claims: { login: 'preferred_username', email: 'email', groups: 'groups' },
                allow: { usersAllowlist: [], emailDomains: [], groupsAny: [], groupsAll: [] },
                fetchUserInfo: true, storeRefreshToken: false, ui: { buttonColor: null, iconHint: 'oidc' } },
            encryptedSecrets } });
        const connection = await db.teamIdentityConnection.create({ data: { teamId: team.id, providerInstanceId: providerId,
            externalReference: { v: 1, kind: 'oidc' }, settings: { v: 1, kind: 'oidc', allowedUsers: [],
                allowedEmailDomains: [], groupsAny: [], groupsAll: [] }, enabled: true, firstEnabledAt: new Date() } });
        await db.team.update({ where: { id: team.id }, data: { authenticationPolicy: { v: 1, mode: 'restricted',
            accepted: [{ kind: 'team_connection', connectionId: connection.id }] } } });
        const identity = await db.accountIdentity.create({ data: { accountId: actor.id, provider: providerId,
            providerUserId: randomUUID(), eligibilityStatus: 'eligible' } });
        const source = await db.projectSource.create({ data: { name: 'SSO Source', createdByAccountId: owner.id,
            owner: { kind: 'team', teamId: team.id }, audience: [], attachments: [] } });
        const descriptors = await inTx(tx => readTeamAuthenticationConnectionDescriptorsInTx(tx, {
            env, references: [{ teamId: team.id, id: connection.id }],
        }));
        const descriptor = descriptors.get(teamIdentityConnectionReferenceKey(connection));
        if (descriptor?.status !== 'ready' || !descriptor.descriptor) throw new Error('Expected offered SSO fixture');
        const authentication = { env, authenticationAuthority: 'present_user' as const, authenticationEvidence: [{
            kind: 'provider' as const, providerId, identityId: identity.id, teamConnectionId: connection.id,
            runtimeFingerprint: descriptor.descriptor.reference.runtimeFingerprint,
        }] };
        const statements: Prisma.QueryEvent[] = [];
        const client = new PrismaClient({ log: [{ emit: 'event', level: 'query' }] });
        client.$on('query', event => statements.push(event));
        await client.$connect();
        try {
            for (const state of ['current', 'absent_evidence', 'ineligible_identity', 'restored_identity', 'disabled_connection'] as const) {
                if (state === 'ineligible_identity') await db.accountIdentity.update({ where: { id: identity.id }, data: { eligibilityStatus: 'ineligible' } });
                if (state === 'restored_identity') await db.accountIdentity.update({ where: { id: identity.id }, data: { eligibilityStatus: 'eligible' } });
                if (state === 'disabled_connection') await db.teamIdentityConnection.update({ where: { id: connection.id }, data: { enabled: false } });
                const credential = state === 'absent_evidence' ? { ...authentication, authenticationEvidence: [] } : authentication;
                const scalar = await inTx(tx => resolveProjectSourceAccessInTx(tx, actor.id, source.id, credential));
                statements.length = 0;
                const captured = await client.$transaction(tx => resolveProjectSourcesAccessInTx(tx, actor.id, [source.id], credential));
                expect(captured.get(source.id)).toEqual(scalar);
                expect(captured.get(source.id)?.ok).toBe(state === 'current' || state === 'restored_identity');
                expect(statements.filter(event => /^(?:SELECT|WITH)\b/.test(event.query.trimStart()))).toHaveLength(1);
            }
        } finally { await client.$disconnect(); }
    });

    it('tombstones a Source, hides it from selection and retains live and deleted Environment history', async () => {
        const serverId = `srv_${'e'.repeat(32)}`;
        process.env.HAPPIER_SERVER_IDENTITY_ID = serverId;
        process.env.HANDY_MASTER_SECRET ??= 'source-delete-disposable-contract';
        await initEncrypt();
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const created = await inTx(tx => createProjectSourceInTx(tx, owner.id, { serverId,
            requestKey: randomUUID(), name: 'Retained history', repository }));
        if (!created.ok) throw new Error(created.error);
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: owner.id,
            metadata: encodePlainMachineStoredContent({ host: 'source-delete-test', platform: 'linux',
                happyCliVersion: 'test', homeDir: '/tmp', happyHomeDir: '/tmp/happier' }),
            dataEncryptionKey: privacyKit.decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER), installationId: randomUUID() } });
        const artifact = await createArtifact({ actorUserId: owner.id, artifactId: randomUUID(),
            kind: 'v1:other:deployment-environment.v1',
            header: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ kind: 'deployment-environment.v1', title: 'Retained' })),
            body: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ body: JSON.stringify(createDeploymentEnvironmentDetailV1().content) })),
            dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) });
        if (!artifact.ok) throw new Error(artifact.error);
        const environment = await inTx(tx => createDeploymentEnvironmentInTx(tx, owner.id, {
            serverId, projectSourceId: created.source.id, protection: 'nonProduction', deployerMode: 'managers',
            controllerMachineId: machine.id, purpose: 'standard', requestKey: randomUUID(),
            contentArtifactId: artifact.artifact.id, contentHeaderVersion: 1, contentBodyVersion: 1,
        }));
        if (!environment.ok) throw new Error(environment.error);
        await withAuthenticatedTestApp(projectSourceRoutes, async app => {
            const response = await app.inject({ method: 'DELETE', url: `/v1/projects/sources/${created.source.id}`,
                headers: { 'x-test-user-id': owner.id },
                payload: { serverId, sourceId: created.source.id, expectedRevision: created.source.revision } });
            expect(response.statusCode).toBe(200);
            expect(response.json()).toEqual({ ok: true, sourceId: created.source.id, revision: created.source.revision });
            expect(await inTx(tx => readProjectSourceInTx(tx, owner.id, { serverId, sourceId: created.source.id })))
                .toEqual({ ok: false, error: 'source_unavailable' });
            const listed = await inTx(tx => listProjectSourcesInTx(tx, owner.id, { serverId }));
            expect(listed.ok).toBe(true);
            expect(listed.ok && listed.sources.some(source => source.id === created.source.id)).toBe(false);
            expect(await db.projectSource.findUniqueOrThrow({ where: { id: created.source.id } }))
                .toMatchObject({ name: created.source.name, deletedAt: expect.any(Date) });
            expect(await inTx(tx => createDeploymentEnvironmentInTx(tx, owner.id, {
                serverId, projectSourceId: created.source.id, protection: 'nonProduction', deployerMode: 'managers',
                controllerMachineId: machine.id, purpose: 'standard', requestKey: randomUUID(),
                contentArtifactId: artifact.artifact.id, contentHeaderVersion: 1, contentBodyVersion: 1,
            }))).toEqual({ ok: false, error: 'deployment_unavailable' });
            for (const deleted of [false, true]) {
                if (deleted) expect(await inTx(tx => deleteDeploymentEnvironmentInTx(tx, owner.id, {
                    serverId, environmentId: environment.environmentId, expectedRevision: environment.revision,
                    requestKey: randomUUID(),
                }))).toMatchObject({ ok: true });
                const before = await db.deploymentEnvironment.findUniqueOrThrow({ where: { id: environment.environmentId } });
                expect(await inTx(tx => readDeploymentEnvironmentInTx(tx, owner.id, { serverId, environmentId: environment.environmentId })))
                    .toMatchObject({ ok: true, environment: { projectSourceId: created.source.id } });
                const history = await inTx(tx => listDeploymentEnvironmentsInTx(tx, owner.id, {
                    serverId, projectSourceId: created.source.id, includeDeleted: true,
                }));
                expect(history).toMatchObject({ ok: true, projectSources: [{ id: created.source.id, name: created.source.name }] });
                expect(await db.deploymentEnvironment.findUniqueOrThrow({ where: { id: environment.environmentId } })).toEqual(before);
            }
            // Persist a historical receipt through the real relational/storage boundary.
            const link = await db.deploymentTargetLink.create({ data: { environmentId: environment.environmentId,
                role: 'runtime', sourceKind: 'host', hostTargetId: 'own-server', targetKind: 'ownServer', state: 'configured',
                createdByAccountId: owner.id, contentArtifactId: artifact.artifact.id, contentHeaderVersion: 1, contentBodyVersion: 1 } });
            const receipt = createDeploymentV1({ environmentId: environment.environmentId, targetLinkId: link.id,
                requestedByAccountId: owner.id, requestKey: randomUUID() });
            if (receipt.content.t !== 'plain') throw new Error('Expected plain receipt fixture');
            const receiptContent = { ...receipt.content.v, sourceIntent: { ...receipt.content.v.sourceIntent,
                projectSourceId: created.source.id, sourceRevision: created.source.revision } };
            const receiptArtifact = await createArtifact({ actorUserId: owner.id, artifactId: randomUUID(),
                kind: 'v1:other:deployment-receipt.v1',
                header: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ kind: 'deployment-receipt.v1', title: 'Retained deploy' })),
                body: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ body: JSON.stringify(receiptContent) })),
                dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) });
            if (!receiptArtifact.ok) throw new Error(receiptArtifact.error);
            const retainedReceipt = await db.deployment.create({ data: { environmentId: environment.environmentId, targetLinkId: link.id,
                operation: receipt.operation, state: receipt.state, requestKey: receipt.requestKey,
                requestedByAccountId: owner.id, actionOperationId: receipt.actionOperationId,
                contentArtifactId: receiptArtifact.artifact.id, contentHeaderVersion: 1, contentBodyVersion: 1 } });
            expect(await inTx(tx => readDeploymentReceiptInTx(tx, owner.id, { serverId, deploymentId: retainedReceipt.id })))
                .toMatchObject({ ok: true, deployment: { id: retainedReceipt.id, environmentId: environment.environmentId } });
            expect(await inTx(tx => listDeploymentReceiptsInTx(tx, owner.id, { serverId, environmentId: environment.environmentId })))
                .toMatchObject({ ok: true, items: [{ id: retainedReceipt.id }] });
            const stranger = await db.account.create({ data: { encryptionMode: 'plain' } });
            expect(await inTx(tx => readDeploymentReceiptInTx(tx, stranger.id, { serverId, deploymentId: retainedReceipt.id })))
                .toEqual({ ok: false, error: 'deployment_unavailable' });
            expect(await db.deployment.findUniqueOrThrow({ where: { id: retainedReceipt.id } })).toEqual(retainedReceipt);
            const unused = await inTx(tx => createProjectSourceInTx(tx, owner.id, { serverId,
                requestKey: randomUUID(), name: created.source.name, repository }));
            if (!unused.ok) throw new Error(unused.error);
            expect(unused.source.id).not.toBe(created.source.id);
            const unusedResponse = await app.inject({ method: 'DELETE', url: `/v1/projects/sources/${unused.source.id}`,
                headers: { 'x-test-user-id': owner.id },
                payload: { serverId, sourceId: unused.source.id, expectedRevision: unused.source.revision } });
            expect(unusedResponse.statusCode).toBe(200);
            expect(unusedResponse.json()).toEqual({ ok: true, sourceId: unused.source.id, revision: unused.source.revision });
            expect(await db.projectSource.findUniqueOrThrow({ where: { id: unused.source.id } })).toMatchObject({ deletedAt: expect.any(Date) });
        });
    });

    it('set-reads distinct old/new audiences and delivers changes to current members and Group administrators', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const fixtures: Array<{ team: { id: string }; accounts: { id: string }[]; groups: { id: string }[] }> = [];
        for (let index = 0; index < 4; index++) {
            const team = await db.team.create({ data: { name: `Audience ${index}` } });
            await db.teamMembership.create({ data: { teamId: team.id, accountId: owner.id, role: 'owner' } });
            const accounts = Array.from({ length: 100 }, (_, member) => ({ id: randomUUID(), encryptionMode: 'plain',
                status: member === 3 ? 'suspended' as const : 'active' as const }));
            await db.account.createMany({ data: accounts });
            const memberships = accounts.map((account, member) => ({ id: randomUUID(), accountId: account.id, teamId: team.id,
                role: member === 99 ? 'admin' as const : member === 1 ? 'guest' as const : 'member' as const,
                status: member === 2 ? 'suspended' as const : 'active' as const }));
            await db.teamMembership.createMany({ data: memberships });
            const groups = Array.from({ length: 8 }, (_, group) => ({ id: randomUUID(), teamId: team.id, name: `Group ${group}`, nameKey: `group-${group}` }));
            await db.teamGroup.createMany({ data: groups });
            await db.teamGroupMembership.createMany({ data: groups.flatMap(group => memberships.slice(0, 4).map(membership => ({
                teamId: team.id, teamGroupId: group.id, teamMembershipId: membership.id, nativeContribution: true,
            }))) });
            fixtures.push({ team, accounts, groups });
        }
        const teamGrant = (teamId: string): ProjectSourceGrantV1 => ({ principal: { kind: 'team', teamId }, level: 'view' });
        const groupGrants = (fixture: typeof fixtures[number]): ProjectSourceGrantV1[] => fixture.groups.map(group => ({
            principal: { kind: 'group', teamId: fixture.team.id, groupId: group.id }, level: 'view',
        }));
        const [oldTeam, newTeam, oldGroups, newGroups] = fixtures;
        const created = await inTx(tx => createProjectSourceInTx(tx, owner.id, { serverId: 'home', requestKey: randomUUID(), name: 'Before', repository,
            audience: [teamGrant(oldTeam.team.id), ...groupGrants(oldGroups)] }));
        expect(created.ok).toBe(true);
        if (!created.ok) throw new Error(created.error);
        const prior = new Map((await db.accountChange.findMany({ where: { entityId: PROJECT_SOURCES_ACCOUNT_CHANGE_ENTITY_ID_V1 } }))
            .map(row => [row.accountId, row.cursor]));
        const statements: Prisma.QueryEvent[] = [];
        const client = new PrismaClient({ log: [{ emit: 'event', level: 'query' }] });
        client.$on('query', event => statements.push(event));
        await client.$connect();
        const transaction = db.$transaction;
        // Instrument only the SQL transport; all audience decisions and publications remain real.
        db.$transaction = new Proxy(transaction, { apply(_target, _receiver, args) {
            return Reflect.apply(client.$transaction, client, args);
        } });
        try {
            const updated = await inTx(tx => updateProjectSourceInTx(tx, owner.id, { serverId: 'home', sourceId: created.source.id,
                expectedRevision: created.source.revision, patch: { name: 'After',
                    audience: [teamGrant(newTeam.team.id), ...groupGrants(newGroups), ...groupGrants(oldGroups)] } }));
            expect(updated).toMatchObject({ ok: true, source: { name: 'After', revision: created.source.revision + 1 } });
            const writeIndex = statements.findIndex(event => /^UPDATE\b/.test(event.query.trimStart()) && event.query.includes('"ProjectSource"'));
            // Recipient existence is the publisher's final read. Later admission
            // and terminal Account locking are separate contracts, outside this cost.
            const publicationIndex = statements.findIndex((event, index) => index > writeIndex
                && /^SELECT\b/.test(event.query.trimStart())
                && event.query.match(/\bFROM\s+"public"\."([^"]+)"/)?.[1] === 'Account');
            expect(writeIndex).toBeGreaterThanOrEqual(0);
            expect(publicationIndex).toBeGreaterThan(writeIndex);
            const reads = statements.slice(writeIndex + 1, publicationIndex).filter(event => /^SELECT\b/.test(event.query.trimStart())
                && /FROM\s+"public"\."Team(?:Group)?Membership"(?:\s|$)/.test(event.query)).length;
            const published = await db.accountChange.findMany({ where: { entityId: PROJECT_SOURCES_ACCOUNT_CHANGE_ENTITY_ID_V1 } });
            const advanced = published.filter(row => row.cursor > (prior.get(row.accountId) ?? 0)).map(row => row.accountId).sort();
            const expected = [owner.id, ...[oldTeam, newTeam].flatMap(fixture => fixture.accounts
                .filter((_, member) => member !== 2 && member !== 3).map(account => account.id)),
                ...[oldGroups, newGroups].flatMap(fixture => [fixture.accounts[0].id, fixture.accounts[1].id, fixture.accounts[99].id])].sort();
            expect(advanced).toEqual(expected);
            expect(await inTx(tx => readProjectSourceInTx(tx, newGroups.accounts[1].id, { serverId: 'home', sourceId: created.source.id })))
                .toMatchObject({ ok: true, source: { name: 'After' } });
            expect(await inTx(tx => readProjectSourceInTx(tx, oldTeam.accounts[0].id, { serverId: 'home', sourceId: created.source.id })))
                .toEqual({ ok: false, error: 'source_unavailable' });
            expect(await inTx(tx => readProjectSourceInTx(tx, newGroups.accounts[99].id, { serverId: 'home', sourceId: created.source.id })))
                .toMatchObject({ ok: true, canManage: true, source: { name: 'After' } });
            console.info('SOURCE_PUBLICATION_SQL', JSON.stringify({ members: 400, audienceGrants: 26, reads, recipients: advanced.length }));
            expect(reads).toBeLessThanOrEqual(3);
        } finally { db.$transaction = transaction; await client.$disconnect(); }
    });
});
