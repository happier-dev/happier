import { describe, expect, it } from 'vitest';
import { createDeploymentTargetLinkHeaderV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { admitOwnServerDeploymentTargetLink } from './ownServerTargetAdmission';

describe('own-server catalog admission', () => {
    it('admits only the fixed host target and preserves target-member placement', () => {
        const link = createDeploymentTargetLinkHeaderV1();
        expect(() => admitOwnServerDeploymentTargetLink(link, 'machine-a')).not.toThrow();
        for (const invalid of [
            { ...link, source: { kind: 'host' as const, id: 'other-host' } },
            { ...link, targetKind: 'other-kind' },
            createDeploymentTargetLinkHeaderV1({
                source: { kind: 'plugin', contribution: { pluginId: 'example.deploy', localId: 'own-server' } },
                targetKind: 'ownServer', machines: [], members: [],
            }),
        ]) {
            expect(() => admitOwnServerDeploymentTargetLink(invalid, 'machine-a', 'machine-a'))
                .toThrow(expect.objectContaining({ code: 'target_mismatch' }));
        }
        expect(() => admitOwnServerDeploymentTargetLink(link, 'foreign-machine'))
            .toThrow(expect.objectContaining({ code: 'target_mismatch' }));
    });

    it('requires the admitted coordinator for multi-member execution', () => {
        const link = createDeploymentTargetLinkHeaderV1({ machines: ['machine-a', 'machine-b'], members: [
            { machineId: 'machine-a', installationId: 'installation-a', state: 'active' },
            { machineId: 'machine-b', installationId: 'installation-b', state: 'active' },
        ] });
        expect(() => admitOwnServerDeploymentTargetLink(link, 'machine-a'))
            .toThrow(expect.objectContaining({ code: 'unsupported' }));
        expect(() => admitOwnServerDeploymentTargetLink(link, 'controller', 'controller')).not.toThrow();
        expect(() => admitOwnServerDeploymentTargetLink(link, 'controller', 'other-controller'))
            .toThrow(expect.objectContaining({ code: 'target_mismatch' }));
    });
});
