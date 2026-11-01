import type { RpcHandlerContext, RpcHandlerRegistrar } from '@/api/rpc/types';
import { AGENTS, type AgentCatalogEntry } from '@/backends/catalog';
import { checklists } from '@/capabilities/checklists';
import { buildDetectContext } from '@/capabilities/context/buildDetectContext';
import { buildCliCapabilityData } from '@/capabilities/probes/cliBase';
import { tmuxCapability } from '@/capabilities/registry/toolTmux';
import { windowsTerminalCapability } from '@/capabilities/registry/toolWindowsTerminal';
import { executionRunsCapability } from '@/capabilities/registry/toolExecutionRuns';
import { systemTasksCapability } from '@/capabilities/registry/toolSystemTasks';
import { installableDepCapabilities } from '@/capabilities/registry/installableDeps';
import { withProviderCliUpdates } from '@/capabilities/cliUpdate/providerCliUpdates';
import { createCapabilitiesService } from '@/capabilities/service';
import type { Capability } from '@/capabilities/service';
import type {
    CapabilitiesDescribeResponse,
    CapabilitiesDetectRequest,
    CapabilitiesDetectResponse,
    CapabilitiesInvokeRequest,
    CapabilitiesInvokeResponse,
} from '@/capabilities/types';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { probeAgentModelsBestEffort } from '@/capabilities/probes/agentModelsProbe';
import { probeAgentModesBestEffort } from '@/capabilities/probes/agentModesProbe';
import { probeAgentConfigOptionsBestEffort } from '@/capabilities/probes/agentConfigOptionsProbe';
import { probeAgentCatalogs } from '@/capabilities/probes/agentCatalogsProbe';
import { remainingCatalogProbeMs, withCatalogProbeLifecycle, type CatalogProbeLifecycle, type NativeCatalogCleanup, type RegisterNativeCatalogCleanup } from '@/capabilities/probes/catalogProbeLifecycle';
import { buildAgentProbeCacheKey } from '@/capabilities/probes/buildAgentProbeCacheKey';
import { resolveAgentProbeVariant } from '@/capabilities/probes/resolveAgentProbeVariant';
import { createHash } from 'node:crypto';
import { validateEnvVarRecordStrict } from '@/terminal/runtime/envVarSanitization';
import { expandEnvironmentVariables } from '@/utils/expandEnvVars';
import { HAPPIER_SPAWN_EXPLICIT_ENV_KEYS_JSON_ENV_VAR, parseExplicitSpawnEnvKeysFromProcessEnv } from '@/daemon/spawn/spawnExplicitEnvKeysMarker';
import { logger } from '@/ui/logger';
import { stripDaemonOwnedChildEnvOverrides } from '@/daemon/spawn/stripDaemonOwnedChildEnvOverrides';
import { readCredentials } from '@/persistence';
import { bootstrapAccountSettingsContext } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import type { AgentId } from '@happier-dev/agents';
import { applyAgentRuntimeKindOverrideToAccountSettings } from '@happier-dev/agents';
import {
    BackendTargetRefSchema,
    ConnectedServiceBindingsV1Schema,
    type BackendTargetRefV1,
    type ConnectedServiceBindingsV1,
} from '@happier-dev/protocol';
import { invokeProviderCliInstall as invokeSharedProviderCliInstall } from '@/runtime/managedTools/invokeProviderCliInstall';
import { existsSync, statSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import os from 'node:os';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import { configuration } from '@/configuration';
import { createConnectedServiceMaterializationIdentity } from '@/daemon/connectedServices/materialize/createConnectedServiceMaterializationIdentity';
import { resolveConnectedServiceAuthForSpawn } from '@/daemon/connectedServices/resolveConnectedServiceAuthForSpawn';
import { HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY } from '@/daemon/connectedServices/connectedServiceChildEnvironment';
import { buildProfileEnvOverlay } from '@/settings/profiles/buildProfileEnvOverlay';
import { readProfilesFromAccountSettings } from '@/settings/profiles/readProfilesFromAccountSettings';
import { resolveProfileForAgent } from '@/settings/profiles/resolveProfileForAgent';
import type { PreflightSessionControlsProbeMethod as CliProbeMethod } from '@/capabilities/probes/preflightSessionControlsProbeAdapterTypes';

const DEFAULT_PROBE_MODELS_TIMEOUT_MS = 30_000;
// Only share an active launch. The composer lifecycle owns its settled catalog snapshot.
type CatalogProbeOperation = {
    controller: AbortController;
    promise: Promise<CapabilitiesInvokeResponse>;
    waiters: number;
    cleanup: NativeCatalogCleanup | null;
};
const catalogProbeRequests = new Map<string, CatalogProbeOperation>();

async function shareCatalogProbe(
    key: string,
    lifecycle: Required<CatalogProbeLifecycle>,
    run: (lifecycle: Required<CatalogProbeLifecycle>, registerCleanup?: RegisterNativeCatalogCleanup) => Promise<CapabilitiesInvokeResponse>,
    registerCleanup?: RegisterNativeCatalogCleanup,
): Promise<CapabilitiesInvokeResponse> {
    lifecycle.signal.throwIfAborted();
    let operation = catalogProbeRequests.get(key);
    if (operation?.controller.signal.aborted) operation = undefined;
    if (!operation) {
        const controller = new AbortController();
        const created: CatalogProbeOperation = {
            controller,
            waiters: 0,
            cleanup: null,
            promise: Promise.resolve().then(() => withCatalogProbeLifecycle(
                { ...lifecycle, signal: controller.signal },
                (sharedLifecycle) => run(sharedLifecycle, (cleanup) => { created.cleanup = cleanup; }),
                () => created.cleanup?.(),
            )),
        };
        operation = created;
        catalogProbeRequests.set(key, created);
        void created.promise.finally(() => {
            if (catalogProbeRequests.get(key) === created) catalogProbeRequests.delete(key);
        }).catch(() => undefined);
    }
    const shared = operation;
    registerCleanup?.(() => shared.controller.signal.aborted ? shared.cleanup?.() : undefined);
    shared.waiters += 1;
    let released = false;
    const release = () => {
        if (released) return;
        released = true;
        shared.waiters -= 1;
        if (shared.waiters === 0) {
            shared.controller.abort(lifecycle.signal.reason);
        }
    };
    lifecycle.signal.addEventListener('abort', release, { once: true });
    try {
        return await shared.promise;
    } finally {
        lifecycle.signal.removeEventListener('abort', release);
        release();
    }
}

function titleCase(value: string): string {
    if (!value) return value;
    return `${value[0].toUpperCase()}${value.slice(1)}`;
}

function isExistingDirectory(value: string): boolean {
    if (!value) return false;
    try {
        return statSync(value).isDirectory();
    } catch {
        return false;
    }
}

function resolveClosestExistingDirectory(value: string): string {
    let candidate = resolvePath(value);
    for (let attempt = 0; attempt < 32; attempt += 1) {
        if (isExistingDirectory(candidate)) return candidate;
        const parent = dirname(candidate);
        if (!parent || parent === candidate) break;
        candidate = parent;
    }
    return candidate;
}

function resolveProbeCwd(raw: unknown): string {
    const rawValue = typeof raw === 'string' ? raw.trim() : '';
    const fallback = (process.env.HOME ?? '').toString().trim() || os.homedir() || process.cwd();
    const initial = rawValue || process.cwd();

    const candidate = resolveClosestExistingDirectory(initial);
    if (isExistingDirectory(candidate)) return candidate;

    const fallbackCandidate = resolveClosestExistingDirectory(fallback);
    if (isExistingDirectory(fallbackCandidate)) return fallbackCandidate;

    const cwdCandidate = resolveClosestExistingDirectory(process.cwd());
    if (isExistingDirectory(cwdCandidate)) return cwdCandidate;

    return process.cwd();
}

function parseProbeConnectedServices(params?: Record<string, unknown>): ConnectedServiceBindingsV1 | null {
    const parsed = ConnectedServiceBindingsV1Schema.safeParse((params ?? {}).connectedServices);
    return parsed.success ? parsed.data : null;
}

function parseProbeProfileId(params?: Record<string, unknown>): string | null {
    const profileId = typeof params?.profileId === 'string' ? params.profileId.trim() : '';
    return profileId || null;
}

async function resolveProbeBackendContext(
    params?: Record<string, unknown>,
    options: Readonly<{ requireCredentials?: boolean }> = {},
): Promise<{
    backendTarget: BackendTargetRefV1 | undefined;
    credentials: Awaited<ReturnType<typeof readCredentials>> | null;
    accountSettings: Record<string, unknown> | null;
}> {
    const parsedBackendTarget = BackendTargetRefSchema.safeParse((params ?? {}).backendTarget);
    const backendTarget = parsedBackendTarget.success ? parsedBackendTarget.data : undefined;
    const runtimeKindOverride = (params ?? {}).runtimeKindOverride;
    const applyRuntimeOverride = (settings: Record<string, unknown> | null) => params?.agentId
        ? applyAgentRuntimeKindOverrideToAccountSettings({ agentId: params.agentId as AgentId, accountSettings: settings, runtimeKindOverride })
        : settings;

    const agentId = typeof params?.agentId === 'string' ? params.agentId : null;
    const needsAccountSettingsForProbes =
        agentId && (AGENTS[agentId as keyof typeof AGENTS] as AgentCatalogEntry | undefined)?.needsAccountSettingsForProbes === true;
    const profileId = parseProbeProfileId(params);
    const shouldLoadAccountSettings =
        backendTarget?.kind === 'configuredAcpBackend'
        || needsAccountSettingsForProbes
        || profileId !== null
        || options.requireCredentials === true;
    if (!shouldLoadAccountSettings) {
      return { backendTarget, credentials: null, accountSettings: applyRuntimeOverride(null) };
    }

    const credentials = await readCredentials().catch(() => null);
    if (!credentials) return { backendTarget, credentials: null, accountSettings: applyRuntimeOverride(null) };

    const accountSettingsContext = await bootstrapAccountSettingsContext({
        credentials,
        ...(params?.agentId ? { agentId: params.agentId as AgentId } : {}),
        backendTarget,
        mode: 'blocking',
        refresh: 'auto',
    }).catch(() => null);

    const accountSettings = accountSettingsContext?.settings ?? null;
    const effectiveAccountSettings = applyRuntimeOverride(accountSettings);

    return {
      backendTarget,
      credentials,
      accountSettings: effectiveAccountSettings,
    };
}

type ConnectedServiceProbeEnvironment = Readonly<{
    processEnv: NodeJS.ProcessEnv;
    connectedServiceSelectionCacheKey: string | null;
    cleanup: (() => Promise<void>) | null;
}>;

async function resolveProfileProbeEnvironment(params: Readonly<{
    agentId: AgentCatalogEntry['id'];
    profileId: string | null;
    credentials: Awaited<ReturnType<typeof readCredentials>> | null;
    accountSettings: Record<string, unknown> | null;
    processEnv: NodeJS.ProcessEnv;
}>): Promise<NodeJS.ProcessEnv> {
    if (!params.profileId) return params.processEnv;
    if (!params.credentials || !params.accountSettings) {
        throw new Error('Profile credentials or account settings are unavailable for this preflight probe');
    }

    const { customProfiles } = readProfilesFromAccountSettings(params.accountSettings);
    const profile = resolveProfileForAgent({
        agentId: params.agentId as AgentId,
        query: params.profileId,
        customProfiles,
    });
    const overlay = await buildProfileEnvOverlay({
        agentId: params.agentId,
        profile,
        accountSettings: params.accountSettings,
        credentials: params.credentials,
        processEnv: params.processEnv,
        promptSecretFn: null,
        startedBy: 'daemon',
    });
    const envOverlay = stripDaemonOwnedChildEnvOverrides(overlay.envOverlayExpanded);
    return {
        ...params.processEnv,
        ...envOverlay,
        [HAPPIER_SPAWN_EXPLICIT_ENV_KEYS_JSON_ENV_VAR]: JSON.stringify(Array.from(new Set([
            ...parseExplicitSpawnEnvKeysFromProcessEnv(params.processEnv),
            ...Object.keys(envOverlay),
        ]))),
    };
}

async function resolveConnectedServiceProbeEnvironment(params: Readonly<{
    agentId: AgentCatalogEntry['id'];
    cwd: string;
    connectedServices: ConnectedServiceBindingsV1 | null;
    credentials: Awaited<ReturnType<typeof readCredentials>> | null;
    accountSettings: Record<string, unknown> | null;
    requiresMaterializedAuth: boolean;
    processEnv: NodeJS.ProcessEnv;
    signal?: AbortSignal;
    onCleanup?: RegisterNativeCatalogCleanup;
}>): Promise<ConnectedServiceProbeEnvironment> {
    if (!params.requiresMaterializedAuth || !params.connectedServices) {
        return {
            processEnv: params.processEnv,
            connectedServiceSelectionCacheKey: null,
            cleanup: null,
        };
    }
    if (!params.credentials) {
        throw new Error('Connected-service credentials are unavailable for this preflight probe');
    }

    const materializationIdentity = createConnectedServiceMaterializationIdentity();
    const materializationBaseDir = join(configuration.happyHomeDir, 'daemon', 'connected-services', 'materialized');
    const resolved = await resolveConnectedServiceAuthForSpawn({
        agentId: params.agentId,
        materializationPurpose: 'probe',
        sessionDirectory: params.cwd,
        connectedServicesBindingsRaw: params.connectedServices,
        materializationKey: materializationIdentity.id,
        connectedServiceMaterializationIdentityV1: materializationIdentity,
        activeServerDir: configuration.activeServerDir,
        baseDir: materializationBaseDir,
        credentials: params.credentials,
        api: await (await import('@/api/api')).ApiClient.create(params.credentials),
        accountSettings: params.accountSettings,
        processEnv: params.processEnv,
        // A model/control probe observes current group authority but must never mutate the selected
        // group or trigger credential refresh. Actual spawn owns those lifecycle transitions.
        authGroupSwitchCoordinator: null,
        credentialRefreshService: null,
        signal: params.signal,
        onCleanup: params.onCleanup,
    });
    if (!resolved) {
        throw new Error('The selected connected-service account could not be materialized for this preflight probe');
    }

    return {
        processEnv: { ...params.processEnv, ...resolved.env },
        connectedServiceSelectionCacheKey:
            resolved.env[HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY] ?? null,
        cleanup: async () => {
            resolved.cleanupOnExit?.();
            resolved.cleanupOnFailure?.();
            await rm(join(materializationBaseDir, materializationIdentity.id), {
                recursive: true,
                force: true,
            });
        },
    };
}

async function invokeProviderCliInstall(
    agentId: AgentCatalogEntry['id'],
    params?: Record<string, unknown>,
    signal?: AbortSignal,
): Promise<CapabilitiesInvokeResponse> {
    const dryRun = params?.dryRun === true;
    const allowVendorRecipeExecution = params?.allowVendorRecipeExecution === true;
    const sharedParams = {
        ...(typeof params?.skipIfInstalled === 'boolean' ? { skipIfInstalled: params.skipIfInstalled } : {}),
        ...(typeof params?.platform === 'string' && params.platform.trim().length > 0 ? { platform: params.platform.trim() } : {}),
        ...(allowVendorRecipeExecution ? { allowVendorRecipeExecution: true } : {}),
    };

    if (!dryRun) {
        const preview = await invokeSharedProviderCliInstall({
            agentId: agentId as AgentId,
            params: { ...sharedParams, dryRun: true },
            env: process.env,
            nodePlatform: process.platform,
            signal,
        });

        if (!preview.ok) {
            return {
                ok: false,
                error: { message: preview.errorMessage, code: preview.errorCode },
                ...(preview.logPath ? { logPath: preview.logPath } : {}),
            };
        }

        if (preview.plan.installMode === 'vendor_recipe' && !allowVendorRecipeExecution) {
            return {
                ok: false,
                error: {
                    message: `Installing ${preview.plan.title} requires explicit confirmation before running vendor install commands.`,
                    code: 'install-confirmation-required',
                },
            };
        }
    }

    const result = await invokeSharedProviderCliInstall({
        agentId: agentId as AgentId,
        params: {
            ...sharedParams,
            ...(dryRun ? { dryRun: true } : {}),
        },
        env: process.env,
        nodePlatform: process.platform,
        signal,
    });

    if (!result.ok) {
        return {
            ok: false,
            error: { message: result.errorMessage, code: result.errorCode },
            ...(result.logPath ? { logPath: result.logPath } : {}),
        };
    }

    return { ok: true, result: { plan: result.plan, alreadyInstalled: result.alreadyInstalled, logPath: result.logPath ?? null } };
}

async function invokeCliProbeMethod(
    agentId: AgentCatalogEntry['id'],
    method: CliProbeMethod,
    params?: Record<string, unknown>,
    signal?: AbortSignal,
): Promise<CapabilitiesInvokeResponse> {
    if (params?.connectedServices !== undefined && params.connectedServices !== null
        && !ConnectedServiceBindingsV1Schema.safeParse(params.connectedServices).success) {
        return { ok: false, error: { code: 'invalid-request', message: 'Invalid selected connected-service bindings' } };
    }
    const timeoutMs = typeof params?.timeoutMs === 'number' ? params.timeoutMs : DEFAULT_PROBE_MODELS_TIMEOUT_MS;
    let cleanup: NativeCatalogCleanup | undefined;
    try {
        return await withCatalogProbeLifecycle({ timeoutMs, signal }, (lifecycle) =>
            prepareAndInvokeCliProbeMethod(agentId, method, params, lifecycle, (nativeCleanup) => { cleanup = nativeCleanup; }),
            () => cleanup?.());
    } catch (error) {
        logger.infoFile('[capabilities] Native catalog preflight failed', { agentId });
        return { ok: false, error: {
            code: 'preflight-catalog-unavailable',
            message: error instanceof Error ? error.message : 'Native catalog discovery failed',
        } };
    }
}

async function prepareAndInvokeCliProbeMethod(
    agentId: AgentCatalogEntry['id'],
    method: CliProbeMethod,
    params?: Record<string, unknown>,
    lifecycle?: Required<CatalogProbeLifecycle>,
    registerCleanup?: RegisterNativeCatalogCleanup,
): Promise<CapabilitiesInvokeResponse> {
    const connectedServices = parseProbeConnectedServices(params);
    const entry = AGENTS[agentId];
    const preflightAdapter = entry?.getPreflightSessionControlsProbeAdapter
        ? await entry.getPreflightSessionControlsProbeAdapter().catch(() => null)
        : null;
    if (lifecycle) remainingCatalogProbeMs(lifecycle);
    const hasSelectedConnectedAccount = Boolean(connectedServices && Object.values(connectedServices.bindingsByServiceId)
        .some((binding) => binding.source === 'connected'));
    const connectedServiceAuthStrategy = preflightAdapter?.connectedServiceAuth === 'materialized-env'
        ? 'materialized-env'
        : preflightAdapter?.connectedServiceAuth?.[method];
    if (hasSelectedConnectedAccount && !connectedServiceAuthStrategy) {
        return {
            ok: false,
            error: {
                code: 'connected-service-preflight-failed',
                message: 'This adapter cannot prepare the selected connected-service account for discovery.',
            },
        };
    }
    const requiresMaterializedAuth = connectedServiceAuthStrategy === 'materialized-env' && hasSelectedConnectedAccount;
    const probeContext = await resolveProbeBackendContext(
        { ...params, agentId },
        { requireCredentials: hasSelectedConnectedAccount && connectedServiceAuthStrategy !== 'not-required' },
    );
    if (lifecycle) remainingCatalogProbeMs(lifecycle);
    const timeoutMsRaw = (params ?? {}).timeoutMs;
    const timeoutMs = typeof timeoutMsRaw === 'number' ? timeoutMsRaw : DEFAULT_PROBE_MODELS_TIMEOUT_MS;
    const cwd = resolveProbeCwd((params ?? {}).cwd);
    const profileId = parseProbeProfileId(params);
    let profileProcessEnv: NodeJS.ProcessEnv;
    try {
        // The GUI supplies the launch owner's fully materialized profile map, including an
        // empty map when the selected secret should come from the machine environment.
        profileProcessEnv = method === 'probeCatalogs' && params?.environmentVariables !== undefined
            ? process.env
            : await resolveProfileProbeEnvironment({
            agentId,
            profileId,
            credentials: probeContext.credentials,
            accountSettings: probeContext.accountSettings,
            processEnv: process.env,
        });
    } catch {
        lifecycle?.signal.throwIfAborted();
        return {
            ok: false,
            error: {
                code: 'profile-preflight-failed',
                message: 'Could not prepare the selected backend profile for this probe.',
            },
        };
    }
    if (lifecycle) remainingCatalogProbeMs(lifecycle);
    const selectedEnv = validateEnvVarRecordStrict(params?.environmentVariables);
    if (!selectedEnv.ok) return { ok: false, error: { code: 'invalid-request', message: selectedEnv.error } };
    const selectedEnvOverlay = stripDaemonOwnedChildEnvOverrides(selectedEnv.env);
    profileProcessEnv = {
        ...profileProcessEnv,
        ...expandEnvironmentVariables(selectedEnvOverlay, { ...profileProcessEnv, ...selectedEnvOverlay }),
        [HAPPIER_SPAWN_EXPLICIT_ENV_KEYS_JSON_ENV_VAR]: JSON.stringify(Array.from(new Set([
            ...parseExplicitSpawnEnvKeysFromProcessEnv(profileProcessEnv),
            ...Object.keys(selectedEnvOverlay),
        ]))),
    };
    const runProbe = async (probeLifecycle = lifecycle, registerNativeCleanup = registerCleanup): Promise<CapabilitiesInvokeResponse> => {
        let connectedServiceProbeEnvironment: ConnectedServiceProbeEnvironment;
        try {
            connectedServiceProbeEnvironment = await resolveConnectedServiceProbeEnvironment({
                agentId,
                cwd,
                connectedServices,
                credentials: probeContext.credentials,
                accountSettings: probeContext.accountSettings,
                requiresMaterializedAuth,
                processEnv: profileProcessEnv,
                signal: probeLifecycle?.signal,
                onCleanup: registerNativeCleanup,
            });
        } catch {
            probeLifecycle?.signal.throwIfAborted();
            return {
                ok: false,
                error: {
                    code: 'connected-service-preflight-failed',
                    message: 'Could not prepare the selected connected-service account for this probe.',
                },
            };
        }

        let connectedCleanup: Promise<void> | undefined;
        const cleanupConnected = () => connectedCleanup ??= Promise.resolve().then(() => connectedServiceProbeEnvironment.cleanup?.());
        try {
            if (connectedServiceProbeEnvironment.cleanup) registerNativeCleanup?.(cleanupConnected);
            const remainingMs = probeLifecycle ? remainingCatalogProbeMs(probeLifecycle) : timeoutMs;
            const commonParams = {
                agentId,
                backendTarget: probeContext.backendTarget,
                cwd,
                timeoutMs: remainingMs,
                ...(probeLifecycle ? { deadlineAt: probeLifecycle.deadlineAt, signal: probeLifecycle.signal } : {}),
                ...(registerNativeCleanup ? { onNativeCleanup: (nativeCleanup: NativeCatalogCleanup) => registerNativeCleanup(async () => {
                    try {
                        await nativeCleanup();
                    } finally {
                        await cleanupConnected();
                    }
                }) } : {}),
                profileId,
                accountSettings: probeContext.accountSettings,
                credentials: probeContext.credentials,
                connectedServices,
                processEnv: connectedServiceProbeEnvironment.processEnv,
                connectedServiceSelectionCacheKey:
                    connectedServiceProbeEnvironment.connectedServiceSelectionCacheKey,
            };

            if (method === 'probeModels') {
                const result = await probeAgentModelsBestEffort({ ...commonParams, bypassCache: params?.bypassCache === true });
                return { ok: true, result };
            }
            if (method === 'probeModes') {
                const result = await probeAgentModesBestEffort(commonParams);
                return { ok: true, result };
            }
            if (method === 'probeCatalogs') {
                return { ok: true, result: await probeAgentCatalogs({ ...commonParams, bypassCache: params?.bypassCache === true }) };
            }

            const result = await probeAgentConfigOptionsBestEffort(commonParams);
            return { ok: true, result };
        } finally {
            await cleanupConnected();
        }
    };
    if (method !== 'probeCatalogs' || params?.bypassCache === true) return await runProbe();
    const scopeFingerprint = createHash('sha256').update(JSON.stringify({
        environment: Object.entries(profileProcessEnv).sort(([left], [right]) => left.localeCompare(right)),
        accountSettings: probeContext.accountSettings,
        connectedServices,
        profileId,
        timeoutMs,
    })).digest('hex');
    const scopeKey = buildAgentProbeCacheKey({
        agentId, cwd, backendTarget: probeContext.backendTarget,
        variant: `${resolveAgentProbeVariant({ agentId, backendTarget: probeContext.backendTarget,
            accountSettings: probeContext.accountSettings, connectedServices, processEnv: profileProcessEnv })}:${scopeFingerprint}`,
    });
    return await shareCatalogProbe(scopeKey, lifecycle!, runProbe, registerCleanup);
}

async function getConnectedServiceAuthSupport(agentId: AgentCatalogEntry['id']): Promise<CapabilitiesInvokeResponse> {
    const entry = AGENTS[agentId];
    const materializer = await entry?.getConnectedServiceMaterializer?.();
    const lifecycle = materializer ? await entry?.getConnectedServiceCredentialLifecycleDescriptor?.() : null;
    return { ok: true, result: { supportedServiceIds: lifecycle?.serviceIds ?? [] } };
}

function createGenericCliCapability(agentId: AgentCatalogEntry['id']): Capability {
    return {
        descriptor: {
            id: `cli.${agentId}`,
            kind: 'cli',
            title: `${titleCase(agentId)} CLI`,
            methods: {
                connectedServiceAuthSupport: { title: 'Connected-service launch support' },
                install: { title: 'Install' },
                probeModels: { title: 'Probe models' },
                probeModes: { title: 'Probe modes' },
                probeConfigOptions: { title: 'Probe config options' },
                probeCatalogs: { title: 'Probe commands and skills' },
            },
        },
        detect: async ({ request, context }) => {
            const entry = context.cliSnapshot?.clis?.[agentId];
            return buildCliCapabilityData({ request, entry });
        },
        invoke: async ({ method, params, signal }) => {
            if (method === 'connectedServiceAuthSupport') return getConnectedServiceAuthSupport(agentId);
            if (method === 'install') {
                return invokeProviderCliInstall(agentId, params, signal);
            }
            if (method === 'probeModels') {
                return invokeCliProbeMethod(agentId, method, params, signal);
            }
            if (method === 'probeModes') {
                return invokeCliProbeMethod(agentId, method, params, signal);
            }
            if (method === 'probeConfigOptions' || method === 'probeCatalogs') {
                return invokeCliProbeMethod(agentId, method, params, signal);
            }
            return { ok: false, error: { message: `Unsupported method: ${method}`, code: 'unsupported-method' } };
        },
    };
}

function augmentCliCapabilityWithProbeModels(cap: Capability, agentId: AgentCatalogEntry['id']): Capability {
    if (!cap.descriptor.id.startsWith('cli.')) return cap;

    const existingMethods = cap.descriptor.methods ?? {};
    const methods = {
        ...existingMethods,
        connectedServiceAuthSupport: { title: 'Connected-service launch support' },
        ...(existingMethods.probeModels ? {} : { probeModels: { title: 'Probe models' } }),
        ...(existingMethods.probeModes ? {} : { probeModes: { title: 'Probe modes' } }),
        ...(existingMethods.probeConfigOptions ? {} : { probeConfigOptions: { title: 'Probe config options' } }),
        ...(existingMethods.probeCatalogs ? {} : { probeCatalogs: { title: 'Probe commands and skills' } }),
        ...(existingMethods.install ? {} : { install: { title: 'Install' } }),
    };

    const baseInvoke = cap.invoke;

    const invoke: Capability['invoke'] = async ({ method, params, signal }) => {
        if (method === 'connectedServiceAuthSupport') return getConnectedServiceAuthSupport(agentId);
        if (method === 'install') {
            return invokeProviderCliInstall(agentId, params, signal);
        }
        if (method === 'probeModels') {
            return invokeCliProbeMethod(agentId, method, params, signal);
        }
        if (method === 'probeModes') {
            return invokeCliProbeMethod(agentId, method, params, signal);
        }
        if (method === 'probeConfigOptions' || method === 'probeCatalogs') {
            return invokeCliProbeMethod(agentId, method, params, signal);
        }
        if (baseInvoke) return await baseInvoke({ method, params, signal });
        return { ok: false, error: { message: `Unsupported method: ${method}`, code: 'unsupported-method' } };
    };

    return {
        ...cap,
        descriptor: { ...cap.descriptor, methods },
        invoke,
    };
}

type CliCapabilitiesOptions = Readonly<{
    hasSessionAgentTransition?: () => boolean;
}>;

export async function createCliCapabilitiesService(options?: CliCapabilitiesOptions): Promise<ReturnType<typeof createCapabilitiesService>> {
    const cliCapabilities = await Promise.all(
        (Object.values(AGENTS) as AgentCatalogEntry[]).map(async (entry) => {
            if (entry.getCliCapabilityOverride) {
                const override = await entry.getCliCapabilityOverride();
                return withProviderCliUpdates(augmentCliCapabilityWithProbeModels(override, entry.id), entry.id);
            }
            return withProviderCliUpdates(createGenericCliCapability(entry.id), entry.id);
        }),
    );

    const extraCapabilitiesNested = await Promise.all(
        (Object.values(AGENTS) as AgentCatalogEntry[]).map(async (entry) => {
            if (!entry.getCapabilities) return [];
            return [...(await entry.getCapabilities())];
        }),
    );
    const extraCapabilities: Capability[] = extraCapabilitiesNested.flat();

    const hasSessionAgentTransition = options?.hasSessionAgentTransition;
    const daemonCapabilities: Capability[] = hasSessionAgentTransition ? [{
        descriptor: { id: 'tool.sessionAgentTransition', kind: 'tool', title: 'Agent transitions' },
        // The machine process installs its transition handler after registering
        // shared capabilities. Check the actual owner at detection time.
        detect: async () => ({ supportsInputPermissionIntent: hasSessionAgentTransition() }),
    }] : [];

    return createCapabilitiesService({
        capabilities: [
            ...cliCapabilities,
            ...extraCapabilities,
            ...daemonCapabilities,
            ...installableDepCapabilities,
            tmuxCapability,
            windowsTerminalCapability,
            executionRunsCapability,
            systemTasksCapability,
        ],
        checklists,
        buildContext: buildDetectContext,
    });
}

export function registerCapabilitiesHandlers(rpcHandlerManager: RpcHandlerRegistrar, options?: CliCapabilitiesOptions): void {
    let servicePromise: Promise<ReturnType<typeof createCapabilitiesService>> | null = null;

    const getService = (): Promise<ReturnType<typeof createCapabilitiesService>> => {
        if (servicePromise) return servicePromise;
        const pending = createCliCapabilitiesService(options).catch((error) => {
            if (servicePromise === pending) {
                servicePromise = null;
            }
            throw error;
        });
        servicePromise = pending;
        return pending;
    };

    // Warm capability loaders after registration has returned. Several capability
    // modules import through the backend catalog; deferring one macrotask avoids
    // caching a partial catalog while daemon startup import cycles are settling.
    setTimeout(() => {
        void getService().catch(() => undefined);
    }, 0);

    rpcHandlerManager.registerHandler<{}, CapabilitiesDescribeResponse>(RPC_METHODS.CAPABILITIES_DESCRIBE, async () => {
        return (await getService()).describe();
    });

    rpcHandlerManager.registerHandler<CapabilitiesDetectRequest, CapabilitiesDetectResponse>(RPC_METHODS.CAPABILITIES_DETECT, async (data) => {
        return await (await getService()).detect(data);
    });

    rpcHandlerManager.registerHandler<CapabilitiesInvokeRequest, CapabilitiesInvokeResponse>(RPC_METHODS.CAPABILITIES_INVOKE, async (data, _legacyLocalOptions?: undefined, context?: RpcHandlerContext) => {
        return await (await getService()).invoke(data, context);
    });
}
