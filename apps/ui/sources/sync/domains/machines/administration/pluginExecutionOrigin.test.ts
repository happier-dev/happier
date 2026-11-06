import { afterEach, describe, expect, it } from 'vitest';
import * as executionOrigins from './pluginExecutionOrigin';
import { PluginPortableReleaseManifestV1Schema } from '@happier-dev/protocol/plugins/availability/v1';

import {
    buildPluginMachineExecutionOriginCandidates,
    buildPluginMachineSourceExecutionOriginCandidates,
    combinePluginMachineExecutionOriginCandidates,
    composePluginMachineExecutionOriginV1,
    resolvePluginMachineExecutionOriginState,
    serializePluginMachineExecutionOriginMachineFacts,
    type PluginMachineExecutionOriginCandidateV1,
} from './pluginExecutionOrigin';
import { resolveFleetMachineRejection } from './fleetUnion';
import { clearMachineRequestReachabilityForTest, recordMachineRequestFailed, recordMachineRequestSucceeded } from '@/sync/domains/machines/reachability/machineReachability';
import { resolveAllProfileMachineInventorySnapshots } from '@/sync/domains/machines/machineInventorySnapshots';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { createMachineFixture } from '@/dev/testkit';
import { createAccountTokenForTests } from '@/dev/testkit/harness/homeGovernanceHarness';
import { parseToken } from '@/utils/auth/parseToken';

const accountId = parseToken(createAccountTokenForTests('plugin-owner'));
afterEach(clearMachineRequestReachabilityForTest);

describe('execution-origin Machine fact serialization', () => {
    it('updates only changed target facts and retains serialized eligibility across unrelated updates', () => {
        const targets = Array.from({ length: 138 }, (_, index) => ({ serverIdentityId: 'srv_one', machineId: `machine-${index}` }));
        const facts = new Map(targets.map((target, index) => [target.machineId,
            { activeAt: index, eligible: true, rejection: null as 'revoked' | null }]));
        let reads = 0;
        const readMachineFact = (target: typeof targets[number]) => { reads += 1; return facts.get(target.machineId)!; };
        const projection = executionOrigins.createPluginMachineExecutionOriginMachineFacts({ targets, machineSnapshots: [], readMachineFact });
        const first = projection.getSnapshot();
        reads = 0;
        const target = targets[0]!;
        for (let index = 1; index <= 5; index += 1) {
            facts.set(target.machineId, { activeAt: index / 10, eligible: true, rejection: null });
            projection.update({ machineSnapshots: [], readMachineFact }, [target]);
            expect(projection.getSnapshot()).toBe(first);
        }
        expect(reads).toBe(5);
        facts.set(target.machineId, { activeAt: 200, eligible: true, rejection: null });
        projection.update({ machineSnapshots: [], readMachineFact }, [target]);
        expect(projection.getSnapshot().eligibilityKey).toBe(first.eligibilityKey);
        expect(JSON.parse(projection.getSnapshot().activityKey)[0]).toEqual(['srv_one', target.machineId, null, true]);
        facts.set(target.machineId, { activeAt: 200, eligible: false, rejection: 'revoked' });
        projection.update({ machineSnapshots: [], readMachineFact }, [target]);
        expect(JSON.parse(projection.getSnapshot().eligibilityKey)).toContainEqual(['srv_one', target.machineId, 'revoked', false]);
        expect(reads).toBe(7);
    });

    it('keeps incremental activity ordering equivalent to a fresh selection across ties, duplicate supplies and Home boundaries', () => {
        const targets = ['srv_one', 'srv_two'].flatMap(serverIdentityId => ['a', 'b', 'c'].map(machineId => ({ serverIdentityId, machineId })));
        targets.push({ ...targets[0]! });
        const facts = new Map(targets.map((target, index) => [JSON.stringify(target),
            { activeAt: index, eligible: true, rejection: null as 'revoked' | null }]));
        const inputs = { machineSnapshots: [], readMachineFact: (target: typeof targets[number]) => facts.get(JSON.stringify(target))! };
        const projection = executionOrigins.createPluginMachineExecutionOriginMachineFacts({ ...inputs, targets });
        const initial = projection.getSnapshot();
        for (const [target, fact] of facts) facts.set(target, { ...fact, activeAt: fact.activeAt + 10 });
        projection.update(inputs, targets);
        expect(projection.getSnapshot()).toBe(initial);
        const changes = [
            [targets[0]!, { activeAt: 100, eligible: true, rejection: null }],
            [targets[3]!, { activeAt: 100, eligible: true, rejection: null }],
            [targets[0]!, { activeAt: 200, eligible: false, rejection: 'revoked' }],
            [targets[1]!, { activeAt: -1, eligible: true, rejection: null }],
            [targets[0]!, { activeAt: 0, eligible: true, rejection: null }],
        ] as const;
        for (const [target, fact] of changes) {
            facts.set(JSON.stringify(target), fact);
            projection.update(inputs, [target]);
            expect(projection.getSnapshot()).toEqual(serializePluginMachineExecutionOriginMachineFacts({ ...inputs, targets,
                pluginId: 'acme.plugin', materializations: [], sources: [] }));
        }
    });
    it('ignores activity ordering among rejected targets but retains selectable target ordering', () => {
        const rows = ['machine-a', 'machine-b'];
        const materializations = rows.map(machineId => candidate({ serverIdentityId: 'srv_one', machineId,
            materializationId: machineId }).materialization);
        const serialize = (activity: readonly number[], revoked: boolean, includeEligibility = true) => serializePluginMachineExecutionOriginMachineFacts({
            pluginId: 'acme.plugin', materializations, sources: [],
            machineSnapshots: [{ kind: 'resolved', profileId: 'home', serverIdentityId: 'srv_one',
                serverName: 'Home', accountId, observation: 'live', inventoryStatus: 'idle',
                ...(includeEligibility ? { executionEligibleMachineIds: revoked ? [] : rows } : {}),
                machines: rows.map((id, index) => createMachineFixture({ id, active: true,
                    activeAt: Date.now() + activity[index], ...(revoked ? { revokedAt: 1 } : {}) })) }],
        }).activityKey;
        expect(serialize([1, 2], true)).toBe(serialize([2, 1], true));
        expect(serialize([1, 2], false)).not.toBe(serialize([2, 1], false));
        expect(serialize([1, 2], false, false)).not.toBe(serialize([2, 1], false, false));
        expect(serialize([1, 2], true)).not.toBe(serialize([1, 2], false));
    });

    it('reads activity once per target instead of rescanning the fleet in sort comparisons', () => {
        let activityReads = 0;
        const rows = Array.from({ length: 64 }, (_, index) => ({
            id: `machine-${String(index).padStart(2, '0')}`,
            activity: (index * 17) % 64,
        }));
        const machines = rows.map(row => ({ ...createMachineFixture({ id: row.id, revokedAt: 1 }),
            get activeAt() { activityReads += 1; return row.activity; },
        }));
        const actual = serializePluginMachineExecutionOriginMachineFacts({
            pluginId: 'acme.plugin',
            materializations: rows.map(row => candidate({ serverIdentityId: 'srv_one', machineId: row.id,
                materializationId: row.id }).materialization),
            sources: [],
            machineSnapshots: [{ kind: 'resolved', profileId: 'home', serverIdentityId: 'srv_one',
                serverName: 'Home', accountId, observation: 'live', inventoryStatus: 'loading', machines }],
        });
        // Actual Fleet policy still refuses each revoked target during a pending census.
        expect(JSON.parse(actual.activityKey)).toEqual([...rows].sort((a, b) => a.id.localeCompare(b.id))
            .map(row => ['srv_one', row.id, 'revoked', false]));
        expect(activityReads).toBe(rows.length);
    });
});

