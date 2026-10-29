import type { PluginAgentCliReadinessServiceForHost } from '../../context/agents';
import type { JsonValue } from '@happier-dev/plugin-sdk';
import { realpath } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { isAbsolute } from 'node:path';
import { configuration } from '@/configuration';
import type { ManagedExecutableRef } from '@happier-dev/plugin-sdk/managed-services';
import type { AgentCliReadinessService as PluginAgentCliReadinessService, ExecService, PluginProcessHandle, SystemToolsService as PluginSystemToolsService } from '@happier-dev/plugin-sdk/exec';
import type { PluginFramedBytesClient, PluginJsonRpcClient, PluginJsonRpcConnection, PluginJsonRpcConnectionSpec, PluginJsonStreamClient, PluginLoopbackWebSocketJsonClient, PluginProtocolClientHandle, PluginProtocolClientSpec, PluginProtocolClientSpecByKind, ProtocolClientsService } from '@happier-dev/plugin-sdk/exec/protocol-clients';
import type { PluginPath } from '@happier-dev/plugin-sdk';
import { isPluginError, PluginError } from '@happier-dev/plugin-sdk';
import { resolveWindowsCommandInvocation } from '@happier-dev/cli-common/process';
import type {
    ExecProcessHandleV1,
    ExecRunResultV1,
    ExecSystemToolServiceV1,
} from '../../exec/privateContract';

import { createJsonRpcProcessClient } from '../../exec/jsonRpc';
import { createJsonStreamProcessClient } from '../../exec/jsonStream';
import { createFramedBytesProcessClient } from '../../exec/framedBytes';
import {
    createLoopbackWebSocketJsonClient,
    createLoopbackWebSocketHandshakeClient,
} from '../../exec/loopbackWebSocket';
import {
    spawnSupervisedPluginProcess,
    type SupervisedPluginProcess,
    type SupervisedPluginGracefulStop,
} from '../../exec/processSupervisor';
import type { ProcessCustodySpawnSpec } from '@/subprocess/supervision/processCustody';
import {
    PluginExecClientError,
    createPluginExecClientExitError,
    createPluginExecClientAbortError,
    sanitizeExecDiagnosticText,
} from '../../exec/errors';
import {
    isPluginPathCoveredByDisclosure,
    type PluginFileSystemScope,
} from './filesystem';
import type { HostRuntimeLimitMeasurementRecorder } from '@/agent/runtime/state/runtimeLimitMeasurement';
import { classifySpawnFailure, spawnFailureMessage, type SpawnFailureLimitsReader } from '@/processes/spawnFailure/classifySpawnFailure';
import { validateEnvVarRecordStrict } from '@/terminal/runtime/envVarSanitization';
import type { ProjectNativeEnvironmentInput, ProjectNativeEnvironmentIo, ProjectNativePluginAdapterInput } from '@/workspaces/environment/produceProjectNativeEnvironment';
import type { ProjectSecretReferenceEnvironmentInput } from '@/settings/secrets/secretReferenceOverlay';
import { formatProcessOwnerTag, readHostProcessOwnerTag, withHostProcessOwnerEnvironment, withProcessOwnerEnvironment, type ProcessOwnerRef } from '@/processes/ownerTag';
import { buildCgroupProcessLaunchSpec, prepareCgroupProcessLaunchScope, type LinuxProcessLaunchScope } from '@/daemon/platform/linux/buildCgroupSelfMigratingHappyCliLaunchSpec';
import { createHappierLinuxScopeName } from '@/daemon/platform/linux/systemdUserResourceGovernor';
import type { OwnerRemainderPort } from '@/daemon/processes/endOwnerRemainder';
import { logger } from '@/ui/logger';

type AgentNativeLaunchQualifier = NonNullable<NonNullable<Parameters<ExecService['spawn']>[1]>['nativeLaunch']>;

const INTERNAL_PROTOCOL_GRACEFUL_DISPOSERS = new WeakMap<PluginProtocolClientHandle<'jsonRpc'>,
    (beforeTerminate: SupervisedPluginGracefulStop) => Promise<void>>();

/** Host resolution and preparation supply this evidence only before process dispatch. */
function withExecLaunchNotStarted(error: unknown): unknown {
    if (!isPluginError(error)) return error;
    const refusal = new PluginError(error.data, { cause: error });
    Object.defineProperty(refusal, 'execLaunch', { value: 'notStarted', enumerable: true });
    Object.defineProperty(refusal, 'data', {
        value: Object.freeze({ ...refusal.data, execLaunch: 'notStarted' as const }), enumerable: true,
    });
    return refusal;
}

/** The supervisor's existing termination grace contains the entire protocol stop. */
export async function disposePluginProtocolClientGracefullyForHost(
    handle: PluginProtocolClientHandle<'jsonRpc'>,
    beforeTerminate: SupervisedPluginGracefulStop,
): Promise<void> {
    const dispose = INTERNAL_PROTOCOL_GRACEFUL_DISPOSERS.get(handle);
    if (!dispose) throw new PluginError({ code: 'plugin_exec_protocol_custody_unavailable', message: 'Protocol client is not owned by this host execution service' });
    await dispose(beforeTerminate);
}

/** Prepared by the host Project owner, never accepted from an SDK Exec request. */
export type HostProjectNativeLaunchAdmission =
    | Readonly<{
        status: 'ready';
        reviewedEffectDigest: string;
        verifyCurrent?: () => Promise<void>;
        environment: Omit<ProjectNativeEnvironmentInput, 'cwd' | 'env' | 'signal' | 'pluginAdapter'>;
        nativeAdapter?: Omit<ProjectNativePluginAdapterInput, 'launch'>;
        secretReferences?: ProjectSecretReferenceEnvironmentInput;
    }>
    | Readonly<{
        status: 'refused';
        kind: 'unavailable' | 'unsupported' | 'binding_unavailable' | 'approval_pending'
            | 'effect_changed' | 'native_failed' | 'cancelled' | 'child_required';
        code: string;
        operationId?: string;
    }>;

export type HostPluginExecLaunchOptions = Readonly<{
    signal?: AbortSignal;
    nativeLaunch?: AgentNativeLaunchQualifier;
    projectLaunch?: HostProjectNativeLaunchAdmission;
    /** The selected native adapter's invocation, not the original Agent's. */
    nativeExecutableOwner?: ExecService;
    prepareAgentNativeLaunch?: HostAgentNativeLaunchPreparation;
}>;

export type HostAgentNativeLaunchPreparation = (
    signal: AbortSignal,
    cwd?: string,
    environment?: Readonly<Record<string, string>>,
) => Promise<Readonly<{
    projectLaunch: HostProjectNativeLaunchAdmission;
    nativeExecutableOwner?: ExecService;
}> | undefined>;

type NativeLaunchQualifiers = WeakSet<object>;
const INTERNAL_NATIVE_LAUNCH_QUALIFIERS = new WeakMap<ExecService, NativeLaunchQualifiers>();
const INTERNAL_RESOLVED_AGENT_LAUNCH_AUTHORIZERS = new WeakMap<ExecService, (
    launch: ResolvedHostExecLaunch,
    signal?: AbortSignal,
    nativeLaunch?: AgentNativeLaunchQualifier,
) => Promise<HostAuthorizedPluginExecLaunch>>();

function assertNativeLaunchQualifier(qualifiers: NativeLaunchQualifiers, nativeLaunch?: AgentNativeLaunchQualifier): void {
    if (nativeLaunch === undefined) return;
    if (typeof nativeLaunch !== 'object' || nativeLaunch === null || !qualifiers.has(nativeLaunch)) {
        fail('plugin_exec_native_launch_qualifier_invalid', 'Native Agent launch qualifier does not belong to this Exec service');
    }
}

/** Only host composition qualifies cold native launch intent; ordinary admission still applies. */
export function issueAgentNativeLaunchQualifierForHost(service: ExecService): AgentNativeLaunchQualifier {
    let qualifiers = INTERNAL_NATIVE_LAUNCH_QUALIFIERS.get(service);
    if (!qualifiers) {
        qualifiers = new WeakSet();
        INTERNAL_NATIVE_LAUNCH_QUALIFIERS.set(service, qualifiers);
    }
    const qualifier = Object.freeze({});
    qualifiers.add(qualifier);
    return qualifier as AgentNativeLaunchQualifier;
}

/** Resolved native transports still consume this exact service's preparation and finalizer. */
export async function authorizeResolvedAgentNativeExecLaunchForHost(
    service: ExecService,
    launch: ResolvedHostExecLaunch,
    signal?: AbortSignal,
    nativeLaunch?: AgentNativeLaunchQualifier,
): Promise<HostAuthorizedPluginExecLaunch> {
    try {
        const authorize = INTERNAL_RESOLVED_AGENT_LAUNCH_AUTHORIZERS.get(service);
        if (!authorize) {
            launch.release?.();
            return fail('plugin_exec_native_launch_unavailable', 'Native Agent launch authority is unavailable');
        }
        return await authorize(launch, signal, nativeLaunch);
    } catch (error) { throw withExecLaunchNotStarted(error); }
}

export type ResolvedPluginExecutable = Readonly<{
    command: string;
    args?: readonly string[];
    env?: Readonly<Record<string, string>>;
    allowedArguments?: readonly string[];
    release?: () => void;
}>;

const INTERNAL_PREAUTHORIZED_SPAWNS = new WeakMap<
    object,
    WeakMap<object, ResolvedPluginExecutable>
>();

/**
 * Host-internal custody installs, keyed by the exact spawn request. A shared
 * daemon's lifetime transfers before resolution; ordinary invocation ownership
 * remains unchanged. When native custody is present, `launchProcess` starts
 * its helper as the command and passes the authorized target launch through it, so the helper
 * establishes the job containment before the target's first instruction while
 * command/args/cwd/env and stdio stay exactly the authorized ones.
 */
type ManagedPluginExecLifetimeForHost = Readonly<{
    signal: AbortSignal;
    isOccurrenceCurrent(): boolean;
    resolveManagedExecutable?(
        executable: ManagedExecutableRef,
        isOccurrenceCurrent: () => boolean,
    ): Promise<ResolvedPluginExecutable>;
}>;

type ManagedPluginExecCustodyForHost = Readonly<{
    processCustody: ProcessCustodySpawnSpec | null;
    lifetime?: ManagedPluginExecLifetimeForHost;
    processOwnerTag?: string;
}>;

const INTERNAL_MANAGED_PROCESS_CUSTODY = new WeakMap<
    object,
    WeakMap<object, ManagedPluginExecCustodyForHost>
>();

const INTERNAL_OWNER_REBINDERS = new WeakMap<ExecService, (owner: ProcessOwnerRef, signal?: AbortSignal) => ExecService>();

/** A retained Session service must not lend its owner to a finite Run. */
export function bindPluginExecProcessOwnerForHost(service: ExecService, owner: ProcessOwnerRef, signal?: AbortSignal): ExecService {
    const rebind = INTERNAL_OWNER_REBINDERS.get(service);
    if (!rebind) return fail('plugin_exec_owner_binding_unavailable', 'Host process ownership binding is unavailable');
    return rebind(owner, signal);
}

