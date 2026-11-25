import { describe, expect, it } from 'vitest';
import { definePlugin, type JsonValue } from '@happier-dev/plugin-sdk';
import type { StorageScopeService } from '@happier-dev/plugin-sdk/storage';
import { createPluginTestkit, createTestResourceInvocationContext } from '@happier-dev/plugin-sdk/testing';
import {
    DatabaseFindingsListResultV1Schema,
    DatabaseFindingReadResultV1Schema,
    DatabaseFindingBriefBuildResultV1Schema,
    type DatabaseTargetV1,
} from '@happier-dev/plugin-sdk/database';
import {
    DATABASE_INSIGHTS_FINDINGS_LIST_ACTION_ID_V1,
    DATABASE_INSIGHTS_FINDINGS_DISMISS_ACTION_ID_V1,
    DATABASE_INSIGHTS_FINDINGS_READ_ACTION_ID_V1,
    DATABASE_INSIGHTS_BRIEF_BUILD_ACTION_ID_V1,
} from '@happier-dev/database-protocol';
import { databaseActionLocalIdV1 } from '@happier-dev/database-protocol';
import { createDatabaseActions } from '../actions.js';
import { createDatabaseRuntime } from '../runtime.js';
import { createDatabaseConnectionResourceRuntime } from '../resources.js';
import { createDatabaseInsightProducers } from './findings.js';
import { createNativeFindingFixture, target, invocation } from './nativeFixture.testkit.js';

function createDismissalStorageFixture() {
    const entries = new Map<string, JsonValue>();
    const storage: StorageScopeService = {
        async get<T extends JsonValue = JsonValue>(key: string) { return (entries.get(key) ?? null) as T | null; },
        async set(key, value) { entries.set(key, value); },
        async delete(key) { entries.delete(key); },
        async list() { return { items: [...entries.keys()].map(key => ({ key })) }; },
        consistency() { return { kind: 'authoritativeSerializable' }; },
        async transaction(run) { return run(storage); },
    };
    return { entries, storage: {
            daemon: { ...storage, async database(): Promise<never> { throw new Error('No daemon database requested'); } },
            daemonSession: storage, ephemeral: storage,
        } };
}

