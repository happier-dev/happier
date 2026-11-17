import { describe, expect, it, vi } from 'vitest';
import { getWorkflowStarterExamplesV1 } from '@happier-dev/protocol/workflows/builtins/examples';
import { HEALTH_CHECK_EVENT_REFS_V1 } from '@happier-dev/protocol/deployments/healthCheckV1';
import { DEPLOYMENT_RECEIPT_EVENT_REFS_V1 } from '@happier-dev/protocol/deployments/deploymentReceiptEventsV1';
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
import { buildSubjectOperationStarter, subjectStarterEventSeed, subjectStarterWhen } from './subjectTriggerStarters';

describe('subject operation starters', () => {
    const subject = { kind: 'environment' as const, environmentId: 'env', machineId: 'machine' };
    const context = { subject, deploymentEnvironment: { serverId: 'home', projectSourceId: 'source', environmentId: 'env' }, controllerMachineId: 'machine' };
  it('reopens one canonical saved health source from every subject entry and carries Domain configure intent', () => {
    const domain = { domainId: 'public-domain', targetLinkId: 'serving-target' };
    const intent = { subject: { kind: 'environment' as const, environmentId: 'production', machineId: 'controller' },
      controllerMachineId: 'controller', domain };
    const environment = subjectStarterEventSeed('healthFailed', intent);
    const service = subjectStarterEventSeed('healthFailed', { subject: {
      kind: 'service', serviceId: 'systemd:api', machineId: 'watched' } });
    expect(environment).toMatchObject({ sourceInstanceId: expect.stringMatching(/^health:/),
      monitoringMachineId: 'controller', setupInput: { subject: { kind: 'environment', environmentId: 'production' }, domain } });
    expect(service).toMatchObject({ sourceInstanceId: expect.stringMatching(/^health:/),
      setupInput: { subject: { kind: 'machineService', machineId: 'watched', serviceId: 'systemd:api' } } });
    expect(environment?.sourceInstanceId).not.toBe(service?.sourceInstanceId);
  });
    it('retains the nightly schedule as ordinary editor intent', () => {
        expect(subjectStarterWhen('nightly')).toMatchObject({ kind: 'schedule', schedule: { repeat: 'daily', hour: 3, minute: 0 } });
        expect(subjectStarterWhen('healthFailed')).toEqual({ kind: 'pluginEvent', value: null, eventRef: HEALTH_CHECK_EVENT_REFS_V1.failed });
    });
    it('seeds failure and recovery from the event owners without configuring or admitting work', () => {
        const failed = buildSubjectOperationStarter('deploymentFailed', context);
        const recovered = buildSubjectOperationStarter('healthRecovered', context);
        expect(failed).toMatchObject({ kind: 'sentence', when: { kind: 'pluginEvent', value: null, eventRef: DEPLOYMENT_RECEIPT_EVENT_REFS_V1.failed },
            eventSeed: { setupInput: { serverId: 'home', environmentId: 'env' } } });
        expect(recovered).toMatchObject({ kind: 'sentence', when: { kind: 'pluginEvent', value: null, eventRef: HEALTH_CHECK_EVENT_REFS_V1.recovered },
            eventSeed: { setupInput: { subject: { kind: 'environment', environmentId: 'env' } } } });
        expect(buildSubjectOperationStarter('healthRecovered', { subject: { kind: 'service', machineId: 'machine', serviceId: 'api' } }))
            .toMatchObject({ eventSeed: { setupInput: { subject: { kind: 'machineService', machineId: 'machine', serviceId: 'api' } } } });
    });
    it('reuses the existing restore drill definition and disabled schedule without selecting a destination', () => {
        const starter = buildSubjectOperationStarter('restoreDrill', context);
        expect(starter).toMatchObject({ kind: 'workflow', example: { key: 'restore-drill', triggerSeed: { kind: 'schedule', enabled: false } } });
        if (starter.kind !== 'workflow') throw Error('Expected Workflow starter');
        expect(starter.example).toBe(getWorkflowStarterExamplesV1().find(example => example.key === 'restore-drill'));
    });
});
