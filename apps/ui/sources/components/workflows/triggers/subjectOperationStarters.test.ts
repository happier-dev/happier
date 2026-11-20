import { describe, expect, it, vi } from 'vitest';
import { HEALTH_CHECK_EVENT_REFS_V1 } from '@happier-dev/protocol/deployments/healthCheckV1';
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
import { subjectStarterEventSeed, subjectStarterWhen } from './subjectTriggerStarters';

describe('subject operation starters', () => {
  it('opens the native Check source for the subject and carries Domain configure intent', () => {
    const domain = { domainId: 'public-domain', targetLinkId: 'serving-target' };
    const intent = { subject: { kind: 'environment' as const, environmentId: 'production', machineId: 'controller' },
      controllerMachineId: 'controller', domain };
    const environment = subjectStarterEventSeed('addCheck', intent);
    const service = subjectStarterEventSeed('addCheck', { subject: {
      kind: 'service', serviceId: 'systemd:api', machineId: 'watched' } });
    expect(environment).toMatchObject({ eventRef: HEALTH_CHECK_EVENT_REFS_V1.status, sourceInstanceId: expect.stringMatching(/^health:/),
      monitoringMachineId: 'controller', setupInput: { subject: { kind: 'environment', environmentId: 'production' }, domain } });
    expect(service).toMatchObject({ sourceInstanceId: expect.stringMatching(/^health:/),
      setupInput: { subject: { kind: 'machineService', machineId: 'watched', serviceId: 'systemd:api' } } });
    expect(environment?.sourceInstanceId).not.toBe(service?.sourceInstanceId);
  });
    it('retains the nightly schedule as ordinary editor intent', () => {
        expect(subjectStarterWhen('nightly')).toMatchObject({ kind: 'schedule', schedule: { repeat: 'daily', hour: 3, minute: 0 } });
        expect(subjectStarterWhen('healthFailed')).toEqual({ kind: 'pluginEvent', value: null, eventRef: HEALTH_CHECK_EVENT_REFS_V1.failed });
    });
});
