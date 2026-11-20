import { expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openSqliteDatabaseSync } from '@happier-dev/plugin-sdk/fs';
import { createWorktreeDatabaseTargets } from './worktreeTargets.js';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import type { PluginServiceLaunchEnvironmentInputV1 } from '@happier-dev/plugin-sdk';
import type { StorageScopeService } from '@happier-dev/plugin-sdk/storage';
import { DATABASE_ACCESS_READ_ACTION_ID_V1, DATABASE_ACCESS_SET_ACTION_ID_V1, DATABASE_DESCRIBE_ACTION_ID_V1,
    DATABASE_TARGETS_LIST_ACTION_ID_V1, databaseActionLocalIdV1 } from '@happier-dev/database-protocol';
import { plugin } from './manifest.js';

// The daemon KV is the persistent boundary; discovery and Action handlers stay real.
const emptyStorage: StorageScopeService = {
    async get() { return null; }, async set() {}, async delete() {}, async list() { return { items: [] }; },
    consistency() { return { kind: 'authoritativeSerializable' }; }, async transaction(run) { return run(emptyStorage); },
};
const storage = { daemon: { ...emptyStorage, async database(): Promise<never> { throw new Error('No database requested'); } },
    daemonSession: emptyStorage, ephemeral: emptyStorage };
const identity = { requesterAccount: { accountId: 'alice' }, chosenMachine: { machineId: 'machine', installationId: 'installation' },
    agentCaller: false, authority: 'present_user' as const };
const workspace = { serverId: 'home', machineId: 'machine', workspaceId: 'selected', rootPath: '/selected' };
const scope = { kind: 'worktree', accountId: 'alice', installationId: 'installation', projectKey: 'project', workspace } as const;

it('reports the missing host fact and recovery when discovery has no admitted Machine', async () => {
    const targets = createWorktreeDatabaseTargets();
    await expect(targets.list({ input: { scope }, identity: { requesterAccount: identity.requesterAccount },
        storage: emptyStorage, requester: 'person' })).rejects.toMatchObject({
        code: 'plugin_service_unavailable',
        details: { reason: 'database_host_identity_unavailable', missing: ['chosenMachine'],
            recovery: 'Reconnect the Machine and retry the database action.' },
        remediation: { kind: 'retry' },
    });
});

it('discovers the selected launched service from prepared originals, isolates custody and removes it on service release', async () => {
    let accessReads = 0;
    const measuredStorage = { ...storage, daemon: { ...storage.daemon, async get() { accessReads++; return null; } } };
    const kit = await createPluginTestkit({ manifest: plugin.manifest, module: plugin, services: { storage: measuredStorage } });
    const observer = kit.registration('serviceLaunchEnvironments', 'database-discovery');
    let release: (() => Promise<void>) | undefined;
    try {
        expect(observer, 'The enabled workbench must observe prepared service launch input').toBeDefined();
        if (!observer) throw new Error('Missing database discovery contribution');
        const original = 'postgresql://app:private-selected@localhost:5432/selected';
        const unrelatedVariables = Object.fromEntries(Array.from({ length: 24 }, (_, i) => [`APP_SETTING_${i}`, `value-${i}`]));
        const launch = {
            workspace: { id: 'selected', serverId: 'home', machineId: 'machine', rootPath: '/selected', projectKey: 'project' },
            project: { serverId: 'home', projectId: 'project' }, requester: { accountId: 'alice', installationId: 'installation' },
            serviceId: 'postgres', physicalRootIdentity: '/physical/selected', executionPlacement: { mode: 'spawn', machineId: 'machine' }, assignedPorts: {},
            async readEnvironment() { return { projectedEnvironment: { DATABASE_URL: 'postgresql://capture@localhost/replacement' }, provenance: {} }; },
            async readDeclaredEnvironment() { return { projectedEnvironment: { ...unrelatedVariables, API_URL: 'https://api.example.test', CUSTOM_DATABASE: original },
                provenance: { CUSTOM_DATABASE: { source: 'dotenv', file: '.env' } } }; },
        } satisfies PluginServiceLaunchEnvironmentInputV1;
        const retained = await observer.prepare(launch);
        if (retained.kind === 'replace') release = () => retained.release();
        expect(retained).toMatchObject({ kind: 'replace' });
        const list = (selectedScope: typeof scope = scope) => kit.invokeAction(databaseActionLocalIdV1(DATABASE_TARGETS_LIST_ACTION_ID_V1),
            { scope: selectedScope }, identity);
        const result = await list();
        expect(result).toMatchObject({ targets: [{ engine: 'postgresql', access: { canRead: true, canWrite: true }, target: { ...scope,
            source: { kind: 'service', serviceId: 'postgres', variable: 'CUSTOM_DATABASE' } } }], completeness: { complete: true } });
        expect(accessReads).toBe(1);
        expect(JSON.stringify(result)).not.toContain('private-selected');
        expect(JSON.stringify(result)).not.toContain(original);
        await expect(kit.invokeAction(databaseActionLocalIdV1(DATABASE_DESCRIBE_ACTION_ID_V1), {
            operation: 'describe',
            target: { ...scope, source: { kind: 'service', serviceId: 'postgres', variable: 'API_URL' } },
        }, identity)).rejects.toMatchObject({ code: 'database_target_unavailable' });
        expect(await kit.invokeAction(databaseActionLocalIdV1(DATABASE_TARGETS_LIST_ACTION_ID_V1), {
            scope: { ...scope, workspace: { ...workspace, workspaceId: 'neighbor', rootPath: '/neighbor' } },
        }, identity)).toMatchObject({ targets: [] });
        await expect(kit.invokeAction(databaseActionLocalIdV1(DATABASE_TARGETS_LIST_ACTION_ID_V1), {
            scope: { ...scope, accountId: 'bob' },
        }, identity)).rejects.toMatchObject({ code: 'database_target_unavailable' });
        if (retained.kind === 'replace') await retained.release();
        expect(await list()).toMatchObject({ targets: [] });
    } finally { await kit.dispose(); }
});

