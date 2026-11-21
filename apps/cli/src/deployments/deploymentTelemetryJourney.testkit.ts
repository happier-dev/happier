import { describe, expect, it, vi } from 'vitest';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Session } from 'node:inspector/promises';
import type { HeapProfiler, Profiler } from 'node:inspector';
import { Socket } from 'node:net';
import nacl from 'tweetnacl';
import { createLogRetentionOwner } from '@/utils/logs/logRetention';
import { localCaptureBackground } from '../../../../packages/plugins/telemetry/src/background';
import { telemetryPartition } from '../../../../packages/plugins/telemetry/src/telemetry/assignments';
import { inspectBuiltinTailscaleAccessProvider } from '../../../../packages/cli-common/src/relayAccess/providers/tailscale/inspect';
import { projectMachineReachabilityObservation } from '@/machines/reachability/readMachineReachability';
import type { ActionExecuteResult } from '@happier-dev/protocol';
import { ActionIdSchema } from '@happier-dev/protocol/actions/actionIds';
import { bindPresentUserActionConfirmationV1 } from '@happier-dev/protocol/actions/executor/approvalReview';
import { MACHINE_ACCESS_GRANT_SET_ACTION_ID_V1 } from '@happier-dev/protocol/actions/specs/machine/accessActionIdsV1';
import { parseQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';
import { CORE_MACHINE_ROLE_IDS_V1, DATABASE_TELEMETRY_MACHINE_ROLE_ID_V1, MachineRolesGetResultV1Schema,
    projectPublishedMachineRolesV1 } from '@happier-dev/protocol/machines/roles/machineRolesV1';
import { MachineAccessGrantsListResultV1Schema, MachineAccessGrantSetInputV1Schema } from '@happier-dev/protocol/machines/machineAccessV1';
import { DeploymentEnvironmentCreateResultV1Schema, DeploymentEnvironmentGetResultV1Schema,
    DeploymentReceiptResultV1Schema } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, DEPLOYMENT_TARGET_LINK_ARTIFACT_KIND_V1 } from '@happier-dev/deployment-protocol/v1';
import { DeploymentEnvironmentContentV1Schema } from '@happier-dev/deployments/contracts/v1';
import { ProjectSourcesCreateOutputV1Schema } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import { createDeploymentSocketHome } from '../../../server/sources/testkit/deploymentSocketHome.testkit.mjs';
import { sessionRoutes } from '../../../server/sources/app/api/routes/session/sessionRoutes';
import { createAccountTokenForTests } from '../../../server/sources/testkit/lightSqliteHarness';
import { createSignedAccountContentBinding } from '../../../server/sources/testkit/accountEncryption';
import { db } from '../../../server/sources/storage/db';
import { inTx } from '../../../server/sources/storage/inTx';
import { removeTeamMemberForActorInTx } from '../../../server/sources/app/teams/memberships/memberAdministration';
import { DATABASE_CAPTURE_PLUGIN } from '../../../../packages/plugins/telemetry/src/manifest';
import { plugin as deploymentTemplates } from '../../../../packages/plugins/deployment-templates/src/manifest';
import { createAdmittedPluginRuntimeFixture, createAuthoredAdmittedPluginRuntimeFixture, requireDaemonEntrypoint } from '@/plugins/testkit/admittedRuntime';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { projectLoadedPluginContributes } from '@/plugins/projection/registry/fullProjection';
import { loadInstalledPlugins } from '@/plugins/discovery/load/installed';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { collectBlockingPluginReloadDiagnostics } from '@/plugins/runtime/reload/diagnostics';
import * as installationStore from '@/daemon/identity/store';
import { createMachineContentCodec } from '@/api/machine/machineStoredContent';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import { createDaemonDeploymentActionDeps } from './createDaemonDeploymentActionDeps';
import { createOwnServerDeploymentRuntimeForHost } from './targets/ownServer/ownServerDeploymentHostRuntime';
import { createS0DeploymentDaemonIngress, installationBoundary, readS0ControllerCredentials, readS0Installation } from './deploymentDaemonIngress.testkit';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { configuration } from '@/configuration';
import { readSettings, updateSettings } from '@/persistence';
import { adoptServerProfileHomeConnectionDescriptor } from '@/server/serverProfiles';
import type { DeploymentSourceRequesterIdentityResolver } from './readDeploymentSourceIntentForHost';
import { resolveOwnServerDeploymentIdentityForHost } from './targets/ownServer/paths';
import { z } from 'zod';
import { TELEMETRY_EXPORT_ENVIRONMENT_KEYS_V1 } from '@happier-dev/deployments/telemetry';
import { runProductionMetricsJourney } from './deploymentMetricsJourney.composed.testkit';
import { createProductionCostsAgentBaseline, runProductionCostsJourney } from './deploymentCostsJourney.composed.testkit';
import { runProductionExceptionsJourney } from './deploymentExceptionsJourney.composed.testkit';
import { SHARED_SAVED_SECRET_ACTION_PATHS_V1 } from '@happier-dev/protocol/account/settings/savedSecretResourceActionsV1';
import { createCredentialedAccountArtifactStore } from '@/api/artifacts/accountArtifactStore';
import { DEFAULT_PLUGIN_DAEMON_DATABASE_LIMITS_POLICY } from '@/plugins/runtime/context/daemonDatabaseLimitsPolicy';
import { applyMachineRoleAdmission } from '@/plugins/projection/registry/builtIn/machineRoles';
import { resolveBundledPluginEnablement } from '@/plugins/projection/registry/builtIn/enablement';
import { createOwnServerNativeRuntime } from './targets/ownServer/nativeRuntime';
import * as nativeRuntimeBoundary from './targets/ownServer/nativeRuntime';
import { authorizePluginExecLaunchForHost } from '@/plugins/runtime/invocation/services/exec';
import {
    DATABASE_CAPTURE_QUERIES_LIST_ACTION_ID_V1, DATABASE_CAPTURE_QUERY_GET_ACTION_ID_V1,
    DATABASE_CAPTURE_TRACES_LIST_ACTION_ID_V1, DATABASE_CAPTURE_TRACE_GET_ACTION_ID_V1,
    DatabaseCaptureQueriesListResultV1Schema, DatabaseCaptureQueryGetResultV1Schema,
    DatabaseCaptureTracesListResultV1Schema, DatabaseCaptureTraceGetResultV1Schema,
} from '@happier-dev/database-protocol';

// The incumbent journey substitutes sudo/getent for its isolation tests. This
// native leg uses the actual OS API, including execFile's promisify contract.
const { execFile } = await vi.importActual<typeof import('node:child_process')>('node:child_process');
const execute = promisify(execFile);
type Invoke = (name: string, input: unknown, machineId?: string) => Promise<ActionExecuteResult>;
function createInvoke(
    executor: ReturnType<typeof createCliActionExecutorFromCredentials>,
    serverId: string,
    accountId: string,
): Invoke {
    return async (name, input, machineId) => {
        const action = parseQualifiedPluginActionId(name);
        const actionId = action ? 'action.invoke' : ActionIdSchema.parse(name);
        const actionRequestId = randomUUID();
        if (actionId === MACHINE_ACCESS_GRANT_SET_ACTION_ID_V1) {
            const grant = MachineAccessGrantSetInputV1Schema.parse(input);
            const context = {
                surface: 'cli', authority: 'present_user', actionRequestId, runtimeAccountId: accountId,
                serverId, serverIdentityId: serverId,
                externalActionTarget: { kind: 'machine', machineId: grant.machineId },
            } as const;
            const review = await executor.execute(actionId, grant, context);
            expect(review).toMatchObject({ ok: false, errorCode: 'action_interactive_review_required' });
            if (review.ok || review.errorCode !== 'action_interactive_review_required') return review;
            const digest = review.details?.reviewDigest;
            expect(digest, 'Machine sharing must carry its current review').toEqual(expect.any(String));
            if (typeof digest !== 'string') return review;
            return executor.execute(actionId, grant, bindPresentUserActionConfirmationV1(actionId, grant, context, digest));
        }
        return executor.execute(actionId, action ? { action, input } : input, {
            surface: 'cli', serverId, ...(machineId ? { externalActionTarget: { kind: 'machine', machineId } } : {}),
            actionRequestId, authority: 'present_user', presentUserConfirmation: { actionId },
        });
    };
}

