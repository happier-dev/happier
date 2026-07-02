import { isAgentId, type AgentId } from '@happier-dev/agents';
import type {
    AgentCliReadinessDiagnosticV1,
    AgentCliReadinessEntryV1,
    AgentCliLaunchableEntryV1,
    AgentCliReadinessQueryV1,
    AgentCliReadinessResultV1,
    AgentCliReadinessStatusV1,
    AgentsRuntimeServiceV1,
} from '@happier-dev/plugin-sdk';

import { resolveProviderCliLaunchSpec } from '@/packagedRuntime/managedTools/requireProviderCliLaunchSpec';

export type CreatePluginAgentsServiceParams = Readonly<{
    processEnv?: NodeJS.ProcessEnv;
}>;

const NO_CANDIDATES_DIAGNOSTIC: AgentCliReadinessDiagnosticV1 = Object.freeze({
    code: 'agent_cli_no_candidates',
    severity: 'warning',
    messageKey: 'plugins.agents.cli.noCandidates',
});

const LAUNCH_ONLY_CHECKS = Object.freeze({
    launch: 'passed',
    auth: 'not_checked',
    buildPolicy: 'not_checked',
} as const);

const LAUNCH_ONLY_DIAGNOSTIC: AgentCliReadinessDiagnosticV1 = Object.freeze({
    code: 'agent_cli_launch_only',
    severity: 'info',
    messageKey: 'plugins.agents.cli.launchOnly',
});

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
        if (!value || seen.has(value)) {
            continue;
        }
        seen.add(value);
        normalized.push(value);
    }
    return Object.freeze(normalized);
}

function missingDiagnostic(agentId: string): AgentCliReadinessDiagnosticV1 {
    return Object.freeze({
        code: 'agent_cli_missing',
        severity: 'error',
        messageKey: 'plugins.agents.cli.missing',
        detail: Object.freeze({ agentId }),
    });
}

function unknownDiagnostic(agentId: string): AgentCliReadinessDiagnosticV1 {
    return Object.freeze({
        code: 'agent_cli_unknown',
        severity: 'warning',
        messageKey: 'plugins.agents.cli.unknown',
        detail: Object.freeze({ agentId }),
    });
}

function readinessEntry(params: AgentCliReadinessEntryV1): AgentCliReadinessEntryV1 {
    return Object.freeze({
        ...params,
        ...(params.diagnostics ? { diagnostics: Object.freeze([...params.diagnostics]) } : {}),
    });
}

function resolveCandidateReadiness(
    agentId: string,
    processEnv: NodeJS.ProcessEnv,
): AgentCliReadinessEntryV1 {
    if (!isAgentId(agentId)) {
        return readinessEntry({
            agentId,
            status: 'unknown',
            diagnostics: [unknownDiagnostic(agentId)],
        });
    }

    const resolved = resolveProviderCliLaunchSpec(agentId as AgentId, { processEnv });
    if (!resolved) {
        return readinessEntry({
            agentId,
            status: 'missing',
            diagnostics: [missingDiagnostic(agentId)],
        });
    }

    return readinessEntry({
        agentId,
        status: 'launchable',
        scope: 'launch',
        checks: LAUNCH_ONLY_CHECKS,
        source: resolved.source,
        diagnostics: [LAUNCH_ONLY_DIAGNOSTIC],
    });
}

function statusForResult(params: Readonly<{
    requirement: 'any' | 'all';
    entries: readonly AgentCliReadinessEntryV1[];
    launchable: readonly AgentCliLaunchableEntryV1[];
    missing: readonly AgentCliReadinessEntryV1[];
    blocked: readonly AgentCliReadinessEntryV1[];
    unknown: readonly AgentCliReadinessEntryV1[];
}>): AgentCliReadinessStatusV1 {
    if (params.entries.length === 0) {
        return 'unknown';
    }

    if (params.requirement === 'any') {
        if (params.launchable.length > 0) return 'launchable';
        if (params.blocked.length > 0) return 'blocked';
        if (params.missing.length > 0) return 'missing';
        return 'unknown';
    }

    if (params.launchable.length === params.entries.length) {
        return 'launchable';
    }
    if (params.blocked.length > 0) {
        return 'blocked';
    }
    if (params.missing.length > 0) {
        return 'missing';
    }
    return 'unknown';
}

export function createPluginAgentsService(
    params: CreatePluginAgentsServiceParams = {},
): AgentsRuntimeServiceV1 {
    const processEnv = params.processEnv ?? process.env;
    return Object.freeze({
        cli: Object.freeze({
            async checkReadiness(query: AgentCliReadinessQueryV1): Promise<AgentCliReadinessResultV1> {
                assertNotAborted(query.signal);
                const entries = uniqueCandidates(query.candidates)
                    .map((candidate) => resolveCandidateReadiness(candidate, processEnv));
                const launchable = Object.freeze(entries.filter((entry): entry is AgentCliLaunchableEntryV1 => entry.status === 'launchable'));
                const missing = Object.freeze(entries.filter((entry) => entry.status === 'missing'));
                const blocked = Object.freeze(entries.filter((entry) => entry.status === 'blocked'));
                const unknown = Object.freeze(entries.filter((entry) => entry.status === 'unknown'));
                const status = statusForResult({
                    requirement: query.requirement,
                    entries,
                    launchable,
                    missing,
                    blocked,
                    unknown,
                });
                return Object.freeze({
                    status,
                    launchable,
                    missing,
                    blocked,
                    ...(unknown.length > 0 ? { unknown } : {}),
                    ...(entries.length === 0 ? { diagnostics: [NO_CANDIDATES_DIAGNOSTIC] } : {}),
                });
            },
        }),
    });
}
