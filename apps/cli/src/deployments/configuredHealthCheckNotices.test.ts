import { afterEach, expect, it, vi } from 'vitest';
import { HealthCheckTransitionV1Schema, type HealthCheckSourceConfigV1 } from '@happier-dev/protocol/activity/usageNoticeArtifactV1';
import { decodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { MachineServiceRowV1Schema } from '@happier-dev/protocol/actions/specs/machine/services';
import { createConfiguredHealthCheckNotices } from './deploymentServiceHealthNotices';
import { createPlainAccountArtifactHttpBoundary } from '@/api/artifacts/accountArtifactStore.testkit';
import { AutomationEventSourceDefinitionV1Schema, AutomationEventAdmitInputV1Schema } from '@happier-dev/protocol/automations/automationActionSpecsV1';

afterEach(() => vi.restoreAllMocks());

it('commits one configured-check condition, keeps equal failures silent, and recovers it once after reload', async () => {
    const f = createPlainAccountArtifactHttpBoundary();
    const caller = { pluginId: 'happier.machine.services', machineId: 'observer', materializationId: 'installed' };
    const subject = { kind: 'machineService' as const, machineId: 'subject-machine', serviceId: 'nginx' };
    const sourceConfig: HealthCheckSourceConfigV1 = { v: 1, subject, checks: [{ checkId: 'public-http',
        kind: { pluginId: caller.pluginId, localId: 'http' }, binding: { kind: 'healthCheck' },
        config: { endpoint: 'https://secret-path.test/private', expectStatus: 200 }, periodMs: 1000, consecutiveFailuresBeforeAlerting: 2 }] };
    const definition = AutomationEventSourceDefinitionV1Schema.parse({ observationOnly: { kind: 'observationOnly' },
        automationId: '11111111-1111-4111-8111-111111111111', triggerId: 'health', triggerRevision: 1,
        sourceSelectorId: '22222222-2222-4222-8222-222222222222', sourceContractVersion: 1,
        filter: null, maximumObservationAgeMs: null, eventRef: { pluginId: caller.pluginId, localId: 'health-status' },
        sourceConfig, sourceInstanceId: 'saved-health', observationTransport: {
            kind: 'checkpointedPull', watcherMaterializationRef: caller } });
    const service = MachineServiceRowV1Schema.parse({ serviceId: subject.serviceId, name: 'Web server', authority: 'machine',
        lifecyclePurpose: 'infrastructure', generation: null, state: 'running',
        watchId: 'watch', watchRevision: '1', capabilities: { start: false, stop: false, restart: false, logs: true, accounting: false } });
    let available = true;
    const host = { credentials: f.credentials, serverId: 'home', serverHttpBaseUrl: 'https://health-notices.test', machineId: caller.machineId,
        // These ports are exact remote Action transports; C1 encoding, dedupe,
        // retention and Account Artifact HTTP beneath the consumer stay real.
        readService: async () => available ? service : null,
        readEnvironment: async () => { throw new Error('Watched checks must not read deployment content'); } };
    const observation = (transition: 'failed' | 'recovered', observedAt: number) => AutomationEventAdmitInputV1Schema.parse({
        eventRef: definition.eventRef, occurrenceId: `${transition}-${observedAt}`, occurredAt: observedAt, observationReceivedAt: observedAt,
        definitions: [{ automationId: definition.automationId, triggerId: definition.triggerId, triggerRevision: definition.triggerRevision,
            sourceSelectorId: definition.sourceSelectorId }], payload: HealthCheckTransitionV1Schema.parse({ sourceInstanceId: definition.sourceInstanceId,
            subject, checkId: 'public-http', transition, observedAt }) });
    const consume = (transition: 'failed' | 'recovered', time: number) => createConfiguredHealthCheckNotices(host)({
        caller, definition, observation: observation(transition, time), signal: new AbortController().signal });
    expect(await consume('failed', 100)).toMatchObject({ kind: 'consumed', changed: true });
    expect(f.rows.size).toBe(1);
    expect(f.writes).toHaveBeenCalledTimes(1);
    expect(await consume('failed', 200)).toMatchObject({ kind: 'consumed', changed: false });
    expect(f.writes).toHaveBeenCalledTimes(1);
    available = false;
    await expect(consume('recovered', 300)).rejects.toMatchObject({ code: 'health_check_subject_unavailable' });
    expect(f.writes).toHaveBeenCalledTimes(1);
    available = true;
    expect(await consume('recovered', 400)).toMatchObject({ kind: 'consumed', changed: true });
    expect(await consume('recovered', 500)).toMatchObject({ kind: 'consumed', changed: false });
    expect(f.rows.size).toBe(1);
    expect(f.writes).toHaveBeenCalledTimes(2);
    const storedHeader = [...f.rows.values()][0]!.header;
    if (typeof storedHeader !== 'string') throw new Error('Artifact header must use its encoded HTTP carrier');
    const header = decodePlainArtifactStoredContent(storedHeader);
    expect(header).toMatchObject({ healthPhase: 'recovered', source: { kind: 'host', topic: 'service_health',
        subject: { kind: 'healthCheck', subject, checkId: 'public-http' } }, page: { page: 'machine_service',
        machine: { serverId: 'home', machineId: subject.machineId }, service: { kind: 'adopted', watchId: 'watch' } } });
    expect(JSON.stringify(header)).not.toContain('secret-path');
});
