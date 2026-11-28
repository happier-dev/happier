import { afterAll, beforeAll, expect, it } from 'vitest';
import { decodeBase64 } from 'privacy-kit';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol';
import { SavedSecretResourceStoredContentV1Schema } from '@happier-dev/protocol/account/settings/savedSecretResourceContentV1';
import { DEPLOYMENT_ENVIRONMENT_ARTIFACT_STORED_KIND_V1 } from '@happier-dev/protocol/artifacts/deploymentArtifactKindsV1';
import { MACHINE_PLAIN_DATA_KEY_MARKER, encodePlainMachineStoredContent } from '@happier-dev/protocol/machines/machineStoredContent';
import { encodeSensitiveContentForAtRestStorage } from '@/app/encryption/sensitiveContentAtRestStorage';
import { createProjectSourceInTx } from '@/app/projects/sources/projectSourceService';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { observeSqliteRequests } from '@/testkit/observeSqliteRequests';
import { readDeploymentEnvironmentInTx } from './deploymentReadService';

const serverId = `srv_${'e'.repeat(32)}`;
let harness: LightSqliteHarness;
beforeAll(async () => {
    harness = await createLightSqliteHarness({
        tempDirPrefix: 'happier-deployment-secret-revisions-',
        initEncrypt: true,
        env: { HAPPIER_SERVER_IDENTITY_ID: serverId },
    });
}, 180_000);
afterAll(async () => { await harness?.close(); });

it('projects current usable bound Secret revisions without reading unrelated Secrets or exposing private material', async () => {
    const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
    const other = await db.account.create({ data: { encryptionMode: 'plain' } });
    const source = await inTx(tx => createProjectSourceInTx(tx, owner.id, {
        serverId, requestKey: crypto.randomUUID(), name: 'Project', audience: [],
    }));
    if (!source.ok) throw new Error(source.error);
    const machine = await db.machine.create({ data: {
        id: crypto.randomUUID(), accountId: owner.id,
        metadata: encodePlainMachineStoredContent({ host: 'Controller', platform: 'linux',
            happyCliVersion: 'test', homeDir: '/tmp', happyHomeDir: '/tmp/happier' }),
        dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER),
    } });
    const artifact = await db.artifact.create({ data: {
        id: crypto.randomUUID(), accountId: owner.id, kind: DEPLOYMENT_ENVIRONMENT_ARTIFACT_STORED_KIND_V1,
        headerVersion: 1, bodyVersion: 1,
        header: decodeBase64(encodePlainArtifactStoredContent({ title: 'Environment' })),
        body: decodeBase64(encodePlainArtifactStoredContent({})),
        dataEncryptionKey: decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER),
    } });
    const environment = await db.deploymentEnvironment.create({ data: {
        projectSourceId: source.source.id, createdByAccountId: owner.id, controllerMachineId: machine.id,
        protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers',
        contentArtifactId: artifact.id, contentHeaderVersion: 1, contentBodyVersion: 1,
        referencedSavedSecretRevisions: ['corrupt', 'foreign', 'ready'].map(resourceId => ({ resourceId, revision: 1 })),
    } });

    const secretValue = 'private-test-material';
    const resource = (id: string, ownerAccountId: string) => ({
        id, ownerAccountId, revision: 2, displayName: 'Credential', kind: 'token', encryptionMode: 'plain',
        storedContent: encodeSensitiveContentForAtRestStorage({
            contentMode: 'plain', keyPath: ['storage', 'saved_secret_resource', id, 'v1'],
            contentSchema: SavedSecretResourceStoredContentV1Schema,
            content: { t: 'plain', v: { v: 1, name: 'Credential', kind: 'token', value: secretValue } },
        }),
    });
    await db.savedSecretResource.createMany({ data: [
        resource('ready', owner.id), resource('foreign', other.id), resource('unbound', owner.id),
        { ...resource('corrupt', owner.id), storedContent: 'corrupt-resource' },
    ] });

    const secretReads: unknown[] = [];
    const stop = observeSqliteRequests({ after: (request, rows) => {
        if (request.model === 'SavedSecretResource' && request.action === 'findMany') secretReads.push(rows);
    } });
    try {
        const result = await inTx(tx => readDeploymentEnvironmentInTx(tx, owner.id, { serverId, environmentId: environment.id }));
        expect(result).toMatchObject({ ok: true, savedSecretRevisions: [{ resourceId: 'ready', revision: 2 }] });
        expect(JSON.stringify(result)).not.toContain(secretValue);
        expect(secretReads).toHaveLength(1);
        expect(secretReads[0]).not.toContainEqual(expect.objectContaining({ id: 'unbound' }));
    } finally {
        stop();
    }
});
