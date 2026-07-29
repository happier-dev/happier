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
import { isDeniedPathOnlyRuntimeName } from '@/plugins/runtime/exec/system/tools/runtimeDeny';
import { killProcessTree as defaultKillProcessTree } from '@/agent/runtime/process/killProcessTree';
import {
    createManagedChildProcess as defaultCreateManagedChildProcess,
    type ManagedChildProcess,
} from '@/subprocess/supervision/managedChildProcess';
import type { TerminationEvent } from '@/subprocess/supervision/types';
import { finalizeSessionChildEnvironment } from '@/session/runtime/control/finalizeSessionChildEnvironment';
import { buildScopedProcessEnv } from '@/utils/processEnv/buildScopedProcessEnv';

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
    const processEnv: NodeJS.ProcessEnv = { ...process.env };
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
    killProcessTree?: (child: ChildProcess, options?: Readonly<{ graceMs?: number }>) => Promise<void>;
    verifyExecutableGrant?: TerminalRuntimeExecutableGrantVerifier;
    registerExecutableGrant?: TerminalRuntimeExecutableGrantRegistrar;
    resolveAgentCliLaunch?: TerminalRuntimeAgentCliLaunchResolver;
    now?: () => number;
}>): HostTerminalProcessService {
    const spawn = deps?.spawn ?? nodeSpawn;
    const createManagedChildProcess = deps?.createManagedChildProcess ?? defaultCreateManagedChildProcess;
    const killProcessTree = deps?.killProcessTree ?? defaultKillProcessTree;
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
                source: launch.source,
                resolvedPath: launch.resolvedPath,
            });
        },
        async launch(request: HostTerminalProcessLaunchRequest): Promise<HostTerminalProcessHandle> {
            assertHostGrantedExecutable(request.executable, verifyExecutableGrant);
            assertNotAborted(request.signal);

            const childEnvironment = finalizeSessionChildEnvironment({
                environment: buildScopedProcessEnv({
                    baseEnv: process.env,
                    explicitEnv: request.env,
                    unsetEnvKeys: request.unsetEnvKeys,
                }),
                enableCgroupSelfMigration: false,
                stackProcessKind: null,
            });
            const child = spawn(request.executable.path, [...(request.args ?? [])], {
                cwd: request.cwd,
                env: childEnvironment,
                stdio: request.stdio ?? 'pipe',
                windowsHide: request.windowsHide,
                windowsVerbatimArguments: request.windowsVerbatimArguments,
            });
            let stopped = false;
            const stop = async (options?: Readonly<{ graceMs?: number }>): Promise<void> => {
                if (stopped) {
                    return;
                }
                stopped = true;
                request.signal?.removeEventListener('abort', abortListener);
                await killProcessTree(child, options);
            };
            const abortListener = (): void => {
                void stop();
            };
            request.signal?.addEventListener('abort', abortListener, { once: true });

            let managed: ManagedChildProcess;
            let readBufferedStderr: () => string;
            try {
                managed = createManagedChildProcess(child);
                readBufferedStderr = bufferChildStderr(child);
            } catch (error) {
                await stop().catch(() => undefined);
                throw error;
            }
            if (request.signal?.aborted) {
                await stop().catch(() => undefined);
                throw createAbortError();
            }

            return Object.freeze({
                pid: managed.pid,
                waitForTermination: async () => {
                    try {
                        return mapTerminationEvent(await managed.waitForTermination());
                    } finally {
                        request.signal?.removeEventListener('abort', abortListener);
                    }
                },
                stop,
                readBufferedStderr,
            });
        },
    });
}
