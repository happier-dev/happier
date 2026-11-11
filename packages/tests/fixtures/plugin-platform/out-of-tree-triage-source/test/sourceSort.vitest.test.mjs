import { expect, it } from 'vitest';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { TriageScanResultV1Schema } from '@happier-dev/triage-protocol/v1';
import {
    manifest, activate, LEDGER_ACTION_IDS, LEDGER_ACCOUNT_PURPOSE,
    LEDGER_CONNECTED_ACCOUNT_ID, LEDGER_CONTRIBUTION_LOCAL_ID,
} from '../src/index.mjs';

const account = { service: { pluginId: manifest.id, localId: LEDGER_CONNECTED_ACCOUNT_ID }, accountId: 'account-1' };
const instance = {
    v: 1,
    instance: { source: { pluginId: manifest.id, localId: LEDGER_CONTRIBUTION_LOCAL_ID },
        sourceInstanceId: '2f1c9c4e-8c1f-4a53-9c2a-4c9a7b1d3e05' },
    binding: { purpose: LEDGER_ACCOUNT_PURPOSE, account },
    localInstanceKey: 'acme/ledger-qa-shallow',
    configuration: { v: 1, token: 'space=acme/ledger-qa-shallow' },
};

it.each([
    ['updated', 'asc', ['LGQ-2', 'LGQ-1', 'LGQ-0']],
    ['updated', 'desc', ['LGQ-0', 'LGQ-1', 'LGQ-2']],
    ['created', 'asc', ['LGQ-2', 'LGQ-1', 'LGQ-0']],
    ['created', 'desc', ['LGQ-0', 'LGQ-1', 'LGQ-2']],
])('FIELD-SORT-1111: activated Action keeps %s %s ordered across native pages', async (field, direction, expected) => {
    // ConnectedAccounts is the only genuine host-service boundary. Activation,
    // Action schemas, the provider page owner and row mapping remain real.
    const kit = await createPluginTestkit({ manifest, module: { activate }, services: { connectedAccounts: {
        async listAccounts({ purpose }) {
            expect(purpose).toBe(LEDGER_ACCOUNT_PURPOSE);
            return { status: 'complete', accounts: [{ account, displayName: 'Acme Ledger', state: 'connected',
                connectedAccountOrigins: [], connectedAccountBases: [] }] };
        },
    } } });
    try {
        const sort = { field, direction };
        const first = TriageScanResultV1Schema.parse(await kit.invokeAction(LEDGER_ACTION_IDS.scan, {
            v: 1, instance, sort, page: { kind: 'initial', limit: 2 },
        }));
        expect(first.kind).toBe('page');
        const second = TriageScanResultV1Schema.parse(await kit.invokeAction(LEDGER_ACTION_IDS.scan, {
            v: 1, instance, sort, page: { kind: 'continuation', continuation: first.continuation },
        }));
        expect(second.kind).toBe('complete');
        expect([...first.observations, ...second.observations].map(row => row.localRef.entryId)).toEqual(expected);
        expect(first.observations).toHaveLength(2);
        expect(second.observations).toHaveLength(1);
        const changed = TriageScanResultV1Schema.parse(await kit.invokeAction(LEDGER_ACTION_IDS.scan, {
            v: 1, instance, sort: { field, direction: direction === 'asc' ? 'desc' : 'asc' },
            page: { kind: 'continuation', continuation: first.continuation },
        }));
        expect(changed.kind).toBe('failed');
        expect(manifest.contributes.targetedPluginContributions[0].descriptor.sortFields).toEqual(['updated', 'created']);
    } finally {
        await kit.dispose();
    }
});
