import { describe, expect, it } from 'vitest';

import { EMPTY_PLUGIN_UI_PROJECTION, type PluginUiProjectionModel } from './projection';
import { createPluginUiExecutionOriginCandidatePublication, createPluginUiProjectionUnionPublication,
    readPluginUiExecutionOriginCandidates, unionPluginUiProjections, type PluginUiProjectionUnionMember } from './projectionUnion';
import { preparePluginUiProjectionOrigins, type PluginUiContributionSupplyV1 } from './projectionOrigins';

function member(machineId = 'machine', pluginCount = 85): PluginUiProjectionUnionMember {
    // The #70 PERF Account's per-Machine indexes contain about 85 plugins.
    const ids = Array.from({ length: pluginCount }, (_, index) => `acme.heap-${index}`);
    const sourceCustody = { kind: 'development' as const, registeredRootId: 'heap-root' };
    const origin = (pluginId: string) => ({ serverIdentityId: 'srv_identity', sourceRef: {
        machineId, pluginId, sourceCustody,
    } });
    return {
        machineId, serverId: 'home', serverIdentityId: 'srv_identity', phase: 'current', interactionEnabled: true,
        projection: {
            ...EMPTY_PLUGIN_UI_PROJECTION, generation: 1,
            installedPackagesById: Object.fromEntries(ids.map(id => [id, {
                id, displayName: id, version: '1.0.0', enabled: true,
                source: { kind: 'localPath' as const, locator: '/heap' }, occurrenceId: id,
                sourceCustody, executionOrigin: origin(id),
            }])),
            unknownEntriesById: Object.fromEntries(ids.map(pluginId => [pluginId, {
                pluginId, contributionKind: 'unknown', occurrenceId: pluginId, executionOrigin: origin(pluginId), value: 1,
            }])),
        },
    };
}

function reachableModels(root: unknown): readonly PluginUiProjectionModel[] {
    const seen = new Set<object>();
    const models: PluginUiProjectionModel[] = [];
    const visit = (value: unknown) => {
        if (!value || typeof value !== 'object' || seen.has(value)) return;
        seen.add(value);
        if ('actionsById' in value && 'installedPackagesById' in value) models.push(value as PluginUiProjectionModel);
        if (value instanceof Map) for (const [key, entry] of value) { visit(key); visit(entry); }
        else if (value instanceof Set) for (const entry of value) visit(entry);
        else for (const key of Reflect.ownKeys(value)) {
            const descriptor = Object.getOwnPropertyDescriptor(value, key);
            if (descriptor && 'value' in descriptor) visit(descriptor.value);
        }
    };
    visit(root);
    return models;
}

function originFleet() {
    return Array.from({ length: 60 }, (_, index) => {
        const input = member(`machine-${index}`, index === 59 ? 17 : 85);
        return { ...input, phase: 'establishing' as const, interactionEnabled: false,
            projection: preparePluginUiProjectionOrigins(input.projection!),
            materializationsByPluginId: Object.fromEntries(Object.keys(input.projection!.installedPackagesById).map(pluginId => [pluginId, {
                serverIdentityId: 'srv_identity', machineId: input.machineId, materializationId: pluginId, pluginId,
                version: '1.0.0', sourceClass: 'localPath' as const, portableRelease: false,
                enabled: true, trustState: 'trusted' as const, observedAt: 1, uiArtifacts: [],
            }])),
        };
    });
}

function measureOriginWork<T>(run: () => T) {
    const nativeSome = Array.prototype.some, nativeFreeze = Object.freeze;
    const counts = { duplicateComparisons: 0, candidateConstructions: 0, establishingTargetCopies: 0 };
    Array.prototype.some = function (predicate, receiver) {
        return nativeSome.call(this, (value: unknown, index: number, array: unknown[]) => {
            if (value && typeof value === 'object' && ('serverIdentityId' in value || 'source' in value)) counts.duplicateComparisons++;
            return predicate.call(receiver, value, index, array);
        });
    };
    Object.freeze = new Proxy(nativeFreeze, { apply(target, receiver, args) {
        const value: unknown = args[0];
        if (value && typeof value === 'object' && 'source' in value && 'releaseContent' in value) counts.candidateConstructions++;
        if (Array.isArray(value) && value.length > 0 && value.every(item => item && typeof item === 'object'
            && Object.hasOwn(item, 'serverIdentityId') && Object.hasOwn(item, 'machineId') && Object.keys(item).length === 2)) {
            counts.establishingTargetCopies += value.length;
        }
        return Reflect.apply(target, receiver, args);
    } });
    try { return { value: run(), counts }; }
    finally { Array.prototype.some = nativeSome; Object.freeze = nativeFreeze; }
}

