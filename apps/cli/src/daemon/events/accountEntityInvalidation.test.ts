import { describe, expect, it } from 'vitest';
import { UpdateBodySchema } from '@happier-dev/protocol/updates';
import { AccountEntitiesInvalidatedHostEventV1Schema } from '@happier-dev/protocol/plugins/events/hostReferencesV1';
import { projectAccountEntitiesInvalidationForHost } from './accountEntityInvalidation';

describe('Account retained-fact invalidation addresses', () => {
    it('preserves canonical plugin KV hints and native Account KV keys from the authorized change page', () => {
        const body = UpdateBodySchema.parse({ t: 'account-change', rows: { v: 1, after: 0, page: {
            nextCursor: 5, changes: [
                { cursor: 1, kind: 'pluginDomain', entityId: 'pluginDomain/happier.machine.services/data-kv', changedAt: 1,
                    hint: { pluginDomain: 'dataKv', pluginId: 'happier.machine.services', keys: ['health:source'] } },
                { cursor: 2, kind: 'pluginDomain', entityId: 'pluginDomain/example.tasks/data-kv', changedAt: 2,
                    hint: { pluginDomain: 'dataKv', pluginId: 'example.tasks', full: true } },
                { cursor: 3, kind: 'kv', entityId: 'self', changedAt: 3,
                    hint: { keys: ['machine-outcome:v1:changed'] } },
                { cursor: 4, kind: 'pluginDomain', entityId: 'pluginDomain/example.tasks/settings', changedAt: 4,
                    hint: { pluginDomain: 'settings', pluginId: 'example.tasks', scope: 'account', revision: 1 } },
                // Values are not a hint contract and must never reach host Events.
                { cursor: 5, kind: 'kv', entityId: 'self', changedAt: 5,
                    hint: { keys: ['machine-outcome:v1:private'], value: 'private-value' } },
            ],
        } } });
        if (body.t !== 'account-change') throw Error('Expected Account change');
        const event = projectAccountEntitiesInvalidationForHost(body);
        expect(event).toMatchObject({ payload: { entityIds: [],
            dataKvChanges: [
                { pluginDomain: 'dataKv', pluginId: 'happier.machine.services', keys: ['health:source'] },
                { pluginDomain: 'dataKv', pluginId: 'example.tasks', full: true },
            ], accountKvChanges: [{ keys: ['machine-outcome:v1:changed'] }] } });
        expect(AccountEntitiesInvalidatedHostEventV1Schema.parse(event?.payload)).toEqual(event?.payload);
    });

    it('retains the KV owner full hint when the committed mutation did not enumerate keys', () => {
        const body = UpdateBodySchema.parse({ t: 'account-change', rows: { v: 1, after: 0, page: {
            nextCursor: 1, changes: [{ cursor: 1, kind: 'kv', entityId: 'self', changedAt: 1,
                hint: { full: true } }],
        } } });
        if (body.t !== 'account-change') throw Error('Expected Account change');
        expect(projectAccountEntitiesInvalidationForHost(body)).toMatchObject({
            payload: { entityIds: [], accountKvChanges: [{ full: true }] },
        });
    });
});
