import { describe, expect, it } from 'vitest';
import { definePlugin } from '@happier-dev/plugin-sdk';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import {
    DatabaseFindingsListResultV1Schema,
    DatabaseFindingReadResultV1Schema,
    DatabaseFindingBriefBuildResultV1Schema,
} from '@happier-dev/plugin-sdk/database';
import {
    DATABASE_INSIGHTS_FINDINGS_LIST_ACTION_ID_V1,
    DATABASE_INSIGHTS_FINDINGS_READ_ACTION_ID_V1,
    DATABASE_INSIGHTS_BRIEF_BUILD_ACTION_ID_V1,
} from '@happier-dev/database-protocol';
import { databaseActionLocalIdV1 } from '@happier-dev/database-protocol';
import { createDatabaseActions } from '../actions.js';
import { createDatabaseInsightProducers } from './findings.js';
import { createNativeFindingFixture, target, invocation } from './nativeFixture.testkit.js';

describe('selected native finding identity', () => {
    it.each(['tables', 'indexes'] as const)('retains selected %s identity through Action results and brief evidence', async group => {
        const native = await createNativeFindingFixture();
        const producers = createDatabaseInsightProducers({ async executeOperation(input) {
            const { connection } = await native.resolve();
            try { return await connection.execute(input); } finally { await connection.close(); }
        } });
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
            }
        } finally { await kit.dispose(); await native.dispose(); }
    });

});