export function installManagedProcessCustodyForHost(
    service: Pick<ExecService, 'spawn' | 'run'>,
    request: Parameters<ExecService['spawn']>[0],
    processCustody: ProcessCustodySpawnSpec | null,
    lifetime?: ManagedPluginExecLifetimeForHost,
    processOwner?: ProcessOwnerRef,
): Readonly<{ dispose(): void }> {
    let authorizations = INTERNAL_MANAGED_PROCESS_CUSTODY.get(service);
    if (!authorizations) {
        authorizations = new WeakMap();
        INTERNAL_MANAGED_PROCESS_CUSTODY.set(service, authorizations);
    }
    if (authorizations.has(request)) {
        fail(
            'plugin_exec_preauthorization_unavailable',
            'Process custody is already installed for this exact spawn request',
        );
    }
    const custody: ManagedPluginExecCustodyForHost = Object.freeze({
        processCustody,
        ...(lifetime ? { lifetime } : {}),
        ...(processOwner ? { processOwnerTag: formatProcessOwnerTag({ happierHomeDir: configuration.happyHomeDir, owner: processOwner }) } : {}),
    });
    authorizations.set(request, custody);
    return Object.freeze({
        dispose() {
            if (authorizations.get(request) === custody) {
                authorizations.delete(request);
            }
        },
    });
}

function readInstalledManagedProcessCustody(
    service: ExecService,
    request: Parameters<ExecService['spawn']>[0],
): ManagedPluginExecCustodyForHost | null {
    const custody = INTERNAL_MANAGED_PROCESS_CUSTODY.get(service)?.get(request) ?? null;
    if (custody) {
        // Custody installs are single-use: they govern exactly one spawn.
        INTERNAL_MANAGED_PROCESS_CUSTODY.get(service)?.delete(request);
    }
    return custody;
}

export function installPreauthorizedPluginExecSpawnForHost(
    service: Pick<ExecService, 'spawn' | 'run'>,
    request: Parameters<ExecService['spawn']>[0],
    launch: ResolvedPluginExecutable,
): Readonly<{ dispose(): void }> {
    const authorizations = INTERNAL_PREAUTHORIZED_SPAWNS.get(service);
    if (!authorizations || authorizations.has(request)) {
        fail(
            'plugin_exec_preauthorization_unavailable',
            'Exact process launch preauthorization is unavailable',
        );
    }
    authorizations.set(request, launch);
    return Object.freeze({
        dispose() {
            if (authorizations.get(request) === launch) {
                authorizations.delete(request);
            }
        },
    });
}

export type HostResolvedManagedDependencyExecutable = Readonly<{
    command: string;
    args?: readonly string[];
    env?: Readonly<Record<string, string>>;
    release(): void;
}>;

export type HostResolvedSystemToolExecutable = Readonly<{
    executable: ManagedExecutableRef;
    command: string;
    args?: readonly string[];
    env?: Readonly<Record<string, string>>;
}>;

export type HostAuthorizedPluginExecLaunch = Readonly<{
    command: string;
    args: readonly string[];
    env: Readonly<Record<string, string>>;
    cwd?: string;
    stdin?: Uint8Array;
    timeoutMs?: number;
    maxStdoutBytes?: number;
    maxStderrBytes?: number;
    windowsVerbatimArguments?: boolean;
    /** Native activation cleanup must finish before descendant termination. Host-only. */
    waitForGracefulRootExitBeforeTreeStop?: true;
    /** Host-private ownership, retained across all native and provider env layers. */
    processOwnerTag?: string;
    release(): void | Promise<void>;
}>;

/** Dispatches the final authorized tuple through the incumbent OS/process owner. */
export function spawnAuthorizedHostExecLaunchForHost(
    launch: HostAuthorizedPluginExecLaunch,
    options: Readonly<{
        signal?: AbortSignal;
        processCustody?: ProcessCustodySpawnSpec;
        /** Host-owned worker containment; ordinary Exec retains its dedicated group. */
        posixProcessGroup?: 'inherit';
        processTreeSystemBoundary?: Parameters<typeof spawnSupervisedPluginProcess>[0]['processTreeSystemBoundary'];
        descendantDisposition?: NonNullable<Parameters<ExecService['spawn']>[1]>['descendantDisposition'];
        linuxProcessLaunchScope?: LinuxProcessLaunchScope | null;
        recordRuntimeLimitMeasurement?: HostRuntimeLimitMeasurementRecorder;
        readSpawnFailureLimits?: SpawnFailureLimitsReader;
        /** Transfer the final capture to the existing service's physical-settlement cleanup. */
        retainLaunch?: (release: HostAuthorizedPluginExecLaunch['release']) => void;
    }> = {},
): SupervisedPluginProcess {
    const custody = options.processCustody;
    const environment = withHostProcessOwnerEnvironment(launch.env, launch.processOwnerTag ?? readHostProcessOwnerTag());
    let supervised: SupervisedPluginProcess;
    // The service cleanup must retain even a no-launch capture: native
    // preparation may already own resources when the final spawn fails.
    options.retainLaunch?.(launch.release);
    try {
        const unit = createHappierLinuxScopeName(launch.processOwnerTag ?? readHostProcessOwnerTag());
        const scopedLaunch = options.linuxProcessLaunchScope && unit
            ? buildCgroupProcessLaunchSpec({ scope: options.linuxProcessLaunchScope, unit,
                launchSpec: { filePath: launch.command, args: [...launch.args], env: { ...environment } } })
            : null;
        supervised = spawnSupervisedPluginProcess({
            command: custody ? custody.executablePath : scopedLaunch?.filePath ?? launch.command,
            args: custody ? [
                'run', `--job=${custody.jobName}`, `--handshake=${custody.handshakePath}`,
                ...(launch.windowsVerbatimArguments ? ['--target-windows-verbatim'] : []),
                '--', launch.command, ...launch.args,
            ] : scopedLaunch?.args ?? launch.args,
            ...(launch.cwd ? { cwd: launch.cwd } : {}),
            env: scopedLaunch?.env ?? environment,
            ...(launch.stdin ? { stdin: launch.stdin } : {}),
            ...(launch.timeoutMs === undefined ? {} : { timeoutMs: launch.timeoutMs }),
            ...(launch.maxStdoutBytes === undefined ? {} : { maxStdoutBytes: launch.maxStdoutBytes }),
            ...(launch.maxStderrBytes === undefined ? {} : { maxStderrBytes: launch.maxStderrBytes }),
            ...(options.descendantDisposition ? { descendantDisposition: options.descendantDisposition } : {}),
            ...(launch.waitForGracefulRootExitBeforeTreeStop ? { waitForGracefulRootExitBeforeTreeStop: true } : {}),
            signals: options.signal ? [options.signal] : [],
            ...(custody ? { processCustody: custody } : {}),
            ...(options.processTreeSystemBoundary ? { processTreeSystemBoundary: options.processTreeSystemBoundary } : {}),
            spawnOptions: {
                detached: process.platform !== 'win32' && options.posixProcessGroup !== 'inherit',
                ...(custody ? {} : { windowsVerbatimArguments: launch.windowsVerbatimArguments }),
            },
            ...(options.recordRuntimeLimitMeasurement
                ? { recordRuntimeLimitMeasurement: options.recordRuntimeLimitMeasurement }
                : {}),
            readSpawnFailureLimits: options.readSpawnFailureLimits,
        });
    } catch (error) {
        if (!options.retainLaunch) void launch.release();
        const spawnFailure = classifySpawnFailure(error, { syscall: 'spawn', limits: options.readSpawnFailureLimits?.() });
        throw new PluginError({ code: 'plugin_exec_spawn_failed', message: spawnFailureMessage(spawnFailure, 'Process could not be started'), details: { spawnFailure } }, { cause: error });
    }
    if (!options.retainLaunch) void supervised.waitForSettlement().then(() => launch.release());
    return supervised;
}

export type PluginExecDisclosureMismatch =
    | Readonly<{ capability: 'process'; executable: ManagedExecutableRef }>
    | Readonly<{ capability: 'environment'; keys: readonly string[] }>
    | Readonly<{ capability: 'filesystem'; path: PluginPath | string; access: 'read' }>;

const INTERNAL_LAUNCH_AUTHORIZERS = new WeakMap<
    ExecService,
    (
        request: Parameters<ExecService['spawn']>[0]
            & Readonly<{ timeoutMs?: number }>,
        options?: Readonly<{ signal?: AbortSignal }>,
        projectLaunch?: HostProjectNativeLaunchAdmission,
        nativeExecutableOwner?: ExecService,
        prepareAgentNativeLaunch?: HostAgentNativeLaunchPreparation,
    ) => Promise<HostAuthorizedPluginExecLaunch>
>();

export type PluginExecProcessCustodyForHost = Readonly<{
    requestStop(): Promise<void>;
    waitForSettlement(): Promise<void>;
    onOutcomeUncertain(listener: (error: unknown) => void): () => void;
    hasUnsettledProcesses(): boolean;
}>;

// Host-only lookup for the resources already owned by this exact Exec service.
const INTERNAL_PROCESS_CUSTODY = new WeakMap<ExecService, PluginExecProcessCustodyForHost>();

export function readPluginExecProcessCustodyForHost(service: ExecService): PluginExecProcessCustodyForHost {
    const custody = INTERNAL_PROCESS_CUSTODY.get(service);
    if (!custody) return fail('plugin_exec_process_custody_unavailable', 'Native process custody is unavailable in this invocation host');
    return custody;
}

export async function authorizePluginExecLaunchForHost(
    service: ExecService,
    request: Parameters<ExecService['spawn']>[0]
        & Readonly<{ timeoutMs?: number }>,
    options?: HostPluginExecLaunchOptions,
): Promise<HostAuthorizedPluginExecLaunch> {
    try {
        const authorize = INTERNAL_LAUNCH_AUTHORIZERS.get(service);
        if (!authorize) {
            return fail(
                'plugin_exec_launch_authorization_unavailable',
                'Exact process launch authorization is unavailable in this invocation host',
            );
        }
        // Only this host entry point supplies the third argument. Extra properties
        // on public run/spawn options cannot opt a plugin into Project effects.
        return await authorize(request, options, options?.projectLaunch, options?.nativeExecutableOwner, options?.prepareAgentNativeLaunch);
    } catch (error) { throw withExecLaunchNotStarted(error); }
}

