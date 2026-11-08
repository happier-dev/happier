import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PROVIDER_SETTINGS_V1 } from '@happier-dev/protocol/providers/settings/v1';
import { setProviderExperimentalConfirmationV1 } from '@happier-dev/protocol/providers/settings/operationsV1';
import { ProviderConnectionsCatalogV1Schema, splitProviderSettingsV1 } from '@happier-dev/protocol/providers/connections/connectionRowsV1';
import { DaemonProviderModelProjectionResponseV1Schema } from '@happier-dev/protocol/rpc/providers';
import { ProviderProbeObservationIdentityV1Schema } from '@happier-dev/protocol/providers/fingerprints';
import { createProviderConnectionsDescribeFixture, createProviderConnectionViewFixture } from '@/dev/testkit/harness/providerSettingsHarness';
import { buildCustomProviderTemplate, createCustomProviderDraft } from '@/providers/authoring/state';
import { applyAcknowledgedProviderCatalog, applyProviderCatalogSnapshot, beginProviderCatalogLoad, getProviderCatalogSnapshot, readProviderCatalogConnection,
    beginProviderModelProjectionRead, getProviderModelProjectionSnapshot,
    resetProviderCatalogSnapshotsForTests, subscribeProviderCatalogSnapshots, subscribeProviderModelProjectionSnapshot,
    beginProviderConnectionCheckRead, getProviderConnectionCheckSnapshot, isProviderConnectionCheckReadRequired, providerConnectionCheckQueryKey } from './providerCatalogSnapshot';

