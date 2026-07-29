import { isAgentId, type AgentId } from '@happier-dev/agents';
import type { PluginAgentCliReadinessService } from '@happier-dev/plugin-sdk/runtime';

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
                .filter((agentId): agentId is AgentId => isAgentId(agentId))
                .filter((agentId) => resolveAgentCliLaunchSpec(agentId, { processEnv }) !== null)
                .map((agentId) => Object.freeze({ agentId }));
            assertNotAborted(request.signal);
            return Object.freeze({ launchable: Object.freeze(launchable) });
        },
    });
}
