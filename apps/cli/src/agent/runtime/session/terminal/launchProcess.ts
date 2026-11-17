import { createHash } from 'node:crypto';
import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { isAbsolute } from 'node:path';

import type {
    HostTerminalAgentCliResolutionRequest,
    HostTerminalAgentCliResolution,
    HostTerminalProcessExecutable,
    HostTerminalProcessExecutableGrantKind,
    HostTerminalProcessHandle,
    HostTerminalProcessLaunchRequest,
    HostTerminalProcessService,
    HostTerminalProcessTermination,
} from './contract';

import type { CatalogAgentLookupId } from '@/agent/catalog/types';
import {
    requireAgentCliLaunchSpec,
    type AgentCliLaunchSpec,
} from '@/packagedRuntime/managedTools/requireAgentCliLaunchSpec';
import type { PluginExecAgentCliGrantRecord } from '@/plugins/runtime/exec/system/tools/definitions';
import { requireAgentNativeLaunchAuthorityForHost, type HostAgentNativeLaunchAuthority } from '@/plugins/runtime/invocation/services/exec';
import { isDeniedPathOnlyRuntimeName } from '@/plugins/runtime/exec/system/tools/runtimeDeny';
import { createProcessTreeStopper, terminateProcessTree as defaultKillProcessTree } from '@/processes/terminate/terminateProcessTree';
import { logger } from '@/ui/logger';
import {
    createManagedChildProcess as defaultCreateManagedChildProcess,
    type ManagedChildProcess,
} from '@/subprocess/supervision/managedChildProcess';
import type { TerminationEvent } from '@/subprocess/supervision/types';
import { finalizeSessionChildEnvironment } from '@/session/runtime/control/finalizeSessionChildEnvironment';
import { buildScopedProcessEnv } from '@/utils/processEnv/buildScopedProcessEnv';
import { withHostProcessOwnerEnvironment } from '@/processes/ownerTag';
import { sessionProcessEnvironment } from '@/agent/runtime/lifecycle/hostedSessionScope';
import { spawnSessionProcess } from '@/subprocess/supervision/sessionHolder';
import { assertTerminalPreambleTransport } from '@/integrations/terminal/host/errors';
import { createProcessStdinWriter } from '@/plugins/runtime/exec/processSupervisor';

type SpawnLike = (
    command: string,
    args: readonly string[],
    options: SpawnOptions,
) => ChildProcess;

export type TerminalRuntimeExecutableGrantVerifier = (
    request: Readonly<{
        kind: HostTerminalProcessExecutableGrantKind;
        grantId: string;
        executablePath: string;
    }>,
) => boolean;

export type TerminalRuntimeExecutableGrantRegistrar = (grant: PluginExecAgentCliGrantRecord) => void;

export type TerminalRuntimeAgentCliLaunchResolver = (
    request: HostTerminalAgentCliResolutionRequest,
) => AgentCliLaunchSpec | Promise<AgentCliLaunchSpec>;

function mapTerminationEvent(event: TerminationEvent): HostTerminalProcessTermination {
    if (event.type === 'signaled') {
        return { type: 'signaled', signal: event.signal };
    }
    return event;
}

function assertHostGrantedExecutable(
    executable: HostTerminalProcessExecutable,
    verifyExecutableGrant: TerminalRuntimeExecutableGrantVerifier | undefined,
): void {
    if (!isAbsolute(executable.path)) {
        throw new Error('Terminal runtime process launch requires an absolute executable path');
    }
    const hostGrant = executable.hostGrant;
    if (
        !hostGrant
        || (hostGrant.kind !== 'system-tool' && hostGrant.kind !== 'agent-cli')
        || typeof hostGrant.grantId !== 'string'
        || hostGrant.grantId.trim().length === 0
    ) {
        throw new Error('Terminal runtime process launch requires a host-issued executable grant');
    }
    if (hostGrant.kind === 'system-tool' && isDeniedPathOnlyRuntimeName(executable.path)) {
        throw new Error('Terminal runtime process launch denied managed runtime or package-manager executable');
    }
    if (!verifyExecutableGrant?.({
        kind: hostGrant.kind,
        grantId: hostGrant.grantId,
        executablePath: executable.path,
    })) {
        throw new Error('Terminal runtime process launch requires a trusted host-issued executable grant');
    }
}

