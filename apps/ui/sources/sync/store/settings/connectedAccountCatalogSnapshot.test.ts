import { afterEach, describe, expect, it } from 'vitest';
import { applyAcknowledgedConnectedAccountCatalog, applyConnectedAccountCatalogSnapshot, beginConnectedAccountCatalogLoad, getConnectedAccountCatalogValue,
    resetConnectedAccountCatalogSnapshotsForTests, subscribeConnectedAccountCatalogSnapshots } from './connectedAccountCatalogSnapshot';

afterEach(resetConnectedAccountCatalogSnapshotsForTests);
const scope = { serverId: 'home', accountId: 'account' };
const ready = { status: 'ready' as const, revision: 3, record: { key: 'purposes' as const,
    value: { v: 1 as const, bindings: [{ purpose: { consumer: { pluginId: 'acme.plugin', localId: 'consumer' }, purpose: 'api' },
        target: { kind: 'account' as const, account: { service: { pluginId: 'acme.service', localId: 'native' }, accountId: 'default' } } }] } } };

describe('Connected Account catalog publication', () => {
    it.each(['snapshot', 'acknowledgement'] as const)('owns an immutable purpose value rather than retaining %s aliases', source => {
        const receipt = structuredClone(ready);
        if (source === 'snapshot') applyConnectedAccountCatalogSnapshot(scope, 'purposes', receipt, true);
        else applyAcknowledgedConnectedAccountCatalog(scope, receipt.record, receipt.revision, true);
        const published = getConnectedAccountCatalogValue(scope, 'purposes').value!;
        receipt.record.value.bindings[0]!.purpose.purpose = 'changed';
        receipt.record.value.bindings[0]!.target.account.accountId = 'changed';
        expect(published.bindings[0]!.purpose.purpose).toBe('api');
        expect(published.bindings[0]!.target).toEqual(ready.record.value.bindings[0]!.target);
        expect(Object.isFrozen(published.bindings[0]!.purpose.consumer)).toBe(true);
        expect(Object.isFrozen(published.bindings[0]!.target)).toBe(true);
    });
    it('publishes only the addressed catalog and retains unchanged selection identity', () => {
        let notifications = 0;
        subscribeConnectedAccountCatalogSnapshots(() => { notifications += 1; });
        applyConnectedAccountCatalogSnapshot(scope, 'purposes', ready, true);
        const first = getConnectedAccountCatalogValue(scope, 'purposes');
        applyConnectedAccountCatalogSnapshot(scope, 'purposes', { ...ready }, true);
        expect(getConnectedAccountCatalogValue(scope, 'purposes')).toBe(first);
        expect(notifications).toBe(1);
        applyConnectedAccountCatalogSnapshot(scope, 'configurations', { status: 'ready', revision: 2,
            record: { key: 'configurations', value: { v: 1, entries: [] } } }, true);
        expect(getConnectedAccountCatalogValue(scope, 'purposes')).toBe(first);
    });
    it('keeps equal refreshes silent, publishes a changed revision and rejects lost private admission', () => {
        const ready = { status: 'ready' as const, revision: 4,
            record: { key: 'configurations' as const, value: { v: 1 as const, entries: [] } } };
        const key = ready.record.key;
        applyConnectedAccountCatalogSnapshot(scope, key, ready, true);
        const initial = getConnectedAccountCatalogValue(scope, key);
        const value = initial.value;
        let notifications = 0;
        const stop = subscribeConnectedAccountCatalogSnapshots(() => { notifications += 1; });
        for (let index = 0; index < 10; index += 1) {
            beginConnectedAccountCatalogLoad(scope, key);
            applyConnectedAccountCatalogSnapshot(scope, key, structuredClone(ready), true);
        }
        expect(notifications).toBe(0);
        expect(getConnectedAccountCatalogValue(scope, key)).toBe(initial);
        applyConnectedAccountCatalogSnapshot(scope, key, ready, false);
        expect(getConnectedAccountCatalogValue(scope, key)).toBe(initial);
        beginConnectedAccountCatalogLoad(scope, key);
        applyConnectedAccountCatalogSnapshot(scope, key, { ...ready, revision: 5 }, true);
        expect(notifications).toBe(1);
        expect(getConnectedAccountCatalogValue(scope, key).revision).toBe(5);
        beginConnectedAccountCatalogLoad(scope, key, true);
        expect(getConnectedAccountCatalogValue(scope, key)).toMatchObject({ status: 'loading', stale: true, value });
        expect(notifications).toBe(2);
        stop();
        applyConnectedAccountCatalogSnapshot(scope, key, { status: 'unavailable', reason: 'unreachable' }, true);
        expect(getConnectedAccountCatalogValue(scope, key)).toMatchObject({ status: 'unavailable', value, stale: true });
        applyConnectedAccountCatalogSnapshot(scope, key, { status: 'unavailable', reason: 'account-mode-mismatch' }, true);
        expect(getConnectedAccountCatalogValue(scope, key)).toMatchObject({ status: 'unavailable', value: null });
    });
    it('publishes a fresh safe partial projection without granting ready catalog authority', () => {
        applyConnectedAccountCatalogSnapshot(scope, 'purposes', ready, true);
        const diagnostics = [{ path: 'value.bindings[1]', reason: 'invalid-stored-content' as const }];
        applyConnectedAccountCatalogSnapshot(scope, 'purposes', { status: 'partial', authority: 'active',
            revision: 4, record: ready.record, diagnostics }, true);
        expect(getConnectedAccountCatalogValue(scope, 'purposes')).toMatchObject({ status: 'partial',
            value: ready.record.value, revision: 4, stale: false, diagnostics });
        applyConnectedAccountCatalogSnapshot(scope, 'purposes', { status: 'partial', authority: 'inactive',
            revision: 'absent', record: ready.record, diagnostics }, true);
        expect(getConnectedAccountCatalogValue(scope, 'purposes')).toMatchObject({ status: 'partial',
            value: ready.record.value, revision: 'absent', stale: false, diagnostics });
        applyConnectedAccountCatalogSnapshot(scope, 'purposes', { status: 'unavailable', reason: 'forbidden' }, true);
        expect(getConnectedAccountCatalogValue(scope, 'purposes')).toMatchObject({ status: 'unavailable', value: null });
    });
});
