import { describe, expect, it } from 'vitest';

import { EMPTY_PLUGIN_UI_PROJECTION } from './projection';
import { createPluginUiExecutionOriginCandidatePublication, createPluginUiProjectionUnionPublication,
    readPluginUiExecutionOriginCandidates, type PluginUiProjectionUnionMember } from './projectionUnion';

// VALIDATE74/count-1-census.json: 61 Machines, 60 materialized snapshots,
// 84 plugins, 5,032 materializations. Distribution within that census is constructed.
function loadedFleet(): PluginUiProjectionUnionMember[] {
    return Array.from({ length: 61 }, (_, machine) => {
        const machineId = `machine-${machine}`;
        const ids = Array.from({ length: machine === 60 ? 0 : machine === 59 ? 76 : 84 }, (_, i) => `acme.loaded-${i}`);
        return { machineId, serverId: 'home', serverIdentityId: 'srv_identity', phase: 'establishing', interactionEnabled: false,
            projection: { ...EMPTY_PLUGIN_UI_PROJECTION, generation: null,
                installedPackagesById: Object.fromEntries(ids.map(id => [id, { id, displayName: id, version: '1.0.0', enabled: true,
                    source: { kind: 'localPath' as const, locator: '/loaded' } }])) },
            materializationsByPluginId: Object.fromEntries(ids.map(pluginId => [pluginId, {
                serverIdentityId: 'srv_identity', machineId, materializationId: pluginId, pluginId, version: '1.0.0',
                sourceClass: 'localPath' as const, portableRelease: false, enabled: true, trustState: 'trusted' as const,
                observedAt: 1, uiArtifacts: [],
            }])) };
    });
}

function countCandidateWork<T>(run: () => T) {
    const stringify = JSON.stringify, freeze = Object.freeze, mapGet = Map.prototype.get, setHas = Set.prototype.has;
    const counts = { targetKeyBuilds: 0, facts: 0, targets: 0, origins: 0, lookups: 0 };
    // Native-operation probes forward unchanged behavior; no domain logic is mocked.
    Map.prototype.get = new Proxy(mapGet, { apply(target, receiver, args) {
        counts.lookups++;
        return Reflect.apply(target, receiver, args);
    } });
    Set.prototype.has = new Proxy(setHas, { apply(target, receiver, args) {
        counts.lookups++;
        return Reflect.apply(target, receiver, args);
    } });
    JSON.stringify = new Proxy(stringify, { apply(target, receiver, args) {
        const value: unknown = args[0];
        if (Array.isArray(value) && value.length === 2 && value.every(v => typeof v === 'string')) counts.targetKeyBuilds++;
        return Reflect.apply(target, receiver, args);
    } });
    Object.freeze = new Proxy(freeze, { apply(target, receiver, args) {
        const value: unknown = args[0];
        if (value && typeof value === 'object' && 'establishingTargets' in value) counts.facts++;
        if (value && typeof value === 'object' && 'releaseContent' in value) counts.origins++;
        if (Array.isArray(value) && value.length && value.every(v => v && typeof v === 'object'
            && 'serverIdentityId' in v && 'machineId' in v)) counts.targets += value.length;
        return Reflect.apply(target, receiver, args);
    } });
    try { return { value: run(), counts }; }
    finally { JSON.stringify = stringify; Object.freeze = freeze; Map.prototype.get = mapGet; Set.prototype.has = setHas; }
}

function publicationSequence(measure: boolean) {
    const fleet = loadedFleet(), ids = Object.keys(fleet[0]!.projection!.installedPackagesById);
    const union = createPluginUiProjectionUnionPublication(), candidates = createPluginUiExecutionOriginCandidatePublication();
    let members: PluginUiProjectionUnionMember[] = fleet.map(member => ({ ...member, materializationsByPluginId: {} }));
    const steps: { unionMs: number; candidatesMs: number; keys: number }[] = [];
    const publish = () => {
        const start = performance.now(), projection = union.publish(members).pluginUiProjection, middle = performance.now();
        const observed = measure ? countCandidateWork(() => candidates.publish(projection, members, ids)) : null;
        if (!observed) candidates.publish(projection, members, ids);
        steps.push({ unionMs: middle - start, candidatesMs: performance.now() - middle, keys: observed?.counts.targetKeyBuilds ?? 0 });
    };
    publish();
    // Sixty genuine Machine arrivals followed by unchanged wrapper publications.
    // 153 is the observed invocation count, not a claim to replay its exact ordering.
    for (let i = 0; i < 60; i++) { members = members.map((m, j) => i === j ? fleet[j]! : m); publish(); }
    const before = candidates.getSnapshot();
    for (let i = 61; i < 153; i++) { members = members.map(m => ({ ...m })); publish(); }
    return { fleet, ids, union, candidates, before, steps };
}

