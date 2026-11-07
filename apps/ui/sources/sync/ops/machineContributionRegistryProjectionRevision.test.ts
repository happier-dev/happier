import { describe, expect, it } from 'vitest';
import { getMachineContributionRegistryProjectionRevision, publishMachineContributionRegistryProjectionRefresh,
    captureMachineContributionRegistryProjectionScope } from './machineContributionRegistryProjectionRevision';

describe('Machine projection reconnect currentness', () => {
    it('advances directly read scopes without a mounted listener and leaves another Home current', () => {
        const scope = { serverId: 'search-reconnect-home', machineId: 'machine' };
        const other = { serverId: 'search-other-home', machineId: 'machine' };
        const before = getMachineContributionRegistryProjectionRevision(scope);
        const otherBefore = getMachineContributionRegistryProjectionRevision(other);
        publishMachineContributionRegistryProjectionRefresh(scope.serverId);
        expect(getMachineContributionRegistryProjectionRevision(scope)).toBe(before + 1);
        expect(getMachineContributionRegistryProjectionRevision(other)).toBe(otherBefore);
    });

    it('advances a captured passive reader after its listener has unmounted', () => {
        const scope = { serverId: 'passive-reconnect-home', machineId: 'machine' };
        const reader = captureMachineContributionRegistryProjectionScope(scope);
        const before = reader.readRevision();
        const unsubscribe = reader.subscribe(() => {});
        unsubscribe();
        publishMachineContributionRegistryProjectionRefresh(scope.serverId);
        expect(reader.readRevision()).toBe(before + 1);
    });
});