afterEach(resetProviderCatalogSnapshotsForTests);
describe('scoped Provider row publication', () => {
    it.each([{ before: null, after: null }, { before: 100, after: 100 }, { before: 100, after: null }])(
        'publishes an admitted observation identity with checkedAt $before → $after and retires older cross-query replies', ({ before, after }) => {
        const scope = { serverId: 'home', accountId: 'account' };
        const listKey = providerConnectionCheckQueryKey('machine-a');
        const detailKey = providerConnectionCheckQueryKey('machine-a', 'pc_a');
        const old = createProviderConnectionsDescribeFixture({ connections: [createProviderConnectionViewFixture({ connectionId: 'pc_a',
            probeObservationIdentity: ProviderProbeObservationIdentityV1Schema.parse('probe-observation:v1:old'), runtime: { health: 'not_checked', checkedAt: before, modelCount: null, endpoints: [] } })] });
        const next = createProviderConnectionsDescribeFixture({ connections: [{ ...old.connections[0]!,
            probeObservationIdentity: ProviderProbeObservationIdentityV1Schema.parse('probe-observation:v1:next'),
            runtime: { ...old.connections[0]!.runtime, checkedAt: after } }] });
        beginProviderConnectionCheckRead(scope, 'credential', listKey)(old);
        beginProviderConnectionCheckRead(scope, 'credential', detailKey)(old);
        const delayed = beginProviderConnectionCheckRead(scope, 'credential', listKey);
        beginProviderConnectionCheckRead(scope, 'credential', detailKey)(next);
        expect(getProviderConnectionCheckSnapshot(scope, 'credential', detailKey)?.connections[0]?.probeObservationIdentity).toBe('probe-observation:v1:next');
        expect(getProviderConnectionCheckSnapshot(scope, 'credential', listKey)?.connections[0]?.probeObservationIdentity).toBe('probe-observation:v1:next');
        delayed(old);
        expect(getProviderConnectionCheckSnapshot(scope, 'credential', listKey)?.connections[0]?.probeObservationIdentity).toBe('probe-observation:v1:next');
        if (after !== null) {
            const earlierCheck = { ...next, connections: [{ ...next.connections[0]!, runtime: { ...next.connections[0]!.runtime, checkedAt: after - 1 } }] };
            beginProviderConnectionCheckRead(scope, 'credential', detailKey)(earlierCheck);
            expect(getProviderConnectionCheckSnapshot(scope, 'credential', detailKey)?.connections[0]?.runtime.checkedAt).toBe(after);
            expect(getProviderConnectionCheckSnapshot(scope, 'credential', listKey)?.connections[0]?.runtime.checkedAt).toBe(after);
        }
    });
    it.each([false, true])('publishes an admitted observation identity into a pending detail before retiring its older reply (loaded: %s)', loaded => {
        const scope = { serverId: 'home', accountId: 'account' };
        const listKey = providerConnectionCheckQueryKey('machine-a');
        const detailKey = providerConnectionCheckQueryKey('machine-a', 'pc_a');
        const old = createProviderConnectionsDescribeFixture({ connections: [createProviderConnectionViewFixture({ connectionId: 'pc_a',
            probeObservationIdentity: ProviderProbeObservationIdentityV1Schema.parse('probe-observation:v1:old') })] });
        const next = createProviderConnectionsDescribeFixture({ connections: [{ ...old.connections[0]!, probeObservationIdentity: ProviderProbeObservationIdentityV1Schema.parse('probe-observation:v1:next') },
            createProviderConnectionViewFixture({ connectionId: 'pc_b' })] });
        beginProviderConnectionCheckRead(scope, 'credential', listKey)(old);
        if (loaded) beginProviderConnectionCheckRead(scope, 'credential', detailKey)(old);
        const delayed = beginProviderConnectionCheckRead(scope, 'credential', detailKey);
        beginProviderConnectionCheckRead(scope, 'credential', listKey)(next);
        expect(getProviderConnectionCheckSnapshot(scope, 'credential', detailKey)?.connections).toEqual([next.connections[0]]);
        delayed(old);
        expect(getProviderConnectionCheckSnapshot(scope, 'credential', detailKey)?.connections).toEqual([next.connections[0]]);
    });
    it('visits published connection identities linearly with retained detail snapshots', () => {
        const measure = (count: number) => {
            resetProviderCatalogSnapshotsForTests();
            const scope = { serverId: 'home', accountId: 'account' };
            const connectionIds = Array.from({ length: count }, (_, index) => `pc_${index}`);
            for (const connectionId of connectionIds) {
                beginProviderConnectionCheckRead(scope, 'credential', providerConnectionCheckQueryKey('machine-a', connectionId))(
                    createProviderConnectionsDescribeFixture({ connections: [createProviderConnectionViewFixture({
                        connectionId, runtime: { health: 'available', checkedAt: 100, modelCount: 2, endpoints: [] },
                    })] }));
            }
            const reply = createProviderConnectionsDescribeFixture({ connections: connectionIds.map(connectionId =>
                createProviderConnectionViewFixture({ connectionId,
                    runtime: { health: 'unreachable', checkedAt: 200, modelCount: 2, endpoints: [] } })) });
            let visits = 0;
            for (const row of reply.connections) {
                const connectionId = row.connectionId;
                Object.defineProperty(row, 'connectionId', { enumerable: true, get: () => { visits += 1; return connectionId; } });
            }
            beginProviderConnectionCheckRead(scope, 'credential', providerConnectionCheckQueryKey('machine-a'))(reply);
            return visits;
        };
        const small = measure(16);
        const large = measure(32);
        expect(small).toBeGreaterThan(0);
        expect(large).toBeLessThanOrEqual(small * 2);
    });
    it.each(['existing', 'empty', 'pending'] as const)('publishes one detail check into the mounted rail without changing other connections or scopes (prior list: %s)', priorList => {
        const scope = { serverId: 'home', accountId: 'account' };
        const railKey = providerConnectionCheckQueryKey('machine-a');
        const detailKey = providerConnectionCheckQueryKey('machine-a', 'pc_a');
        const otherMachineKey = providerConnectionCheckQueryKey('machine-b');
        const original = createProviderConnectionViewFixture({ connectionId: 'pc_a',
            runtime: { health: 'available', checkedAt: 100, modelCount: 2, endpoints: [] } });
        const other = createProviderConnectionViewFixture({ connectionId: 'pc_b' });
        const rail = createProviderConnectionsDescribeFixture({ connections: priorList === 'existing' ? [original, other] : priorList === 'empty' ? [other] : [] });
        if (priorList !== 'pending') beginProviderConnectionCheckRead(scope, 'credential', railKey)(rail);
        beginProviderConnectionCheckRead(scope, 'credential', otherMachineKey)(rail);
        beginProviderConnectionCheckRead(scope, 'other-credential', railKey)(rail);
        const publishDelayedRail = beginProviderConnectionCheckRead(scope, 'credential', railKey);
        const changed = vi.fn();
        const release = subscribeProviderModelProjectionSnapshot(scope, 'credential', railKey, changed);
        try {
            const failed = createProviderConnectionViewFixture({ connectionId: 'pc_a',
                runtime: { health: 'unreachable', checkedAt: 200, modelCount: 2, endpoints: [{
                    endpointTemplateId: 'chat', status: 'unreachable', observedAt: 200, activity: 'idle',
                    errorCode: 'provider_endpoint_unreachable', retryAt: null,
                    failureCause: { phase: 'providers.probe.resolve_host', errorClass: 'Error', errorCode: 'ENOTFOUND', httpStatus: null },
                }] } });
            beginProviderConnectionCheckRead(scope, 'credential', detailKey)(
                createProviderConnectionsDescribeFixture({ connections: [failed] }));
            const updated = getProviderConnectionCheckSnapshot(scope, 'credential', railKey)!;
            expect(updated?.connections.find(row => row.connectionId === 'pc_a')).toEqual(failed);
            expect(updated.connections.find(row => row.connectionId === 'pc_b')).toBe(rail.connections.find(row => row.connectionId === 'pc_b'));
            expect(changed).toHaveBeenCalledOnce();
            expect(getProviderConnectionCheckSnapshot(scope, 'credential', otherMachineKey)).toBe(rail);
            expect(getProviderConnectionCheckSnapshot(scope, 'other-credential', railKey)).toBe(rail);
            publishDelayedRail(rail);
            expect(getProviderConnectionCheckSnapshot(scope, 'credential', railKey)?.connections.find(row => row.connectionId === 'pc_a')).toEqual(failed);
            expect(changed).toHaveBeenCalledOnce();
            beginProviderConnectionCheckRead(scope, 'credential', railKey)(
                createProviderConnectionsDescribeFixture({ connections: [other] }));
            expect(getProviderConnectionCheckSnapshot(scope, 'credential', railKey)?.connections.map(row => row.connectionId)).toEqual(['pc_b']);
        } finally { release(); }
    });
    it('reconciles changed catalog rows without waking unchanged row consumers at scale', () => {
        const scope = { serverId: 'home', accountId: 'account' };
        const template = buildCustomProviderTemplate({ ...createCustomProviderDraft('openai-chat'),
            name: 'Acme', baseUrl: 'https://models.example/v1', requiresApiKey: false });
        const confirmed = setProviderExperimentalConfirmationV1(DEFAULT_PROVIDER_SETTINGS_V1, {
            connectionId: 'connected-source:recipient', catalogSourceKey: 's'.repeat(43),
            agentTargetKey: 'agent:happier.agent.codex/codex', modelId: 'model-a',
            compatibilityFingerprint: 'compatibility:v1:experimental', confirmedAt: 1,
        });
        const catalog = ProviderConnectionsCatalogV1Schema.parse({ ...splitProviderSettingsV1(confirmed).catalog,
            connections: Array.from({ length: 400 }, (_, i) => ({ v: 1, id: `pc_${i}`, source: { kind: 'custom', template },
                role: 'named', displayName: `Connection ${i}`, displayNameMode: 'custom', revision: 1, createdAt: 1, updatedAt: 1 })),
            accountGrants: [{ v: 1, connectionId: 'pc_200', connectionSecurityFingerprint: 'approved', confirmedAt: 1 }],
            manualModelsByConnectionId: { pc_200: [{ id: 'model-a', name: 'Model A', addedAt: 1 }, { id: 'model-b', name: 'Model B', addedAt: 1 }] },
        });
        applyProviderCatalogSnapshot(scope, { status: 'ready', revision: 1, catalog }, true);
        const baseline = getProviderCatalogSnapshot(scope)!.data!;
        let publications = 0;
        let unaffectedWakes = 0;
        const names: string[] = [];
        const release = subscribeProviderCatalogSnapshots(() => {
            publications += 1;
            const data = getProviderCatalogSnapshot(scope)!.data;
            if (data?.connections[199] !== baseline.connections[199]) unaffectedWakes += 1;
            names.push(data?.connections[200]?.displayName ?? 'withdrawn');
        });
        try {
            for (let i = 0; i < 5; i += 1) applyProviderCatalogSnapshot(scope,
                { status: 'ready', revision: 1, catalog: structuredClone(catalog) }, true);
            expect(publications).toBe(0);
            const changed = structuredClone(catalog);
            changed.connections[200] = { ...changed.connections[200]!, displayName: 'Renamed', revision: 2 };
            applyProviderCatalogSnapshot(scope, { status: 'ready', revision: 2, catalog: changed }, true);
            expect(publications).toBe(1);
            expect(names).toEqual(['Renamed']);
            expect(unaffectedWakes).toBe(0);
            const admitted = getProviderCatalogSnapshot(scope)!.data!;
            expect(admitted.connections[200]).not.toBe(baseline.connections[200]);
            expect(admitted.accountGrants).toBe(baseline.accountGrants);
            expect(admitted.machineGrants).toBe(baseline.machineGrants);
            expect(admitted.manualModelsByConnectionId).toBe(baseline.manualModelsByConnectionId);
            expect(admitted.experimentalBindingConfirmations).toBe(baseline.experimentalBindingConfirmations);
            expect(admitted.connections[200]?.source).toBe(baseline.connections[200]?.source);
            const publication = getProviderCatalogSnapshot(scope)!.catalog;
            if (publication.status !== 'ready') throw new Error('Expected ready publication');
            expect(publication.catalog).toBe(admitted);
            const reordered = { ...structuredClone(changed), connections: [...structuredClone(changed.connections)].reverse() };
            applyAcknowledgedProviderCatalog(scope, reordered, 3, true, null);
            expect(getProviderCatalogSnapshot(scope)!.data!.connections[200]).toBe(admitted.connections[199]);
            const modelChange = structuredClone(changed);
            modelChange.manualModelsByConnectionId.pc_200![0] = { ...modelChange.manualModelsByConnectionId.pc_200![0]!, name: 'Renamed model' };
            modelChange.accountGrants = [];
            applyProviderCatalogSnapshot(scope, { status: 'ready', revision: 4, catalog: modelChange }, true);
            const revised = getProviderCatalogSnapshot(scope)!.data!;
            expect(revised.accountGrants).toEqual([]);
            expect(revised.manualModelsByConnectionId.pc_200?.[0]?.name).toBe('Renamed model');
            expect(revised.manualModelsByConnectionId.pc_200?.[1]).toBe(admitted.manualModelsByConnectionId.pc_200?.[1]);
            applyProviderCatalogSnapshot(scope, { status: 'unavailable', reason: 'forbidden' }, true);
            expect(publications).toBe(4);
            expect(names.at(-1)).toBe('withdrawn');
        } finally { release(); }
    });

    it.each(['read', 'acknowledgement'] as const)('publishes a new connection once through %s admission without replacing retained rows', admission => {
        const scope = { serverId: 'home', accountId: 'account' };
        const template = buildCustomProviderTemplate({ ...createCustomProviderDraft('openai-chat'),
            name: 'Acme', baseUrl: 'https://models.example/v1', requiresApiKey: false });
        const catalog = ProviderConnectionsCatalogV1Schema.parse({ ...splitProviderSettingsV1(DEFAULT_PROVIDER_SETTINGS_V1).catalog,
            connections: Array.from({ length: 400 }, (_, index) => ({ v: 1, id: `pc_${index}`, source: { kind: 'custom', template },
                role: 'named', displayName: `Connection ${index}`, displayNameMode: 'custom', revision: 1, createdAt: 1, updatedAt: 1 })),
        });
        applyProviderCatalogSnapshot(scope, { status: 'ready', revision: 1, catalog }, true);
        const retained = getProviderCatalogSnapshot(scope)!.data!;
        const next = ProviderConnectionsCatalogV1Schema.parse({ ...catalog,
            connections: [...catalog.connections, { ...catalog.connections[0]!, id: 'pc_new', displayName: 'New connection' }],
        });
        const observed: string[][] = [];
        const release = subscribeProviderCatalogSnapshots(() => {
            observed.push(getProviderCatalogSnapshot(scope)!.data!.connections.map(row => row.id));
        });
        const publish = () => admission === 'read'
            ? applyProviderCatalogSnapshot(scope, { status: 'ready', revision: 2, catalog: structuredClone(next) }, true)
            : applyAcknowledgedProviderCatalog(scope, structuredClone(next), 2, true, null);
        try {
            publish();
            expect(observed).toHaveLength(1);
            expect(observed[0]).toEqual([...retained.connections.map(row => row.id), 'pc_new']);
            const added = getProviderCatalogSnapshot(scope)!.data!;
            expect(added.connections).toHaveLength(401);
            expect(readProviderCatalogConnection(scope, 'pc_new')?.displayName).toBe('New connection');
            expect(added.connections.slice(0, 400).every((row, index) => row === retained.connections[index])).toBe(true);
            for (let index = 0; index < 22; index += 1) publish();
            expect(observed).toHaveLength(1);
            expect(getProviderCatalogSnapshot(scope)!.data).toBe(added);
        } finally { release(); }
    });

    it('retires a check only when its Account source authority changes, not for a preference or display rename', () => {
        const scope = { serverId: 'home', accountId: 'account' };
        const catalog = ProviderConnectionsCatalogV1Schema.parse({ ...splitProviderSettingsV1(DEFAULT_PROVIDER_SETTINGS_V1).catalog,
            connections: [{ v: 1 as const, id: 'pc_a', source: { kind: 'custom' as const, template: buildCustomProviderTemplate({
                ...createCustomProviderDraft('openai-chat'), name: 'Acme', baseUrl: 'https://models.example/v1', requiresApiKey: false,
            }) }, role: 'named' as const, displayName: 'Acme', displayNameMode: 'custom' as const,
            revision: 1, createdAt: 1, updatedAt: 1 }],
        });
        applyProviderCatalogSnapshot(scope, { status: 'ready', revision: 1, catalog }, true);
        const key = providerConnectionCheckQueryKey('machine-a', 'pc_a');
        const check = createProviderConnectionsDescribeFixture({ connections: [createProviderConnectionViewFixture({
            connectionId: 'pc_a', revision: 1, runtime: { health: 'unreachable', checkedAt: 200, modelCount: 466,
                endpoints: [{ endpointTemplateId: 'chat', status: 'unreachable', observedAt: 200,
                    activity: 'idle', errorCode: 'provider_endpoint_unreachable', retryAt: null }] },
        })] });
        beginProviderConnectionCheckRead(scope, 'credential', key)(check);
        const changed = vi.fn();
        const release = subscribeProviderModelProjectionSnapshot(scope, 'credential', key, changed);
        try {
            applyProviderCatalogSnapshot(scope, { status: 'ready', revision: 1, catalog: { ...catalog } }, true);
            expect(changed).not.toHaveBeenCalled();
            const renamed = { ...catalog, connections: catalog.connections.map(row => ({ ...row,
                displayName: 'Renamed', revision: 2, updatedAt: 2 })) };
            applyProviderCatalogSnapshot(scope, { status: 'ready', revision: 2, catalog: renamed }, true);
            expect(getProviderConnectionCheckSnapshot(scope, 'credential', key)?.connections[0]?.runtime.checkedAt).toBe(200);
            expect(changed).not.toHaveBeenCalled();
            const publishOld = beginProviderConnectionCheckRead(scope, 'credential', key);
            applyProviderCatalogSnapshot(scope, { status: 'ready', revision: 3, catalog: ProviderConnectionsCatalogV1Schema.parse({ ...renamed,
                secretBindingsByConnectionId: { pc_a: { account: { apiKey: 'replacement' }, byMachineId: {} } } }) }, true);
            expect(getProviderConnectionCheckSnapshot(scope, 'credential', key)?.connections).toEqual([]);
            expect(isProviderConnectionCheckReadRequired(scope, 'credential', key)).toBe(true);
            publishOld(check);
            expect(getProviderConnectionCheckSnapshot(scope, 'credential', key)?.connections).toEqual([]);
            expect(isProviderConnectionCheckReadRequired(scope, 'credential', key)).toBe(true);
            expect(changed).toHaveBeenCalledTimes(1);
            const publishCurrent = beginProviderConnectionCheckRead(scope, 'credential', key);
            expect(isProviderConnectionCheckReadRequired(scope, 'credential', key)).toBe(false);
            publishCurrent(check);
            expect(getProviderConnectionCheckSnapshot(scope, 'credential', key)?.connections).toEqual(check.connections);
            expect(changed).toHaveBeenCalledTimes(2);
        } finally { release(); }
    });
    it('notifies only the affected model query and never the Account catalog or a sibling scope', () => {
        const scope = { serverId: 'home', accountId: 'account' };
        const catalogChanged = vi.fn();
        const queryChanged = vi.fn();
        const siblingChanged = vi.fn();
        const releases = [subscribeProviderCatalogSnapshots(catalogChanged),
            subscribeProviderModelProjectionSnapshot(scope, 'credential-a', 'models', queryChanged),
            subscribeProviderModelProjectionSnapshot(scope, 'credential-a', 'other-models', siblingChanged),
            subscribeProviderModelProjectionSnapshot({ ...scope, serverId: 'other' }, 'credential-a', 'models', siblingChanged)];
        try {
            const projection = DaemonProviderModelProjectionResponseV1Schema.parse({ status: 'success',
                agentTargetKey: 'agent:happier.agent.codex/codex', groups: [] });
            if (projection.status !== 'success') throw new Error('Expected successful fixture');
            beginProviderModelProjectionRead(scope, 'credential-a', 'models')(projection);
            expect(queryChanged).toHaveBeenCalledTimes(1);
            expect(catalogChanged).not.toHaveBeenCalled();
            expect(siblingChanged).not.toHaveBeenCalled();
        } finally { for (const release of releases) release(); }
    });

    it('withdraws model display data with Account-mode refusal and cannot republish the retired read', () => {
        const scope = { serverId: 'home', accountId: 'account' };
        const projection = DaemonProviderModelProjectionResponseV1Schema.parse({ status: 'success',
            agentTargetKey: 'agent:happier.agent.codex/codex', groups: [] });
        if (projection.status !== 'success') throw new Error('Expected successful fixture');
        const publish = beginProviderModelProjectionRead(scope, 'credential-a', 'models');
        publish(projection);
        expect(getProviderModelProjectionSnapshot(scope, 'credential-a', 'models')).toBe(projection);
        applyProviderCatalogSnapshot(scope, { status: 'unavailable', reason: 'account-mode-mismatch' }, true);
        expect(getProviderModelProjectionSnapshot(scope, 'credential-a', 'models')).toBeNull();
        publish(projection);
        expect(getProviderModelProjectionSnapshot(scope, 'credential-a', 'models')).toBeNull();
    });

    it('keeps the latest successful model revalidation and isolates credential/query scopes', () => {
        const scope = { serverId: 'home', accountId: 'account' };
        const projection = (agentTargetKey: string) => {
            const result = DaemonProviderModelProjectionResponseV1Schema.parse({ status: 'success', agentTargetKey, groups: [] });
            if (result.status !== 'success') throw new Error('Expected successful fixture');
            return result;
        };
        const publishEarlier = beginProviderModelProjectionRead(scope, 'credential-a', 'models');
        const publishLater = beginProviderModelProjectionRead(scope, 'credential-a', 'models');
        const latest = projection('agent:happier.agent.codex/codex');
        publishLater(latest);
        publishEarlier(projection('agent:happier.agent.claude/claude'));
        expect(getProviderModelProjectionSnapshot(scope, 'credential-a', 'models')).toBe(latest);
        expect(getProviderModelProjectionSnapshot(scope, 'credential-b', 'models')).toBeNull();
        expect(getProviderModelProjectionSnapshot(scope, 'credential-a', 'different-query')).toBeNull();
        expect(getProviderModelProjectionSnapshot({ ...scope, accountId: 'other' }, 'credential-a', 'models')).toBeNull();
    });

    it('publishes nothing across equal refreshes, but publishes a changed revision and admission loss', () => {
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
        // An equal refresh retains settled presentation.
        for (let index = 0; index < 10; index += 1) {
            beginProviderCatalogLoad(scope);
            applyProviderCatalogSnapshot(scope, structuredClone(ready), true);
        }
        expect(notifications).toBe(0);
        expect(getProviderCatalogSnapshot(scope)).toBe(initial);
        expect(getProviderCatalogSnapshot(scope)?.data).toBe(initial.data);
        applyProviderCatalogSnapshot(scope, ready, false);
        expect(getProviderCatalogSnapshot(scope)).toBe(initial);
        beginProviderCatalogLoad(scope);
        applyProviderCatalogSnapshot(scope, { ...ready, revision: 5 }, true);
        expect(notifications).toBe(1);
        expect(getProviderCatalogSnapshot(scope)?.revision).toBe(5);
        beginProviderCatalogLoad(scope, true);
        expect(getProviderCatalogSnapshot(scope)).toMatchObject({ status: 'loading', stale: true, data: initial.data });
        expect(notifications).toBe(2);
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
