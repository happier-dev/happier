import { describe, expect, it } from 'vitest';
import { DeploymentReadAdmissionV1Schema, projectDeploymentReadAdmissionV1 } from './deploymentReadAdmissionV1';

describe('deployment current-health read admission', () => {
    it('binds the read-only current edge to one Environment, link and controller without a receipt', () => {
        const input = { serverId: 'server', environmentId: 'environment', targetLinkId: 'link', machineId: 'controller' };
        const admission = projectDeploymentReadAdmissionV1('deployments.health.current', input);
        expect(DeploymentReadAdmissionV1Schema.parse(admission)).toEqual({ actionId: 'deployments.health.current',
            environmentId: 'environment', targetLinkId: 'link', machineId: 'controller' });
        expect(DeploymentReadAdmissionV1Schema.safeParse({ ...admission, deploymentId: 'fabricated' }).success).toBe(false);
    });
});
