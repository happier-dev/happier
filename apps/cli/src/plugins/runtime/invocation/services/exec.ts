import type { JsonValue } from '@happier-dev/plugin-sdk';
import type { ManagedExecutableRef } from '@happier-dev/plugin-sdk/managed-services';
import type { AgentCliReadinessService as PluginAgentCliReadinessService, ExecService, PluginProcessHandle, SystemToolsService as PluginSystemToolsService } from '@happier-dev/plugin-sdk/exec';
import type { PluginFramedBytesClient, PluginJsonRpcClient, PluginJsonStreamClient, PluginLoopbackWebSocketJsonClient, PluginProtocolClientHandle, PluginProtocolClientSpec, PluginProtocolClientSpecByKind, ProtocolClientsService } from '@happier-dev/plugin-sdk/exec/protocol-clients';
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
} from '../../exec/processSupervisor';
import type { ProcessCustodySpawnSpec } from '@/subprocess/supervision/processCustody';
import {
    PluginExecClientError,
    createPluginExecClientExitError,
    sanitizeExecDiagnosticText,
} from '../../exec/errors';
import {
    isPluginPathCoveredByDisclosure,
    type PluginFileSystemScope,
} from './filesystem';
import type { HostRuntimeLimitMeasurementRecorder } from '@/agent/runtime/state/runtimeLimitMeasurement';
import { validateEnvVarRecordStrict } from '@/terminal/runtime/envVarSanitization';

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
 * Host-internal native-custody installs, keyed by the exact spawn request.
 * When present for a request, `launchProcess` starts the custody helper as the
 * command and passes the authorized target launch through it, so the helper
 * establishes the job containment before the target's first instruction while
 * command/args/cwd/env and stdio stay exactly the authorized ones.
 */
const INTERNAL_MANAGED_PROCESS_CUSTODY = new WeakMap<
    ExecService,
    WeakMap<object, ProcessCustodySpawnSpec>
>();

export function installManagedProcessCustodyForHost(
    service: Pick<ExecService, 'spawn' | 'run'>,
    request: Parameters<ExecService['spawn']>[0],
    custody: ProcessCustodySpawnSpec,
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
): ProcessCustodySpawnSpec | null {
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
    release(): void;
}>;

export type PluginExecDisclosureMismatch =
    | Readonly<{ capability: 'process'; executable: ManagedExecutableRef }>
    | Readonly<{ capability: 'environment'; keys: readonly string[] }>
    | Readonly<{ capability: 'filesystem'; path: PluginPath; access: 'read' }>;

const INTERNAL_LAUNCH_AUTHORIZERS = new WeakMap<
    ExecService,
    (
        request: Parameters<ExecService['spawn']>[0]
            & Readonly<{ timeoutMs?: number }>,
        options?: Readonly<{ signal?: AbortSignal }>,
    ) => Promise<HostAuthorizedPluginExecLaunch>
>();

export async function authorizePluginExecLaunchForHost(
    service: ExecService,
    request: Parameters<ExecService['spawn']>[0]
        & Readonly<{ timeoutMs?: number }>,
    options?: Readonly<{ signal?: AbortSignal }>,
): Promise<HostAuthorizedPluginExecLaunch> {
    const authorize = INTERNAL_LAUNCH_AUTHORIZERS.get(service);
    if (!authorize) {
        return fail(
            'plugin_exec_launch_authorization_unavailable',
            'Exact process launch authorization is unavailable in this invocation host',
        );
    }
    return await authorize(request, options);
}