type DeploymentSocketHomeFixture = Awaited<ReturnType<typeof createDeploymentSocketHome>>;
type EnvironmentDetail = Extract<z.infer<typeof DeploymentEnvironmentGetResultV1Schema>, { ok: true }>;
type TelemetryJourneyActor = Readonly<{
    accountId: string;
    credentials: ReturnType<typeof readS0ControllerCredentials>;
    invoke: Invoke;
    invokeSettled: Invoke;
    accepted(name: string, input: unknown, machineId?: string): Promise<unknown>;
    prepare(kind: string, body: unknown): Promise<Readonly<{
        contentArtifactId: string; contentHeaderVersion: number; contentBodyVersion: number;
    }>>;
}>;
export type ProductionTelemetryCollectorAppJourney = (context: Readonly<{
    home: DeploymentSocketHomeFixture;
    daemon: Awaited<ReturnType<typeof createS0DeploymentDaemonIngress>>;
    credentials: ReturnType<typeof readS0ControllerCredentials>;
    invoke: Invoke;
    accepted(name: string, input: unknown): Promise<unknown>;
    prepare(kind: string, body: unknown): Promise<Readonly<{
        contentArtifactId: string; contentHeaderVersion: number; contentBodyVersion: number;
    }>>;
    createEnvironment(name: string): Promise<string>;
    readEnvironment(environmentId?: string): Promise<EnvironmentDetail>;
    cleanup: Array<() => Promise<void>>;
    signal: AbortSignal;
    nativeDockerEngineId: string;
    nativeDocker(args: readonly string[]): Promise<Readonly<{ stdout: string; stderr: string }>>;
    initiator: TelemetryJourneyActor & Readonly<{
        projectSourceId: string;
        teamId: string;
        grantHostManage(): Promise<void>;
    }>;
}>) => Promise<Readonly<{
    machineId: string; environmentId: string;
    restart(): Promise<void>; stop(): Promise<void>; start(): Promise<void>;
    prepareEnvironment(environmentId: string): Promise<void>;
}>>;

/** Extends the incumbent journey's real Home/daemon/approval helpers. This native
 * leg never installs the fake Docker executable used by the S0 OS-boundary tests.
 * Capture reads use the same credentialed executor as setup and deployment. */
