import { describe, expect, it } from 'vitest';

import { EMPTY_PLUGIN_UI_PROJECTION } from './projection';
import { preparePluginUiProjectionOrigins } from './projectionOrigins';
import { createPluginUiExecutionOriginCandidatePublication, createPluginUiProjectionUnionPublication,
    readPluginUiContributionSupplies, readPluginUiExecutionOriginCandidates, unionPluginUiProjections,
    type PluginUiProjectionUnionMember } from './projectionUnion';

// PERF Account shape (P03-UNPROFILED, agent-qa-perf #79): ~61 Machines, each
// supplying the same ~84 plugins. Each Machine's currentness report is one
// publication; a cold load or route open delivers one per Machine.
const PLUGINS = 84;

function fleet(machines: number): PluginUiProjectionUnionMember[] {
    const ids = Array.from({ length: PLUGINS }, (_, index) => `acme.flip-${index}`);
    return Array.from({ length: machines }, (_, index) => {
        const machineId = `machine-${String(index).padStart(3, '0')}`;
        const custody = (pluginId: string) => ({ kind: 'development' as const, registeredRootId: `${machineId}/${pluginId}` });
        const origin = (pluginId: string) => ({ serverIdentityId: 'srv_identity', sourceRef: { machineId, pluginId, sourceCustody: custody(pluginId) } });
        return {
            machineId, serverId: 'home', serverIdentityId: 'srv_identity', phase: 'establishing', interactionEnabled: false,
            projection: preparePluginUiProjectionOrigins({ ...EMPTY_PLUGIN_UI_PROJECTION, generation: 1,
                installedPackagesById: Object.fromEntries(ids.map(pluginId => [pluginId, { id: pluginId, displayName: pluginId,
                    version: '1.0.0', enabled: true, source: { kind: 'localPath' as const, locator: '/flip' },
                    occurrenceId: `${machineId}/${pluginId}`, sourceCustody: custody(pluginId), executionOrigin: origin(pluginId) }])),
                unknownEntriesById: Object.fromEntries(ids.map(pluginId => [`${pluginId}.row`, { pluginId, contributionKind: 'unknown',
                    occurrenceId: `${machineId}/${pluginId}`, executionOrigin: origin(pluginId), payload: { title: pluginId } }])),
            }),
            materializationsByPluginId: Object.fromEntries(ids.map(pluginId => [pluginId, { serverIdentityId: 'srv_identity', machineId,
                materializationId: pluginId, pluginId, version: '1.0.0', sourceClass: 'localPath' as const, portableRelease: false,
                enabled: true, trustState: 'trusted' as const, observedAt: 1, uiArtifacts: [] }])),
        } satisfies PluginUiProjectionUnionMember;
    });
}

/** Native-operation probes forward unchanged behavior; no domain logic is mocked. */
function countWork<T>(run: () => T) {
    const natives = { entries: Object.entries, values: Object.values, keys: Object.keys, freeze: Object.freeze };
    let work = 0;
    const probe = <F extends (...args: never[]) => unknown>(target: F) => new Proxy(target, {
        apply(fn, receiver, args) { work++; return Reflect.apply(fn, receiver, args); },
    });
    Object.entries = probe(natives.entries);
    Object.values = probe(natives.values);
    Object.keys = probe(natives.keys);
    Object.freeze = probe(natives.freeze);
    try { return { value: run(), work }; }
    finally { Object.assign(Object, natives); }
}

/** One Machine's status report against a fleet that already published. */
function measureStatusChange(machines: number) {
    const ids = Array.from({ length: PLUGINS }, (_, index) => `acme.flip-${index}`);
    let members = fleet(machines);
    const union = createPluginUiProjectionUnionPublication();
    const candidates = createPluginUiExecutionOriginCandidatePublication();
    const publish = () => candidates.publish(union.publish(members).pluginUiProjection, members, ids);
    publish();
    // Earlier reports already landed; measure the next one.
    members = members.map((member, index) => index < 2 ? { ...member, phase: 'unavailable' as const,
        unavailableReasonCode: 'plugin_machine_unreachable' } : member);
    publish();
    members = members.map((member, index) => index === 2 ? { ...member, phase: 'unavailable' as const,
        unavailableReasonCode: 'plugin_machine_unreachable' } : member);
    const measured = countWork(publish);
    return { ...measured, members, union, ids };
}

describe('projection union work per Machine status change', () => {
    it('does work for the reporting Machine only, independent of how many other Machines supply the same plugins', () => {
        const small = measureStatusChange(15);
        const large = measureStatusChange(60);
        // The report changes 84 plugins' supplies for one Machine. Every other
        // Machine's derived structures are reused, so 45 more Machines add no work.
        expect(large.work).toBeLessThanOrEqual(Math.ceil(small.work * 1.1));

        // The reconciled result is the canonical union and the canonical candidates.
        const projection = large.union.getSnapshot().pluginUiProjection;
        expect(projection).toEqual(unionPluginUiProjections(large.members).pluginUiProjection);
        const supplies = readPluginUiContributionSupplies(projection?.unknownEntriesById['acme.flip-0.row']);
        expect(supplies).toHaveLength(60);
        expect(supplies[2]).toMatchObject({ machineId: 'machine-002', phase: 'unavailable', unavailableReasonCode: 'plugin_machine_unreachable' });
        expect(supplies[3]).toMatchObject({ machineId: 'machine-003', phase: 'establishing' });
        for (const id of large.ids.slice(0, 3)) {
            expect(large.value.get(id)).toEqual(readPluginUiExecutionOriginCandidates({ projection, pluginId: id, members: large.members }));
        }
    }, 120_000);
});
