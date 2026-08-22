import type { AgentCliReadinessService as PluginAgentCliReadinessService } from '@happier-dev/plugin-sdk/exec';

import { resolveAgentCliLaunchSpec } from '@/packagedRuntime/managedTools/requireAgentCliLaunchSpec';

export type CreatePluginAgentCliReadinessServiceParams = Readonly<{
    processEnv?: NodeJS.ProcessEnv;
}>;

function createAbortError(): Error {
    const error = new Error('Plugin agent CLI readiness check was aborted');
    error.name = 'AbortError';
    return error;
}

function assertNotAborted(signal: AbortSignal | undefined): void {
    if (signal?.aborted === true) {
        throw createAbortError();
    }
}

function uniqueCandidates(candidates: readonly string[]): readonly string[] {
    const normalized: string[] = [];
    const seen = new Set<string>();
    for (const candidate of candidates) {
        const value = candidate.trim();
        if (!value || seen.has(value)) continue;
        seen.add(value);
        normalized.push(value);
    }
    return Object.freeze(normalized);
}

function hasCurrentLaunchableAgentCli(agentId: string, processEnv: NodeJS.ProcessEnv): boolean {
    try {
        return resolveAgentCliLaunchSpec(agentId, { processEnv }) !== null;
    } catch {
        // An installed Agent without current runtime metadata is not launchable. Keep
        // the readiness boundary fail-closed instead of substituting another Agent.
        return false;
    }
}

export function createPluginAgentCliReadinessService(
    params: CreatePluginAgentCliReadinessServiceParams = {},
): PluginAgentCliReadinessService {
    const processEnv = params.processEnv ?? process.env;
    return Object.freeze({
        async checkReadiness(
            request: Parameters<PluginAgentCliReadinessService['checkReadiness']>[0],
        ) {
            assertNotAborted(request.signal);
            const launchable = uniqueCandidates(request.candidates)
                .filter((agentId) => hasCurrentLaunchableAgentCli(agentId, processEnv))
                .map((agentId) => Object.freeze({ agentId }));
            assertNotAborted(request.signal);
            return Object.freeze({ launchable: Object.freeze(launchable) });
        },
    });
}
