import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { createActionExecutor, MachineServicesDetailResultV1Schema,
    AutomationSourceSelectorIdV1Schema, AutomationTriggerIdSchema,
    sealAutomationTriggerDefinitionStoredEnvelopeV1,
    type AutomationEventStoredDefinitionProjectionV1 } from '@happier-dev/protocol';
import { AutomationEventAdmitInputV1Schema, AutomationEventSourceStatusReportV1Schema } from '@happier-dev/protocol/automations/automationActionSpecsV1';
import { ActionsSettingsV1Schema, setActionApprovalOverride } from '@happier-dev/protocol/actions/actionSettings';
import { runCheckpointedPluginEventObserverV1, type BackgroundServiceContext } from '@happier-dev/plugin-sdk/background-services';
import type { AccountKvEntry } from '@happier-dev/plugin-sdk/storage';
import type { HealthCheckSourceConfigV1, JsonValue } from '@happier-dev/plugin-sdk';
import type { HttpService } from '@happier-dev/plugin-sdk/http';
import { createAutomationEventAdoptedDefinitionSetHostV1 } from '@/plugins/runtime/automations/automationEventAdoptedDefinitionSetHost';
import { createAutomationEventActionExecutor } from '@/plugins/runtime/automations/automationEventActionExecutor';
import { createPluginInvocationActionsService } from '@/plugins/runtime/invocation/services/actions';
import type { PluginInvocationServicesSeed } from '@/plugins/runtime/invocation/services/types';
import { createHealthCheckSourceAdapter, healthTransition } from '../../../../../packages/plugins/machine-services/src/healthObserver';
import { createSavedHealthChecksHost } from './savedHealthChecks';
import { createPlainAccountArtifactHttpBoundary } from '@/api/artifacts/accountArtifactStore.testkit';
import { createConfiguredHealthCheckNotices } from '../deploymentServiceHealthNotices';
import { decodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';

afterEach(() => vi.restoreAllMocks());

it('cold-adopts retained health subscriptions for a new occurrence, preserves settled failure and admits recovery once', async () => {
    const notices = createPlainAccountArtifactHttpBoundary();
    const caller = { pluginId: 'happier.machine.services', machineId: 'observer', materializationId: 'installed' };
    const sourceCustody = { kind: 'managed' as const, immutableGenerationId: 'retained-generation', installSource: 'archive' as const };
    const sourceInstanceId = 'health:retained-service';
    const sourceConfig: HealthCheckSourceConfigV1 = { v: 1,
        subject: { kind: 'machineService', machineId: caller.machineId, serviceId: 'web' },
        checks: [{ checkId: 'http', kind: { pluginId: caller.pluginId, localId: 'http' },
            binding: { kind: 'healthCheck' }, config: { endpoint: 'https://example.test/private-health', expectStatus: 200 },
            periodMs: 1000, consecutiveFailuresBeforeAlerting: 1 }] };
    const storedDefinitions: AutomationEventStoredDefinitionProjectionV1[] = ['health-check-failed', 'health-check-recovered'].map(localId => {
        const eventRef = { pluginId: caller.pluginId, localId };
        const binding = { v: 1 as const, automationId: randomUUID(), triggerId: AutomationTriggerIdSchema.parse(`trigger-${localId}`), triggerRevision: 1,
            triggerKind: 'pluginEvent' as const, eventRef, sourceSelectorId: AutomationSourceSelectorIdV1Schema.parse(randomUUID()) };
        return { automationId: binding.automationId, triggerId: binding.triggerId, triggerRevision: 1, eventRef,
            sourceSelectorId: binding.sourceSelectorId, sourceContractVersion: 1,
            observationTransport: { kind: 'checkpointedPull', watcherMaterializationRef: caller },
            payloadSchema: healthTransition.jsonSchema,
            storedDefinitionEnvelope: sealAutomationTriggerDefinitionStoredEnvelopeV1({ mode: 'plain', binding,
                definition: { v: 1, sourceInstanceId, sourceConfig, displayLabel: 'Retained web check', filter: null, maximumObservationAgeMs: null } }) };
    });
    const currentness = { mode: 'plain' as const, version: 1, signingKeyFingerprint: 'aemk1_signing',
        contentKeyFingerprint: null, updatedAt: 1, recipientEnvelopeReadiness: { status: 'unavailable' as const, reason: 'plain_account' as const } };
    const detail = MachineServicesDetailResultV1Schema.parse({ kind: 'service', service: {
        serviceId: 'web', name: 'Web', authority: 'machine', lifecyclePurpose: 'deployment',
        generation: 'native-generation', state: 'running', watchId: 'web', watchRevision: '1',
        native: { phase: 'running', readiness: 'not_reported' },
        nativeInstance: { adapter: { pluginId: caller.pluginId, localId: 'systemd' }, nativeResourceId: 'web.service' },
        capabilities: { start: true, stop: true, restart: true, logs: true, accounting: false },
    } });
    const rows = new Map<string, AccountKvEntry>();
    const admissions: ReturnType<typeof AutomationEventAdmitInputV1Schema.parse>[] = [];
    const statuses: ReturnType<typeof AutomationEventSourceStatusReportV1Schema.parse>[] = [];
    const reads: string[] = [];
    let now = 1000;
    let httpStatus = 503;
    const http: HttpService = { async request(input) {
        return { status: httpStatus, headers: {}, body: new Uint8Array(), finalUrl: input.url };
    } } as HttpService;
    const credentials = notices.credentials;
    const actionsSettings = setActionApprovalOverride({ settings: ActionsSettingsV1Schema.parse({ v: 1, actions: {} }),
        actionId: 'automation.event.admit', surface: 'plugin', approvalRequired: false });
    function start(occurrenceId: string, gate?: Promise<void>, onRead?: () => void) {
        const abort = new AbortController();
        const owner = createAutomationEventAdoptedDefinitionSetHostV1({ credentials, caller, occurrenceId, sourceCustody,
            transport: { kind: 'checkpointedPull' }, occurrenceSignal: abort.signal,
            isOccurrenceCurrent: () => !abort.signal.aborted,
            revalidateCallerMaterialization: async () => true,
            revalidateCallerOccurrence: async value => value.occurrenceId === occurrenceId && !abort.signal.aborted,
            resolveAccountEncryptionCurrentness: async () => currentness,
            resolveAccountEncryptionMaterial: async () => null,
            // The remote stored-definition HTTP boundary returns the same
            // retained records; adoption, opening and public list stay real.
            readStoredDefinitions: async request => {
                reads.push(request.caller.occurrenceId); onRead?.(); await gate;
                return { kind: 'page', revision: '1', definitions: storedDefinitions, nextCursor: null,
                    eventDeclarationRelease: { release: { pluginId: caller.pluginId, version: '0.0.0' }, archiveDigestSha256: `sha256:${'a'.repeat(64)}` } };
            },
        });
        const resolveAdoptedDefinitionSet: Parameters<typeof createAutomationEventActionExecutor>[0]['resolveAdoptedDefinitionSet'] =
            (reference, occurrence, transport) => reference.materializationId === caller.materializationId
                && occurrence === occurrenceId && transport.kind === 'checkpointedPull' ? owner : null;
        const seed: PluginInvocationServicesSeed = { plugin: { id: caller.pluginId, version: '0.0.0' }, occurrenceId, sourceCustody,
            contribution: { id: 'health-observer', qualifiedId: `${caller.pluginId}/backgroundServices/health-observer` },
            surface: 'background', signal: abort.signal, resolveCurrentPluginMaterializationRef: () => caller,
            isOccurrenceCurrent: () => !abort.signal.aborted };
        const automationEventAction = createAutomationEventActionExecutor({ credentials, resolveAdoptedDefinitionSet,
            resolveAccountId: async () => 'owner', revalidateCallerMaterialization: async () => true,
            revalidateCallerOccurrence: async value => value.occurrenceId === occurrenceId && !abort.signal.aborted,
            onCommittedObservation: async observation => {
                await createConfiguredHealthCheckNotices({ credentials, serverId: 'home', serverHttpBaseUrl: 'https://health-notices.test',
                    machineId: caller.machineId, readEnvironment: async () => { throw new Error('service_has_no_environment'); },
                    readService: async () => detail.kind === 'service' ? detail.service : null,
                })(observation);
            },
            // Remote admission/status HTTP and native Machine detail are the
            // system boundaries; E2 preparation and Action policy remain real.
            transport: { async execute(actionId, request) {
                if (actionId === 'automation.event.source.status.report') {
                    if (!('input' in request)) throw new Error('status_input_required');
                    statuses.push(AutomationEventSourceStatusReportV1Schema.parse(request.input));
                    return {};
                }
                if (actionId !== 'automation.event.admit' || !('input' in request)) throw new Error('unexpected_event_transport');
                const input = AutomationEventAdmitInputV1Schema.parse(request.input);
                admissions.push(input);
                return { results: input.definitions.map(() => ({ kind: 'admitted', runId: randomUUID(), checkpointSafe: true })),
                    continuation: { kind: 'ready', accountCurrentness: { mode: 'plain', version: 1, contentKeyFingerprint: null } } };
            } },
        });
        const actionExecutor = createActionExecutor({ automationEventAction, machineServiceAction: async () => detail });
        const actions = createPluginInvocationActionsService({ seed,
            // The host loads the person's explicit Account policy at the
            // settings boundary; canonical Action approval still decides.
            actionExecutor: { ...actionExecutor, async execute(actionId, input, context) {
                return await actionExecutor.execute(actionId, input, { ...context, actionsSettings });
            } },
            invokeContributedAction: async () => { throw new Error('unexpected_contributed_action'); } });
        const healthChecks = createSavedHealthChecksHost({ serverId: 'server', resolveAdoptedDefinitionSet,
            readObserver: () => ({ machineId: caller.machineId, installationId: 'installation' }), now: () => now,
            openDomainArtifact: async () => { throw new Error('service_has_no_domain'); } }).bind(seed, { actions, http });
        if (!healthChecks) throw new Error('health_service_required');
        const context = { ...seed, materialization: caller, invokedAtMs: now,
            services: { actions, healthChecks, storage: { account: { kv: {
                async get(key: string) { return rows.get(key) ?? null; },
                async set(key: string, value: JsonValue, options: { expectedVersion: number | 'absent' }) {
                    const prior = rows.get(key);
                    if ((prior?.version ?? 'absent') !== options.expectedVersion) throw new Error('cas_conflict');
                    const version = (prior?.version ?? 0) + 1;
                    rows.set(key, { version, value }); return { version };
                },
            } } }, events: { host: { subscribe: () => ({ dispose() {} }) } } },
        } as unknown as BackgroundServiceContext;
        const adapter = createHealthCheckSourceAdapter(() => now);
        return { owner, abort, cycle: () => runCheckpointedPluginEventObserverV1({ context, source: adapter, mode: 'once', now: () => now }) };
    }
    const initial = start('first-occurrence');
    expect(initial.owner.readPublicProjection().kind).toBe('initializing');
    await initial.cycle();
    expect(initial.owner.readPublicProjection().kind).toBe('available');
    expect(admissions.map(value => value.eventRef.localId), JSON.stringify(statuses)).toEqual(['health-check-failed']);
    expect(notices.rows.size).toBe(1);
    expect(notices.writes).toHaveBeenCalledTimes(1);
    initial.abort.abort();
    let release!: () => void;
    let readStarted!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const reading = new Promise<void>(resolve => { readStarted = resolve; });
    const restarted = start('restarted-occurrence', gate, readStarted);
    now += 1000;
    const adopting = restarted.cycle();
    await Promise.race([reading, adopting.then(() => { throw new Error('cold_observer_settled_before_reading_retained_definitions'); })]);
    expect(restarted.owner.readPublicProjection().kind).toBe('initializing');
    release();
    await adopting;
    expect(restarted.owner.readPublicProjection()).toMatchObject({ kind: 'available', revision: '1' });
    expect(reads).toContain('restarted-occurrence');
    expect(admissions.map(value => value.eventRef.localId)).toEqual(['health-check-failed']);
    expect(notices.rows.size).toBe(1);
    expect(notices.writes).toHaveBeenCalledTimes(1);
    expect(statuses).toContainEqual(expect.objectContaining({ kind: 'catalogReconciliation', state: 'current', adoptedRevision: '1' }));
    httpStatus = 200; now += 1000;
    await restarted.cycle();
    await restarted.cycle();
    expect(admissions.map(value => value.eventRef.localId)).toEqual(['health-check-failed', 'health-check-recovered']);
    expect(admissions[1]?.payload).toMatchObject({ transition: 'recovered' });
    expect(notices.rows.size).toBe(1);
    expect(notices.writes).toHaveBeenCalledTimes(2);
    expect(decodePlainArtifactStoredContent([...notices.rows.values()][0]!.header)).toMatchObject({
        healthPhase: 'recovered', source: { subject: { kind: 'healthCheck', subject: sourceConfig.subject, checkId: 'http' } },
    });
    restarted.abort.abort();
});