function bufferChildStderr(child: ChildProcess): () => string {
    const chunks: string[] = [];
    const stderr = child.stderr;
    if (!stderr) {
        return () => '';
    }
    stderr.setEncoding('utf8');
    stderr.on('data', (chunk) => {
        chunks.push(String(chunk));
    });
    return () => chunks.join('');
}

function createAbortError(): Error {
    const error = new Error('Terminal runtime process launch was aborted');
    error.name = 'AbortError';
    return error;
}

function assertNotAborted(signal: AbortSignal | undefined): void {
    if (signal?.aborted) {
        throw createAbortError();
    }
}

function buildAgentCliProcessEnv(
    request: HostTerminalAgentCliResolutionRequest,
): NodeJS.ProcessEnv {
    const processEnv: NodeJS.ProcessEnv = { ...sessionProcessEnvironment() };
    for (const [key, value] of Object.entries(request.env ?? {})) {
        if (typeof value === 'string') {
            processEnv[key] = value;
        }
    }
    return processEnv;
}

function resolveDefaultAgentCliLaunch(
    request: HostTerminalAgentCliResolutionRequest,
): AgentCliLaunchSpec {
    return requireAgentCliLaunchSpec(request.agentId as CatalogAgentLookupId, {
        processEnv: buildAgentCliProcessEnv(request),
    });
}

function createAgentCliGrantId(params: Readonly<{
    agentId: string;
    executablePath: string;
    resolvedPath: string;
    issuedAt: number;
}>): string {
    const digest = createHash('sha256')
        .update(params.agentId)
        .update('\0')
        .update(params.executablePath)
        .update('\0')
        .update(params.resolvedPath)
        .update('\0')
        .update(String(params.issuedAt))
        .digest('hex')
        .slice(0, 16);
    return `agent-cli:${digest}`;
}

