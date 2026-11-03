import { describe, expect, it, vi } from 'vitest';
import { ENCRYPTED_DATA_KEY_ENVELOPE_V1_BYTES } from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeFormatV1';
import { ArtifactReadBatchResponseV1Schema } from '@happier-dev/protocol/artifacts/artifactAccessV1';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';

import { createArtifactStoreBoundary } from './artifactStoreBoundary';

describe('Artifact store HTTP boundary', () => {
    it('persists a semantic Team grant without manufacturing Account access or recipient keys', async () => {
        let caller = 'owner';
        const boundary = createArtifactStoreBoundary({ ownerAccountId: () => caller, encryptionMode: 'plain' });
        await boundary.handle('/v1/artifacts', { method: 'POST', body: JSON.stringify({ id: 'team-content',
            header: 'header', body: 'body', dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER }) });
        const path = '/v1/artifacts/team-content/access/grants';
        const put = () => boundary.handle(path, { method: 'PUT', body: JSON.stringify({ artifactId: 'team-content',
            principal: { kind: 'team', teamId: 'team' }, accessLevel: 'admin' }) });
        expect(await (await put())!.json()).toMatchObject({ changed: true, access: 'owner', grants: [
            { principal: { kind: 'team', teamId: 'team' }, accessLevel: 'admin' },
        ] });
        expect(await (await put())!.json()).toMatchObject({ changed: false });
        expect(await (await boundary.handle(path))!.json()).toMatchObject({ grants: boundary.readGrants('team-content') });
        caller = 'team';
        expect((await boundary.handle('/v1/artifacts/team-content'))?.status).toBe(404);
        expect((await put())?.status).toBe(403);
        caller = 'owner';
        expect(await (await boundary.handle('/v1/artifacts/team-content/access/recipients'))!.json()).toMatchObject({
            recipients: [{ recipientAccountId: 'owner' }],
        });
    });
    it('serves coarse kind and exact presence instead of echoing the stored write hint', async () => {
        for (const mode of ['plain', 'e2ee'] as const) {
            const boundary = createArtifactStoreBoundary({ ownerAccountId: () => 'owner', encryptionMode: mode });
            const input = {
                id: 'indexed-prompt', kind: 'v1:prompt:prompt_doc.v2',
                header: mode === 'plain' ? encodePlainArtifactStoredContent({ kind: 'prompt_doc.v2', title: 'Private title' }) : 'encrypted-header',
                body: mode === 'plain' ? encodePlainArtifactStoredContent({ body: 'Private body' }) : 'encrypted-body',
                dataEncryptionKey: mode === 'plain' ? ARTIFACT_PLAIN_DATA_KEY_MARKER
                    : Buffer.alloc(ENCRYPTED_DATA_KEY_ENVELOPE_V1_BYTES, 1).toString('base64'),
            };
            const created = await boundary.handle('/v1/artifacts', { method: 'POST', body: JSON.stringify(input) });
            expect(created?.status).toBe(200);
            const served = await created!.json();
            expect(served).toMatchObject({ id: input.id, kind: 'prompt', kindHint: 'prompt_doc.v2',
                header: input.header, body: input.body });
            expect(boundary.read(input.id)).toEqual(served);
            expect(await (await boundary.handle(`/v1/artifacts/${input.id}`))!.json()).toEqual(served);
            if (mode === 'e2ee') {
                const legacy = await boundary.handle('/v1/artifacts', { method: 'POST',
                    body: JSON.stringify({ ...input, id: 'legacy-prompt', kind: 'prompt' }) });
                expect(legacy?.status).toBe(200);
                const row = await legacy!.json();
                expect(row).toMatchObject({ kind: 'prompt' });
                expect(Object.hasOwn(row, 'kindHint')).toBe(false);
            }
        }
    });

    it('serves selected batch reads in request order through the same Account and content-mode owner', async () => {
        for (const mode of ['plain', 'e2ee'] as const) {
            let accountId: string | null = 'owner';
            const boundary = createArtifactStoreBoundary({ ownerAccountId: () => accountId, encryptionMode: mode });
            for (const id of ['first', 'second']) {
                await boundary.handle('/v1/artifacts', { method: 'POST', body: JSON.stringify({
                    id, header: 'private-header-' + id, body: 'private-body-' + id,
                    dataEncryptionKey: mode === 'plain' ? ARTIFACT_PLAIN_DATA_KEY_MARKER
                        : Buffer.alloc(ENCRYPTED_DATA_KEY_ENVELOPE_V1_BYTES, 1).toString('base64'),
                }) });
            }
            const before = boundary.list();
            const read = (artifactIds: readonly string[]) => boundary.handle('/v1/artifacts/read', {
                method: 'POST', body: JSON.stringify({ artifactIds }),
            });
            const response = await read(['second', 'missing', 'first']);
            expect(response?.status).toBe(200);
            const result = ArtifactReadBatchResponseV1Schema.parse(await response!.json());
            expect(result.items.map(item => item.artifactId)).toEqual(['second', 'missing', 'first']);
            expect(result.items[1]).toEqual({ artifactId: 'missing', ok: false,
                error: 'artifact_not_found', status: 404, retryable: false });
            for (const [index, id] of [[0, 'second'], [2, 'first']] as const) {
                const item = result.items[index];
                expect(item?.ok).toBe(true);
                if (!item?.ok) throw new Error('Expected an authorized selected Artifact read');
                expect(item.artifact).toEqual(boundary.read(id));
                if (mode === 'plain') expect(item.recipientCensus).toBeNull();
                else expect(item.recipientCensus).toMatchObject({ artifactId: id, ownerAccountId: 'owner', access: 'owner', encryptionMode: 'e2ee' });
            }
            expect(boundary.list()).toEqual(before);
            expect((await read(['first', 'first']))?.status).toBe(400);
            accountId = 'foreign';
            const refused = ArtifactReadBatchResponseV1Schema.parse(await (await read(['first']))!.json());
            expect(refused.items).toEqual([{ artifactId: 'first', ok: false,
                error: 'artifact_not_found', status: 404, retryable: false }]);
            boundary.seedAccountGrant('first', 'foreign', 'view');
            const granted = ArtifactReadBatchResponseV1Schema.parse(await (await read(['first']))!.json());
            if (mode === 'plain') expect(granted.items).toEqual([{ artifactId: 'first', ok: true,
                artifact: { ...boundary.read('first'), access: 'view' }, recipientCensus: null }]);
            else expect(granted.items).toEqual([{ artifactId: 'first', ok: false,
                error: 'artifact_content_unavailable', status: 409, retryable: false }]);
            accountId = null;
            expect((await read(['first']))?.status).toBe(401);
            expect(boundary.list()).toEqual(before);
        }
    });

    it('projects seeded Account grants and admits only writable grants through the same CAS owner', async () => {
        let accountId = 'owner';
        const boundary = createArtifactStoreBoundary({ ownerAccountId: () => accountId, encryptionMode: 'plain' });
        const input = { id: 'shared', header: 'header', body: 'body', dataEncryptionKey: '' };
        await boundary.handle('/v1/artifacts', { method: 'POST', body: JSON.stringify(input) });
        for (const access of ['edit', 'view', 'admin'] as const) {
            boundary.seedAccountGrant('shared', 'grantee', access);
            accountId = 'grantee';
            const before = boundary.read('shared')!;
            const detail = await boundary.handle('/v1/artifacts/shared');
            expect(detail?.status).toBe(200);
            expect(await detail!.json()).toMatchObject({ ownerAccountId: 'owner', access, body: before.body });
            expect(await (await boundary.handle('/v1/artifacts?includeBody=true'))!.json()).toMatchObject([
                { id: 'shared', ownerAccountId: 'owner', access, body: before.body },
            ]);
            expect(await (await boundary.handle('/v1/artifacts/shared/access/grants'))!.json()).toMatchObject({
                ownerAccountId: 'owner', access, grants: [{ principal: { kind: 'account', accountId: 'grantee' }, accessLevel: access }],
            });
            const write = (revision = before.headerVersion) => boundary.handle('/v1/artifacts/shared', {
                method: 'POST', body: JSON.stringify({ header: access, expectedHeaderVersion: revision }),
            });
            const response = await write();
            expect(response?.status).toBe(access === 'view' ? 404 : 200);
            expect(await response!.json()).toEqual(access === 'view' ? { error: 'Artifact not found' }
                : { success: true, headerVersion: before.headerVersion + 1 });
            if (access === 'view') expect(boundary.read('shared')).toEqual(before);
            else {
                const committed = boundary.read('shared');
                expect(await (await write())!.json()).toMatchObject({ success: false, error: 'version-mismatch' });
                expect(boundary.read('shared')).toEqual(committed);
            }
            expect((await boundary.handle('/v1/artifacts/shared/revision/1/1', { method: 'DELETE' }))?.status).toBe(404);
            expect((await boundary.handle('/v1/artifacts', { method: 'POST', body: JSON.stringify(input) }))?.status).toBe(409);
        }
        for (const retire of ['delete', 'clear'] as const) {
            accountId = 'owner';
            if (retire === 'delete') await boundary.handle('/v1/artifacts/shared', { method: 'DELETE' });
            else boundary.clear();
            await boundary.handle('/v1/artifacts', { method: 'POST', body: JSON.stringify(input) });
            accountId = 'grantee';
            expect((await boundary.handle('/v1/artifacts/shared'))?.status).toBe(404);
            boundary.seedAccountGrant('shared', 'grantee', 'edit');
        }
        // A semantic E2EE grant is not a recipient key envelope. Never substitute the owner's key.
        accountId = 'owner';
        const encrypted = createArtifactStoreBoundary({ ownerAccountId: () => accountId, encryptionMode: 'e2ee' });
        await encrypted.handle('/v1/artifacts', { method: 'POST', body: JSON.stringify({ ...input,
            dataEncryptionKey: Buffer.alloc(ENCRYPTED_DATA_KEY_ENVELOPE_V1_BYTES, 1).toString('base64'),
        }) });
        encrypted.seedAccountGrant('shared', 'grantee', 'edit');
        accountId = 'grantee';
        const unavailable = await encrypted.handle('/v1/artifacts/shared');
        expect(unavailable?.status).toBe(409);
        expect(await unavailable!.json()).toEqual({ error: 'artifact_content_unavailable' });
        expect(await (await encrypted.handle('/v1/artifacts?includeBody=true'))!.json()).toEqual([]);
        const census = await encrypted.handle('/v1/artifacts/shared/access/recipients');
        expect(census?.status).toBe(409);
        expect(await census!.json()).toEqual({ error: 'artifact_content_unavailable' });
        expect((await encrypted.handle('/v1/artifacts/shared', { method: 'POST', body: JSON.stringify({
            header: 'changed', expectedHeaderVersion: 1,
        }) }))?.status).toBe(404);
        expect(encrypted.read('shared')?.header).toBe('header');
    });

    it.each(['account-b', null])('refuses addressed operations for caller %s before bytes or mutation', async (caller) => {
        let accountId: string | null = 'account-a';
        const boundary = createArtifactStoreBoundary({ ownerAccountId: () => accountId, encryptionMode: 'plain' });
        const createInput = { id: 'artifact-a', header: 'private-header', body: 'private-body', dataEncryptionKey: '' };
        await boundary.handle('/v1/artifacts', { method: 'POST', body: JSON.stringify(createInput) });
        const committed = boundary.read('artifact-a');
        if (!committed) throw new Error('Missing created Artifact');
        boundary.replaceStoredRow({ ...committed, headerVersion: 5, bodyVersion: 9 });
        const before = boundary.read('artifact-a');
        accountId = caller;
        const attempts: ReadonlyArray<Readonly<{ path: string; init?: RequestInit; foreignStatus: number; foreignError: string }>> = [
            { path: '/v1/artifacts/artifact-a', foreignStatus: 404, foreignError: 'Artifact not found' },
            { path: '/v1/artifacts/artifact-a/access/grants', foreignStatus: 404, foreignError: 'artifact_not_found' },
            { path: '/v1/artifacts/artifact-a/access/recipients', foreignStatus: 404, foreignError: 'artifact_not_found' },
            { path: '/v1/artifacts/artifact-a', init: { method: 'POST', body: JSON.stringify({
                header: 'changed-header', body: 'changed-body', expectedHeaderVersion: 1, expectedBodyVersion: 1,
            }) }, foreignStatus: 404, foreignError: 'Artifact not found' },
            { path: '/v1/artifacts/artifact-a', init: { method: 'POST', body: JSON.stringify({
                header: 'changed-header', body: 'changed-body', expectedHeaderVersion: 5, expectedBodyVersion: 9,
            }) }, foreignStatus: 404, foreignError: 'Artifact not found' },
            { path: '/v1/artifacts/artifact-a/revision/5/9', init: { method: 'DELETE' }, foreignStatus: 404, foreignError: 'Artifact not found' },
            { path: '/v1/artifacts/artifact-a/revision/1/1', init: { method: 'DELETE' }, foreignStatus: 404, foreignError: 'Artifact not found' },
            { path: '/v1/artifacts/artifact-a', init: { method: 'DELETE' }, foreignStatus: 404, foreignError: 'Artifact not found' },
            { path: '/v1/artifacts', init: { method: 'POST', body: JSON.stringify(createInput) },
                foreignStatus: 409, foreignError: 'Artifact with this ID already exists for another account' },
        ];
        for (const attempt of attempts) {
            const response = await boundary.handle(attempt.path, attempt.init);
            expect(response?.status, attempt.path).toBe(caller === null ? 401 : attempt.foreignStatus);
            expect(await response!.json(), attempt.path).toEqual({ error: caller === null ? 'Missing authorization header' : attempt.foreignError });
            expect(boundary.read('artifact-a'), attempt.path).toEqual(before);
        }
        accountId = 'account-a';
        expect(await (await boundary.handle('/v1/artifacts', { method: 'POST', body: JSON.stringify(createInput) }))!.json()).toEqual(before);
        expect(await (await boundary.handle('/v1/artifacts/artifact-a'))!.json()).toEqual(before);
        expect((await boundary.handle('/v1/artifacts/artifact-a/revision/1/1', { method: 'DELETE' }))?.status).toBe(409);
        expect(boundary.read('artifact-a')).toEqual(before);
        expect(await (await boundary.handle('/v1/artifacts/artifact-a/revision/5/9', { method: 'DELETE' }))!.json()).toEqual({ success: true });
        expect(boundary.read('artifact-a')).toBeNull();
    });

    it('uses a committed server row for CAS and keeps read snapshots detached', async () => {
        const boundary = createArtifactStoreBoundary({ ownerAccountId: () => 'account-a', encryptionMode: 'plain' });
        await boundary.handle('/v1/artifacts', { method: 'POST', body: JSON.stringify({
            id: 'artifact-a', header: 'first-header', body: 'first-body', dataEncryptionKey: '',
        }) });
        const committed = boundary.read('artifact-a');
        if (!committed) throw new Error('Missing created Artifact');
        Object.assign(committed, { header: 'agent-header', body: 'agent-body', headerVersion: 5, bodyVersion: 9 });
        boundary.replaceStoredRow(committed);
        committed.headerVersion = 100;
        const attempt = (headerVersion: number, bodyVersion: number) => boundary.handle('/v1/artifacts/artifact-a', {
            method: 'POST', body: JSON.stringify({ header: 'human-header', body: 'human-body',
                expectedHeaderVersion: headerVersion, expectedBodyVersion: bodyVersion }),
        });
        expect(await (await attempt(1, 1))!.json()).toMatchObject({ success: false, error: 'version-mismatch',
            currentHeaderVersion: 5, currentBodyVersion: 9 });
        expect(await (await attempt(5, 9))!.json()).toEqual({ success: true, headerVersion: 6, bodyVersion: 10 });
        expect(boundary.read('artifact-a')).toMatchObject({ header: 'human-header', body: 'human-body',
            headerVersion: 6, bodyVersion: 10 });
    });

    it('returns only the stored owner census and fences it to that Account', async () => {
        let accountId: string | null = 'account-a';
        const boundary = createArtifactStoreBoundary({ ownerAccountId: () => accountId, encryptionMode: 'e2ee' });
        // The HTTP boundary stores opaque envelope bytes; opening them belongs to the real codec.
        const dataEncryptionKey = Buffer.alloc(ENCRYPTED_DATA_KEY_ENVELOPE_V1_BYTES, 1).toString('base64');
        const provenanceDataEncryptionKey = Buffer.alloc(ENCRYPTED_DATA_KEY_ENVELOPE_V1_BYTES, 2).toString('base64');
        await boundary.handle('/v1/artifacts', { method: 'POST', body: JSON.stringify({
            id: 'artifact-a', header: 'header', body: 'body', dataEncryptionKey,
            provenance: 'private-metadata', provenanceDataEncryptionKey,
        }) });
        const response = await boundary.handle('/v1/artifacts/artifact-a/access/recipients');
        expect(response?.status).toBe(200);
        expect(await response!.json()).toMatchObject({
            artifactId: 'artifact-a', ownerAccountId: 'account-a', access: 'owner', encryptionMode: 'e2ee',
            dataEncryptionKey, callerDataEncryptionKey: dataEncryptionKey,
            provenanceDataEncryptionKey, callerProvenanceDataEncryptionKey: provenanceDataEncryptionKey,
            recipients: [{ recipientAccountId: 'account-a', contentKey: { status: 'unavailable', reason: 'encryption_setup_required' } }],
        });
        expect(await (await boundary.handle('/v1/artifacts/artifact-a?accessProjectionVersion=1'))!.json())
            .toMatchObject({ id: 'artifact-a', ownerAccountId: 'account-a', access: 'owner' });
        expect((await boundary.handle('/v1/artifacts/missing/access/recipients'))?.status).toBe(404);
        accountId = 'account-b';
        expect((await boundary.handle('/v1/artifacts/artifact-a/access/recipients'))?.status).toBe(404);
        accountId = null;
        expect((await boundary.handle('/v1/artifacts/artifact-a/access/recipients'))?.status).toBe(401);
    });

    it('pages headers in the server cursor order without repeating tied timestamps or returning bodies', async () => {
        const clock = vi.spyOn(Date, 'now').mockReturnValue(1234);
        try {
            const boundary = createArtifactStoreBoundary({ ownerAccountId: () => 'account-a', encryptionMode: 'plain' });
            for (const id of ['a', 'b', 'c']) await boundary.handle('/v1/artifacts', { method: 'POST',
                body: JSON.stringify({ id, header: 'header', body: 'body', dataEncryptionKey: '' }) });
            const first = await (await boundary.handle('/v1/artifacts?limit=2'))!.json();
            expect(first.map((row: { id: string }) => row.id)).toEqual(['c', 'b']);
            expect(first[0]).not.toHaveProperty('body');
            const cursor = Buffer.from(JSON.stringify({ updatedAt: 1234, id: 'b' })).toString('base64url');
            const last = await (await boundary.handle(`/v1/artifacts?limit=2&cursor=${cursor}&includeBody=true`))!.json();
            expect(last).toMatchObject([{ id: 'a', body: 'body', bodyVersion: 1 }]);
            expect(last).toHaveLength(1);
        } finally { clock.mockRestore(); }
    });
});