export function createStableRunnerPluginExecService(
    params: Readonly<{
        signal: AbortSignal;
        isGenerationCurrent(): boolean;
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
            options?: Readonly<{ signal?: AbortSignal }>,
            systemToolResolutionId?: string,
        ): Promise<HostAuthorizedPluginExecLaunch>;
        transformAgentChildLaunchEnvironment?(
            environment: Readonly<Record<string, string>>,
        ): Readonly<Record<string, string>>;
        recordRuntimeLimitMeasurement?:
            HostRuntimeLimitMeasurementRecorder;
    }>,
): ExecService {
    const systemToolResolutionIds = new WeakMap<object, string>();
    const base = createStablePluginExecService({
        allowedExecutables: [],
        signal: params.signal,
        isGenerationCurrent: params.isGenerationCurrent,
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
            const resolved =
                await params.resolveSystemTool(request);
            systemToolResolutionIds.set(
                resolved.result.executable,
                resolved.resolutionId,
            );
            return resolved.result;
        },
    });
    return Object.freeze({
        ...base,
        agentCli: params.agentCli,
        systemTools,
    });
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
    const resolveSystemTool = INTERNAL_SYSTEM_TOOL_RESOLVERS.get(service);
    if (!resolveSystemTool) {
        fail(
            'plugin_exec_system_tool_resolution_unavailable',
            'System-tool executable resolution is unavailable in this invocation host',
        );
    }
    return await resolveSystemTool(request);
}

export async function resolvePluginExecManagedDependencyForHost(
    service: ExecService,
    dependencyId: string,
    options?: Readonly<{ signal?: AbortSignal }>,
): Promise<HostResolvedManagedDependencyExecutable> {
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
}

type ProtocolClientKind = PluginProtocolClientSpec['kind'];

