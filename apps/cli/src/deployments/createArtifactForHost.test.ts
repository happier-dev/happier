import axios from 'axios';
import { randomBytes } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519';
import { afterEach, expect, it, vi } from 'vitest';
import { ArtifactHttpReadV1Schema, ArtifactRecipientKeyEnvelopeCommitInputV1Schema,
    type ArtifactAccessGrantRowV1, type ArtifactHttpReadV1, type ArtifactRecipientKeyEnvelopeInputV1 } from '@happier-dev/protocol/artifacts/artifactAccessV1';
import { signAccountContentKeyBindingV1 } from '@happier-dev/protocol/crypto/accountContentKeyBindingV1';
import { ArtifactJsonUpdateHttpInputV1Schema } from '@happier-dev/protocol';
import { computeContentPublicKeyFingerprint } from '@happier-dev/protocol/machines/identity/contentPublicKeyFingerprint';
import { createAccountArtifactStore } from '@/api/artifacts/accountArtifactStore';
import { encodeBase64, libsodiumPublicKeyFromSecretKey } from '@/api/encryption';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { createDeploymentArtifactForHost } from './createArtifactForHost';

afterEach(() => vi.restoreAllMocks());

it('publishes an issued Link Artifact with create idempotency without replacing an existing head', async () => {
    const artifactId = '238a6c63-d34f-87f9-bb73-84d87f17edbd';
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.signature`;
    const artifacts = createAccountArtifactStore({ credentials: { token, encryption: null }, getAccountEncryptionMode: async () => 'plain' });
    const operations: string[] = [];
    // Storage is the boundary: a retained Link's content must never be rewritten.
    vi.spyOn(axios, 'get').mockImplementation(async url => {
        operations.push(`GET ${new URL(String(url)).pathname}`);
        return { status: 200, data: { id: artifactId, ownerAccountId: 'owner', access: 'owner', publicAudience: 'none', encryptionMode: 'plain',
            header: encodePlainArtifactStoredContent({ kind: 'deployment-target-link.v1', title: '' }),
            body: encodePlainArtifactStoredContent({ body: '{}' }), headerVersion: 4, bodyVersion: 7,
            seq: 1, createdAt: 1, updatedAt: 1, dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER } };
    });
    vi.spyOn(axios, 'post').mockImplementation(async url => {
        operations.push(`POST ${new URL(String(url)).pathname}`);
        return { status: 200, data: { id: artifactId, headerVersion: 4, bodyVersion: 7,
            success: true } };
    });
    const result = await runWithServerHttpBaseUrl('https://link.test', () => createDeploymentArtifactForHost({
        artifacts, owner: { kind: 'account', accountId: 'owner' }, assertCurrent: async () => {}, publication: 'create',
        content: { artifactId, header: { kind: 'deployment-target-link.v1', title: '' }, body: '{}' },
    }));
    expect(result).toEqual({ artifactId, revision: { headerVersion: 4, bodyVersion: 7 } });
    expect(operations).toEqual(['POST /v1/artifacts']);
});

it('refreshes the issued pre-receipt candidate using its current head instead of recreating version one', async () => {
    const artifactId = '238a6c63-d34f-87f9-bb73-84d87f17edbd';
    const header = { kind: 'deployment.v1', title: 'Candidate' };
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.signature`;
    const artifacts = createAccountArtifactStore({ credentials: { token, encryption: null }, getAccountEncryptionMode: async () => 'plain' });
    const writes: string[] = [];
    // HTTP storage is the system boundary; candidate publication and the full
    // Artifact codec/CAS writer remain real.
    vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: {
        id: artifactId, ownerAccountId: 'owner', access: 'owner', publicAudience: 'none', encryptionMode: 'plain',
        header: encodePlainArtifactStoredContent(header), body: encodePlainArtifactStoredContent({ body: '{}' }),
        headerVersion: 4, bodyVersion: 7, seq: 1, createdAt: 1, updatedAt: 1,
        dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
    } });
    vi.spyOn(axios, 'post').mockImplementation(async (url, raw) => {
        const path = new URL(String(url)).pathname;
        writes.push(path);
        if (path === '/v1/artifacts') return { status: 200, data: { id: artifactId, headerVersion: 1, bodyVersion: 1 } };
        expect(raw).toMatchObject({ expectedHeaderVersion: 4, expectedBodyVersion: 7 });
        return { status: 200, data: { success: true, headerVersion: 5, bodyVersion: 8 } };
    });
    const result = await runWithServerHttpBaseUrl('https://candidate.test', () => createDeploymentArtifactForHost({
        artifacts, owner: { kind: 'account', accountId: 'owner' }, assertCurrent: async () => {},
        content: { artifactId, header, body: '{"prepared":true}' },
    }));
    expect(result).toEqual({ artifactId, revision: { headerVersion: 5, bodyVersion: 8 } });
    expect(writes).toEqual([`/v1/artifacts/${artifactId}`]);
});