it('does not expose another Account launch or turn missing prepared identity into a database target', async () => {
    const kit = await createPluginTestkit({ manifest: plugin.manifest, module: plugin, services: { storage } });
    try {
        const observer = kit.registration('serviceLaunchEnvironments', 'database-discovery');
        expect(observer).toBeDefined();
        if (!observer) throw new Error('Missing database discovery contribution');
        const launch = { workspace: { id: 'selected', serverId: 'home', machineId: 'machine', rootPath: '/selected', projectKey: 'project' },
            project: { serverId: 'home', projectId: 'project' }, serviceId: 'postgres',
            physicalRootIdentity: '/physical/selected', executionPlacement: { mode: 'spawn', machineId: 'machine' }, assignedPorts: {},
            async readEnvironment() { return { projectedEnvironment: { DATABASE_URL: 'postgresql://app:neighbor@localhost/neighbor' }, provenance: {} }; },
        } satisfies PluginServiceLaunchEnvironmentInputV1;
        expect(await observer.prepare(launch)).toEqual({ kind: 'unchanged' });
        const retained = await observer.prepare({ ...launch, requester: { accountId: 'bob', installationId: 'installation' } });
        try {
            expect(await kit.invokeAction(databaseActionLocalIdV1(DATABASE_TARGETS_LIST_ACTION_ID_V1), { scope }, identity))
                .toMatchObject({ targets: [] });
        } finally { if (retained.kind === 'replace') await retained.release(); }
    } finally { await kit.dispose(); }
});


it('resolves the discovered service original into a native operation and withdraws it on release', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dbw-discovered-'));
    const path = join(directory, 'selected.sqlite');
    const db = openSqliteDatabaseSync(path);
    db.exec("CREATE TABLE selected(label TEXT); INSERT INTO selected VALUES ('prepared-original');"); db.close();
    const targets = createWorktreeDatabaseTargets();
    const retained = await targets.launch.prepare({
        workspace: { id: 'selected', serverId: 'home', machineId: 'machine', rootPath: '/selected', projectKey: 'project' },
        project: { serverId: 'home', projectId: 'project' }, requester: { accountId: 'alice', installationId: 'installation' },
        serviceId: 'sqlite-app', physicalRootIdentity: '/physical/selected', executionPlacement: { mode: 'spawn', machineId: 'machine' }, assignedPorts: {},
        async readEnvironment() { return { projectedEnvironment: { DATABASE_URL: pathToFileURL(path).toString() }, provenance: {} }; },
    });
    let connection: Awaited<ReturnType<typeof targets.resolve>>['connection'] | undefined;
    try {
        const request = { identity, storage: emptyStorage, requester: 'person' as const, input: { scope } };
        const listed = await targets.list(request);
        expect(listed.targets).toHaveLength(1);
        const target = listed.targets[0]!.target;
        const input = {
            operation: 'statement.run', target, mode: 'read',
            statement: { sql: 'SELECT label FROM selected', parameters: [] },
        } satisfies Parameters<typeof targets.resolve>[0]['input'];
        const resolved = await targets.resolve({ identity, storage: emptyStorage, requester: 'person', input, access: 'read' });
        connection = resolved.connection;
        expect(resolved.descriptor).toEqual(listed.targets[0]);
        expect(await connection.execute(input)).toMatchObject({ ok: true,
            results: [{ rows: [{ cells: [{ type: 'text', value: 'prepared-original' }] }] }] });
        if (retained.kind === 'replace') await retained.release();
        await expect(targets.resolve({ identity, storage: emptyStorage, requester: 'person', input, access: 'read' }))
            .rejects.toMatchObject({ code: 'database_target_unavailable' });
    } finally {
        await connection?.close();
        if (retained.kind === 'replace') await retained.release();
        await rm(directory, { recursive: true, force: true });
    }
});

