import type { SessionSubagent } from '@/sync/domains/session/subagents/types';

export function resolveSessionSubagentAdvancedRoute(params: Readonly<{
    sessionId: string;
    subagent: SessionSubagent;
}>): string | null {
    const normalizedSessionId = params.sessionId.trim();
    if (!normalizedSessionId) return null;

    const runId = params.subagent.runRef?.runId?.trim();
    if (!runId) return null;

    return `/session/${encodeURIComponent(normalizedSessionId)}/runs/${encodeURIComponent(runId)}`;
}
