import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sealAccountScopedBlobCiphertext } from '@happier-dev/protocol';
import { buildWorkspaceExecutionConfigRowIdV1, buildWorkspaceExecutionConfigPhysicalKeyV1 } from '@happier-dev/protocol/workspaces/workspaceExecutionConfigRowV1';
import { createWorkspaceExecutionConfigClientV1, openWorkspaceExecutionConfigContentV1, type WorkspaceExecutionConfigTransportV1 } from '@happier-dev/protocol/workspaces/workspaceExecutionConfigClientV1';

import { accountRoutes } from '@/app/api/routes/account/accountRoutes';
import { kvRoutes } from '@/app/api/routes/kv/kvRoutes';
import { createAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { db } from '@/storage/db';
import { createSignedAccountContentBinding } from '@/testkit/accountEncryption';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';

const route = '/v1/projects/execution/config';
const address = { serverId: 'home-a', refId: 'checkout-a' };
const content = { t: 'plain', v: { enabled: false, unavailable: 'ask', allowAdHoc: false, scriptOverrides: {}, services: {} } };

function createApp() {
    const app = createAuthenticatedTestApp();
    accountRoutes(app);
    kvRoutes(app);
    return app;
}

describe('workspace execution config reserved rows (SQLite)', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => { harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-workspace-config-' }); }, 120_000);
    afterAll(async () => { await harness?.close(); });

    it('CAS-writes a keyless Plain checkout without touching Account settings, isolates qualified refs and retains tombstones', async () => {
        const account = await db.account.create({ data: { id: randomUUID(), encryptionMode: 'plain' } });
        const before = await db.account.findUniqueOrThrow({ where: { id: account.id } });
        const historyCount = await db.accountSettingsSnapshot.count({ where: { accountId: account.id } });
        const app = createApp();
        const headers = { 'x-test-user-id': account.id };
        try {
            expect((await app.inject({ method: 'POST', url: `${route}/read`, headers, payload: { address } })).json()).toEqual({ status: 'absent' });
            const write = await app.inject({ method: 'POST', url: `${route}/mutate`, headers, payload: { address, expectedRevision: 'absent', content } });
            expect(write.statusCode).toBe(200);
            expect(write.json()).toMatchObject({ status: 'updated', revision: 0 });
            expect((await app.inject({ method: 'POST', url: `${route}/read`, headers, payload: { address } })).json()).toEqual({ status: 'present', revision: 0, content });
            for (const other of [{ ...address, refId: 'checkout-b' }, { ...address, serverId: 'home-b' }]) {
                expect((await app.inject({ method: 'POST', url: `${route}/read`, headers, payload: { address: other } })).json()).toEqual({ status: 'absent' });
            }
            expect((await app.inject({ method: 'POST', url: `${route}/mutate`, headers, payload: { address, expectedRevision: 'absent', content: null } })).json()).toEqual({ status: 'conflict', revision: 0 });
            const after = await db.account.findUniqueOrThrow({ where: { id: account.id } });
            expect(after.settings).toEqual(before.settings);
            expect(after.settingsVersion).toBe(before.settingsVersion);
            expect(await db.accountSettingsSnapshot.count({ where: { accountId: account.id } })).toBe(historyCount);
            const row = await db.userKVStore.findFirstOrThrow({ where: { accountId: account.id } });
            expect(row.key).not.toContain('checkout-a');
            expect(row.key).not.toContain('home-a');
            // JSON keys reach the public KV classifier without the router's path-parameter length limit.
            expect((await app.inject({ method: 'POST', url: '/v1/kv/bulk', headers, payload: { keys: [row.key] } })).statusCode).toBe(400);
            expect((await app.inject({ method: 'POST', url: `${route}/mutate`, headers, payload: { address, expectedRevision: 0, content: null } })).json()).toMatchObject({ status: 'updated', revision: 1 });
            expect((await app.inject({ method: 'POST', url: `${route}/read`, headers, payload: { address } })).json()).toEqual({ status: 'deleted', revision: 1 });
            expect((await app.inject({ method: 'GET', url: route, headers })).json()).toMatchObject({ rows: [{ revision: 1, content: null }] });
        } finally { await app.close(); }
    });

    it('refuses wrong Account mode, malformed content and additive mutation fields before disclosure or mutation', async () => {
        const account = await db.account.create({ data: { id: randomUUID(), encryptionMode: 'e2ee', ...createSignedAccountContentBinding() } });
        const app = createApp();
        const headers = { 'x-test-user-id': account.id };
        try {
            expect((await app.inject({ method: 'POST', url: `${route}/mutate`, headers, payload: { address, expectedRevision: 'absent', content } })).statusCode).toBe(503);
            expect(await db.userKVStore.count({ where: { accountId: account.id } })).toBe(0);
            expect((await app.inject({ method: 'POST', url: `${route}/mutate`, headers, payload: { address, expectedRevision: 'absent', content: { ...content, extra: true } } })).statusCode).toBe(400);
            expect((await app.inject({ method: 'POST', url: `${route}/mutate`, headers, payload: { address, expectedRevision: 'absent', content: { t: 'encrypted', c: 'malformed' } } })).statusCode).toBe(503);
        } finally { await app.close(); }
    });

    it('opens additive stored fields, keeps E2EE opaque and refuses stored mode mismatches even for deletion', async () => {
        const plain = await db.account.create({ data: { id: randomUUID(), encryptionMode: 'plain' } });
        const encrypted = await db.account.create({ data: { id: randomUUID(), encryptionMode: 'e2ee', ...createSignedAccountContentBinding() } });
        const rowId = buildWorkspaceExecutionConfigRowIdV1(address);
        const key = buildWorkspaceExecutionConfigPhysicalKeyV1(rowId);
        const stored = new TextEncoder().encode(JSON.stringify({ ...content, futureEnvelope: true, v: { ...content.v, futureSetting: true } }));
        await db.userKVStore.create({ data: { accountId: plain.id, key, version: 4, value: stored } });
        const opaque = { t: 'encrypted', c: sealAccountScopedBlobCiphertext({
            kind: 'workspace_execution_config', material: { type: 'dataKey', machineKey: new Uint8Array(32).fill(9) },
            payload: { rowId, value: content.v }, randomBytes: length => new Uint8Array(length).fill(3),
        }) };
        const app = createApp();
        try {
            const headers = { 'x-test-user-id': plain.id };
            expect((await app.inject({ method: 'POST', url: `${route}/read`, headers, payload: { address } })).json()).toEqual({ status: 'present', revision: 4, content });
            const encryptedHeaders = { 'x-test-user-id': encrypted.id };
            expect((await app.inject({ method: 'POST', url: `${route}/mutate`, headers: encryptedHeaders, payload: { address, expectedRevision: 'absent', content: opaque } })).statusCode).toBe(200);
            expect((await app.inject({ method: 'POST', url: `${route}/read`, headers: encryptedHeaders, payload: { address } })).json()).toEqual({ status: 'present', revision: 0, content: opaque });
            await db.userKVStore.update({ where: { accountId_key: { accountId: encrypted.id, key } }, data: { value: stored } });
            for (const request of [
                { method: 'POST' as const, url: `${route}/read`, payload: { address } },
                { method: 'POST' as const, url: `${route}/mutate`, payload: { address, expectedRevision: 0, content: null } },
                { method: 'GET' as const, url: route },
            ]) {
                const rejected = await app.inject({ ...request, headers: encryptedHeaders });
                expect(rejected.statusCode).toBe(503);
                expect(rejected.body).not.toContain('futureSetting');
            }
            expect((await db.userKVStore.findUniqueOrThrow({ where: { accountId_key: { accountId: encrypted.id, key } } })).value).toEqual(stored);
        } finally { await app.close(); }
    });

    it('rebases finite preference edits across service CAS writes and conflicts on a changed finite entry', async () => {
        const account = await db.account.create({ data: { id: randomUUID(), encryptionMode: 'plain' } });
        const app = createApp();
        const headers = { 'x-test-user-id': account.id };
        const initial = { enabled: false as const, unavailable: 'ask' as const, allowAdHoc: false, scriptOverrides: {} };
        const services = { web: { runsOn: { kind: 'primary' as const }, unavailable: 'fail' as const } };
        let concurrentServiceWrite = true;
        // Fastify injection replaces only the HTTP transport; client semantics, row CAS and DB are real.
        const client = createWorkspaceExecutionConfigClientV1({
            mode: 'plain', material: null, randomBytes: length => new Uint8Array(length), isCurrent: () => true,
            transport: {
                read: async input => (await app.inject({ method: 'POST', url: `${route}/read`, headers, payload: input })).json(),
                mutate: async input => {
                    if (concurrentServiceWrite) {
                        concurrentServiceWrite = false;
                        const competing = await app.inject({ method: 'POST', url: `${route}/mutate`, headers, payload: {
                            address, expectedRevision: 0, content: { t: 'plain', v: { ...initial, services } },
                        } });
                        expect(competing.json()).toMatchObject({ status: 'updated', revision: 1 });
                    }
                    return (await app.inject({ method: 'POST', url: `${route}/mutate`, headers, payload: input })).json();
                },
            },
        });
        try {
            expect((await app.inject({ method: 'POST', url: `${route}/mutate`, headers, payload: { address, expectedRevision: 'absent', content } })).statusCode).toBe(200);
            const next = { ...initial, enabled: true as const, destination: { kind: 'machine' as const, machineId: 'worker-a' } };
            expect(await client.set({ workspace: address, expectedRevision: 0, expected: { kind: 'value', value: initial }, next })).toMatchObject({ status: 'applied', revision: 2, preference: next });
            const read = async () => (await app.inject({ method: 'POST', url: `${route}/read`, headers, payload: { address } })).json();
            expect(await read()).toEqual({ status: 'present', revision: 2, content: { t: 'plain', v: { ...next, services } } });
            expect(await client.set({ workspace: address, expectedRevision: 0, expected: { kind: 'value', value: initial }, next: { ...next, allowAdHoc: true } })).toMatchObject({ status: 'conflict', revision: 2 });
            expect(await client.reset({ workspace: address, expectedRevision: 2, expected: { kind: 'value', value: next } })).toMatchObject({ status: 'applied', revision: 3 });
            expect(await read()).toEqual({ status: 'present', revision: 3, content: { t: 'plain', v: { ...initial, services } } });
        } finally { await app.close(); }
    });

    it.each(['plain', 'e2ee'] as const)('rebases the first finite preference CAS after a service materializes the absent row (%s)', async (mode) => {
        const account = await db.account.create({ data: {
            id: randomUUID(), encryptionMode: mode,
            ...(mode === 'e2ee' ? createSignedAccountContentBinding() : {}),
        } });
        const app = createApp();
        const headers = { 'x-test-user-id': account.id };
        const material = mode === 'plain' ? null : { type: 'legacy' as const, secret: new Uint8Array(32).fill(23) };
        const transport: WorkspaceExecutionConfigTransportV1 = {
            read: async input => (await app.inject({ method: 'POST', url: `${route}/read`, headers, payload: input })).json(),
            mutate: async input => (await app.inject({ method: 'POST', url: `${route}/mutate`, headers, payload: input })).json(),
        };
        const options = { mode, material, randomBytes: (length: number) => new Uint8Array(length).fill(17), isCurrent: () => true };
        const serviceClient = createWorkspaceExecutionConfigClientV1({ ...options, transport });
        const placement = { runsOn: { kind: 'workers' as const, destination: { kind: 'machine' as const, machineId: 'service-worker' } }, unavailable: 'fail' as const };
        let serviceMaterialized = false;
        const finiteClient = createWorkspaceExecutionConfigClientV1({ ...options, transport: {
            ...transport,
            mutate: async input => {
                if (!serviceMaterialized) {
                    serviceMaterialized = true;
                    expect(input.expectedRevision).toBe('absent');
                    expect(await serviceClient.setService({ workspace: address, serviceName: 'web', expectedRevision: 'absent', expected: { kind: 'absent' }, value: placement }))
                        .toMatchObject({ status: 'applied', revision: 0 });
                }
                return transport.mutate(input);
            },
        } });
        const initial = { enabled: false as const, unavailable: 'ask' as const, allowAdHoc: false, scriptOverrides: {} };
        const next = { ...initial, allowAdHoc: true };
        try {
            expect(await finiteClient.get({ workspace: address })).toMatchObject({ status: 'ready', revision: 'absent', provenance: 'default' });
            expect(await finiteClient.set({ workspace: address, expectedRevision: 'absent', expected: { kind: 'absent' }, next }))
                .toMatchObject({ status: 'applied', revision: 1, preference: next });
            const row = await app.inject({ method: 'POST', url: `${route}/read`, headers, payload: { address } });
            expect(row.statusCode).toBe(200);
            expect(row.json()).toMatchObject({ status: 'present', revision: 1 });
            expect(openWorkspaceExecutionConfigContentV1({ rowId: buildWorkspaceExecutionConfigRowIdV1(address), mode, material, content: row.json().content }))
                .toEqual({ ...next, services: { web: placement } });
            expect(await finiteClient.set({ workspace: address, expectedRevision: 'absent', expected: { kind: 'absent' }, next: { ...initial, unavailable: 'primary' } }))
                .toMatchObject({ status: 'conflict', revision: 1, preference: next });
            expect(await serviceClient.getService({ workspace: address, serviceName: 'web' })).toMatchObject({ status: 'ready', revision: 1, placement });
        } finally { await app.close(); }
    });
});
