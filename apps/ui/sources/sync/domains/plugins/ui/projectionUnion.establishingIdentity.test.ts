import { describe, expect, it } from 'vitest';
import { PluginMachineMaterializationV1Schema } from '@happier-dev/protocol/plugins/availability/v1';

import { EMPTY_PLUGIN_UI_PROJECTION } from './projection';
import {
    createPluginUiExecutionOriginCandidatePublication,
    createPluginUiProjectionUnionPublication,
    type PluginUiProjectionUnionMember,
} from './projectionUnion';

const PLUGIN = 'acme.shared';

function currentMember(machineId: string): PluginUiProjectionUnionMember {
    const sourceCustody = { kind: 'development' as const, registeredRootId: machineId };
    const executionOrigin = { serverIdentityId: 'srv_identity', sourceRef: { machineId, pluginId: PLUGIN, sourceCustody } };
    return { machineId, serverId: 'server', serverIdentityId: 'srv_identity', phase: 'current', interactionEnabled: true,
        projection: { ...EMPTY_PLUGIN_UI_PROJECTION, generation: 1,
            installedPackagesById: { [PLUGIN]: { id: PLUGIN, displayName: machineId, version: '1.0.0', enabled: true,
                source: { kind: 'localPath', locator: `/${machineId}` }, occurrenceId: machineId, sourceCustody, executionOrigin } },
            unknownEntriesById: { row: { pluginId: PLUGIN, contributionKind: 'unknown', occurrenceId: machineId, executionOrigin } } } };
}

/** A Machine that joined the online set but has not answered its first projection read (reconnect re-admission). */
function establishingMember(machineId: string): PluginUiProjectionUnionMember {
    return { machineId, serverId: 'server', serverIdentityId: 'srv_identity', phase: 'establishing', interactionEnabled: false,
        projection: null,
        materializationsByPluginId: { [PLUGIN]: PluginMachineMaterializationV1Schema.parse({
            serverIdentityId: 'srv_identity', machineId, materializationId: `${machineId}-${PLUGIN}`, pluginId: PLUGIN,
            version: '1.0.0', sourceClass: 'localPath', portableRelease: false, enabled: true, trustState: 'trusted',
            observedAt: 1, uiArtifacts: [] }) } };
}

describe('pending establishing targets are a union fact, not a declaration-model change', () => {
    it('keeps cold projection establishment pending until currentness settles, without inventing a source refusal', () => {
        const current = currentMember('machine-a');
        const union = createPluginUiProjectionUnionPublication();
        const candidates = createPluginUiExecutionOriginCandidatePublication();
        const publish = (member: PluginUiProjectionUnionMember) => {
            const snapshot = union.publish([member]);
            return candidates.publish(snapshot.pluginUiProjection, [member], [PLUGIN],
                snapshot.establishingExecutionTargetsByPluginId).get(PLUGIN)!;
        };
        const pending = publish({ ...current, phase: 'establishing', interactionEnabled: false });
        expect(pending.establishingTargets).toEqual([{ serverIdentityId: 'srv_identity', machineId: 'machine-a' }]);
        expect(pending.machineRejections).toEqual([]);
        const settled = publish(current);
        expect(settled.establishingTargets).toEqual([]);
        expect(settled.sourceCandidates[0]?.validation).toEqual({ kind: 'admitted' });
        for (const [unavailableReasonCode, reason] of [
            ['plugin_source_not_ready', 'source_not_ready'],
            ['plugin_daemon_unavailable', 'daemon_unavailable'],
        ] as const) {
            const failed = publish({ ...current, phase: 'unavailable', interactionEnabled: false, unavailableReasonCode });
            expect(failed.establishingTargets).toEqual([]);
            expect(failed.machineRejections).toEqual([{ serverIdentityId: 'srv_identity', machineId: 'machine-a', reason }]);
            expect(failed.sourceCandidates[0]?.validation).toEqual({ kind: 'rejected', reason });
        }
    });

    it('keeps the published model identity while re-admitted Machines leave one at a time, and still reports them as pending', () => {
        // Return after hide (P03-RECONNECT-RETURN): the reconnect re-admits unreachable Machines, then each
        // drops on its own failed request. Each drop used to republish the whole declaration model.
        const current = currentMember('machine-a');
        const pending = Array.from({ length: 6 }, (_, index) => establishingMember(`machine-p${index}`));
        const union = createPluginUiProjectionUnionPublication();
        const candidates = createPluginUiExecutionOriginCandidatePublication();
        const models = new Set<unknown>();
        const pendingCounts: number[] = [];
        for (let remaining = pending.length; remaining >= 0; remaining--) {
            const members = [current, ...pending.slice(0, remaining)];
            const snapshot = union.publish(members);
            models.add(snapshot.pluginUiProjection);
            const facts = candidates.publish(snapshot.pluginUiProjection, members, [PLUGIN],
                snapshot.establishingExecutionTargetsByPluginId).get(PLUGIN);
            pendingCounts.push(facts?.establishingTargets.length ?? -1);
        }
        // One declaration model for 7 publications: the drops changed no declaration.
        expect(models.size).toBe(1);
        // Correctness: Administration still sees every pending Machine until it leaves.
        expect(pendingCounts).toEqual([6, 5, 4, 3, 2, 1, 0]);
        expect(union.getSnapshot().establishingExecutionTargetsByPluginId).toBeUndefined();
    });
});