export function registerProductionTelemetrySetupJourney(support: Readonly<{
    nativeDeploymentArtifacts(home: DeploymentSocketHomeFixture): Pick<ReturnType<typeof createCredentialedAccountArtifactStore>, 'create' | 'read'>;
    sourceRequesterForHome(home: DeploymentSocketHomeFixture): DeploymentSourceRequesterIdentityResolver;
    settlePublicApproval(invoke: Invoke, result: ActionExecuteResult): Promise<ActionExecuteResult>;
    collectorAppJourney?: ProductionTelemetryCollectorAppJourney;
}>) {
    // The real server identity owner caches one Home per process. Both fresh
    // Accounts exercise that Home rather than inventing a second process identity.
    const serverId = `srv_${randomUUID().replaceAll('-', '')}`;
    describe.skipIf(process.env.HAPPIER_RUN_DBW_TELEMETRY_F14 !== '1')('F14 native production telemetry setup and deploy', () => {
        // The disposable DB-contract runner owns this native journey's deadline.
        it.each(['plain', 'e2ee'] as const)('reads deployed SDK queries and traces through admitted Actions in %s mode', async encryptionMode => {
            expect(process.platform, 'F14 requires native Linux Docker').toBe('linux');
            const native = await execute('docker', ['info', '--format', '{{.OSType}}']);
            expect(native.stdout.trim()).toBe('linux');
            const engine = await execute('docker', ['info', '--format', '{{.ID}}']);
            const dockerEnvironmentNames = ['DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG', 'XDG_RUNTIME_DIR']
                .filter(name => process.env[name] !== undefined);
            const setupRequests = { bindings: 0, secretCreate: 0, secretUpdate: 0 };
            const home = await createDeploymentSocketHome({ encryptionMode, dbProvider: 'postgres', serverId,
                configureApp: app => {
                    if (process.env.HAPPIER_RUN_DBW_COSTS_F17 === '1') sessionRoutes(app);
                    app.addHook('onResponse', async (request, reply) => {
                        if (request.method !== 'POST' || reply.statusCode !== 200) return;
                        const route = request.routeOptions.url;
                        if (route === '/v1/deployments/environments/:environmentId/bindings') setupRequests.bindings += 1;
                        if (route === SHARED_SAVED_SECRET_ACTION_PATHS_V1['secrets.shared.create']) setupRequests.secretCreate += 1;
                        if (route === SHARED_SAVED_SECRET_ACTION_PATHS_V1['secrets.shared.update']) setupRequests.secretUpdate += 1;
                    });
                },
                ...(encryptionMode === 'e2ee' ? { prepareMachineContent: (key: Uint8Array, metadata: Readonly<Record<string, unknown>>) =>
                    createMachineContentCodec({ encryptionMode: 'e2ee', encryptionKey: key, encryptionVariant: 'dataKey' }).encodeStored(metadata) } : {}) });
            const cleanup: Array<() => Promise<void>> = [() => home.close()];
            const lifetime = new AbortController();
            try {
                // The background collector signs through the async identity store, outside the RPC fixture context.
                const originalInstallationFile = configuration.installationIdentityFile;
                const installationFile = join(home.baseDir, 'installation-identity.json');
                await writeFile(installationFile, JSON.stringify(readS0Installation(home)), { mode: 0o600, flag: 'wx' });
                Reflect.set(configuration, 'installationIdentityFile', installationFile);
                cleanup.push(async () => { Reflect.set(configuration, 'installationIdentityFile', originalInstallationFile); });
                // Observe the real OS boundary without retaining native arguments or output.
                const failedDockerCommands: Array<Readonly<{ verb: string; operation: string; exitCode: number | null; reasons: string[] }>> = [];
                const verbs = new Set(['image', 'buildx', 'compose', 'version', 'info', 'inspect', 'network', 'volume', 'container', 'ps']);
                const operations = new Set(['inspect', 'save', 'pull', 'imagetools', 'bake', 'version', 'config', 'up', 'down', 'ls', 'rm', 'tag']);
                const createNativeRuntime = nativeRuntimeBoundary.createOwnServerNativeRuntime;
                const nativeObservation = vi.spyOn(nativeRuntimeBoundary, 'createOwnServerNativeRuntime').mockImplementation(input => {
                    const native = createNativeRuntime(input);
                    const run = native.nativeIo.run.bind(native.nativeIo);
                    const observeRun: typeof native.nativeIo.run = async request => {
                        const result = await run(request);
                        const argv = request.args;
                        const verbIndex = argv.findIndex(value => verbs.has(value));
                        if (result.exitCode !== 0) {
                            const message = (result.stderr ?? '').toLowerCase();
                            const reasons = ['permission denied', 'no such file', 'unknown flag', 'unknown command',
                                'requires at least', 'no such image', 'denied', 'connection refused', 'not found',
                                'unexpected eof', 'x509', 'failed to resolve', 'too many requests', 'failed to dial', 'dial unix']
                                .filter(reason => message.includes(reason));
                            failedDockerCommands.push({ verb: argv[verbIndex] ?? 'other',
                                operation: operations.has(argv[verbIndex + 1]) ? argv[verbIndex + 1] : 'other',
                                exitCode: result.exitCode, reasons });
                        }
                        return result;
                    };
                    return { ...native, nativeIo: { ...native.nativeIo, run: observeRun } };
                });
                cleanup.push(async () => { nativeObservation.mockRestore(); });
                vi.stubEnv('HAPPIER_CLI_SUBPROCESS_PREFER_TSX', '1');
                vi.spyOn(installationStore, 'readInstallationIdentityIfExistsSync').mockImplementation(
                    () => installationBoundary.getStore() ?? readS0Installation(home));
                const credentials = readS0ControllerCredentials(home);
                const previousSettings = await readSettings();
                cleanup.push(async () => { await updateSettings(settings => {
                    const { [configuration.activeServerId]: _profile, ...servers } = settings.servers ?? {};
                    const { [home.accountId]: _machine, ...machines } = settings.machineIdByServerIdByAccountId?.[configuration.activeServerId] ?? {};
                    const { [configuration.activeServerId]: _account, ...accounts } = settings.lastTokenSubByServerId ?? {};
                    return { ...settings,
                        servers: { ...servers, ...(previousSettings.servers?.[configuration.activeServerId]
                            ? { [configuration.activeServerId]: previousSettings.servers[configuration.activeServerId] } : {}) },
                        machineIdByServerIdByAccountId: { ...settings.machineIdByServerIdByAccountId,
                            [configuration.activeServerId]: machines },
                        lastTokenSubByServerId: { ...accounts, ...(previousSettings.lastTokenSubByServerId?.[configuration.activeServerId]
                            ? { [configuration.activeServerId]: previousSettings.lastTokenSubByServerId[configuration.activeServerId] } : {}) },
                    };
                }); });
                await adoptServerProfileHomeConnectionDescriptor({
                    descriptor: { v: 1, homeServerIdentityId: home.serverId, canonicalServerUrl: home.baseUrl,
                        revision: 1, endpoints: [{ kind: 'https', url: home.baseUrl }] },
                    expectedProfileId: configuration.activeServerId, createIfMissing: true, observation: 'exact',
                });
                await updateSettings(settings => ({ ...settings,
                    machineIdByServerIdByAccountId: { ...settings.machineIdByServerIdByAccountId,
                        [configuration.activeServerId]: { ...settings.machineIdByServerIdByAccountId?.[configuration.activeServerId], [home.accountId]: home.machineId } },
                    lastTokenSubByServerId: { ...settings.lastTokenSubByServerId, [configuration.activeServerId]: home.accountId },
                }));
                cleanup.push(async () => { lifetime.abort(); });
                const runtime = createOwnServerDeploymentRuntimeForHost({ credentials,
                    resolveRequesterIdentity: support.sourceRequesterForHome(home), serverId: home.serverId,
                    serverHttpBaseUrl: home.baseUrl, machineId: home.machineId,
                    acquirePluginRuntimeRegistryLease: () => pluginReloadController.acquireRuntimeRegistry(),
                    signal: lifetime.signal });
                const daemon = await createS0DeploymentDaemonIngress({ home, installRolesReceiver: true,
                    resolveDeploymentRequesterIdentity: support.sourceRequesterForHome(home),
                    createDeploymentActionDeps: requester => createDaemonDeploymentActionDeps({
                        resolveRequesterIdentity: support.sourceRequesterForHome(home), credentials: requester?.credentials ?? credentials,
                        serverId: home.serverId, serverHttpBaseUrl: requester?.serverHttpBaseUrl ?? home.baseUrl,
                        machineId: home.machineId, runtime,
                        ...(requester ? { savedSecretOperationContext: requester.savedSecretOperationContext } : {}),
                    }) });
                cleanup.push(() => daemon.close());
                const runtimeOptions = { scopedActionRuntime: { credentials, actionsSettingsProvider: createActionSettingsProvider() },
                    resolveCurrentMachineId: () => home.machineId, daemonDatabaseLimits: DEFAULT_PLUGIN_DAEMON_DATABASE_LIMITS_POLICY };
                const readContributes = async (happyHomeDir: string) => {
                    const loadResult = await loadInstalledPlugins({ happyHomeDir });
                    const pluginEnablementById = resolveBundledPluginEnablement({
                        pluginIds: loadResult.loadedPlugins.map(plugin => plugin.pluginId) });
                    const declarations = createResolvedContributionRegistry(projectLoadedPluginContributes({
                        loadResult, provenance: 'external', pluginEnablementById }));
                    return Object.freeze({ ...declarations, pluginEnablementById: applyMachineRoleAdmission({
                        pluginEnablementById, machineRoles: declarations.machineRoles }) });
                };
                const templateManifest = deploymentTemplates.manifest;
                const deploymentPluginIds = [DATABASE_CAPTURE_PLUGIN.manifest.id, templateManifest.id];
                const templateFiles = Object.fromEntries(await Promise.all(templateManifest.contributes.registrySources.flatMap(source => {
                    if (!('packageContent' in source)) return [];
                    const path = source.packageContent.path;
                    return [readFile(new URL(`../../../../packages/plugins/deployment-templates/${path}`, import.meta.url))
                        .then(content => [path, content] as const)];
                })));
                const mounted = await runWithServerHttpBaseUrl(home.baseUrl, () => createAuthoredAdmittedPluginRuntimeFixture({
                    controller: pluginReloadController, happyHomeDir: configuration.happyHomeDir,
                    plugins: [{ manifest: DATABASE_CAPTURE_PLUGIN.manifest, replaceExisting: true,
                        files: { [requireDaemonEntrypoint(DATABASE_CAPTURE_PLUGIN.manifest)]: 'export function activate() {}' },
                        instantiateCommittedModule: () => ({ activate: DATABASE_CAPTURE_PLUGIN.activate,
                            daemonDatabases: DATABASE_CAPTURE_PLUGIN.daemonDatabases }) },
                    { manifest: templateManifest, replaceExisting: true,
                        files: { ...templateFiles, [requireDaemonEntrypoint(templateManifest)]: 'export function activate() {}' },
                        instantiateCommittedModule: () => ({ activate: deploymentTemplates.activate }) }],
                    resolveContributes: readContributes, runtimeOptions: { ...runtimeOptions, pluginIds: deploymentPluginIds },
                }));
                cleanup.push(() => mounted.dispose());
                if (!daemon.publishDaemonState) throw new Error('F14 requires the real Machine daemon-state publisher');
                // Observe the configured host through the canonical native
                // provider. This fixture never joins or creates a network.
                const nativeNetwork = await inspectBuiltinTailscaleAccessProvider({ signal: lifetime.signal }, {
                    runCommand: async request => {
                        try {
                            const result = await execute(request.command, [...request.args], {
                                env: request.env, signal: request.signal, timeout: request.timeoutMs,
                            });
                            return { command: request.command, args: request.args, exitCode: 0, ...result };
                        } catch (error) {
                            if (!error || typeof error !== 'object' || !('code' in error) || typeof error.code !== 'number') throw error;
                            return { command: request.command, args: request.args, exitCode: error.code,
                                stdout: 'stdout' in error && typeof error.stdout === 'string' ? error.stdout : '',
                                stderr: 'stderr' in error && typeof error.stderr === 'string' ? error.stderr : '' };
                        }
                    },
                });
                if (nativeNetwork.kind !== 'confirmed' || nativeNetwork.facts.privateNetwork?.state !== 'ready') {
                    throw new Error(`F14 host private network unavailable: ${nativeNetwork.kind === 'confirmed'
                        ? nativeNetwork.facts.state : nativeNetwork.code}`);
                }
                const privateNetwork = nativeNetwork.facts.privateNetwork;
                await daemon.publishDaemonState(state => ({ ...(state ?? { status: 'running' }),
                    reachability: projectMachineReachabilityObservation(state?.reachability, {
                        revision: 0,
                        management: state?.reachability?.management ?? { daemon: 'unknown', publicSsh: 'unknown', providers: [] },
                        ingress: state?.reachability?.ingress ?? [], privateNetworks: [privateNetwork],
                    }),
                    machineRoles: projectPublishedMachineRolesV1(mounted.registry.contributes.machineRoles.map(
                        entry => ({ pluginId: entry.pluginId, declaration: entry.definition }))) }));
                console.info('F14 native private network', { provider: privateNetwork.provider, state: privateNetwork.state,
                    scope: 'existing host network; collector App and workload share this hosting Machine',
                    networkIdentityPresent: Boolean(privateNetwork.networkIdentity), addresses: privateNetwork.addresses.length });
                const createExecutor = (actorCredentials: typeof credentials, machineId?: string, disclosureAccountId?: string) => createCliActionExecutorFromCredentials({
                    credentials: actorCredentials, readCredentials: async () => actorCredentials, externalActionClient: true,
                    ...(machineId ? { machineId } : {}), serverId: home.serverId, serverIdentityId: home.serverId, serverApiUrl: home.baseUrl,
                    ...(disclosureAccountId ? { onRequesterSessionCredentialDisclosure: disclosure =>
                        disclosure.accountId === disclosureAccountId && disclosure.machineId === home.machineId
                        && (disclosure.custodian === undefined || disclosure.custodian.accountId === home.accountId) } : {}),
                });
                const invokeLocal = createInvoke(createExecutor(credentials, home.machineId), home.serverId, home.accountId);
                const invokeTargeted = createInvoke(createExecutor(credentials), home.serverId, home.accountId);
                const invoke: Invoke = (name, input, machineId) => machineId ? invokeTargeted(name, input, machineId) : invokeLocal(name, input);
                const accepted = async (name: string, input: unknown, machineId?: string) => {
                    const result = await support.settlePublicApproval(invoke, await invoke(name, input, machineId));
                    let nativeDiagnostic: ActionExecuteResult | undefined;
                    if (!result.ok && name === 'deployments.deploy' && input !== null && typeof input === 'object'
                        && 'environmentId' in input && typeof input.environmentId === 'string') {
                        const receipt = await db.deployment.findFirst({ where: { environmentId: input.environmentId },
                            orderBy: [{ requestedAt: 'desc' }, { id: 'desc' }], select: { id: true, targetLinkId: true } });
                        if (receipt) nativeDiagnostic = await invoke('deployments.logs.read', { serverId: home.serverId,
                            environmentId: input.environmentId, deploymentId: receipt.id, targetLinkId: receipt.targetLinkId,
                            machineId: home.machineId, installationId: home.installationId, kind: 'build' });
                    }
                    expect(result.ok, JSON.stringify(result.ok ? { name, state: 'accepted' }
                        : { name, errorCode: result.errorCode, failureCause: result.failureCause,
                            effectAttempted: result.effectAttempted, nativeDiagnostic, failedDockerCommands })).toBe(true);
                    if (!result.ok) throw new Error(`${name}: ${result.errorCode}`);
                    return result.result;
                };
                const createReader = async (options?: Readonly<{ consentToFixtureHost: boolean }>) => {
                    const keys = encryptionMode === 'e2ee' ? nacl.box.keyPair() : null;
                    const account = await db.account.create({ data: { encryptionMode,
                        ...(keys ? createSignedAccountContentBinding(keys.publicKey) : {}) } });
                    const token = await createAccountTokenForTests(account.id, { kind: 'account', authority: 'present_user' });
                    const readerCredentials = readS0ControllerCredentials({ ...home, token,
                        encryption: keys ? { type: 'dataKey', machineKey: new Uint8Array(keys.secretKey),
                            publicKey: new Uint8Array(keys.publicKey) } : null });
                    const invokeReader = createInvoke(createExecutor(readerCredentials, undefined,
                        options?.consentToFixtureHost ? account.id : undefined), home.serverId, account.id);
                    const invokeSettled: Invoke = async (name, input, machineId) =>
                        support.settlePublicApproval(invokeReader, await invokeReader(name, input, machineId));
                    const acceptedReader = async (name: string, input: unknown, machineId?: string) => {
                        const result = await invokeSettled(name, input, machineId);
                        expect(result.ok, JSON.stringify(result.ok ? { name, state: 'accepted' }
                            : { name, errorCode: result.errorCode, failureCause: result.failureCause })).toBe(true);
                        if (!result.ok) throw new Error(`${name}: ${result.errorCode}`);
                        return result.result;
                    };
                    const prepareReader = async (kind: string, body: unknown) => {
                        const store = createCredentialedAccountArtifactStore(readerCredentials);
                        const artifact = await runWithServerHttpBaseUrl(home.baseUrl, () => store.create({
                            header: { kind, title: 'F14 collector fixture' }, body: JSON.stringify(body) }));
                        return { contentArtifactId: artifact.artifactId, contentHeaderVersion: artifact.revision.headerVersion,
                            contentBodyVersion: artifact.revision.bodyVersion };
                    };
                    return { accountId: account.id, token, credentials: readerCredentials, invoke: invokeReader,
                        invokeSettled, accepted: acceptedReader, prepare: prepareReader };
                };
                const teammate = await createReader();
                const outsider = await createReader();
                const assertNoTeammateMachineGrant = async (machineIds: readonly string[]) => {
                    const memberships = await db.teamMembership.findMany({ where: { accountId: teammate.accountId },
                        select: { teamId: true, groupMemberships: { select: { teamGroupId: true } } } });
                    const grants = await db.machineGrant.findMany({ where: { machineId: { in: [...machineIds] }, OR: [
                        { accountId: teammate.accountId },
                        { teamId: { in: memberships.map(membership => membership.teamId) } },
                        { teamGroupId: { in: memberships.flatMap(membership => membership.groupMemberships.map(group => group.teamGroupId)) } },
                    ] }, select: { id: true } });
                    expect(grants, 'C has no direct, Team or group Use/Manage grant to a collector Machine').toEqual([]);
                };
                const sourceTeam = await db.team.create({ data: { name: 'F14 telemetry readers' } });
                await db.teamMembership.createMany({ data: [
                    { teamId: sourceTeam.id, accountId: home.accountId, role: 'owner' },
                    { teamId: sourceTeam.id, accountId: teammate.accountId, role: 'member' },
                ] });
                // The hosting Account owns workload custody. The reader Team
                // gets Source access without a grant to either collector Machine.
                const sourceResponse = await fetch(`${home.baseUrl}/v1/projects/sources`, {
                    method: 'POST', headers: { Authorization: `Bearer ${home.token}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ serverId: home.serverId, requestKey: randomUUID(), name: 'F14 native app',
                        audience: [{ principal: { kind: 'team', teamId: sourceTeam.id }, level: 'view' }] }),
                });
                expect(sourceResponse.status).toBe(200);
                const source = ProjectSourcesCreateOutputV1Schema.parse(await sourceResponse.json());
                if (!source.ok) throw new Error(source.error);
                const prepare = async (kind: string, body: unknown) => {
                    const artifact = await support.nativeDeploymentArtifacts(home).create({ header: { kind, title: 'F14 fixture' }, body: JSON.stringify(body) });
                    return { contentArtifactId: artifact.artifactId, contentHeaderVersion: artifact.revision.headerVersion,
                        contentBodyVersion: artifact.revision.bodyVersion };
                };
                const image = `happier-f14-app:${randomUUID()}`;
                const fixtureDirectory = fileURLToPath(new URL('./testkit/telemetryApp/', import.meta.url));
                const nativeRuntime = createOwnServerNativeRuntime({ cwd: fixtureDirectory, signal: lifetime.signal,
                    isCurrent: () => !lifetime.signal.aborted });
                const dockerTool = await nativeRuntime.exec.systemTools.resolve({ toolId: 'docker',
                    purpose: 'deployment-native-compose', cwd: fixtureDirectory });
                const nativeEngineLaunch = await authorizePluginExecLaunchForHost(nativeRuntime.exec, {
                    executable: dockerTool.executable, args: ['info', '--format', '{{.ID}}'], cwd: fixtureDirectory,
                }, { agentIsolation: null });
                let nativeDockerEngineId: string;
                try {
                    const result = await nativeRuntime.nativeIo.run({ command: nativeEngineLaunch.command,
                        args: nativeEngineLaunch.args, cwd: nativeEngineLaunch.cwd!, env: nativeEngineLaunch.env });
                    expect(result.exitCode, 'Native Docker engine diagnostic must succeed').toBe(0);
                    nativeDockerEngineId = result.stdout.trim();
                } finally {
                    await nativeEngineLaunch.release();
                    await nativeRuntime.settleNative();
                }
                await execute('docker', ['build', '--load', '--tag', image, fixtureDirectory]);
                // The image and all containers selected below are unique to this test.
                cleanup.push(async () => { await execute('docker', ['image', 'rm', image]); });
                const loadedImage = await execute('docker', ['image', 'inspect', '--format', '{{json .}}', image]);
                const imageIdentity = FixtureImageIdentity.parse(JSON.parse(loadedImage.stdout));
                console.info('F14 native fixture identity', { encryptionMode, image, ...imageIdentity,
                    dockerEngineId: engine.stdout.trim(), nativeDockerEngineId, dockerEnvironmentNames,
                    serverId: home.serverId, daemonHomeDir: configuration.happyHomeDir });
                const document = JSON.stringify({ services: {
                    db: { image: 'postgres:17', environment: { POSTGRES_USER: 'fixture', POSTGRES_PASSWORD: 'fixture', POSTGRES_DB: 'fixture' },
                        healthcheck: { test: ['CMD', 'pg_isready', '-h', '127.0.0.1', '-U', 'fixture', '-d', 'fixture'] } },
                    web: { image, ports: ['127.0.0.1::3000'], depends_on: { db: { condition: 'service_healthy' } },
                        healthcheck: { test: ['CMD', 'node', '-e',
                            "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"] },
                        environment: { DATABASE_URL: 'postgresql://fixture:fixture@db:5432/fixture',
                            ...Object.fromEntries(TELEMETRY_EXPORT_ENVIRONMENT_KEYS_V1.map(key => [key, null])) } },
                } });
                const createEnvironment = async (name: string) => {
                    const created = DeploymentEnvironmentCreateResultV1Schema.parse(await accepted('deployments.environments.create', {
                        serverId: home.serverId, projectSourceId: source.source.id, requestKey: randomUUID(),
                        protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers',
                        controllerMachineId: home.machineId, buildMachineId: home.machineId,
                        ...await prepare(DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, { name, retainPreviousDeployments: 1,
                            definition: { kind: 'stored', contentRevision: 1, document,
                                composeDigest: `sha256:${createHash('sha256').update(document).digest('hex')}`, profiles: [], services: ['web', 'db'] }, bindings: [] }),
                        firstTargetLink: { machines: [{ machineId: home.machineId, installationId: home.installationId }],
                            ...await prepare(DEPLOYMENT_TARGET_LINK_ARTIFACT_KIND_V1, {}) },
                    }));
                    if (!created.ok) throw new Error(created.error);
                    const environmentId = created.environmentId;
                    const identity = await resolveOwnServerDeploymentIdentityForHost({ happierHomeDir: configuration.happyHomeDir,
                        serverId: home.serverId, environmentId });
                    cleanup.push(async () => {
                        const filter = `label=com.docker.compose.project=${identity.projectName}`;
                        const containers = await execute('docker', ['ps', '--all', '--filter', filter, '--quiet']);
                        for (const id of containers.stdout.trim().split('\n').filter(Boolean)) await execute('docker', ['rm', '--force', '--volumes', id]);
                        const networks = await execute('docker', ['network', 'ls', '--filter', filter, '--quiet']);
                        for (const id of networks.stdout.trim().split('\n').filter(Boolean)) {
                            // The private relay has no Compose label. Clean up remaining
                            // endpoints by exact ID on this isolated fixture network.
                            const network = await execute('docker', ['network', 'inspect', '--format', '{{json .Containers}}', id]);
                            const endpoints = z.record(z.string().regex(/^[a-f0-9]{64}$/u), z.unknown())
                                .nullable().parse(JSON.parse(network.stdout));
                            for (const endpoint of Object.keys(endpoints ?? {})) {
                                await execute('docker', ['rm', '--force', '--volumes', endpoint]);
                            }
                            await execute('docker', ['network', 'rm', id]);
                        }
                    });
                    return environmentId;
                };
                const environmentId = await createEnvironment('F14 native');
                const readEnvironment = async (selectedEnvironmentId = environmentId) => {
                    const result = DeploymentEnvironmentGetResultV1Schema.parse(await accepted('deployments.environments.get', {
                        serverId: home.serverId, environmentId: selectedEnvironmentId }));
                    if (!result.ok) throw new Error(result.error);
                    return result;
                };
                const containersByEnvironment = new Map<string, string>();
                const deploy = async (selectedEnvironmentId = environmentId) => {
                    const detail = await readEnvironment(selectedEnvironmentId);
                    const receipt = DeploymentReceiptResultV1Schema.parse(await accepted('deployments.deploy', {
                        serverId: home.serverId, environmentId: selectedEnvironmentId, targetLinkId: detail.environment.runtimeTargetLinkId,
                        requestKey: randomUUID() }));
                    expect(receipt).toMatchObject({ ok: true, state: 'succeeded' });
                    const identity = await resolveOwnServerDeploymentIdentityForHost({ happierHomeDir: configuration.happyHomeDir,
                        serverId: home.serverId, environmentId: selectedEnvironmentId });
                    const containers = await execute('docker', ['ps', '--filter', `label=com.docker.compose.project=${identity.projectName}`,
                        '--filter', 'label=com.docker.compose.service=web', '--format', '{{.ID}}']);
                    const ids = containers.stdout.trim().split('\n').filter(Boolean);
                    expect(ids).toHaveLength(1);
                    containersByEnvironment.set(selectedEnvironmentId, ids[0]);
                    const published = await execute('docker', ['port', ids[0], '3000/tcp']);
                    return `http://${published.stdout.trim()}`;
                };
                const measureRequests = async (appUrl: string, profileLocalReceiver = true) => {
                    const before = AppMeasurement.parse(await (await fetch(`${appUrl}/measurement`)).json());
                    // The receiver is mounted in this process; the SDK runs in
                    // Docker. Attribute sampled work by the receiver's own frames,
                    // and observe the real SQLite child stdin without replacing it.
                    const requests = async () => {
                        for (let request = 0; request < 2; request++) expect((await fetch(`${appUrl}/orders`)).status).toBe(200);
                        return (await fetch(`${appUrl}/flush`)).status;
                    };
                    const measured = profileLocalReceiver ? await measureReceiverWork(requests)
                        : { result: await requests(), work: null };
                    // SDK outage remains visible while application requests succeed.
                    const exports = ExportStatus.parse(await (await fetch(`${appUrl}/export-status`)).json());
                    const after = AppMeasurement.parse(await (await fetch(`${appUrl}/measurement`)).json());
                    expect(after.requests - before.requests).toBe(2);
                    expect(after.queries - before.queries).toBe(6);
                    return { receiver: measured.work,
                        sdkVersions: after.sdkVersions,
                        appCpu: { user: after.cpu.user - before.cpu.user, system: after.cpu.system - before.cpu.system },
                        appHeapUsedDelta: after.heapUsed - before.heapUsed,
                        sdk: exports, flushStatus: measured.result, requestCount: 2, spansPerRequest: 4 };
                };
                const readIngestClient = async (selectedEnvironmentId: string) => {
                    const container = containersByEnvironment.get(selectedEnvironmentId);
                    if (!container) throw new Error('F14 ingest probe requires a deployed fixture');
                    // Read this fixture's actual delivered SDK configuration. The
                    // secret stays in these closures; no assertion or log prints it.
                    const inspected = await execute('docker', ['inspect', '--format', '{{json .Config.Env}}', container]);
                    const variables = new Map(z.array(z.string()).parse(JSON.parse(inspected.stdout)).map(line => {
                        const separator = line.indexOf('=');
                        return [line.slice(0, separator), line.slice(separator + 1)] as const;
                    }));
                    const endpoint = variables.get('OTEL_EXPORTER_OTLP_ENDPOINT');
                    const encodedHeaders = variables.get('OTEL_EXPORTER_OTLP_HEADERS');
                    if (!endpoint || !encodedHeaders) throw new Error('F14 deploy did not deliver the SDK endpoint and headers');
                    const headers = Object.fromEntries(encodedHeaders.split(',').map(pair => {
                        const separator = pair.indexOf('=');
                        return [pair.slice(0, separator), decodeURIComponent(pair.slice(separator + 1))];
                    }));
                    return {
                        endpoint,
                        async send(input: Readonly<{ endpoint?: string; authorization?: 'missing' | 'invalid'; serviceName?: string; at?: number }> = {}) {
                            const traceId = randomUUID().replaceAll('-', '');
                            const at = BigInt(input.at ?? Date.now()) * 1_000_000n;
                            const response = await fetch(`${input.endpoint ?? endpoint}/v1/traces`, {
                                method: 'POST', headers: { 'Content-Type': 'application/json',
                                    ...(input.authorization === 'missing' ? {} : input.authorization === 'invalid'
                                        ? { Authorization: 'Bearer unknown-f14-token' } : headers) },
                                body: JSON.stringify({ resourceSpans: [{ resource: { attributes: [
                                    { key: 'service.name', value: { stringValue: input.serviceName ?? 'f14-probe' } },
                                    { key: 'happier.environment.id', value: { stringValue: input.serviceName ?? selectedEnvironmentId } },
                                ] }, scopeSpans: [{ spans: [{ traceId, spanId: randomUUID().replaceAll('-', '').slice(0, 16),
                                    name: 'SELECT probe', kind: 3, startTimeUnixNano: String(at), endTimeUnixNano: String(at + 1_000_000n),
                                    attributes: [{ key: 'db.system', value: { stringValue: 'postgresql' } },
                                        { key: 'db.query.text', value: { stringValue: 'SELECT 1' } }] }] }] }] }),
                            });
                            const status = response.status;
                            await response.arrayBuffer();
                            return { status, traceId };
                        },
                    };
                };
                const offMeasurement = await measureRequests(await deploy());
                expect(offMeasurement.sdk.exportedRecords).toBe(0);
                expect(offMeasurement.sdk.failedBatches).toBeGreaterThan(0);
                // G1: the same credentialed executor reaches this native Home
                // and daemon and performs actual Docker/Postgres effects before
                // the role-off refusal is evaluated.
                const control = await readEnvironment();
                expect(control.environment.id).toBe(environmentId);
                const beforeSetup = { ...setupRequests };
                const roleOff = await support.settlePublicApproval(invoke, await invoke('deployments.environments.telemetry.set', {
                    serverId: home.serverId, environmentId, expectedRevision: control.environment.revision,
                    collector: { machineId: home.machineId } }));
                expect(roleOff).toMatchObject({ ok: false, errorCode: 'telemetry_role_inactive' });
                const role = await accepted('machines.roles.get', { serverId: home.serverId, machineId: home.machineId });
                const currentRoles = getReadyRoles(role);
                await accepted('machines.roles.set', { serverId: home.serverId, machineId: home.machineId,
                    expectedPolicy: currentRoles.policy, expectedMetadataVersion: currentRoles.metadataVersion,
                    policy: { active: [...new Set([...CORE_MACHINE_ROLE_IDS_V1, DATABASE_TELEMETRY_MACHINE_ROLE_ID_V1])] } });
                // The authored fixture explicitly republishes the same real module
                // after the real role mutation. Production daemon live-refresh
                // coverage belongs to its runtime owner, not this constructed host.
                const activeContributes = await readContributes(mounted.happyHomeDir);
                const active = await runWithServerHttpBaseUrl(home.baseUrl, () => createAdmittedPluginRuntimeFixture({
                    controller: pluginReloadController, happyHomeDir: mounted.happyHomeDir,
                    runtimeOptions: { ...runtimeOptions, contributes: activeContributes,
                        generationAuthority: mounted.committed, preparedActivationGraphsByPluginId: mounted.preparedActivationGraphsByPluginId,
                        pluginIds: deploymentPluginIds },
                }));
                cleanup.push(() => active.dispose());
                const activationDiagnostics = collectBlockingPluginReloadDiagnostics(active.registry, [DATABASE_CAPTURE_PLUGIN.manifest.id]);
                expect(activationDiagnostics.flatMap(({ diagnostics }) => diagnostics.map(({ code, stage, message }) => ({
                    code, stage, message,
                })))).toEqual([]);
                const setup = await accepted('deployments.environments.telemetry.set', {
                    serverId: home.serverId, environmentId, expectedRevision: control.environment.revision,
                    collector: { machineId: home.machineId },
                    ...(process.env.HAPPIER_RUN_DBW_METRICS_F15 === '1' || process.env.HAPPIER_RUN_DBW_COSTS_F17 === '1'
                        || process.env.HAPPIER_RUN_DBW_EXCEPTIONS_F18A === '1'
                        ? { capabilities: { ...(process.env.HAPPIER_RUN_DBW_METRICS_F15 === '1' ? { metrics: true } : {}),
                            ...(process.env.HAPPIER_RUN_DBW_COSTS_F17 === '1' ? { appLlmCost: true } : {}),
                            ...(process.env.HAPPIER_RUN_DBW_EXCEPTIONS_F18A === '1' ? { exceptions: true } : {}) } } : {}) });
                expect(setup).toMatchObject({ ok: true, state: 'redeploy_required' });
                const configured = await readEnvironment();
                expect(configured.environment.telemetryMachineId).toBe(home.machineId);
                const stored = await support.nativeDeploymentArtifacts(home).read(configured.environment.contentArtifactId);
                if (!stored || typeof stored.body !== 'string') throw new Error('F14 requires opened native Environment content');
                const content = DeploymentEnvironmentContentV1Schema.parse(JSON.parse(stored.body));
                const owned = content.bindings.filter((binding): binding is Extract<typeof binding, { purpose: 'variable' }> =>
                    binding.purpose === 'variable' && binding.managedBy === 'telemetry');
                expect(owned.map(binding => binding.name).sort()).toEqual([...TELEMETRY_EXPORT_ENVIRONMENT_KEYS_V1].sort());
                expect(owned).toEqual(expect.arrayContaining([
                    expect.objectContaining({ name: 'OTEL_EXPORTER_OTLP_ENDPOINT', source: { kind: 'deploymentFact', fact: 'telemetryEndpoint' } }),
                    expect.objectContaining({ name: 'OTEL_EXPORTER_OTLP_HEADERS', source: expect.objectContaining({ kind: 'secret' }) }),
                ]));
                expect(setupRequests.bindings - beforeSetup.bindings).toBe(1);
                expect(setupRequests.secretCreate - beforeSetup.secretCreate).toBe(1);
                expect(setupRequests.secretUpdate - beforeSetup.secretUpdate).toBe(0);
                const afterSetup = { ...setupRequests };
                const unchanged = await accepted('deployments.environments.telemetry.set', {
                    serverId: home.serverId, environmentId, expectedRevision: configured.environment.revision,
                    collector: { machineId: home.machineId } });
                expect(unchanged).toMatchObject({ ok: true, revision: configured.environment.revision });
                expect(setupRequests).toEqual(afterSetup);
                const onMeasurement = await measureRequests(await deploy());
                expect(onMeasurement.flushStatus).toBe(200);
                expect(onMeasurement.sdk.exportedRecords, 'Both requests and their queries must receive successful collector HTTP responses').toBeGreaterThanOrEqual(8);
                if (!offMeasurement.receiver || !onMeasurement.receiver) throw new Error('F14 local receiver profiling must be enabled');
                expect(offMeasurement.receiver.storeStatements).toBe(0);
                expect(onMeasurement.receiver.storeStatements).toBeGreaterThan(0);
                // capture.ts persists each accepted record with one summary
                // insert and one detail insert; sampling never adds a third write.
                expect(onMeasurement.receiver.storeStatements).toBeLessThanOrEqual(2 * onMeasurement.sdk.exportedRecords);
                // Sampling is an observation, never a timing/allocation threshold.
                // Emit it before read acceptance so a missing public producer
                // does not discard the independently observed receiver work.
                console.info('F14 paired receiver measurement', { encryptionMode, receiverPid: process.pid,
                    attribution: 'V8 sampled inclusive receiver stacks; statement observer overhead included',
                    off: offMeasurement, on: onMeasurement,
                    onPerSpan: { sampledCpuMicros: onMeasurement.receiver.sampledCpuMicros / onMeasurement.sdk.exportedRecords,
                        sampledAllocationBytes: onMeasurement.receiver.sampledAllocationBytes / onMeasurement.sdk.exportedRecords,
                        storeStatements: onMeasurement.receiver.storeStatements / onMeasurement.sdk.exportedRecords } });
                const captureSource = { kind: 'environment' as const, serverId: home.serverId, environmentId };
                const queries = DatabaseCaptureQueriesListResultV1Schema.parse(await accepted(DATABASE_CAPTURE_QUERIES_LIST_ACTION_ID_V1, {
                    source: captureSource, page: { limit: 6 } }));
                expect(queries.ok, 'SDK HTTP success must be observable through the real admitted Queries Action').toBe(true);
                if (!queries.ok) throw new Error(`F14 queries unavailable: ${queries.code}`);
                expect(queries.items).toHaveLength(6);
                expect(queries.items.every(query => query.source === 'otlp' && query.kind === 'query')).toBe(true);
                expect(new Set(queries.items.map(query => query.shape)).size).toBe(1);
                const traces = DatabaseCaptureTracesListResultV1Schema.parse(await accepted(DATABASE_CAPTURE_TRACES_LIST_ACTION_ID_V1, {
                    source: captureSource, page: { limit: 2 } }));
                expect(traces.ok).toBe(true);
                if (!traces.ok) throw new Error(`F14 traces unavailable: ${traces.code}`);
                expect(traces.items).toHaveLength(2);
                for (const request of traces.items) {
                    expect(request).toMatchObject({ source: 'otlp', endpointMethod: 'GET', endpointRoute: '/orders' });
                    const trace = DatabaseCaptureTraceGetResultV1Schema.parse(await accepted(DATABASE_CAPTURE_TRACE_GET_ACTION_ID_V1, {
                        source: captureSource, traceId: request.traceId, page: { limit: 4 } }));
                    expect(trace.ok).toBe(true);
                    if (!trace.ok) throw new Error(`F14 trace unavailable: ${trace.code}`);
                    expect(trace.summaries).toHaveLength(4);
                    expect(trace.repeatedQueries).toEqual(expect.arrayContaining([
                        expect.objectContaining({ repetitionCount: 3 }),
                    ]));
                }
                for (const query of queries.items) {
                    const detail = DatabaseCaptureQueryGetResultV1Schema.parse(await accepted(DATABASE_CAPTURE_QUERY_GET_ACTION_ID_V1, {
                        source: captureSource, id: query.id }));
                    expect(detail.ok).toBe(true);
                    if (!detail.ok) throw new Error(`F14 query unavailable: ${detail.code}`);
                    expect(detail.detail).not.toBeNull();
                    expect(JSON.stringify(detail.detail)).not.toContain('must-be-masked');
                }
                const beforeReaders = await readEnvironment();
                await accepted('deployments.environments.update', { serverId: home.serverId, environmentId,
                    expectedRevision: beforeReaders.environment.revision,
                    contentArtifactId: beforeReaders.environment.contentArtifactId,
                    contentHeaderVersion: beforeReaders.environment.contentHeaderVersion,
                    contentBodyVersion: beforeReaders.environment.contentBodyVersion,
                    patch: { dataEditorMode: 'chosen', dataEditors: [{ kind: 'team', teamId: sourceTeam.id }] } });
                // Source membership inherits the native content grants. The
                // existing keyholder read delivers recipient envelopes in E2EE.
                const ownerArtifacts = createCredentialedAccountArtifactStore(credentials);
                for (const artifactId of [beforeReaders.environment.contentArtifactId,
                    ...beforeReaders.targetLinks.map(link => link.contentArtifactId)]) {
                    expect(await runWithServerHttpBaseUrl(home.baseUrl, () => ownerArtifacts.readHeader(artifactId))).not.toBeNull();
                }
                const teammateEnvironment = DeploymentEnvironmentGetResultV1Schema.parse(await teammate.accepted(
                    'deployments.environments.get', { serverId: home.serverId, environmentId }));
                expect(teammateEnvironment.ok, 'D29 starts with the teammate\'s real Environment read').toBe(true);
                await assertNoTeammateMachineGrant([home.machineId]);
                const teammateQueries = DatabaseCaptureQueriesListResultV1Schema.parse(await teammate.accepted(
                    DATABASE_CAPTURE_QUERIES_LIST_ACTION_ID_V1, { source: captureSource, page: { limit: 6 } }, home.machineId));
                expect(teammateQueries.ok).toBe(true);
                if (!teammateQueries.ok) throw new Error(`F14 teammate queries unavailable: ${teammateQueries.code}`);
                expect(teammateQueries.items).toEqual(queries.items);
                const teammateTraces = DatabaseCaptureTracesListResultV1Schema.parse(await teammate.accepted(
                    DATABASE_CAPTURE_TRACES_LIST_ACTION_ID_V1, { source: captureSource, page: { limit: 2 } }, home.machineId));
                expect(teammateTraces.ok).toBe(true);
                if (!teammateTraces.ok) throw new Error(`F14 teammate traces unavailable: ${teammateTraces.code}`);
                expect(teammateTraces.items).toEqual(traces.items);
                const denied = await outsider.invoke(DATABASE_CAPTURE_QUERIES_LIST_ACTION_ID_V1, {
                    source: captureSource, page: { limit: 6 } }, home.machineId);
                if (denied.ok) expect(DatabaseCaptureQueriesListResultV1Schema.parse(denied.result).ok).toBe(false);
                else expect(denied.effectAttempted).not.toBe(true);
                const collectorOperator = await createReader({ consentToFixtureHost: true });
                const operatorTeam = await db.team.create({ data: { name: 'F14 collector operators' } });
                await db.teamMembership.createMany({ data: [
                    { teamId: operatorTeam.id, accountId: home.accountId, role: 'owner' },
                    { teamId: operatorTeam.id, accountId: collectorOperator.accountId, role: 'owner' },
                ] });
                // Progress the operator from Use to Manage through reviewed grants.
                // The separate reader Team never receives a grant on either Machine.
                const grantCollectorHost = async (level: 'view' | 'admin') => {
                    await accepted(MACHINE_ACCESS_GRANT_SET_ACTION_ID_V1, { serverId: home.serverId, machineId: home.machineId,
                        principal: { kind: 'team', teamId: operatorTeam.id }, level });
                    const grant = await db.machineGrant.findFirst({
                        where: { machineId: home.machineId, teamId: operatorTeam.id },
                        select: { accessLevel: true },
                    });
                    expect(grant).toEqual({ accessLevel: level });
                    await accepted('machines.access.prepareKeys', { serverId: home.serverId, machineId: home.machineId });
                };
                await grantCollectorHost('view');
                const operatorSourceResponse = await fetch(`${home.baseUrl}/v1/projects/sources`, {
                    method: 'POST', headers: { Authorization: `Bearer ${collectorOperator.token}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ serverId: home.serverId, requestKey: randomUUID(), name: 'F14 deployed collector', audience: [],
                        owner: { kind: 'team', teamId: operatorTeam.id } }),
                });
                expect(operatorSourceResponse.status).toBe(200);
                const operatorSource = ProjectSourcesCreateOutputV1Schema.parse(await operatorSourceResponse.json());
                if (!operatorSource.ok) throw new Error(operatorSource.error);
                // The deployed collector journey consumes this same real Home,
                // native Compose owner and credentialed Action executor.
                const secondCollector = await support.collectorAppJourney?.({ home, daemon, credentials, invoke, accepted,
                    prepare, createEnvironment, readEnvironment, cleanup, signal: lifetime.signal, nativeDockerEngineId,
                    nativeDocker: args => execute('docker', [...args]),
                    initiator: { ...collectorOperator, projectSourceId: operatorSource.source.id, teamId: operatorTeam.id,
                        grantHostManage: async () => {
                            expect(await db.deploymentEnvironment.count({ where: { projectSourceId: operatorSource.source.id } })).toBe(0);
                            await grantCollectorHost('admin');
                        } } });
                const otherEnvironmentId = await createEnvironment('F14 isolation control');
                const other = await readEnvironment(otherEnvironmentId);
                await accepted('deployments.environments.telemetry.set', { serverId: home.serverId,
                    environmentId: otherEnvironmentId, expectedRevision: other.environment.revision, collector: { machineId: home.machineId } });
                const otherAppUrl = await deploy(otherEnvironmentId);
                const otherMeasurement = await measureRequests(otherAppUrl);
                expect(otherMeasurement.sdk.exportedRecords).toBeGreaterThanOrEqual(8);
                const otherSource = { ...captureSource, environmentId: otherEnvironmentId };
                const listQueries = async (source = captureSource, machineId?: string) => {
                    const result = DatabaseCaptureQueriesListResultV1Schema.parse(await accepted(DATABASE_CAPTURE_QUERIES_LIST_ACTION_ID_V1, {
                        source, page: { limit: 20 } }, machineId));
                    if (!result.ok) throw new Error(`F14 queries unavailable: ${result.code}`);
                    return result.items;
                };
                const assertSourceUnavailable = async () => {
                    for (const [actionId, schema] of [
                        [DATABASE_CAPTURE_QUERIES_LIST_ACTION_ID_V1, DatabaseCaptureQueriesListResultV1Schema],
                        [DATABASE_CAPTURE_TRACES_LIST_ACTION_ID_V1, DatabaseCaptureTracesListResultV1Schema],
                    ] as const) {
                        const response = await invoke(actionId, { source: captureSource, page: { limit: 6 } });
                        if (response.ok) expect(schema.parse(response.result)).toMatchObject({ ok: false, status: 'unavailable' });
                        else expect(response.effectAttempted).not.toBe(true);
                    }
                };
                const otherQueries = await listQueries(otherSource);
                expect(otherQueries).toHaveLength(6);
                expect(otherQueries.some(query => queries.items.some(first => first.id === query.id))).toBe(false);
                const originalClient = await readIngestClient(environmentId);
                const forged = await originalClient.send({ serviceName: otherEnvironmentId });
                expect(forged.status).toBe(200);
                expect((await listQueries()).some(query => query.traceId === forged.traceId)).toBe(true);
                expect(await listQueries(otherSource)).toEqual(otherQueries);
                const beforeRefusal = await listQueries();
                // G1: authenticated ingest and both admitted partition reads have
                // succeeded before these HTTP trust-boundary refusals.
                for (const authorization of ['missing', 'invalid'] as const) {
                    expect((await originalClient.send({ authorization })).status).toBe(401);
                }
                expect(await listQueries()).toEqual(beforeRefusal);
                expect(await listQueries(otherSource)).toEqual(otherQueries);

                if (!secondCollector) throw new Error('F14 move acceptance requires the real deployed and enrolled collector App journey');
                expect(secondCollector.machineId).not.toBe(home.machineId);
                const collectorAccess = MachineAccessGrantsListResultV1Schema.parse(await accepted('machines.access.grants.list', {
                    serverId: home.serverId, machineId: secondCollector.machineId }));
                if (!('custodian' in collectorAccess)) throw new Error('F14 requires admitted access to the second collector Machine');
                expect(collectorAccess.custodian.accountId).not.toBe(home.accountId);
                expect(collectorAccess.ownAccessSources.some(source => source.principal.kind === 'team')).toBe(true);
                const selectCollector = async (machineId: string) => {
                    const current = await readEnvironment();
                    await accepted('deployments.environments.telemetry.set', { serverId: home.serverId, environmentId,
                        expectedRevision: current.environment.revision, collector: { machineId }, confirmDelete: true });
                    await secondCollector.prepareEnvironment(environmentId);
                };
                const localPartitions = async () => {
                    const runtime = localCaptureBackground.readRuntime();
                    if (!runtime) throw new Error('F14 requires the running production receiver/store');
                    return runtime.store.listPartitions();
                };
                await selectCollector(secondCollector.machineId);
                await vi.waitFor(async () => expect(await localPartitions()).not.toContain(telemetryPartition(environmentId)));
                // The old collector still admits B. A's token cannot mutate B
                // after A has moved away, even with forged resource labels.
                expect((await originalClient.send({ serviceName: otherEnvironmentId })).status).toBe(401);
                expect(await listQueries(otherSource)).toEqual(otherQueries);
                const listMovedQueries = () => listQueries(captureSource, secondCollector.machineId);
                expect(await listMovedQueries()).toEqual([]);
                const movedAppUrl = await deploy();
                // M2's receiver runs in its own deployed daemon. The original
                // process's inspector cannot attribute work performed there.
                const movedMeasurement = await measureRequests(movedAppUrl, false);
                expect(movedMeasurement.sdk.exportedRecords).toBeGreaterThanOrEqual(8);
                const movedQueries = await listMovedQueries();
                expect(movedQueries).toHaveLength(6);
                expect(movedQueries.some(query => queries.items.some(previous => previous.id === query.id))).toBe(false);
                if (process.env.HAPPIER_RUN_DBW_METRICS_F15 === '1' || process.env.HAPPIER_RUN_DBW_COSTS_F17 === '1'
                    || process.env.HAPPIER_RUN_DBW_EXCEPTIONS_F18A === '1') {
                    const invokeOnCollector: Invoke = (name, input) => invoke(name, input, secondCollector.machineId);
                    const acceptedOnCollector = async (name: string, input: unknown) => {
                        const result = await support.settlePublicApproval(invokeOnCollector, await invokeOnCollector(name, input));
                        expect(result.ok, JSON.stringify(result)).toBe(true);
                        if (!result.ok) throw new Error(`Telemetry collector Action refused: ${result.errorCode}`);
                        return result.result;
                    };
                    if (process.env.HAPPIER_RUN_DBW_METRICS_F15 === '1') {
                        await runProductionMetricsJourney({ serverId: home.serverId, serverUrl: home.baseUrl, environmentId,
                            collectorMachineId: secondCollector.machineId, appUrl: movedAppUrl, credentials,
                            signal: lifetime.signal, accepted, acceptedOnCollector });
                    }
                    if (process.env.HAPPIER_RUN_DBW_COSTS_F17 === '1') {
                        const agentSessionId = await createProductionCostsAgentBaseline({ serverUrl: home.baseUrl,
                            machineId: home.machineId, credentials, signal: lifetime.signal });
                        await runProductionCostsJourney({ serverId: home.serverId, environmentId, appUrl: movedAppUrl,
                            signal: lifetime.signal, agentSessionId, collectorMachineId: secondCollector.machineId, acceptedOnCollector,
                            owner: { accountId: home.accountId, accepted }, teammate });
                    }
                    if (process.env.HAPPIER_RUN_DBW_EXCEPTIONS_F18A === '1') {
                        await runProductionExceptionsJourney({ serverId: home.serverId, environmentId, appUrl: movedAppUrl,
                            signal: lifetime.signal, teamId: sourceTeam.id, acceptedOnCollector,
                            owner: { accountId: home.accountId, accepted }, teammate });
                    }
                }
                await secondCollector.restart();
                expect(await listMovedQueries()).toEqual(movedQueries);
                const movedReaderQueries = DatabaseCaptureQueriesListResultV1Schema.parse(await teammate.accepted(
                    DATABASE_CAPTURE_QUERIES_LIST_ACTION_ID_V1, { source: captureSource, page: { limit: 20 } }, secondCollector.machineId));
                expect(movedReaderQueries.ok).toBe(true);
                if (!movedReaderQueries.ok) throw new Error(`F14 moved teammate queries unavailable: ${movedReaderQueries.code}`);
                expect(movedReaderQueries.items).toEqual(movedQueries);
                const movedReaderTraces = DatabaseCaptureTracesListResultV1Schema.parse(await teammate.accepted(
                    DATABASE_CAPTURE_TRACES_LIST_ACTION_ID_V1, { source: captureSource, page: { limit: 2 } }, secondCollector.machineId));
                expect(movedReaderTraces.ok).toBe(true);
                if (!movedReaderTraces.ok) throw new Error(`F14 moved teammate traces unavailable: ${movedReaderTraces.code}`);
                expect(movedReaderTraces.items).toHaveLength(2);
                await assertNoTeammateMachineGrant([home.machineId, secondCollector.machineId]);
                expect(await inTx(tx => removeTeamMemberForActorInTx(tx, { teamId: sourceTeam.id,
                    actorAccountId: teammate.accountId }))).toMatchObject({ ok: true });
                const withdrawn = await teammate.invoke(DATABASE_CAPTURE_QUERIES_LIST_ACTION_ID_V1, {
                    source: captureSource, page: { limit: 6 } }, secondCollector.machineId);
                if (withdrawn.ok) expect(DatabaseCaptureQueriesListResultV1Schema.parse(withdrawn.result).ok).toBe(false);
                else expect(withdrawn.effectAttempted).not.toBe(true);

                // Change the assignment while its old collector is offline.
                // Reconnecting then selecting it again must not resurrect its
                // old partition. Read through the admitted source each time.
                await secondCollector.stop();
                await selectCollector(home.machineId);
                await secondCollector.start();
                expect(await listQueries()).toEqual([]);
                await selectCollector(secondCollector.machineId);
                expect(await listMovedQueries()).toEqual([]);
                await selectCollector(home.machineId);
                const returnedAppUrl = await deploy();
                expect((await measureRequests(returnedAppUrl)).sdk.exportedRecords).toBeGreaterThanOrEqual(8);
                expect(await listQueries()).toHaveLength(6);
                expect(await listQueries(otherSource)).toEqual(otherQueries);

                const beforeRotate = await readEnvironment();
                const beforeRotateClient = await readIngestClient(environmentId);
                await accepted('deployments.environments.telemetry.set', { serverId: home.serverId, environmentId,
                    expectedRevision: beforeRotate.environment.revision, rotate: true });
                expect((await beforeRotateClient.send()).status).toBe(200);
                await deploy();
                const rotatedClient = await readIngestClient(environmentId);
                expect((await rotatedClient.send()).status).toBe(200);
                expect((await beforeRotateClient.send({ endpoint: rotatedClient.endpoint })).status).toBe(401);
                expect(await listQueries(otherSource)).toEqual(otherQueries);

                const expired = await rotatedClient.send({ at: Date.now() - 2 * 86_400_000 });
                expect(expired.status).toBe(200);
                expect((await listQueries()).some(query => query.traceId === expired.traceId)).toBe(true);
                if (!active.registry.runDaemonDatabaseRetention) throw new Error('F14 requires the registered plugin retention owner');
                const retentionErrors: unknown[] = [];
                const maintenanceLogs = createLogRetentionOwner({ happyHomeDir: configuration.happyHomeDir, currentLogPaths: () => [],
                    daemonDatabases: { runRetention: active.registry.runDaemonDatabaseRetention }, onError: error => retentionErrors.push(error) });
                const retention = await maintenanceLogs.run(1, Date.now());
                expect(retentionErrors).toEqual([]);
                expect(retention.pruned).toBeGreaterThanOrEqual(2);
                expect((await listQueries()).some(query => query.traceId === expired.traceId)).toBe(false);
                expect((await listQueries()).length).toBeGreaterThan(0);
                expect(await listQueries(otherSource)).toEqual(otherQueries);

                const beforeOff = await readEnvironment();
                await accepted('deployments.environments.telemetry.set', { serverId: home.serverId, environmentId,
                    expectedRevision: beforeOff.environment.revision, collector: null, confirmDelete: true });
                await assertSourceUnavailable();
                // Physical removal supplements the public source withdrawal
                // and sibling read acceptance; it cannot replace either.
                const partitions = async () => {
                    const runtime = localCaptureBackground.readRuntime();
                    if (!runtime) throw new Error('F14 requires the running production receiver/store');
                    return runtime.store.listPartitions();
                };
                await vi.waitFor(async () => expect(await partitions()).not.toContain(telemetryPartition(environmentId)));
                expect(await partitions()).toContain(telemetryPartition(otherEnvironmentId));
                expect((await rotatedClient.send()).status).toBe(401);
                expect(await listQueries(otherSource)).toEqual(otherQueries);

                const beforeEnable = await readEnvironment();
                await accepted('deployments.environments.telemetry.set', { serverId: home.serverId, environmentId,
                    expectedRevision: beforeEnable.environment.revision, collector: { machineId: home.machineId } });
                const reenabledAppUrl = await deploy();
                const reenabledClient = await readIngestClient(environmentId);
                const deleteControl = await reenabledClient.send();
                expect(deleteControl.status).toBe(200);
                expect((await listQueries()).some(query => query.traceId === deleteControl.traceId)).toBe(true);
                const beforeDelete = await readEnvironment();
                await accepted('deployments.environments.delete', { serverId: home.serverId, environmentId,
                    expectedRevision: beforeDelete.environment.revision, requestKey: randomUUID(), detachKeepRunning: true });
                await assertSourceUnavailable();
                await vi.waitFor(async () => expect(await partitions()).not.toContain(telemetryPartition(environmentId)));
                expect((await reenabledClient.send()).status).toBe(401);
                expect(await partitions()).toContain(telemetryPartition(otherEnvironmentId));
                expect(await listQueries(otherSource)).toEqual(otherQueries);
                // Detaching a running app still serves requests after its
                // Environment is deleted and its next export is refused.
                expect((await fetch(`${reenabledAppUrl}/orders`)).status).toBe(200);
            } finally {
                const failures: unknown[] = [];
                for (const dispose of cleanup.reverse()) try { await dispose(); } catch (error) { failures.push(error); }
                vi.restoreAllMocks();
                vi.unstubAllEnvs();
                if (failures.length) throw new AggregateError(failures, 'F14 fixture cleanup failed');
            }
        }, 0);
    });
}

const ExportStatus = z.object({ successfulBatches: z.number().int().nonnegative(), failedBatches: z.number().int().nonnegative(),
    exportedRecords: z.number().int().nonnegative() });
const AppMeasurement = z.object({ cpu: z.object({ user: z.number(), system: z.number() }), heapUsed: z.number(),
    sdkVersions: z.object({ node: z.string(), sdkNode: z.string(), sdkTraceBase: z.string(), exporter: z.string() }),
    requests: z.number().int().nonnegative(), queries: z.number().int().nonnegative() });
const FixtureImageIdentity = z.object({ Id: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
    RepoTags: z.array(z.string()).nullable().optional(), RepoDigests: z.array(z.string()).nullable().optional(),
    Descriptor: z.unknown().optional(), Os: z.string(), Architecture: z.string(), Variant: z.string().optional() });

function getReadyRoles(value: unknown) {
    const result = MachineRolesGetResultV1Schema.parse(value);
    if (result.status !== 'ready') throw new Error(`F14 roles unavailable: ${result.status}`);
    return result;
}

/** Profile the real receiver and observe only capture-table statements crossing
 * the SQLite process boundary. No SQL operands or exporter headers are retained. */
async function measureReceiverWork<T>(operation: () => Promise<T>) {
    const session = new Session();
    session.connect();
    // Docker-host database-worker stdin is a Socket with its own write method.
    const writes = vi.spyOn(Socket.prototype, 'write');
    try {
        await session.post('Profiler.enable');
        await session.post('Profiler.start');
        // V8 supports collected-object sampling; the retained Node declarations
        // omit those protocol fields. Keep this extension at the inspector boundary.
        const sampling: HeapProfiler.StartSamplingParameterType & {
            includeObjectsCollectedByMajorGC: boolean; includeObjectsCollectedByMinorGC: boolean;
        } = {
            includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true,
        };
        await session.post('HeapProfiler.startSampling', sampling);
        const result = await operation();
        const { profile: allocations } = await session.post('HeapProfiler.stopSampling');
        const { profile: cpu } = await session.post('Profiler.stop');
        // store/ includes ingest.ts after async resumption, when those frames
        // no longer descend synchronously from the receiver stack.
        const ownsFrame = (url: string) => /\/packages\/plugins\/telemetry\/src\/(?:otlp\/|store\/|runtime\.)/u.test(url.replaceAll('\\', '/'));
        const attributed = new Set<number>();
        const nodes = new Map(cpu.nodes.map(node => [node.id, node]));
        const visitCpu = (node: Profiler.ProfileNode, owned: boolean) => {
            owned ||= ownsFrame(node.callFrame.url);
            if (owned) attributed.add(node.id);
            for (const id of node.children ?? []) {
                const child = nodes.get(id);
                if (child) visitCpu(child, owned);
            }
        };
        visitCpu(cpu.nodes[0], false);
        let sampledCpuMicros = 0;
        for (const [index, id] of (cpu.samples ?? []).entries()) {
            if (attributed.has(id)) sampledCpuMicros += cpu.timeDeltas?.[index] ?? 0;
        }
        const allocationBytes = (node: HeapProfiler.SamplingHeapProfileNode, owned = false): number => {
            owned ||= ownsFrame(node.callFrame.url);
            return (owned ? node.selfSize : 0) + node.children.reduce((sum, child) => sum + allocationBytes(child, owned), 0);
        };
        let storeStatements = 0;
        for (const [chunk] of writes.mock.calls) {
            if (typeof chunk !== 'string' && !Buffer.isBuffer(chunk)) continue;
            const line = chunk.toString();
            if (!line.startsWith('{') || !line.includes('captureSummaries') && !line.includes('captureDetails')) continue;
            let message: unknown;
            try { message = JSON.parse(line); } catch { continue; }
            if (message && typeof message === 'object' && 'kind' in message && message.kind === 'run'
                && 'sql' in message && typeof message.sql === 'string' && /^INSERT INTO capture(?:Summaries|Details)\b/u.test(message.sql)) storeStatements++;
        }
        return { result, work: { sampledCpuMicros, sampledAllocationBytes: allocationBytes(allocations.head), storeStatements } };
    } finally {
        writes.mockRestore();
        await Promise.allSettled([session.post('Profiler.disable'), session.post('HeapProfiler.disable')]);
        session.disconnect();
    }
}
