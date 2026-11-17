import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createActionExecutor, arePluginMachineMaterializationRefsEqual, MachineServicesDiscoveryResultV1Schema, MachineServicesListResultV1Schema, type MachineMetadataFieldReadV1, type MachineMetadataFieldPortV1,
    PluginEventAutomationSetupResultV1Schema,
    ActionsSettingsV1Schema, setActionApprovalOverride } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { HEALTH_CHECK_EVENT_REFS_V1 } from '@happier-dev/protocol/deployments/healthCheckV1';
import { runCheckpointedPluginEventObserverV1, type BackgroundServiceContext } from '@happier-dev/plugin-sdk/background-services';
import type { AccountKvEntry, AccountKvService } from '@happier-dev/plugin-sdk/storage';
import type { HttpService } from '@happier-dev/plugin-sdk/http';
import { createDeploymentSocketHome } from '../../../../apps/server/sources/testkit/deploymentSocketHome.testkit.mjs';
import { registerAutomationV3Routes } from '../../../../apps/server/sources/app/api/routes/automations/registerAutomationV3Routes';
import { registerAutomationEventRoutes } from '../../../../apps/server/sources/app/api/routes/automations/registerAutomationEventRoutes';
import { db } from '../../../../apps/server/sources/storage/db';
import { plugin } from '../../../plugins/machine-services/src/manifest';
import { createHealthCheckSourceAdapter } from '../../../plugins/machine-services/src/healthObserver';
import { configuration, reloadConfiguration } from '../../../../apps/cli/src/configuration';
import { updateSettings } from '../../../../apps/cli/src/persistence';
import { readCurrentMachineInstallation } from '../../../../apps/cli/src/daemon/identity/currentMachineInstallation';
import { withTempDir } from '../../../../apps/cli/src/testkit/fs/tempDir';
import { createAdmittedPluginRuntimeFixture } from '../../../../apps/cli/src/plugins/testkit/admittedRuntime';
import { createActionSettingsProvider } from '../../../../apps/cli/src/settings/actionsSettingsProvider';
import { registerDaemonContributionRegistryProjectionHandler } from '../../../../apps/cli/src/rpc/handlers/daemonContributionRegistryProjection';
import type { RpcHandler } from '../../../../apps/cli/src/api/rpc/types';
import { createCliWorkflowTriggerActions } from '../../../../apps/cli/src/session/actions/workflowTriggers';
import { getAutomationDefinition } from '../../../../apps/cli/src/api/automations';
import { runWithServerHttpBaseUrl } from '../../../../apps/cli/src/api/client/serverHttpBaseUrl';
import { createAutomationEventAdoptedDefinitionSetHostV1, createAutomationEventStoredDefinitionsHttpTransportV1 } from '../../../../apps/cli/src/plugins/runtime/automations/automationEventAdoptedDefinitionSetHost';
import { createAutomationEventActionExecutor, type ResolveAutomationEventAdoptedDefinitionSetV1 } from '../../../../apps/cli/src/plugins/runtime/automations/automationEventActionExecutor';
import { createPluginInvocationActionsService } from '../../../../apps/cli/src/plugins/runtime/invocation/services/actions';
import type { PluginInvocationServicesSeed } from '../../../../apps/cli/src/plugins/runtime/invocation/services/types';
import { createSavedHealthChecksHost, type SavedMachineServiceHealthResult } from '../../../../apps/cli/src/deployments/healthChecks/savedHealthChecks';

import { createMachineContentCodec } from '../../../../apps/cli/src/api/machine/machineStoredContent';
import { pluginReloadController } from '../../../../apps/cli/src/plugins/runtime/reload/singleton';
import { createMachineServicesRuntime } from '../../../../apps/cli/src/daemon/local/services/launch/machineServices';
import { createUnavailablePluginServices } from '../../../../apps/cli/src/plugins/runtime/invocation/services/unavailable';
import { createStablePluginEventsBroker, createPluginInvocationHostEventsService } from '../../../../apps/cli/src/plugins/runtime/invocation/services/events';
import { createConfiguredHealthCheckNotices } from '../../../../apps/cli/src/deployments/deploymentServiceHealthNotices';
import { readConfiguredHealthResults, configuredHealthResultsForTrigger } from '../../../../apps/ui/sources/components/store/inventory/configuredHealthResults';

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); reloadConfiguration(); });

// Server identity belongs to this process even when each Account mode gets an isolated database.
const serverId = `srv_${randomUUID().replaceAll('-', '')}`;

