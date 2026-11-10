import { afterEach, expect, it } from 'vitest';
import * as React from 'react';
import { act } from 'react-test-renderer';
import { DEFAULT_PROVIDER_SETTINGS_V1 } from '@happier-dev/protocol/providers/settings/v1';
import { ProviderConnectionIdSchema } from '@happier-dev/protocol/providers/ids';
import { ProviderConnectionsCatalogV1Schema, splitProviderSettingsV1 } from '@happier-dev/protocol/providers/connections/connectionRowsV1';
import { createRenderCommitCounter, useRenderCommitCounter } from '@/dev/testkit/performance/counts';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import '@/dev/testkit/harness/persistentUiState';
import '@/sync/domains/machines/reachability/machineReachability';
import { applyAcknowledgedProviderCatalog, applyProviderCatalogSnapshot, beginProviderCatalogLoad,
    readProviderCatalogConnection, readProviderCatalogModel, resetProviderCatalogSnapshotsForTests,
    subscribeProviderCatalogSnapshots } from './providerCatalogSnapshot';

const scope = { serverId: 'home', accountId: 'recipient' };
const catalog = ProviderConnectionsCatalogV1Schema.parse({ ...splitProviderSettingsV1(DEFAULT_PROVIDER_SETTINGS_V1).catalog,
    connections: Array.from({ length: 1_000 }, (_, index) => ({ v: 1, id: `pc_${index}`,
        source: { kind: 'contribution', contributionKey: 'acme.gateway/gateway' }, role: 'named',
        displayName: `Gateway ${index}`, displayNameMode: 'custom', revision: 1, createdAt: 1, updatedAt: 1 })),
    manualModelsByConnectionId: { pc_0: Array.from({ length: 500 }, (_, index) => ({
        id: `model-${index}`, name: `Model ${index}`, addedAt: 1,
    })) },
});

afterEach(() => { standardCleanup(); resetProviderCatalogSnapshotsForTests(); });

it('reads an exact connection/model without inventory work and keeps an unrelated publication out of its mounted consumer', async () => {
    let inventoryReads = 0;
    const counted = { ...catalog,
        connections: catalog.connections.map(connection => ({ ...connection, get id() { inventoryReads += 1; return connection.id; } })),
        manualModelsByConnectionId: { pc_0: catalog.manualModelsByConnectionId[ProviderConnectionIdSchema.parse('pc_0')]!.map(model => ({ ...model,
            get id() { inventoryReads += 1; return model.id; } })) },
    };
    applyProviderCatalogSnapshot(scope, { status: 'ready', revision: 1, catalog: counted }, true);
    inventoryReads = 0;
    expect(readProviderCatalogConnection(scope, 'pc_0')?.displayName).toBe('Gateway 0');
    expect(readProviderCatalogConnection(scope, 'absent')).toBeNull();
    expect(readProviderCatalogModel(scope, 'pc_0', 'model-499')?.name).toBe('Model 499');
    expect(readProviderCatalogModel(scope, 'pc_0', 'absent')).toBeNull();
    expect(inventoryReads).toBe(0);
    const counter = createRenderCommitCounter();
    const hook = await renderHook(() => {
        useRenderCommitCounter(counter);
        const connection = React.useSyncExternalStore(subscribeProviderCatalogSnapshots, () => readProviderCatalogConnection(scope, 'pc_0'));
        return connection?.displayName;
    });
    counter.reset();
    for (let revision = 2; revision <= 6; revision += 1) {
        await act(async () => applyProviderCatalogSnapshot(scope, { status: 'ready', revision, catalog: { ...catalog,
            connections: catalog.connections.map(connection => connection.id === 'pc_1' ? { ...connection, displayName: `Other ${revision}` } : connection),
        } }, true));
    }
    expect(counter.read()).toEqual({ renders: 0, commits: 0 });
    await act(async () => applyProviderCatalogSnapshot(scope, { status: 'ready', revision: 7, catalog: { ...catalog,
        connections: catalog.connections.map(connection => connection.id === 'pc_0' ? { ...connection, displayName: 'Renamed gateway' } : connection),
    } }, true));
    expect(hook.getCurrent()).toBe('Renamed gateway');
    expect(counter.read()).toEqual({ renders: 1, commits: 1 });
});

it('uses both canonical admission paths and preserves scope, reread and refusal lifetimes', () => {
    applyAcknowledgedProviderCatalog(scope, catalog, 1, true, null);
    expect(readProviderCatalogConnection(scope, 'pc_0')?.displayName).toBe('Gateway 0');
    expect(readProviderCatalogConnection({ ...scope, accountId: 'other' }, 'pc_0')).toBeNull();
    beginProviderCatalogLoad(scope);
    expect(readProviderCatalogModel(scope, 'pc_0', 'model-0')?.name).toBe('Model 0');
    applyProviderCatalogSnapshot(scope, { status: 'unavailable', reason: 'unreachable' }, true);
    expect(readProviderCatalogConnection(scope, 'pc_0')?.displayName).toBe('Gateway 0');
    applyProviderCatalogSnapshot(scope, { status: 'unavailable', reason: 'forbidden' }, true);
    expect(readProviderCatalogConnection(scope, 'pc_0')).toBeNull();
    expect(readProviderCatalogModel(scope, 'pc_0', 'model-0')).toBeNull();
    applyProviderCatalogSnapshot(scope, { status: 'ready', revision: 2, catalog }, true);
    applyProviderCatalogSnapshot(scope, { status: 'ready', revision: 3, catalog: splitProviderSettingsV1(DEFAULT_PROVIDER_SETTINGS_V1).catalog }, true);
    expect(readProviderCatalogConnection(scope, 'pc_0')).toBeNull();
});
