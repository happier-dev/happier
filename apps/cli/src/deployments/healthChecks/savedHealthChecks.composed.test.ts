import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir } from '@/testkit/fs/tempDir';
import { reloadConfiguration } from '@/configuration';
import { addServerProfile, adoptServerProfileHomeConnectionDescriptor, resolveServerProfileHomeIdentityId } from '@/server/serverProfiles';
import { Resolver } from 'node:dns/promises';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import type { ActionsService } from '@happier-dev/plugin-sdk/actions';
import type { HttpService } from '@happier-dev/plugin-sdk/http';
import type { HealthCheckSourceConfigV1, JsonValue } from '@happier-dev/plugin-sdk';
import type { AccountKvEntry, AccountKvService } from '@happier-dev/plugin-sdk/storage';
import { runCheckpointedPluginEventObserverV1, type BackgroundServiceContext } from '@happier-dev/plugin-sdk/background-services';
import { AutomationEventAdmitInputV1Schema } from '@happier-dev/protocol/automations/automationActionSpecsV1';
import { createHealthCheckSourceAdapter } from '../../../../../packages/plugins/machine-services/src/healthObserver';
import { MachineServicesDetailResultV1Schema, sealAutomationTriggerDefinitionStoredEnvelopeV1,
    createActionExecutor, type AutomationEventStoredDefinitionProjectionV1 } from '@happier-dev/protocol';
import { createAutomationEventAdoptedDefinitionSetHostV1 } from '@/plugins/runtime/automations/automationEventAdoptedDefinitionSetHost';
import type { PluginInvocationServicesSeed } from '@/plugins/runtime/invocation/services/types';
import { createSavedHealthChecksHost, type SavedMachineServiceHealthResult } from './savedHealthChecks';
import { publishSavedServiceHealthResult } from './publishServiceHealth';
import { readAdoptedHealthCheckBatch } from './readAdoptedHealthCheckBatch';
import { createCurrentDomainEdgeObservation } from './currentDomainEdgeObservation';
import { createDeploymentEnvironmentHeaderV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { createPluginHttpService } from '@/plugins/runtime/fetch/service';
import { createGlobalFetchRuntime } from '@/plugins/runtime/fetch/globalFetchRuntime';
import { createPluginInvocationActionsService } from '@/plugins/runtime/invocation/services/actions';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { createDaemonDeploymentActionDeps } from '@/deployments/createDaemonDeploymentActionDeps';
import { createCredentialedAccountArtifactStore } from '@/api/artifacts/accountArtifactStore';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createDeploymentSocketHome } from '../../../../server/sources/testkit/deploymentSocketHome.testkit.mjs';
import { db } from '../../../../server/sources/storage/db';
import { inTx } from '../../../../server/sources/storage/inTx';
import { auth } from '../../../../server/sources/app/auth/auth';
import { createProjectSourceInTx } from '../../../../server/sources/app/projects/sources/projectSourceService';
import { makeShareEligibleForTest } from '../../../../server/sources/testkit/shareEligibility.testkit';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { monitorDefinitions } from '../../../../../packages/plugins/machine-services/src/monitorDefinitions';

