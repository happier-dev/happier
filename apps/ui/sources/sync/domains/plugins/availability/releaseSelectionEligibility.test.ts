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
    it.each([null, reader([])])('rejects a known local install before its materialization census arrives', availability => {
        expect(readPluginAccountReleaseSelectionEligibility({ ...coordinate, ...origin,
            installedDistribution: { kind: 'localPath', canonicalPath: '/tmp/own-plugin' }, reader: availability }))
            .toEqual({ kind: 'ineligible', reason: 'non_portable' });
    });
    it('keeps a packaged installation selectable while its census is unavailable', () => {
        expect(readPluginAccountReleaseSelectionEligibility({ ...coordinate, ...origin,
            installedDistribution: { kind: 'archive', source: { kind: 'localFile', canonicalPath: '/tmp/own-plugin.tgz' }, integrity: 'sha256:fixture' },
            reader: null })).toEqual({ kind: 'eligible' });
    });
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
    it('classifies the observed release when Installed is opened on a Machine without that plugin', () => {
        const availability = reader([materialization('localPath')]);
        expect(readPluginAccountReleaseSelectionEligibility({ ...coordinate,
            serverIdentityId: origin.serverIdentityId, machineId: 'machine-without-plugin', reader: availability }))
            .toEqual({ kind: 'ineligible', reason: 'non_portable' });
    });
    it('keeps a portable observed release selectable from a Machine without that plugin', () => {
        expect(readPluginAccountReleaseSelectionEligibility({ ...coordinate,
            serverIdentityId: origin.serverIdentityId, machineId: 'machine-without-plugin',
            reader: reader([materialization('versionedArchive')]) })).toEqual({ kind: 'eligible' });
    });
    it('does not let another Machine’s portable copy change the selected local installation', () => {
        const availability = reader([materialization('localPath'), materialization('versionedArchive', 'machine-other')]);
        expect(readPluginAccountReleaseSelectionEligibility({ ...coordinate, ...origin, reader: availability }))
            .toEqual({ kind: 'ineligible', reason: 'non_portable' });
    });
});