describe('selected native finding identity', () => {
    it.each([false, true])('uses the serving placement for an Environment finding with no caller Machine (held demand: %s)', async held => {
        const native = await createNativeFindingFixture();
        const selected = { kind: 'deployment_service', environment: { serverId: 'server', projectSourceId: 'project', environmentId: 'environment' },
            deploymentId: 'deployed', targetLinkId: 'link', serviceId: 'postgres', database: 'main' } satisfies DatabaseTargetV1;
        const sourceScope = { serverId: 'server', machineId: 'database-worker' };
        const resolve = async () => {
            // The driver boundary supplies a real SQLite connection in place of the deployment connection.
            const { descriptor, connection } = await native.resolve();
            return { descriptor: { ...descriptor, target: selected, placement: { ...descriptor.placement, ...sourceScope } }, connection };
        };
        const admit = async () => {};
        const runtime = createDatabaseRuntime({ resolve, admit });
        const plugin = definePlugin({ id: 'happier.database', version: '0.0.0', actions: createDatabaseActions({
            ...runtime, ...createDatabaseInsightProducers({ executeResolvedOperation: runtime.executeResolvedOperation, admit }),
        }) });
        const context = createTestResourceInvocationContext({
            requesterAccount: { accountId: 'alice' },
            secrets: { async readSavedSecret() { throw new Error('The deployment target supplies its own connection'); } },
            context: { kind: 'surface', mountInstanceKey: 'environment', launchInput: { operation: 'describe', target: selected } },
        });
        const producer = held ? await createDatabaseConnectionResourceRuntime({ resolve }).createProducer!(context) : undefined;
        const kit = await createPluginTestkit({ manifest: plugin.manifest, module: plugin,
            services: {
                logger: { debug() {}, info() {}, warn() {}, error() {}, diagnostic() {} },
                storage: createDismissalStorageFixture().storage,
                resources: { ...context.resources, async invokeDemand(request, options) {
                    return producer!.invoke!(request.input, { signal: options?.signal ?? context.signal });
                } },
            } });
        try {
            const result = await kit.invokeAction(databaseActionLocalIdV1(DATABASE_INSIGHTS_FINDINGS_LIST_ACTION_ID_V1),
                { target: selected, ...(held ? { subscriptionId: 'selected' } : {}),
                    request: { kind: 'stats.read', group: 'tables', selection: { schema: 'main', page: { rows: 20 } } } },
                { requesterAccount: { accountId: 'alice' } });
            expect(result).toMatchObject({ ok: true, observation: { sourceScope, summary: { records: 2 } } });
            expect(native.sqlReads()).toBe(1);
        } finally { await producer?.dispose(); await kit.dispose(); await native.dispose(); }
    });

    it('retains only an explicit dismissal across separate samples and isolates the requesting Account', async () => {
        const native = await createNativeFindingFixture();
        const { entries, storage } = createDismissalStorageFixture();
        const producers = createDatabaseInsightProducers({ async executeResolvedOperation(input) {
            const { descriptor, connection } = await native.resolve();
            const { serverId, machineId } = descriptor.placement;
            try {
                const result = await connection.execute(input);
                return { result, sourceScope: { serverId, machineId } };
            } finally { await connection.close(); }
        }, async admit() {} });
        const plugin = definePlugin({ id: 'happier.database', version: '0.0.0', actions: createDatabaseActions(producers) });
        const kit = await createPluginTestkit({ manifest: plugin.manifest, module: plugin, services: { storage } });
        const alice = { ...invocation, requesterAccount: { accountId: 'alice' }, authority: 'present_user' as const };
        const bob = { ...alice, requesterAccount: { accountId: 'bob' } };
        const input = { target, request: { kind: 'stats.read', group: 'tables', selection: { schema: 'main', page: { rows: 20 } } } };
        const listId = databaseActionLocalIdV1(DATABASE_INSIGHTS_FINDINGS_LIST_ACTION_ID_V1);
        const dismissId = databaseActionLocalIdV1(DATABASE_INSIGHTS_FINDINGS_DISMISS_ACTION_ID_V1);
        async function list(caller: typeof alice) {
            const result = DatabaseFindingsListResultV1Schema.parse(await kit.invokeAction(listId, input, caller));
            if (!result.ok) throw new Error(result.code);
            return result.findings;
        }
        try {
            const first = await list(alice);
            expect(first).toHaveLength(2);
            expect(entries.size).toBe(0);
            expect(first[0]).toMatchObject({ dismissalKey: expect.any(String) });
            await expect(kit.invokeAction(dismissId, { target, dismissalKey: first[0]!.dismissalKey! }, alice))
                .resolves.toEqual({ ok: true });
            expect(await list(alice)).toEqual(first.slice(1));
            expect(await list(bob)).toMatchObject(first.map(({ recordKey }) => ({ recordKey })));
            expect([...entries.values()]).toEqual([true]);
        } finally { await kit.dispose(); await native.dispose(); }
    });

    it.each(['tables', 'indexes'] as const)('retains selected %s identity through Action results and brief evidence', async group => {
        const native = await createNativeFindingFixture();
        const producers = createDatabaseInsightProducers({ async executeResolvedOperation(input) {
            const { descriptor, connection } = await native.resolve();
            const { serverId, machineId } = descriptor.placement;
            try {
                const result = await connection.execute(input);
                return { result, sourceScope: { serverId, machineId } };
            } finally { await connection.close(); }
        }, async admit() {} });
        const plugin = definePlugin({ id: 'happier.database', version: '0.0.0', actions: createDatabaseActions(producers) });
        const kit = await createPluginTestkit({ manifest: plugin.manifest, module: plugin });
        try {
            const input = { target, request: { kind: 'stats.read' as const, group, selection: { schema: 'main', page: { rows: 20 } } } };
            const list = DatabaseFindingsListResultV1Schema.parse(await kit.invokeAction(databaseActionLocalIdV1(DATABASE_INSIGHTS_FINDINGS_LIST_ACTION_ID_V1), input, invocation));
            if (!list.ok) throw new Error(`Finding read failed: ${list.code}`);
            const identities = group === 'tables' ? [
                { kind: 'table', relation: { schema: 'main', name: 'first' } },
                { kind: 'table', relation: { schema: 'main', name: 'second' } },
            ] : [
                { kind: 'index', relation: { schema: 'main', name: 'first' }, name: 'first_a' },
                { kind: 'index', relation: { schema: 'main', name: 'first' }, name: 'first_b' },
            ];
            expect(list.findings).toMatchObject(identities.map(object => ({ object })));
            for (const [index, selected] of list.findings.entries()) {
                const detailInput = { target, request: { kind: 'stats.read' as const, group,
                    selection: { relation: identities[index]!.relation } }, recordKey: selected.recordKey };
                const detail = DatabaseFindingReadResultV1Schema.parse(await kit.invokeAction(databaseActionLocalIdV1(DATABASE_INSIGHTS_FINDINGS_READ_ACTION_ID_V1), detailInput, invocation));
                if (!detail.ok) throw new Error(`Finding detail failed: ${detail.code}`);
                expect(detail.finding).toMatchObject({ object: identities[index], verification: { read: { group, selection: { relation: identities[index]!.relation } } } });
                const brief = DatabaseFindingBriefBuildResultV1Schema.parse(await kit.invokeAction(databaseActionLocalIdV1(DATABASE_INSIGHTS_BRIEF_BUILD_ACTION_ID_V1),
                    { ...detailInput, baseline: { ...list.observation, basis: detail.finding.verification.basis } }, invocation));
                if (!brief.ok) throw new Error(`Brief failed: ${brief.code}`);
                expect(JSON.parse(brief.brief.evidence.items[0]!.text)).toMatchObject({ currentDetail: { object: identities[index] } });
                const freshBrief = DatabaseFindingBriefBuildResultV1Schema.parse(await kit.invokeAction(
                    databaseActionLocalIdV1(DATABASE_INSIGHTS_BRIEF_BUILD_ACTION_ID_V1), detailInput, invocation));
                if (!freshBrief.ok) throw new Error(`Brief failed: ${freshBrief.code}`);
                const { baseline, currentDetail } = JSON.parse(freshBrief.brief.evidence.items[0]!.text);
                expect(baseline).toMatchObject({
                    evidenceIdentity: currentDetail.evidenceIdentity,
                    summary: currentDetail.summary,
                    observedWindow: currentDetail.observedWindow,
                    basis: currentDetail.verification.basis,
                });
            }
        } finally { await kit.dispose(); await native.dispose(); }
    });

});
