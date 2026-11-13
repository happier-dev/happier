import { afterEach, expect, it, vi } from 'vitest';
import axios from 'axios';
import { AutomationDefinitionDetailSchema } from '@happier-dev/protocol/automations/automationApiV3';
import { sealAutomationTriggerDefinitionStoredEnvelopeV1 } from '@happier-dev/protocol/automations/automationTriggerDefinitionStoredContent';
import { AutomationTriggerIdSchema } from '@happier-dev/protocol/automations/automationTriggerIdentity';
import { AutomationSourceSelectorIdV1Schema } from '@happier-dev/protocol/automations/automationEventJsonBoundsV1';
import { HEALTH_CHECK_EVENT_REFS_V1 } from '@happier-dev/protocol/deployments/healthCheckV1';
import { HAPPIER_AUTOMATION_EVENT_SOURCES_INVALIDATED_HOST_EVENT_ID_V1 } from '@happier-dev/protocol/plugins/events/hostV1';
import { createAccountEncryptionCurrentnessFixture } from '@/testkit/backends/sessionFixtures';
import { createCliHealthCheckSourceSnapshotReader } from '@/session/actions/workflowTriggers';
import { createStablePluginEventsBroker } from '../invocation/services/events';
import { assembleAutomationRuntime } from './automationAssembly';

afterEach(() => vi.restoreAllMocks());