describe('loaded origin candidate work', () => {
    it('deduplicates executable origins across the same loaded Machine/plugin census without building target keys', () => {
        const fleet = loadedFleet();
        const ids = Object.keys(fleet[0]!.projection!.installedPackagesById);
        const measured = countCandidateWork(() => ids.map(pluginId => {
            const supplies = fleet.filter(m => m.materializationsByPluginId?.[pluginId]).map(member => ({
                machineId: member.machineId, serverId: member.serverId, serverIdentityId: member.serverIdentityId,
                phase: 'current', interactionEnabled: true, occurrenceId: pluginId, pluginVersion: '1.0.0',
                sourceCustody: { kind: 'development', registeredRootId: 'loaded-root' }, executionTargetDefault: true,
                executionOrigin: { serverIdentityId: member.serverIdentityId, sourceRef: {
                    machineId: member.machineId, pluginId, sourceCustody: { kind: 'development', registeredRootId: 'loaded-root' },
                } },
            }));
            // A second declaration supplies the same origins in the same order.
            const facts = readPluginUiExecutionOriginCandidates({ projection: null, pluginId,
                entry: { pluginId, hostSupplies: [...supplies, ...supplies] } });
            expect(facts.sourceCandidates.map(c => c.source.origin)).toEqual(supplies.map(s => s.executionOrigin));
            expect(facts.declaredDefaultOrigins).toEqual(supplies.map(s => s.executionOrigin));
            expect(facts.machineRejections).toEqual([]);
            return facts;
        }));
        expect(measured.counts.targetKeyBuilds).toBe(0);
        expect(measured.counts.origins).toBe(5032);
    });

    it('does not serialize target tuples across 153 loaded-shape publications and does no work for unchanged inputs', () => {
        const result = publicationSequence(true);
        expect(result.steps).toHaveLength(153);
        expect(result.fleet.reduce((n, m) => n + Object.keys(m.materializationsByPluginId ?? {}).length, 0)).toBe(5032);
        expect.soft(result.steps.map(s => s.keys)).toEqual(Array(153).fill(0));
        expect(result.candidates.getSnapshot()).toBe(result.before);
        const projection = result.union.getSnapshot().pluginUiProjection;
        for (const id of result.ids) {
            const facts = result.candidates.getSnapshot().get(id);
            expect(facts).toEqual(readPluginUiExecutionOriginCandidates({ projection, pluginId: id, members: result.fleet }));
        }
        expect(result.before.get(result.ids[0]!)?.establishingTargets).toHaveLength(60);
        expect(result.before.get(result.ids[0]!)?.machineRejections).toHaveLength(60);
        const identical = countCandidateWork(() => result.candidates.publish(projection, result.fleet.map(m => ({ ...m })), [...result.ids]));
        expect(identical.counts).toEqual({ targetKeyBuilds: 0, facts: 0, targets: 0, origins: 0, lookups: 0 });
        expect(identical.value).toBe(result.before);
        const changed = [{ ...result.fleet[0]!, phase: 'current' as const, interactionEnabled: true }, ...result.fleet.slice(1)];
        const nextProjection = result.union.publish(changed).pluginUiProjection;
        const next = result.candidates.publish(nextProjection, changed, result.ids);
        expect(next.get(result.ids[0]!)?.establishingTargets).toHaveLength(59);
        expect(next.get(result.ids[0]!)?.machineRejections).toHaveLength(59);
        expect(next.get(result.ids[0]!)?.sourceCandidates).toBe(result.before.get(result.ids[0]!)?.sourceCandidates);
    }, 60_000);

    it.skipIf(!process.env.ORIGIN_CPU_2_MEASURE)('measures the loaded census across 153 sequential publications', () => {
        publicationSequence(false);
        const runs = Array.from({ length: 7 }, () => {
            const { steps } = publicationSequence(false);
            return { unionMs: steps.reduce((n, s) => n + s.unionMs, 0), candidatesMs: steps.reduce((n, s) => n + s.candidatesMs, 0),
                identicalCandidatesMs: steps.slice(61).reduce((n, s) => n + s.candidatesMs, 0) };
        });
        const { steps } = publicationSequence(true);
        console.log('ORIGIN_CPU_2_MEASURE', JSON.stringify({ label: process.env.ORIGIN_CPU_2_MEASURE,
            machines: 61, plugins: 84, materializations: 5032, publications: 153, runs, keysPerPublication: steps.map(s => s.keys) }));
    }, 60_000);
});