describe('projection union retained memory', () => {
    it('keeps distinct custody and materializations on one Machine, preserving first-supply order and rejection', () => {
        const pluginId = 'acme.same-machine';
        const sourceCustody = { kind: 'development' as const, registeredRootId: 'root-a' };
        const first: PluginUiContributionSupplyV1 = { machineId: 'machine', serverId: 'home', serverIdentityId: 'srv_identity',
            phase: 'establishing', interactionEnabled: false, unavailableReasonCode: 'plugin_source_not_ready',
            executionOrigin: { serverIdentityId: 'srv_identity', sourceRef: { machineId: 'machine', pluginId, sourceCustody } },
            occurrenceId: 'first', pluginVersion: '1.0.0', sourceCustody, executionTargetDefault: true };
        const otherCustody: PluginUiContributionSupplyV1 = { ...first, occurrenceId: 'second',
            unavailableReasonCode: 'plugin_activation_failed', executionOrigin: { serverIdentityId: 'srv_identity', sourceRef: {
                machineId: 'machine', pluginId, sourceCustody: { kind: 'development', registeredRootId: 'root-b' },
            } } };
        const materialization: PluginUiContributionSupplyV1 = { ...first, occurrenceId: 'third', executionOrigin: {
            serverIdentityId: 'srv_identity', materializationRef: { machineId: 'machine', pluginId, materializationId: 'installed' },
        } };
        const otherHome: PluginUiContributionSupplyV1 = { ...first, serverIdentityId: 'srv_other', occurrenceId: 'fourth',
            executionOrigin: { serverIdentityId: 'srv_other', sourceRef: { machineId: 'machine', pluginId, sourceCustody } } };
        const facts = readPluginUiExecutionOriginCandidates({ projection: null, pluginId, entry: { pluginId,
            hostSupplies: [first, otherCustody, { ...first, occurrenceId: 'duplicate' }, materialization, otherHome] } });
        expect(facts.sourceCandidates.map(candidate => candidate.source.occurrenceId)).toEqual(['first', 'second', 'third', 'fourth']);
        expect(facts.declaredDefaultOrigins).toEqual([first, otherCustody, materialization, otherHome].map(supply => supply.executionOrigin));
        expect(facts.establishingTargets).toEqual([{ serverIdentityId: 'srv_identity', machineId: 'machine' },
            { serverIdentityId: 'srv_other', machineId: 'machine' }]);
        expect(facts.machineRejections).toEqual([{ serverIdentityId: 'srv_identity', machineId: 'machine', reason: 'source_not_ready' },
            { serverIdentityId: 'srv_other', machineId: 'machine', reason: 'source_not_ready' }]);
        expect(facts.sourceCandidates[1]?.validation).toEqual({ kind: 'rejected', reason: 'activation_refused' });
    });

    it('derives candidates only for the changed plugin and never for identical republication', () => {
        const fleet = originFleet();
        const union = createPluginUiProjectionUnionPublication();
        const candidates = createPluginUiExecutionOriginCandidatePublication();
        const ids = Object.keys(fleet[0]!.projection.installedPackagesById);
        const first = candidates.publish(union.publish(fleet).pluginUiProjection, fleet, ids);
        const changed = { ...fleet[0]!, projection: { ...fleet[0]!.projection, installedPackagesById: {
            ...fleet[0]!.projection.installedPackagesById,
            'acme.heap-0': { ...fleet[0]!.projection.installedPackagesById['acme.heap-0']!, version: '2.0.0' },
        }, unknownEntriesById: {
            ...fleet[0]!.projection.unknownEntriesById,
            'acme.heap-0': { ...fleet[0]!.projection.unknownEntriesById['acme.heap-0'], value: 2 },
        } } };
        const members = [changed, ...fleet.slice(1)];
        const projection = union.publish(members).pluginUiProjection;
        const update = measureOriginWork(() => candidates.publish(projection, members, ids));
        expect(projection?.unknownEntriesById['acme.heap-0']).toMatchObject({ value: 2 });
        expect(update.value.get('acme.heap-0')?.sourceCandidates[0]?.source.version).toBe('2.0.0');
        expect(update.counts.candidateConstructions).toBe(60);
        expect(update.value.get('acme.heap-1')).toBe(first.get('acme.heap-1'));
        for (const id of ids) expect(update.value.get(id)).toEqual(readPluginUiExecutionOriginCandidates({ projection, pluginId: id, members }));
        const identical = measureOriginWork(() => candidates.publish(projection, [...members], [...ids]));
        expect(identical.value).toBe(update.value);
        expect(identical.counts.candidateConstructions).toBe(0);
        expect(identical.counts.duplicateComparisons).toBe(0);
    });

    it('deduplicates 5,032 establishing origin supplies with linear comparison and target-copy work', () => {
        const fleet = originFleet();
        const owner = createPluginUiProjectionUnionPublication();
        const publication = measureOriginWork(() => owner.publish(fleet));
        const projection = publication.value.pluginUiProjection;
        const ids = Object.keys(fleet[0]!.projection.installedPackagesById);
        const candidateOwner = createPluginUiExecutionOriginCandidatePublication();
        const candidates = measureOriginWork(() => candidateOwner.publish(projection, fleet, ids));
        expect(candidates.value.size).toBe(85);
        expect(candidates.value.get('acme.heap-0')?.sourceCandidates).toHaveLength(60);
        expect(candidates.value.get('acme.heap-0')?.machineRejections).toHaveLength(60);
        // Two distinct supply paths (declaration and package) per source. Work
        // must follow supplies, rather than each supply × earlier Machines.
        expect.soft(candidates.counts.duplicateComparisons).toBeLessThanOrEqual(2 * 5032);
        expect(publication.counts.establishingTargetCopies).toBe(5032);
        expect(publication.value).toEqual(unionPluginUiProjections(fleet));
    });

    it.skipIf(!process.env.ORIGIN_CPU_MEASURE)('measures origin candidates and publication facts on 5,032 source slices', () => {
        const fleet = originFleet();
        const ids = Object.keys(fleet[0]!.projection.installedPackagesById);
        const timing = () => {
            const union = createPluginUiProjectionUnionPublication();
            const candidates = createPluginUiExecutionOriginCandidatePublication();
            const start = performance.now();
            const first = union.publish(fleet);
            const factsEnd = performance.now();
            candidates.publish(first.pluginUiProjection, fleet, ids);
            const candidatesEnd = performance.now();
            const changed = [{ ...fleet[0]!, interactionEnabled: true, phase: 'current' as const }, ...fleet.slice(1)];
            const next = union.publish(changed);
            const updateFactsEnd = performance.now();
            candidates.publish(next.pluginUiProjection, changed, ids);
            const updateCandidatesEnd = performance.now();
            candidates.publish(next.pluginUiProjection, [...changed], [...ids]);
            return { coldUnionMs: factsEnd - start, coldCandidatesMs: candidatesEnd - factsEnd,
                updateUnionMs: updateFactsEnd - candidatesEnd, updateCandidatesMs: updateCandidatesEnd - updateFactsEnd,
                identicalCandidatesMs: performance.now() - updateCandidatesEnd };
        };
        timing();
        const timings = Array.from({ length: 7 }, timing);
        const publication = measureOriginWork(() => createPluginUiProjectionUnionPublication().publish(fleet));
        const candidates = measureOriginWork(() => createPluginUiExecutionOriginCandidatePublication().publish(publication.value.pluginUiProjection, fleet, ids));
        console.log('ORIGIN_CPU_MEASURE', JSON.stringify({ label: process.env.ORIGIN_CPU_MEASURE, sources: 60, plugins: 85, slices: 5032,
            unionWork: publication.counts, candidateWork: candidates.counts, timings }));
    }, 60_000);

    it('does not enumerate unchanged plugin slices when one of 85 plugins changes', () => {
        const base = member();
        const input: PluginUiProjectionUnionMember = { ...base, projection: { ...base.projection!, unknownEntriesById: {
            ...base.projection!.unknownEntriesById,
            'acme.heap-0/retained': { ...base.projection!.unknownEntriesById['acme.heap-0'], value: 'retained' },
        } } };
        const owner = createPluginUiProjectionUnionPublication();
        const first = owner.publish([input]);
        const changed = { ...input, projection: { ...input.projection!, unknownEntriesById: {
            ...input.projection!.unknownEntriesById,
            'acme.heap-0': { ...input.projection!.unknownEntriesById['acme.heap-0'], value: 2 },
        } } };
        const nativeKeys = Object.keys;
        let unrelatedSliceEnumerations = 0;
        // Observe the actual dictionary enumeration boundary, preserving all
        // internal projection, structural sharing and publication behavior.
        Object.keys = value => {
            const keys = nativeKeys(value);
            if (keys.length === 1 && keys[0]!.startsWith('acme.heap-') && keys[0] !== 'acme.heap-0') {
                unrelatedSliceEnumerations++;
            }
            return keys;
        };
        let next;
        try { next = owner.publish([changed]); }
        finally { Object.keys = nativeKeys; }
        expect(next.pluginUiProjection?.unknownEntriesById['acme.heap-0']).toMatchObject({ value: 2 });
        expect(next.pluginUiProjection?.unknownEntriesById['acme.heap-1']).toBe(first.pluginUiProjection?.unknownEntriesById['acme.heap-1']);
        expect(next.pluginUiProjection?.unknownEntriesById['acme.heap-0/retained']).toBe(first.pluginUiProjection?.unknownEntriesById['acme.heap-0/retained']);
        expect(unrelatedSliceEnumerations).toBe(0);
        expect(owner.publish([{ ...changed }])).toBe(next);
        const withdrawn = owner.publish([{ ...changed, projection: { ...changed.projection,
            unknownEntriesById: Object.fromEntries(Object.entries(changed.projection.unknownEntriesById).filter(([id]) => id !== 'acme.heap-0')),
        } }]);
        expect(withdrawn.pluginUiProjection?.unknownEntriesById['acme.heap-0']).toBeUndefined();
        expect(withdrawn.pluginUiProjection?.unknownEntriesById['acme.heap-1']).toBe(next.pluginUiProjection?.unknownEntriesById['acme.heap-1']);
    });

    it.skipIf(!process.env.PROJECTION_CPU_MEASURE)('measures the 60-source / 5,032-slice cold union and a one-plugin update', () => {
        const fleet = Array.from({ length: 60 }, (_, index) => member(`machine-${index}`, index === 59 ? 17 : 85));
        const owner = createPluginUiProjectionUnionPublication();
        const changed = { ...fleet[0]!, projection: { ...fleet[0]!.projection!, unknownEntriesById: {
            ...fleet[0]!.projection!.unknownEntriesById,
            'acme.heap-0': { ...fleet[0]!.projection!.unknownEntriesById['acme.heap-0'], value: 2 },
        } } };
        const measure = (publish: () => unknown) => {
            const nativeKeys = Object.keys, nativeEntries = Object.entries, nativeFreeze = Object.freeze, nativeDefine = Object.defineProperty;
            const NativeMap = globalThis.Map, NativeSet = globalThis.Set;
            const counts = { keys: 0, entries: 0, freezes: 0, definedProperties: 0, maps: 0, sets: 0 };
            Object.keys = value => { counts.keys++; return nativeKeys(value); };
            Object.entries = new Proxy(nativeEntries, { apply(target, receiver, args) { counts.entries++; return Reflect.apply(target, receiver, args); } });
            Object.freeze = new Proxy(nativeFreeze, { apply(target, receiver, args) { counts.freezes++; return Reflect.apply(target, receiver, args); } });
            Object.defineProperty = (value, key, descriptor) => { counts.definedProperties++; return nativeDefine(value, key, descriptor); };
            globalThis.Map = new Proxy(NativeMap, { construct(target, args, newTarget) { counts.maps++; return Reflect.construct(target, args, newTarget); } });
            globalThis.Set = new Proxy(NativeSet, { construct(target, args, newTarget) { counts.sets++; return Reflect.construct(target, args, newTarget); } });
            const start = performance.now();
            try { publish(); }
            finally {
                Object.keys = nativeKeys; Object.entries = nativeEntries; Object.freeze = nativeFreeze; Object.defineProperty = nativeDefine;
                globalThis.Map = NativeMap; globalThis.Set = NativeSet;
            }
            return { ms: performance.now() - start, ...counts };
        };
        const cold = measure(() => owner.publish(fleet));
        const update = measure(() => owner.publish([changed, ...fleet.slice(1)]));
        const identical = measure(() => owner.publish([changed, ...fleet.slice(1)]));
        const timings = Array.from({ length: 5 }, () => {
            const publication = createPluginUiProjectionUnionPublication();
            const start = performance.now();
            publication.publish(fleet);
            const coldEnd = performance.now();
            publication.publish([changed, ...fleet.slice(1)]);
            return { coldMs: coldEnd - start, updateMs: performance.now() - coldEnd };
        });
        console.log('PROJECTION_CPU_MEASURE', JSON.stringify({ label: process.env.PROJECTION_CPU_MEASURE,
            sources: 60, plugins: 85, slices: 5032, cold, update, identical, timings }));
        expect(Object.keys(owner.getSnapshot().pluginUiProjection!.unknownEntriesById)).toHaveLength(85);
    }, 60_000);

    it('shares absent contribution dictionaries throughout its retained publication graph', () => {
        const input = member();
        const owner = createPluginUiProjectionUnionPublication();
        const first = owner.publish([input]);
        const families = Object.keys(EMPTY_PLUGIN_UI_PROJECTION).filter(key => key.endsWith('ById') || key.endsWith('ByPluginId'));
        const dictionary = (model: PluginUiProjectionModel, key: string): unknown => Reflect.get(model, key);
        const roots = [EMPTY_PLUGIN_UI_PROJECTION, input.projection!, first.pluginUiProjection!];
        const duplicates = reachableModels(first).flatMap(model => families.filter(key => {
            const value = dictionary(model, key);
            return value && typeof value === 'object' && Object.keys(value).length === 0
                && !roots.some(root => dictionary(root, key) === value);
        }));
        expect(duplicates).toHaveLength(0);

        const changed = { ...input, projection: { ...input.projection!, unknownEntriesById: {
            ...input.projection!.unknownEntriesById,
            'acme.heap-0': { ...input.projection!.unknownEntriesById['acme.heap-0'], value: 2 },
        } } };
        const next = owner.publish([changed]);
        expect(next.pluginUiProjection?.unknownEntriesById['acme.heap-0']).toMatchObject({ value: 2 });
        expect(next.pluginUiProjection?.unknownEntriesById['acme.heap-1']).toBe(first.pluginUiProjection?.unknownEntriesById['acme.heap-1']);
        expect(owner.publish([changed])).toBe(next);
        expect(Object.keys(owner.publish([]).pluginUiProjection?.unknownEntriesById ?? {})).toHaveLength(0);
    });

    it('allocates empty sets by supplied plugins rather than by every absent contribution family', () => {
        const input = member();
        const owner = createPluginUiProjectionUnionPublication();
        const NativeSet = globalThis.Set;
        let emptySets = 0;
        // Allocation instrumentation forwards every construction to the real Set.
        // No domain logic or Set behavior is replaced.
        globalThis.Set = new Proxy(NativeSet, { construct(target, args, newTarget) {
            const value = Reflect.construct(target, args, newTarget) as Set<unknown>;
            if (value.size === 0) emptySets++;
            return value;
        } });
        let result;
        try { result = owner.publish([input]); }
        finally { globalThis.Set = NativeSet; }
        expect(Object.keys(result.pluginUiProjection?.unknownEntriesById ?? {})).toHaveLength(85);
        const pluginCount = Object.keys(input.projection!.installedPackagesById).length;
        const absentFamilies = Object.keys(EMPTY_PLUGIN_UI_PROJECTION).filter(key =>
            (key.endsWith('ById') || key.endsWith('ByPluginId'))
            && Object.keys(Reflect.get(input.projection!, key)).length === 0);
        // Control sets still scale with real plugins. Absent contribution families
        // must not introduce their own plugin × family allocation multiplier.
        expect(emptySets).toBeLessThan(pluginCount * absentFamilies.length);
    });
});
