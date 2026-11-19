import { describe, expect, it } from 'vitest';
import { createDeploymentEnvironmentHeaderV1, createDeploymentReceiptHeaderV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { createDeploymentTargetLinkHeaderV1 } from '@happier-dev/deployments/testing/v1';
import { deploymentEnvironmentRunsOnMachine } from './deploymentEnvironmentRowFact';

describe('Environment service disclosure placement', () => {
  it.each(['ownServer', 'vercel', 'neon'] as const)('opens Machine services only for ownServer (%s)', targetKind => {
    const environment = createDeploymentEnvironmentHeaderV1({ controllerMachineId: 'controller' });
    const native = createDeploymentTargetLinkHeaderV1();
    const runtimeTargetLink = createDeploymentTargetLinkHeaderV1(targetKind === 'ownServer' ? {
      machines: ['runtime'], members: native.members.map(member => ({ ...member, machineId: 'runtime' })),
    } : {
      targetKind, role: targetKind === 'neon' ? 'data' : 'runtime', machines: [], members: [],
      source: { kind: 'plugin', contribution: { pluginId: `happier.deploy.${targetKind}`, localId: targetKind } },
    });
    const item = { environment, title: 'App', runtimeTargetLink,
      currentDeployment: createDeploymentReceiptHeaderV1() };
    expect(deploymentEnvironmentRunsOnMachine(item)).toBe(targetKind === 'ownServer' ? 'runtime' : null);
    expect(deploymentEnvironmentRunsOnMachine({ ...item, currentDeployment: null })).toBeNull();
  });
});