export function createTerminalRuntimeProcessService(deps?: Readonly<{
    spawn?: SpawnLike;
    createManagedChildProcess?: (child: ChildProcess) => ManagedChildProcess;
    terminateProcessTree?: (child: ChildProcess, options?: Readonly<{ graceMs?: number }>) => Promise<void>;
    verifyExecutableGrant?: TerminalRuntimeExecutableGrantVerifier;
    registerExecutableGrant?: TerminalRuntimeExecutableGrantRegistrar;
    resolveAgentCliLaunch?: TerminalRuntimeAgentCliLaunchResolver;
    readNativeLaunchAuthority?(): HostAgentNativeLaunchAuthority | null;
    now?: () => number;
}>): HostTerminalProcessService {
    const spawn = deps?.spawn ?? nodeSpawn;
    const createManagedChildProcess = deps?.createManagedChildProcess ?? defaultCreateManagedChildProcess;
    const terminateProcessTree = deps?.terminateProcessTree ?? defaultKillProcessTree;
    const verifyExecutableGrant = deps?.verifyExecutableGrant;
    const registerExecutableGrant = deps?.registerExecutableGrant;
    const resolveAgentCliLaunch = deps?.resolveAgentCliLaunch ?? resolveDefaultAgentCliLaunch;
    const now = (): number => deps?.now?.() ?? Date.now();

    return Object.freeze({
        async resolveAgentCliExecutable(
            request: HostTerminalAgentCliResolutionRequest,
        ): Promise<HostTerminalAgentCliResolution> {
            assertNotAborted(request.signal);
            if (!registerExecutableGrant) {
                throw new Error('Terminal runtime agent CLI executable resolution requires a host grant registry');
            }
            const launch = await resolveAgentCliLaunch(request);
            assertNotAborted(request.signal);
            if (!isAbsolute(launch.command)) {
                throw new Error('Terminal runtime agent CLI executable resolution requires an absolute host-resolved command');
            }
            const issuedAt = now();
            const grant: PluginExecAgentCliGrantRecord = Object.freeze({
                kind: 'agent-cli',
                grantId: createAgentCliGrantId({
                    agentId: request.agentId,
                    executablePath: launch.command,
                    resolvedPath: launch.resolvedPath,
                    issuedAt,
                }),
                agentId: request.agentId,
                source: launch.source,
                resolvedPath: launch.resolvedPath,
                executablePath: launch.command,
                expiresAt: null,
            });
            registerExecutableGrant(grant);
            return Object.freeze({
                executable: Object.freeze({
                    path: launch.command,
                    hostGrant: Object.freeze({
                        kind: 'agent-cli' as const,
                        grantId: grant.grantId,
                    }),
                }),
                args: Object.freeze([...launch.args]),
                ...(launch.providerExitOwnership ? { providerExitOwnership: launch.providerExitOwnership } : {}),
                source: launch.source,
                resolvedPath: launch.resolvedPath,
            });
        },
        async launch(request: HostTerminalProcessLaunchRequest): Promise<HostTerminalProcessHandle> {
            assertHostGrantedExecutable(request.executable, verifyExecutableGrant);
            assertNotAborted(request.signal);

            const childEnvironment = finalizeSessionChildEnvironment({
                environment: buildScopedProcessEnv({
                    baseEnv: sessionProcessEnvironment(),
                    explicitEnv: request.env,
                    unsetEnvKeys: request.unsetEnvKeys,
                }),
                explicitEnvironment: request.env,
                enableCgroupSelfMigration: false,
                stackProcessKind: null,
            });
            const authority = requireAgentNativeLaunchAuthorityForHost(deps?.readNativeLaunchAuthority?.(), 'terminal');
            const signal = request.signal ? AbortSignal.any([authority.signal, request.signal]) : authority.signal;
            const launch = await authority.authorize({ command: request.executable.path, args: request.args ?? [],
                cwd: request.cwd, env: childEnvironment,
                ...(request.requiredFiles?.length ? { requiredFiles: request.requiredFiles } : {}),
            }, signal);
            let child: ChildProcess;
            try {
                assertNotAborted(signal);
                assertTerminalPreambleTransport(launch.stdinPreamble, request.stdio !== 'inherit');
                child = spawnSessionProcess(launch.command, [...launch.args], {
                    ...(launch.requiredFiles ? { requiredFiles: launch.requiredFiles } : {}),
                    targetLaunchSignal: signal,
                    cwd: launch.launcherCwd ?? launch.cwd,
                    env: withHostProcessOwnerEnvironment(launch.env, launch.processOwnerTag),
                    stdio: request.stdio ?? 'pipe',
                    windowsHide: request.windowsHide,
                    windowsVerbatimArguments: launch.windowsVerbatimArguments ?? request.windowsVerbatimArguments,
                }, spawn);
            } catch (error) { await launch.release(); throw error; }
            const stopProcess = createProcessTreeStopper(async options => {
                await terminateProcessTree(child, options);
                signal.removeEventListener('abort', abortListener);
            });
            const stop = stopProcess.stop;
            const abortListener = (): void => {
                void stop().catch(() => {
                    logger.infoFile('[terminal-runtime] Process termination after cancellation failed', {
                        code: 'terminal_process_stop_failed',
                    });
                });
            };
            signal.addEventListener('abort', abortListener, { once: true });

            let managed: ManagedChildProcess;
            let readBufferedStderr: () => string;
            try {
                managed = createManagedChildProcess(child);
                readBufferedStderr = bufferChildStderr(child);
                if (launch.stdinPreamble?.byteLength) await createProcessStdinWriter(child.stdin!)(launch.stdinPreamble);
                assertNotAborted(signal);
            } catch (error) {
                try {
                    try { await stop(); }
                    finally { await launch.release(); }
                } catch (cleanupError) {
                    throw new AggregateError([error, cleanupError], 'Terminal process launch and cleanup failed', { cause: error });
                }
                throw error;
            }

            const termination = managed.waitForTermination().then(mapTerminationEvent).finally(async () => {
                signal.removeEventListener('abort', abortListener);
                await launch.release();
            });
            // The terminal owner may ask to Stop before it starts awaiting the result.
            void termination.catch(() => undefined);
            return Object.freeze({
                pid: managed.pid,
                waitForTermination: () => termination,
                stop,
                readBufferedStderr,
            });
        },
    });
}
