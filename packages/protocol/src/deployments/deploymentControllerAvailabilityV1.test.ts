import { describe, expect, it } from 'vitest';
import { projectDeploymentControllerAvailabilityV1 } from './deploymentActionsV1.js';

describe('Environment controller availability', () => {
    it('pauses jobs and alerts only when the existing presence owner says offline', () => {
        expect(projectDeploymentControllerAvailabilityV1('controller', {
            active: false, presenceProtocolVersion: 1,
        })).toEqual({ machineId: 'controller', state: 'paused' });
        expect(projectDeploymentControllerAvailabilityV1('controller', {
            active: true, activeAt: 1, presenceProtocolVersion: 1,
        })).toEqual({ machineId: 'controller', state: 'available' });
        expect(projectDeploymentControllerAvailabilityV1('controller', {
            active: true, presenceProtocolVersion: 1, revokedAt: 1,
        })).toEqual({ machineId: 'controller', state: 'paused' });
        expect(projectDeploymentControllerAvailabilityV1('controller', null))
            .toEqual({ machineId: 'controller', state: 'unknown' });
    });
});
