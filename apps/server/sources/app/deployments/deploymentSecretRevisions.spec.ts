import { afterEach, expect, it, vi } from 'vitest';
import * as privacyKit from 'privacy-kit';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol';
import { DEPLOYMENT_ENVIRONMENT_ARTIFACT_STORED_KIND_V1 } from '@happier-dev/protocol/artifacts/deploymentArtifactKindsV1';
import { createDbMocks, installDbModuleMock } from '@/app/api/testkit/dbMocks';
import type { Tx } from '@/storage/inTx';
import { initEncrypt } from '@/modules/encrypt';
import { encodeSensitiveContentForAtRestStorage } from '@/app/encryption/sensitiveContentAtRestStorage';
import { SavedSecretResourceStoredContentV1Schema } from '@happier-dev/protocol/account/settings/savedSecretResourceContentV1';

const mocks = createDbMocks({ account: ['findUnique'], projectSource: ['findUnique'], machine: ['findUnique'],
    deploymentEnvironment: ['findUnique', 'findMany'], deploymentTargetLink: ['findMany'], projectDeploymentDefaults: ['findMany'],
    deployment: ['findMany'], deploymentDomain: ['findMany'],
    artifact: ['findMany'], publicSessionShare: ['findMany'], savedSecretResource: ['findMany'] });
// Only Prisma persistence is replaced. Source/Artifact admission, Account
// mode and Saved Secret authorization/material parsing remain real.
installDbModuleMock({ db: mocks.db, isPrismaErrorCode: () => false });
const { readDeploymentEnvironmentInTx } = await import('./deploymentReadService');

afterEach(() => {
    vi.doUnmock('@/storage/db');
    vi.unstubAllEnvs();
    vi.resetModules();
});

it('projects current usable bound Secret revisions without acquiring values or exposing inaccessible resources', async () => {
    const serverId = `srv_${'e'.repeat(32)}`;
    vi.stubEnv('HAPPIER_SERVER_IDENTITY_ID', serverId);
    vi.stubEnv('HAPPIER_DB_PROVIDER', 'sqlite');
    vi.stubEnv('HANDY_MASTER_SECRET', 'deployment-secret-revision-test-master-secret');
    await initEncrypt();
    const account = { id: 'owner', status: 'active', encryptionMode: 'plain', publicKey: null,
        contentPublicKey: null, contentPublicKeySig: null, name: null, firstName: null, lastName: null,
        username: null, avatar: null };
    mocks.db.account.findUnique.mockResolvedValue(account);
    mocks.db.projectSource.findUnique.mockResolvedValue({ id: 'source', revision: 1, name: 'Project',
        owner: { kind: 'account', accountId: account.id }, createdByAccountId: account.id,
        repository: null, defaultRef: null, subdir: null, audience: [], attachments: [] });
    const captures = ['corrupt', 'foreign', 'ready'].map(resourceId => ({ resourceId, revision: 1 }));
    const now = new Date(1);
    mocks.db.deploymentEnvironment.findUnique.mockResolvedValue({ id: 'environment', projectSourceId: 'source',
        revision: 1, protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers', principals: [],
        controllerMachineId: 'machine', runtimeTargetLinkId: null, buildMachineId: null, edgeMachineId: null,
        contentArtifactId: 'artifact', contentHeaderVersion: 1, contentBodyVersion: 1,
        referencedSavedSecretRevisions: captures, pendingDeployContent: null, deletedAt: null,
        createdByAccountId: account.id, createdAt: now, updatedAt: now });
    mocks.db.deploymentTargetLink.findMany.mockResolvedValue([]);
    // Controller availability and Source content-reference reads find no rows.
    mocks.db.machine.findUnique.mockResolvedValue(null);
    for (const reader of [mocks.db.deploymentEnvironment, mocks.db.projectDeploymentDefaults,
        mocks.db.deployment, mocks.db.deploymentDomain]) reader.findMany.mockResolvedValue([]);
    mocks.db.publicSessionShare.findMany.mockResolvedValue([]);
    mocks.db.artifact.findMany.mockResolvedValue([{ id: 'artifact', accountId: account.id, account,
        kind: DEPLOYMENT_ENVIRONMENT_ARTIFACT_STORED_KIND_V1, signedInLink: null,
        grants: [], keyEnvelopes: [],
        dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER), provenanceDataEncryptionKey: null,
        header: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ title: 'Environment' })),
        headerVersion: 1, bodyVersion: 1, provenance: null, seq: 1, createdAt: now, updatedAt: now }]);
    const resource = (id: string, ownerAccountId: string) => ({ id, ownerAccountId, revision: 2,
        displayName: 'Credential', kind: 'token', encryptionMode: 'plain', owner: { ...account, id: ownerAccountId },
        accountGrants: [], teamGrants: [], groupGrants: [], keyEnvelopes: [],
        storedContent: encodeSensitiveContentForAtRestStorage({ contentMode: 'plain',
            keyPath: ['storage', 'saved_secret_resource', id, 'v1'], contentSchema: SavedSecretResourceStoredContentV1Schema,
            content: { t: 'plain', v: { v: 1, name: 'Credential', kind: 'token', value: 'private-test-material' } } }) });
    const rows = [resource('ready', account.id), resource('foreign', 'other'),
        { ...resource('corrupt', account.id), storedContent: 'corrupt-resource' }];
    mocks.db.savedSecretResource.findMany.mockResolvedValue(rows);
    // The cast represents the genuine Prisma boundary implemented by this fixture.
    const result = await readDeploymentEnvironmentInTx(mocks.db as unknown as Tx, account.id,
        { serverId, environmentId: 'environment' });
    expect(result.ok ? null : result).toBeNull();
    expect(result).toMatchObject({ ok: true, savedSecretRevisions: [{ resourceId: 'ready', revision: 2 }] });
    expect(JSON.stringify(result)).not.toContain('private-test-material');
    expect(mocks.db.savedSecretResource.findMany).toHaveBeenCalledTimes(1);
    expect(mocks.db.savedSecretResource.findMany.mock.calls[0]?.[0]).toMatchObject({
        where: { id: { in: captures.map(capture => capture.resourceId) } } });
});