function candidate(input: Readonly<{
    serverIdentityId: string;
    machineId: string;
    materializationId: string;
    pluginId?: string;
    version?: string;
    releaseContent?: PluginMachineExecutionOriginCandidateV1['releaseContent'];
    validation?: PluginMachineExecutionOriginCandidateV1['validation'];
    sourceClass?: PluginMachineExecutionOriginCandidateV1['materialization']['sourceClass'];
}>): PluginMachineExecutionOriginCandidateV1 {
    return {
        materialization: {
            serverIdentityId: input.serverIdentityId,
            machineId: input.machineId,
            materializationId: input.materializationId,
            pluginId: input.pluginId ?? 'acme.plugin',
            version: input.version ?? '1.0.0',
            sourceClass: input.sourceClass ?? 'registryPackage',
            portableRelease: input.sourceClass !== 'localPath',
            uiArtifacts: [],
            enabled: true,
            trustState: 'trusted',
            observedAt: 100,
        },
        releaseContent: input.releaseContent ?? 'matched',
        validation: input.validation ?? { kind: 'admitted' },
    };
}

describe('resolvePluginMachineExecutionOriginState', () => {
    it('retains unknown contributor coverage instead of treating a thin incumbent as proven empty', () => {
        const a = candidate({ serverIdentityId: 'srv_one', machineId: 'machine-a', materializationId: 'a' });
        const b = candidate({ serverIdentityId: 'srv_one', machineId: 'machine-b', materializationId: 'b' });
        const source = { ...b.materialization, pluginId: 'acme.source', declaredManifest:
            PluginPortableReleaseManifestV1Schema.parse({ schemaVersion: 2, id: 'acme.source', version: '1.0.0',
                displayName: 'Source', runtime: { apiVersion: 1 }, contributes: {
                    actions: [{ id: 'read', title: 'Read', scopes: ['global'], surfaces: ['ui'], placementBindings: [],
                        dangerLevel: 'safe', execution: { target: 'daemon' } }],
                    targetedPluginContributions: [{ id: 'source', target: { pluginId: 'acme.plugin', pointId: 'sources' },
                        protocol: { id: 'sources', version: 1 }, operations: { read: 'read' } }],
                } }) };
        const origin = composePluginMachineExecutionOriginV1(a.materialization);
        for (const sourceMaterializations of [[], [a.materialization, b.materialization], [a.materialization, source]]) {
            expect(resolvePluginMachineExecutionOriginState({ pluginId: 'acme.plugin', storedOrigin: null,
                automaticOrigin: origin, candidates: [a, b], sourceMaterializations,
                lastUsedTarget: { serverIdentityId: 'srv_one', machineId: 'machine-b' } }))
                .toMatchObject({ kind: 'selected', origin });
        }
    });
    it('retains the admitted Auto Machine when its supplying origin is replaced at equal coverage', () => {
        const previous = candidate({ serverIdentityId: 'srv_one', machineId: 'machine-a', materializationId: 'previous' });
        const replacement = candidate({ serverIdentityId: 'srv_one', machineId: 'machine-a', materializationId: 'replacement' });
        const other = candidate({ serverIdentityId: 'srv_one', machineId: 'machine-b', materializationId: 'other' });
        const params = { pluginId: 'acme.plugin', storedOrigin: null,
            automaticOrigin: composePluginMachineExecutionOriginV1(previous.materialization), candidates: [replacement, other],
            lastUsedTarget: { serverIdentityId: 'srv_one', machineId: 'machine-b' } };
        expect(resolvePluginMachineExecutionOriginState(params)).toMatchObject({ kind: 'selected',
            origin: composePluginMachineExecutionOriginV1(replacement.materialization), selectionSource: 'auto' });
        expect(resolvePluginMachineExecutionOriginState({ ...params, candidates: [
            { ...replacement, validation: { kind: 'rejected', reason: 'offline' } }, other,
        ] })).toMatchObject({ kind: 'selected', origin: composePluginMachineExecutionOriginV1(other.materialization) });
    });

    it('replaces Auto only with a known contributor superset that preserves native readiness', () => {
        const a = candidate({ serverIdentityId: 'srv_one', machineId: 'machine-a', materializationId: 'a' });
        const b = candidate({ serverIdentityId: 'srv_one', machineId: 'machine-b', materializationId: 'b' });
        const originA = composePluginMachineExecutionOriginV1(a.materialization);
        const originB = composePluginMachineExecutionOriginV1(b.materialization);
        const contributor = (host: typeof a, id: string, target = 'acme.plugin', accountOnly = false) => ({
            ...host.materialization, pluginId: id, materializationId: `${host.materialization.machineId}-${id}`,
            declaredManifest: PluginPortableReleaseManifestV1Schema.parse({ schemaVersion: 2, id, version: '1.0.0',
                displayName: id, runtime: { apiVersion: 1 }, contributes: {
                    connectedAccountDescriptors: [{ id: 'account', title: 'Account', authentication: {
                        native: { systemTool: 'gh' }, defaultModeId: 'manual', modes: [{ id: 'manual', kind: 'manual',
                            outcomeReconciliation: 'none', fields: [{ id: 'credential', title: 'Credential',
                                schema: { type: 'string' }, secret: true }] }],
                    } }],
                    actions: [{ id: 'read', title: 'Read', scopes: ['global'], surfaces: ['ui'], placementBindings: [], dangerLevel: 'safe',
                        execution: accountOnly ? { target: 'account', account: { artifactId: 'runtime', exportName: 'activate' } }
                            : { target: 'daemon' } }],
                    targetedPluginContributions: [{ id: 'source', target: { pluginId: target, pointId: 'sources' },
                        protocol: { id: 'sources', version: 1 }, operations: { read: 'read' } }],
                } }),
        });
        const sourceA = contributor(a, 'acme.source-one');
        const sourceB = contributor(b, 'acme.source-one');
        const secondB = contributor(b, 'acme.source-two');
        const params = { pluginId: 'acme.plugin', storedOrigin: null, candidates: [a, b],
            lastUsedTarget: { serverIdentityId: 'srv_one', machineId: 'machine-a' },
            localMachineTarget: { serverIdentityId: 'srv_one', machineId: 'machine-a' },
            machineActivity: [{ serverIdentityId: 'srv_one', machineId: 'machine-a', activeAt: 100 }],
            sourceMaterializations: [sourceA, sourceB, secondB] };
        expect(resolvePluginMachineExecutionOriginState(params)).toMatchObject({ kind: 'selected', origin: originB });
        // The configured-source recovery contract permits a strict known superset,
        // including a peer whose additional installation declarations are unknown.
        const unknownA = { ...a.materialization, pluginId: 'acme.pending' };
        const unknownB = { ...unknownA, machineId: b.materialization.machineId };
        expect(resolvePluginMachineExecutionOriginState({ ...params, automaticOrigin: originA,
            sourceMaterializations: [sourceA, sourceB, secondB, unknownA, unknownB,
                ...['shared-two', 'shared-three', 'shared-four'].flatMap(id =>
                    [contributor(a, `acme.${id}`), contributor(b, `acme.${id}`)])],
            nativeToolAuthentication: [a, b].map(host => ({ serverIdentityId: host.materialization.serverIdentityId,
                machineId: host.materialization.machineId, systemTool: 'gh', authenticated: true })) }))
            .toMatchObject({ kind: 'selected', origin: originB });
        expect(resolvePluginMachineExecutionOriginState({ ...params, automaticOrigin: originA }))
            .toMatchObject({ kind: 'selected', origin: originB });
        expect(resolvePluginMachineExecutionOriginState({ ...params, automaticOrigin: originA,
            sourceMaterializations: [sourceA, sourceB, secondB, unknownA] }))
            .toMatchObject({ kind: 'selected', origin: originB });
        expect(resolvePluginMachineExecutionOriginState({ ...params, automaticOrigin: originA,
            sourceMaterializations: [sourceB, secondB, unknownA] }))
            .toMatchObject({ kind: 'selected', origin: originA });
        const thirdB = contributor(b, 'acme.source-three');
        expect(resolvePluginMachineExecutionOriginState({ ...params, automaticOrigin: originA,
            sourceMaterializations: [sourceA, secondB, thirdB] }))
            .toMatchObject({ kind: 'selected', origin: originA });
        const c = candidate({ serverIdentityId: 'srv_one', machineId: 'machine-c', materializationId: 'c' });
        expect(resolvePluginMachineExecutionOriginState({ ...params, automaticOrigin: originA, candidates: [a, b, c],
            sourceMaterializations: [sourceA, sourceB, secondB, ...['three', 'four', 'five']
                .map(id => contributor(c, `acme.source-${id}`))] }))
            .toMatchObject({ kind: 'selected', origin: originB });
        // Only settled declarations prove the incumbent supplies no sources.
        const emptyA = { ...sourceA, declaredManifest: PluginPortableReleaseManifestV1Schema.parse({
            ...sourceA.declaredManifest, contributes: {} }) };
        expect(resolvePluginMachineExecutionOriginState({ ...params, automaticOrigin: originA,
            sourceMaterializations: [emptyA, sourceB, secondB] }))
            .toMatchObject({ kind: 'selected', origin: originB });
        expect(resolvePluginMachineExecutionOriginState({ ...params, automaticOrigin: originB,
            sourceMaterializations: [sourceA, sourceB] })).toMatchObject({ kind: 'selected', origin: originB });
        const nativeToolAuthentication = [{ serverIdentityId: 'srv_one', machineId: 'machine-a', systemTool: 'gh', authenticated: true },
            { serverIdentityId: 'srv_one', machineId: 'machine-b', systemTool: 'gh', authenticated: false }];
        expect(resolvePluginMachineExecutionOriginState({ ...params, automaticOrigin: originB, nativeToolAuthentication }))
            .toMatchObject({ kind: 'selected', origin: originB });
        expect(resolvePluginMachineExecutionOriginState({ ...params, nativeToolAuthentication }))
            .toMatchObject({ kind: 'selected', origin: originA });
        expect(resolvePluginMachineExecutionOriginState({ ...params, automaticOrigin: originA, nativeToolAuthentication }))
            .toMatchObject({ kind: 'selected', origin: originA });
        expect(resolvePluginMachineExecutionOriginState({ ...params, automaticOrigin: originA,
            nativeToolAuthentication: [{ ...nativeToolAuthentication[0]!, authenticated: true },
                { ...nativeToolAuthentication[1]!, authenticated: true }] }))
            .toMatchObject({ kind: 'selected', origin: originB });
        expect(resolvePluginMachineExecutionOriginState({ ...params, sourceMaterializations: [sourceA, sourceB, sourceB,
            { ...secondB, enabled: false }, contributor(b, 'acme.other', 'acme.other-target'),
            contributor(b, 'acme.account-source', 'acme.plugin', true),
            { ...secondB, trustState: 'revoked' }, { ...secondB, serverIdentityId: 'srv_other' }] }))
            .toMatchObject({ kind: 'selected', origin: originA });
        expect(resolvePluginMachineExecutionOriginState({ ...params, storedOrigin: originA }))
            .toMatchObject({ kind: 'selected', origin: originA, selectionSource: 'pinned' });
        expect(resolvePluginMachineExecutionOriginState({ ...params, storedTarget: params.lastUsedTarget }))
            .toMatchObject({ kind: 'selected', origin: originA, selectionSource: 'pinned' });
        expect(resolvePluginMachineExecutionOriginState({ ...params, candidates: [a,
            { ...b, validation: { kind: 'rejected', reason: 'offline' } }] })).toMatchObject({ kind: 'selected', origin: originA });
        expect(resolvePluginMachineExecutionOriginState({ ...params, autoPick: false }))
            .toMatchObject({ kind: 'selectionRequired' });
    });
    it('auto-picks compatible admitted supply during census hydration and keeps unresolved coverage pending', () => {
        const a = candidate({ serverIdentityId: 'srv_one', machineId: 'machine-a', materializationId: 'a' });
        const b = candidate({ serverIdentityId: 'srv_one', machineId: 'machine-b', materializationId: 'b', version: '2.0.0' });
        const params = { pluginId: 'acme.plugin', storedOrigin: null, inventoryPending: true,
            renderedVersion: '1.0.0', candidates: [b, a] };
        expect(resolvePluginMachineExecutionOriginState(params)).toMatchObject({ kind: 'selected',
            origin: composePluginMachineExecutionOriginV1(a.materialization), selectionSource: 'auto' });
        for (const candidates of [[], [b], [{ ...a, validation: { kind: 'rejected', reason: 'unknown' } }]] as const) {
            expect(resolvePluginMachineExecutionOriginState({ ...params, candidates })).toMatchObject({
                kind: 'unavailable', reasons: ['unknown'],
            });
        }
    });
    it('auto-picks by last use, own Machine, then activity with stable ties, and re-picks a dropped auto target', () => {
        const a = candidate({ serverIdentityId: 'srv_one', machineId: 'machine-a', materializationId: 'a' });
        const b = candidate({ serverIdentityId: 'srv_one', machineId: 'machine-b', materializationId: 'b' });
        const target = (entry: typeof a) => ({ serverIdentityId: entry.materialization.serverIdentityId, machineId: entry.materialization.machineId });
        const params = { pluginId: 'acme.plugin', storedOrigin: null, candidates: [b, a],
            machineActivity: [{ ...target(a), activeAt: 100 }, { ...target(b), activeAt: 200 }] };
        const selected = (entry: typeof a) => ({ kind: 'selected', origin: composePluginMachineExecutionOriginV1(entry.materialization), selectionSource: 'auto' });
        expect(resolvePluginMachineExecutionOriginState(params)).toMatchObject(selected(b));
        expect(resolvePluginMachineExecutionOriginState({ ...params, localMachineTarget: target(a) })).toMatchObject(selected(a));
        expect(resolvePluginMachineExecutionOriginState({ ...params, localMachineTarget: target(b), lastUsedTarget: target(a) })).toMatchObject(selected(a));
        expect(resolvePluginMachineExecutionOriginState({ ...params, lastUsedTarget: { ...target(a), serverIdentityId: 'srv_elsewhere' } })).toMatchObject(selected(b));
        expect(resolvePluginMachineExecutionOriginState({ ...params, lastUsedTarget: target(b),
            candidates: [a, { ...b, validation: { kind: 'rejected', reason: 'offline' } }] })).toMatchObject(selected(a));
        expect(resolvePluginMachineExecutionOriginState({ ...params, machineActivity: [] })).toMatchObject(selected(a));
        expect(resolvePluginMachineExecutionOriginState({ ...params, machineActivity: [], candidates: [a, b] })).toMatchObject(selected(a));
        expect(resolvePluginMachineExecutionOriginState({ ...params, autoPick: false })).toMatchObject({ kind: 'selectionRequired' });
        expect(resolvePluginMachineExecutionOriginState({ ...params, autoPick: false,
            declaredDefaultOrigins: [composePluginMachineExecutionOriginV1(b.materialization)] })).toMatchObject({ kind: 'selectionRequired' });
    });
    it('retains an eligible automatic origin without overriding pins, compatibility or Ask', () => {
        const a = candidate({ serverIdentityId: 'srv_one', machineId: 'machine-a', materializationId: 'a' });
        const b = candidate({ serverIdentityId: 'srv_one', machineId: 'machine-b', materializationId: 'b' });
        const originA = composePluginMachineExecutionOriginV1(a.materialization);
        const originB = composePluginMachineExecutionOriginV1(b.materialization);
        const params = { pluginId: 'acme.plugin', storedOrigin: null, candidates: [a, b], automaticOrigin: originA,
            machineActivity: [{ serverIdentityId: 'srv_one', machineId: 'machine-b', activeAt: 200 }] };
        expect(resolvePluginMachineExecutionOriginState(params)).toMatchObject({ kind: 'selected', origin: originA, selectionSource: 'auto' });
        expect(resolvePluginMachineExecutionOriginState({ ...params, storedTarget: { serverIdentityId: 'srv_one', machineId: 'machine-b' } }))
            .toMatchObject({ kind: 'selected', origin: originB, selectionSource: 'pinned' });
        expect(resolvePluginMachineExecutionOriginState({ ...params, candidates: [{ ...a, validation: { kind: 'rejected', reason: 'offline' } }, b] }))
            .toMatchObject({ kind: 'selected', origin: originB, selectionSource: 'auto' });
        expect(resolvePluginMachineExecutionOriginState({ ...params, renderedVersion: '2.0.0',
            candidates: [a, candidate({ ...b.materialization, version: '2.0.0' })] }))
            .toMatchObject({ kind: 'selected', origin: originB, selectionSource: 'auto' });
        expect(resolvePluginMachineExecutionOriginState({ ...params, autoPick: false })).toMatchObject({ kind: 'selectionRequired' });
        expect(resolvePluginMachineExecutionOriginState({ ...params, contextualTarget: { serverIdentityId: 'srv_one', machineId: 'machine-b' } }))
            .toMatchObject({ kind: 'selected', origin: originB });
    });

    it('keeps an explicit admitted development choice able to replace the bundled rendered version', () => {
        const origin = { serverIdentityId: 'srv_one', sourceRef: { machineId: 'dev-machine', pluginId: 'acme.plugin',
            sourceCustody: { kind: 'development', registeredRootId: 'dev-root' } } } as const;
        const source = { source: { origin, version: '2.0.0', occurrenceId: 'dev-occurrence', serverId: 'local-one' },
            releaseContent: 'matched', validation: { kind: 'admitted' } } as const;
        const params = { pluginId: 'acme.plugin', storedOrigin: null, renderedVersion: '1.0.0', candidates: [source] };
        expect(resolvePluginMachineExecutionOriginState({ ...params, storedOrigin: origin })).toMatchObject({ kind: 'selected', origin, selectionSource: 'pinned' });
        expect(resolvePluginMachineExecutionOriginState({ ...params, storedTarget: { serverIdentityId: 'srv_one', machineId: 'dev-machine' } }))
            .toMatchObject({ kind: 'selected', origin, selectionSource: 'pinned' });
    });
    it('prefers the rendered release across versions and asks only if no selectable version matches', () => {
        const a = candidate({ serverIdentityId: 'srv_one', machineId: 'machine-a', materializationId: 'a' });
        const b = candidate({ serverIdentityId: 'srv_one', machineId: 'machine-b', materializationId: 'b', version: '2.0.0' });
        const params = { pluginId: 'acme.plugin', storedOrigin: null, candidates: [a, b], renderedVersion: '2.0.0' };
        expect(resolvePluginMachineExecutionOriginState(params)).toMatchObject({ kind: 'selected',
            origin: composePluginMachineExecutionOriginV1(b.materialization), selectionSource: 'auto' });
        expect(resolvePluginMachineExecutionOriginState({ ...params, renderedVersion: '3.0.0' })).toMatchObject({ kind: 'conflict', reasons: ['different_versions'] });
        expect(resolvePluginMachineExecutionOriginState({ ...params, storedTarget: { serverIdentityId: 'srv_one', machineId: 'machine-a' },
            candidates: [{ ...a, validation: { kind: 'rejected', reason: 'offline' } }, b] })).toMatchObject({ kind: 'unavailable', reasons: ['offline'] });
    });
    it('uses only the local Home for an unpinned operation', () => {
        const local = candidate({ serverIdentityId: 'srv_one', machineId: 'local', materializationId: 'local-custody' });
        const foreign = candidate({ serverIdentityId: 'srv_two', machineId: 'foreign', materializationId: 'foreign-custody' });
        expect(resolvePluginMachineExecutionOriginState({ pluginId: 'acme.plugin', storedOrigin: null,
            homeServerIdentityId: 'srv_one', candidates: [foreign] })).toMatchObject({ kind: 'unavailable' });
        expect(resolvePluginMachineExecutionOriginState({ pluginId: 'acme.plugin', storedOrigin: null,
            homeServerIdentityId: 'srv_one', candidates: [foreign, local], declaredDefaultOrigins: [composePluginMachineExecutionOriginV1(foreign.materialization)] }))
            .toMatchObject({ kind: 'selected', origin: composePluginMachineExecutionOriginV1(local.materialization), selectionSource: 'auto' });
    });
    it('keeps an offline explicit Machine pinned while resolving replacement custody on that Machine', () => {
        const own = candidate({ serverIdentityId: 'srv_one', machineId: 'pinned-machine', materializationId: 'new-custody' });
        const other = candidate({ serverIdentityId: 'srv_one', machineId: 'online-machine', materializationId: 'other' });
        const storedTarget = { serverIdentityId: 'srv_one', machineId: 'pinned-machine' };
        expect(resolvePluginMachineExecutionOriginState({ pluginId: 'acme.plugin', storedOrigin: null, storedTarget,
            candidates: [own, other] })).toMatchObject({ kind: 'selected', origin: composePluginMachineExecutionOriginV1(own.materialization) });
        expect(resolvePluginMachineExecutionOriginState({ pluginId: 'acme.plugin', storedOrigin: null, storedTarget,
            candidates: [{ ...own, validation: { kind: 'rejected', reason: 'offline' } }, other] }))
            .toMatchObject({ kind: 'unavailable', storedTarget, reasons: ['offline'] });
        expect(resolvePluginMachineExecutionOriginState({ pluginId: 'acme.plugin', storedOrigin: null, storedTarget,
            candidates: [other], storedOriginMachinePresence: 'offline' }))
            .toMatchObject({ kind: 'unavailable', storedTarget, reasons: ['offline'] });
    });
    it('defaults a contextual Session panel to its exact machine rather than an unrelated saved offline origin', () => {
        const own = candidate({ serverIdentityId: 'srv_one', machineId: 'session-machine', materializationId: 'own' });
        const other = candidate({ serverIdentityId: 'srv_one', machineId: 'unrelated-machine', materializationId: 'other',
            validation: { kind: 'rejected', reason: 'offline' } });
        const saved = { serverIdentityId: 'srv_one', materializationRef: { pluginId: 'acme.plugin', machineId: 'unrelated-machine', materializationId: 'other' } };
        const sameIdElsewhere = candidate({ serverIdentityId: 'srv_two', machineId: 'session-machine', materializationId: 'elsewhere' });
        expect(resolvePluginMachineExecutionOriginState({ pluginId: 'acme.plugin', storedOrigin: saved, candidates: [own, other, sameIdElsewhere],
            contextualTarget: { serverIdentityId: 'srv_one', machineId: 'session-machine' } })).toMatchObject({
            kind: 'selected', origin: { materializationRef: { machineId: 'session-machine' } },
        });
        expect(resolvePluginMachineExecutionOriginState({ pluginId: 'acme.plugin', storedOrigin: saved, candidates: [other],
            contextualTarget: { serverIdentityId: 'srv_one', machineId: 'session-machine' } })).toMatchObject({ kind: 'unavailable' });
        expect(resolvePluginMachineExecutionOriginState({ pluginId: 'acme.plugin', storedOrigin: null, candidates: [own],
            contextualTarget: null })).toMatchObject({ kind: 'unavailable' });
        expect(resolvePluginMachineExecutionOriginState({ pluginId: 'acme.plugin', storedOrigin: saved, candidates: [own, other] }))
            .toMatchObject({ kind: 'unavailable', storedOrigin: saved });
    });
    it('ignores a nonselectable machine-local census when auto-picking a compatible admitted copy', () => {
        const current = candidate({ serverIdentityId: 'srv_one', machineId: 'current-machine', materializationId: 'current', version: '2.0.0' });
        const local = candidate({ serverIdentityId: 'srv_one', machineId: 'local-machine', materializationId: 'local',
            version: '1.0.0', sourceClass: 'localPath' });
        const state = resolvePluginMachineExecutionOriginState({ pluginId: 'acme.plugin', storedOrigin: null,
            candidates: [current, local] });
        expect(state).toMatchObject({ kind: 'selected', selectionSource: 'auto',
            origin: composePluginMachineExecutionOriginV1(current.materialization) });
    });
    it('keeps source and release selection aligned with server-scoped reachability and retry recovery', () => {
        const machineId = 'plugin-reachability-machine';
        const serverId = 'plugin-reachability-home';
        const materialization = candidate({ serverIdentityId: 'srv_reachability', machineId, materializationId: 'reachability-mat' }).materialization;
        const source = { source: { origin: { serverIdentityId: 'srv_reachability', sourceRef: { machineId,
            pluginId: 'acme.plugin', sourceCustody: { kind: 'development', registeredRootId: 'reachability-root' } } },
            version: '1.0.0', occurrenceId: 'reachability-occurrence', serverId },
            releaseContent: 'matched', validation: { kind: 'admitted' } } as const;
        const machineSnapshots = [{ kind: 'resolved', accountId, profileId: serverId, serverIdentityId: 'srv_reachability',
            serverName: 'Studio', observation: 'live', machines: [{ id: machineId, updatedAt: 1, active: true,
                activeAt: Date.now(), revokedAt: null, metadataVersion: 1, metadata: null }] }] as const;
        const readCandidates = () => [
            ...buildPluginMachineExecutionOriginCandidates({ pluginId: 'acme.plugin', materializations: [materialization],
                machineSnapshots, classifyRelease: () => ({ releaseContent: 'matched', validation: { kind: 'admitted' } }) }),
            ...buildPluginMachineSourceExecutionOriginCandidates({ pluginId: 'acme.plugin', sources: [source], machineSnapshots }),
        ];
        const readSelection = () => resolvePluginMachineExecutionOriginState({ pluginId: 'acme.plugin',
            storedOrigin: source.source.origin, candidates: readCandidates() });
        const scope = { serverId: 'srv_reachability', accountId };
        recordMachineRequestFailed({ serverId: 'another-home', accountId, machineId, observedAtMs: 1 });
        recordMachineRequestFailed({ ...scope, accountId: 'another-account', machineId, observedAtMs: 1 });
        expect(readSelection()).toMatchObject({ kind: 'selected', origin: source.source.origin });
        recordMachineRequestFailed({ ...scope, machineId, observedAtMs: 2 });
        expect(readCandidates().map(entry => entry.validation)).toEqual([
            { kind: 'rejected', reason: 'home_unreachable' }, { kind: 'rejected', reason: 'home_unreachable' },
        ]);
        expect(readSelection()).toMatchObject({ kind: 'unavailable', storedOrigin: source.source.origin, reasons: ['home_unreachable'] });
        recordMachineRequestSucceeded({ ...scope, machineId, observedAtMs: 3 });
        expect(readSelection()).toMatchObject({ kind: 'selected', origin: source.source.origin });
    });
    it('coalesces only a machine-local census with its supplying source, not other Homes or exact sources', () => {
        const origin = { serverIdentityId: 'srv_one', sourceRef: { machineId: 'machine-a', pluginId: 'acme.plugin',
            sourceCustody: { kind: 'development', registeredRootId: 'source-a' } } } as const;
        const source = { source: { origin, version: '1.0.0', occurrenceId: 'source-a', serverId: 'local-one' },
            releaseContent: 'matched', validation: { kind: 'rejected', reason: 'offline' } } as const;
        const alternate = { ...source, source: { ...source.source, origin: { ...origin,
            sourceRef: { ...origin.sourceRef, sourceCustody: { kind: 'development', registeredRootId: 'source-b' } } } } } as const;
        const census = candidate({ serverIdentityId: 'srv_one', machineId: 'machine-a', materializationId: 'local-a', sourceClass: 'localPath' });
        const otherHome = candidate({ serverIdentityId: 'srv_two', machineId: 'machine-a', materializationId: 'local-a', sourceClass: 'localPath' });
        const portable = candidate({ serverIdentityId: 'srv_one', machineId: 'machine-a', materializationId: 'portable-a' });
        expect(combinePluginMachineExecutionOriginCandidates([census, otherHome, portable], [source, alternate]))
            .toEqual([otherHome, portable, source, alternate]);
        expect(combinePluginMachineExecutionOriginCandidates([census], [])).toEqual([census]);
    });
    it('selects an exact admitted source and preserves an unavailable saved source', () => {
        const origin = { serverIdentityId: 'srv_one', sourceRef: { machineId: 'machine-a', pluginId: 'acme.plugin',
            sourceCustody: { kind: 'development', registeredRootId: 'registered-source-a' } } } as const;
        const sourceCandidate = { source: { origin, version: '1.0.0', occurrenceId: 'occurrence-a',
            serverId: 'local-one' }, releaseContent: 'matched', validation: { kind: 'admitted' } } as const;
        expect(resolvePluginMachineExecutionOriginState({ pluginId: 'acme.plugin', storedOrigin: null,
            candidates: [sourceCandidate] })).toMatchObject({ kind: 'selected', origin, selectionSource: 'auto' });
        expect(resolvePluginMachineExecutionOriginState({ pluginId: 'acme.plugin', storedOrigin: origin,
            candidates: [{ ...sourceCandidate, validation: { kind: 'rejected', reason: 'offline' } }] }))
            .toMatchObject({ kind: 'unavailable', storedOrigin: origin, reasons: ['offline'] });
        const replacement = { ...sourceCandidate, source: { ...sourceCandidate.source, origin: { ...origin,
            sourceRef: { ...origin.sourceRef, sourceCustody: { kind: 'development', registeredRootId: 'replacement-source' } } } } } as const;
        expect(resolvePluginMachineExecutionOriginState({ pluginId: 'acme.plugin', storedOrigin: origin,
            candidates: [replacement] })).toMatchObject({ kind: 'unavailable', reasons: ['missing'] });
    });
    it('uses an admitted plugin default after explicit preference and before sole selection', () => {
        const a = candidate({ serverIdentityId: 'srv_one', machineId: 'machine-a', materializationId: 'mat-a' });
        const b = candidate({ serverIdentityId: 'srv_one', machineId: 'machine-b', materializationId: 'mat-b' });
        const origin = (entry: typeof a) => ({ serverIdentityId: entry.materialization.serverIdentityId,
            materializationRef: { machineId: entry.materialization.machineId, materializationId: entry.materialization.materializationId, pluginId: 'acme.plugin' } });
        expect(resolvePluginMachineExecutionOriginState({ pluginId: 'acme.plugin', storedOrigin: null,
            candidates: [a, b], declaredDefaultOrigins: [origin(b)] })).toMatchObject({ kind: 'selected', origin: origin(b), selectionSource: 'auto' });
        expect(resolvePluginMachineExecutionOriginState({ pluginId: 'acme.plugin', storedOrigin: null,
            candidates: [{ ...a, releaseContent: 'unknown' }, b], declaredDefaultOrigins: [origin(b)] }))
            .toMatchObject({ kind: 'selected', origin: origin(b), selectionSource: 'auto' });
        expect(resolvePluginMachineExecutionOriginState({ pluginId: 'acme.plugin', storedOrigin: origin(a),
            candidates: [a, b], declaredDefaultOrigins: [origin(b)] })).toMatchObject({ kind: 'selected', origin: origin(a), selectionSource: 'pinned' });
        const offline = { ...a, validation: { kind: 'rejected', reason: 'offline' } } as const;
        expect(resolvePluginMachineExecutionOriginState({ pluginId: 'acme.plugin', storedOrigin: origin(a),
            candidates: [offline, b], declaredDefaultOrigins: [origin(b)] })).toMatchObject({ kind: 'unavailable', reasons: ['offline'] });
        expect(resolvePluginMachineExecutionOriginState({ pluginId: 'acme.plugin', storedOrigin: null,
            candidates: [a, b], autoPick: false, declaredDefaultOrigins: [origin(a), origin(b)] }).kind).toBe('selectionRequired');
        const replacement = { ...b, materialization: { ...b.materialization, machineId: a.materialization.machineId } };
        expect(resolvePluginMachineExecutionOriginState({ pluginId: 'acme.plugin', storedOrigin: null,
            storedTarget: { serverIdentityId: 'srv_one', machineId: 'machine-a' },
            candidates: [a, replacement], declaredDefaultOrigins: [origin(replacement)] }))
            .toMatchObject({ kind: 'selected', origin: origin(replacement), selectionSource: 'pinned' });
    });
    it('composes uncollapsed Availability rows with exact machine state and Artifact-owned release validation', () => {
        const materialization = candidate({
            serverIdentityId: 'srv_one',
            machineId: 'machine-a',
            materializationId: 'mat-a',
        }).materialization;
        const candidates = buildPluginMachineExecutionOriginCandidates({
            pluginId: 'acme.plugin',
            materializations: [materialization],
            machineSnapshots: [{
                kind: 'resolved',
                accountId,
                profileId: 'local-one',
                serverIdentityId: 'srv_one',
                serverName: 'Server One',
                observation: 'live',
                machines: [{
                    id: 'machine-a',
                    updatedAt: 100,
                    active: true,
                    activeAt: Date.now(),
                    revokedAt: null,
                    metadataVersion: 1,
                    metadata: null,
                }],
            }],
            classifyRelease: () => ({
                releaseContent: 'matched',
                validation: { kind: 'admitted' },
            }),
        });

        expect(candidates).toEqual([{
            materialization,
            releaseContent: 'matched',
            validation: { kind: 'admitted' },
        }]);
    });

    it('keeps the candidate set scoped to the requested plugin before presentation', () => {
        const own = candidate({
            serverIdentityId: 'srv_one',
            machineId: 'machine-a',
            materializationId: 'mat-own',
        }).materialization;
        const foreign = candidate({
            serverIdentityId: 'srv_one',
            machineId: 'machine-a',
            materializationId: 'mat-foreign',
            pluginId: 'other.plugin',
        }).materialization;
        const input = {
            pluginId: 'acme.plugin',
            materializations: [foreign, own],
            machineSnapshots: [{
                kind: 'resolved' as const,
                accountId,
                profileId: 'local-one',
                serverIdentityId: 'srv_one',
                serverName: 'Server One',
                observation: 'live' as const,
                machines: [{
                    id: 'machine-a',
                    updatedAt: 100,
                    active: true,
                    activeAt: Date.now(),
                    revokedAt: null,
                    metadataVersion: 1,
                    metadata: null,
                }],
            }],
            classifyRelease: () => ({
                releaseContent: 'matched' as const,
                validation: { kind: 'admitted' as const },
            }),
        };

        expect(buildPluginMachineExecutionOriginCandidates(input).map((entry) => entry.materialization.pluginId))
            .toEqual(['acme.plugin']);
    });

    it('fails stale, replaced, revoked, disabled, and untrusted Availability rows closed before selection', () => {
        const base = candidate({
            serverIdentityId: 'srv_one',
            machineId: 'machine-a',
            materializationId: 'mat-a',
        }).materialization;
        const classifyRelease = () => ({
            releaseContent: 'matched' as const,
            validation: { kind: 'admitted' as const },
        });
        const machineSnapshot = (machine: Readonly<{
            replacedByMachineId?: string;
            revokedAt?: number;
        }>, observation: 'live' | 'stale' = 'live') => [{
            kind: 'resolved' as const,
            accountId,
            profileId: 'local-one',
            serverIdentityId: 'srv_one',
            serverName: 'Server One',
            observation,
            machines: [{
                id: 'machine-a',
                updatedAt: 100,
                active: true,
                activeAt: Date.now(),
                revokedAt: machine.revokedAt ?? null,
                replacedByMachineId: machine.replacedByMachineId ?? null,
                metadataVersion: 1,
                metadata: null,
            }],
        }];

        expect(buildPluginMachineExecutionOriginCandidates({
            pluginId: 'acme.plugin',
            materializations: [base],
            machineSnapshots: machineSnapshot({}, 'stale'),
            classifyRelease,
        })[0]?.validation).toEqual({ kind: 'rejected', reason: 'stale' });
        expect(buildPluginMachineExecutionOriginCandidates({
            pluginId: 'acme.plugin',
            materializations: [base],
            machineSnapshots: machineSnapshot({ replacedByMachineId: 'machine-b' }),
            classifyRelease,
        })[0]?.validation).toEqual({ kind: 'rejected', reason: 'replaced' });
        expect(buildPluginMachineExecutionOriginCandidates({
            pluginId: 'acme.plugin',
            materializations: [base],
            machineSnapshots: machineSnapshot({ revokedAt: 100 }),
            classifyRelease,
        })[0]?.validation).toEqual({ kind: 'rejected', reason: 'revoked' });
        expect(buildPluginMachineExecutionOriginCandidates({
            pluginId: 'acme.plugin',
            materializations: [{ ...base, enabled: false }],
            machineSnapshots: machineSnapshot({}),
            classifyRelease,
        })[0]?.validation).toEqual({ kind: 'rejected', reason: 'disabled' });
        expect(buildPluginMachineExecutionOriginCandidates({
            pluginId: 'acme.plugin',
            materializations: [{ ...base, trustState: 'untrusted' }],
            machineSnapshots: machineSnapshot({}),
            classifyRelease,
        })[0]?.validation).toEqual({ kind: 'rejected', reason: 'untrusted' });
    });

    it('keeps a stored origin selected through its Home\'s machine-list refresh, including a failed one', () => {
        const base = candidate({ serverIdentityId: 'srv_one', machineId: 'machine-a', materializationId: 'mat-a' }).materialization;
        const stored = composePluginMachineExecutionOriginV1(base);
        const row = createMachineFixture({ id: 'machine-a', active: true, activeAt: Date.now() });
        const profile = { id: 'local-one', name: 'Server One', serverUrl: 'https://one.example.test', serverIdentityId: 'srv_one',
            createdAt: 1, updatedAt: 1, lastUsedAt: 1 };
        const stateWhen = (status: 'idle' | 'loading' | 'error') => resolvePluginMachineExecutionOriginState({
            pluginId: 'acme.plugin', storedOrigin: stored,
            candidates: buildPluginMachineExecutionOriginCandidates({
                pluginId: 'acme.plugin', materializations: [base],
                classifyRelease: () => ({ releaseContent: 'matched' as const, validation: { kind: 'admitted' as const } }),
                machineSnapshots: resolveAllProfileMachineInventorySnapshots({
                    profiles: [profile], activeServerId: 'local-one', activeMachines: [row],
                    machineListByServerId: { 'local-one': [row] }, machineListStatusByServerId: { 'local-one': status },
                    accountScopesByServerId: new Map([['srv_one', { serverId: 'srv_one', accountId }]]), loadWarmEntries: () => ({}),
                }),
            }),
        });
        expect(stateWhen('idle')).toMatchObject({ kind: 'selected' });
        expect(stateWhen('loading')).toMatchObject({ kind: 'selected' });
        // A failed list read never proves the stored origin's Machine gone.
        expect(stateWhen('error')).toMatchObject({ kind: 'selected' });
    });

    it('does not call a materialization\'s machine missing while its Home\'s machine list is unread', () => {
        const base = candidate({ serverIdentityId: 'srv_one', machineId: 'machine-a', materializationId: 'mat-a' }).materialization;
        const classifyRelease = () => ({ releaseContent: 'matched' as const, validation: { kind: 'admitted' as const } });
        const unread = [{ kind: 'unknown' as const, profileId: 'local-one', serverIdentityId: 'srv_one', serverName: 'Server One', machines: [] }];
        expect(buildPluginMachineExecutionOriginCandidates({
            pluginId: 'acme.plugin',
            materializations: [base],
            machineSnapshots: unread,
            classifyRelease,
        })[0]?.validation).toEqual({ kind: 'rejected', reason: 'unknown' });
        // A read list that lacks the machine: now it has really left.
        const read = [{ kind: 'resolved' as const, accountId, profileId: 'local-one', serverIdentityId: 'srv_one', serverName: 'Server One', observation: 'live' as const, settled: true as const, machines: [] }];
        expect(buildPluginMachineExecutionOriginCandidates({
            pluginId: 'acme.plugin',
            materializations: [base],
            machineSnapshots: read,
            classifyRelease,
        })[0]?.validation).toEqual({ kind: 'rejected', reason: 'missing' });
    });

    it('does not infer executable installation from a bundled plugin identity', () => {
        expect(resolvePluginMachineExecutionOriginState({
            pluginId: 'happier.claude',
            storedOrigin: null,
            candidates: [],
        })).toEqual({ kind: 'unavailable', storedOrigin: null, candidates: [], reasons: ['no_materialization'] });
    });

    it('reports unavailable for zero candidates and structurally selects the sole admitted origin', () => {
        expect(resolvePluginMachineExecutionOriginState({
            pluginId: 'acme.plugin',
            storedOrigin: null,
            candidates: [],
        })).toEqual({ kind: 'unavailable', storedOrigin: null, candidates: [], reasons: ['no_materialization'] });

        const only = candidate({
            serverIdentityId: 'srv_one',
            machineId: 'machine-a',
            materializationId: 'mat-a',
        });
        expect(resolvePluginMachineExecutionOriginState({
            pluginId: 'acme.plugin',
            storedOrigin: null,
            candidates: [only],
        })).toEqual({
            kind: 'selected',
            origin: {
                serverIdentityId: 'srv_one',
                materializationRef: {
                    machineId: 'machine-a',
                    materializationId: 'mat-a',
                    pluginId: 'acme.plugin',
                },
            },
            candidate: only,
            selectionSource: 'auto',
        });
    });

    it('retains explicit choice between matching replicas for an opt-out plugin under input permutation', () => {
        const machineA = candidate({ serverIdentityId: 'srv_one', machineId: 'machine-a', materializationId: 'mat-a' });
        const machineB = candidate({ serverIdentityId: 'srv_one', machineId: 'machine-b', materializationId: 'mat-b' });

        const first = resolvePluginMachineExecutionOriginState({
            autoPick: false,
            pluginId: 'acme.plugin',
            storedOrigin: null,
            candidates: [machineB, machineA],
        });
        const reordered = resolvePluginMachineExecutionOriginState({
            autoPick: false,
            pluginId: 'acme.plugin',
            storedOrigin: null,
            candidates: [machineA, machineB],
        });

        expect(first).toEqual({ kind: 'selectionRequired', candidates: [machineA, machineB] });
        expect(reordered).toEqual(first);
    });

    it('fails closed for divergent versions, conflicting content, and machine-local rows', () => {
        const base = candidate({ serverIdentityId: 'srv_one', machineId: 'machine-a', materializationId: 'mat-a' });
        const divergent = candidate({
            serverIdentityId: 'srv_one',
            machineId: 'machine-b',
            materializationId: 'mat-b',
            version: '2.0.0',
        });
        expect(resolvePluginMachineExecutionOriginState({
            pluginId: 'acme.plugin',
            storedOrigin: null,
            candidates: [base, divergent],
        }).kind).toBe('conflict');

        const contentConflict = candidate({
            serverIdentityId: 'srv_one',
            machineId: 'machine-b',
            materializationId: 'mat-b',
            releaseContent: 'conflict',
        });
        expect(resolvePluginMachineExecutionOriginState({
            pluginId: 'acme.plugin',
            storedOrigin: null,
            candidates: [base, contentConflict], autoPick: false,
        }).kind).toBe('conflict');

        const local = candidate({
            serverIdentityId: 'srv_one',
            machineId: 'machine-b',
            materializationId: 'mat-local',
            sourceClass: 'localPath',
        });
        expect(resolvePluginMachineExecutionOriginState({
            pluginId: 'acme.plugin',
            storedOrigin: null,
            candidates: [base, local], autoPick: false,
        }).kind).toBe('conflict');
    });

    it('retains an unavailable stored origin and never roams to another admitted replica', () => {
        const old = candidate({
            serverIdentityId: 'srv_one',
            machineId: 'machine-a',
            materializationId: 'mat-a',
            validation: { kind: 'rejected', reason: 'offline' },
        });
        const replacement = candidate({
            serverIdentityId: 'srv_one',
            machineId: 'machine-b',
            materializationId: 'mat-b',
        });

        expect(resolvePluginMachineExecutionOriginState({
            pluginId: 'acme.plugin',
            storedOrigin: {
                serverIdentityId: 'srv_one',
                materializationRef: {
                    machineId: 'machine-a',
                    materializationId: 'mat-a',
                    pluginId: 'acme.plugin',
                },
            },
            candidates: [replacement, old],
        })).toEqual({
            kind: 'unavailable',
            storedOrigin: {
                serverIdentityId: 'srv_one',
                materializationRef: {
                    machineId: 'machine-a',
                    materializationId: 'mat-a',
                    pluginId: 'acme.plugin',
                },
            },
            candidates: [old, replacement],
            reasons: ['offline'],
        });
    });

    it('names an offline machine, not a missing source, when the stored source left with its machine', () => {
        // Live 2026-10-16 (PLUGVIS 2h): PRs & Issues pinned to an offline machine said "Its source isn't
        // available" — an offline machine stops advertising its sources, so the stored source had no candidate.
        const machineId = 'pinned-offline-machine';
        const origin = { serverIdentityId: 'srv_pinned', sourceRef: { machineId, pluginId: 'acme.plugin',
            sourceCustody: { kind: 'development', registeredRootId: 'pinned-root' } } } as const;
        const snapshotWith = (activeAt: number, machines = [{ id: machineId, updatedAt: 1, active: activeAt > 0,
            activeAt, revokedAt: null, metadataVersion: 1, metadata: null }]) => [{ kind: 'resolved', accountId,
            profileId: 'pinned-home', serverIdentityId: 'srv_pinned', serverName: 'Studio', observation: 'live',
            settled: true, machines }] as const;
        const stateWith = (machineSnapshots: ReturnType<typeof snapshotWith>) => resolvePluginMachineExecutionOriginState({
            pluginId: 'acme.plugin', storedOrigin: origin, candidates: [],
            storedOriginMachinePresence: resolveFleetMachineRejection({ serverIdentityId: 'srv_pinned', machineId, machineSnapshots }) });
        recordMachineRequestFailed({ serverId: 'srv_pinned', accountId, machineId, observedAtMs: 2 });
        expect(stateWith(snapshotWith(0))).toMatchObject({ kind: 'unavailable', storedOrigin: origin, reasons: ['home_unreachable'] });
        // The machine itself is gone from its Home: the source is missing, not offline.
        expect(stateWith(snapshotWith(0, []))).toMatchObject({ kind: 'unavailable', reasons: ['missing'] });
        // An online machine that no longer offers the stored source keeps blaming the source.
        recordMachineRequestSucceeded({ serverId: 'srv_pinned', accountId, machineId, observedAtMs: 3 });
        expect(stateWith(snapshotWith(Date.now()))).toMatchObject({ kind: 'unavailable', reasons: ['missing'] });
    });

    it('reports a vanished install epoch as missing instead of relocating to a healthy replica', () => {
        // Reinstalling mints a new installation epoch, so the stored epoch can
        // disappear while another admitted replica is present. Relocating there
        // silently would move execution to a machine the user never chose.
        const replacement = candidate({
            serverIdentityId: 'srv_one',
            machineId: 'machine-b',
            materializationId: 'mat-b',
        });
        const storedOrigin = {
            serverIdentityId: 'srv_one',
            materializationRef: {
                machineId: 'machine-a',
                materializationId: 'mat-a-retired',
                pluginId: 'acme.plugin',
            },
        } as const;

        expect(resolvePluginMachineExecutionOriginState({
            pluginId: 'acme.plugin',
            storedOrigin,
            candidates: [replacement],
        })).toEqual({
            kind: 'unavailable',
            storedOrigin,
            candidates: [replacement],
            reasons: ['missing'],
        });

        // Positive twin: once the stored epoch is reported again it is selected,
        // so the result above is the no-relocation rule and not a dead branch.
        const restored = candidate({
            serverIdentityId: 'srv_one',
            machineId: 'machine-a',
            materializationId: 'mat-a-retired',
        });
        expect(resolvePluginMachineExecutionOriginState({
            pluginId: 'acme.plugin',
            storedOrigin,
            candidates: [replacement, restored],
        })).toMatchObject({
            kind: 'selected',
            origin: storedOrigin,
            selectionSource: 'pinned',
        });
    });

    it('rejects a stored origin for another plugin instead of borrowing it', () => {
        const current = candidate({ serverIdentityId: 'srv_one', machineId: 'machine-a', materializationId: 'mat-a' });

        expect(resolvePluginMachineExecutionOriginState({
            pluginId: 'acme.plugin',
            storedOrigin: {
                serverIdentityId: 'srv_one',
                materializationRef: {
                    machineId: 'machine-a',
                    materializationId: 'mat-a',
                    pluginId: 'other.plugin',
                },
            },
            candidates: [current],
        })).toEqual({
            kind: 'unavailable',
            storedOrigin: expect.objectContaining({
                materializationRef: expect.objectContaining({ pluginId: 'other.plugin' }),
            }),
            candidates: [current],
            reasons: ['plugin_mismatch'],
        });
    });

    it('withholds a stored origin when release facts conflict even if a validator is accidentally permissive', () => {
        const conflicting = candidate({
            serverIdentityId: 'srv_one',
            machineId: 'machine-a',
            materializationId: 'mat-a',
            releaseContent: 'conflict',
            validation: { kind: 'admitted' },
        });

        expect(resolvePluginMachineExecutionOriginState({
            pluginId: 'acme.plugin',
            storedOrigin: {
                serverIdentityId: 'srv_one',
                materializationRef: {
                    machineId: 'machine-a',
                    materializationId: 'mat-a',
                    pluginId: 'acme.plugin',
                },
            },
            candidates: [conflicting],
        })).toEqual({
            kind: 'unavailable',
            storedOrigin: expect.any(Object),
            candidates: [conflicting],
            reasons: ['content_conflict'],
        });
    });

    it('does not misreport an unknown stored release fact as a proven content conflict', () => {
        const unknown = candidate({
            serverIdentityId: 'srv_one',
            machineId: 'machine-a',
            materializationId: 'mat-a',
            releaseContent: 'unknown',
            validation: { kind: 'admitted' },
        });

        expect(resolvePluginMachineExecutionOriginState({
            pluginId: 'acme.plugin',
            storedOrigin: {
                serverIdentityId: 'srv_one',
                materializationRef: {
                    machineId: 'machine-a',
                    materializationId: 'mat-a',
                    pluginId: 'acme.plugin',
                },
            },
            candidates: [unknown],
        })).toEqual({
            kind: 'unavailable',
            storedOrigin: expect.any(Object),
            candidates: [unknown],
            reasons: ['unknown'],
        });

        expect(resolvePluginMachineExecutionOriginState({
            pluginId: 'acme.plugin',
            storedOrigin: null,
            candidates: [unknown],
        })).toEqual({
            kind: 'unavailable',
            storedOrigin: null,
            candidates: [unknown],
            reasons: ['unknown'],
        });
    });
});