it('borrows one current source refresh after a definitions push, with zero idle or unchanged-arrival census', async () => {
    const credentials = { token: 'header.eyJzdWIiOiJvd25lciJ9.signature', encryption: null };
    const sourceInstanceId = 'native-alert-source';
    const eventRef = HEALTH_CHECK_EVENT_REFS_V1.failed;
    const triggerId = '11111111-1111-4111-8111-111111111111';
    let revision = 0;
    let channelId: string | null = 'first-destination';
    let unavailable = false;
    let malformed = false;
    let census = 0;
    const currentness = createAccountEncryptionCurrentnessFixture({ mode: 'plain' });
    vi.spyOn(axios, 'get').mockImplementation(async () => ({ status: 200, data: currentness }));
    // Only Home HTTP is replaced; source envelope opening, selection, Account
    // currentness, the source assembly and host event delivery remain real.
    vi.spyOn(axios, 'post').mockImplementation(async () => {
        census++;
        if (unavailable) throw Object.assign(new Error('Source read refused'), { code: 'source_read_refused' });
        if (malformed) return { status: 200, data: { automations: null, nextCursor: null } };
        const binding = { v: 1 as const, automationId: 'saved-health', triggerId: AutomationTriggerIdSchema.parse(triggerId),
            triggerRevision: revision, triggerKind: 'pluginEvent' as const, eventRef,
            sourceSelectorId: AutomationSourceSelectorIdV1Schema.parse('c79a9957-537c-4f21-a08d-289245801c05') };
        return { status: 200, data: { automations: [AutomationDefinitionDetailSchema.parse({
            id: binding.automationId, name: 'Saved health', description: null, enabled: true, targetType: null,
            existingSessionId: null, templateVersion: 1, lastRunAt: null, createdAt: 1, updatedAt: 1, assignments: [],
            observationOnly: { kind: 'observationOnly', templateVersion: 1 }, triggers: [{ id: triggerId, revision,
                enabled: true, createdAt: 1, updatedAt: 1, kind: 'pluginEvent', eventRef,
                sourceSelectorId: binding.sourceSelectorId, sourceContractVersion: 1,
                observation: { kind: 'checkpointedPull', watcher: { machineId: 'remote-observer',
                    machineInstallationId: 'remote-installation', pluginId: eventRef.pluginId, materializationId: 'services' } },
                sourceStatus: null, sourceCatalogStatus: null,
                triggerDefinitionEnvelope: JSON.stringify(sealAutomationTriggerDefinitionStoredEnvelopeV1({ binding, mode: 'plain',
                    definition: { v: 1, sourceInstanceId, sourceConfig: { v: 1,
                        subject: { kind: 'machineService', machineId: 'controller', serviceId: 'db' },
                        checks: [{ checkId: 'tcp', kind: { pluginId: eventRef.pluginId, localId: 'tcp' },
                            binding: { kind: 'healthCheck' }, config: { host: 'localhost', port: 5432 },
                            periodMs: 60000, consecutiveFailuresBeforeAlerting: 1 }],
                        alerts: { channels: channelId ? [{ channelId }] : [], phases: ['open', 'recovered'] } },
                        displayLabel: 'Saved health', filter: null, maximumObservationAgeMs: null } })) }],
        })], nextCursor: null } };
    });
    const readHealthSources = createCliHealthCheckSourceSnapshotReader({ credentials, serverHttpBaseUrl: 'http://health-source.test' });
    const assembly = await assembleAutomationRuntime({ credentials, activationTargets: [], activatedPluginIds: new Set(),
        resolveCurrentMaterialization: () => null, readPluginOccurrenceId: () => null, readPluginSourceCustody: () => null,
        resolveConsumerLifecycle: () => { throw new Error('No activated source'); },
        revalidateCallerMaterialization: async () => false, revalidateCallerOccurrence: async () => false,
        readHealthSources,
    });
    const broker = createStablePluginEventsBroker();
    const subscription = broker.subscribeHost({
        target: { eventId: HAPPIER_AUTOMATION_EVENT_SOURCES_INVALIDATED_HOST_EVENT_ID_V1, scope: { kind: 'account' } },
        isCurrent: () => true,
        listener: event => {
            if (event.eventId !== HAPPIER_AUTOMATION_EVENT_SOURCES_INVALIDATED_HOST_EVENT_ID_V1) return;
            if (event.payload.definitionsChanged !== false) assembly.invalidateSourceDefinitions();
        },
    });
    const push = (definitionsChanged: boolean) => broker.publishHostEventEnvelope({
        eventId: HAPPIER_AUTOMATION_EVENT_SOURCES_INVALIDATED_HOST_EVENT_ID_V1,
        scope: { kind: 'account' }, payload: { definitionsChanged },
    });
    expect(census).toBe(0);
    push(true);
    expect(census).toBe(0);
    expect(await assembly.readHealthAlertSource(sourceInstanceId)).toMatchObject({ kind: 'available',
        source: { alerts: { channels: [{ channelId: 'first-destination' }] } } });
    await assembly.readHealthAlertSource(sourceInstanceId);
    push(false);
    await assembly.readHealthAlertSource(sourceInstanceId);
    expect(census).toBe(1);
    channelId = null; revision++;
    push(true);
    expect(await assembly.readHealthAlertSource(sourceInstanceId)).toMatchObject({ kind: 'available',
        source: { alerts: { channels: [] } } });
    expect(census).toBe(2);
    channelId = 'changed-destination'; revision++;
    push(true);
    expect(await assembly.readHealthAlertSource(sourceInstanceId)).toMatchObject({ kind: 'available',
        source: { alerts: { channels: [{ channelId: 'changed-destination' }] } } });
    expect(census).toBe(3);
    unavailable = true;
    push(true);
    expect(await assembly.readHealthAlertSource(sourceInstanceId)).toEqual({ kind: 'unavailable', code: 'source_read_refused' });
    expect(census).toBe(4);
    unavailable = false;
    broker.publishHostEventEnvelope({ eventId: HAPPIER_AUTOMATION_EVENT_SOURCES_INVALIDATED_HOST_EVENT_ID_V1,
        scope: { kind: 'account' }, payload: { reason: 'reconnect' } });
    expect(await assembly.readHealthAlertSource(sourceInstanceId)).toMatchObject({ kind: 'available',
        source: { alerts: { channels: [{ channelId: 'changed-destination' }] } } });
    expect(census).toBe(5);
    malformed = true;
    push(true);
    expect(await assembly.readHealthAlertSource(sourceInstanceId)).toMatchObject({ kind: 'unavailable', code: 'internal_error' });
    await subscription.dispose();
});
