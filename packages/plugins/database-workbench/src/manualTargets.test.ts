import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { openSqliteDatabaseSync } from '@happier-dev/plugin-sdk/fs';
import type { JsonValue } from '@happier-dev/plugin-sdk';
import { createCanonicalJsonSigningInput } from '@happier-dev/plugin-sdk';
import type { StorageScopeService } from '@happier-dev/plugin-sdk/storage';
import type { DatabaseManualTargetV1, DatabaseTargetV1 } from '@happier-dev/plugin-sdk/database';
import { DatabaseTargetsListInputV1Schema } from '@happier-dev/plugin-sdk/database';
import { DatabaseTargetsConnectInputV1Schema } from '@happier-dev/database-protocol';
import { createManualDatabaseTargets, type DatabaseManualIdentity, type DatabaseManualScope } from './manualTargets.js';
import type { DatabaseWorkbenchConnection } from './connection.js';

const directories: string[] = [];
const databases: DatabaseSync[] = [];
const connections: DatabaseWorkbenchConnection[] = [];
afterEach(async () => {
    await Promise.all(connections.splice(0).map(connection => connection.close()));
    for (const database of databases.splice(0)) database.close();
    await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

const identity = (accountId: string): DatabaseManualIdentity => ({ requesterAccount: { accountId }, chosenMachine: { machineId: 'machine', installationId: 'installation' } });
const scope = (accountId: string, projectKey = 'project', workspaceId = 'workspace', rootPath = '/project'): DatabaseManualScope => ({
    kind: 'worktree', accountId, installationId: 'installation', projectKey,
    workspace: { serverId: 'profile', machineId: 'machine', workspaceId, rootPath },
});

async function fixture() {
    const directory = await mkdtemp(join(tmpdir(), 'dbw-manual-store-')); directories.push(directory);
    const sqlite = new DatabaseSync(join(directory, 'daemon-kv.sqlite')); databases.push(sqlite);
    sqlite.exec('CREATE TABLE kv(key TEXT PRIMARY KEY,value TEXT NOT NULL)');
    const reads: string[] = [];
    const storage: Pick<StorageScopeService, 'get' | 'set' | 'delete' | 'list'> = {
        async get<T extends JsonValue = JsonValue>(key: string): Promise<T | null> {
            reads.push(key);
            const row = sqlite.prepare('SELECT value FROM kv WHERE key=?').get(key);
            // This fixture is the persistent KV system boundary; every payload was written as JSON below.
            return row ? JSON.parse(String(row.value)) as T : null;
        },
        async set(key, value) { sqlite.prepare('INSERT INTO kv VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value)); },
        async delete(key) { sqlite.prepare('DELETE FROM kv WHERE key=?').run(key); },
        async list(options) {
            reads.push(options?.prefix ?? '');
            const prefix = options?.prefix ?? '';
            const rows = sqlite.prepare('SELECT key FROM kv WHERE substr(key,1,length(?))=? AND key>? ORDER BY key LIMIT 2').all(prefix, prefix, options?.cursor ?? '');
            const items = rows.slice(0, 1).map(row => ({ key: String(row.key) }));
            return { items, ...(rows.length > 1 ? { nextCursor: items[0]!.key } : {}) };
        },
    };
    const path = join(directory, 'selected database.sqlite');
    const database = openSqliteDatabaseSync(path);
    database.exec("CREATE TABLE selected(id INTEGER PRIMARY KEY,label TEXT); INSERT INTO selected VALUES(1,'original');"); database.close();
    const secretValue = pathToFileURL(path).toString();
    const acquisitions: string[] = [];
    const secrets = { async readSavedSecret(ref: string) { acquisitions.push(ref); return secretValue; } };
    return { storage, sqlite, reads, secrets, acquisitions, secretValue };
}

function manual(target: DatabaseTargetV1): DatabaseManualTargetV1 {
    if (target.kind !== 'manual') throw new Error('Expected the selected manual association');
    return target;
}

describe('manual target associations in the persistent daemon KV boundary', () => {
    it('lists a Project across worktrees without acquiring secrets or disclosing another scope', async () => {
        const state = await fixture();
        const owner = createManualDatabaseTargets({ storage: state.storage, identity: identity('owner') });
        const first = scope('owner');
        const second = scope('owner', 'project', 'second', '/second');
        // Persisted v1 KV boundary fixture; listing must work without opening a driver.
        const associate = async (selected: DatabaseManualScope, savedSecretId: string, label: string) => {
            const key = `manual-targets/v1/${encodeURIComponent(createCanonicalJsonSigningInput(selected))}/${encodeURIComponent(savedSecretId)}`;
            await state.storage.set(key, { target: { ...selected, kind: 'manual', savedSecretId },
                label, engine: 'sqlite', agentAccess: 'none' });
        };
        await associate(first, 'first', 'First checkout');
        await associate(second, 'second', 'Second checkout');
        await associate(scope('owner', 'another-project'), 'other', 'Other Project');
        const visitor = createManualDatabaseTargets({ storage: state.storage, identity: identity('visitor') });
        await associate(scope('visitor'), 'visitor', 'Other Account');
        await associate({ ...first, installationId: 'another-installation' }, 'foreign-install', 'Other installation');
        const before = state.acquisitions.length;
        const input = DatabaseTargetsListInputV1Schema.parse({ scope: {
            kind: 'project', accountId: 'owner', installationId: 'installation', projectKey: 'project',
        } });
        const listed = await owner.list({ input, requester: 'person' });
        expect(DatabaseTargetsConnectInputV1Schema.safeParse({ ...input, savedSecretRef: 'first', label: 'Selected' }).success).toBe(false);
        expect(listed.targets.map(target => target.label).sort()).toEqual(['First checkout', 'Second checkout']);
        expect(listed.completeness).toEqual({ complete: true });
        expect(state.acquisitions).toHaveLength(before);
        expect((await owner.list({ input: { scope: first }, requester: 'person' })).targets.map(target => target.label)).toEqual(['First checkout']);
        const beforeReads = state.reads.length;
        await expect(visitor.list({ input, requester: 'person' })).rejects.toMatchObject({ code: 'database_target_unavailable' });
        await expect(owner.list({ input: DatabaseTargetsListInputV1Schema.parse({ scope: {
            kind: 'project', accountId: 'owner', installationId: 'another-installation', projectKey: 'project',
        } }), requester: 'person' }))
            .rejects.toMatchObject({ code: 'database_target_unavailable' });
        expect(state.reads).toHaveLength(beforeReads);
        expect(state.acquisitions).toHaveLength(before);
    });

    it('reports unavailable host custody once rather than borrowing target identity', async () => {
        const state = await fixture();
        expect(() => createManualDatabaseTargets({ storage: state.storage, identity: undefined })).toThrow(expect.objectContaining({ code: 'plugin_service_unavailable' }));
        expect(() => createManualDatabaseTargets({ storage: undefined, identity: identity('owner') })).toThrow(expect.objectContaining({ code: 'plugin_service_unavailable' }));
        expect(() => createManualDatabaseTargets({ storage: state.storage, identity: { requesterAccount: { accountId: 'owner' } } })).toThrow(expect.objectContaining({ code: 'plugin_service_unavailable' }));
        const owner = createManualDatabaseTargets({ storage: state.storage, identity: identity('owner') });
        await expect(owner.list({ input: { scope: scope('owner') }, requester: undefined })).rejects.toMatchObject({ code: 'plugin_service_unavailable' });
        expect(state.reads).toEqual([]);
        expect(state.acquisitions).toEqual([]);
    });

    it('verifies Connect once, persists only association metadata, and lists selected scope without acquiring secrets', async () => {
        const state = await fixture();
        const owner = createManualDatabaseTargets({ storage: state.storage, identity: identity('owner') });
        const connected = await owner.connect({ scope: scope('owner'), savedSecretId: 'selected-secret', label: 'Selected database', agentAccess: 'none', secrets: state.secrets });
        expect(connected).toMatchObject({ engine: 'sqlite', target: { savedSecretId: 'selected-secret' } });
        expect(connected.capabilities).toContainEqual({ operation: 'rows.read', available: true });
        expect(state.acquisitions).toEqual(['selected-secret']);
        await owner.connect({ scope: scope('owner'), savedSecretId: 'second-secret', label: 'Second database', agentAccess: 'read', secrets: state.secrets });
        await owner.connect({ scope: scope('owner', 'other-project'), savedSecretId: 'other-secret', label: 'Other database', agentAccess: 'none', secrets: state.secrets });
        const before = state.acquisitions.length;
        const listed = await owner.list({ input: { scope: scope('owner') }, requester: 'person' });
        expect(listed.targets.map(target => target.label).sort()).toEqual(['Second database', 'Selected database']);
        for (const target of listed.targets) expect(target.capabilities).toEqual(connected.capabilities);
        expect(listed.completeness).toEqual({ complete: true });
        expect(state.acquisitions).toHaveLength(before);
        const records = state.sqlite.prepare('SELECT value FROM kv').all().map(row => JSON.parse(String(row.value)) as Record<string, unknown>);
        for (const record of records) expect(Object.keys(record).sort()).toEqual(['agentAccess', 'engine', 'label', 'target']);
        expect(JSON.stringify(records)).not.toContain(state.secretValue);
        expect(JSON.stringify(listed)).not.toContain(state.secretValue);
        await owner.forget({ target: manual(connected.target) });
        expect((await owner.list({ input: { scope: scope('owner') }, requester: 'person' })).targets.map(target => target.label)).toEqual(['Second database']);
        expect(state.acquisitions).toHaveLength(before);
    });

    it('rejects another Account or executing Machine before any KV or secret read, and requires the selected stored association', async () => {
        const state = await fixture();
        const owner = createManualDatabaseTargets({ storage: state.storage, identity: identity('owner') });
        const visitor = createManualDatabaseTargets({ storage: state.storage, identity: identity('visitor') });
        const connected = await owner.connect({ scope: scope('owner'), savedSecretId: 'selected-secret', label: 'Owner database', agentAccess: 'none', secrets: state.secrets });
        const target = manual(connected.target);
        const beforeReads = state.reads.length; const beforeAcquisitions = state.acquisitions.length;
        await expect(visitor.list({ input: { scope: scope('owner') }, requester: 'person' })).rejects.toMatchObject({ code: 'database_target_unavailable' });
        await expect(visitor.resolve({ input: { operation: 'describe', target }, access: 'read', requester: 'person', secrets: state.secrets })).rejects.toMatchObject({ code: 'database_target_unavailable' });
        await expect(owner.resolve({ input: { operation: 'describe', target: { ...target, installationId: 'foreign-installation' } }, access: 'read', requester: 'person', secrets: state.secrets })).rejects.toMatchObject({ code: 'database_target_unavailable' });
        await expect(owner.resolve({ input: { operation: 'describe', target: { ...target, workspace: { serverId: 'profile', workspaceId: 'workspace', rootPath: '/project', machineId: 'foreign-machine' } } }, access: 'read', requester: 'person', secrets: state.secrets })).rejects.toMatchObject({ code: 'database_target_unavailable' });
        expect(state.reads).toHaveLength(beforeReads);
        expect(state.acquisitions).toHaveLength(beforeAcquisitions);
        expect((await visitor.list({ input: { scope: scope('visitor') }, requester: 'person' })).targets).toEqual([]);
        await expect(owner.resolve({ input: { operation: 'describe', target: { ...target, savedSecretId: 'unassociated-secret' } }, access: 'read', requester: 'person', secrets: state.secrets })).rejects.toMatchObject({ code: 'database_target_unavailable' });
        expect(state.acquisitions).toHaveLength(beforeAcquisitions);
    });

    it('honors P3 access and opens read demand read-only even when the person can write', async () => {
        const state = await fixture();
        const owner = createManualDatabaseTargets({ storage: state.storage, identity: identity('owner') });
        const connected = await owner.connect({ scope: scope('owner'), savedSecretId: 'selected-secret', label: 'Selected database', agentAccess: 'none', secrets: state.secrets });
        const target = manual(connected.target);
        await expect(owner.resolve({ input: { operation: 'describe', target }, access: 'read', requester: 'agent', secrets: state.secrets })).rejects.toMatchObject({ code: 'database_agent_access_none' });
        const before = state.acquisitions.length;
        const read = await owner.resolve({ input: { operation: 'describe', target }, access: 'read', requester: 'person', secrets: state.secrets }); connections.push(read.connection);
        expect(read.descriptor.access).toMatchObject({ canRead: true, canWrite: true });
        expect(state.acquisitions.slice(before)).toEqual(['selected-secret']);
        const write = { operation: 'statement.run' as const, target, mode: 'write' as const, executionMode: 'transaction' as const, statements: [{ sql: "UPDATE selected SET label='changed'", parameters: [] }] };
        expect(await read.connection.execute(write)).toMatchObject({ ok: false });
        const writable = await owner.resolve({ input: write, access: 'write', requester: 'person', secrets: state.secrets }); connections.push(writable.connection);
        expect(await writable.connection.execute(write)).toMatchObject({ ok: true });
        await owner.connect({ scope: scope('owner'), savedSecretId: 'selected-secret', label: 'Selected database', agentAccess: 'read', secrets: state.secrets });
        const agent = await owner.resolve({ input: { operation: 'describe', target }, access: 'read', requester: 'agent', secrets: state.secrets }); connections.push(agent.connection);
        expect(agent.descriptor.access).toMatchObject({ canRead: true, canWrite: false, reason: 'database_agent_access_read_only' });
        expect(await agent.connection.execute({ operation: 'statement.run', target, mode: 'read', statement: { sql: 'SELECT label FROM selected', parameters: [] } })).toMatchObject({ ok: true, results: [{ rows: [{ cells: [{ type: 'text', value: 'changed' }] }] }] });
        await expect(owner.resolve({ input: write, access: 'write', requester: 'agent', secrets: state.secrets })).rejects.toMatchObject({ code: 'database_agent_access_read_only' });
    });
});