export function createStableRunnerPluginExecService(
    params: Readonly<{
        processOwner?: ProcessOwnerRef;
        signal: AbortSignal;
        isOccurrenceCurrent(): boolean;
        agentCli: PluginAgentCliReadinessService;
        resolveSystemTool(
            request: Parameters<
                PluginSystemToolsService['resolve']
            >[0],
        ): Promise<Readonly<{
            result: Awaited<ReturnType<
                PluginSystemToolsService['resolve']
            >>;
            resolutionId: string;
        }>>;
        authorizeLaunch(
            request: Parameters<ExecService['spawn']>[0]
                & Readonly<{ timeoutMs?: number }>,
            options?: Readonly<{ signal?: AbortSignal; agentNativeLaunch?: true }>,
            systemToolResolutionId?: string,
        ): Promise<HostAuthorizedPluginExecLaunch>;
        authorizeResolvedAgentNativeLaunch?(
            launch: ResolvedHostExecLaunch,
            options?: Readonly<{ signal?: AbortSignal }>,
        ): Promise<HostAuthorizedPluginExecLaunch>;
        transformAgentChildLaunchEnvironment?(
            environment: Readonly<Record<string, string>>,
        ): Readonly<Record<string, string>>;
        recordRuntimeLimitMeasurement?:
            HostRuntimeLimitMeasurementRecorder;
        readSpawnFailureLimits?: SpawnFailureLimitsReader;
    }>,
): ExecService {
    const systemToolResolutionIds = new WeakMap<object, string>();
    const base = createStablePluginExecService({
        ...(params.processOwner ? { processOwner: params.processOwner } : {}),
        allowedExecutables: [],
        signal: params.signal,
        readSpawnFailureLimits: params.readSpawnFailureLimits,
        isOccurrenceCurrent: params.isOccurrenceCurrent,
        authorizeLaunch: (request, options) =>
            params.authorizeLaunch(
                request,
                options,
                systemToolResolutionIds.get(
                    request.executable,
                ),
            ),
        ...(params.transformAgentChildLaunchEnvironment
            ? {
                transformAgentChildLaunchEnvironment:
                    params.transformAgentChildLaunchEnvironment,
            }
            : {}),
        async resolveExecutable() {
            return fail(
                'plugin_exec_runner_local_resolution_forbidden',
                'Runner executable resolution must remain daemon-owned',
            );
        },
        async resolvePath() {
            return fail(
                'plugin_exec_runner_local_path_resolution_forbidden',
                'Runner path resolution must remain daemon-owned',
            );
        },
        ...(params.recordRuntimeLimitMeasurement
            ? {
                recordRuntimeLimitMeasurement:
                    params.recordRuntimeLimitMeasurement,
            }
            : {}),
    });
    const systemTools: PluginSystemToolsService = Object.freeze({
        async resolve(
            request: Parameters<
                PluginSystemToolsService['resolve']
            >[0],
        ) {
            try {
                const resolved =
                    await params.resolveSystemTool(request);
                systemToolResolutionIds.set(
                    resolved.result.executable,
                    resolved.resolutionId,
                );
                return resolved.result;
            } catch (error) { throw withExecLaunchNotStarted(error); }
        },
    });
    const service: ExecService = Object.freeze({
        ...base,
        agentCli: params.agentCli,
        systemTools,
    });
    INTERNAL_OWNER_REBINDERS.set(service, (owner, signal) => createStableRunnerPluginExecService({ ...params,
        processOwner: owner, signal: signal ? AbortSignal.any([params.signal, signal]) : params.signal }));
    INTERNAL_NATIVE_LAUNCH_QUALIFIERS.set(service, INTERNAL_NATIVE_LAUNCH_QUALIFIERS.get(base)!);
    INTERNAL_RESOLVED_AGENT_LAUNCH_AUTHORIZERS.set(service, async (launch, signal, nativeLaunch) => {
        const assertCurrent = () => {
            if (!params.isOccurrenceCurrent()) fail('plugin_generation_stale', 'Plugin occurrenceId is stale');
            if (params.signal.aborted || signal?.aborted) fail('plugin_exec_aborted', 'Process operation was aborted');
        };
        let authorized: HostAuthorizedPluginExecLaunch;
        try {
            assertCurrent();
            const qualifiers = INTERNAL_NATIVE_LAUNCH_QUALIFIERS.get(service)!;
            assertNativeLaunchQualifier(qualifiers, nativeLaunch);
            if (!params.authorizeResolvedAgentNativeLaunch) fail('plugin_exec_native_launch_unavailable', 'Daemon native Agent launch authority is unavailable');
            const processOwnerTag = params.processOwner
                ? formatProcessOwnerTag({ happierHomeDir: configuration.happyHomeDir, owner: params.processOwner }) : readHostProcessOwnerTag();
            authorized = await params.authorizeResolvedAgentNativeLaunch({ ...launch,
                ...(processOwnerTag ? { processOwnerTag } : {}) }, { signal });
            try { assertCurrent(); }
            catch (error) { await authorized.release(); throw error; }
        } catch (error) {
            launch.release?.();
            throw error;
        }
        let released = false;
        return Object.freeze({ ...authorized, async release() {
            if (released) return;
            released = true;
            try { await authorized.release(); }
            finally { launch.release?.(); }
        } });
    });
    return service;
}

const INTERNAL_EXECUTABLE_RESOLVERS = new WeakMap<
    ExecService,
    (
        executable: ManagedExecutableRef,
        options?: Readonly<{ signal?: AbortSignal }>,
    ) => Promise<ResolvedPluginExecutable>
>();

const INTERNAL_SYSTEM_TOOL_RESOLVERS = new WeakMap<
    ExecService,
    (
        request: Parameters<PluginSystemToolsService['resolve']>[0],
    ) => Promise<HostResolvedSystemToolExecutable>
>();

export async function resolvePluginExecSystemToolForHost(
    service: ExecService,
    request: Parameters<PluginSystemToolsService['resolve']>[0],
): Promise<HostResolvedSystemToolExecutable> {
    try {
        const resolveSystemTool = INTERNAL_SYSTEM_TOOL_RESOLVERS.get(service);
        if (!resolveSystemTool) {
            fail(
                'plugin_exec_system_tool_resolution_unavailable',
                'System-tool executable resolution is unavailable in this invocation host',
            );
        }
        return await resolveSystemTool(request);
    } catch (error) { throw withExecLaunchNotStarted(error); }
}

export async function resolvePluginExecManagedDependencyForHost(
    service: ExecService,
    dependencyId: string,
    options?: Readonly<{ signal?: AbortSignal }>,
): Promise<HostResolvedManagedDependencyExecutable> {
    try {
        const resolveExecutable = INTERNAL_EXECUTABLE_RESOLVERS.get(service);
        if (!resolveExecutable) {
            fail(
                'plugin_exec_managed_dependency_resolution_unavailable',
                'Managed-dependency executable resolution is unavailable in this invocation host',
            );
        }
        const resolved = await resolveExecutable({
            kind: 'managedDependency',
            id: dependencyId,
        }, options);
        return Object.freeze({
            command: resolved.command,
            ...(resolved.args ? { args: resolved.args } : {}),
            ...(resolved.env ? { env: resolved.env } : {}),
            release: resolved.release ?? (() => undefined),
        });
    } catch (error) { throw withExecLaunchNotStarted(error); }
}

type ProtocolClientKind = PluginProtocolClientSpec['kind'];

export function resolveStablePluginExecInvocation(input: Readonly<{
    command: string;
    args: readonly string[];
    env: NodeJS.ProcessEnv;
}>) {
    return resolveWindowsCommandInvocation(input);
}

type ResolvedHostExecLaunch = Omit<HostAuthorizedPluginExecLaunch, 'windowsVerbatimArguments' | 'release'>
    & Readonly<{ release?: () => void }>;

function validateExecLaunchInput(input: Readonly<{
    maxStdoutBytes?: number; maxStderrBytes?: number; timeoutMs?: number; stdin?: Uint8Array; cwd?: unknown;
}>): void {
    if (typeof input.cwd === 'string' && (!isAbsolute(input.cwd) || input.cwd.includes('\u0000'))) {
        fail('plugin_exec_invalid_cwd', 'Process working directory must be an absolute path without NUL');
    }
    for (const [field, value] of [
        ['maxStdoutBytes', input.maxStdoutBytes],
        ['maxStderrBytes', input.maxStderrBytes],
        ['timeoutMs', input.timeoutMs],
    ] as const) {
        if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
            fail('plugin_exec_invalid_limit', `${field} must be a non-negative safe integer`);
        }
    }
    if (input.stdin !== undefined && !(input.stdin instanceof Uint8Array)) {
        fail('plugin_exec_invalid_input', 'Process stdin must be binary data');
    }
}

function assertAllowedExecArguments(resolved: ResolvedPluginExecutable, args: readonly string[]): void {
    const allowedArguments = resolved.allowedArguments;
    if (allowedArguments !== undefined && args.some(argument => !allowedArguments.includes(argument))) {
        fail('plugin_exec_argument_denied', 'Process argument is not authorized for this system tool');
    }
}

async function resolveNativeExecutableForHost(
    service: ExecService,
    executable: ManagedExecutableRef,
    signal: AbortSignal,
): Promise<ResolvedPluginExecutable> {
    const resolveExecutable = INTERNAL_EXECUTABLE_RESOLVERS.get(service);
    if (!resolveExecutable) fail('native_adapter_invocation_unavailable', 'Native wrapper executable resolution is unavailable');
    return await resolveExecutable(executable, { signal });
}

type HostProjectEnvironmentInput = Readonly<{
    cwd: string;
    env: Readonly<Record<string, string>>;
    projectLaunch: HostProjectNativeLaunchAdmission;
    signal: AbortSignal;
    assertCurrent(): void;
}>;

async function produceHostProjectEnvironment(input: HostProjectEnvironmentInput,
    launch?: Readonly<{ command: string; args: readonly string[] }>) {
    const assertCurrent = () => {
        if (input.signal.aborted) fail('plugin_exec_aborted', 'Process operation was aborted');
        input.assertCurrent();
        if (input.projectLaunch.status === 'ready' && input.projectLaunch.nativeAdapter
            && !input.projectLaunch.nativeAdapter.lease.isCurrent()) {
            fail('native_adapter_retired', 'Project native adapter was retired');
        }
    };
    assertCurrent();
    const admitted = input.projectLaunch;
    if (admitted.status === 'refused') fail(admitted.code, 'Project launch preparation was not admitted');
    if (!input.cwd || !admitted.reviewedEffectDigest) {
        fail('project_launch_preparation_unavailable', 'Project launch requires its admitted root and reviewed effect');
    }
    const { produceProjectNativeEnvironment } = await import('@/workspaces/environment/produceProjectNativeEnvironment');
    await admitted.verifyCurrent?.();
    assertCurrent();
    const native = await produceProjectNativeEnvironment({
        ...admitted.environment, cwd: input.cwd, env: input.env, signal: input.signal,
        ...(admitted.nativeAdapter ? { pluginAdapter: { ...admitted.nativeAdapter,
            ...(launch ? { launch } : {}),
        } } : {}),
    });
    await admitted.verifyCurrent?.();
    assertCurrent();
    if (native.status === 'refused') fail(native.code, 'Project native environment production was refused');
    // Complete replacement preserves native removals. Only exact bindings may
    // overlay it; no consumer can accidentally merge inherited values back.
    let environment = native.env;
    if (admitted.secretReferences) {
        const { resolveProjectSecretReferenceEnvironment } = await import('@/settings/secrets/secretReferenceOverlay');
        environment = { ...environment, ...resolveProjectSecretReferenceEnvironment(admitted.secretReferences) };
    }
    assertCurrent();
    return { ...native, env: Object.freeze({ ...environment }) };
}

