import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import tweetnacl from 'tweetnacl';
import * as privacyKit from 'privacy-kit';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, computeContentPublicKeyFingerprint, encodePlainArtifactStoredContent,
    openEncryptedDataKeyEnvelopeV1, openSessionDataKeyBundleV0, sealEncryptedDataKeyEnvelopeV1, sealSessionDataKeyBundleV0 } from '@happier-dev/protocol';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { createSignedAccountContentBinding } from '@/testkit/accountEncryption';
import { readArtifactForCallerInTx } from '@/app/artifacts/artifactAccessService';
import { createProjectSourceInTx } from './sources/projectSourceService';
import { readProjectDeploymentDefaultsInTx, setProjectDeploymentDefaultsInTx } from './projectDeploymentDefaultsService';

/** The same persisted Source/Artifact/defaults boundary runs on each real provider. */
export async function exerciseProjectDefaultsStorage(mode: 'plain' | 'e2ee', serverId: string) {
    const keys = [tweetnacl.box.keyPair(), tweetnacl.box.keyPair()];
    const [owner, member] = await Promise.all(keys.map(key => db.account.create({ data: { encryptionMode: mode,
        ...(mode === 'e2ee' ? createSignedAccountContentBinding(key.publicKey) : {}) } })));
    const outsider = await db.account.create({ data: { encryptionMode: 'plain' } });
    const team = await db.team.create({ data: { name: 'Defaults Team' } });
    await db.teamMembership.create({ data: { teamId: team.id, accountId: owner.id, role: 'owner' } });
    const membership = await db.teamMembership.create({ data: { teamId: team.id, accountId: member.id, role: 'member' } });
    const source = await inTx(tx => createProjectSourceInTx(tx, owner.id, { serverId, requestKey: randomUUID(), name: 'Shared defaults',
        owner: { kind: 'team', teamId: team.id },
        repository: { provider: { id: 'github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' },
            repository: { nameWithOwner: 'acme/defaults', cloneUrl: 'https://github.com/acme/defaults.git' }, protocol: 'https' } }));
    if (!source.ok) throw new Error(source.error);
    const payload = { projectSourceId: source.source.id, deploymentDefaults: { retainPreviousDeployments: 0 } };
    const key = tweetnacl.randomBytes(32);
    const seal = async (value: unknown) => mode === 'plain'
        ? privacyKit.decodeBase64(encodePlainArtifactStoredContent(value)) : new Uint8Array(await sealSessionDataKeyBundleV0(value, key));
    const wrap = (publicKey: Uint8Array) => new Uint8Array(sealEncryptedDataKeyEnvelopeV1({ dataKey: key,
        recipientPublicKey: publicKey, randomBytes: tweetnacl.randomBytes }));
    const artifact = await db.artifact.create({ data: { id: randomUUID(), accountId: owner.id,
        kind: 'v1:other:project-deployment-defaults.v1', headerVersion: 1, bodyVersion: 1,
        header: await seal({ kind: 'project-deployment-defaults.v1', title: 'Private defaults' }),
        body: await seal({ body: JSON.stringify(payload) }),
        dataEncryptionKey: mode === 'plain' ? privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) : wrap(keys[0].publicKey) } });
    await db.artifactGrant.create({ data: { principalKind: 'team', artifactId: artifact.id, teamId: team.id, accessLevel: 'view', createdByAccountId: owner.id } });
    if (mode === 'e2ee') await db.artifactKeyEnvelope.create({ data: { artifactId: artifact.id, recipientAccountId: member.id,
        encryptedDataKey: wrap(keys[1].publicKey), recipientContentPublicKeyFingerprint: computeContentPublicKeyFingerprint(keys[1].publicKey) } });
    const input = { serverId, projectSourceId: source.source.id, expectedSourceRevision: source.source.revision, expectedRevision: 0,
        content: { contentArtifactId: artifact.id, contentHeaderVersion: 1, contentBodyVersion: 1 } };
    const set = (actorAccountId: string, value = input) => inTx(tx => setProjectDeploymentDefaultsInTx(tx, actorAccountId, value), { isolationLevel: 'Serializable' });
    const read = (actorAccountId: string) => inTx(tx => readProjectDeploymentDefaultsInTx(tx, actorAccountId, input));
    const saved = await set(owner.id);
    expect(saved).toMatchObject({ ok: true, revision: 1, content: input.content });
    expect(await read(member.id)).toEqual(saved);
    expect(await read(outsider.id)).toEqual({ ok: false, error: 'project_defaults_unavailable' });
    expect(await set(member.id, { ...input, expectedRevision: 1 })).toEqual({ ok: false, error: 'project_defaults_access_denied' });
    expect(await set(owner.id)).toEqual({ ok: false, error: 'project_defaults_conflict' });
    const opened = await inTx(tx => readArtifactForCallerInTx(tx, { actorAccountId: member.id, artifactId: artifact.id }));
    expect(opened.ok).toBe(true);
    if (!opened.ok) throw new Error(opened.error);
    if (mode === 'e2ee') {
        const memberKey = openEncryptedDataKeyEnvelopeV1({ envelope: opened.artifact.dataEncryptionKey, recipientSecretKeyOrSeed: keys[1].secretKey });
        expect(memberKey).toEqual(key);
        expect(await openSessionDataKeyBundleV0(opened.artifact.body, memberKey!)).toEqual({ status: 'authenticated', value: { body: JSON.stringify(payload) } });
        await db.artifactKeyEnvelope.deleteMany({ where: { artifactId: artifact.id, recipientAccountId: member.id } });
        expect(await read(member.id)).toEqual({ ok: false, error: 'project_defaults_content_unavailable' });
    }
    const before = await db.accountChange.findMany({ where: { entityId: `projects:${source.source.id}:deploymentDefaults` }, orderBy: { accountId: 'asc' } });
    expect(before.map(row => row.accountId).sort()).toEqual([owner.id, member.id].sort());
    expect(await set(owner.id, { ...input, expectedRevision: 1 })).toEqual(saved);
    expect((await db.accountChange.findMany({ where: { entityId: `projects:${source.source.id}:deploymentDefaults` }, orderBy: { accountId: 'asc' } })).map(row => row.cursor)).toEqual(before.map(row => row.cursor));
    await db.teamMembership.update({ where: { id: membership.id }, data: { status: 'suspended' } });
    expect(await read(member.id)).toEqual({ ok: false, error: 'project_defaults_unavailable' });
    await db.account.update({ where: { id: owner.id }, data: { encryptionMode: mode === 'plain' ? 'e2ee' : 'plain' } });
    expect(await read(owner.id)).toEqual({ ok: false, error: 'project_defaults_content_unavailable' });
    await expect(db.projectDeploymentDefaults.create({ data: { projectSourceId: randomUUID(), contentArtifactId: artifact.id,
        contentHeaderVersion: 1, contentBodyVersion: 1 } })).rejects.toThrow();
    await expect(db.projectDeploymentDefaults.update({ where: { projectSourceId: source.source.id },
        data: { contentHeaderVersion: null } })).rejects.toThrow();
    await expect(db.artifact.delete({ where: { id: artifact.id } })).rejects.toThrow();
    // MySQL cannot CHECK a foreign-key column with referential actions. The
    // owning reader/writer must still reject an incomplete retained address.
    await db.projectDeploymentDefaults.update({ where: { projectSourceId: source.source.id }, data: { contentArtifactId: null } });
    expect(await read(owner.id)).toEqual({ ok: false, error: 'project_defaults_content_unavailable' });
    expect(await inTx(tx => setProjectDeploymentDefaultsInTx(tx, owner.id, { ...input, expectedRevision: 1, content: null }),
        { isolationLevel: 'Serializable' })).toEqual({ ok: false, error: 'project_defaults_content_unavailable' });
}