it.each([{ creator: 'alice', retained: false }, { creator: 'bob', retained: false }, { creator: 'bob', retained: true }])('publishes an E2EE receipt for the server-admitted audience without reading the Environment grants ($creator, retained=$retained)', async ({ creator, retained }) => {
    const environmentId = '11111111-1111-4111-8111-111111111111';
    const receiptId = '22222222-2222-4222-8222-222222222222';
    const token = (accountId: string) => `e30.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`;
    const accounts = new Map(['alice', 'bob', 'carol', 'outsider'].map(accountId => {
        const secret = new Uint8Array(randomBytes(32));
        const publicKey = libsodiumPublicKeyFromSecretKey(secret);
        const signingSeed = new Uint8Array(randomBytes(32));
        const signingPublicKey = ed25519.getPublicKey(signingSeed);
        return [accountId, { store: createAccountArtifactStore({ credentials: { token: token(accountId), encryption: {
            type: 'dataKey', machineKey: secret, publicKey,
        } }, getAccountEncryptionMode: async () => 'e2ee' }), publicKey, signingPublicKey,
        signature: signAccountContentKeyBindingV1({ accountSigningSecretKey: new Uint8Array([...signingSeed, ...signingPublicKey]),
            contentPublicKey: publicKey }) }] as const;
    }));
    const grant = (principal: ArtifactAccessGrantRowV1['principal'], accessLevel: ArtifactAccessGrantRowV1['accessLevel']): ArtifactAccessGrantRowV1 => ({
        principal, accessLevel, createdByAccountId: 'alice', createdAt: 1, display: { name: null },
    });
    const environmentGrants = [grant({ kind: 'team', teamId: 'team' }, 'view'),
        grant({ kind: 'account', accountId: 'bob' }, 'edit'), grant({ kind: 'account', accountId: 'carol' }, 'admin')];
    const receiptGrants: ArtifactAccessGrantRowV1[] = [];
    const envelopes = new Map<string, ArtifactRecipientKeyEnvelopeInputV1>();
    let receipt: ArtifactHttpReadV1 | undefined;
    const accountFrom = (config?: { headers?: unknown }) => {
        const headers = config?.headers;
        const authorization = headers && typeof headers === 'object' ? Reflect.get(headers, 'Authorization') : undefined;
        return [...accounts.keys()].find(accountId => authorization === `Bearer ${token(accountId)}`) ?? 'outsider';
    };
    const accessFor = (accountId: string) => accountId === creator ? 'owner' as const
        : receiptGrants.some(row => row.principal.kind === 'account' ? row.principal.accountId === accountId
            : row.principal.teamId === 'team' && ['alice', 'bob'].includes(accountId)) ? 'view' as const : null;
    const roster = (artifactId: string, accountId: string) => ({ artifactId,
        ownerAccountId: artifactId === environmentId ? 'alice' : creator,
        access: artifactId === environmentId ? accountId === 'alice' ? 'owner' : 'view' : accessFor(accountId),
        grants: artifactId === environmentId ? environmentGrants : receiptGrants });
    // Authenticated HTTP storage is the only mocked boundary. The real Artifact
    // writer, grant preparation, signed recipient bindings and E2EE readers run.
    vi.spyOn(axios, 'get').mockImplementation(async (rawUrl, config) => {
        const path = new URL(String(rawUrl)).pathname;
        const accountId = accountFrom(config);
        if (path === `/v1/artifacts/${environmentId}/access/grants`) return { status: 401, data: { error: 'artifact_access_forbidden' } };
        if (!receipt || !accessFor(accountId)) return { status: 404, data: { error: 'artifact_not_found' } };
        if (path.endsWith('/grants')) return { status: 200, data: roster(receiptId, accountId) };
        const callerDataEncryptionKey = accountId === creator ? receipt.dataEncryptionKey : envelopes.get(accountId)?.encryptedDataKey ?? null;
        if (path.endsWith('/recipients')) return { status: 200, data: {
            artifactId: receiptId, ownerAccountId: creator, access: accessFor(accountId), encryptionMode: 'e2ee',
            dataEncryptionKey: receipt.dataEncryptionKey, callerDataEncryptionKey,
            recipients: [...accounts].filter(([id]) => id !== creator && accessFor(id)).map(([id, account]) => ({
                recipientAccountId: id, contentPublicKeyFingerprint: computeContentPublicKeyFingerprint(account.publicKey),
                contentKey: { status: 'available', accountSigningPublicKey: Buffer.from(account.signingPublicKey).toString('hex'),
                    contentPublicKey: encodeBase64(account.publicKey), contentPublicKeySignature: encodeBase64(account.signature) },
                encryptedDataKey: envelopes.get(id)?.encryptedDataKey ?? null,
                recipientContentPublicKeyFingerprint: envelopes.get(id)?.recipientContentPublicKeyFingerprint ?? null,
            })),
        } };
        return { status: 200, data: { ...receipt, access: accessFor(accountId), dataEncryptionKey: callerDataEncryptionKey } };
    });
    const applyAudience = () => receiptGrants.push(
        ...(creator === 'bob' ? [grant({ kind: 'account', accountId: 'alice' }, 'admin')] : []),
        ...environmentGrants.filter(({ principal }) => principal.kind !== 'account' || principal.accountId !== creator)
            .map(({ principal }) => grant(principal, 'view')),
    );
    vi.spyOn(axios, 'post').mockImplementation(async (rawUrl, raw: unknown, config) => {
        const path = new URL(String(rawUrl)).pathname;
        if (path === `/v1/artifacts/${receiptId}`) {
            if (!receipt || typeof raw !== 'object' || !raw) throw new Error('Missing retained candidate');
            applyAudience();
            const { expectedHeaderVersion, expectedBodyVersion, ...content } = ArtifactJsonUpdateHttpInputV1Schema.parse(raw);
            expect([expectedHeaderVersion, expectedBodyVersion]).toEqual([1, 1]);
            receipt = ArtifactHttpReadV1Schema.parse({ ...receipt, ...content, headerVersion: 2, bodyVersion: 2 });
            return { status: 200, data: { success: true, headerVersion: 2, bodyVersion: 2 } };
        }
        if (path === '/v1/artifacts') {
            if (typeof raw !== 'object' || raw === null) throw new Error('Invalid Artifact write');
            // The server publication owner applies the admitted Environment audience at create.
            if (!retained) applyAudience();
            receipt = ArtifactHttpReadV1Schema.parse({ ...raw, ownerAccountId: accountFrom(config), access: 'owner',
                publicAudience: 'none', encryptionMode: 'e2ee', headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 });
            return { status: 200, data: { id: receipt.id, headerVersion: 1, bodyVersion: 1 } };
        }
        const input = ArtifactRecipientKeyEnvelopeCommitInputV1Schema.parse(raw);
        expect(input.expectedDataEncryptionKey).toBe(receipt?.dataEncryptionKey);
        for (const envelope of input.recipientKeyEnvelopes) envelopes.set(envelope.recipientAccountId, envelope);
        return { status: 200, data: { appliedRecipientAccountIds: input.recipientKeyEnvelopes.map(row => row.recipientAccountId), skippedRecipientAccountIds: [] } };
    });
    vi.spyOn(axios, 'put').mockRejectedValue(new Error('Receipt audience is established at create, not selected by its writer'));
    await runWithServerHttpBaseUrl('https://receipt.test', async () => {
        if (retained) await accounts.get(creator)!.store.create({ artifactId: receiptId,
            header: { kind: 'deployment-receipt.v1', title: 'Retained private candidate' }, body: '{}' });
        await createDeploymentArtifactForHost({ artifacts: accounts.get(creator)!.store,
            owner: { kind: 'account', accountId: 'alice' }, assertCurrent: async () => {}, content: { prepareRecipients: true, artifactId: receiptId,
                header: { kind: 'deployment-receipt.v1', title: 'Deployment receipt' }, body: '{"status":"succeeded"}' } });
        for (const accountId of ['alice', 'bob', 'carol']) {
            await expect(accounts.get(accountId)!.store.read(receiptId, { prepareRecipients: false })).resolves.toMatchObject({
                header: { kind: 'deployment-receipt.v1' }, body: '{"status":"succeeded"}',
            });
        }
        await expect(accounts.get('outsider')!.store.read(receiptId, { prepareRecipients: false })).resolves.toBeNull();
    });
    expect(new Set(receiptGrants.map(({ principal, accessLevel }) => ({ principal, accessLevel })))).toEqual(new Set([
        ...(creator === 'bob' ? [{ principal: { kind: 'account', accountId: 'alice' }, accessLevel: 'admin' }] : []),
        { principal: { kind: 'team', teamId: 'team' }, accessLevel: 'view' },
        ...(creator === 'alice' ? [{ principal: { kind: 'account', accountId: 'bob' }, accessLevel: 'view' }] : []),
        { principal: { kind: 'account', accountId: 'carol' }, accessLevel: 'view' },
    ]));
});
