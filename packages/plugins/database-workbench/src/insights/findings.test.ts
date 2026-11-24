import { describe, expect, it } from 'vitest';
import { definePlugin, type JsonValue } from '@happier-dev/plugin-sdk';
import type { StorageScopeService } from '@happier-dev/plugin-sdk/storage';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import {
    DatabaseFindingsListResultV1Schema,
    DatabaseFindingReadResultV1Schema,
    DatabaseFindingBriefBuildResultV1Schema,
} from '@happier-dev/plugin-sdk/database';
import {
    DATABASE_INSIGHTS_FINDINGS_LIST_ACTION_ID_V1,
    DATABASE_INSIGHTS_FINDINGS_DISMISS_ACTION_ID_V1,
    DATABASE_INSIGHTS_FINDINGS_READ_ACTION_ID_V1,
    DATABASE_INSIGHTS_BRIEF_BUILD_ACTION_ID_V1,
} from '@happier-dev/database-protocol';
import { databaseActionLocalIdV1 } from '@happier-dev/database-protocol';
import { createDatabaseActions } from '../actions.js';
import { createDatabaseInsightProducers } from './findings.js';
import { createNativeFindingFixture, target, invocation } from './nativeFixture.testkit.js';

describe('selected native finding identity', () => {
    it('retains only an explicit dismissal across separate samples and isolates the requesting Account', async () => {
        const native = await createNativeFindingFixture();
        const entries = new Map<string, JsonValue>();
        const storage: StorageScopeService = {
            async get<T extends JsonValue = JsonValue>(key: string) { return (entries.get(key) ?? null) as T | null; },
            async set(key, value) { entries.set(key, value); },
            async delete(key) { entries.delete(key); },
            async list() { return { items: [...entries.keys()].map(key => ({ key })) }; },
            consistency() { return { kind: 'authoritativeSerializable' }; },
            async transaction(run) { return run(storage); },
        };
        const producers = createDatabaseInsightProducers({ async executeOperation(input) {
            const { connection } = await native.resolve();
            try { return await connection.execute(input); } finally { await connection.close(); }
        }, async admit() {} });
        const plugin = definePlugin({ id: 'happier.database', version: '0.0.0', actions: createDatabaseActions(producers) });
        const kit = await createPluginTestkit({ manifest: plugin.manifest, module: plugin, services: { storage: {
            daemon: { ...storage, async database(): Promise<never> { throw new Error('No daemon database requested'); } },
            daemonSession: storage, ephemeral: storage,
        } } });
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
        const producers = createDatabaseInsightProducers({ async executeOperation(input) {
            const { connection } = await native.resolve();
            try { return await connection.execute(input); } finally { await connection.close(); }
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
