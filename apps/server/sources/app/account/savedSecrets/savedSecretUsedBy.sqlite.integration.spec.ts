import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent, encodePlainMachineStoredContent,
    MACHINE_PLAIN_DATA_KEY_MARKER, formatSharedSavedSecretRefV1, sealEncryptedDataKeyEnvelopeV1,
    sealSavedSecretResourceStoredContentV1, openSavedSecretResourceStoredContentV1, signAccountContentKeyBindingV1, verifyAccountContentKeyBindingV1 } from '@happier-dev/protocol';
import { DeploymentEnvironmentContentV1Schema } from '@happier-dev/deployment-protocol';
import { decodeBase64, encodeBase64 } from 'privacy-kit';
import tweetnacl from 'tweetnacl';
import { db } from '@/storage/db';
import { inReadSnapshot, inTx } from '@/storage/inTx';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { observeSqliteRequests } from '@/testkit/observeSqliteRequests';
import { createArtifact } from '@/app/artifacts/artifactWriteService';
import { createProjectSourceInTx, readProjectSourceInTx } from '@/app/projects/sources/projectSourceService';
import { createDeploymentEnvironmentInTx, setDeploymentEnvironmentBindingsInTx } from '@/app/deployments/deploymentEnvironmentService';
import { deleteDeploymentEnvironmentInTx } from '@/app/deployments/deploymentDispositionService';
import { makeShareEligibleForTest } from '@/testkit/shareEligibility.testkit';
import { createSavedSecretResourceInTx, listSavedSecretResourcesForAccountInTx,
    listSavedSecretResourceMaterialsForAccountInTx, updateSavedSecretResourceInTx, migrateSavedSecretResourcesForAccountModeInTx } from './savedSecretResourceService';