async function adopted(sourceConfig: HealthCheckSourceConfigV1, observerMachineId = 'subject') {
    const caller = { pluginId: 'happier.machine.services', machineId: observerMachineId, materializationId: 'installed' };
    const abort = new AbortController();
    const invocationAbort = new AbortController();
    const eventRef = { pluginId: caller.pluginId, localId: 'health-status' };
    const binding = { v: 1 as const, automationId: 'automation', triggerId: 'trigger', triggerRevision: 1,
        triggerKind: 'pluginEvent' as const, eventRef, sourceSelectorId: '11111111-1111-4111-8111-111111111111' };
    const stored: AutomationEventStoredDefinitionProjectionV1 = {
        automationId: binding.automationId, triggerId: binding.triggerId, triggerRevision: 1, eventRef,
        sourceSelectorId: binding.sourceSelectorId, sourceContractVersion: 1,
        observationTransport: { kind: 'checkpointedPull', watcherMaterializationRef: caller }, payloadSchema: { type: 'object' },
        storedDefinitionEnvelope: sealAutomationTriggerDefinitionStoredEnvelopeV1({ mode: 'plain', binding,
            definition: { v: 1, sourceInstanceId: 'health:subject', sourceConfig, displayLabel: 'Service checks',
                filter: null, maximumObservationAgeMs: null } }),
    };
    const sourceCustody = { kind: 'managed' as const, immutableGenerationId: 'generation', installSource: 'archive' as const };
    const readStoredDefinitions = vi.fn(async () => ({ kind: 'page', revision: '1', definitions: [stored], nextCursor: null,
        eventDeclarationRelease: { release: { pluginId: caller.pluginId, version: '0.0.0' }, archiveDigestSha256: `sha256:${'a'.repeat(64)}` } }));
    const owner = createAutomationEventAdoptedDefinitionSetHostV1({
        credentials: { token: 'fixture-token', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
        caller, occurrenceId: 'occurrence', sourceCustody, transport: { kind: 'checkpointedPull' }, occurrenceSignal: abort.signal,
        isOccurrenceCurrent: () => true, revalidateCallerMaterialization: async () => true, revalidateCallerOccurrence: async () => true,
        resolveAccountEncryptionCurrentness: async () => ({ mode: 'plain', version: 1, signingKeyFingerprint: 'aemk1_signing',
            contentKeyFingerprint: null, updatedAt: 1, recipientEnvelopeReadiness: { status: 'unavailable', reason: 'plain_account' } }),
        resolveAccountEncryptionMaterial: async () => null,
        readStoredDefinitions,
    });
    expect(await owner.refresh()).toEqual({ kind: 'adopted', revision: '1' });
    const seed: PluginInvocationServicesSeed = { plugin: { id: caller.pluginId, version: '0.0.0' },
        contribution: { id: 'health-observer', qualifiedId: `${caller.pluginId}/backgroundServices/health-observer` },
        occurrenceId: 'occurrence', sourceCustody, correlationId: 'correlation', surface: 'background', signal: invocationAbort.signal,
        retirementSignal: abort.signal,
        resolveCurrentPluginMaterializationRef: () => caller, isOccurrenceCurrent: () => true };
    return { seed, owner, abort, invocationAbort, readStoredDefinitions, observer: { machineId: observerMachineId, installationId: 'installation' } };
}

const definition = (kind: string, config: HealthCheckSourceConfigV1['checks'][number]['config']) => ({
    checkId: kind, kind: { pluginId: 'happier.machine.services', localId: kind }, binding: { kind: 'healthCheck' as const },
    config, periodMs: 1000, consecutiveFailuresBeforeAlerting: 1,
});

describe('saved source finite native producer binding', () => {
    it('enrolls a selected monitor handler and stores only its endpoint identity on the admitted mapping', async () => {
        const sourceConfig: HealthCheckSourceConfigV1 = { v: 1,
            subject: { kind: 'machineService', machineId: 'subject', serviceId: 'service' },
            checks: [definition('uptime-kuma', { monitorId: '7' })] };
        const f = await adopted(sourceConfig);
        const enroll = vi.fn(async () => ({ webhookEndpointId: 'wh_ep_AAAAAAAAAAAAAAAAAAAAAA' }));
        const service = createSavedHealthChecksHost({ serverId: 'server', homeServerIdentityId: 'server', resolveAdoptedDefinitionSet: () => f.owner,
            readObserver: () => f.observer, openDomainArtifact: async () => null, now: () => 400,
            readKinds: () => [{ pluginId: f.seed.plugin.id, id: 'uptime-kuma', title: 'Uptime Kuma',
                action: 'health/uptime-kuma', configSchema: monitorDefinitions['uptime-kuma'].configSchema.jsonSchema }],
            enrollHeartbeat: enroll,
        }).bind(f.seed, { actions: { execute: vi.fn() } as unknown as ActionsService, http: {} as HttpService })!;
        const request = { sourceInstanceId: 'health:subject', sourceConfig, heartbeatContributionId: 'health-heartbeat',
            capabilityWebhookContributions: { 'uptime-kuma': 'health-uptime-kuma' } };
        const saved = await service.setup(request);
        expect(saved.checks[0]?.config).toEqual({ monitorId: '7', webhookEndpointId: 'wh_ep_AAAAAAAAAAAAAAAAAAAAAA', observingSince: 400 });
        expect(enroll).toHaveBeenCalledWith(expect.objectContaining({ checkId: 'uptime-kuma',
            heartbeatContributionId: 'health-uptime-kuma' }), expect.any(AbortSignal));
    });
    it('admits a source-local automatic investigation against the live Triage catalog when saving', async () => {
        const sourceConfig: HealthCheckSourceConfigV1 = { v: 1,
            subject: { kind: 'machineService', machineId: 'subject', serviceId: 'service' },
            checks: [definition('tcp', { host: '127.0.0.1', port: 80 })] };
        const f = await adopted(sourceConfig);
        let available = false;
        const execute = vi.fn(async () => ({ v: 1, kind: 'choices', defaultActionId: null,
            actions: available ? [{ label: 'Investigate production', selection: { configuredActionId: 'investigate-production',
                sessionChoice: { kind: 'configured' }, agentChoice: { kind: 'configured' }, delivery: 'configured' } }] : [] }));
        const service = createSavedHealthChecksHost({ serverId: 'server', homeServerIdentityId: 'server', resolveAdoptedDefinitionSet: () => f.owner,
            readObserver: () => f.observer, openDomainArtifact: async () => null,
        }).bind(f.seed, { actions: { execute } as unknown as ActionsService, http: {} as HttpService })!;
        await expect(service.setup({ sourceInstanceId: 'health:subject', sourceConfig,
            heartbeatContributionId: 'health-heartbeat' })).resolves.toEqual(sourceConfig);
        expect(execute).not.toHaveBeenCalled();
        const automatic = { ...sourceConfig, investigation: { mode: 'auto_start' as const, configuredActionId: 'investigate-production' } };
        await expect(service.setup({ sourceInstanceId: 'health:subject', sourceConfig: automatic,
            heartbeatContributionId: 'health-heartbeat' })).rejects.toMatchObject({ code: 'health_check_investigation_unavailable' });
        available = true;
        await expect(service.setup({ sourceInstanceId: 'health:subject', sourceConfig: automatic,
            heartbeatContributionId: 'health-heartbeat' })).resolves.toEqual(automatic);
    });
    it('dispatches a contributed check on its saved observer even when the Environment app has another controller', async () => {
        const environment = createDeploymentEnvironmentHeaderV1({ id: 'environment', serverId: 'server', controllerMachineId: 'app-machine' });
        const kind = { pluginId: 'com.example.health', localId: 'external-health' };
        const sourceConfig: HealthCheckSourceConfigV1 = { v: 1,
            subject: { kind: 'environment', environmentId: environment.id },
            checks: [{ ...definition('external', { monitorId: 'service-a' }), kind }] };
        const f = await adopted(sourceConfig, 'observer');
        const observed = { status: 'up' as const, observedAt: 1000,
            evidence: { v: 1 as const, items: [{ source: { kind: 'alert' as const, label: 'External monitor' },
                author: { kind: 'process' as const }, text: 'Healthy' }] } };
        const configSchema = { type: 'object' as const, additionalProperties: false,
            properties: { monitorId: { type: 'string' as const } }, required: ['monitorId'] };
        const host = createSavedHealthChecksHost({ serverId: 'server', homeServerIdentityId: 'server', resolveAdoptedDefinitionSet: (caller, occurrence) =>
            caller.pluginId === f.seed.plugin.id && occurrence === f.seed.occurrenceId ? f.owner : null,
            readObserver: () => f.observer, openDomainArtifact: async () => null,
            resolveSourceOwner: () => ({ caller: f.seed.resolveCurrentPluginMaterializationRef!()!, occurrenceId: f.seed.occurrenceId }),
            readKinds: () => [{ pluginId: kind.pluginId, id: kind.localId, title: 'External health', action: 'observe-health', configSchema }],
        });
        // Contributed Action transport is the external plugin boundary. Its
        // producer reads the real adopted source through the host-stamped caller.
        const execute = vi.fn(async (action: unknown, value: unknown) => {
            if (action === 'deployments.environments.get') return { ok: true, environment, targetLinks: [] };
            expect(action).toEqual({ pluginId: kind.pluginId, localId: 'observe-health' });
            expect(value).toEqual({ sourceInstanceId: 'health:subject', checkId: 'external' });
            const producer = host.bind({ ...f.seed, plugin: { id: kind.pluginId, version: '1.0.0' },
                contribution: { id: 'observe-health', qualifiedId: `${kind.pluginId}/actions/observe-health` },
                resolveCurrentPluginMaterializationRef: () => ({ pluginId: kind.pluginId,
                    machineId: 'observer', materializationId: 'external' }),
                caller: { kind: 'plugin', pluginId: f.seed.plugin.id, occurrenceId: f.seed.occurrenceId,
                    contribution: f.seed.contribution, sourceCustody: f.seed.sourceCustody!,
                    materialization: f.seed.resolveCurrentPluginMaterializationRef!()! },
            }, { actions: { execute } as unknown as ActionsService, http: {} as HttpService })!;
            const saved = await producer.readSource({ sourceInstanceId: 'health:subject' });
            expect(saved).toEqual(sourceConfig);
            return observed;
        });
        const service = host.bind(f.seed, { actions: { execute } as unknown as ActionsService, http: {} as HttpService })!;
        expect(await service.read({ sourceInstanceId: 'health:subject', checkIds: ['external'] }))
            .toEqual([{ checkId: 'external', result: observed }]);
        expect(f.readStoredDefinitions).toHaveBeenCalledTimes(1);
        await expect(service.read({ sourceInstanceId: 'health:subject', checkIds: ['missing'] }))
            .rejects.toMatchObject({ code: 'health_check_kind_unavailable' });
    });

    it('executes generic Environment endpoint checks from its controller without a Domain or watched service', async () => {
        const environment = createDeploymentEnvironmentHeaderV1({ id: 'environment', serverId: 'server', controllerMachineId: 'observer' });
        const server = createServer(socket => socket.end());
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('TCP listener required');
        const dns = vi.spyOn(Resolver.prototype, 'resolve').mockResolvedValue(['192.0.2.1']);
        try {
            const sourceConfig: HealthCheckSourceConfigV1 = { v: 1, subject: { kind: 'environment', environmentId: environment.id }, checks: [
                definition('http', { endpoint: 'https://app.example.test/ready', expectStatus: 204 }),
                definition('certificate', { endpoint: 'https://app.example.test/ready', expectStatus: 204 }),
                definition('tcp', { host: '127.0.0.1', port: address.port }),
                definition('dns', { hostname: 'app.example.test', recordType: 'A', expectedAnswer: '192.0.2.1' }),
            ] };
            const f = await adopted(sourceConfig, 'observer');
            // Environment admission, HTTP transport and DNS are external boundaries;
            // adopted config, selector binding and all finite producers remain real.
            const execute = vi.fn(async (id: string) => {
                expect(id).toBe('deployments.environments.get');
                return { ok: true as const, environment, targetLinks: [] };
            });
            const http = { requestStream: async () => ({ status: 204, finalUrl: 'https://app.example.test/ready', headers: {},
                chunks: (async function* () {})(), dispose: async () => {} }),
                request: async () => ({ status: 204, finalUrl: 'https://app.example.test/ready', headers: {}, body: new Uint8Array(),
                    tlsPeer: { url: 'https://app.example.test/ready', notBefore: 0, notAfter: 5000, fingerprint256: 'aa' } }),
            } as unknown as HttpService;
            const service = createSavedHealthChecksHost({ serverId: 'server', homeServerIdentityId: 'server', resolveAdoptedDefinitionSet: () => f.owner,
                readObserver: () => f.observer, now: () => 1000,
                openDomainArtifact: async () => { throw new Error('Generic checks have no Domain'); },
            }).bind(f.seed, { actions: { execute } as unknown as ActionsService, http })!;
            const results = await service.read({ sourceInstanceId: 'health:subject', checkIds: ['http', 'certificate', 'tcp', 'dns'] });
            expect(results.map(value => [value.checkId, value.result.status])).toEqual([
                ['http', 'up'], ['certificate', 'up'], ['tcp', 'up'], ['dns', 'up'],
            ]);
            expect(execute).toHaveBeenCalledTimes(1);
            expect(f.readStoredDefinitions).toHaveBeenCalledTimes(1);
            expect(results.every(value => value.result.cause?.vantage === 'sameMachine')).toBe(true);
            expect(JSON.stringify(results)).not.toContain('app.example.test');
        } finally { dns.mockRestore(); await new Promise<void>(resolve => server.close(() => resolve())); }
    });

    it('withdraws retained service health when its observer occurrence retires', async () => {
        const runtime = await createAdmittedPluginRuntimeFixture({ controller: pluginReloadController, runtimeOptions: { pluginIds: [] } });
        const sourceConfig: HealthCheckSourceConfigV1 = { v: 1,
            subject: { kind: 'machineService', machineId: 'subject', serviceId: 'service' },
            checks: [definition('http', { endpoint: 'http://127.0.0.1:40797', expectStatus: 200 })] };
        const f = await adopted(sourceConfig);
        const owner = runtime.registry.projectManagedServices;
        let nativeAvailable = true;
        let phase: 'running' | 'stopped' = 'running';
        const handle = await owner.superviseMachine({ serverId: 'server', machineId: 'subject',
            watch: { v: 1, watchId: 'service', name: 'Retained service',
                adapter: { pluginId: 'happier.machine.services', localId: 'systemd' },
                nativeResourceId: 'user/retained.service', lifecyclePurpose: 'development' },
            isCurrent: () => true, releaseObservation: async () => {}, lifecycle: {
                async inspect() {
                    return { phase: nativeAvailable ? phase : 'unknown', readiness: 'not_reported', endpoint: null };
                },
                async stop() { return { status: 'stopped' }; },
            } });
        const serviceFor = (adoption: typeof f) => createSavedHealthChecksHost({ serverId: 'server', homeServerIdentityId: 'server', resolveAdoptedDefinitionSet: () => adoption.owner,
            readObserver: () => adoption.observer, now: () => 1000, openDomainArtifact: async () => null,
            onServiceResult: value => publishSavedServiceHealthResult(owner, value),
        }).bind(adoption.seed, { actions: {
            execute: async () => ({ kind: 'service', service: owner.machineServiceRows.read(handle) }),
        } as unknown as ActionsService, http: { requestStream: async () => ({ status: 200,
            finalUrl: 'http://127.0.0.1:40797', headers: {}, chunks: (async function* () {})(), dispose: async () => {} }),
        } as unknown as HttpService });
        try {
            await serviceFor(f)!.read({ sourceInstanceId: 'health:subject', checkIds: ['http'] });
            expect(owner.machineServiceRows.read(handle).health?.status).toBe('up');
            nativeAvailable = false;
            await handle.inspectCurrentOccurrence();
            expect(handle.readNativeRuntimeFacts().freshness).toBe('unavailable');
            expect(owner.machineServiceRows.read(handle).health).toMatchObject({ status: 'up', freshness: 'current' });
            nativeAvailable = true; phase = 'stopped';
            await handle.inspectCurrentOccurrence();
            expect(owner.machineServiceRows.read(handle).health?.status).toBe('down');
            phase = 'running'; await handle.inspectCurrentOccurrence();
            expect(owner.machineServiceRows.read(handle).health?.status).toBe('up');
            f.invocationAbort.abort();
            expect(owner.machineServiceRows.read(handle).health?.status).toBe('up');
            const replacement = await adopted(sourceConfig);
            await serviceFor(replacement)!.read({ sourceInstanceId: 'health:subject', checkIds: ['http'] });
            f.abort.abort();
            expect(owner.machineServiceRows.read(handle).health?.status).toBe('up');
            replacement.abort.abort();
            expect(handle.isCurrent()).toBe(true);
            expect(owner.machineServiceRows.read(handle).health?.status).toBe('unknown');
        } finally { await handle.dispose(); await runtime.dispose(); }
    });

    it.each(['unsettled', 'waitingApproval'] as const)('publishes saved HTTP recovery while Event admission is %s without clock-only pushes', async admissionState => {
        const env = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_ACTIVE_SERVER_ID', 'HAPPIER_SERVER_URL', 'HAPPIER_WEBAPP_URL']);
        try {
            await withTempDir('happier-saved-service-health-home-', async homeDir => {
                env.patch({ HAPPIER_HOME_DIR: homeDir, HAPPIER_ACTIVE_SERVER_ID: undefined,
                    HAPPIER_SERVER_URL: undefined, HAPPIER_WEBAPP_URL: undefined });
                reloadConfiguration();
                const serverUrl = 'https://health-home.example.test';
                const profile = await addServerProfile({ name: 'saved-health', serverUrl, webappUrl: serverUrl });
                const homeId = 'srv_niq7wbpMyJviL4EtO5YlTEd0Us0Ou0nN';
                await adoptServerProfileHomeConnectionDescriptor({ expectedProfileId: profile.id, observation: 'exact',
                    descriptor: { v: 1, homeServerIdentityId: homeId, canonicalServerUrl: serverUrl,
                        revision: 1, endpoints: [{ kind: 'https', url: serverUrl }] } });
                expect(profile.id).not.toBe(homeId);
                const runtime = await createAdmittedPluginRuntimeFixture({ controller: pluginReloadController, runtimeOptions: { pluginIds: [] } });
                const machineId = 'eadc2422-b42b-478d-97b1-af9b530d5f08';
                const serviceId = '6d6375ac-3a3c-4d1a-bf45-6af1f3dba203';
                const sourceConfig: HealthCheckSourceConfigV1 = { v: 1, subject: { kind: 'machineService', machineId, serviceId },
                    checks: [{ checkId: 'http', kind: { pluginId: 'happier.machine.services', localId: 'http' },
                        binding: { kind: 'healthCheck' }, config: { endpoint: 'http://127.0.0.1:40797', expectStatus: 200 },
                        periodMs: 60000, consecutiveFailuresBeforeAlerting: 2 }] };
                const f = await adopted(sourceConfig, machineId);
                const owner = runtime.registry.projectManagedServices;
                let nativePhase: 'running' | 'stopped' = 'running';
                const handle = await owner.superviseMachine({ serverId: homeId, machineId,
                    watch: { v: 1, watchId: serviceId, name: 'QA-HEALTH-PUBLISH-1109-http.service',
                        adapter: { pluginId: 'happier.machine.services', localId: 'systemd' },
                        nativeResourceId: 'user/QA-HEALTH-PUBLISH-1109-http.service', lifecyclePurpose: 'development' },
                    isCurrent: () => true, releaseObservation: async () => {}, lifecycle: {
                        async inspect() { return { phase: nativePhase, readiness: 'not_reported', endpoint: null }; },
                        async stop() { return { status: 'stopped' }; },
                    } });
                let status = 200;
                let now = 1000;
                const changes: unknown[] = [];
                const subscription = owner.machineServiceRows.subscribe(machineId, [handle], change => changes.push(change.row?.health));
                const published: SavedMachineServiceHealthResult[] = [];
                const service = createSavedHealthChecksHost({ serverId: profile.id, homeServerIdentityId: await resolveServerProfileHomeIdentityId(profile.id), resolveAdoptedDefinitionSet: () => f.owner,
                    readObserver: () => f.observer, now: () => now, openDomainArtifact: async () => null,
                    onServiceResult: async value => { await publishSavedServiceHealthResult(owner, value); published.push(value); },
                }).bind(f.seed, { actions: { execute: async () => ({ kind: 'service', service: owner.machineServiceRows.read(handle) }) } as unknown as ActionsService,
                    http: { requestStream: async () => ({ status, finalUrl: 'http://127.0.0.1:40797', headers: {},
                        chunks: (async function* () {})(), dispose: async () => {} }) } as unknown as HttpService });
                let observer: Promise<void> | undefined;
                let releaseProbe: (() => void) | undefined;
                let approve: (() => void) | undefined;
                const approval = new Promise<void>(resolve => { approve = resolve; });
                try {
                    let admissionSettles = false;
                    const admissions: ReturnType<typeof AutomationEventAdmitInputV1Schema.parse>[] = [];
                    const cursors = new Map<string, AccountKvEntry>();
                    const kv = {
                        async get(key: string) { return cursors.get(key) ?? null; },
                        async set(key: string, value: JsonValue, options: { expectedVersion: number | 'absent' }) {
                            const previous = cursors.get(key);
                            if ((previous?.version ?? 'absent') !== options.expectedVersion) throw new Error('CAS conflict');
                            const version = (previous?.version ?? 0) + 1;
                            cursors.set(key, { version, value }); return { version };
                        },
                    };
                    // Account storage and Action IPC are plugin host boundaries;
                    // the SDK runner, saved check, publisher and row owner are real.
                    const context = { ...f.seed, materialization: f.seed.resolveCurrentPluginMaterializationRef!(),
                        services: { healthChecks: service, storage: { account: { kv: kv as AccountKvService } },
                            actions: { async execute(id: string, input: unknown) {
                                if (id === 'automation.event.sources.list') {
                                    const projection = f.owner.readPublicProjection();
                                    if (projection.kind !== 'available') throw new Error('Fixture adoption is unavailable');
                                    return { ...projection, kind: 'page', nextCursor: null };
                                }
                                if (id === 'automation.event.source.status.report') return { kind: 'reported' };
                                if (id === 'automation.event.admit') {
                                    const request = AutomationEventAdmitInputV1Schema.parse(input);
                                    admissions.push(request);
                                    if (admissionState === 'waitingApproval' && !admissionSettles) await approval;
                                    return { results: admissionSettles ? request.definitions.map(() => ({
                                        kind: 'admitted', checkpointSafe: true, runId: 'run',
                                    })) : [] };
                                }
                                throw new Error(`Unexpected host Action ${id}`);
                            } }, events: { host: { subscribe: () => ({ dispose() {} }) } } },
                    } as unknown as BackgroundServiceContext;
                    const adapter = createHealthCheckSourceAdapter(() => now);
                    const read = async () => {
                        if (admissionState === 'unsettled') {
                            await runCheckpointedPluginEventObserverV1({ context, source: adapter, mode: 'once', now: () => now });
                            return;
                        }
                        // The real retained Action waits for its one approval. A
                        // boundary-held Promise must not stop the chosen probe period.
                        if (observer === undefined) {
                            observer = runCheckpointedPluginEventObserverV1({ context, source: adapter, now: () => now,
                                sleep: (_delay, signal) => new Promise<void>(resolve => {
                                    const done = () => { signal.removeEventListener('abort', done); releaseProbe = undefined; resolve(); };
                                    releaseProbe = done;
                                    signal.addEventListener('abort', done, { once: true });
                                    if (signal.aborted) done();
                                }) });
                            void observer.catch(() => {});
                        } else releaseProbe?.();
                        await vi.waitFor(() => expect(published.at(-1)?.result.observedAt).toBe(now));
                    };
                    await read();
                    expect(owner.machineServiceRows.read(handle).health).toMatchObject({ status: 'up', freshness: 'current', observedAtMs: 1000 });
                    expect(changes).toHaveLength(1);
                    now += 60000; await read(); await handle.inspectCurrentOccurrence();
                    expect(owner.machineServiceRows.read(handle).health?.status).toBe('up');
                    expect(changes).toHaveLength(1);
                    nativePhase = 'stopped'; await handle.inspectCurrentOccurrence();
                    status = 503; now += 60000; await read();
                    expect(owner.machineServiceRows.read(handle).health?.status).toBe('down');
                    expect(changes).toHaveLength(2);
                    now += 60000; await read();
                    const failed = admissions.at(-1);
                    expect(failed?.payload).toMatchObject({ transition: 'failed' });
                    await publishSavedServiceHealthResult(owner, { ...published[0]!, serverId: 'srv_unrelated_home' });
                    expect(owner.machineServiceRows.read(handle).health?.status).toBe('down');
                    expect(changes).toHaveLength(2);
                    nativePhase = 'running'; await handle.inspectCurrentOccurrence();
                    expect(owner.machineServiceRows.read(handle).health?.status).toBe('down');
                    const changesBeforeRecoveryProbe = changes.length;
                    status = 200; now += 60000; await read();
                    expect(owner.machineServiceRows.read(handle).health?.status).toBe('up');
                    expect(changes).toHaveLength(changesBeforeRecoveryProbe + 1);
                    expect(admissions.at(-1)).toMatchObject({ occurrenceId: failed?.occurrenceId,
                        occurredAt: failed?.occurredAt, payload: failed?.payload });
                    if (admissionState === 'waitingApproval') expect(admissions).toHaveLength(1);
                    admissionSettles = true; approve?.(); now += 60000; await read();
                    if (admissionState === 'unsettled') expect(admissions.at(-1)?.payload).toMatchObject({ transition: 'failed' });
                    else expect(admissions.filter(value => value.occurrenceId === failed?.occurrenceId)).toHaveLength(1);
                    now += 60000; await read();
                    expect(admissions.at(-1)?.payload).toMatchObject({ transition: 'recovered' });
                    const changesBeforeWithdrawal = changes.length;
                    const page = await f.readStoredDefinitions.mock.results[0]!.value;
                    f.readStoredDefinitions.mockResolvedValueOnce({ ...page, revision: '2', definitions: [] });
                    expect(await f.owner.refresh()).toEqual({ kind: 'adopted', revision: '2' });
                    owner.machineServiceRows.reconcileHealthResults(entry => readAdoptedHealthCheckBatch({
                        resolveAdoptedDefinitionSet: () => f.owner, caller: entry.caller, occurrenceId: entry.occurrenceId,
                        sourceInstanceId: entry.sourceInstanceId, signal: f.seed.signal,
                    }).kind === 'available');
                    expect(owner.machineServiceRows.read(handle).health?.status).toBe('unknown');
                    expect(changes).toHaveLength(changesBeforeWithdrawal + 1);
                } finally {
                    f.invocationAbort.abort(); approve?.(); releaseProbe?.();
                    await observer?.catch(error => { if (error !== f.seed.signal.reason) throw error; });
                    subscription.dispose(); await handle.dispose(); await runtime.dispose();
                }
            });
        } finally { env.restore(); reloadConfiguration(); }
    });

    it('reads an Environment heartbeat at its controller through the same saved source and exact receipt owner', async () => {
        const environment = createDeploymentEnvironmentHeaderV1({ id: 'environment', serverId: 'server', controllerMachineId: 'observer' });
        const sourceConfig: HealthCheckSourceConfigV1 = { v: 1, subject: { kind: 'environment', environmentId: environment.id },
            checks: [definition('heartbeat', { webhookEndpointId: 'wh_ep_AAAAAAAAAAAAAAAAAAAAAA', graceMs: 200 })] };
        const f = await adopted(sourceConfig, 'observer');
        let lastAcceptedAt: number | null = null;
        let time = 2200;
        const receipts = vi.fn(async () => ({ kind: 'ready' as const, lastAcceptedAt }));
        const execute = vi.fn(async () => ({ ok: true as const, environment, targetLinks: [] }));
        const host = createSavedHealthChecksHost({ serverId: 'server', homeServerIdentityId: 'server', resolveAdoptedDefinitionSet: () => f.owner,
            readObserver: () => f.observer, now: () => time, readHeartbeatReceipt: receipts,
            openDomainArtifact: async () => { throw new Error('Heartbeat has no Domain content'); } });
        const service = host.bind(f.seed, { actions: { execute } as unknown as ActionsService,
            http: { request: () => { throw new Error('Heartbeat does not probe'); } } as unknown as HttpService });
        expect(await service!.read({ sourceInstanceId: 'health:subject', checkIds: ['heartbeat'] }))
            .toMatchObject([{ checkId: 'heartbeat', result: { status: 'unknown' }, nextEligibleAt: null }]);
        lastAcceptedAt = 1000;
        expect(await service!.read({ sourceInstanceId: 'health:subject', checkIds: ['heartbeat'] }))
            .toMatchObject([{ result: { status: 'up' }, nextEligibleAt: 2201 }]);
        time = 2201;
        expect(await service!.read({ sourceInstanceId: 'health:subject', checkIds: ['heartbeat'] }))
            .toMatchObject([{ result: { status: 'down' } }]);
        expect(receipts).toHaveBeenLastCalledWith({ caller: f.seed.resolveCurrentPluginMaterializationRef!(),
            sourceInstanceId: 'health:subject', checkId: 'heartbeat', webhookEndpointId: 'wh_ep_AAAAAAAAAAAAAAAAAAAAAA' }, expect.any(AbortSignal));
        const other = await adopted(sourceConfig, 'other-controller');
        const retired = createSavedHealthChecksHost({ serverId: 'server', homeServerIdentityId: 'server', resolveAdoptedDefinitionSet: () => other.owner,
            readObserver: () => other.observer, readHeartbeatReceipt: receipts, openDomainArtifact: async () => null })
            .bind(other.seed, { actions: { execute } as unknown as ActionsService, http: {} as HttpService });
        await expect(retired!.read({ sourceInstanceId: 'health:subject', checkIds: ['heartbeat'] }))
            .rejects.toMatchObject({ code: 'health_check_subject_mismatch' });
        expect(receipts).toHaveBeenCalledTimes(3);
    });

    it.each(['http', 'certificate'] as const)('binds a finite saved %s Action to the current Domain and refuses another person before the network', async kind => {
        const env = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_ACTIVE_SERVER_ID', 'HAPPIER_SERVER_URL', 'HAPPIER_WEBAPP_URL']);
        await withTempDir('happier-saved-health-home-', async homeDir => {
            env.patch({ HAPPIER_HOME_DIR: homeDir, HAPPIER_ACTIVE_SERVER_ID: undefined,
                HAPPIER_SERVER_URL: undefined, HAPPIER_WEBAPP_URL: undefined });
            reloadConfiguration();
            const home = await createDeploymentSocketHome();
            try {
                const profile = await addServerProfile({ name: 'saved-health', serverUrl: home.baseUrl, webappUrl: home.baseUrl });
                await adoptServerProfileHomeConnectionDescriptor({ expectedProfileId: profile.id, observation: 'exact',
                    descriptor: { v: 1, homeServerIdentityId: home.serverId, canonicalServerUrl: home.baseUrl,
                        revision: 1, endpoints: [{ kind: 'https', url: home.baseUrl }] } });
                const requester = await db.account.create({ data: { encryptionMode: 'plain' } });
                const requesterToken = await auth.createToken(requester.id, undefined, { kind: 'account', authority: 'present_user',
                    authenticationEvidence: [{ kind: 'home_method', methodId: 'key_challenge' }] });
                await makeShareEligibleForTest(home.accountId, requester.id);
                const source = await inTx(tx => createProjectSourceInTx(tx, home.accountId, { serverId: home.serverId,
                    requestKey: randomUUID(), name: 'Saved Domain authority', audience: [
                        { principal: { kind: 'account', accountId: requester.id }, level: 'view' },
                    ] }));
                if (!source.ok) throw new Error(source.error);
                const environmentContent = await home.createContentArtifact({}, 'deployment-environment.v1');
                const targetContent = await home.createContentArtifact({}, 'deployment-target-link.v1');
                const ownerCredentials = { token: home.token, encryption: null };
                const artifacts = createCredentialedAccountArtifactStore(ownerCredentials);
                const domainArtifact = await runWithServerHttpBaseUrl(home.baseUrl, () => artifacts.create({
                    header: { kind: 'deployment-domain.v1', title: 'Saved Domain authority' },
                    body: JSON.stringify({ hostname: 'app.example.test', target: { service: 'web', containerPort: 3000 },
                        healthCheck: { path: '/ready', expectStatus: 204 } }),
                }));
                const domainContent = { contentArtifactId: domainArtifact.artifactId,
                    contentHeaderVersion: domainArtifact.revision.headerVersion,
                    contentBodyVersion: domainArtifact.revision.bodyVersion };
                await db.artifactGrant.createMany({ data: [environmentContent.contentArtifactId,
                    targetContent.contentArtifactId, domainContent.contentArtifactId].map(artifactId => ({ artifactId, principalKind: 'account',
                    accountId: requester.id, accessLevel: 'view', createdByAccountId: home.accountId })) });
                const environment = await db.deploymentEnvironment.create({ data: { projectSourceId: source.source.id,
                    createdByAccountId: home.accountId, protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers',
                    controllerMachineId: home.machineId, ...environmentContent } });
                const link = await db.deploymentTargetLink.create({ data: { environmentId: environment.id,
                    createdByAccountId: home.accountId, role: 'runtime', sourceKind: 'host', hostTargetId: 'own-server',
                    targetKind: 'ownServer', state: 'configured', ...targetContent,
                    machines: { create: { machineId: home.machineId, installationId: home.installationId,
                        position: 0, state: 'active' } } } });
                await db.deploymentEnvironment.update({ where: { id: environment.id },
                    data: { runtimeTargetLinkId: link.id } });
                const domain = await db.deploymentDomain.create({ data: { environmentId: environment.id, targetLinkId: link.id,
                    createdByAccountId: home.accountId, state: 'active', ...domainContent } });
                const sourceConfig: HealthCheckSourceConfigV1 = { v: 1,
                    subject: { kind: 'environment', environmentId: environment.id },
                    checks: [{ ...definition(kind, {}), binding: { kind: 'domain', domainId: domain.id,
                        targetLinkId: link.id, condition: 'domain_probe_failed' } }] };
                const f = await adopted(sourceConfig, home.machineId);
                const actionSeed: PluginInvocationServicesSeed = { ...f.seed, surface: 'cli',
                    approvalContext: { serverId: profile.id, serverIdentityId: home.serverId },
                    contribution: { id: `health/${kind}`, qualifiedId: `happier.machine.services/actions/health/${kind}` } };
                const requests: string[] = [];
                let expectedStatus = 204;
                const http = { request: vi.fn(async ({ url }: { url: string }) => {
                    requests.push(url);
                    return { status: expectedStatus, body: new Uint8Array(), finalUrl: url,
                        tlsPeer: { url, fingerprint256: 'AA:BB', notBefore: Date.now() - 60_000, notAfter: Date.now() + 60_000 } };
                }), requestStream: vi.fn(async ({ url }: { url: string }) => {
                    requests.push(url);
                    return { status: expectedStatus, finalUrl: url, headers: {},
                        chunks: (async function* () {})(), dispose: async () => {} };
                }) } as unknown as HttpService;
                const openDomainArtifact = vi.fn(async (artifactId: string, signal: AbortSignal) =>
                    await runWithServerHttpBaseUrl(home.baseUrl, () => artifacts.read(artifactId, {
                        signal, prepareRecipients: false, includeSharedAudience: false })));
                const currentDomain = createCurrentDomainEdgeObservation();
                const host = createSavedHealthChecksHost({ serverId: profile.id, homeServerIdentityId: await resolveServerProfileHomeIdentityId(profile.id),
                    resolveAdoptedDefinitionSet: () => f.owner, readObserver: () => f.observer, openDomainArtifact,
                    onDomainResult: value => currentDomain.publish(value) });
                const actionsFor = (token: string) => createPluginInvocationActionsService({ seed: actionSeed,
                    actionExecutor: createActionExecutor({ ...createUnavailableActionTransportDeps(),
                        ...createDaemonDeploymentActionDeps({ credentials: { token, encryption: null },
                            serverId: home.serverId, serverHttpBaseUrl: home.baseUrl, machineId: home.machineId,
                            resolveRequesterIdentity: async () => ({ kind: 'unknown', reason: 'requester_authority_unavailable' }),
                            runtime: { async acquire() { throw new Error('No native role in saved health admission'); } },
                        }),
                    }), invokeContributedAction: async () => { throw new Error('No contributed Action in saved health admission'); } });
                const ownerService = host.bind(actionSeed, { actions: actionsFor(home.token), http });
                if (!ownerService) throw new Error('Owner service must bind');
                expect(profile.id).not.toBe(home.serverId);
                expect(await ownerService.setup({ sourceInstanceId: 'health:subject', sourceConfig: {
                    ...sourceConfig, mode: 'preview', alerts: { channels: [], phases: ['open', 'recovered'] },
                } })).toMatchObject({ mode: 'preview', destinationSelectionContext: {
                    serverId: profile.id, machineId: home.machineId,
                } });
                await expect(ownerService.setup({ sourceInstanceId: 'health:subject', sourceConfig: {
                    ...sourceConfig, checks: [{ ...sourceConfig.checks[0]!, binding: { kind: 'domain',
                        domainId: 'not-deployed-domain', targetLinkId: link.id, condition: 'domain_probe_failed' } }],
                }, heartbeatContributionId: 'health-heartbeat' })).rejects.toMatchObject({
                    code: 'deployment_unavailable', details: { requiredFact: 'domainServingAddress',
                        remedy: expect.stringMatching(/deploy/i) },
                    data: { name: 'PluginError', code: 'deployment_unavailable',
                        details: { requiredFact: 'domainServingAddress', remedy: expect.stringMatching(/deploy/i) } },
                });
                expect(requests).toEqual([]);
                expect(await ownerService.setup({ sourceInstanceId: 'health:subject', sourceConfig,
                    heartbeatContributionId: 'health-heartbeat' })).toEqual(sourceConfig);
                await expect(ownerService.setup({ sourceInstanceId: 'health:subject', sourceConfig: {
                    ...sourceConfig, checks: [{ ...sourceConfig.checks[0]!, config: { endpoint: 'https://attacker.example', expectStatus: 200 } }],
                }, heartbeatContributionId: 'health-heartbeat' })).rejects.toMatchObject({ code: 'source_config_invalid' });
                const firstResult = (await ownerService.read({ sourceInstanceId: 'health:subject', checkIds: [kind] }))[0]?.result;
                expect(firstResult?.status).toBe('up');
                expect(firstResult?.cause?.vantage).toBe('sameMachine');
                expect(firstResult?.cause?.disclosure).toContain('checked from the server itself');
                expect(requests).toEqual(['https://app.example.test/ready']);
                const changedArtifact = await runWithServerHttpBaseUrl(home.baseUrl, () => artifacts.create({
                    header: { kind: 'deployment-domain.v1', title: 'Saved Domain authority' },
                    body: JSON.stringify({ hostname: 'app.example.test', target: { service: 'web', containerPort: 3000 },
                        healthCheck: { path: '/changed', expectStatus: 205 } }),
                }));
                await db.deploymentDomain.update({ where: { id: domain.id }, data: { revision: { increment: 1 },
                    contentArtifactId: changedArtifact.artifactId, contentHeaderVersion: changedArtifact.revision.headerVersion,
                    contentBodyVersion: changedArtifact.revision.bodyVersion } });
                expectedStatus = 205;
                expect((await ownerService.read({ sourceInstanceId: 'health:subject', checkIds: [kind] }))[0]?.result.status).toBe('up');
                expect(requests).toEqual(['https://app.example.test/ready', 'https://app.example.test/changed']);
                const retained = currentDomain.readDomainProofs(environment.id, link.id)[0];
                expect(retained?.domainObservation).toMatchObject({ kind, domainId: domain.id,
                    domainRevision: domain.revision + 1, observerMachineId: home.machineId,
                    vantage: 'sameMachine', result: { status: 'up' } });
                const requesterService = host.bind(actionSeed, { actions: actionsFor(requesterToken), http });
                if (!requesterService) throw new Error('Requester service must bind');
                await expect(requesterService.setup({ sourceInstanceId: 'health:subject', sourceConfig,
                    heartbeatContributionId: 'health-heartbeat' })).rejects.toMatchObject({ code: 'deployment_access_denied' });
                await expect(requesterService.read({ sourceInstanceId: 'health:subject', checkIds: [kind] }))
                    .rejects.toMatchObject({ code: 'deployment_access_denied' });
                expect(requests).toHaveLength(2);
                expect(openDomainArtifact).toHaveBeenCalledTimes(3);
                expect(currentDomain.readDomainProofs(environment.id, link.id)[0]).toBe(retained);
                const otherLink = await db.deploymentTargetLink.create({ data: { environmentId: environment.id,
                    createdByAccountId: home.accountId, role: 'data', sourceKind: 'plugin', pluginId: 'example.data',
                    contributionLocalId: 'database', targetKind: 'database', state: 'configured', ...targetContent } });
                await db.deploymentDomain.update({ where: { id: domain.id }, data: { targetLinkId: otherLink.id,
                    revision: { increment: 1 } } });
                await expect(ownerService.read({ sourceInstanceId: 'health:subject', checkIds: [kind] }))
                    .rejects.toMatchObject({ code: 'health_check_subject_mismatch' });
                expect(requests).toHaveLength(2);
                expect(openDomainArtifact).toHaveBeenCalledTimes(3);
            } finally {
                await home.close();
                env.restore();
                reloadConfiguration();
            }
        });
    }, 180_000);
    it('runs saved TCP/DNS/heartbeat selectors under one adopted source without another scan or Environment', async () => {
        let connections = 0;
        const server = createServer(socket => { connections += 1; socket.end(); });
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('TCP listener required');
        const dns = vi.spyOn(Resolver.prototype, 'resolve').mockResolvedValue(['192.0.2.1']);
        try {
            const sourceConfig: HealthCheckSourceConfigV1 = { v: 1, subject: { kind: 'machineService', machineId: 'subject', serviceId: 'service' },
                checks: [definition('tcp', { host: '127.0.0.1', port: address.port }),
                    definition('dns', { hostname: 'private.example.test', recordType: 'A', expectedAnswer: '192.0.2.1' }),
                    definition('heartbeat', { webhookEndpointId: 'endpoint', graceMs: 200 })] };
            const f = await adopted(sourceConfig);
            // Machine detail and heartbeat receipt are remote host boundaries;
            // source adoption/config admission and native producers remain real.
            const detail = MachineServicesDetailResultV1Schema.parse({ kind: 'service', service: {
                serviceId: 'service', name: 'Watched service', authority: 'machine', lifecyclePurpose: 'deployment',
                generation: 'generation', state: 'running', watchId: 'service', watchRevision: '1',
                native: { phase: 'running', readiness: 'not_reported' },
                nativeInstance: { adapter: { pluginId: 'happier.machine.services', localId: 'systemd' }, nativeResourceId: 'example.service' },
                capabilities: { start: true, stop: true, restart: true, logs: true, accounting: false },
            } });
            const execute = vi.fn(async () => detail);
            const actions = { execute } as unknown as ActionsService;
            const http = createPluginHttpService({ adapter: createGlobalFetchRuntime() });
            const receipts = vi.fn(async () => ({ kind: 'ready' as const, lastAcceptedAt: 1000 }));
            const host = createSavedHealthChecksHost({ serverId: 'server', homeServerIdentityId: 'server', resolveAdoptedDefinitionSet: () => f.owner,
                readObserver: () => f.observer, now: () => 2200, readHeartbeatReceipt: receipts,
                openDomainArtifact: async () => null });
            const service = host.bind(f.seed, { actions, http });
            expect(service).not.toBeNull();
            const results = await service!.read({ sourceInstanceId: 'health:subject', checkIds: ['tcp', 'dns', 'heartbeat'] });
            expect(results.map(value => value.result.status)).toEqual(['up', 'up', 'up']);
            expect(results[2]?.nextEligibleAt).toBe(2201);
            expect(f.readStoredDefinitions).toHaveBeenCalledTimes(1);
            expect(execute).toHaveBeenCalledTimes(1);
            expect(execute).toHaveBeenCalledWith('machines.services.detail', { serverId: 'server', machineId: 'subject', serviceId: 'service' },
                expect.objectContaining({ signal: expect.any(AbortSignal) }));
            expect(dns).toHaveBeenCalledWith('private.example.test', 'A');
            expect(JSON.stringify(results)).not.toContain('private.example.test');
            const remote = await adopted(sourceConfig, 'outside-observer');
            const remoteHost = createSavedHealthChecksHost({ serverId: 'server', homeServerIdentityId: 'server', resolveAdoptedDefinitionSet: () => remote.owner,
                readObserver: () => remote.observer, now: () => 2200, readHeartbeatReceipt: receipts,
                openDomainArtifact: async () => null }).bind(remote.seed, { actions, http });
            await expect(remoteHost!.read({ sourceInstanceId: 'health:subject', checkIds: ['tcp', 'dns', 'heartbeat'] }))
                .rejects.toMatchObject({ code: 'health_check_subject_mismatch' });
            expect(connections).toBe(1);
            expect(dns).toHaveBeenCalledTimes(1);
            expect(receipts).toHaveBeenCalledTimes(1);
        } finally {
            dns.mockRestore();
            await new Promise<void>(resolve => server.close(() => resolve()));
        }
    });
});
