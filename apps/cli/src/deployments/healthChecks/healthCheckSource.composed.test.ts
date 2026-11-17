import { describe, expect, it, vi } from 'vitest';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { HealthCheckResultV1Schema } from '@happier-dev/deployment-protocol/v1';
import { plugin } from '../../../../../packages/plugins/machine-services/src/manifest';
import { healthResultProjectionSchema, healthResultProjectionAt, retainHealthResult } from '../../../../../packages/plugins/machine-services/src/healthResultProjection';
import { createHealthCheckSourceAdapter } from '../../../../../packages/plugins/machine-services/src/healthObserver';
import { runCheckpointedPluginEventObserverV1, type BackgroundServiceContext,
    type PluginCheckpointedEventSourceDefinitionV1 } from '@happier-dev/plugin-sdk/background-services';
import { AutomationEventAdmitInputV1Schema, AutomationEventSourceDefinitionV1Schema } from '@happier-dev/protocol/automations/automationActionSpecsV1';
import type { AccountKvEntry, AccountKvService } from '@happier-dev/plugin-sdk/storage';
import type { HealthCheckResultV1, HealthCheckSourceConfigV1, JsonValue } from '@happier-dev/plugin-sdk';
import { readHeartbeatHealthCheckV1 } from './finiteHeartbeatHealthCheck';
import { PluginError } from '@happier-dev/plugin-sdk/errors';
import { createPlainAccountArtifactHttpBoundary } from '@/api/artifacts/accountArtifactStore.testkit';
import { createConfiguredHealthCheckNotices } from '../deploymentServiceHealthNotices';
import { createDeploymentEnvironmentDetailV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { decodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { normalizePluginAccountStorageJsonValueV1 } from '@happier-dev/protocol/plugins/data/accountKvValueV1';
import { PLUGIN_ACCOUNT_STORAGE_LIMITS_V1 } from '@happier-dev/plugin-sdk/storage';
import { createAccountWorkflowTriggerActions } from '@happier-dev/protocol/actions/executor/workflowTriggerAccountHost';
import { AutomationDefinitionDetailSchema, type AutomationDefinitionDetail } from '@happier-dev/protocol/automations/automationApiV3';
import { sealAutomationTriggerDefinitionStoredEnvelopeV1 } from '@happier-dev/protocol/automations/automationTriggerDefinitionStoredContent';

const materialization = { pluginId: 'happier.machine.services', machineId: 'observer', materializationId: 'installed' };
const source: HealthCheckSourceConfigV1 = { v: 1, subject: { kind: 'machineService', machineId: 'subject', serviceId: 'service' },
    checks: [{ checkId: 'http', kind: { pluginId: materialization.pluginId, localId: 'http' }, binding: { kind: 'healthCheck' },
        config: { endpoint: 'https://example.test/private-path', expectStatus: 200 }, periodMs: 1000, consecutiveFailuresBeforeAlerting: 2 }] };
const definition: PluginCheckpointedEventSourceDefinitionV1 = {
    automationId: '11111111-1111-4111-8111-111111111111', triggerId: 'health-trigger', triggerRevision: 1,
    sourceSelectorId: '22222222-2222-4222-8222-222222222222', eventRef: { pluginId: materialization.pluginId, localId: 'health-status' },
    sourceInstanceId: 'health:service', sourceContractVersion: 1, sourceConfig: source,
    observationTransport: { kind: 'checkpointedPull', watcherMaterializationRef: materialization }, filter: null, maximumObservationAgeMs: null,
};
const result = (status: HealthCheckResultV1['status'], observedAt: number): HealthCheckResultV1 => ({ status, observedAt,
    evidence: { v: 1, items: [{ source: { kind: 'alert', label: 'http' }, author: { kind: 'process' }, text: '{"reason":"http_status"}' }] } });

function fixture(healthSource: HealthCheckSourceConfigV1 = source, events = ['health-status'], triggerRevision = definition.triggerRevision,
    enrolledDefinition?: PluginCheckpointedEventSourceDefinitionV1) {
    let configuredSource = healthSource;
    let now = 1000;
    let status: HealthCheckResultV1['status'] = 'down';
    let safe = true;
    let active = true;
    let watcher = materialization;
    let revision = 1;
    const rows = new Map<string, AccountKvEntry>();
    const writes: JsonValue[] = [];
    const admissions: ReturnType<typeof AutomationEventAdmitInputV1Schema.parse>[] = [];
    const hostListeners = new Map<string, Set<(event: { payload: JsonValue }) => void | Promise<void>>>();
    const pluginListeners = new Map<string, Set<(event: { payload: JsonValue }) => void | Promise<void>>>();
    const sourceReports = new Set<() => void>();
    const kv = {
        async get(key: string) { return rows.get(key) ?? null; },
        async set(key: string, value: JsonValue, options: { expectedVersion: number | 'absent' }) {
            normalizePluginAccountStorageJsonValueV1(value);
            const previous = rows.get(key);
            if ((previous?.version ?? 'absent') !== options.expectedVersion) throw new Error('CAS conflict');
            const version = (previous?.version ?? 0) + 1;
            rows.set(key, { version, value }); writes.push(value); return { version };
        },
        async transaction<T>(operation: (store: AccountKvService) => Promise<T>) { return operation(kv as AccountKvService); },
    };
    const read = vi.fn(async () => [{ checkId: 'http', result: result(status, now) }]);
    const execute = vi.fn(async (id: string, input: unknown) => {
        if (id === 'automation.event.sources.list') return { kind: 'page', revision: String(revision),
            definitions: !active ? [] : enrolledDefinition ? [enrolledDefinition] : events.map((localId, index) => ({ ...definition, triggerId: `health-trigger-${index}`, triggerRevision,
                eventRef: { ...definition.eventRef, localId }, sourceConfig: configuredSource,
                observationTransport: { kind: 'checkpointedPull', watcherMaterializationRef: watcher } })), nextCursor: null };
        if (id === 'automation.event.source.status.report') {
            if (input && typeof input === 'object' && 'kind' in input && input.kind === 'source') {
                for (const listener of sourceReports) listener();
            }
            return { kind: 'reported' };
        }
        if (id === 'automation.event.admit') {
            const request = AutomationEventAdmitInputV1Schema.parse(input); admissions.push(request);
            return { results: safe ? request.definitions.map(() => ({ kind: 'admitted', checkpointSafe: true, runId: 'run-1' })) : [] };
        }
        throw new Error(`Unexpected host Action ${id}`);
    });
    // SDK host Actions, Account KV and finite health reads are genuine plugin
    // boundaries; the source adapter and SDK admission/runner remain real.
    const context = { plugin: { id: materialization.pluginId, version: '0.0.0' },
        contribution: { id: 'health-observer', qualifiedId: `${materialization.pluginId}/backgroundServices/health-observer` },
        surface: 'background', invokedAtMs: now, materialization, signal: new AbortController().signal,
        services: { actions: { execute }, healthChecks: { read }, storage: { account: { kv: kv as AccountKvService } },
            events: { host: { subscribe: (target: { eventId: string }, listener: (event: { payload: JsonValue }) => void | Promise<void>) => {
                let listeners = hostListeners.get(target.eventId);
                if (!listeners) { listeners = new Set(); hostListeners.set(target.eventId, listeners); }
                listeners.add(listener);
                return { dispose() { listeners.delete(listener); } };
            } }, plugin: { subscribe(target: { localId: string }, listener: (event: { payload: JsonValue }) => void | Promise<void>) {
                let listeners = pluginListeners.get(target.localId);
                if (!listeners) { listeners = new Set(); pluginListeners.set(target.localId, listeners); }
                listeners.add(listener);
                return { dispose() { listeners.delete(listener); } };
            } } } },
    } as unknown as BackgroundServiceContext;
    const adapter = createHealthCheckSourceAdapter(() => now, context.services.events.host, context.services.events.plugin);
    const errors: unknown[] = [];
    const cycle = (sourceAdapter = adapter, selectedContext = context) => runCheckpointedPluginEventObserverV1({
        context: selectedContext, source: { ...sourceAdapter, async observe(input) {
            try { return await sourceAdapter.observe(input); } catch (error) { errors.push(error); throw error; }
        } }, mode: 'once', now: () => now,
    });
    return { context, adapter, errors, read, writes, rows, admissions, cycle, kv, tick(value: HealthCheckResultV1['status']) { now += 1000; status = value; },
        clock(time: number) { now = time; },
        async heartbeat(payload: JsonValue) {
            for (const listener of hostListeners.get('@happier/health-check/heartbeat-received') ?? []) await listener({ payload });
        },
        async monitor(payload: JsonValue, localId = 'health-uptime-kuma-observed') {
            for (const listener of pluginListeners.get(localId) ?? []) await listener({ payload });
        },
        async invalidate(payload: JsonValue) {
            for (const listener of hostListeners.get('@happier/automation/event-sources-invalidated') ?? []) await listener({ payload });
        },
        onSourceReport(listener: () => void) { sourceReports.add(listener); },
        configure(next: HealthCheckSourceConfigV1) { configuredSource = next; revision += 1; },
        safe(value: boolean) { safe = value; }, remove() { active = false; revision += 1; },
        assign(machineId: string) { watcher = { ...materialization, machineId }; revision += 1; },
        // A continuous runner retains its owner across adoption cycles. The
        // once-mode driver below deliberately supplies that retirement boundary.
        async retire() { await adapter.retire?.({ context, definitions: active ? [{ ...definition,
            observationTransport: { kind: 'checkpointedPull', watcherMaterializationRef: watcher } }] : [],
            revision: String(revision), isCurrent: async () => true }); }, now: () => now };
}

describe('saved health source registration and finite cycles', () => {
    it('retains saved source identity while a threshold transition awaits admission', async () => {
        const f = fixture();
        f.safe(false);
        await f.cycle();
        f.tick('down');
        await f.cycle();
        expect(f.writes.at(-1)).toMatchObject({
            source: { sourceInstanceId: definition.sourceInstanceId, subject: source.subject },
            pending: [{ checkId: 'http' }],
        });
    });
    it('reads additive nested checkpoint diagnostics without accepting invalid known fields', async () => {
        const f = fixture();
        await f.cycle();
        const [key, entry] = [...f.rows][0]!;
        if (!entry || !('value' in entry) || !entry.value || typeof entry.value !== 'object' || Array.isArray(entry.value)) throw Error('Expected checkpoint');
        const value = entry.value;
        const current = healthResultProjectionSchema.parse(value.current);
        const withCause = (httpStatus: number | string) => ({ ...value, futureCheckpoint: true, current: { ...current,
            checks: current.checks.map(check => ({ ...check, result: { ...check.result, cause: { kind: 'http', vantage: 'outside',
                observerMachineId: 'observer', httpStatus, futureDiagnostic: { detail: true } } } })) } });
        f.rows.set(key, { version: entry.version, value: withCause(503) });
        f.tick('up'); await f.cycle();
        expect(f.errors).toEqual([]);
        const latest = f.rows.get(key)!;
        if (!('value' in latest)) throw Error('Expected checkpoint');
        f.rows.set(key, { version: latest.version, value: withCause('503') });
        f.tick('up'); await f.cycle();
        expect(f.errors).toHaveLength(1);
    });
    it('acknowledges an admitted transition after a newer current result without losing that result', async () => {
        const configured = { ...source, checks: source.checks.map(check => ({ ...check, consecutiveFailuresBeforeAlerting: 1 })) };
        const f = fixture(configured);
        const input = { context: f.context, definition, definitions: [definition], source: configured, isCurrent: async () => true };
        const failed = await f.adapter.observe(input);
        if (!failed.checkpoint) throw Error('Expected failed transition checkpoint');
        f.tick('up'); await f.adapter.observe(input);
        await f.adapter.save({ ...input, checkpoint: failed.checkpoint });
        expect(f.writes.at(-1)).toMatchObject({ current: { checks: [{ result: { status: 'up', observedAt: 2000 } }] } });
        f.tick('up');
        const recovery = await f.adapter.observe(input);
        expect(recovery.observations[0]?.payload).toMatchObject({ transition: 'recovered' });
        expect(f.read).toHaveBeenCalledTimes(3);
    });
    it('retains the known latest failed sample when upgrading an old checkpoint with incomplete history', () => {
        const previous = healthResultProjectionSchema.parse({ v: 1, members: [], checks: [{ checkId: 'http', result: result('down', 10) }] }).checks[0]!;
        expect(previous.recentResults).toBeUndefined();
        expect(retainHealthResult(previous, 'http', result('down', 10)).recentResults).toBeUndefined();
        const next = retainHealthResult(previous, 'http', result('down', 20));
        expect(next).toMatchObject({ recentResults: [{ observedAt: 10 }, { observedAt: 20 }],
            recentResultsCoverage: 'partial', failingSince: 10, failureStreak: 2 });
        expect(retainHealthResult(next, 'http', result('up', 30))).toMatchObject({ failingSince: null, failureStreak: 0 });
    });
    it('enrolls one failed-event observation through failure Notice and recovery', async () => {
        const artifacts = createPlainAccountArtifactHttpBoundary();
        const environment = createDeploymentEnvironmentDetailV1();
        const configured: HealthCheckSourceConfigV1 = { ...source,
            subject: { kind: 'environment', environmentId: environment.environment.id },
            checks: source.checks.map(check => ({ ...check, consecutiveFailuresBeforeAlerting: 1 })) };
        const rows = new Map<string, AutomationDefinitionDetail>();
        // Automation HTTP persistence is the boundary. Enrollment, private-definition
        // codecs, source observation and Notice publication all run their real owners.
        const enrollment = createAccountWorkflowTriggerActions({
            resolveEncryption: async () => ({ kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
            randomBytes: length => new Uint8Array(length).fill(3), newId: () => crypto.randomUUID(),
            automations: {
                list: async () => ({ automations: [...rows.values()], nextCursor: null }),
                listDetails: async () => ({ automations: [...rows.values()], nextCursor: null }),
                get: async id => rows.get(id) ?? null,
                create: async input => {
                    const row = AutomationDefinitionDetailSchema.parse({ id: input.automationId, name: input.name,
                        description: input.description ?? null, enabled: input.enabled, targetType: null, existingSessionId: null,
                        templateVersion: 1, lastRunAt: null, createdAt: 1, updatedAt: 1, scheduleOccurrences: [],
                        workflowDefinitionId: null, scopeSessionId: null, observationOnly: input.observationOnly, assignments: [],
                        triggers: input.triggers.map(({ triggerId, trigger }) => {
                            if (trigger.kind !== 'pluginEvent' || 'triggerDefinitionEnvelope' in trigger
                                || trigger.observationTransport.kind !== 'checkpointedPull') throw new Error('Unexpected enrollment');
                            const sourceSelectorId = definition.sourceSelectorId;
                            return { kind: 'pluginEvent', id: triggerId, revision: 0, enabled: trigger.enabled,
                                createdAt: 1, updatedAt: 1, eventRef: trigger.eventRef, sourceSelectorId,
                                sourceContractVersion: trigger.sourceContractVersion, sourceStatus: null, sourceCatalogStatus: null,
                                observation: { kind: 'checkpointedPull', watcher: { ...materialization, machineInstallationId: 'installed' } },
                                triggerDefinitionEnvelope: JSON.stringify(sealAutomationTriggerDefinitionStoredEnvelopeV1({ mode: 'plain',
                                    binding: { v: 1, automationId: input.automationId, triggerId, triggerRevision: 0,
                                        triggerKind: 'pluginEvent', eventRef: trigger.eventRef, sourceSelectorId },
                                    definition: { v: 1, sourceInstanceId: trigger.sourceInstanceId, sourceConfig: trigger.sourceConfig,
                                        displayLabel: trigger.displayLabel, filter: trigger.filter, maximumObservationAgeMs: trigger.maximumObservationAgeMs,
                                        automationDisplay: trigger.automationDisplay } })) };
                        }) });
                    rows.set(row.id, row); return row;
                },
                reconcile: async () => { throw new Error('Unexpected enrollment update'); },
                delete: async () => { throw new Error('Unexpected enrollment removal'); },
            },
        });
        const saved = await enrollment.add({ observationOnly: { kind: 'observationOnly' }, includeEventDefinition: true,
            trigger: { kind: 'pluginEvent', enabled: true, eventRef: { ...definition.eventRef, localId: 'health-check-failed' },
                sourceInstanceId: definition.sourceInstanceId, sourceContractVersion: definition.sourceContractVersion,
                sourceConfig: configured, displayLabel: 'Saved health checks', observationTransport: definition.observationTransport,
                filter: null, maximumObservationAgeMs: null } });
        const persisted = rows.get(saved.set.automationId)?.triggers[0];
        const privateDefinition = saved.triggerDefinition?.definition;
        if (persisted?.kind !== 'pluginEvent' || !privateDefinition) throw new Error('Expected saved observation');
        const noticeDefinition = AutomationEventSourceDefinitionV1Schema.parse({ ...definition,
            sourceInstanceId: privateDefinition.sourceInstanceId, sourceConfig: privateDefinition.sourceConfig,
            filter: privateDefinition.filter,
            maximumObservationAgeMs: privateDefinition.maximumObservationAgeMs,
            automationId: saved.set.automationId, triggerId: saved.triggerId, triggerRevision: saved.triggerRevision,
            eventRef: persisted.eventRef, sourceSelectorId: persisted.sourceSelectorId, observationOnly: { kind: 'observationOnly' } });
        const f = fixture(configured, [noticeDefinition.eventRef.localId], noticeDefinition.triggerRevision, noticeDefinition);
        const publish = createConfiguredHealthCheckNotices({ credentials: artifacts.credentials,
            serverId: environment.environment.serverId, serverHttpBaseUrl: 'https://health-notices.test',
            machineId: materialization.machineId, readService: async () => null, readEnvironment: async () => environment });
        await f.cycle();
        expect(f.errors).toEqual([]);
        expect(f.admissions).toHaveLength(1);
        await publish({ caller: materialization, definition: noticeDefinition, admitted: false,
            signal: f.context.signal, observation: f.admissions[0]! });
        expect([...artifacts.rows.values()].map(row => decodePlainArtifactStoredContent(String(row.header))))
            .toEqual([expect.objectContaining({ healthPhase: 'open' })]);
        f.tick('up'); await f.cycle();
        expect(f.errors).toEqual([]);
        expect(f.admissions).toHaveLength(2);
        await publish({ caller: materialization, definition: noticeDefinition, admitted: false,
            signal: f.context.signal, observation: f.admissions[1]! });
        expect([...artifacts.rows.values()].map(row => decodePlainArtifactStoredContent(String(row.header))))
            .toEqual([expect.objectContaining({ healthPhase: 'recovered' })]);
    });
    it('adopts an alert-only Environment source without probes, occurrences or a next check deadline', async () => {
        const f = fixture({ v: 1, subject: { kind: 'environment', environmentId: 'production' }, checks: [],
            alerts: { channels: [{ channelId: 'slack' }], phases: ['open', 'recovered'] } });
        const decoded = f.adapter.decode({ ...definition, sourceConfig: { v: 1,
            subject: { kind: 'environment', environmentId: 'production' }, checks: [],
            alerts: { channels: [{ channelId: 'slack' }], phases: ['open', 'recovered'] } } });
        expect(decoded).not.toBeNull();
        const observed = await f.adapter.observe({ context: f.context, definition, definitions: [definition],
            source: decoded!, isCurrent: async () => true });
        expect(observed.nextEligibleAt).toBeNull();
        await f.cycle();
        expect(f.read).not.toHaveBeenCalled();
        expect(f.admissions).toEqual([]);
        expect(f.writes).toEqual([]);
    });
    it.each(['uptime-kuma', 'gatus'] as const)('carries registered %s deliveries through shared D5 into one Domain C1 condition and recovery', async kind => {
        const artifacts = createPlainAccountArtifactHttpBoundary();
        const environment = createDeploymentEnvironmentDetailV1();
        environment.environment.controllerMachineId = materialization.machineId;
        environment.environment.protection = 'production';
        const endpoint = 'wh_ep_AAAAAAAAAAAAAAAAAAAAAA';
        const mapped: HealthCheckSourceConfigV1 = { v: 1, subject: { kind: 'environment', environmentId: environment.environment.id },
            checks: [{ checkId: 'shop', kind: { pluginId: materialization.pluginId, localId: kind },
                binding: { kind: 'domain', domainId: 'shop-domain', targetLinkId: environment.environment.runtimeTargetLinkId!, condition: 'domain_probe_failed' },
                config: { ...(kind === 'uptime-kuma' ? { monitorId: '7' } : { endpointGroup: '', endpointName: 'Shop' }),
                    webhookEndpointId: endpoint, observingSince: 100 }, periodMs: 1000, consecutiveFailuresBeforeAlerting: 2 }] };
        const f = fixture(mapped, ['health-check-failed', 'health-check-recovered']);
        const kit = await createPluginTestkit({ manifest: plugin.manifest, module: plugin, services: {
            storage: { account: { kv: f.kv as AccountKvService } }, healthChecks: { readSource: async () => mapped },
            events: { plugin: { emit: async (localId: string, payload: JsonValue) => f.monitor(payload, localId) } },
        } });
        f.read.mockImplementation(async () => [{ checkId: 'shop', result: HealthCheckResultV1Schema.parse(await kit.invokeAction(`health/${kind}`,
            { sourceInstanceId: definition.sourceInstanceId, checkId: 'shop' })) }]);
        const noticeDefinition = AutomationEventSourceDefinitionV1Schema.parse({ ...definition, sourceConfig: mapped,
            observationOnly: { kind: 'observationOnly' } });
        const publish = createConfiguredHealthCheckNotices({ credentials: artifacts.credentials, serverId: environment.environment.serverId,
            serverHttpBaseUrl: 'https://monitor-notices.test', machineId: materialization.machineId,
            readService: async () => null, readEnvironment: async () => environment });
        const deliver = async (status: 'down' | 'up', receivedAtMs: number) => {
            const raw = JSON.stringify(kind === 'uptime-kuma' ? { monitor: { id: 7 }, heartbeat: { monitorID: 7, status: status === 'up' ? 1 : 0,
                time: new Date(Date.UTC(2026, 10, 10) + receivedAtMs).toISOString().replace('T', ' ').replace('Z', ''), msg: 'private provider body' },
                subject: { environmentId: 'forged-environment' } }
                : { endpointGroup: '', endpointName: 'Shop', status: status === 'up' ? 'RESOLVED' : 'TRIGGERED', msg: 'private provider body' });
            await kit.invokeAction(`health/${kind}/receive`, { v: 1, endpoint: {
                webhookContribution: { pluginId: materialization.pluginId, localId: `health-${kind}` },
                sourceInstanceId: definition.sourceInstanceId, webhookEndpointId: endpoint },
                delivery: { deliveryId: `monitor-${receivedAtMs}`, providerDeliveryId: `monitor-${receivedAtMs}`, attempt: 1, replay: 0, receivedAtMs },
                request: { contentType: 'application/json', headers: [], rawBodyBytes: Buffer.byteLength(raw), rawBodyBase64: Buffer.from(raw).toString('base64') },
                verified: { verifier: 'capabilityUrl_v1' } });
            await f.cycle();
        };
        const subscription = f.adapter.subscribeWake?.(async () => {});
        try {
            await f.cycle();
            await deliver('down', 200); await deliver('down', 200);
            expect(f.admissions).toHaveLength(0);
            await deliver('down', 300);
            expect(f.admissions).toHaveLength(1);
            await publish({ caller: materialization, definition: noticeDefinition, admitted: true, signal: new AbortController().signal,
                observation: f.admissions[0]! });
            expect([...artifacts.rows.values()].map(row => decodePlainArtifactStoredContent(String(row.header))))
                .toEqual([expect.objectContaining({ healthPhase: 'open', source: expect.objectContaining({ subject: expect.objectContaining({
                    kind: 'domain', environmentId: environment.environment.id, domainId: 'shop-domain', condition: 'domain_probe_failed' }) }) })]);
            await deliver('up', 400);
            expect(f.admissions).toHaveLength(2);
            await publish({ caller: materialization, definition: noticeDefinition, admitted: true, signal: new AbortController().signal,
                observation: f.admissions[1]! });
            const headers = [...artifacts.rows.values()].map(row => decodePlainArtifactStoredContent(String(row.header)));
            expect(headers).toEqual([expect.objectContaining({ healthPhase: 'recovered' })]);
            expect(JSON.stringify(headers)).not.toContain('private provider body');
            expect(JSON.stringify(headers)).not.toContain('forged-environment');
            expect(f.errors).toEqual([]);
        } finally { subscription?.dispose(); await kit.dispose(); }
    });
    it('counts distinct monitor receipts once and wakes the same observer without an idle timer', async () => {
        const endpoint = 'wh_ep_AAAAAAAAAAAAAAAAAAAAAA';
        const mapped = { ...source, checks: [{ ...source.checks[0]!, kind: { pluginId: materialization.pluginId, localId: 'uptime-kuma' },
            config: { monitorId: '7', webhookEndpointId: endpoint, observingSince: 0 } }] };
        const f = fixture(mapped, ['health-check-failed', 'health-check-recovered']);
        let observation = result('down', 1000);
        f.read.mockImplementation(async () => [{ checkId: 'http', result: observation }]);
        const subscription = f.adapter.subscribeWake?.(async () => {});
        const hint = { sourceInstanceId: definition.sourceInstanceId, checkId: 'http', webhookEndpointId: endpoint };
        try {
            await f.cycle();
            f.clock(100_000); await f.cycle();
            expect(f.read).toHaveBeenCalledTimes(1);
            await f.monitor(hint); await f.cycle();
            expect(f.admissions).toHaveLength(0);
            observation = result('down', 2000);
            await f.monitor(hint); await f.cycle();
            expect(f.admissions).toHaveLength(1);
            observation = result('up', 3000);
            await f.monitor({ ...hint, webhookEndpointId: 'wh_ep_BBBBBBBBBBBBBBBBBBBBBA' }); await f.cycle();
            expect(f.admissions).toHaveLength(1);
            await f.monitor(hint); await f.cycle();
            expect(f.admissions).toHaveLength(2);
            expect(f.admissions[1]?.payload).toMatchObject({ transition: 'recovered', observedAt: 3000 });
        } finally { subscription?.dispose(); }
    });
    it('keeps the newest results inside the actual Account KV byte capacity without losing uptime or failure state', async () => {
        const f = fixture();
        f.clock(86_400_000); await f.cycle();
        const [key, entry] = [...f.rows][0]!;
        if (!entry || !('value' in entry) || !entry.value || typeof entry.value !== 'object' || Array.isArray(entry.value)) throw Error('Expected checkpoint');
        const value = entry.value;
        const current = healthResultProjectionSchema.parse(value.current);
        const check = current.checks[0]!;
        const samples: HealthCheckResultV1[] = [];
        const checkpoint = () => ({ ...value, current: { ...current, checks: [{ ...check, recentResults: samples,
            recentResultsCoverage: 'complete' as const }] } });
        const bytes = (candidate: unknown) => new TextEncoder().encode(JSON.stringify(candidate)).byteLength;
        while (bytes(checkpoint()) <= PLUGIN_ACCOUNT_STORAGE_LIMITS_V1.maximumValueEncodedBytes) {
            samples.unshift(result('down', f.now() - samples.length));
        }
        samples.shift();
        f.rows.set(key, { version: entry.version, value: checkpoint() });
        f.tick('down'); await f.cycle();
        expect(f.errors).toEqual([]);
        const retained = f.writes.at(-1)!;
        expect(bytes(retained)).toBeLessThanOrEqual(PLUGIN_ACCOUNT_STORAGE_LIMITS_V1.maximumValueEncodedBytes);
        if (!retained || typeof retained !== 'object' || Array.isArray(retained)) throw Error('Expected checkpoint');
        const actual = healthResultProjectionSchema.parse(retained.current).checks[0]!;
        expect(actual).toMatchObject({ result: { observedAt: f.now() }, failureStreak: 2, failingSince: 86_400_000,
            recentResultsCoverage: 'partial', history: { days: [{ down: 2 }] } });
        expect(actual.recentResults?.at(-1)?.observedAt).toBe(f.now());
        expect(f.read).toHaveBeenCalledTimes(2);
    });
    it('re-adopts a legacy result without inventing missing history or rewriting its checkpoint', async () => {
        const f = fixture();
        await f.cycle();
        const [key, entry] = [...f.rows][0]!;
        if (!entry || !('value' in entry) || !entry.value || typeof entry.value !== 'object' || Array.isArray(entry.value)) throw Error('Expected checkpoint');
        const current = healthResultProjectionSchema.parse(entry.value.current);
        f.rows.set(key, { version: entry.version, value: { ...entry.value, current: { ...current,
            checks: current.checks.map(({ checkId, result }) => ({ checkId, result })),
        } } });
        const writes = f.writes.length;
        await f.cycle(createHealthCheckSourceAdapter(f.now));
        expect(f.read).toHaveBeenCalledTimes(2);
        expect(f.errors).toEqual([]);
        expect(f.writes).toHaveLength(writes);
    });
    it('retains thirty UTC days of sample uptime through equal results, missing days and restart without extra probes', async () => {
        const day = 86_400_000;
        const f = fixture();
        const current = () => {
            const row = f.writes.at(-1);
            if (!row || typeof row !== 'object' || Array.isArray(row)) throw Error('Expected checkpoint');
            return healthResultProjectionSchema.parse(row.current).checks[0]!;
        };
        f.clock(day); await f.cycle();
        expect(f.writes.at(-1)).toMatchObject({ source: {
            sourceInstanceId: definition.sourceInstanceId, subject: source.subject,
        } });
        expect(current()).toMatchObject({ history: { uptimePercent: 0,
            days: [{ dayStartAt: day, up: 0, down: 1, degraded: 0, unknown: 0 }] } });
        expect(current()).toMatchObject({ recentResults: [{ status: 'down', observedAt: day }],
            failingSince: day, failureStreak: 1 });
        const writes = f.writes.length;
        await f.cycle();
        expect(f.writes).toHaveLength(writes);
        expect(f.read).toHaveBeenCalledTimes(1);
        f.tick('up'); await f.cycle();
        expect(current()).toMatchObject({ failingSince: null, failureStreak: 0 });
        f.tick('degraded'); await f.cycle();
        expect(current()).toMatchObject({ failingSince: f.now(), failureStreak: 1 });
        f.tick('unknown'); await f.cycle();
        expect(current()).toMatchObject({ failingSince: null, failureStreak: 0 });
        expect(current()).toMatchObject({ history: { uptimePercent: 100 / 3,
            days: [{ up: 1, down: 1, degraded: 1, unknown: 1 }] } });
        // Gaps remain unobserved; no invented up/down duration. Re-adoption of
        // the same result must not count the sample again.
        const priorWrites = f.writes.length;
        await f.cycle(createHealthCheckSourceAdapter(f.now));
        expect(f.writes).toHaveLength(priorWrites);
        for (let date = 2; date <= 31; date++) {
            f.clock(date * day); f.tick('up');
            await f.cycle(createHealthCheckSourceAdapter(f.now));
        }
        expect(current().history?.days).toHaveLength(30);
        expect(current().history?.days[0]?.dayStartAt).toBe(2 * day);
        expect(current().history?.uptimePercent).toBe(100);
        expect(current()).toMatchObject({ recentResults: expect.not.arrayContaining([
            expect.objectContaining({ observedAt: day }),
        ]) });
        expect(healthResultProjectionAt({ v: 1, members: [], checks: [current()] }, 65 * day).checks[0]?.history)
            .toMatchObject({ days: [], uptimePercent: null });
        f.clock(65 * day); f.tick('unknown'); await f.cycle();
        expect(current().history).toMatchObject({ uptimePercent: null,
            days: [{ dayStartAt: 65 * day, unknown: 1 }] });
        expect(current().history?.days).toHaveLength(1);
        expect(f.read).toHaveBeenCalledTimes(36);
        expect(f.errors).toEqual([]);
    });

    it('selects failed and recovered Events from one saved observer without evidence or duplicate failure runs', async () => {
        const f = fixture(source, ['health-check-failed', 'health-check-recovered']);
        await f.cycle(); f.tick('down'); await f.cycle();
        expect(f.errors).toEqual([]);
        expect(f.admissions).toHaveLength(1);
        expect(f.admissions[0]).toMatchObject({ eventRef: { localId: 'health-check-failed' }, payload: {
            sourceInstanceId: definition.sourceInstanceId, subject: source.subject, checkId: 'http',
            transition: 'failed', observedAt: 2000,
        } });
        expect(f.admissions[0]?.payload).not.toHaveProperty('result');
        f.tick('degraded'); await f.cycle(); f.tick('degraded'); await f.cycle();
        expect(f.admissions).toHaveLength(1);
        f.tick('up'); await f.cycle();
        expect(f.admissions).toHaveLength(2);
        expect(f.admissions[1]).toMatchObject({ eventRef: { localId: 'health-check-recovered' }, payload: { transition: 'recovered' } });
        expect(f.read).toHaveBeenCalledTimes(5);
        await f.cycle(createHealthCheckSourceAdapter(f.now));
        expect(f.admissions).toHaveLength(2);
        expect(JSON.stringify(f.admissions)).not.toContain('http_status');
    });

    it.each(['http', 'certificate', 'tcp', 'dns', 'heartbeat'])('reaches the saved-selector %s producer through the registered manual Action', async (kind) => {
        const kit = await createPluginTestkit({ manifest: plugin.manifest, module: plugin,
            services: { healthChecks: { read: async () => [{ checkId: kind, result: result('up', 1000) }] } } });
        try {
            const result = await kit.invokeAction(`health/${kind}`, {
                sourceInstanceId: 'health:service:machine-a:service-a', checkId: kind,
            });
            expect(HealthCheckResultV1Schema.parse(result).status).toBe('up');
        } finally {
            await kit.dispose();
        }
    });

    it('admits only threshold transitions and keeps equal ticks, unknown and absent assignment silent', async () => {
        const f = fixture();
        await f.cycle();
        await f.cycle();
        expect(f.read).toHaveBeenCalledTimes(1);
        expect(f.admissions).toHaveLength(0);
        f.tick('unknown'); await f.cycle();
        f.tick('down'); await f.cycle();
        expect(f.admissions).toHaveLength(0);
        f.tick('down'); await f.cycle();
        expect(f.errors).toEqual([]);
        expect(f.admissions).toHaveLength(1);
        const written = f.writes.length;
        for (let index = 0; index < 10; index++) { f.tick('down'); await f.cycle(); }
        expect(f.admissions).toHaveLength(1);
        expect(f.writes).toHaveLength(written + 10);
        f.tick('up'); await f.cycle();
        expect(f.admissions).toHaveLength(2);
        expect(f.admissions[1]?.payload).toMatchObject({ transition: 'recovered' });
        expect(JSON.stringify(f.admissions)).not.toContain('private-path');
        const reads = f.read.mock.calls.length;
        await f.cycle(undefined, { ...f.context, materialization: { ...materialization, machineId: 'other' } });
        f.remove(); await f.cycle();
        expect(f.read).toHaveBeenCalledTimes(reads);
    });

    it('refreshes current health while replaying the original pending Event after reload', async () => {
        const f = fixture();
        await f.cycle(); f.tick('down'); f.safe(false); await f.cycle();
        const first = f.admissions[0];
        const reads = f.read.mock.calls.length;
        f.tick('up'); f.safe(true);
        await f.cycle(createHealthCheckSourceAdapter(f.now));
        expect(f.read).toHaveBeenCalledTimes(reads + 1);
        expect(f.admissions[1]).toMatchObject({ occurrenceId: first?.occurrenceId,
            occurredAt: first?.occurredAt, payload: first?.payload });
        expect(f.writes.at(-1)).not.toHaveProperty('pending');
        f.tick('up'); await f.cycle();
        expect(f.admissions.at(-1)?.payload).toMatchObject({ transition: 'recovered' });
    });

    it('discards an incomplete live failure streak when its watcher assignment is withdrawn', async () => {
        const f = fixture();
        await f.cycle();
        f.assign('other'); f.tick('down'); await f.cycle(); await f.retire();
        expect(f.read).toHaveBeenCalledTimes(1);
        f.assign(materialization.machineId); f.tick('down'); await f.cycle();
        expect(f.errors).toEqual([]);
        expect(f.admissions).toHaveLength(0);
        f.tick('down'); await f.cycle();
        expect(f.admissions).toHaveLength(1);
    });

    it.each([1, 3])('keeps first-ping and settled late checks quiet with threshold %i, using matching receipts and the exact age deadline', async (threshold) => {
        const f = fixture({ ...source, checks: [{ ...source.checks[0]!, checkId: 'heartbeat',
            kind: { pluginId: materialization.pluginId, localId: 'heartbeat' }, consecutiveFailuresBeforeAlerting: threshold,
            config: { webhookEndpointId: 'endpoint', graceMs: 200 } }] });
        let nextEligibleAt: number | null = null;
        let state: HealthCheckResultV1['status'] = 'unknown';
        f.read.mockImplementation(async () => [{ checkId: 'heartbeat', result: result(state, f.now()), nextEligibleAt }]);
        await f.cycle();
        for (let index = 0; index < 10; index++) { f.tick('unknown'); await f.cycle(); }
        expect(f.read).toHaveBeenCalledTimes(1);
        expect(f.admissions).toHaveLength(0);
        // The first unknown result is retained once; settled idle ticks publish nothing.
        expect(f.writes).toHaveLength(1);
        const wake = vi.fn(async () => {});
        const subscription = f.adapter.subscribeWake!(wake);
        try {
            const receipt = { sourceInstanceId: definition.sourceInstanceId, checkId: 'heartbeat',
                webhookEndpointId: 'endpoint', lastAcceptedAt: f.now() };
            await f.heartbeat({ ...receipt, checkId: 'another-check' });
            expect(wake).not.toHaveBeenCalled();
            state = 'up'; nextEligibleAt = f.now() + 1201;
            await f.heartbeat(receipt); await f.cycle();
            expect(wake).toHaveBeenCalledWith(definition.sourceInstanceId);
            expect(f.read).toHaveBeenCalledTimes(2);
            f.clock(nextEligibleAt - 1); await f.cycle();
            expect(f.read).toHaveBeenCalledTimes(2);
            f.clock(nextEligibleAt); state = 'down'; nextEligibleAt += 1000; await f.cycle();
            expect(f.read).toHaveBeenCalledTimes(3);
            for (let failure = 1; failure < threshold; failure++) {
                expect(f.admissions).toHaveLength(0);
                f.clock(nextEligibleAt); nextEligibleAt += 1000; await f.cycle();
            }
            expect(f.admissions).toHaveLength(1);
            for (let tick = 0; tick < 10; tick++) { f.clock(nextEligibleAt); nextEligibleAt += 1000; await f.cycle(); }
            expect(f.read).toHaveBeenCalledTimes(2 + threshold);
            expect(f.admissions).toHaveLength(1);
            expect(f.errors).toEqual([]);
        } finally { subscription.dispose(); }
    });

    it('re-reads a missed first receipt on reconnect while unrelated catalog invalidation stays quiet', async () => {
        const healthSource: HealthCheckSourceConfigV1 = { ...source, checks: [{ ...source.checks[0]!, checkId: 'heartbeat',
            kind: { pluginId: materialization.pluginId, localId: 'heartbeat' }, consecutiveFailuresBeforeAlerting: 1,
            config: { webhookEndpointId: 'endpoint', graceMs: 200 } }] };
        const f = fixture(healthSource);
        let acceptedAt: number | null = null;
        f.read.mockImplementation(async () => [{ checkId: 'heartbeat', ...readHeartbeatHealthCheckV1({
            observer: { machineId: materialization.machineId, installationId: 'installation' }, vantage: 'outside',
            periodMs: 1000, graceMs: 200, lastAcceptedAt: acceptedAt }, f.now()) }]);
        let observed!: () => void;
        const initialObservation = new Promise<void>(resolve => { observed = resolve; });
        // The SDK reports this public source status after committing its next
        // eligibility. Equal later statuses are intentionally not republished.
        f.onSourceReport(observed);
        const abort = new AbortController();
        const running = runCheckpointedPluginEventObserverV1({ context: { ...f.context, signal: abort.signal },
            source: f.adapter, now: f.now });
        try {
            await initialObservation;
            expect(f.read).toHaveBeenCalledTimes(1);
            await f.invalidate({});
            // All fixture host transports resolve immediately. Yield a turn so
            // the quiet catalog cycle settles without requiring a status write.
            await new Promise<void>(resolve => { setImmediate(resolve); });
            expect(f.read).toHaveBeenCalledTimes(1);
            // The first accepted ping arrived while this socket was disconnected;
            // reconnect carries the producer's reason, without replaying a ping.
            acceptedAt = f.now();
            // The authenticated provider wake settles after its finite cycle.
            await f.invalidate({ reason: 'reconnect' });
            expect(f.read).toHaveBeenCalledTimes(2);
            expect(f.admissions).toHaveLength(0);
        } finally {
            abort.abort();
            await running;
        }
    });

    it('keeps a receipt wake that arrives while its previous finite read is still in flight', async () => {
        const f = fixture({ ...source, checks: [{ ...source.checks[0]!, checkId: 'heartbeat',
            kind: { pluginId: materialization.pluginId, localId: 'heartbeat' }, consecutiveFailuresBeforeAlerting: 1,
            config: { webhookEndpointId: 'endpoint', graceMs: 200 } }] });
        const observation = (lastAcceptedAt: number | null) => ({ checkId: 'heartbeat', ...readHeartbeatHealthCheckV1({
            observer: { machineId: materialization.machineId, installationId: 'installation' }, vantage: 'outside',
            periodMs: 1000, graceMs: 200, lastAcceptedAt }, f.now()) });
        let release!: (results: Awaited<ReturnType<typeof f.read>>) => void;
        let started!: () => void;
        const reading = new Promise<void>(resolve => { started = resolve; });
        f.read.mockImplementation(async () => [observation(f.now())]);
        f.read.mockImplementationOnce(() => new Promise(resolve => { release = resolve; started(); }));
        const abort = new AbortController();
        const running = runCheckpointedPluginEventObserverV1({ context: { ...f.context, signal: abort.signal }, source: f.adapter, now: f.now });
        try {
            await reading;
            const delivered = f.heartbeat({ sourceInstanceId: definition.sourceInstanceId, checkId: 'heartbeat',
                webhookEndpointId: 'endpoint', lastAcceptedAt: f.now() });
            release([observation(null)]);
            await delivered;
            expect(f.read).toHaveBeenCalledTimes(2);
            expect(f.admissions).toHaveLength(0);
        } finally { abort.abort(); await running; }
    });

    it('parks a producer-declared terminal endpoint refusal, then observes a changed saved endpoint', async () => {
        const healthSource: HealthCheckSourceConfigV1 = { ...source, checks: [{ ...source.checks[0]!, checkId: 'heartbeat',
            kind: { pluginId: materialization.pluginId, localId: 'heartbeat' }, consecutiveFailuresBeforeAlerting: 1,
            config: { webhookEndpointId: 'endpoint', graceMs: 200 } }] };
        const f = fixture(healthSource);
        f.read.mockRejectedValueOnce(new PluginError({ code: 'endpoint_unavailable', retryable: false }));
        f.read.mockImplementation(async () => [{ checkId: 'heartbeat', ...readHeartbeatHealthCheckV1({
            observer: { machineId: materialization.machineId, installationId: 'installation' }, vantage: 'outside',
            periodMs: 1000, graceMs: 200, lastAcceptedAt: f.now() }, f.now()) }]);
        let report!: () => void;
        let reported = new Promise<void>(resolve => { report = resolve; });
        f.onSourceReport(() => report());
        const abort = new AbortController();
        const sleep = vi.fn(async (_delay: number, signal: AbortSignal) => new Promise<void>(resolve => {
            signal.addEventListener('abort', () => resolve(), { once: true });
        }));
        const running = runCheckpointedPluginEventObserverV1({ context: { ...f.context, signal: abort.signal }, source: f.adapter, now: f.now, sleep });
        try {
            await reported;
            await new Promise<void>(resolve => setImmediate(resolve));
            expect(sleep).not.toHaveBeenCalled();
            f.clock(f.now() + 10_000);
            expect(f.read).toHaveBeenCalledTimes(1);
            reported = new Promise<void>(resolve => { report = resolve; });
            f.configure({ ...healthSource, checks: [{ ...healthSource.checks[0]!, config: { webhookEndpointId: 'replacement', graceMs: 200 } }] });
            await f.invalidate({}); await reported;
            expect(f.read).toHaveBeenCalledTimes(2);
            expect(f.admissions).toHaveLength(0);
            expect(f.adapter.retryAt({ error: new Error('native transport unavailable'), now: f.now(),
                definition: { ...definition, sourceConfig: healthSource } })).toBe(f.now() + 1000);
        } finally { abort.abort(); await running; }
    });
});


it('retains current results before alert admission and only publishes semantic changes', async () => {
    const f = fixture();
    await f.cycle();
    expect(f.writes.at(-1)).toMatchObject({ current: { members: [{ automationId: definition.automationId,
        triggerId: 'health-trigger-0', triggerRevision: 1, sourceSelectorId: definition.sourceSelectorId }],
        checks: [{ checkId: 'http', result: { status: 'down', observedAt: 1000 } }] } });
    const afterFirst = f.writes.length;
    f.tick('down'); await f.cycle();
    // A second failure crosses the alert threshold. Each new sample also
    // advances the retained uptime counts (owner decision 3, 2026-11-13).
    const afterAdmission = f.writes.length;
    expect(afterAdmission).toBeGreaterThanOrEqual(afterFirst);
    f.tick('down'); await f.cycle();
    expect(f.writes).toHaveLength(afterAdmission + 1);
    f.tick('unknown'); await f.cycle();
    expect(f.writes).toHaveLength(afterAdmission + 2);
    expect(f.writes.at(-1)).toMatchObject({ current: { checks: [{ checkId: 'http', result: { status: 'unknown' } }] } });
});


it('publishes changed individual checks while the aggregate remains failing', async () => {
    const multiple = { ...source, checks: [source.checks[0]!, { ...source.checks[0]!, checkId: 'tcp' }] };
    const f = fixture(multiple);
    f.read.mockImplementation(async () => [{ checkId: 'http', result: result('down', 1000) }, { checkId: 'tcp', result: result('up', 1000) }]);
    await f.cycle();
    f.tick('down');
    f.read.mockImplementation(async () => [{ checkId: 'http', result: result('up', 2000) }, { checkId: 'tcp', result: result('down', 2000) }]);
    await f.cycle();
    expect(f.errors).toEqual([]);
    expect(f.writes.at(-1)).toMatchObject({ current: { checks: [
        { checkId: 'http', result: { status: 'up', observedAt: 2000 } },
        { checkId: 'tcp', result: { status: 'down', observedAt: 2000 } },
    ] } });
});