describe('Saved Secret Environment Used-by census', () => {
    const serverId = `srv_${'6'.repeat(32)}`;
    let harness: LightSqliteHarness;
    beforeAll(async () => { harness = await createLightSqliteHarness({ tempDirPrefix: 'saved-secret-used-by-', initEncrypt: true, initAuth: false,
        env: { HAPPIER_SERVER_IDENTITY_ID: serverId } }); }, 180_000);
    afterAll(async () => { await harness?.close(); });

    it('publishes value-free bound/unbound/unknown facts with one Environment sweep for the Account catalog', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const foreign = await db.account.create({ data: { encryptionMode: 'plain' } });
        const machine = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: foreign.id, metadata: '{}' } });
        const source = await db.projectSource.create({ data: { createdByAccountId: foreign.id,
            owner: { kind: 'account', accountId: foreign.id }, name: 'Private source sentinel', audience: [], attachments: [] } });
        const ids = Array.from({ length: 3 }, () => crypto.randomUUID());
        for (const resourceId of ids) {
            expect(await inTx(tx => createSavedSecretResourceInTx(tx, { accountId: owner.id, resourceId,
                displayName: 'Key', kind: 'token', encryptionMode: 'plain',
                storedContent: { t: 'plain', v: { v: 1, name: 'Key', kind: 'token', value: 'never-census-material' } } })))
                .toMatchObject({ ok: true });
        }
        const environment = async (captures: unknown, deleted = false) => {
            const artifact = await createArtifact({ actorUserId: foreign.id, artifactId: crypto.randomUUID(), kind: 'v1:other:deployment-environment.v1',
                header: decodeBase64(encodePlainArtifactStoredContent({ title: 'Private Environment sentinel' })),
                body: decodeBase64(encodePlainArtifactStoredContent({ body: '{}' })), dataEncryptionKey: decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) });
            if (!artifact.ok) throw new Error(artifact.error);
            return db.deploymentEnvironment.create({ data: { projectSourceId: source.id, createdByAccountId: foreign.id,
                protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers', controllerMachineId: machine.id,
                contentArtifactId: artifact.artifact.id, contentHeaderVersion: 1, contentBodyVersion: 1,
                ...(deleted ? { deletedAt: new Date() } : {}),
                // Real stored metadata boundary: legacy/malformed retained captures must remain unknown.
                referencedSavedSecretRevisions: JSON.parse(JSON.stringify(captures)),
            } });
        };
        const first = await environment(ids.slice(0, 2).map(resourceId => ({ resourceId, revision: 1 })));
        await environment([{ resourceId: ids[0], revision: 1 }]);
        await environment([{ resourceId: ids[2], revision: 1 }], true);
        let sweeps = 0, visited = 0, bindings = 0;
        const stop = observeSqliteRequests({ after(request, result) {
            if (request.model === 'DeploymentEnvironment' && request.action === 'findMany' && Array.isArray(result)) {
                sweeps++; visited += result.length;
                for (const row of result) if (row && typeof row === 'object' && 'referencedSavedSecretRevisions' in row
                    && Array.isArray(row.referencedSavedSecretRevisions)) bindings += row.referencedSavedSecretRevisions.length;
            }
        } });
        let entries: Awaited<ReturnType<typeof listSavedSecretResourcesForAccountInTx>>;
        try { entries = await inReadSnapshot(tx => listSavedSecretResourcesForAccountInTx(tx, owner.id)); }
        finally { stop(); }
        expect(entries.map(entry => 'deploymentReferenceState' in entry ? entry.deploymentReferenceState : undefined).sort())
            .toEqual(['referenced', 'referenced', 'unreferenced']);
        expect(entries).toHaveLength(3);
        expect({ sweeps, visited, bindings }).toEqual({ sweeps: 1, visited: 2, bindings: 3 });
        expect(JSON.stringify(entries)).not.toMatch(/Private source sentinel|Private Environment sentinel|never-census-material/);
        expect(JSON.stringify(entries)).not.toContain(first.id);
        const malformed = await environment([{ resourceId: ids[2], revision: 'unreadable' }]);
        const unknown = await inReadSnapshot(tx => listSavedSecretResourceMaterialsForAccountInTx(tx, owner.id, undefined, undefined, true));
        expect(unknown.find(row => 'resourceId' in row && row.resourceId === ids[2])?.entry)
            .toMatchObject({ deploymentReferenceState: 'unavailable' });
        expect(unknown.find(row => 'resourceId' in row && row.resourceId === ids[0])?.entry)
            .toMatchObject({ deploymentReferenceState: 'referenced' });
        expect(await inReadSnapshot(tx => listSavedSecretResourcesForAccountInTx(tx, foreign.id))).toEqual([]);
        await db.deploymentEnvironment.update({ where: { id: malformed.id }, data: { deletedAt: new Date() } });
    });


    it.each([
        { purpose: 'backupDestination', role: 'repositoryPassword', blocked: true, migration: false },
        { purpose: 'backupDestination', role: 'repositoryPassword', blocked: false, migration: true },
        { purpose: 'backupDestination', role: 'repositoryPassword', blocked: false, migration: 'roundTrip' },
        { purpose: 'backupDestination', role: undefined, blocked: true, migration: false },
        { purpose: undefined, role: undefined, blocked: true, migration: false },
        { purpose: 'backupDestination', role: 'accessKeyId', blocked: false, migration: false },
        { purpose: 'domainCredential', role: undefined, blocked: false, migration: false },
        { purpose: 'dataRole', role: undefined, blocked: false, migration: false },
    ])('protects backup repository material before replacing a Secret ($purpose:$role, migration=$migration)', async ({ purpose, role, blocked, migration }) => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const foreign = await db.account.create({ data: { encryptionMode: 'plain' } });
        const resourceId = crypto.randomUUID();
        expect(await inTx(tx => createSavedSecretResourceInTx(tx, { accountId: owner.id, resourceId,
            displayName: 'Repository credential', kind: 'token', encryptionMode: 'plain',
            storedContent: { t: 'plain', v: { v: 1, name: 'Repository credential', kind: 'token', value: 'fixture-old' } } })))
            .toMatchObject({ ok: true });
        const environments = [];
        for (const accountId of [owner.id, foreign.id]) {
            const machine = await db.machine.create({ data: { id: crypto.randomUUID(), accountId, metadata: '{}' } });
            const source = await db.projectSource.create({ data: { createdByAccountId: accountId,
                owner: { kind: 'account', accountId }, name: 'Private source', audience: [], attachments: [] } });
            const artifact = await createArtifact({ actorUserId: accountId, artifactId: crypto.randomUUID(), kind: 'v1:other:deployment-environment.v1',
                header: decodeBase64(encodePlainArtifactStoredContent({ title: 'Private backup' })),
                body: decodeBase64(encodePlainArtifactStoredContent({ body: '{}' })), dataEncryptionKey: decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) });
            if (!artifact.ok) throw new Error(artifact.error);
            environments.push(await db.deploymentEnvironment.create({ data: { projectSourceId: source.id, createdByAccountId: accountId,
                protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers', controllerMachineId: machine.id,
                contentArtifactId: artifact.artifact.id, contentHeaderVersion: 1, contentBodyVersion: 1,
                referencedSavedSecretRevisions: [{ resourceId, revision: 1,
                    ...(purpose ? { requiredBindings: [{ purpose, ...(role ? { role } : {}) }] } : {}) }],
            } }));
        }
        for (const environment of environments) await db.machineSecretGrant.create({ data: {
            subjectKey: crypto.randomUUID(), kind: 'secret', machineId: environment.controllerMachineId!,
            installationId: 'fixture-installation', environmentId: environment.id, resourceId, resourceRevision: 1,
            contentEnvelope: 'fixture-sealed',
        } });
        if (migration) {
            const signing = tweetnacl.sign.keyPair(), content = tweetnacl.box.keyPair();
            const signature = signAccountContentKeyBindingV1({ accountSigningSecretKey: signing.secretKey, contentPublicKey: content.publicKey });
            const binding = verifyAccountContentKeyBindingV1({ accountSigningPublicKey: signing.publicKey,
                contentPublicKey: content.publicKey, signature });
            if (!binding) throw new Error('Expected verified target Account key');
            const dataKey = new Uint8Array(32).fill(7);
            const storedContent = sealSavedSecretResourceStoredContentV1({ resourceId, mode: 'e2ee', resourceDataKey: dataKey,
                content: { v: 1, name: 'Repository credential', kind: 'token', value: 'fixture-old' }, randomBytes: tweetnacl.randomBytes });
            const result = await inTx(tx => migrateSavedSecretResourcesForAccountModeInTx(tx, { accountId: owner.id,
                fromMode: 'plain', toMode: 'e2ee', ownerContentPublicKeyFingerprint: binding.contentPublicKeyFingerprint,
                directive: { items: [{ resourceId, expectedRevision: 1, storedContent, ownerKeyEnvelope: {
                    recipientAccountId: owner.id, recipientContentPublicKeyFingerprint: binding.contentPublicKeyFingerprint,
                    encryptedDataKey: encodeBase64(sealEncryptedDataKeyEnvelopeV1({ dataKey, recipientPublicKey: content.publicKey,
                        randomBytes: tweetnacl.randomBytes })),
                } }] } }));
            expect(result).toEqual({ status: 'applied' });
            expect(await db.savedSecretResource.findUnique({ where: { id: resourceId }, select: { revision: true, encryptionMode: true } }))
                .toEqual({ revision: 2, encryptionMode: 'e2ee' });
            expect(openSavedSecretResourceStoredContentV1({ resourceId, mode: 'e2ee', storedContent, resourceDataKey: dataKey }))
                .toMatchObject({ value: 'fixture-old' });
            if (migration === 'roundTrip') {
                await db.account.update({ where: { id: owner.id }, data: { encryptionMode: 'e2ee' } });
                for (const environment of environments) await db.deploymentEnvironment.update({ where: { id: environment.id },
                    data: { referencedSavedSecretRevisions: [{ resourceId, revision: 2,
                        requiredBindings: [{ purpose: 'backupDestination', role: 'repositoryPassword' }] }] } });
                expect(await inTx(tx => migrateSavedSecretResourcesForAccountModeInTx(tx, { accountId: owner.id,
                    fromMode: 'e2ee', toMode: 'plain', ownerContentPublicKeyFingerprint: null,
                    directive: { items: [{ resourceId, expectedRevision: 2,
                        storedContent: { t: 'plain', v: { v: 1, name: 'Repository credential', kind: 'token', value: 'fixture-old' } } }] } })))
                    .toEqual({ status: 'applied' });
                expect(await db.savedSecretResource.findUnique({ where: { id: resourceId }, select: { revision: true, encryptionMode: true } }))
                    .toEqual({ revision: 3, encryptionMode: 'plain' });
            }
            return;
        }
        const replace = () => inTx(tx => updateSavedSecretResourceInTx(tx, { accountId: owner.id, resourceId, expectedRevision: 1,
            displayName: 'Repository credential', kind: 'token',
            storedContent: { t: 'plain', v: { v: 1, name: 'Repository credential', kind: 'token', value: 'fixture-new' } } }));
        let environmentSweeps = 0;
        const stop = observeSqliteRequests({ after(request) {
            if (request.model === 'DeploymentEnvironment' && request.action === 'findMany') environmentSweeps++;
        } });
        let result: Awaited<ReturnType<typeof replace>>;
        try { result = await replace(); } finally { stop(); }
        expect(environmentSweeps).toBe(1);
        if (blocked) {
            expect(result).toEqual({ ok: false, error: 'backup_rekey_required',
                backups: [{ environmentId: environments[0]!.id, role: role ?? 'unknown' }], hasOtherBackups: true });
            expect(JSON.stringify(result)).not.toContain(environments[1]!.id);
            expect(JSON.stringify(result)).not.toMatch(/Private source|Private backup|fixture-old|fixture-new/);
            expect(await db.savedSecretResource.findUnique({ where: { id: resourceId }, select: { revision: true } })).toEqual({ revision: 1 });
            expect(await db.machineSecretGrant.count({ where: { resourceId } })).toBe(2);
            // Refreshing/re-keying the bindings removes the pin; the same replacement can then proceed.
            for (const environment of environments) await db.deploymentEnvironment.update({ where: { id: environment.id },
                data: { referencedSavedSecretRevisions: [{ resourceId: 'unrelated-resource', revision: 1 }] } });
            expect(await replace()).toMatchObject({ ok: true, value: { revision: 2 } });
            expect(await db.machineSecretGrant.count({ where: { resourceId } })).toBe(0);
        } else expect(result).toMatchObject({ ok: true, value: { revision: 2 } });
    });

    it('pushes bind, unbind and delete usage changes to a Secret owner outside the private Environment audience', async () => {
        const secretOwner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const environmentOwner = await db.account.create({ data: { encryptionMode: 'plain' } });
        await makeShareEligibleForTest(secretOwner.id, environmentOwner.id);
        const resourceId = crypto.randomUUID();
        expect(await inTx(tx => createSavedSecretResourceInTx(tx, { accountId: secretOwner.id, resourceId,
            displayName: 'Deploy key', kind: 'token', encryptionMode: 'plain', accountGrants: [environmentOwner.id],
            storedContent: { t: 'plain', v: { v: 1, name: 'Deploy key', kind: 'token', value: 'never-published' } } })))
            .toMatchObject({ ok: true });
        const source = await inTx(tx => createProjectSourceInTx(tx, environmentOwner.id,
            { serverId, requestKey: crypto.randomUUID(), name: 'Private source', audience: [] }));
        if (!source.ok) throw new Error(source.error);
        expect(await inReadSnapshot(tx => readProjectSourceInTx(tx, secretOwner.id, { serverId, sourceId: source.source.id })))
            .toMatchObject({ ok: false });
        const machine = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: environmentOwner.id,
            installationId: crypto.randomUUID(), dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER),
            metadata: encodePlainMachineStoredContent({ host: 'Census', platform: 'linux', happyCliVersion: 'test',
                homeDir: '/home/test', happyHomeDir: '/home/test/.happier' }) } });
        const stored = async (bound: boolean) => {
            const content = DeploymentEnvironmentContentV1Schema.parse({ name: 'Private Environment', retainPreviousDeployments: 1,
                definition: { kind: 'repository', ref: 'main' }, bindings: bound ? [{ purpose: 'variable', phase: 'runtime', name: 'TOKEN',
                    source: { kind: 'secret', ref: formatSharedSavedSecretRefV1(resourceId), resourceRevision: 1 } }] : [] });
            const artifact = await createArtifact({ actorUserId: environmentOwner.id, artifactId: crypto.randomUUID(),
                kind: 'v1:other:deployment-environment.v1',
                header: decodeBase64(encodePlainArtifactStoredContent({ kind: 'deployment-environment.v1', title: content.name })),
                body: decodeBase64(encodePlainArtifactStoredContent({ body: JSON.stringify(content) })),
                dataEncryptionKey: decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) });
            if (!artifact.ok) throw new Error(artifact.error);
            return { contentArtifactId: artifact.artifact.id, contentHeaderVersion: 1, contentBodyVersion: 1 };
        };
        const initialContent = await stored(false);
        const created = await inTx(tx => createDeploymentEnvironmentInTx(tx, environmentOwner.id, { serverId,
            projectSourceId: source.source.id, requestKey: crypto.randomUUID(), protection: 'nonProduction', purpose: 'standard',
            deployerMode: 'managers', controllerMachineId: machine.id, ...initialContent }));
        if (!created.ok) throw new Error(created.error);
        let revision = created.revision;
        const usageCursor = async () => (await db.accountChange.findFirst({ where: { accountId: secretOwner.id,
            kind: 'savedSecretResource', entityId: resourceId }, orderBy: { cursor: 'desc' } }))!.cursor;
        const assertUsageChanged = async (previousCursor: number) => {
            const change = await db.accountChange.findFirst({ where: { accountId: secretOwner.id,
                kind: 'savedSecretResource', entityId: resourceId }, orderBy: { cursor: 'desc' } });
            expect(change?.cursor).toBeGreaterThan(previousCursor);
            expect(JSON.stringify(change)).not.toMatch(/Private source|Private Environment|never-published/);
            expect(JSON.stringify(change)).not.toContain(created.environmentId);
        };
        for (const bound of [true, false, true]) {
            const previousCursor = await usageCursor();
            const content = await stored(bound);
            const changed = await inTx(tx => setDeploymentEnvironmentBindingsInTx(tx, environmentOwner.id, {
                serverId, environmentId: created.environmentId, expectedRevision: revision, ...content, grants: [],
                referencedSavedSecretRevisions: bound ? [{ resourceId, revision: 1 }] : [],
            }));
            expect(changed).toMatchObject({ ok: true });
            if (!changed.ok) throw new Error(changed.error);
            revision = changed.revision;
            expect(await db.deploymentEnvironment.findUnique({ where: { id: created.environmentId },
                select: { referencedSavedSecretRevisions: true } })).toMatchObject({
                referencedSavedSecretRevisions: bound ? [{ resourceId, revision: 1 }] : [],
            });
            await assertUsageChanged(previousCursor);
            const rows = await inReadSnapshot(tx => listSavedSecretResourcesForAccountInTx(tx, secretOwner.id));
            expect(rows).toMatchObject([{ deploymentReferenceState: bound ? 'referenced' : 'unreferenced' }]);
        }
        const previousCursor = await usageCursor();
        expect(await inTx(tx => deleteDeploymentEnvironmentInTx(tx, environmentOwner.id, { serverId,
            environmentId: created.environmentId, expectedRevision: revision, requestKey: crypto.randomUUID() })))
            .toMatchObject({ ok: true });
        await assertUsageChanged(previousCursor);
        expect(await inReadSnapshot(tx => listSavedSecretResourcesForAccountInTx(tx, secretOwner.id)))
            .toMatchObject([{ deploymentReferenceState: 'unreferenced' }]);
    });
});