export function resolveStablePluginExecInvocation(input: Readonly<{
    command: string;
    args: readonly string[];
    env: NodeJS.ProcessEnv;
}>) {
    return resolveWindowsCommandInvocation(input);
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
    allowedExecutables: readonly ManagedExecutableRef[];
    allowedEnvKeys?: readonly string[];
    environment?: Readonly<Record<string, string>>;
    allowedCwdScopes?: readonly PluginFileSystemScope[];
    signal: AbortSignal;
    isGenerationCurrent(): boolean;
    resolveExecutable(executable: ManagedExecutableRef): Promise<ResolvedPluginExecutable>;
    resolvePath(path: PluginPath): Promise<string>;
    agentCli?: PluginAgentCliReadinessService;
    systemTools?: ExecSystemToolServiceV1;
    authorizeLaunch?(
        request: Parameters<ExecService['spawn']>[0]
            & Readonly<{ timeoutMs?: number }>,
        options?: Readonly<{ signal?: AbortSignal }>,
    ): Promise<HostAuthorizedPluginExecLaunch>;
    transformAgentChildLaunchEnvironment?(
        environment: Readonly<Record<string, string>>,
    ): Readonly<Record<string, string>>;
    recordDisclosureMismatch?(mismatch: PluginExecDisclosureMismatch): void;
    recordRuntimeLimitMeasurement?: HostRuntimeLimitMeasurementRecorder;
}>): ExecService {
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

    function guard(signal?: AbortSignal): void {
        if (!params.isGenerationCurrent()) {
            fail('plugin_generation_stale', 'Plugin generation is stale');
        }
        if (params.signal.aborted || signal?.aborted) {
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
            const result = await params.agentCli.checkReadiness(request);
            guard(request.signal);
            return Object.freeze({ launchable: Object.freeze([...result.launchable]) });
        },
    });

    const systemTools: PluginSystemToolsService = Object.freeze({
        async resolve(request: Parameters<PluginSystemToolsService['resolve']>[0]) {
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
        },
    });

    function validateOptionalByteLimit(value: number | undefined, field: string): void {
        if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
            fail('plugin_exec_invalid_limit', `${field} must be a non-negative safe integer`);
        }
    }

    function validateSpawnRequest(request: Parameters<ExecService['spawn']>[0] & { timeoutMs?: number }): void {
        validateOptionalByteLimit(request.maxStdoutBytes, 'maxStdoutBytes');
        validateOptionalByteLimit(request.maxStderrBytes, 'maxStderrBytes');
        if (request.timeoutMs !== undefined && (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs < 0)) {
            fail('plugin_exec_invalid_limit', 'timeoutMs must be a non-negative safe integer');
        }
        if (request.stdin !== undefined && !(request.stdin instanceof Uint8Array)) {
            fail('plugin_exec_invalid_input', 'Process stdin must be binary data');
        }
    }

    async function authorizeLaunch(
        request: Parameters<ExecService['spawn']>[0] & Readonly<{ timeoutMs?: number }>,
        options?: { signal?: AbortSignal },
    ): Promise<HostAuthorizedPluginExecLaunch> {
        guard(options?.signal);
        validateSpawnRequest(request);
        if (params.authorizeLaunch) {
            const launch = await params.authorizeLaunch(
                request,
                options,
            );
            try {
                guard(options?.signal);
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
        if (preauthorized) {
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
        const allowedArguments = resolved.allowedArguments;
        if (
            allowedArguments !== undefined
            && (request.args ?? []).some((argument) => !allowedArguments.includes(argument))
        ) {
            releaseExecutable();
            return fail(
                'plugin_exec_argument_denied',
                'Process argument is not authorized for this system tool',
            );
        }
        try {
            guard(options?.signal);
        } catch (error) {
            releaseExecutable();
            throw error;
        }
        let cwd: string | undefined;
        try {
            cwd = request.cwd ? await params.resolvePath(request.cwd) : undefined;
        } catch (error) {
            releaseExecutable();
            if (isPluginError(error)) throw error;
            return fail('plugin_exec_cwd_unavailable', 'Process working directory could not be resolved', error);
        }
        if (
            request.cwd
            && !isPluginPathCoveredByDisclosure(request.cwd, params.allowedCwdScopes ?? [], 'read')
        ) {
            recordDisclosureMismatch({
                capability: 'filesystem',
                path: request.cwd,
                access: 'read',
            });
        }
        try {
            guard(options?.signal);
        } catch (error) {
            releaseExecutable();
            throw error;
        }
        const environment = {
            ...admittedEnvironment,
            ...(resolved.env ?? {}),
            ...(request.env ?? {}),
        };
        const invocation = resolveStablePluginExecInvocation({
            command: resolved.command,
            args: [
                ...(resolved.args ?? []),
                ...(request.args ?? []),
            ],
            env: environment,
        });
        return Object.freeze({
            command: invocation.command,
            args: Object.freeze([...invocation.args]),
            env: Object.freeze({ ...environment }),
            ...(cwd ? { cwd } : {}),
            ...(request.stdin
                ? { stdin: new Uint8Array(request.stdin) }
                : {}),
            ...(request.timeoutMs === undefined
                ? {}
                : { timeoutMs: request.timeoutMs }),
            ...(request.maxStdoutBytes === undefined
                ? {}
                : {
                    maxStdoutBytes:
                        request.maxStdoutBytes,
                }),
            ...(request.maxStderrBytes === undefined
                ? {}
                : {
                    maxStderrBytes:
                        request.maxStderrBytes,
                }),
            ...(invocation.windowsVerbatimArguments
                ? { windowsVerbatimArguments: true }
                : {}),
            release: releaseExecutable,
        });
    }

    async function launchProcess(
        request: Parameters<ExecService['spawn']>[0] & Readonly<{ timeoutMs?: number }>,
        options?: { signal?: AbortSignal },
        transformProtocolClientEnvironment = false,
    ): Promise<SupervisedPluginProcess> {
        const launch = await authorizeLaunch(request, options);
        const managedCustody = readInstalledManagedProcessCustody(service, request);
        let supervised: ReturnType<typeof spawnSupervisedPluginProcess>;
        try {
            const environment = transformProtocolClientEnvironment
                && params.transformAgentChildLaunchEnvironment
                ? params.transformAgentChildLaunchEnvironment(
                    launch.env,
                )
                : launch.env;
            supervised = spawnSupervisedPluginProcess({
                command: managedCustody
                    ? managedCustody.executablePath
                    : launch.command,
                args: managedCustody
                    ? Object.freeze([
                        'run',
                        `--job=${managedCustody.jobName}`,
                        `--handshake=${managedCustody.handshakePath}`,
                        '--',
                        launch.command,
                        ...launch.args,
                    ])
                    : launch.args,
                ...(launch.cwd ? { cwd: launch.cwd } : {}),
                env: environment,
                ...(launch.stdin ? { stdin: launch.stdin } : {}),
                ...(launch.timeoutMs === undefined ? {} : { timeoutMs: launch.timeoutMs }),
                ...(launch.maxStdoutBytes === undefined ? {} : { maxStdoutBytes: launch.maxStdoutBytes }),
                ...(launch.maxStderrBytes === undefined ? {} : { maxStderrBytes: launch.maxStderrBytes }),
                signals: options?.signal ? [options.signal] : [],
                ...(managedCustody ? { processCustody: managedCustody } : {}),
                spawnOptions: {
                    // A dedicated POSIX process group lets the canonical supervisor
                    // terminate the complete plugin tree immediately without first
                    // enumerating every process on the host. Windows remains attached
                    // and terminates through the named job containment.
                    detached: process.platform !== 'win32',
                    // Under custody the helper's own argv is built here and must
                    // use the standard quoting contract so the helper can decode
                    // and re-render the target command line losslessly.
                    ...(managedCustody
                        ? {}
                        : { windowsVerbatimArguments: launch.windowsVerbatimArguments }),
                },
                ...(params.recordRuntimeLimitMeasurement
                    ? { recordRuntimeLimitMeasurement: params.recordRuntimeLimitMeasurement }
                    : {}),
            });
        } catch (error) {
            launch.release();
            return fail('plugin_exec_spawn_failed', 'Process could not be started', error);
        }
        const retire = () => {
            void supervised.dispose('generationRetired');
        };

        params.signal.addEventListener('abort', retire, { once: true });
        void supervised.handle.wait().finally(() => {
            params.signal.removeEventListener('abort', retire);
            launch.release();
        });
        return supervised;
    }

    async function spawnProcess(
        request: Parameters<ExecService['spawn']>[0],
        options?: { signal?: AbortSignal },
    ): Promise<PluginProcessHandle> {
        return (await launchProcess(request, options, true)).handle;
    }
    async function spawnJsonRpcClient(
        spec: Extract<Parameters<ExecService['clients']['spawn']>[0], { kind: 'jsonRpc' }>,
        options?: { signal?: AbortSignal },
    ): Promise<PluginProtocolClientHandle<'jsonRpc'>> {
        const supervised = await launchProcess(spec.launch, options, true);
        const legacyProcess = adaptStablePluginExecLegacyProcessHandle(supervised);
        const protocol = createJsonRpcProcessClient({
            process: legacyProcess,
            stdout: supervised.child.stdout,
            write: async (data) => supervised.handle.write(typeof data === 'string'
                ? new Uint8Array(Buffer.from(data, 'utf8'))
                : data),
            framing: spec.framing,
            maxFrameBytes: spec.maxFrameBytes,
            requestTimeoutMs: spec.requestTimeoutMs,
            readStderrPreview: () => Buffer.from(supervised.readBufferedStderr()).toString('utf8'),
            onFailure: () => {
                void supervised.dispose('runtimeRecovery');
            },
            ...(params.recordRuntimeLimitMeasurement
                ? { recordRuntimeLimitMeasurement: params.recordRuntimeLimitMeasurement }
                : {}),
        });
        const requestMethods = new Set<string>();
        const client: PluginJsonRpcClient = Object.freeze({
            async request(method: string, requestParams?: JsonValue, requestOptions?: { signal?: AbortSignal; timeoutMs?: number | null }) {
                return await protocol.client.request<JsonValue | undefined, JsonValue>(method, requestParams, requestOptions);
            },
            notify: (method: string, notificationParams?: JsonValue) => protocol.client.notify(method, notificationParams),
            onNotification(listener: Parameters<PluginJsonRpcClient['onNotification']>[0]) {
                const unsubscribe = protocol.subscribeNotification((message) => listener({
                    method: message.method,
                    ...(message.params === undefined ? {} : { params: message.params as JsonValue }),
                }));
                return Object.freeze({ dispose: unsubscribe });
            },
            onRequest(method: string, listener: Parameters<PluginJsonRpcClient['onRequest']>[1]) {
                if (requestMethods.has(method)) {
                    fail('plugin_exec_protocol_duplicate_handler', `JSON-RPC method '${method}' already has a responder`);
                }
                requestMethods.add(method);
                const unregister = protocol.client.registerRequestHandler(method, async (requestParams, context) => {
                    return await listener({
                        id: context.requestId
                            ?? fail('plugin_exec_protocol_invalid_request', 'JSON-RPC server request is missing its correlation id'),
                        method,
                        ...(requestParams === undefined ? {} : { params: requestParams as JsonValue }),
                    });
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
        let disposePromise: Promise<void> | null = null;
        const dispose = (): Promise<void> => {
            disposePromise ??= (async () => {
                protocol.dispose();
                await supervised.dispose('caller');
            })();
            return disposePromise;
        };
        void supervised.handle.wait().then((result) => {
            protocol.settleExit(new PluginExecClientError(
                'PLUGIN_EXEC_CLIENT_EXITED',
                `Plugin process terminated (${result.termination.observed.kind})`,
            ));
        });
        return Object.freeze({
            client,
            process: supervised.handle,
            wait: () => supervised.handle.wait(),
            dispose,
        });
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
        let disposePromise: Promise<void> | null = null;
        const dispose = (): Promise<void> => {
            disposePromise ??= (async () => {
                protocol.dispose();
                await supervised.dispose('caller');
            })();
            return disposePromise;
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
        let disposePromise: Promise<void> | null = null;
        const dispose = (): Promise<void> => {
            disposePromise ??= (async () => {
                protocol.dispose();
                await supervised.dispose('caller');
            })();
            return disposePromise;
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
                    process: {
                        child: {
                            stdin: supervised.child.stdin,
                            stdout: supervised.child.stdout,
                        },
                        handle: adaptStablePluginExecLegacyProcessHandle(supervised),
                        readStderrPreview: () => Buffer.from(supervised.readBufferedStderr()).toString('utf8'),
                    },
                    ...(options?.signal ? { optionsSignal: options.signal } : {}),
                    ...(params.recordRuntimeLimitMeasurement
                        ? { recordRuntimeLimitMeasurement: params.recordRuntimeLimitMeasurement }
                        : {}),
                });
            } else {
                protocol = await createLoopbackWebSocketJsonClient({
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
        let disposePromise: Promise<void> | null = null;
        const dispose = (): Promise<void> => {
            disposePromise ??= (async () => {
                protocol.dispose();
                await supervised.dispose('caller');
            })();
            return disposePromise;
        };
        void supervised.handle.wait().then(() => {
            protocol.settleExit(new PluginExecClientError('PLUGIN_EXEC_CLIENT_EXITED', 'Plugin process terminated'));
        });
        return Object.freeze({ client, process: supervised.handle, wait: () => supervised.handle.wait(), dispose });
    }

    async function spawnProtocolClient(
        spec: PluginProtocolClientSpec,
        options?: { signal?: AbortSignal },
    ): Promise<PluginProtocolClientHandle> {
        if (!Number.isSafeInteger(spec.maxFrameBytes) || spec.maxFrameBytes <= 0) {
            return fail('plugin_exec_invalid_limit', 'maxFrameBytes must be a positive safe integer');
        }
        if (spec.kind === 'jsonRpc' && spec.requestTimeoutMs !== undefined && (
            !Number.isSafeInteger(spec.requestTimeoutMs) || spec.requestTimeoutMs < 0
        )) {
            return fail('plugin_exec_invalid_limit', 'requestTimeoutMs must be a non-negative safe integer');
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
        switch (spec.kind) {
            case 'jsonRpc': return await spawnJsonRpcClient(spec, options);
            case 'jsonStream': return await spawnJsonStreamClient(spec, options);
            case 'framedBytes': return await spawnFramedBytesClient(spec, options);
            case 'loopbackWebSocketJson': return await spawnLoopbackWebSocketClient(spec, options);
        }
    }

    const clients: ProtocolClientsService = Object.freeze({
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
            const handle = (await launchProcess(
                request.stdin === undefined
                    ? { ...request, stdin: new Uint8Array() }
                    : request,
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
    INTERNAL_LAUNCH_AUTHORIZERS.set(service, authorizeLaunch);
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