/** Environment-only preparation uses the same owner without a dummy process. */
export async function produceProjectLaunchEnvironmentForHost(input: HostProjectEnvironmentInput): Promise<Readonly<Record<string, string>>> {
    const native = await produceHostProjectEnvironment(input);
    if (native.nativeLaunch) fail('native_environment_launch_required', 'This native adapter requires an admitted command');
    return native.env;
}

/** The one final tuple producer, after the caller's executable/effect admission. */
async function finalizeHostExecLaunch(input: Readonly<{
    launch: ResolvedHostExecLaunch;
    projectLaunch?: HostProjectNativeLaunchAdmission;
    resolveNativeExecutable?: (executable: ManagedExecutableRef, signal: AbortSignal) => Promise<ResolvedPluginExecutable>;
    signal: AbortSignal;
    assertCurrent(): void;
}>): Promise<HostAuthorizedPluginExecLaunch> {
    let released = false;
    let nativeExecutable: ResolvedPluginExecutable | undefined;
    const release = () => {
        if (released) return;
        released = true;
        try { nativeExecutable?.release?.(); }
        finally { input.launch.release?.(); }
    };
    const assertCurrent = () => {
        input.assertCurrent();
        if (input.projectLaunch?.status === 'ready' && input.projectLaunch.nativeAdapter
            && !input.projectLaunch.nativeAdapter.lease.isCurrent()) {
            fail('native_adapter_retired', 'Project native adapter was retired');
        }
    };
    try {
        assertCurrent();
        if (input.projectLaunch?.status === 'refused') {
            fail(input.projectLaunch.code, 'Project launch preparation was not admitted');
        }
        validateExecLaunchInput(input.launch);
        let environment = input.launch.env;
        let command = input.launch.command;
        let args = input.launch.args;
        let cwd = input.launch.cwd;
        if (input.projectLaunch?.status === 'ready') {
            const native = await produceHostProjectEnvironment({
                cwd: cwd ?? '', env: environment, projectLaunch: input.projectLaunch,
                signal: input.signal, assertCurrent,
            }, { command, args });
            assertCurrent();
            environment = native.env;
            if (native.nativeLaunch) {
                if (!input.resolveNativeExecutable) fail('native_adapter_invocation_unavailable', 'Native wrapper executable resolution is unavailable');
                nativeExecutable = await input.resolveNativeExecutable(native.nativeLaunch.executable, input.signal);
                assertCurrent();
                assertAllowedExecArguments(nativeExecutable, native.nativeLaunch.args);
                command = nativeExecutable.command;
                args = [...(nativeExecutable.args ?? []), ...native.nativeLaunch.args];
                cwd = native.nativeLaunch.cwd;
                // The adapter's complete environment is authoritative; a
                // resolver overlay must not revive values it removed.
            }
            assertCurrent();
        }
        const invocation = resolveStablePluginExecInvocation({
            command, args, env: environment,
        });
        if (input.projectLaunch?.status === 'ready') await input.projectLaunch.verifyCurrent?.();
        assertCurrent();
        return Object.freeze({
            ...input.launch,
            command: invocation.command,
            args: Object.freeze([...invocation.args]),
            env: Object.freeze({ ...environment }),
            ...(cwd === undefined ? {} : { cwd }),
            ...(input.launch.stdin ? { stdin: new Uint8Array(input.launch.stdin) } : {}),
            ...(invocation.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
            release,
        });
    } catch (error) {
        release();
        throw error;
    }
}

/** Host-only entry for B1/B9's resolved built-in/literal Project commands.
 * SDK requests still resolve their declared executable through ExecService. */
export async function authorizeResolvedProjectExecLaunchForHost(input: Readonly<{
    launch: ResolvedHostExecLaunch;
    projectLaunch?: HostProjectNativeLaunchAdmission;
    nativeExecutableOwner?: ExecService;
    prepareAgentNativeLaunch?: HostAgentNativeLaunchPreparation;
    signal: AbortSignal;
    assertCurrent(): void;
}>): Promise<HostAuthorizedPluginExecLaunch> {
    const assertCurrent = () => {
        if (input.signal.aborted) fail('plugin_exec_aborted', 'Process operation was aborted');
        input.assertCurrent();
    };
    let projectLaunch = input.projectLaunch;
    let nativeExecutableOwner = input.nativeExecutableOwner;
    try {
        assertCurrent();
        validateExecLaunchInput(input.launch);
        if (!projectLaunch && input.prepareAgentNativeLaunch) {
            const prepared = await input.prepareAgentNativeLaunch(input.signal, input.launch.cwd, input.launch.env);
            assertCurrent();
            projectLaunch = prepared?.projectLaunch;
            nativeExecutableOwner = prepared?.nativeExecutableOwner;
        }
    } catch (error) {
        input.launch.release?.();
        throw withExecLaunchNotStarted(error);
    }
    const executableOwner = nativeExecutableOwner;
    return await finalizeHostExecLaunch({
        ...input,
        projectLaunch,
        ...(executableOwner ? {
            resolveNativeExecutable: (executable: ManagedExecutableRef, signal: AbortSignal) =>
                resolveNativeExecutableForHost(executableOwner, executable, signal),
        } : {}),
        assertCurrent,
    }).catch(error => { throw withExecLaunchNotStarted(error); });
}

/** Native-effect IO over the incumbent supervisor and process-tree owner.
 * Tool resolution stays with the admitted managed/system-tool invocation. */
export type ProjectNativeEffectCaptureForHost = Readonly<{
    requestStop(): Promise<void>;
    waitForSettlement(): Promise<void>;
    onOutcomeUncertain(listener: (error: unknown) => void): () => void;
    release(): Promise<void>;
}>;

export type ProjectNativeEnvironmentIoForHost = ProjectNativeEnvironmentIo & Readonly<{
    createInvocation(input: Readonly<{
        signal: AbortSignal;
        retainCapture(capture: ProjectNativeEffectCaptureForHost): void;
    }>): ProjectNativeEnvironmentIo;
}>;

/** One invocation's physical resources, shared by SDK Exec and built-in effects. */
function createNativeProcessCustodyForHost() {
    type OwnedResource = Pick<SupervisedPluginProcess, 'dispose'>
        & Readonly<{ waitForSettlement(): Promise<unknown> }>
        & Partial<Pick<SupervisedPluginProcess, 'onOutcomeUncertain'>>;
    const resources = new Set<OwnedResource>();
    const observers = new Set<(error: unknown) => void>();
    let uncertain: unknown;
    let stopRequested = false;
    const custody: PluginExecProcessCustodyForHost = Object.freeze({
        async requestStop() {
            stopRequested = true;
            await Promise.all([...resources].map(resource => resource.dispose('caller')));
        },
        async waitForSettlement() { await Promise.all([...resources].map(resource => resource.waitForSettlement())); },
        hasUnsettledProcesses: () => resources.size > 0,
        onOutcomeUncertain(listener) {
            observers.add(listener);
            if (uncertain !== undefined) {
                try { listener(uncertain); } catch { /* Observers do not own process custody. */ }
            }
            return () => { observers.delete(listener); };
        },
    });
    return {
        custody,
        assertOpen() { if (stopRequested) fail('plugin_exec_aborted', 'Process operation was aborted'); },
        retain(supervised: OwnedResource) {
            resources.add(supervised);
            const unsubscribe = supervised.onOutcomeUncertain?.(error => {
                uncertain = error;
                for (const listener of [...observers]) {
                    try { listener(error); } catch { /* Observers do not own process custody. */ }
                }
            });
            void supervised.waitForSettlement().then(() => {
                resources.delete(supervised);
                unsubscribe?.();
                if (resources.size === 0) uncertain = undefined;
            });
        },
    };
}

export function createProjectNativeEnvironmentIoForHost(input: Readonly<{
    ownerRemainder?: OwnerRemainderPort;
    resolveTool(tool: string, signal: AbortSignal | undefined, scopedIo: ProjectNativeEnvironmentIo): ReturnType<ProjectNativeEnvironmentIo['resolveTool']>;
}>): ProjectNativeEnvironmentIoForHost {
    const create = (invocation?: Parameters<ProjectNativeEnvironmentIoForHost['createInvocation']>[0]): ProjectNativeEnvironmentIoForHost => {
        const { custody, retain, assertOpen } = createNativeProcessCustodyForHost();
        const capture: ProjectNativeEffectCaptureForHost = Object.freeze({
            requestStop: custody.requestStop,
            waitForSettlement: custody.waitForSettlement,
            onOutcomeUncertain: custody.onOutcomeUncertain,
            async release() {
                await custody.requestStop();
                await custody.waitForSettlement();
            },
        });
        invocation?.retainCapture(capture);
        const io: ProjectNativeEnvironmentIoForHost = Object.freeze({
            resolveTool: (tool, signal) => input.resolveTool(tool, signal, io),
            createInvocation: create,
            async run(request: Parameters<ProjectNativeEnvironmentIo['run']>[0]) {
                const signal = invocation ? request.signal ? AbortSignal.any([invocation.signal, request.signal]) : invocation.signal : request.signal;
                assertOpen();
                if (signal?.aborted) fail('plugin_exec_aborted', 'Process operation was aborted');
                const supervised = spawnSupervisedPluginProcess({
                    ...request,
                    env: withProcessOwnerEnvironment(request.env, { kind: 'happier' }),
                    ...(input.ownerRemainder ? { rootExitObservation: {
                        ownerRemainder: input.ownerRemainder, owner: { kind: 'happier' as const },
                    } } : {}),
                    signals: signal ? [signal] : [],
                    // Abort/timeout cleans this spawner's live tree. After root
                    // exit, exact observed descendants belong to Happier remainder.
                    spawnOptions: { detached: process.platform !== 'win32' },
                });
                retain(supervised);
                const settle = async () => {
                    try { await supervised.dispose(); }
                    catch (error) {
                        if (!invocation || !isPluginError(error) || error.code !== 'plugin_exec_termination_incomplete') throw error;
                        await supervised.waitForSettlement();
                    }
                };
                try {
                    const result = await supervised.handle.wait();
                    // Root exit alone is not completed requested tree cleanup.
                    await settle();
                    if (signal?.aborted || result.termination.requestedBy.kind === 'abort') {
                        fail('plugin_exec_aborted', 'Process operation was aborted');
                    }
                    if (result.termination.observed.kind === 'failed') {
                        fail('project_native_environment_process_failed', 'Native environment process failed');
                    }
                    if (result.stdoutTruncated) {
                        fail('project_native_environment_output_incomplete', 'Native environment output was incomplete');
                    }
                    return Object.freeze({
                        exitCode: result.termination.observed.kind === 'exit' ? result.termination.observed.exitCode : 1,
                        stdout: Buffer.from(result.stdout).toString('utf8'),
                        stderr: Buffer.from(result.stderr).toString('utf8'),
                    });
                } finally {
                    await settle();
                }
            },
        });
        return io;
    };
    return create();
}

function executableKey(executable: ManagedExecutableRef): string {
    if (executable.kind === 'packaged-runtime-binary') {
        return `${executable.kind}:${JSON.stringify(executable.directorySegments)}:${JSON.stringify(executable.executableBaseName)}`;
    }
    const id = typeof executable.id === 'string'
        ? executable.id
        : `${executable.id.pluginId}:${executable.id.localId}`;
    return `${executable.kind}:${id}`;
}

function fail(code: string, message: string, cause?: unknown): never {
    throw new PluginError({ code, message }, cause === undefined ? undefined : { cause });
}

export function adaptStablePluginExecLegacyProcessHandle(
    supervised: SupervisedPluginProcess,
): ExecProcessHandleV1 {
    const exit = supervised.handle.wait().then((result): ExecRunResultV1 => {
        const observed = result.termination.observed;
        if (observed.kind === 'failed') {
            throw new PluginExecClientError(
                observed.diagnostic.code,
                observed.diagnostic.message ?? 'Plugin process failed',
                { details: observed.diagnostic.details },
            );
        }
        return Object.freeze({
            exitCode: observed.kind === 'exit' ? observed.exitCode : null,
            signal: observed.kind === 'signal' ? observed.signal : null,
            stdout: Buffer.from(result.stdout).toString('utf8'),
            stderr: Buffer.from(result.stderr).toString('utf8'),
        });
    });
    // Protocol adapters may use the legacy process handle only for I/O and never observe
    // `exit`; own the rejection immediately while preserving it for callers that do await it.
    void exit.catch(() => undefined);
    return Object.freeze({
        pid: supervised.child.pid ?? null,
        exit,
        writeStdin: async (data) => supervised.handle.write(
            typeof data === 'string' ? new Uint8Array(Buffer.from(data, 'utf8')) : data,
        ),
        kill: () => {
            void supervised.requestTermination({ kind: 'abort' });
        },
        dispose: () => supervised.dispose('caller'),
    });
}

export function createStablePluginExecService(params: Readonly<{
    /** Prepared by the host invocation owner, never an Exec request field. */
    processOwner?: ProcessOwnerRef;
    /** Host-private placement inside an already supervised worker process group. */
    posixProcessGroup?: 'inherit';
    processTreeSystemBoundary?: Parameters<typeof spawnSupervisedPluginProcess>[0]['processTreeSystemBoundary'];
    allowedExecutables: readonly ManagedExecutableRef[];
    allowedEnvKeys?: readonly string[];
    environment?: Readonly<Record<string, string>>;
    allowedCwdScopes?: readonly PluginFileSystemScope[];
    signal: AbortSignal;
    isOccurrenceCurrent(): boolean;
    resolveExecutable(executable: ManagedExecutableRef): Promise<ResolvedPluginExecutable>;
    /** Host-only physical owner admission, independent of one consumer invocation. */
    resolveManagedExecutable?(
        executable: ManagedExecutableRef,
        isOccurrenceCurrent: () => boolean,
    ): Promise<ResolvedPluginExecutable>;
    observeProcessOutput?: (output: import('@happier-dev/plugin-sdk/exec').PluginProcessOutput) => void;
    invocationTimeoutMs?: number | null;
    resolvePath(path: PluginPath): Promise<string>;
    agentCli?: PluginAgentCliReadinessServiceForHost;
    systemTools?: ExecSystemToolServiceV1;
    prepareAgentNativeLaunch?: HostAgentNativeLaunchPreparation;
    /** Operation-owned authority; applies to qualified and ordinary launches alike. */
    assertLaunchCurrent?: (signal: AbortSignal) => Promise<void>;
    authorizeLaunch?(
        request: Parameters<ExecService['spawn']>[0]
            & Readonly<{ timeoutMs?: number }>,
        options?: Readonly<{ signal?: AbortSignal; agentNativeLaunch?: true }>,
    ): Promise<HostAuthorizedPluginExecLaunch>;
    transformAgentChildLaunchEnvironment?(
        environment: Readonly<Record<string, string>>,
    ): Readonly<Record<string, string>>;
    recordDisclosureMismatch?(mismatch: PluginExecDisclosureMismatch): void;
    recordRuntimeLimitMeasurement?: HostRuntimeLimitMeasurementRecorder;
    readSpawnFailureLimits?: SpawnFailureLimitsReader;
}>): ExecService {
    const processOwnerTag = params.processOwner
        ? formatProcessOwnerTag({ happierHomeDir: configuration.happyHomeDir, owner: params.processOwner })
        : readHostProcessOwnerTag();
    const { custody, retain, assertOpen } = createNativeProcessCustodyForHost();
    const nativeLaunchQualifiers = new WeakSet<object>();
    const allowedExecutables = new Set(params.allowedExecutables.map(executableKey));
    const preResolvedSystemTools = new WeakMap<object, Readonly<{
        launch: ResolvedPluginExecutable;
        expiresAt: number | null;
    }>>();
    const preauthorizedSpawns =
        new WeakMap<object, ResolvedPluginExecutable>();
    const allowedEnvKeys = new Set(params.allowedEnvKeys ?? []);
    const admittedEnvironment = Object.freeze(Object.fromEntries(
        Object.entries(params.environment ?? {}).filter(([key]) => allowedEnvKeys.has(key)),
    ));

    function guard(signal?: AbortSignal, lifetime?: ManagedPluginExecLifetimeForHost): void {
        if (!(lifetime ? lifetime.isOccurrenceCurrent() : params.isOccurrenceCurrent())) {
            fail('plugin_generation_stale', 'Plugin occurrenceId is stale');
        }
        if (!lifetime) assertOpen();
        if ((lifetime?.signal ?? params.signal).aborted || signal?.aborted) {
            fail('plugin_exec_aborted', 'Process operation was aborted');
        }
    }

    function recordDisclosureMismatch(mismatch: Parameters<NonNullable<typeof params.recordDisclosureMismatch>>[0]): void {
        try {
            params.recordDisclosureMismatch?.(mismatch);
        } catch {
            // Cooperative-disclosure diagnostics cannot alter process semantics.
        }
    }

    function diagnoseDeclarationMismatches(
        request: Readonly<{ executable: ManagedExecutableRef; env?: Readonly<Record<string, string>> }>,
    ): void {
        if (!allowedExecutables.has(executableKey(request.executable))) {
            recordDisclosureMismatch({ capability: 'process', executable: request.executable });
        }
        const undeclaredEnvKeys = Object.keys(request.env ?? {}).filter((key) => !allowedEnvKeys.has(key));
        if (undeclaredEnvKeys.length > 0) {
            recordDisclosureMismatch({
                capability: 'environment',
                keys: Object.freeze(undeclaredEnvKeys.sort()),
            });
        }
    }

    const agentCli: PluginAgentCliReadinessService = Object.freeze({
        async checkReadiness(request: Parameters<PluginAgentCliReadinessService['checkReadiness']>[0]) {
            guard(request.signal);
            if (params.agentCli === undefined) {
                fail('plugin_exec_agent_cli_readiness_unavailable', 'Agent CLI readiness is unavailable in this invocation host');
            }
            const result = await params.agentCli.checkReadiness(request, request.includeVersion === true ? {
                ...(params.environment ? { environment: params.environment } : {}),
                async runVersionCommand(input) {
                    const { findCatalogEntry } = await import('@/agent/catalog/registry');
                    guard(input.signal);
                    const toolId = findCatalogEntry(input.agentId)?.agentCliSystemTool?.toolId;
                    if (!toolId) fail('plugin_exec_agent_cli_version_unavailable', 'Agent CLI has no declared system-tool execution binding');
                    const resolved = await resolvePluginExecSystemToolForHost(service, {
                        toolId,
                        purpose: 'Read the installed Agent CLI version',
                        preferredPath: input.launch.resolvedPath,
                        signal: input.signal,
                    });
                    if (resolved.command !== input.launch.command
                        || (resolved.args ?? []).length !== input.launch.args.length
                        || !(resolved.args ?? []).every((arg, index) => arg === input.launch.args[index])) {
                        fail('plugin_exec_agent_cli_version_unavailable', 'Authorized Agent CLI launch does not match the resolved CLI');
                    }
                    const processResult = await service.run({
                        executable: resolved.executable,
                        args: input.args,
                        timeoutMs: input.timeoutMs,
                    }, { signal: input.signal });
                    guard(input.signal);
                    if (processResult.termination.observed.kind !== 'exit' || processResult.termination.observed.exitCode !== 0) {
                        fail('plugin_exec_agent_cli_version_failed', 'Agent CLI version execution did not finish successfully');
                    }
                    return {
                        stdout: Buffer.from(processResult.stdout).toString('utf8'),
                        stderr: Buffer.from(processResult.stderr).toString('utf8'),
                    };
                },
            } : undefined);
            guard(request.signal);
            return Object.freeze({ launchable: Object.freeze([...result.launchable]) });
        },
    });

    const systemTools: PluginSystemToolsService = Object.freeze({
        async resolve(request: Parameters<PluginSystemToolsService['resolve']>[0]) {
            try {
                guard(request.signal);
                const executable = Object.freeze({
                    kind: 'systemTool' as const,
                    id: request.toolId,
                });
                diagnoseDeclarationMismatches({ executable });
                if (params.systemTools === undefined) {
                    fail('plugin_exec_system_tool_resolution_unavailable', 'System-tool resolution is unavailable in this invocation host');
                }
                const resolved = await params.systemTools.resolve(request);
                guard(request.signal);
                preResolvedSystemTools.set(executable, Object.freeze({
                    launch: Object.freeze({
                        command: resolved.launch.executablePath,
                        args: Object.freeze([...(resolved.launch.args ?? [])]),
                        env: Object.freeze({ ...(resolved.launch.env ?? {}) }),
                        ...(resolved.allowedArguments ? {
                            allowedArguments: Object.freeze([...resolved.allowedArguments]),
                        } : {}),
                    }),
                    expiresAt: resolved.expiresAt ?? null,
                }));
                return Object.freeze({
                    executable,
                    executablePath: resolved.executablePath,
                    ...(resolved.providerExitOwnership === 'direct' ? { providerExitOwnership: 'direct' as const } : {}),
                    ...(resolved.diagnostics ? {
                        diagnostics: Object.freeze(resolved.diagnostics.map((diagnostic) => {
                            const detail = Object.freeze(Object.fromEntries(
                                Object.entries(diagnostic.detail ?? {}).filter(
                                    (entry): entry is [string, string | number] => (
                                        typeof entry[1] === 'string'
                                        || (typeof entry[1] === 'number' && Number.isFinite(entry[1]))
                                    ),
                                ),
                            ));
                            return Object.freeze({
                                code: diagnostic.code,
                                ...(Object.keys(detail).length > 0 ? { detail } : {}),
                            });
                        })),
                    } : {}),
                });
            } catch (error) { throw withExecLaunchNotStarted(error); }
        },
    });

    async function authorizeLaunch(...args: Parameters<typeof prepareLaunch>): Promise<HostAuthorizedPluginExecLaunch> {
        try { return await prepareLaunch(...args); }
        catch (error) { throw withExecLaunchNotStarted(error); }
    }

    async function prepareLaunch(
        request: Parameters<ExecService['spawn']>[0] & Readonly<{ timeoutMs?: number }>,
        options?: { signal?: AbortSignal; nativeLaunch?: AgentNativeLaunchQualifier },
        projectLaunch?: HostProjectNativeLaunchAdmission,
        nativeExecutableOwner?: ExecService,
        prepareAgentNativeLaunch?: HostAgentNativeLaunchPreparation,
        lifetime?: ManagedPluginExecLifetimeForHost,
    ): Promise<HostAuthorizedPluginExecLaunch> {
        const assertCurrent = () => guard(options?.signal, lifetime);
        const resolveManagedExecutable = lifetime?.resolveManagedExecutable ?? params.resolveManagedExecutable;
        assertCurrent();
        const nativeLaunch = options?.nativeLaunch;
        const agentNativeLaunch = nativeLaunch !== undefined;
        assertNativeLaunchQualifier(nativeLaunchQualifiers, nativeLaunch);
        if (agentNativeLaunch && !params.authorizeLaunch && !params.prepareAgentNativeLaunch && !prepareAgentNativeLaunch) {
            fail('plugin_exec_native_launch_unavailable', 'Native Agent launch preparation is unavailable');
        }
        if (lifetime && (!resolveManagedExecutable || params.authorizeLaunch)) {
            return fail('plugin_exec_managed_launch_authorization_unavailable', 'Physical process launch authorization is unavailable');
        }
        validateExecLaunchInput(request);
        if (projectLaunch?.status === 'refused') {
            return fail(projectLaunch.code, 'Project launch preparation was not admitted');
        }
        if (params.authorizeLaunch) {
            if (projectLaunch) {
                return fail('plugin_project_launch_admission_unavailable', 'Project effects must be produced by the target host');
            }
            const launch = await params.authorizeLaunch(
                request,
                agentNativeLaunch ? { ...(options?.signal ? { signal: options.signal } : {}), agentNativeLaunch: true }
                    : options === undefined ? undefined : { ...(options.signal ? { signal: options.signal } : {}) },
            );
            try {
                assertCurrent();
                return launch;
            } catch (error) {
                launch.release();
                throw error;
            }
        }
        const environmentValidation = validateEnvVarRecordStrict(request.env);
        if (!environmentValidation.ok) {
            fail('plugin_exec_invalid_environment', environmentValidation.error);
        }
        diagnoseDeclarationMismatches(request);
        let resolved: ResolvedPluginExecutable;
        const preauthorized = preauthorizedSpawns.get(request);
        if (lifetime) {
            try {
                resolved = await resolveManagedExecutable!(request.executable, lifetime.isOccurrenceCurrent);
            } catch (error) {
                if (isPluginError(error)) throw error;
                return fail('plugin_exec_resolve_failed', 'Executable could not be resolved', error);
            }
        } else if (preauthorized) {
            preauthorizedSpawns.delete(request);
            resolved = preauthorized;
        } else {
            const preResolved = preResolvedSystemTools.get(request.executable);
            if (preResolved) {
            if (preResolved.expiresAt !== null && preResolved.expiresAt <= Date.now()) {
                preResolvedSystemTools.delete(request.executable);
                return fail('plugin_exec_system_tool_resolution_expired', 'Pre-resolved system-tool launch has expired');
            }
            resolved = preResolved.launch;
            } else {
                try {
                    resolved = await params.resolveExecutable(request.executable);
                } catch (error) {
                    if (isPluginError(error)) throw error;
                    return fail('plugin_exec_resolve_failed', 'Executable could not be resolved', error);
                }
            }
        }
        let released = false;
        const releaseExecutable = () => {
            if (released) return;
            released = true;
            resolved.release?.();
        };
        try {
            assertAllowedExecArguments(resolved, request.args ?? []);
        } catch (error) {
            releaseExecutable();
            throw error;
        }
        try {
            assertCurrent();
        } catch (error) {
            releaseExecutable();
            throw error;
        }
        let cwd: string | undefined;
        try {
            cwd = typeof request.cwd === 'string' ? await realpath(request.cwd)
                : request.cwd ? await params.resolvePath(request.cwd) : undefined;
        } catch (error) {
            releaseExecutable();
            if (isPluginError(error)) throw error;
            return fail('plugin_exec_cwd_unavailable', 'Process working directory could not be resolved', error);
        }
        if (
            request.cwd
            && (typeof request.cwd === 'string'
                || !isPluginPathCoveredByDisclosure(request.cwd, params.allowedCwdScopes ?? [], 'read'))
        ) {
            recordDisclosureMismatch({
                capability: 'filesystem',
                path: request.cwd,
                access: 'read',
            });
        }
        try {
            assertCurrent();
        } catch (error) {
            releaseExecutable();
            throw error;
        }
        const environment: Readonly<Record<string, string>> = {
            ...admittedEnvironment,
            ...(resolved.env ?? {}),
            ...(request.env ?? {}),
        };
        const signal = options?.signal ? AbortSignal.any([lifetime?.signal ?? params.signal, options.signal]) : lifetime?.signal ?? params.signal;
        try {
            const prepare = prepareAgentNativeLaunch ?? (agentNativeLaunch ? params.prepareAgentNativeLaunch : undefined);
            if (prepare && !projectLaunch) {
                const prepared = await prepare(signal, cwd, environment);
                assertCurrent();
                projectLaunch = prepared?.projectLaunch;
                nativeExecutableOwner = prepared?.nativeExecutableOwner;
            }
        } catch (error) {
            releaseExecutable();
            throw error;
        }
        return await finalizeHostExecLaunch({
            signal,
            assertCurrent,
            projectLaunch,
            ...(nativeExecutableOwner ? { resolveNativeExecutable: (executable: ManagedExecutableRef, signal: AbortSignal) =>
                resolveNativeExecutableForHost(nativeExecutableOwner, executable, signal) } : {}),
            launch: {
                command: resolved.command,
                args: [...(resolved.args ?? []), ...(request.args ?? [])],
                env: environment,
                ...(cwd ? { cwd } : {}),
                ...(request.stdin ? { stdin: new Uint8Array(request.stdin) } : {}),
                ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
                ...(request.maxStdoutBytes === undefined ? {} : { maxStdoutBytes: request.maxStdoutBytes }),
                ...(request.maxStderrBytes === undefined ? {} : { maxStderrBytes: request.maxStderrBytes }),
                release: releaseExecutable,
            },
        });
    }

    async function launchProcess(
        request: Parameters<ExecService['spawn']>[0] & Readonly<{ timeoutMs?: number }>,
        options?: Parameters<ExecService['run']>[1],
        transformProtocolClientEnvironment = false,
    ): Promise<SupervisedPluginProcess> {
        const launchStartedAt = performance.now();
        // Only the supervisor installs this exact host-owned request; public
        // Exec options cannot transfer invocation authority or process custody.
        const managedCustody = readInstalledManagedProcessCustody(service, request);
        if (managedCustody && options?.descendantDisposition === 'preserve-on-success') {
            throw withExecLaunchNotStarted(new PluginError({ code: 'plugin_exec_managed_handoff_forbidden', message: 'Managed process custody cannot be handed to a native tool' }));
        }
        const lifetime = managedCustody?.lifetime;
        const launch = await authorizeLaunch(request, options, undefined, undefined, undefined, lifetime);
        const authorizedAt = performance.now();
        try { guard(options?.signal, lifetime); }
        catch (error) { await launch.release(); throw withExecLaunchNotStarted(error); }
        let environment: Readonly<Record<string, string>>;
        let linuxProcessLaunchScope: LinuxProcessLaunchScope | null;
        try {
            try {
                environment = transformProtocolClientEnvironment
                    && params.transformAgentChildLaunchEnvironment
                    ? params.transformAgentChildLaunchEnvironment(launch.env)
                    : launch.env;
            } catch (error) {
                fail('plugin_exec_spawn_failed', 'Process could not be started', error);
            }
            linuxProcessLaunchScope = process.platform === 'linux' && managedCustody
                ? await prepareCgroupProcessLaunchScope() : null;
            if (params.assertLaunchCurrent) {
                await params.assertLaunchCurrent(options?.signal
                    ? AbortSignal.any([lifetime?.signal ?? params.signal, options.signal])
                    : lifetime?.signal ?? params.signal);
            }
            guard(options?.signal, lifetime);
        } catch (error) {
            await launch.release();
            throw withExecLaunchNotStarted(error);
        }
        const supervised = spawnAuthorizedHostExecLaunchForHost({ ...launch, env: environment,
            processOwnerTag: managedCustody?.processOwnerTag ?? processOwnerTag }, {
            readSpawnFailureLimits: params.readSpawnFailureLimits,
            ...(params.posixProcessGroup ? { posixProcessGroup: params.posixProcessGroup } : {}),
            ...(params.processTreeSystemBoundary ? { processTreeSystemBoundary: params.processTreeSystemBoundary } : {}),
            ...(options?.descendantDisposition ? { descendantDisposition: options.descendantDisposition } : {}),
            ...(lifetime ? { signal: lifetime.signal } : options?.signal ? { signal: options.signal } : {}),
            ...(managedCustody?.processCustody ? { processCustody: managedCustody.processCustody } : {}),
            ...(linuxProcessLaunchScope ? { linuxProcessLaunchScope } : {}),
            ...(params.recordRuntimeLimitMeasurement
                ? { recordRuntimeLimitMeasurement: params.recordRuntimeLimitMeasurement }
                : {}),
        });
        logger.infoFile('[PluginExec] Launch preparation phase', {
            phase: 'spawn_requested', executableKind: request.executable.kind, pid: supervised.child.pid,
            authorizationDurationMs: Math.round(authorizedAt - launchStartedAt),
            durationMs: Math.round(performance.now() - authorizedAt),
            elapsedMs: Math.round(performance.now() - launchStartedAt),
        });
        if (!lifetime) retain(supervised);
        const outputSubscription = !lifetime && options?.outputDelivery === 'invocation' && params.observeProcessOutput
            ? supervised.handle.onOutput(params.observeProcessOutput)
            : null;
        const retire = () => {
            void supervised.dispose('generationRetired').catch(() => undefined);
        };

        if (!lifetime) params.signal.addEventListener('abort', retire, { once: true });
        void supervised.waitForSettlement().then(() => {
            outputSubscription?.dispose();
            if (!lifetime) params.signal.removeEventListener('abort', retire);
        });
        return supervised;
    }

    async function spawnProcess(
        request: Parameters<ExecService['spawn']>[0],
        options?: Parameters<ExecService['spawn']>[1],
    ): Promise<PluginProcessHandle> {
        return (await launchProcess(request, options, true)).handle;
    }
    function guardJsonRpcClient(
        protocol: ReturnType<typeof createJsonRpcProcessClient>,
        assertCurrent: (signal?: AbortSignal) => void,
    ): PluginJsonRpcClient {
        const requestMethods = new Set<string>();
        const assertCallbackCurrent = () => {
            try {
                assertCurrent();
            } catch (error) {
                protocol.dispose(error instanceof Error ? error : undefined);
                throw error;
            }
        };
        return Object.freeze({
            async request(method: string, requestParams?: JsonValue, requestOptions?: { signal?: AbortSignal; timeoutMs?: number | null }) {
                assertCurrent(requestOptions?.signal);
                const result = await protocol.client.request<JsonValue | undefined, JsonValue>(method, requestParams, requestOptions);
                assertCurrent(requestOptions?.signal);
                return result;
            },
            notify: async (method: string, notificationParams?: JsonValue) => { assertCurrent(); await protocol.client.notify(method, notificationParams); },
            onNotificationReceived(listener: Parameters<PluginJsonRpcClient['onNotificationReceived']>[0]) {
                assertCurrent();
                const unsubscribe = protocol.subscribeNotificationReceived((message) => {
                    assertCallbackCurrent();
                    listener({
                        method: message.method,
                        ...(message.params === undefined ? {} : { params: message.params as JsonValue }),
                        receivedAtMs: message.receivedAtMs,
                    });
                });
                return Object.freeze({ dispose: unsubscribe });
            },
            onNotification(listener: Parameters<PluginJsonRpcClient['onNotification']>[0]) {
                assertCurrent();
                const unsubscribe = protocol.subscribeNotification((message) => {
                    assertCallbackCurrent();
                    return listener({
                        method: message.method,
                        ...(message.params === undefined ? {} : { params: message.params as JsonValue }),
                    });
                });
                return Object.freeze({ dispose: unsubscribe });
            },
            onRequest(method: string, listener: Parameters<PluginJsonRpcClient['onRequest']>[1]) {
                assertCurrent();
                if (requestMethods.has(method)) {
                    fail('plugin_exec_protocol_duplicate_handler', `JSON-RPC method '${method}' already has a responder`);
                }
                requestMethods.add(method);
                const unregister = protocol.client.registerRequestHandler(method, async (requestParams, context) => {
                    assertCallbackCurrent();
                    try {
                        return await listener({
                            id: context.requestId
                                ?? fail('plugin_exec_protocol_invalid_request', 'JSON-RPC server request is missing its correlation id'),
                            method,
                            ...(requestParams === undefined ? {} : { params: requestParams as JsonValue }),
                        });
                    } finally {
                        assertCallbackCurrent();
                    }
                });
                return Object.freeze({
                    dispose() {
                        requestMethods.delete(method);
                        unregister();
                    },
                });
            },
            dispose: () => protocol.dispose(),
        });
    }

    async function spawnJsonRpcClient(
        spec: Extract<Parameters<ExecService['clients']['spawn']>[0], { kind: 'jsonRpc' }>,
        options?: { signal?: AbortSignal },
    ): Promise<PluginProtocolClientHandle<'jsonRpc'>> {
        const supervised = await launchProcess(spec.launch, options, true);
        const protocol = createJsonRpcProcessClient({
            stdout: supervised.child.stdout,
            write: async (data) => supervised.handle.write(typeof data === 'string'
                ? new Uint8Array(Buffer.from(data, 'utf8'))
                : data),
            framing: spec.framing,
            maxFrameBytes: spec.maxFrameBytes,
            requestTimeoutMs: spec.requestTimeoutMs,
            cancellationMethod: spec.cancellationMethod,
            readStderrPreview: () => Buffer.from(supervised.readBufferedStderr()).toString('utf8'),
            onFailure: () => {
                void supervised.dispose('runtimeRecovery');
            },
            ...(params.recordRuntimeLimitMeasurement
                ? { recordRuntimeLimitMeasurement: params.recordRuntimeLimitMeasurement }
                : {}),
        });
        const client = guardJsonRpcClient(protocol, signal => guard(signal));
        const dispose = async (): Promise<void> => {
            protocol.dispose();
            // The supervisor owns joining and re-observing explicit cleanup.
            // Do not turn its failed observation into a permanent client latch.
            await supervised.dispose('caller');
        };
        void supervised.handle.wait().then((result) => {
            protocol.settleExit(new PluginExecClientError(
                'PLUGIN_EXEC_CLIENT_EXITED',
                `Plugin process terminated (${result.termination.observed.kind})`,
            ));
        });
        const handle: PluginProtocolClientHandle<'jsonRpc'> = Object.freeze({
            client,
            process: supervised.handle,
            wait: () => supervised.handle.wait(),
            dispose,
        });
        INTERNAL_PROTOCOL_GRACEFUL_DISPOSERS.set(handle, async beforeTerminate => {
            await supervised.dispose('caller', { beforeTerminate });
            protocol.dispose();
        });
        return handle;
    }

    async function spawnJsonStreamClient(
        spec: Extract<Parameters<ExecService['clients']['spawn']>[0], { kind: 'jsonStream' }>,
        options?: { signal?: AbortSignal },
    ): Promise<PluginProtocolClientHandle<'jsonStream'>> {
        const supervised = await launchProcess(spec.launch, options, true);
        const readStderrPreview = () => sanitizeExecDiagnosticText(
            Buffer.from(supervised.readBufferedStderr()).toString('utf8'),
            spec.launch.maxStderrBytes ?? 4_096,
        );
        const protocol = createJsonStreamProcessClient({
            process: adaptStablePluginExecLegacyProcessHandle(supervised),
            stdout: supervised.child.stdout,
            write: async (data) => supervised.handle.write(new Uint8Array(Buffer.from(data, 'utf8'))),
            maxFrameBytes: spec.maxFrameBytes,
            readStderrPreview,
            ...(params.recordRuntimeLimitMeasurement
                ? { recordRuntimeLimitMeasurement: params.recordRuntimeLimitMeasurement }
                : {}),
        });
        const client: PluginJsonStreamClient = Object.freeze({
            async write(value: JsonValue) {
                const outcome = await protocol.client.writeRecord(value);
                if (outcome.kind !== 'written') {
                    // Stay in the exec-client vocabulary: an exec-client rejection keeps its own
                    // code and diagnostics, and only a raw stream write failure is named here.
                    const rejected = outcome.error instanceof PluginExecClientError ? outcome.error : null;
                    throw new PluginExecClientError(
                        rejected?.code ?? 'PLUGIN_EXEC_CLIENT_WRITE_FAILED',
                        outcome.error.message,
                        {
                            cause: outcome.error,
                            details: { jsonStreamWriteOutcome: outcome.kind },
                            ...(rejected?.stderrPreview === undefined
                                ? {}
                                : { stderrPreview: rejected.stderrPreview }),
                            ...(rejected?.cleanProcessExit === undefined
                                ? {}
                                : { cleanProcessExit: rejected.cleanProcessExit }),
                        },
                    );
                }
            },
            subscribe(listener: Parameters<PluginJsonStreamClient['subscribe']>[0]) {
                const unsubscribe = protocol.client.subscribe((value) => listener(value as JsonValue));
                return Object.freeze({ dispose: unsubscribe });
            },
            dispose: () => protocol.dispose(),
        });
        const dispose = async (): Promise<void> => {
            protocol.dispose();
            await supervised.dispose('caller');
        };
        void supervised.handle.wait().then((result) => {
            const observed = result.termination.observed;
            protocol.settleExit(createPluginExecClientExitError({
                exitCode: observed.kind === 'exit' ? observed.exitCode : null,
                signal: observed.kind === 'signal' ? observed.signal : null,
                ...(observed.kind === 'failed'
                    ? { diagnostic: observed.diagnostic.message ?? observed.diagnostic.code }
                    : {}),
            }, readStderrPreview()));
        });
        return Object.freeze({ client, process: supervised.handle, wait: () => supervised.handle.wait(), dispose });
    }

    async function spawnFramedBytesClient(
        spec: Extract<Parameters<ExecService['clients']['spawn']>[0], { kind: 'framedBytes' }>,
        options?: { signal?: AbortSignal },
    ): Promise<PluginProtocolClientHandle<'framedBytes'>> {
        const supervised = await launchProcess(spec.launch, options, true);
        const protocol = createFramedBytesProcessClient({
            process: adaptStablePluginExecLegacyProcessHandle(supervised),
            stdout: supervised.child.stdout,
            write: (data) => supervised.handle.write(data),
            framing: spec.framing,
            maxFrameBytes: spec.maxFrameBytes,
            readStderrPreview: () => Buffer.from(supervised.readBufferedStderr()).toString('utf8'),
            ...(params.recordRuntimeLimitMeasurement
                ? { recordRuntimeLimitMeasurement: params.recordRuntimeLimitMeasurement }
                : {}),
        });
        const client: PluginFramedBytesClient = Object.freeze({
            writeFrame: (frame: Uint8Array) => protocol.client.writeFrame(frame),
            subscribe(listener: Parameters<PluginFramedBytesClient['subscribe']>[0]) {
                const unsubscribe = protocol.client.subscribe(listener);
                return Object.freeze({ dispose: unsubscribe });
            },
            dispose: () => protocol.dispose(),
        });
        const dispose = async (): Promise<void> => {
            protocol.dispose();
            await supervised.dispose('caller');
        };
        void supervised.handle.wait().then(() => {
            protocol.settleExit(new PluginExecClientError('PLUGIN_EXEC_CLIENT_EXITED', 'Plugin process terminated'));
        });
        return Object.freeze({ client, process: supervised.handle, wait: () => supervised.handle.wait(), dispose });
    }

    async function spawnLoopbackWebSocketClient(
        spec: Extract<Parameters<ExecService['clients']['spawn']>[0], { kind: 'loopbackWebSocketJson' }>,
        options?: { signal?: AbortSignal },
    ): Promise<PluginProtocolClientHandle<'loopbackWebSocketJson'>> {
        const supervised = await launchProcess(spec.launch, options, true);
        const process = {
            child: { stdin: supervised.child.stdin, stdout: supervised.child.stdout },
            handle: adaptStablePluginExecLegacyProcessHandle(supervised),
            readStderrPreview: () => Buffer.from(supervised.readBufferedStderr()).toString('utf8'),
        };
        let protocol: Awaited<ReturnType<typeof createLoopbackWebSocketJsonClient>>;
        try {
            if (spec.handshake) {
                const handshake = spec.handshake;
                protocol = await createLoopbackWebSocketHandshakeClient({
                    handshake: {
                        byteOrder: handshake.byteOrder,
                        requestFrames: handshake.requestFrames,
                        response: {
                            byteOrder: handshake.byteOrder,
                            maxFrameBytes: spec.maxFrameBytes,
                        },
                    },
                    endpoint: {
                        decodeHandshakeResponse: handshake.decodeResponse,
                        buildHeaders: (endpoint) => endpoint.headers ?? [],
                    },
                    limits: { maxMessageBytes: spec.maxFrameBytes },
                    process,
                    ...(options?.signal ? { optionsSignal: options.signal } : {}),
                    ...(params.recordRuntimeLimitMeasurement
                        ? { recordRuntimeLimitMeasurement: params.recordRuntimeLimitMeasurement }
                        : {}),
                });
            } else {
                protocol = await createLoopbackWebSocketJsonClient({
                    process,
                    endpoint: {
                        host: spec.endpoint.host,
                        port: spec.endpoint.port,
                        path: spec.endpoint.path ?? '/',
                    },
                    headers: spec.endpoint.headers ?? [],
                    limits: { maxMessageBytes: spec.maxFrameBytes },
                    ...(options?.signal ? { signal: options.signal } : {}),
                    readDiagnosticPreview: () => Buffer.from(supervised.readBufferedStderr()).toString('utf8'),
                    ...(params.recordRuntimeLimitMeasurement
                        ? { recordRuntimeLimitMeasurement: params.recordRuntimeLimitMeasurement }
                        : {}),
                });
            }
        } catch (error) {
            await supervised.dispose('caller');
            if (isPluginError(error)) throw error;
            return fail('plugin_exec_client_create_failed', 'Protocol client could not be created', error);
        }
        const client: PluginLoopbackWebSocketJsonClient = Object.freeze({
            send: (value: JsonValue) => protocol.client.sendJson(value),
            subscribe(listener: Parameters<PluginLoopbackWebSocketJsonClient['subscribe']>[0]) {
                const unsubscribe = protocol.client.subscribe((value) => listener(value as JsonValue));
                return Object.freeze({ dispose: unsubscribe });
            },
            dispose: () => protocol.dispose(),
        });
        const dispose = async (): Promise<void> => {
            protocol.dispose();
            await supervised.dispose('caller');
        };
        void supervised.handle.wait().then(() => {
            protocol.settleExit(new PluginExecClientError('PLUGIN_EXEC_CLIENT_EXITED', 'Plugin process terminated'));
        });
        return Object.freeze({ client, process: supervised.handle, wait: () => supervised.handle.wait(), dispose });
    }

    function assertJsonRpcLimits(spec: Pick<PluginJsonRpcConnectionSpec, 'maxFrameBytes' | 'requestTimeoutMs'>): void {
        if (spec.maxFrameBytes !== undefined && (!Number.isSafeInteger(spec.maxFrameBytes) || spec.maxFrameBytes <= 0)) {
            fail('plugin_exec_invalid_limit', 'maxFrameBytes must be a positive safe integer');
        }
        if (spec.requestTimeoutMs !== undefined && (!Number.isSafeInteger(spec.requestTimeoutMs) || spec.requestTimeoutMs < 0)) {
            fail('plugin_exec_invalid_limit', 'requestTimeoutMs must be a non-negative safe integer');
        }
    }

    async function connectJsonRpc(
        spec: PluginJsonRpcConnectionSpec,
        options?: { signal?: AbortSignal },
    ): Promise<PluginJsonRpcConnection> {
        const signal = options?.signal ? AbortSignal.any([params.signal, options.signal]) : params.signal;
        guard(signal);
        assertJsonRpcLimits(spec);
        if (spec.endpoint.kind !== 'unixWebSocket' || typeof spec.endpoint.socketPath !== 'string'
            || !isAbsolute(spec.endpoint.socketPath)) {
            fail('plugin_exec_invalid_endpoint', 'A native Unix connection requires an absolute socket path');
        }
        const socket = createConnection({ path: spec.endpoint.socketPath });
        const closed = new Promise<void>(resolve => { socket.once('close', () => resolve()); });
        let protocol: ReturnType<typeof createJsonRpcProcessClient> | undefined;
        const dispose = async (error?: Error): Promise<void> => {
            protocol?.dispose(error);
            socket.destroy(error);
            await closed;
        };
        const abort = () => { void dispose(createPluginExecClientAbortError()); };
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
        void closed.then(() => { signal.removeEventListener('abort', abort); });
        retain({ dispose: async () => await dispose(createPluginExecClientAbortError()), waitForSettlement: async () => await closed });
        try {
            // Keep the native OS error intact: the server's readiness owner decides retries.
            await new Promise<void>((resolve, reject) => {
                socket.once('connect', resolve);
                socket.once('error', reject);
            });
            guard(signal);
            protocol = createJsonRpcProcessClient({
                stdout: socket,
                write: async data => await new Promise<void>((resolve, reject) => {
                    socket.write(data, error => error ? reject(error) : resolve());
                }),
                framing: 'webSocket', maxFrameBytes: spec.maxFrameBytes,
                requestTimeoutMs: spec.requestTimeoutMs, cancellationMethod: spec.cancellationMethod,
                onFailure: error => { void dispose(error); },
                ...(params.recordRuntimeLimitMeasurement ? { recordRuntimeLimitMeasurement: params.recordRuntimeLimitMeasurement } : {}),
            });
            const client = guardJsonRpcClient(protocol, requestSignal => {
                guard(signal);
                guard(requestSignal);
            });
            return Object.freeze({ client, closed, dispose: async () => await dispose() });
        } catch (error) {
            await dispose();
            throw error;
        }
    }

    async function spawnProtocolClient(
        spec: PluginProtocolClientSpec,
        options?: { signal?: AbortSignal },
    ): Promise<PluginProtocolClientHandle> {
        try {
            if (spec.kind === 'jsonRpc') assertJsonRpcLimits(spec);
            else if (!Number.isSafeInteger(spec.maxFrameBytes) || spec.maxFrameBytes <= 0) {
                return fail('plugin_exec_invalid_limit', 'maxFrameBytes must be a positive safe integer');
            }
            if (spec.kind === 'loopbackWebSocketJson' && spec.endpoint && (
                !Number.isSafeInteger(spec.endpoint.port)
                || spec.endpoint.port < 1
                || spec.endpoint.port > 65_535
            )) {
                return fail('plugin_exec_invalid_endpoint', 'Loopback WebSocket port is invalid');
            }
            if (spec.kind === 'loopbackWebSocketJson' && spec.handshake && (
                spec.handshake.framing !== 'lengthPrefix'
                || !['little-endian', 'big-endian'].includes(spec.handshake.byteOrder)
            )) {
                return fail('plugin_exec_invalid_handshake', 'Loopback WebSocket handshake framing is invalid');
            }
        } catch (error) { throw withExecLaunchNotStarted(error); }
        switch (spec.kind) {
            case 'jsonRpc': return await spawnJsonRpcClient(spec, options);
            case 'jsonStream': return await spawnJsonStreamClient(spec, options);
            case 'framedBytes': return await spawnFramedBytesClient(spec, options);
            case 'loopbackWebSocketJson': return await spawnLoopbackWebSocketClient(spec, options);
        }
    }

    const clients: ProtocolClientsService = Object.freeze({
        connectJsonRpc,
        async spawn<K extends ProtocolClientKind>(
            spec: PluginProtocolClientSpecByKind<K>,
            options?: { signal?: AbortSignal },
        ): Promise<PluginProtocolClientHandle<K>> {
            return await spawnProtocolClient(spec, options) as PluginProtocolClientHandle<K>;
        },
    });

    const service: ExecService = Object.freeze({
        agentCli,
        systemTools,
        async run(
            request: Parameters<ExecService['run']>[0],
            options?: Parameters<ExecService['run']>[1],
        ) {
            const selectedRequest = options?.outputDelivery === 'invocation' && params.invocationTimeoutMs !== undefined
                ? { ...request, timeoutMs: params.invocationTimeoutMs ?? undefined }
                : request;
            const handle = (await launchProcess(
                selectedRequest.stdin === undefined
                    ? { ...selectedRequest, stdin: new Uint8Array() }
                    : selectedRequest,
                options,
            )).handle;
            try {
                return await handle.wait();
            } finally {
                await handle.dispose();
            }
        },
        spawn: spawnProcess,
        clients,
    });
    INTERNAL_PREAUTHORIZED_SPAWNS.set(service, preauthorizedSpawns);
    INTERNAL_NATIVE_LAUNCH_QUALIFIERS.set(service, nativeLaunchQualifiers);
    INTERNAL_RESOLVED_AGENT_LAUNCH_AUTHORIZERS.set(service, async (launch, signal, nativeLaunch) => {
        const combinedSignal = signal ? AbortSignal.any([params.signal, signal]) : params.signal;
        try {
            guard(combinedSignal);
            assertNativeLaunchQualifier(nativeLaunchQualifiers, nativeLaunch);
            if (nativeLaunch !== undefined && !params.prepareAgentNativeLaunch) {
                fail('plugin_exec_native_launch_unavailable', 'Native Agent launch preparation is unavailable');
            }
        } catch (error) {
            launch.release?.();
            throw error;
        }
        return await authorizeResolvedProjectExecLaunchForHost({
            launch: { ...launch, ...(processOwnerTag ? { processOwnerTag } : {}) },
            signal: combinedSignal, assertCurrent: () => guard(combinedSignal),
            prepareAgentNativeLaunch: params.prepareAgentNativeLaunch,
        });
    });
    INTERNAL_OWNER_REBINDERS.set(service, (owner, signal) => createStablePluginExecService({ ...params,
        processOwner: owner, signal: signal ? AbortSignal.any([params.signal, signal]) : params.signal }));
    INTERNAL_LAUNCH_AUTHORIZERS.set(service, authorizeLaunch);
    INTERNAL_PROCESS_CUSTODY.set(service, custody);
    INTERNAL_EXECUTABLE_RESOLVERS.set(service, async (executable, options) => {
        guard(options?.signal);
        diagnoseDeclarationMismatches({ executable });
        const resolved = await params.resolveExecutable(executable);
        try {
            guard(options?.signal);
            return resolved;
        } catch (error) {
            resolved.release?.();
            throw error;
        }
    });
    INTERNAL_SYSTEM_TOOL_RESOLVERS.set(service, async (request) => {
        const resolved = await systemTools.resolve(request);
        const preResolved = preResolvedSystemTools.get(resolved.executable);
        if (!preResolved) {
            fail(
                'plugin_exec_system_tool_resolution_unavailable',
                'The invocation-local system-tool launch is unavailable',
            );
        }
        if (
            preResolved.expiresAt !== null
            && preResolved.expiresAt <= Date.now()
        ) {
            preResolvedSystemTools.delete(resolved.executable);
            fail(
                'plugin_exec_system_tool_resolution_expired',
                'Pre-resolved system-tool launch has expired',
            );
        }
        return Object.freeze({
            executable: resolved.executable,
            command: preResolved.launch.command,
            ...(preResolved.launch.args
                ? { args: preResolved.launch.args }
                : {}),
            ...(preResolved.launch.env
                ? { env: preResolved.launch.env }
                : {}),
        });
    });
    return service;
}
