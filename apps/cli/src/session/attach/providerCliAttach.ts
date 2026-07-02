import { spawn } from 'node:child_process';

import { resolveWindowsCommandInvocation, type CommandInvocation } from '@happier-dev/cli-common/process';
import type { CatalogAgentLookupId, ProviderAttachOps, ProviderAttachScope } from '@/backends/types';
import type { ProviderCliLaunchSpec } from '@/packagedRuntime/managedTools/requireProviderCliLaunchSpec';
import { requireProviderCliLaunchSpec } from '@/packagedRuntime/managedTools/requireProviderCliLaunchSpec';

type SpawnedAttachProcess = Readonly<{
    once: {
        (event: 'exit', handler: (code: number | null, signal: NodeJS.Signals | null) => void): void;
        (event: 'error', handler: (error: Error) => void): void;
    };
}>;

export type ProviderCliAttachTargetResult<TTarget extends object> =
    | Readonly<{ ok: true; value: TTarget }>
    | Readonly<{ ok: false; reason: string }>;

export type ProviderCliAttachTargetResolver<TTarget extends object> = (params: Readonly<{
    metadata: Record<string, unknown>;
    fallbackServerBaseUrl?: string | null;
}>) => ProviderCliAttachTargetResult<TTarget>;

function resolveAttachScope(params: Readonly<{
    currentMachineId: string | null;
    sessionMachineId: string | null;
    hasLocalAttachmentInfo: boolean;
}>): ProviderAttachScope {
    if (params.hasLocalAttachmentInfo) return 'local';
    if (
        params.currentMachineId
        && params.sessionMachineId
        && params.currentMachineId === params.sessionMachineId
    ) {
        return 'local';
    }
    return 'remote';
}

async function readFallbackServerBaseUrl(params: Readonly<{
    readFallbackServerBaseUrl?: () => Promise<string | null>;
}>): Promise<string | null> {
    if (!params.readFallbackServerBaseUrl) return null;
    try {
        const value = await params.readFallbackServerBaseUrl();
        return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
    } catch {
        return null;
    }
}

async function resolveTargetWithFallback<TTarget extends object>(params: Readonly<{
    metadata: Record<string, unknown>;
    resolver: ProviderCliAttachTargetResolver<TTarget>;
    readFallbackServerBaseUrl?: () => Promise<string | null>;
}>): Promise<ProviderCliAttachTargetResult<TTarget>> {
    const fallbackServerBaseUrl = await readFallbackServerBaseUrl({
        readFallbackServerBaseUrl: params.readFallbackServerBaseUrl,
    });
    return params.resolver({
        metadata: params.metadata,
        fallbackServerBaseUrl,
    });
}

export function createProviderCliAttachOps<TTarget extends object>(params: Readonly<{
    agentId: CatalogAgentLookupId;
    resolveTarget: ProviderCliAttachTargetResolver<TTarget>;
    createArgs: (target: TTarget) => readonly string[];
    buildHealthUrl?: (target: TTarget) => string | null;
    readFallbackServerBaseUrl?: () => Promise<string | null>;
    resolveLaunchSpec?: (env?: NodeJS.ProcessEnv) => ProviderCliLaunchSpec;
    resolveCommandInvocation?: (params: Readonly<{
        command: string;
        args: readonly string[];
        env?: NodeJS.ProcessEnv;
    }>) => CommandInvocation;
    spawnProcess?: typeof spawn;
    fetchFn?: typeof fetch;
    env?: NodeJS.ProcessEnv;
    reachabilityTimeoutMs?: number;
}>): ProviderAttachOps {
    const buildHealthUrl = params.buildHealthUrl;
    const resolveInvocation = params.resolveCommandInvocation ?? resolveWindowsCommandInvocation;
    return {
        evaluateAvailability: async (request) => {
            const scope = resolveAttachScope({
                currentMachineId: request.currentMachineId,
                sessionMachineId: request.sessionMachineId,
                hasLocalAttachmentInfo: request.hasLocalAttachmentInfo,
            });
            const target = await resolveTargetWithFallback({
                metadata: request.metadata,
                resolver: params.resolveTarget,
                readFallbackServerBaseUrl: scope === 'local'
                    ? params.readFallbackServerBaseUrl
                    : undefined,
            });
            if (!target.ok) {
                return {
                    eligible: false,
                    reason: target.reason,
                };
            }
            return {
                eligible: true,
                scope,
                metadata: request.metadata,
            };
        },
        probeReachability: buildHealthUrl
            ? async ({ metadata }) => {
                const target = await resolveTargetWithFallback({
                    metadata,
                    resolver: params.resolveTarget,
                    readFallbackServerBaseUrl: params.readFallbackServerBaseUrl,
                });
                if (!target.ok) {
                    return {
                        reachable: false,
                        reason: target.reason,
                    };
                }

                const healthUrl = buildHealthUrl(target.value);
                if (!healthUrl) {
                    return {
                        reachable: false,
                        reason: 'Provider attach health URL is invalid.',
                    };
                }

                const controller = new AbortController();
                const timeout = setTimeout(() => controller.abort(), params.reachabilityTimeoutMs ?? 1_500);
                timeout.unref?.();
                try {
                    const response = await (params.fetchFn ?? fetch)(healthUrl, {
                        method: 'GET',
                        signal: controller.signal,
                    }).catch(() => null);
                    return response?.ok
                        ? { reachable: true }
                        : { reachable: false, reason: 'Provider attach target is unreachable.' };
                } finally {
                    clearTimeout(timeout);
                }
            }
            : undefined,
        attach: async ({ metadata }) => {
            const target = await resolveTargetWithFallback({
                metadata,
                resolver: params.resolveTarget,
                readFallbackServerBaseUrl: params.readFallbackServerBaseUrl,
            });
            if (!target.ok) return 1;

            const env = params.env ?? process.env;
            const launch = (params.resolveLaunchSpec ?? ((processEnv) =>
                requireProviderCliLaunchSpec(params.agentId, { processEnv })))(env);
            const invocation = resolveInvocation({
                command: launch.command,
                args: [
                    ...launch.args,
                    ...params.createArgs(target.value),
                ],
                env,
            });
            const child = (params.spawnProcess ?? spawn)(
                invocation.command,
                invocation.args,
                {
                    env,
                    shell: false,
                    stdio: 'inherit',
                    ...(invocation.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
                },
            ) as unknown as SpawnedAttachProcess;

            return await new Promise<number>((resolve) => {
                child.once('error', () => resolve(1));
                child.once('exit', (code) => resolve(typeof code === 'number' ? code : 1));
            });
        },
    };
}
