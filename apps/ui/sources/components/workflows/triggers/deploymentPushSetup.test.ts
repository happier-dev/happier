import { describe, expect, it } from 'vitest';
import { WorkflowTriggerAddRequestV1Schema } from '@happier-dev/protocol/workflows/triggers/workflowTriggerActionsV1';
import { buildDeploymentPushFilter, buildDeploymentPushRequest } from './deploymentPushSetup';

const config = {
  environment: { serverId: 'home', environmentId: 'staging', projectSourceId: 'source' },
  targetLinkId: 'runtime', project: { machineId: 'controller', directory: '~' },
};
const trigger = { kind: 'pluginEvent' as const, enabled: true,
  eventRef: { pluginId: 'happier.scm.forge.github', localId: 'automation/repository-pushed-v1' },
  sourceInstanceId: 'repository', sourceContractVersion: 1, sourceConfig: {}, displayLabel: 'Repository',
  observationTransport: { kind: 'checkpointedPull' as const, watcherMaterializationRef: {
    machineId: 'controller', materializationId: 'github', pluginId: 'happier.scm.forge.github' } },
  filter: null, maximumObservationAgeMs: null };

describe('Environment push setup', () => {
  it('clears a saved branch while retaining its path filter and excluding trigger identity', () => {
    expect(buildDeploymentPushFilter('  ', { triggerId: 'retained', branch: 'main', paths: ['apps/web/**'] }))
      .toEqual({ paths: ['apps/web/**'] });
  });
  it('binds the destination while leaving SHA and request identity to the admitted event', () => {
    const request = buildDeploymentPushRequest(config, trigger, undefined, 'main');
    expect(WorkflowTriggerAddRequestV1Schema.safeParse(request).success).toBe(true);
    expect(request).toMatchObject({ project: config.project, deployment: { branch: 'main' },
      executionTarget: { kind: 'detached_run' }, inputs: { serverId: 'home', environmentId: 'staging', targetLinkId: 'runtime' } });
    expect(request.inputs).not.toHaveProperty('sha');
    expect(request.inputs).not.toHaveProperty('requestKey');
    expect(request).not.toHaveProperty('actionApproval'); // owner prepares non-production/Production default
    expect(request.target.definition.blocks).toMatchObject([{ actionId: 'deployments.deploy', input: {
      sha: { kind: 'input', name: 'sha' }, requestKey: { kind: 'input', name: 'requestKey' } } }]);
  });
  it.each(['automatic', 'ask'] as const)('saves explicit %s through the existing trigger Action', choice => {
    const request = buildDeploymentPushRequest(config, trigger, choice);
    expect(request.actionApproval).toBe(choice);
    expect(request).not.toHaveProperty('actionApprovals');
    expect(request.deployment).toEqual({});
  });
});
