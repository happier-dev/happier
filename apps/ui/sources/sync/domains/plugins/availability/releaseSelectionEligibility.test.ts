import { describe, expect, it } from 'vitest';
import { PluginMachineMaterializationV1Schema } from '@happier-dev/protocol/plugins/availability';
import { createPluginAccountAvailabilityReader } from './reader';
import { readPluginAccountReleaseSelectionEligibility } from './releaseSelectionEligibility';

const coordinate = { pluginId: 'store.fixtures125', version: '1.0.0' };
function materialization(sourceClass: 'localPath' | 'bundledFirstParty' | 'versionedArchive', machineId = 'machine-local') {
    return PluginMachineMaterializationV1Schema.parse({
        ...coordinate, serverIdentityId: 'srv_fixture', machineId, materializationId: machineId,
        sourceClass, portableRelease: sourceClass === 'versionedArchive', uiArtifacts: [],
        enabled: true, trustState: 'trusted', observedAt: 1,
    });
}
function reader(materializations: ReturnType<typeof materialization>[]) {
    return createPluginAccountAvailabilityReader({ scope: { serverId: 'home', accountId: 'owner' }, snapshot: {
        availabilityCursor: 1, intentReads: [], snapshots: [], materializations,
    } });
}
const origin = { serverIdentityId: 'srv_fixture', machineId: 'machine-local' };

describe('Account release selection eligibility', () => {
    it.each(['localPath', 'bundledFirstParty'] as const)('retains Availability’s typed non-portable reason for %s', sourceClass => {
        const installed = materialization(sourceClass);
        const availability = reader([installed]);
        expect(availability.classifyRelease(installed).validation).toEqual({ kind: 'rejected', reason: 'non_portable' });
        expect(readPluginAccountReleaseSelectionEligibility({ ...coordinate, ...origin, reader: availability }))
            .toEqual({ kind: 'ineligible', reason: 'non_portable' });
    });
    it('keeps an exact portable installation eligible independently of selected Account intent', () => {
        expect(readPluginAccountReleaseSelectionEligibility({ ...coordinate, ...origin,
            reader: reader([materialization('versionedArchive')]) })).toEqual({ kind: 'eligible' });
    });
    it('does not let another Machine’s portable copy change the selected local installation', () => {
        const availability = reader([materialization('localPath'), materialization('versionedArchive', 'machine-other')]);
        expect(readPluginAccountReleaseSelectionEligibility({ ...coordinate, ...origin, reader: availability }))
            .toEqual({ kind: 'ineligible', reason: 'non_portable' });
    });
});
