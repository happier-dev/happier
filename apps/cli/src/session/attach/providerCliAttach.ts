import { spawn } from 'node:child_process';

import { resolveWindowsCommandInvocation, type CommandInvocation } from '@happier-dev/cli-common/process';
import type { CatalogAgentLookupId } from '@/agent/catalog/types';
import type {
    AttachAvailabilityRequestV1,
    AttachSessionMetadataV1,
} from '@happier-dev/agents';
import type { AttachSurface } from '@happier-dev/plugin-sdk/agents/runtime';
import type { AgentCliLaunchSpec } from '@/packagedRuntime/managedTools/requireAgentCliLaunchSpec';
import { requireAgentCliLaunchSpec } from '@/packagedRuntime/managedTools/requireAgentCliLaunchSpec';

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
    metadata: AttachSessionMetadataV1;
    fallbackServerBaseUrl?: string | null;
}>) => ProviderCliAttachTargetResult<TTarget>;

function isLocalAttachRequest(request: AttachAvailabilityRequestV1): boolean {
    if (request.hasLocalAttachmentInfo === true) return true;
    if (
        request.currentMachineId
        && request.sessionMachineId
        && request.currentMachineId === request.sessionMachineId
    ) {
        return true;
    }
    return false;
}

async function readFallbackServerBaseUrl(params: Readonly<{
    sessionId: string;
    readFallbackServerBaseUrl?: (
        input: Readonly<{ sessionId: string }>,
    ) => Promise<string | null>;
}>): Promise<string | null> {
    if (!params.readFallbackServerBaseUrl) return null;
    try {
        const value = await params.readFallbackServerBaseUrl({ sessionId: params.sessionId });
        return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
    } catch {
        return null;
    }
}

async function resolveTargetWithFallback<TTarget extends object>(params: Readonly<{
    metadata: AttachSessionMetadataV1;
    sessionId: string;
    resolver: ProviderCliAttachTargetResolver<TTarget>;
    readFallbackServerBaseUrl?: (
        input: Readonly<{ sessionId: string }>,
    ) => Promise<string | null>;
}>): Promise<ProviderCliAttachTargetResult<TTarget>> {
    const fallbackServerBaseUrl = await readFallbackServerBaseUrl({
        sessionId: params.sessionId,
        readFallbackServerBaseUrl: params.readFallbackServerBaseUrl,
    });
    return params.resolver({
        metadata: params.metadata,
        fallbackServerBaseUrl,
    });
}

export function createProviderCliAttachSurface<TTarget extends object>(params: Readonly<{
    agentId: CatalogAgentLookupId;
    resolveTarget: ProviderCliAttachTargetResolver<TTarget>;
    createArgs: (target: TTarget) => readonly string[];
    buildHealthUrl?: (target: TTarget) => string | null;
    readFallbackServerBaseUrl?: (
        input: Readonly<{ sessionId: string }>,
    ) => Promise<string | null>;
    resolveLaunchSpec?: (env?: NodeJS.ProcessEnv) => AgentCliLaunchSpec;
    resolveCommandInvocation?: (params: Readonly<{
        command: string;
        args: readonly string[];
        env?: NodeJS.ProcessEnv;
    }>) => CommandInvocation;
    spawnProcess?: typeof spawn;
    fetchFn?: typeof fetch;
    env?: NodeJS.ProcessEnv;
    reachabilityTimeoutMs?: number;
}>): AttachSurface {
    const buildHealthUrl = params.buildHealthUrl;
    const resolveInvocation = params.resolveCommandInvocation ?? resolveWindowsCommandInvocation;
    return {
        evaluateAvailability: async (request) => {
            const target = await resolveTargetWithFallback({
                metadata: request.metadata,
                sessionId: request.sessionId,
                resolver: params.resolveTarget,
                readFallbackServerBaseUrl: isLocalAttachRequest(request)
                    ? params.readFallbackServerBaseUrl
                    : undefined,
            });
            if (!target.ok) {
                return {
                    available: false,
                    reasonCode: 'missing_metadata',
                    safeMessage: target.reason,
                };
            }
            if (request.depth === 'live') {
                if (!buildHealthUrl) {
                    return {
                        available: false,
                        reasonCode: 'unsupported',
                        safeMessage: 'Provider attach reachability is unavailable.',
                    };
                }
                const healthUrl = buildHealthUrl(target.value);
                if (!healthUrl) {
                    return {
                        available: false,
                        reasonCode: 'missing_metadata',
                        safeMessage: 'Provider attach health URL is invalid.',
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
                    if (!response?.ok) {
                        return {
                            available: false,
                            reasonCode: 'agent_unavailable',
                            retryable: true,
                            safeMessage: 'Provider attach target is unreachable.',
                        };
                    }
                } finally {
                    clearTimeout(timeout);
                }
            }
            return { available: true };
        },
        attach: async ({ metadata, sessionId }) => {
            const target = await resolveTargetWithFallback({
                metadata,
                sessionId,
                resolver: params.resolveTarget,
                readFallbackServerBaseUrl: params.readFallbackServerBaseUrl,
            });
            if (!target.ok) {
                return {
                    ok: false,
                    code: 'attach_failed',
                    message: target.reason,
                };
            }

            const env = params.env ?? process.env;
            const launch = (params.resolveLaunchSpec ?? ((processEnv) =>
                requireAgentCliLaunchSpec(params.agentId, { processEnv })))(env);
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

            const exitCode = await new Promise<number>((resolve) => {
                child.once('error', () => resolve(1));
                child.once('exit', (code) => resolve(typeof code === 'number' ? code : 1));
            });
            return { ok: true, value: { exitCode } };
        },
    };
}
