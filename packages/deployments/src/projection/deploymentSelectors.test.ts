import { expect, it } from 'vitest';
import { createDeploymentEnvironmentDetailV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { deploymentDataTargetOperands, selectDeploymentRuntimeTargetLinkV1 } from './deploymentSelectors.js';

it.each([1, 2])('selects data custody only when the runtime has one source Machine (%i members)', count => {
    const detail = createDeploymentEnvironmentDetailV1();
    const runtime = detail.targetLinks[0]!.targetLink;
    runtime.machines = Array.from({ length: count }, (_, index) => `source-${index}`);
    runtime.members = runtime.machines.map(machineId => ({ machineId, installationId: `installed-${machineId}`, state: 'active' }));
    detail.environment.controllerMachineId = 'controller';
    detail.environment.runtimeTargetLinkId = runtime.id;
    const selected = deploymentDataTargetOperands({ environment: detail.environment,
        runtimeTargetLink: selectDeploymentRuntimeTargetLinkV1(detail) });
    expect(selected).toEqual(count === 1 ? { environmentId: detail.environment.id, expectedRevision: detail.environment.revision,
        targetLinkId: runtime.id, machineId: 'source-0', installationId: 'installed-source-0' } : null);
});
