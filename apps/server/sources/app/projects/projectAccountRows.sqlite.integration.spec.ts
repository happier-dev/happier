import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { db } from '@/storage/db';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { withAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { registerProjectAccountRowRoutes } from '@/app/api/routes/projects/registerProjectAccountRowRoutes';
import { buildProjectAccountRowPhysicalKeyV1, type ProjectAccountRowKeyV1 } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import { computeWorkspaceSyncPolicyDigest, signAccountContentKeyBindingV1 } from '@happier-dev/protocol';
import { encodeAccountScopedKvJson } from '@/app/kv/accountScopedKv';
import { decodeBase64, encodeBase64 } from 'privacy-kit';
import tweetnacl from 'tweetnacl';

const graphKey = { kind: 'relationship-graph' } as const;
const refKey = (id: string) => ({ kind: 'workspace-ref', serverId: 'home-a', id } as const);
const plain = (key: ProjectAccountRowKeyV1, value: unknown) => ({ t: 'plain', v: { key, value } });
const refValue = (id: string, label = 'original') => ({ id, serverId: 'home-a', machineId: `machine-${id}`, rootPath: `/repo/${id}`, label, createdAtMs: 1 });
const mutation = (key: ProjectAccountRowKeyV1, expectedRevision: number | 'absent', value: unknown) => ({ key, expectedRevision, content: plain(key, value) });
function relationship(id: string, alpha: string, beta: string) {
    const policy = { v: 1 as const, selection: 'all_files' as const, extraIgnorePatterns: [], extraIncludePatterns: [] };
    return { v: 1, relationshipId: id, controllerMachineId: 'machine-a', alphaWorkspaceRefId: alpha, betaWorkspaceRefId: beta,
        mode: 'keep_synced', contentPolicy: { ...policy, policyDigest: computeWorkspaceSyncPolicyDigest(policy) }, enabled: true, createdAtMs: 1, updatedAtMs: 1 };
}

describe('Project Account rows (SQLite integration)', () => {
    let harness: LightSqliteHarness | undefined;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-project-account-rows-' });
    }, 120_000);
    afterEach(async () => { await db.account.deleteMany(); });
    afterAll(async () => { await harness?.close(); });

    it('serializes stale relationship creation against Forget and rolls back every losing row', async () => {
        const account = await db.account.create({ data: { encryptionMode: 'plain' } });
        await withAuthenticatedTestApp(registerProjectAccountRowRoutes, async app => {
            const send = async (payload: unknown) => (await app.inject({ method: 'POST', url: '/v1/account/project-rows/mutate', headers: { 'x-test-user-id': account.id }, payload })).json();
            expect(await send({ mutations: [mutation(refKey('a'), 'absent', refValue('a')), mutation(refKey('b'), 'absent', refValue('b')), mutation(graphKey, 'absent', { relationships: [] })], expectedRefs: [], topologyChange: true })).toMatchObject({ status: 'updated' });
            // Both authenticated clients have admitted their intent from graph=0/ref=0 before either commits.
            const responses = await Promise.all([
                send({ mutations: [{ key: refKey('a'), expectedRevision: 0, content: null }, mutation(graphKey, 0, { relationships: [] })], expectedRefs: [{ key: refKey('a'), expectedRevision: 0 }], topologyChange: true }),
                send({ mutations: [mutation(graphKey, 0, { relationships: [relationship('ab', 'a', 'b')] })], expectedRefs: [{ key: refKey('a'), expectedRevision: 0 }, { key: refKey('b'), expectedRevision: 0 }], topologyChange: false }),
            ]);
            expect(responses.map(r => r.status).sort()).toEqual(['conflict', 'updated']);
            const list = (await app.inject({ method: 'POST', url: '/v1/account/project-rows/list', headers: { 'x-test-user-id': account.id }, payload: {} })).json();
            expect(list.coverage).toBe('complete');
            const graph = list.rows.find((row: { key: ProjectAccountRowKeyV1 }) => row.key.kind === 'relationship-graph');
            const ref = list.rows.find((row: { key: ProjectAccountRowKeyV1 }) => row.key.kind === 'workspace-ref' && row.key.id === 'a');
            expect(graph.revision).toBe(1);
            expect(graph.content.v.value.relationships.length === 0 ? ref.content : ref.content.t).toEqual(graph.content.v.value.relationships.length === 0 ? null : 'plain');
            expect(await db.accountChange.count({ where: { accountId: account.id } })).toBe(3);
        });
    });

    it('requires graph advancement for insertion, Forget and Plain root changes even when the caller omits topology intent', async () => {
        const account = await db.account.create({ data: { encryptionMode: 'plain' } });
        await withAuthenticatedTestApp(registerProjectAccountRowRoutes, async app => {
            const send = async (mutations: unknown[]) => (await app.inject({ method: 'POST', url: '/v1/account/project-rows/mutate', headers: { 'x-test-user-id': account.id }, payload: { mutations, expectedRefs: [], topologyChange: false } })).json();
            expect(await send([mutation(refKey('a'), 'absent', refValue('a'))])).toMatchObject({ status: 'graph-required' });
            expect(await send([mutation(refKey('a'), 'absent', refValue('a')), mutation(graphKey, 'absent', { relationships: [] })])).toMatchObject({ status: 'updated' });
            expect(await send([mutation(refKey('a'), 0, { ...refValue('a'), rootPath: '/moved' })])).toMatchObject({ status: 'graph-required' });
            expect(await send([{ key: refKey('a'), expectedRevision: 0, content: null }])).toMatchObject({ status: 'graph-required' });
            expect(await send([{ key: graphKey, expectedRevision: 0, content: null }])).toMatchObject({ status: 'graph-deletion-forbidden' });
        });
    });

    it('admits only one of two overlapping daemon graph writes and leaves the loser ref unchanged', async () => {
        const account = await db.account.create({ data: { encryptionMode: 'plain' } });
        await withAuthenticatedTestApp(registerProjectAccountRowRoutes, async app => {
            const send = async (payload: unknown) => (await app.inject({ method: 'POST', url: '/v1/account/project-rows/mutate', headers: { 'x-test-user-id': account.id }, payload })).json();
            expect(await send({ mutations: ['a', 'b', 'c'].map(id => mutation(refKey(id), 'absent', refValue(id))).concat([mutation(graphKey, 'absent', { relationships: [] })]), expectedRefs: [], topologyChange: true })).toMatchObject({ status: 'updated' });
            const create = (endpoint: string) => send({ mutations: [mutation(refKey(endpoint), 0, refValue(endpoint, 'winner')), mutation(graphKey, 0, { relationships: [relationship(`a${endpoint}`, 'a', endpoint)] })], expectedRefs: [{ key: refKey('a'), expectedRevision: 0 }, { key: refKey(endpoint), expectedRevision: 0 }], topologyChange: false });
            const results = await Promise.all([create('b'), create('c')]);
            expect(results.map(r => r.status).sort()).toEqual(['conflict', 'updated']);
            const list = (await app.inject({ method: 'POST', url: '/v1/account/project-rows/list', headers: { 'x-test-user-id': account.id }, payload: {} })).json();
            const refs = list.rows.filter((r: { key: ProjectAccountRowKeyV1 }) => r.key.kind === 'workspace-ref');
            expect(refs.map((r: { content: { v: { value: { label: string } } } }) => r.content.v.value.label).sort()).toEqual(['original', 'original', 'winner']);
        });
    });

    it('lets unrelated ref labels and Project organization edits both commit without graph contention', async () => {
        const account = await db.account.create({ data: { encryptionMode: 'plain' } });
        const organizationKey = { kind: 'project-organization', serverId: 'home-a', projectKey: 'other' } as const;
        await withAuthenticatedTestApp(registerProjectAccountRowRoutes, async app => {
            const send = async (mutations: unknown[]) => (await app.inject({ method: 'POST', url: '/v1/account/project-rows/mutate', headers: { 'x-test-user-id': account.id }, payload: { mutations, expectedRefs: [], topologyChange: false } })).json();
            expect(await send([mutation(refKey('a'), 'absent', refValue('a')), mutation(graphKey, 'absent', { relationships: [] })])).toMatchObject({ status: 'updated' });
            const results = await Promise.all([send([mutation(refKey('a'), 0, refValue('a', 'renamed'))]), send([mutation(organizationKey, 'absent', { hidden: true, pinned: true })])]);
            expect(results.map(r => r.status)).toEqual(['updated', 'updated']);
            const graph = await db.userKVStore.findUniqueOrThrow({ where: { accountId_key: { accountId: account.id, key: buildProjectAccountRowPhysicalKeyV1(graphKey) } } });
            expect(graph.version).toBe(0);
        });
    });

    it('refuses a stale reached-ref census even when the graph revision is current, preserving the whole batch', async () => {
        const account = await db.account.create({ data: { encryptionMode: 'plain' } });
        const organizationKey = { kind: 'project-organization', serverId: 'home-a', projectKey: 'batch' } as const;
        await withAuthenticatedTestApp(registerProjectAccountRowRoutes, async app => {
            const send = async (payload: unknown) => (await app.inject({ method: 'POST', url: '/v1/account/project-rows/mutate', headers: { 'x-test-user-id': account.id }, payload })).json();
            expect(await send({ mutations: [mutation(refKey('a'), 'absent', refValue('a')), mutation(refKey('b'), 'absent', refValue('b')), mutation(graphKey, 'absent', { relationships: [] })], expectedRefs: [], topologyChange: true })).toMatchObject({ status: 'updated' });
            expect(await send({ mutations: [mutation(refKey('b'), 0, refValue('b', 'newer'))], expectedRefs: [], topologyChange: false })).toMatchObject({ status: 'updated' });
            const before = await db.account.findUniqueOrThrow({ where: { id: account.id } });
            expect(await send({ mutations: [mutation(organizationKey, 'absent', { hidden: true }), mutation(graphKey, 0, { relationships: [relationship('ab', 'a', 'b')] })],
                expectedRefs: [{ key: refKey('a'), expectedRevision: 0 }, { key: refKey('b'), expectedRevision: 0 }], topologyChange: false }))
                .toEqual({ status: 'conflict', key: refKey('b'), revision: 1 });
            const graph = await db.userKVStore.findUniqueOrThrow({ where: { accountId_key: { accountId: account.id, key: buildProjectAccountRowPhysicalKeyV1(graphKey) } } });
            expect(graph.version).toBe(0);
            expect(await db.userKVStore.findUnique({ where: { accountId_key: { accountId: account.id, key: buildProjectAccountRowPhysicalKeyV1(organizationKey) } } })).toBeNull();
            expect((await db.account.findUniqueOrThrow({ where: { id: account.id } })).seq).toBe(before.seq);
            expect(await db.accountChange.count({ where: { accountId: account.id } })).toBe(3);
        });
    });

    it('refuses mismatched payload identity and Account mode without changing any row', async () => {
        const account = await db.account.create({ data: { encryptionMode: 'plain' } });
        const key = { kind: 'project-organization', serverId: 'home-a', projectKey: 'private' } as const;
        await withAuthenticatedTestApp(registerProjectAccountRowRoutes, async app => {
            const send = async (content: unknown) => (await app.inject({ method: 'POST', url: '/v1/account/project-rows/mutate', headers: { 'x-test-user-id': account.id }, payload: { mutations: [{ key, expectedRevision: 'absent', content }], expectedRefs: [], topologyChange: false } })).json();
            expect(await send({ t: 'encrypted', c: 'opaque' })).toMatchObject({ status: 'account-mode-mismatch' });
            expect(await send(plain({ ...key, projectKey: 'foreign' }, { hidden: true }))).toMatchObject({ status: 'invalid-stored-content' });
            expect(await db.userKVStore.count({ where: { accountId: account.id } })).toBe(0);
        });
    });

    it('keeps E2EE content opaque while refusing wrong-mode reads and writes', async () => {
        const signing = tweetnacl.sign.keyPair();
        const contentKey = tweetnacl.box.keyPair();
        const account = await db.account.create({ data: { encryptionMode: 'e2ee', publicKey: Buffer.from(signing.publicKey).toString('hex'),
            contentPublicKey: contentKey.publicKey, contentPublicKeySig: signAccountContentKeyBindingV1({ accountSigningSecretKey: signing.secretKey, contentPublicKey: contentKey.publicKey }) } });
        const key = { kind: 'project-organization', serverId: 'home-a', projectKey: 'encrypted' } as const;
        // Only the real Account cipher's framing is server-readable; opaque bytes are never interpreted here.
        const ciphertext = new Uint8Array(43); ciphertext[0] = 0xa1; ciphertext[1] = 34; ciphertext[42] = 7;
        const content = { t: 'encrypted', c: encodeBase64(ciphertext) };
        await withAuthenticatedTestApp(registerProjectAccountRowRoutes, async app => {
            const send = async (value: unknown, expectedRevision: number | 'absent') => (await app.inject({ method: 'POST', url: '/v1/account/project-rows/mutate', headers: { 'x-test-user-id': account.id }, payload: { mutations: [{ key, expectedRevision, content: value }], expectedRefs: [], topologyChange: false } })).json();
            expect(await send(content, 'absent')).toMatchObject({ status: 'updated' });
            expect((await app.inject({ method: 'POST', url: '/v1/account/project-rows/read', headers: { 'x-test-user-id': account.id }, payload: { key } })).json()).toEqual({ status: 'present', row: { key, revision: 0, content } });
            expect(await send(plain(key, { hidden: true }), 0)).toMatchObject({ status: 'account-mode-mismatch' });
            await db.account.update({ where: { id: account.id }, data: { encryptionMode: 'plain' } });
            expect((await app.inject({ method: 'POST', url: '/v1/account/project-rows/list', headers: { 'x-test-user-id': account.id }, payload: {} })).json()).toEqual({ status: 'account-mode-mismatch' });
        });
    });

    it('reads nested stored extras, then emits only canonical known fields on write', async () => {
        const account = await db.account.create({ data: { encryptionMode: 'plain' } });
        const key = { kind: 'project-organization', serverId: 'home-a', projectKey: 'private' } as const;
        const entry = { id: 'context-a', enabled: true, placement: 'system_append', ref: { kind: 'doc', artifactId: 'doc-a' } };
        const canonicalValue = { hidden: true, promptStack: [entry] };
        const stored = { t: 'plain', envelopeExtra: true, v: { key: { ...key, keyExtra: true }, payloadExtra: true, value: { ...canonicalValue,
            promptStack: [{ ...entry, editPolicy: 'user_only', entryExtra: true, ref: { ...entry.ref, referenceExtra: true } }], nestedExtra: { private: true } } } };
        const bytes = encodeAccountScopedKvJson(stored);
        if (bytes === null) throw new Error('fixture encoding failed');
        await db.userKVStore.create({ data: { accountId: account.id, key: buildProjectAccountRowPhysicalKeyV1(key), version: 0, value: decodeBase64(bytes) } });
        await withAuthenticatedTestApp(registerProjectAccountRowRoutes, async app => {
            const read = (await app.inject({ method: 'POST', url: '/v1/account/project-rows/read', headers: { 'x-test-user-id': account.id }, payload: { key } })).json();
            expect(read).toEqual({ status: 'present', row: { key, revision: 0, content: plain(key, canonicalValue) } });
            expect((await app.inject({ method: 'POST', url: '/v1/account/project-rows/mutate', headers: { 'x-test-user-id': account.id }, payload: { mutations: [{ key, expectedRevision: 0, content: read.row.content }], expectedRefs: [], topologyChange: false } })).json()).toMatchObject({ status: 'updated' });
            const row = await db.userKVStore.findUniqueOrThrow({ where: { accountId_key: { accountId: account.id, key: buildProjectAccountRowPhysicalKeyV1(key) } } });
            expect(JSON.parse(new TextDecoder().decode(row.value!))).toEqual(plain(key, canonicalValue));
            const corrupt = encodeAccountScopedKvJson(plain(key, { hidden: 'wrong-known-type' }));
            if (corrupt === null) throw new Error('fixture encoding failed');
            await db.userKVStore.update({ where: { accountId_key: { accountId: account.id, key: row.key } }, data: { value: decodeBase64(corrupt) } });
            expect((await app.inject({ method: 'POST', url: '/v1/account/project-rows/read', headers: { 'x-test-user-id': account.id }, payload: { key } })).json()).toEqual({ status: 'invalid-stored-content' });
        });
    });

    it('does not disclose another Account row or let an input select the Account owner', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const outsider = await db.account.create({ data: { encryptionMode: 'plain' } });
        const key = { kind: 'project-organization', serverId: 'home-a', projectKey: 'private' } as const;
        await withAuthenticatedTestApp(registerProjectAccountRowRoutes, async app => {
            expect((await app.inject({ method: 'POST', url: '/v1/account/project-rows/mutate', headers: { 'x-test-user-id': owner.id }, payload: { mutations: [mutation(key, 'absent', { hidden: true })], expectedRefs: [], topologyChange: false } })).json()).toMatchObject({ status: 'updated' });
            expect((await app.inject({ method: 'POST', url: '/v1/account/project-rows/read', headers: { 'x-test-user-id': outsider.id }, payload: { key } })).json()).toEqual({ status: 'absent' });
            expect((await app.inject({ method: 'POST', url: '/v1/account/project-rows/read', headers: { 'x-test-user-id': outsider.id }, payload: { key, accountId: owner.id } })).statusCode).toBe(400);
        });
    });

    it('stores keyless Plain organization rows without settings or history writes', async () => {
        const account = await db.account.create({ data: { encryptionMode: 'plain' } });
        const key = { kind: 'project-organization', serverId: 'home-a', projectKey: randomUUID() };
        const before = await db.account.findUniqueOrThrow({ where: { id: account.id } });
        await withAuthenticatedTestApp(registerProjectAccountRowRoutes, async app => {
            const response = await app.inject({ method: 'POST', url: '/v1/account/project-rows/mutate',
                headers: { 'x-test-user-id': account.id }, payload: {
                    mutations: [{ key, expectedRevision: 'absent', content: { t: 'plain', v: { key, value: { hidden: true } } } }],
                    expectedRefs: [], topologyChange: false,
                } });
            expect(response.statusCode).toBe(200);
            expect(response.json()).toMatchObject({ status: 'updated', rows: [{ key, revision: 0 }] });
            const read = await app.inject({ method: 'POST', url: '/v1/account/project-rows/read',
                headers: { 'x-test-user-id': account.id }, payload: { key } });
            expect(read.json()).toMatchObject({ status: 'present', row: { key, content: { t: 'plain', v: { value: { hidden: true } } } } });
        });
        const after = await db.account.findUniqueOrThrow({ where: { id: account.id } });
        expect(after.settings).toEqual(before.settings);
        expect(after.settingsVersion).toBe(before.settingsVersion);
        expect(await db.accountSettingsSnapshot.count({ where: { accountId: account.id } })).toBe(0);
    });
});
