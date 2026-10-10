import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_PROVIDER_SETTINGS_V1 } from '@happier-dev/protocol/providers/settings/v1';
import { splitProviderSettingsV1 } from '@happier-dev/protocol/providers/connections/connectionRowsV1';
import { applyProviderCatalogSnapshot, beginProviderCatalogLoad, getProviderCatalogSnapshot,
    resetProviderCatalogSnapshotsForTests, subscribeProviderCatalogSnapshots } from './providerCatalogSnapshot';

afterEach(resetProviderCatalogSnapshotsForTests);
describe('scoped Provider row publication', () => {
    it('retains display contents while refresh withdraws effect authority without notifying on an unchanged catalog', () => {
        const scope = { serverId: 'home', accountId: 'account' };
        const catalog = splitProviderSettingsV1(DEFAULT_PROVIDER_SETTINGS_V1).catalog;
        const ready = { status: 'ready' as const, revision: 4, catalog };
        applyProviderCatalogSnapshot(scope, ready, true);
        const initial = getProviderCatalogSnapshot(scope)!;
        let notifications = 0;
        const dispose = subscribeProviderCatalogSnapshots(() => { notifications += 1; });
        applyProviderCatalogSnapshot(scope, { ...ready, catalog: { ...catalog } }, true);
        expect(getProviderCatalogSnapshot(scope)).toBe(initial);
        expect(notifications).toBe(0);
        beginProviderCatalogLoad(scope);
        expect(getProviderCatalogSnapshot(scope)).toMatchObject({ status: 'loading', stale: true });
        expect(getProviderCatalogSnapshot(scope)?.data).toBe(initial.data);
        applyProviderCatalogSnapshot(scope, ready, false);
        expect(getProviderCatalogSnapshot(scope)?.status).toBe('loading');
        applyProviderCatalogSnapshot(scope, { status: 'unavailable', reason: 'unreachable' }, true);
        expect(getProviderCatalogSnapshot(scope)?.data).toBe(initial.data);
        applyProviderCatalogSnapshot(scope, { status: 'unavailable', reason: 'account-mode-mismatch' }, true);
        expect(getProviderCatalogSnapshot(scope)).toMatchObject({ data: null, stale: true });
        dispose();
    });
    it('keeps sibling Home publications isolated and never republishes a retired Account', () => {
        const scope = { serverId: 'home', accountId: 'account' };
        const catalog = splitProviderSettingsV1(DEFAULT_PROVIDER_SETTINGS_V1).catalog;
        applyProviderCatalogSnapshot(scope, { status: 'ready', revision: 'absent', catalog }, true);
        const initial = getProviderCatalogSnapshot(scope);
        applyProviderCatalogSnapshot({ serverId: 'other', accountId: 'account' }, { status: 'ready', revision: 1, catalog }, true);
        expect(getProviderCatalogSnapshot(scope)).toBe(initial);
        applyProviderCatalogSnapshot(scope, { status: 'unavailable', reason: 'scope-retired' }, true);
        expect(getProviderCatalogSnapshot(scope)).toBe(initial);
    });
});
