import { afterEach, expect, it, vi } from 'vitest';
import { MachineServiceRowV1Schema } from '@happier-dev/protocol/actions/specs/machine/services';
import { AutomationEventSourceDefinitionV1Schema, AutomationEventAdmitInputV1Schema } from '@happier-dev/protocol/automations/automationActionSpecsV1';
import { HealthCheckSourceConfigV1Schema } from '@happier-dev/protocol/deployments/healthCheckSourceV1';
import { decodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { createPlainAccountArtifactHttpBoundary } from '@/api/artifacts/accountArtifactStore.testkit';
import { createConfiguredHealthCheckNotices } from './deploymentServiceHealthNotices';

afterEach(() => vi.restoreAllMocks());

it.each(['inbox', 'default'] as const)(
    'records health notices for %s mode without legacy direct auto_start dispatch and rejects auto_start configs', async kind => {
    const f = createPlainAccountArtifactHttpBoundary();
    const caller = { pluginId: 'happier.machine.services', machineId: 'observer', materializationId: 'installed' };
    const subject = { kind: 'machineService' as const, machineId: 'subject-machine', serviceId: 'nginx' };
    const checks = [{ checkId: 'tcp', kind: { pluginId: caller.pluginId, localId: 'tcp' }, binding: { kind: 'healthCheck' as const },
        config: { host: 'private-host', port: 80 }, periodMs: 1000, consecutiveFailuresBeforeAlerting: 1 }];
    expect(HealthCheckSourceConfigV1Schema.safeParse({
        v: 1, subject, investigation: { mode: 'auto_start', configuredActionId: 'investigate' }, checks,
    }).success).toBe(false);
    const definition = AutomationEventSourceDefinitionV1Schema.parse({ observationOnly: { kind: 'observationOnly' },
        automationId: '11111111-1111-4111-8111-111111111111', triggerId: 'health', triggerRevision: 1,
        sourceSelectorId: '22222222-2222-4222-8222-222222222222', sourceContractVersion: 1,
        filter: null, maximumObservationAgeMs: null, eventRef: { pluginId: caller.pluginId, localId: 'health-status' },
        sourceConfig: { v: 1, subject, ...(kind === 'default' ? {} : { investigation: { mode: 'inbox' } }), checks },
        sourceInstanceId: 'saved-health', observationTransport: { kind: 'checkpointedPull', watcherMaterializationRef: caller } });
    const service = MachineServiceRowV1Schema.parse({ serviceId: subject.serviceId, name: 'Web server', authority: 'machine',
        lifecyclePurpose: 'infrastructure', generation: null, state: 'running', watchId: 'watch', watchRevision: '1',
        capabilities: { start: false, stop: false, restart: false, logs: true, accounting: false } });
    const host = { credentials: f.credentials, serverId: 'home', serverHttpBaseUrl: 'https://health-notices.test', machineId: caller.machineId,
        readService: async () => service, readEnvironment: async () => { throw new Error('Unexpected Environment read'); } };
    const consume = (transition: 'failed' | 'recovered', time: number) => createConfiguredHealthCheckNotices(host)({
        caller, actionCaller: { kind: 'plugin', pluginId: caller.pluginId, materialization: caller },
        definition, admitted: true, signal: new AbortController().signal,
        observation: AutomationEventAdmitInputV1Schema.parse({ eventRef: definition.eventRef, occurrenceId: `${transition}-${time}`,
            occurredAt: time, observationReceivedAt: time, definitions: [{ automationId: definition.automationId,
                triggerId: definition.triggerId, triggerRevision: definition.triggerRevision, sourceSelectorId: definition.sourceSelectorId }],
            payload: { sourceInstanceId: definition.sourceInstanceId, subject, checkId: 'tcp', transition, observedAt: time } }) });
    expect(await consume('failed', 100)).toMatchObject({ kind: 'consumed', changed: true });
    expect(f.rows.size).toBe(1);
    const body = decodePlainArtifactStoredContent(String([...f.rows.values()][0]!.body));
    expect(JSON.stringify(body)).toContain('failed');
    await consume('failed', 200);
    await consume('recovered', 300);
    expect(f.rows.size).toBe(1);
});
