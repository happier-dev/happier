import { describe, expect, it, vi } from 'vitest';
import { getWorkflowStarterExamplesV1 } from '@happier-dev/protocol/workflows/builtins/examples';
import { HEALTH_CHECK_EVENT_REFS_V1 } from '@happier-dev/protocol/deployments/healthCheckV1';
import { DEPLOYMENT_RECEIPT_EVENT_REFS_V1 } from '@happier-dev/protocol/deployments/deploymentReceiptEventsV1';
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
import { buildSubjectOperationStarter } from './subjectTriggerStarters';

describe('subject operation starters', () => {
    const subject = { kind: 'environment' as const, environmentId: 'env', machineId: 'machine' };
    const context = { subject, deploymentEnvironment: { serverId: 'home', projectSourceId: 'source', environmentId: 'env' }, controllerMachineId: 'machine' };
    it('seeds failure and recovery from the event owners without configuring or admitting work', () => {
        const failed = buildSubjectOperationStarter('deploymentFailed', context);
        const recovered = buildSubjectOperationStarter('healthRecovered', context);
        expect(failed).toMatchObject({ kind: 'guided', draft: { when: { kind: 'pluginEvent', value: null, eventRef: DEPLOYMENT_RECEIPT_EVENT_REFS_V1.failed } },
            eventSeed: { setupInput: { serverId: 'home', environmentId: 'env' } } });
        expect(recovered).toMatchObject({ kind: 'guided', draft: { when: { kind: 'pluginEvent', value: null, eventRef: HEALTH_CHECK_EVENT_REFS_V1.recovered } },
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