it.skipIf(process.platform !== 'linux').each(['e2ee', 'plain'] as const)('%s: registers mounted Health on its installation and cold-adopts recovery into the same Notice; rejects a plugin ID as an installation', async encryptionMode => {
    await withTempDir('health-registration-', async happyHomeDir => {
        vi.stubEnv('HAPPIER_HOME_DIR', happyHomeDir);
        vi.stubEnv('HAPPIER_ACCOUNT_SETTINGS_MODE', 'never');
        vi.stubEnv('HAPPIER_ACTIONS_SETTINGS_V1', '');
        reloadConfiguration();
        const refusalBodies: unknown[] = [];
        const adoptionHttpFailures: unknown[] = [];
        const home = await createDeploymentSocketHome({ serverId, encryptionMode, prepareMachineContent: (key, metadata) => createMachineContentCodec({ encryptionMode: 'e2ee', encryptionKey: key, encryptionVariant: 'dataKey' }).encodeStored(metadata), configureApp(app) {
            registerAutomationV3Routes(app);
            registerAutomationEventRoutes(app);
            app.addHook('onSend', async (request, reply, payload) => {
                if (request.url === '/v3/automations' && reply.statusCode === 400 && typeof payload === 'string') {
                    refusalBodies.push(JSON.parse(payload));
                }
                if (request.url !== '/v3/automations' && reply.statusCode >= 400 && typeof payload === 'string') {
                    adoptionHttpFailures.push({ path: request.url, status: reply.statusCode, response: JSON.parse(payload) });
                }
                return payload;
            });
        } });
        let runtime: Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>> | undefined;
        const lifetime = new AbortController();
        let observerLifetime = new AbortController();
        let machineServices: ReturnType<typeof createMachineServicesRuntime> | undefined;
        try {
            // The already paired observer and installed declaration are preconditions.
            // Everything after setup, including registration and source adoption, uses public owners.
            await home.prepareControllerProvisioner(plugin.manifest);
            await updateSettings(settings => ({ ...settings, machineId: home.machineId,
                machineIdByServerId: { ...settings.machineIdByServerId, [configuration.activeServerId]: home.machineId } }));
            await mkdir(dirname(configuration.installationIdentityFile), { recursive: true });
            await writeFile(configuration.installationIdentityFile, JSON.stringify({ version: 1, createdAt: Date.now(),
                installationId: home.installationId, publicKey: Buffer.from(home.keys.publicKey).toString('base64url'),
                privateKey: Buffer.from(home.keys.secretKey).toString('base64url') }), { mode: 0o600 });
            const credentials = { token: home.token, encryption: home.encryption, credentialProvenance: 'stored_session' as const };
            const origin = { serverIdentityId: home.serverId, machineId: home.machineId };
            expect((await readCurrentMachineInstallation())?.machineId).toBe(home.machineId);
            const startRuntime = () => runWithServerHttpBaseUrl(home.baseUrl, () => createAdmittedPluginRuntimeFixture({ happyHomeDir, controller: pluginReloadController, runtimeOptions: {
                pluginIds: [plugin.manifest.id], resolveCurrentMachineId: () => home.machineId,
                externalActionHomeBinding: { serverId: home.serverId, serverIdentityId: home.serverId },
                resolveCurrentMachineExecutionOriginContext: async () => origin,
                scopedActionRuntime: { credentials, actionsSettingsProvider: createActionSettingsProvider({
                    getAccountSettings: () => null, allowEnvironmentOverride: false }) },
            } }));
            runtime = await startRuntime();
            const registry = runtime.registry;
            const materialization = registry.resolveCurrentPluginMaterializationRef?.(plugin.manifest.id);
            const occurrenceId = registry.readPluginOccurrenceId(plugin.manifest.id);
            const sourceCustody = registry.readPluginSourceCustody?.(plugin.manifest.id);
            if (!materialization || !occurrenceId || !sourceCustody) throw new Error('Expected admitted Health observer');
            expect(materialization.materializationId).not.toBe(plugin.manifest.id);
            // Match the pre-existing installation to the real daemon declaration producer.
            await db.pluginMachineMaterialization.update({ where: { machineId_materializationId: {
                machineId: home.machineId, materializationId: home.installationId } },
                data: { materializationId: materialization.materializationId } });
            const handlers = new Map<string, RpcHandler>();
            registerDaemonContributionRegistryProjectionHandler({ registerHandler(method, handler) { handlers.set(method, handler); } }, {
                resolveRuntimeRegistry: async () => registry, resolveInstalledPackages: async () => [],
                resolvePluginProjectionExecutionOriginContext: () => origin,
            });
            const setup = handlers.get(RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE);
            if (!setup) throw new Error('Expected mounted Health setup RPC');
            const invokeSetup = (input: unknown) => runWithServerHttpBaseUrl(home.baseUrl, () => setup({
                machineId: home.machineId, qualifiedActionId: `${plugin.manifest.id}/health/setup`,
                expectedContributorOccurrenceId: occurrenceId, executionSurface: 'ui', input,
                invocation: { kind: 'mountedPluginSurface', mountedBinding: { pluginId: plugin.manifest.id,
                    contributionLocalId: HEALTH_CHECK_EVENT_REFS_V1.failed.localId, occurrenceId, sourceCustody,
                    materializationRef: materialization } },
            }, { signal: lifetime.signal, callerAuthority: 'present_user' }));
            // Replace only the OS executable; the bundled native adapter, discovery,
            // saved watch and current Machine service detail remain real.
            const nativeBin = join(happyHomeDir, 'systemctl');
            await writeFile(nativeBin, `#!${process.execPath}
const args=process.argv.slice(2);
if(args.includes('list-units')) process.stdout.write('web.service loaded active running Web\\n');
else if(args.includes('show')) process.stdout.write('LoadState=loaded\\nActiveState=active\\nSubState=running\\n');
else process.exitCode=17;
`, { mode: 0o700 });
            vi.stubEnv('PATH', `${happyHomeDir}:${process.env.PATH ?? ''}`);
            const target = { serverId: home.serverId, machineId: home.machineId };
            let metadata: MachineMetadataFieldReadV1 = { status: 'ready', metadataVersion: 1, metadata: {} };
            const port: MachineMetadataFieldPortV1 = { read: async () => metadata, compareAndSwap: async input => {
                if (metadata.status !== 'ready') return metadata;
                if (metadata.metadataVersion !== input.expectedMetadataVersion) return { ...metadata, status: 'conflict' };
                metadata = { status: 'ready', metadataVersion: metadata.metadataVersion + 1, metadata: input.metadata };
                return { ...metadata, status: 'applied' };
            } };
            machineServices = createMachineServicesRuntime({ target, readMetadata: () => metadata, captureMetadataPort: () => port });
            const nativeContext = { surface: 'cli' as const, authority: 'present_user' as const };
            const discovered = MachineServicesDiscoveryResultV1Schema.parse(await machineServices.execute({
                actionId: 'machines.services.discovery', input: { ...target, adapter: { pluginId: plugin.manifest.id, localId: 'systemd' } }, context: nativeContext }));
            if (discovered.kind !== 'snapshot') throw new Error(JSON.stringify(discovered));
            const candidate = discovered.candidates.find(value => value.nativeResourceId === 'user/web.service');
            if (!candidate) throw new Error(JSON.stringify(discovered));
            expect(await machineServices.execute({ actionId: 'machines.services.watch', context: nativeContext,
                input: { ...target, candidateId: candidate.candidateId, expectedRevision: candidate.revision, lifecyclePurpose: 'deployment' } })).toMatchObject({ kind: 'applied' });
            const listed = MachineServicesListResultV1Schema.parse(await machineServices.execute({ actionId: 'machines.services.list', input: target, context: nativeContext }));
            if (listed.kind !== 'snapshot' || listed.services.length !== 1) throw new Error(JSON.stringify(listed));
            const subject = { kind: 'machineService', machineId: home.machineId, serviceId: listed.services[0]!.serviceId };
            const prepared = await invokeSetup({ v: 1, subject, investigation: { mode: 'inbox' }, checks: [{
                checkId: 'http', kind: { pluginId: plugin.manifest.id, localId: 'http' }, binding: { kind: 'healthCheck' },
                config: { endpoint: 'http://127.0.0.1:18087', expectStatus: 200 }, periodMs: 60_000, consecutiveFailuresBeforeAlerting: 1,
            }] });
            expect(prepared, JSON.stringify(prepared)).toMatchObject({ ok: true });
            if (!prepared || typeof prepared !== 'object' || !('result' in prepared)) throw new Error('Expected prepared Health source');
            const source = PluginEventAutomationSetupResultV1Schema.parse(prepared.result);
            const triggers = createCliWorkflowTriggerActions({ credentials, serverHttpBaseUrl: home.baseUrl,
                resolveWorkflow: async () => { throw new Error('Observation-only Health has no Workflow'); } });
            const trigger = { kind: 'pluginEvent' as const, eventRef: HEALTH_CHECK_EVENT_REFS_V1.failed,
                ...source, v: undefined, observationTransport: { kind: 'checkpointedPull' as const, watcherMaterializationRef: materialization },
                filter: null, maximumObservationAgeMs: null, enabled: true };
            // v belongs to the setup result, not the Event definition request.
            const { v: _version, ...eventTrigger } = trigger;
            await expect(triggers.add({ observationOnly: { kind: 'observationOnly' }, name: 'Invalid installation',
                trigger: { ...eventTrigger, observationTransport: { kind: 'checkpointedPull',
                    watcherMaterializationRef: { ...materialization, materializationId: plugin.manifest.id } } } }))
                .rejects.toMatchObject({ code: 'workflow_http_error', details: { status: 400 } });
            expect(refusalBodies).toEqual([{ error: 'Automation Event watcher is not current' }]);
            const written = await triggers.add({ observationOnly: { kind: 'observationOnly' }, name: 'Observed service', trigger: eventTrigger });
            expect(written.set.health).toBe('available');
            await triggers.add({ observationOnly: { kind: 'observationOnly' }, name: 'Recovered service',
                trigger: { ...eventTrigger, eventRef: HEALTH_CHECK_EVENT_REFS_V1.recovered } });

            const noticeResults: unknown[] = [];
            let probes = 0;
            let now = Date.now();
            let httpStatus = 503;
            const samples: SavedMachineServiceHealthResult[] = [];
            const unavailable = createUnavailablePluginServices();
            const http: HttpService = { ...unavailable.http, async requestStream(request) { probes += 1; return { status: httpStatus, headers: {},
                finalUrl: request.url, chunks: (async function* () {})(), dispose: async () => {} }; } };
            const rows = new Map<string, AccountKvEntry>();
            // Account KV is the persistent-storage boundary; retain real SDK checkpoints and observation logic.
            const kv: AccountKvService = {
                async get<T extends import('@happier-dev/plugin-sdk').JsonValue>(key: string) {
                    // The generic content type is supplied by the SDK at this persistence boundary.
                    return (rows.get(key) ?? null) as AccountKvEntry<T> | null;
                },
                async set(key, value, options) {
                    const previous = rows.get(key);
                    if ((previous?.version ?? 'absent') !== options.expectedVersion) throw new Error('CAS conflict');
                    const version = (previous?.version ?? 0) + 1; rows.set(key, { version, value }); return { version };
                },
                async delete(key, options) {
                    const previous = rows.get(key);
                    if (previous?.version !== options.expectedVersion) throw new Error('CAS conflict');
                    const version = previous.version + 1; rows.set(key, { version, deleted: true }); return { version, deleted: true };
                },
                async list() { return { items: [...rows].map(([key, entry]) => ({ key, ...entry })) }; },
                async transaction(operation) { return operation(kv); },
            };
            function startObservation(current: NonNullable<typeof runtime>) {
                const registry = current.registry;
                const occurrenceId = registry.readPluginOccurrenceId(plugin.manifest.id);
                const materialization = registry.resolveCurrentPluginMaterializationRef?.(plugin.manifest.id);
                const sourceCustody = registry.readPluginSourceCustody?.(plugin.manifest.id);
                if (!occurrenceId || !materialization || !sourceCustody) throw new Error('Expected current Health observer');
                const isCurrent = () => registry.isPluginOccurrenceCurrent(plugin.manifest.id, occurrenceId);
                const revalidateCallerMaterialization = async (candidate: typeof materialization) => {
                    const current = registry.resolveCurrentPluginMaterializationRef?.(candidate.pluginId);
                    return current !== null && current !== undefined && arePluginMachineMaterializationRefsEqual(current, candidate);
                };
                const revalidateCallerOccurrence = async (candidate: Readonly<{ pluginId: string; occurrenceId: string }>) =>
                    registry.isPluginOccurrenceCurrent(candidate.pluginId, candidate.occurrenceId);
                const definitionsTransport = createAutomationEventStoredDefinitionsHttpTransportV1({ credentials,
                    revalidateCaller: async caller => isCurrent()
                        && await revalidateCallerMaterialization(caller.materialization)
                        && await revalidateCallerOccurrence(caller) });
                const adopted = createAutomationEventAdoptedDefinitionSetHostV1({ credentials, caller: materialization, occurrenceId,
                    sourceCustody, transport: { kind: 'checkpointedPull' }, occurrenceSignal: observerLifetime.signal,
                    readStoredDefinitions: async request => {
                        try { return await definitionsTransport.read(request); }
                        catch (error) {
                            // Retain locations only: Axios objects can include bearer headers.
                            adoptionHttpFailures.push({ phase: 'storedDefinitions',
                                frames: error instanceof Error ? error.stack?.split('\n').filter(line => /^\s+at /u.test(line)) : [] });
                            throw error;
                        }
                    },
                    isOccurrenceCurrent: isCurrent, revalidateCallerMaterialization, revalidateCallerOccurrence });
                const resolveAdoptedDefinitionSet: ResolveAutomationEventAdoptedDefinitionSetV1 = (candidate, occurrence, transport) =>
                    transport.kind === 'checkpointedPull' && occurrence === occurrenceId
                        && arePluginMachineMaterializationRefsEqual(candidate, materialization) ? adopted : null;
                const seed: PluginInvocationServicesSeed = { plugin: { id: plugin.manifest.id, version: plugin.manifest.version },
                    contribution: { id: 'health-observer', qualifiedId: `${plugin.manifest.id}/backgroundServices/health-observer` },
                    occurrenceId, sourceCustody, surface: 'background', signal: observerLifetime.signal, isOccurrenceCurrent: isCurrent,
                    resolveCurrentPluginMaterializationRef: () => registry.resolveCurrentPluginMaterializationRef?.(plugin.manifest.id) ?? null };
                const actionsSettings = setActionApprovalOverride({ settings: ActionsSettingsV1Schema.parse({ v: 1, actions: {} }),
                    actionId: 'automation.event.admit', surface: 'plugin', approvalRequired: false });
                // Native service discovery and the peer's HTTP reply are system boundaries.
                const consume = createConfiguredHealthCheckNotices({ credentials, serverId: home.serverId, serverHttpBaseUrl: home.baseUrl,
                    machineId: home.machineId, readService: async () => listed.services[0]!,
                    readEnvironment: async () => { throw new Error('Machine service has no Environment'); } });
                const executor = createActionExecutor({ machineServiceAction: request => {
                    if (!machineServices) throw new Error('Native service runtime unavailable');
                    return machineServices.execute(request);
                },
                    automationEventAction: createAutomationEventActionExecutor({ credentials, resolveAdoptedDefinitionSet,
                        revalidateCallerMaterialization, revalidateCallerOccurrence,
                        onCommittedObservation: async observation => { noticeResults.push(await consume(observation)); } }) });
                const actions = createPluginInvocationActionsService({ seed, actionExecutor: { ...executor,
                    execute: (id, input, context) => executor.execute(id, input, { ...context, actionsSettings }) },
                    invokeContributedAction: async () => { throw new Error('Unexpected contributed health check'); } });
                const healthChecks = createSavedHealthChecksHost({ serverId: home.serverId, homeServerIdentityId: home.serverId,
                    now: () => now,
                    resolveAdoptedDefinitionSet, readObserver: () => ({ machineId: home.machineId, installationId: home.installationId }),
                    openDomainArtifact: async () => { throw new Error('Machine service has no Domain'); },
                    onServiceResult: result => { samples.push(result); } }).bind(seed, { actions, http });
                if (!healthChecks) throw new Error('Expected bound saved-health service');
                const context: BackgroundServiceContext = { plugin: seed.plugin, contribution: seed.contribution,
                    surface: 'background', signal: observerLifetime.signal, materialization, invokedAtMs: Date.now(), services: {
                        ...unavailable, actions, healthChecks, http,
                        events: { ...unavailable.events, host: createPluginInvocationHostEventsService({ seed, broker: createStablePluginEventsBroker() }) },
                        storage: { ...unavailable.storage, account: { kv, collection() { throw new Error('Unexpected Collection'); } } },
                    } };
                const adapter = createHealthCheckSourceAdapter(() => now);
                const cycle = () => runWithServerHttpBaseUrl(home.baseUrl, () => runCheckpointedPluginEventObserverV1({
                    context, source: adapter, mode: 'once', now: () => now }));
                return { adopted, cycle };
            }
            let observer = startObservation(runtime);
            expect(observer.adopted.readPublicProjection().kind).toBe('initializing');
            await observer.cycle();
            const projection = observer.adopted.readPublicProjection();
            expect(projection, JSON.stringify(adoptionHttpFailures)).toMatchObject({ kind: 'available', definitions: expect.arrayContaining([expect.objectContaining({
                sourceInstanceId: source.sourceInstanceId, sourceConfig: source.sourceConfig,
                observationOnly: { kind: 'observationOnly' },
                observationTransport: { kind: 'checkpointedPull', watcherMaterializationRef: materialization },
            })]) });
            const observed = await runWithServerHttpBaseUrl(home.baseUrl, () => getAutomationDefinition({
                token: home.token, automationId: written.set.automationId,
            }));
            expect(probes, JSON.stringify(observed?.triggers)).toBe(1);
            expect(samples).toEqual([expect.objectContaining({ sourceInstanceId: source.sourceInstanceId,
                caller: materialization, subject, result: expect.objectContaining({ status: 'down' }) })]);
            expect(rows.size).toBeGreaterThan(0);
            // Status is read back through the public owner: a local sample alone
            // would not prove the SDK's admission/status HTTP writes succeeded.
            expect(observed?.triggers).toEqual([expect.objectContaining({ kind: 'pluginEvent', sourceStatus: expect.objectContaining({
                state: 'observing', code: null, observedCount: 1, admittedCount: 0, skippedCount: 0,
                reporterMaterializationRef: materialization,
            }) })]);
            expect(noticeResults).toEqual([expect.objectContaining({ kind: 'consumed', changed: true })]);
            const notices = await db.artifact.findMany();
            expect(notices).toHaveLength(1);
            const healthTrigger = observed?.triggers.find(trigger => trigger.kind === 'pluginEvent');
            if (!healthTrigger || healthTrigger.kind !== 'pluginEvent') throw new Error('Expected registered Health trigger');
            expect(healthTrigger.revision).toBe(0);
            const readInventoryHealth = async () => configuredHealthResultsForTrigger(await readConfiguredHealthResults({
                list: async () => ({ items: [...rows].map(([key, entry]) => ({ key, ...entry })) }),
            }, lifetime.signal, { results: new Map(), preceding: false }), written.set.automationId, healthTrigger);
            expect(await readInventoryHealth()).toMatchObject({ kind: 'available', checks: [
                { checkId: 'http', result: { status: 'down' } },
            ] });
            // A cold in-process daemon incarnation keeps only native metadata,
            // Account KV and server records; no adopted definitions or adapter state.
            observerLifetime.abort();
            await runtime.dispose();
            await machineServices.dispose();
            machineServices = createMachineServicesRuntime({ target, readMetadata: () => metadata, captureMetadataPort: () => port });
            observerLifetime = new AbortController();
            runtime = await startRuntime();
            expect(runtime.registry.readPluginOccurrenceId(plugin.manifest.id)).not.toBe(occurrenceId);
            expect(runtime.registry.resolveCurrentPluginMaterializationRef?.(plugin.manifest.id)).toEqual(materialization);
            observer = startObservation(runtime);
            expect(observer.adopted.readPublicProjection().kind).toBe('initializing');
            expect(await readInventoryHealth()).toMatchObject({ kind: 'available', checks: [
                { checkId: 'http', result: { status: 'down' } },
            ] });
            now += 60_000;
            await observer.cycle();
            expect(observer.adopted.readPublicProjection(), JSON.stringify(adoptionHttpFailures)).toMatchObject({ kind: 'available', definitions: expect.arrayContaining([
                expect.objectContaining({ sourceInstanceId: source.sourceInstanceId, sourceConfig: source.sourceConfig }),
            ]) });
            expect(probes).toBe(2);
            expect(noticeResults).toEqual([expect.objectContaining({ kind: 'consumed', changed: true })]);
            expect(await db.artifact.findMany()).toEqual(notices);
            now += 60_000;
            httpStatus = 200;
            await observer.cycle();
            expect(probes).toBe(3);
            expect(noticeResults).toEqual([
                expect.objectContaining({ kind: 'consumed', changed: true }),
                expect.objectContaining({ kind: 'consumed', changed: true }),
            ]);
            const recoveredNotices = await db.artifact.findMany();
            expect(recoveredNotices).toEqual([expect.objectContaining({ id: notices[0]!.id,
                headerVersion: notices[0]!.headerVersion + 1 })]);
            expect(await readInventoryHealth()).toMatchObject({ kind: 'available', checks: [
                { checkId: 'http', result: { status: 'up' } },
            ] });
        } finally {
            observerLifetime.abort();
            lifetime.abort();
            await machineServices?.dispose();
            await runtime?.dispose();
            await home.close();
        }
    });
});