it('stores the worktree database agent level on this Machine: Read & write (asks first) by default, set by its owner', async () => {
    // The daemon KV is the persistent boundary; a Map keeps its get/set contract.
    const values = new Map<string, unknown>();
    const kv: StorageScopeService = {
        async get(key) { return values.has(key) ? values.get(key) as never : null; },
        async set(key, value) { values.set(key, value); }, async delete(key) { values.delete(key); },
        async list() { return { items: [...values.keys()].map(key => ({ key })) } as never; },
        consistency() { return { kind: 'authoritativeSerializable' }; }, async transaction(run) { return run(kv); },
    };
    const stateful = { ...storage, daemon: { ...kv, async database(): Promise<never> { throw new Error('No database requested'); } } };
    const kit = await createPluginTestkit({ manifest: plugin.manifest, module: plugin, services: { storage: stateful } });
    const agent = { ...identity, agentCaller: true };
    try {
        const observer = kit.registration('serviceLaunchEnvironments', 'database-discovery');
        if (!observer) throw new Error('Missing database discovery contribution');
        const retained = await observer.prepare({
            workspace: { id: 'selected', serverId: 'home', machineId: 'machine', rootPath: '/selected', projectKey: 'project' },
            project: { serverId: 'home', projectId: 'project' }, requester: { accountId: 'alice', installationId: 'installation' },
            serviceId: 'postgres', physicalRootIdentity: '/physical/selected', executionPlacement: { mode: 'spawn', machineId: 'machine' }, assignedPorts: {},
            async readEnvironment() { return { projectedEnvironment: { DATABASE_URL: 'postgresql://app:secret@localhost:5432/selected' }, provenance: {} }; },
        });
        try {
            const target = { ...scope, source: { kind: 'service', serviceId: 'postgres', variable: 'DATABASE_URL' } } as const;
            const read = (who: typeof identity) => kit.invokeAction(databaseActionLocalIdV1(DATABASE_ACCESS_READ_ACTION_ID_V1), { target }, who);
            const set = (agentAccess: string, who: typeof identity = identity) =>
                kit.invokeAction(databaseActionLocalIdV1(DATABASE_ACCESS_SET_ACTION_ID_V1), { target, agentAccess }, who);
            expect(await read(agent)).toEqual({ setBy: 'machine', agentAccess: 'readWriteAsk', access: { canRead: true, canWrite: true } });
            expect(await set('readWriteNoApproval')).toEqual({ ok: true, agentAccess: 'readWriteNoApproval' });
            expect(await read(agent)).toMatchObject({ agentAccess: 'readWriteNoApproval' });
            expect(await set('none')).toEqual({ ok: true, agentAccess: 'none' });
            expect(await read(identity)).toMatchObject({ setBy: 'machine', agentAccess: 'none' });
            await expect(kit.invokeAction(databaseActionLocalIdV1(DATABASE_DESCRIBE_ACTION_ID_V1), { operation: 'describe', target }, agent))
                .rejects.toMatchObject({ code: 'database_agent_access_none' });
            // Another person's Account never reaches this Machine-local record.
            await expect(set('read', { ...identity, requesterAccount: { accountId: 'bob' } }))
                .rejects.toMatchObject({ code: 'database_target_unavailable' });
            expect(await set('none')).toEqual({ ok: true, agentAccess: 'none' });
            expect(values.size).toBe(1);
            expect(JSON.stringify([...values])).not.toContain('secret');
        } finally { if (retained.kind === 'replace') await retained.release(); }
    } finally { await kit.dispose(); }
});

it('resolves a selected env file target without a running service', async () => {
    const rootPath = await mkdtemp(join(tmpdir(), 'dbw-env-file-'));
    const path = '.env.local';
    const dbPath = join(rootPath, 'selected.sqlite');
    const target = { ...scope, workspace: { ...workspace, rootPath },
        source: { kind: 'env_file', path, variable: 'DATABASE_URL' } } as const;
    try {
        openSqliteDatabaseSync(dbPath).close();
        const targets = createWorktreeDatabaseTargets();
        const request = { identity, storage: emptyStorage, requester: 'person' as const, access: 'read' as const,
            input: { operation: 'describe' as const, target },
            // The daemon's private prepared input is a system boundary for the plugin.
            worktreeEnvironment: { async readDotenv() { return pathToFileURL(dbPath).href; } } };
        expect(await targets.admit(request)).toMatchObject({ agentAccess: 'readWriteAsk' });
        const resolved = await targets.resolve(request);
        try {
            expect(resolved.descriptor).toMatchObject({ engine: 'sqlite', target });
        } finally { await resolved.connection.close(); }
    } finally { await rm(rootPath, { recursive: true, force: true }); }
});

it('returns the typed unavailable refusal for a missing env file variable', async () => {
    const targets = createWorktreeDatabaseTargets();
    const target = { ...scope, source: { kind: 'env_file', path: '.env.local', variable: 'MISSING_DATABASE_URL' } } as const;
    const request = { identity, storage: emptyStorage, requester: 'person' as const, access: 'read' as const,
        input: { operation: 'describe' as const, target },
        worktreeEnvironment: { async readDotenv() { return undefined; } } };
    await expect(targets.admit(request)).rejects.toMatchObject({ code: 'database_target_unavailable' });
});
