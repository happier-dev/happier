import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openSqliteDatabaseSync } from '@happier-dev/plugin-sdk/fs';
import type { PluginDynamicResourceInvocationOptionsV1 } from '@happier-dev/plugin-sdk/resources';
import type { DatabaseDescriptorV1, DatabaseManualTargetV1, DatabaseWorktreeTargetV1 } from '@happier-dev/plugin-sdk/database';
import { openManualDatabaseConnection } from './connection.js';
import { createDatabaseConnectionResourceRuntime } from './resources.js';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const target: DatabaseManualTargetV1 = { kind: 'manual', accountId: 'alice', installationId: 'installation',
    projectKey: 'project', savedSecretId: 'selected-secret',
    workspace: { serverId: 'server', machineId: 'machine', workspaceId: 'workspace', rootPath: '/project' } };
const descriptor: DatabaseDescriptorV1 = { target, label: 'Selected database', engine: 'sqlite', origin: { label: 'Manual' },
    capabilities: [], access: { canRead: true, canWrite: true },
    placement: { serverId: 'server', accountId: 'alice', machineId: 'machine', installationId: 'installation' } };
const unavailable = () => { throw new Error('No Action or Resource port is used by the held connection'); };

describe('database connection Resource', () => {
    it('publishes the admitted worktree database subject in the snapshot and held Describe', async () => {
        const worktree: DatabaseWorktreeTargetV1 = {
            kind: 'worktree', accountId: target.accountId, installationId: target.installationId,
            projectKey: target.projectKey, workspace: target.workspace,
            source: { kind: 'env_file', path: '.env', variable: 'DATABASE_URL' },
        };
        const admitted: DatabaseDescriptorV1 = { ...descriptor, target: worktree, engine: 'postgresql' };
        const runtime = createDatabaseConnectionResourceRuntime({ async resolve() {
            return { descriptor: admitted, connection: { execute: unavailable, async close() {} } };
        } });
        const signal = new AbortController().signal;
        const options: PluginDynamicResourceInvocationOptionsV1 = {
            signal, context: { kind: 'surface', mountInstanceKey: 'worktree', launchInput: { operation: 'describe', target: worktree } },
            requesterAccount: { accountId: target.accountId }, secrets: { readSavedSecret: unavailable },
            resources: { describe: unavailable, read: unavailable, watch: unavailable, invokeDemand: unavailable, notifyDemands: unavailable },
            readAction: unavailable, observeAction: unavailable,
        };
        const producer = await runtime.createProducer!(options);
        const expected = {
            ...admitted, automationSubject: { ok: true, subject: { kind: 'database', serverId: 'server', target: worktree } },
        };
        try {
            expect(JSON.parse(String(await producer.read(options)))).toEqual({
                descriptor: expected, ownWriteRevision: 0, relationRevisions: [],
            });
            expect(await producer.invoke!({ operation: 'describe', target: worktree }, { signal })).toEqual({
                result: { ok: true, operation: 'describe', descriptor: expected },
                sourceScope: { serverId: 'server', machineId: 'machine' },
            });
        } finally { await producer.dispose(); }
    });

    it('retains revisions for two committed tables before a read and a separate unknown-table write', async () => {
        const unavailableSubject: DatabaseDescriptorV1 = {
            ...descriptor, automationSubject: { ok: false, code: 'subject_kind_unavailable' },
        };
        const directory = await mkdtemp(join(tmpdir(), 'dbw-demand-relations-')); directories.push(directory);
        const path = join(directory, 'selected.sqlite');
        const database = openSqliteDatabaseSync(path);
        database.exec('CREATE TABLE first(label TEXT); CREATE TABLE second(label TEXT);'); database.close();
        const secretValue = pathToFileURL(path).toString();
        const runtime = createDatabaseConnectionResourceRuntime({ async resolve(input) {
            return { descriptor: unavailableSubject, connection: await openManualDatabaseConnection({ target,
                secretValue: await input.secrets.readSavedSecret(target.savedSecretId), access: 'read', signal: input.signal }) };
        } });
        const controller = new AbortController();
        const options: PluginDynamicResourceInvocationOptionsV1 = { signal: controller.signal,
            context: { kind: 'surface', mountInstanceKey: 'selected', launchInput: { operation: 'describe', target } },
            requesterAccount: { accountId: 'alice' }, secrets: { async readSavedSecret() { return secretValue; } },
            resources: { describe: unavailable, read: unavailable, watch: unavailable, invokeDemand: unavailable, notifyDemands: unavailable },
            readAction: unavailable, observeAction: unavailable };
        const producer = await runtime.createProducer!(options);
        const write = await openManualDatabaseConnection({ target, secretValue, access: 'write' });
        const first = { schema: 'main', name: 'first' };
        const second = { schema: 'main', name: 'second' };
        try {
            for (const relation of [first, second, first]) {
                expect(await write.execute({ operation: 'edits.apply', target, relation,
                    changes: [{ kind: 'insert', values: [{ column: 'label', value: {
                        kind: 'value', cell: { type: 'text', value: 'committed' },
                    } }] }] })).toMatchObject({ ok: true });
                await producer.notify!({ target, relation });
            }
            await producer.notify!({ target: { ...target, savedSecretId: 'unrelated' }, relation: first });
            const relationRevisions = [{ relation: first, revision: 2 }, { relation: second, revision: 1 }];
            expect(JSON.parse(String(await producer.read(options))))
                .toEqual({ descriptor: unavailableSubject, ownWriteRevision: 0, relationRevisions });
            expect(await write.execute({ operation: 'statement.run', target, mode: 'write', executionMode: 'transaction',
                statements: [{ sql: "INSERT INTO first VALUES ('console')", parameters: [] }] })).toMatchObject({ ok: true });
            await producer.notify!({ target });
            expect(JSON.parse(String(await producer.read(options))))
                .toEqual({ descriptor: unavailableSubject, ownWriteRevision: 1, relationRevisions });
        } finally { await write.close(); controller.abort(); await producer.dispose(); }
    });

    it('resolves and acquires once, holds real SQLite reads, and publishes only the changed target', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'dbw-demand-')); directories.push(directory);
        const path = join(directory, 'selected.sqlite');
        const db = openSqliteDatabaseSync(path);
        db.exec("CREATE TABLE selected(label TEXT); INSERT INTO selected VALUES ('before');"); db.close();
        let acquisitions = 0;
        let resolutions = 0;
        const runtime = createDatabaseConnectionResourceRuntime({
            async resolve(input) {
                resolutions++;
                expect(input.requesterAccount.accountId).toBe('alice');
                const secretValue = await input.secrets.readSavedSecret(target.savedSecretId, { signal: input.signal });
                return { descriptor, connection: await openManualDatabaseConnection({ target, secretValue, access: 'read', signal: input.signal }) };
            },
        });
        const controller = new AbortController();
        const options: PluginDynamicResourceInvocationOptionsV1 = { signal: controller.signal,
            context: { kind: 'surface', mountInstanceKey: 'selected', launchInput: { operation: 'describe', target } },
            requesterAccount: { accountId: 'alice' }, secrets: { async readSavedSecret() { acquisitions++; return pathToFileURL(path).toString(); } },
            resources: { describe: unavailable, read: unavailable, watch: unavailable, invokeDemand: unavailable, notifyDemands: unavailable },
            readAction: unavailable, observeAction: unavailable };
        const producer = await runtime.createProducer!(options);
        let invalidations = 0;
        const observation = await producer.observe(() => { invalidations++; }, options);
        const published = {
            ...descriptor, automationSubject: { ok: true, subject: { kind: 'database', serverId: 'server', target } },
        };
        try {
            expect(JSON.parse(String(await producer.read(options)))).toEqual({ descriptor: published, ownWriteRevision: 0, relationRevisions: [] });
            expect(await producer.invoke!({ operation: 'describe', target }, { signal: controller.signal }))
                .toEqual({ result: { ok: true, operation: 'describe', descriptor: published }, sourceScope: { serverId: 'server', machineId: 'machine' } });
            const read = { operation: 'statement.run' as const, target, mode: 'read' as const,
                statement: { sql: 'SELECT label FROM selected', parameters: [] } };
            for (const operation of [
                { operation: 'schemas.list', target, page: { rows: 1 } },
                { operation: 'relations.list', target, schema: 'main', page: { rows: 1 } },
                { operation: 'relation.structure', target, relation: { schema: 'main', name: 'selected' } },
            ] as const) {
                expect(await producer.invoke!(operation, { signal: controller.signal }))
                    .toMatchObject({ result: { ok: true, operation: operation.operation } });
            }
            expect(await producer.invoke!(read, { signal: controller.signal }))
                .toMatchObject({ result: { ok: true, results: [{ rows: [{ cells: [{ type: 'text', value: 'before' }] }] }] } });
            await expect(producer.invoke!({ ...read, target: { ...target, savedSecretId: 'other' } }, { signal: controller.signal }))
                .rejects.toMatchObject({ code: 'database_demand_target_mismatch' });
            const write = await openManualDatabaseConnection({ target, secretValue: pathToFileURL(path).toString(), access: 'write' });
            try { expect(await write.execute({ operation: 'statement.run', target, mode: 'write', executionMode: 'transaction',
                statements: [{ sql: "UPDATE selected SET label='after'", parameters: [] }] })).toMatchObject({ ok: true }); }
            finally { await write.close(); }
            producer.notify!({ target: { ...target, savedSecretId: 'unrelated' } }); expect(invalidations).toBe(0);
            producer.notify!({ target }); expect(invalidations).toBe(1);
            expect(JSON.parse(String(await producer.read(options)))).toEqual({ descriptor: published, ownWriteRevision: 1, relationRevisions: [] });
            expect(await producer.invoke!(read, { signal: controller.signal }))
                .toMatchObject({ result: { ok: true, results: [{ rows: [{ cells: [{ type: 'text', value: 'after' }] }] }] } });
            expect({ acquisitions, resolutions }).toEqual({ acquisitions: 1, resolutions: 1 });
        } finally { observation.dispose(); controller.abort(); await producer.dispose(); }
        expect(await producer.invoke!({ operation: 'schemas.list', target, page: { rows: 1 } }, { signal: new AbortController().signal }))
            .toMatchObject({ result: { ok: false, code: 'database_connection_unavailable' } });
        const { requesterAccount: _requesterAccount, secrets: _secrets, ...withoutCustody } = options;
        await expect(runtime.createProducer!(withoutCustody))
            .rejects.toMatchObject({ code: 'plugin_resource_demand_unavailable' });
        expect(acquisitions).toBe(1);
    });
});
