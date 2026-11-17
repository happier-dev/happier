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
import { DATABASE_DESCRIBE_ACTION_ID_V1, DATABASE_TARGETS_LIST_ACTION_ID_V1, databaseActionLocalIdV1 } from '@happier-dev/database-protocol';
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

it('discovers the selected launched service from prepared originals, isolates custody and removes it on service release', async () => {
    const kit = await createPluginTestkit({ manifest: plugin.manifest, module: plugin, services: { storage } });
    try {
        const observer = kit.registration('serviceLaunchEnvironments', 'database-discovery');
        expect(observer, 'The enabled workbench must observe prepared service launch input').toBeDefined();
        if (!observer) throw new Error('Missing database discovery contribution');
        const original = 'postgresql://app:private-selected@localhost:5432/selected';
        const launch = {
            workspace: { id: 'selected', serverId: 'home', machineId: 'machine', rootPath: '/selected', projectKey: 'project' },
            project: { serverId: 'home', projectId: 'project' }, requester: { accountId: 'alice', installationId: 'installation' },
            serviceId: 'postgres', executionPlacement: { mode: 'spawn', machineId: 'machine' }, assignedPorts: {},
            async readEnvironment() { return { projectedEnvironment: { DATABASE_URL: 'postgresql://capture@localhost/replacement' }, provenance: {} }; },
            async readDeclaredEnvironment() { return { projectedEnvironment: { API_URL: 'https://api.example.test', CUSTOM_DATABASE: original },
                provenance: { CUSTOM_DATABASE: { source: 'dotenv', file: '.env' } } }; },
        } satisfies PluginServiceLaunchEnvironmentInputV1;
        const retained = await observer.prepare(launch);
        expect(retained).toMatchObject({ kind: 'replace' });
        const list = (selectedScope: typeof scope = scope) => kit.invokeAction(databaseActionLocalIdV1(DATABASE_TARGETS_LIST_ACTION_ID_V1),
            { scope: selectedScope }, identity);
        expect(await list()).toMatchObject({ targets: [{ engine: 'postgresql', target: { kind: 'worktree', ...scope,
            source: { kind: 'service', serviceId: 'postgres', variable: 'CUSTOM_DATABASE' } } }], completeness: { complete: true } });
        expect(JSON.stringify(await list())).not.toContain('private-selected');
        expect(JSON.stringify(await list())).not.toContain(original);
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
            executionPlacement: { mode: 'spawn', machineId: 'machine' }, assignedPorts: {},
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
        serviceId: 'sqlite-app', executionPlacement: { mode: 'spawn', machineId: 'machine' }, assignedPorts: {},
        async readEnvironment() { return { projectedEnvironment: { DATABASE_URL: pathToFileURL(path).toString() }, provenance: {} }; },
    });
    let connection: Awaited<ReturnType<typeof targets.resolve>>['connection'] | undefined;
    try {
        const request = { identity, requester: 'person' as const, input: { scope } };
        const listed = await targets.list(request);
        expect(listed.targets).toHaveLength(1);
        const target = listed.targets[0]!.target;
        const input = { operation: 'statement.run', target, mode: 'read', statement: { sql: 'SELECT label FROM selected', parameters: [] } } as const;
        const resolved = await targets.resolve({ identity, requester: 'person', input, access: 'read' });
        connection = resolved.connection;
        expect(resolved.descriptor).toEqual(listed.targets[0]);
        expect(await connection.execute(input)).toMatchObject({ ok: true,
            results: [{ rows: [{ cells: [{ type: 'text', value: 'prepared-original' }] }] }] });
        if (retained.kind === 'replace') await retained.release();
        await expect(targets.resolve({ identity, requester: 'person', input, access: 'read' }))
            .rejects.toMatchObject({ code: 'database_target_unavailable' });
    } finally {
        await connection?.close();
        if (retained.kind === 'replace') await retained.release();
        await rm(directory, { recursive: true, force: true });
    }
});
