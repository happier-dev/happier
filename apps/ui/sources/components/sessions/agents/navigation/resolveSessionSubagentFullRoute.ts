import type { SessionSubagent } from '@/sync/domains/session/subagents/types';

export function resolveSessionSubagentFullRoute(params: Readonly<{
    sessionId: string;
    subagent: SessionSubagent;
}>): string | null {
    const normalizedSessionId = params.sessionId.trim();
    if (!normalizedSessionId) return null;

    const routeId = params.subagent.transcript.toolMessageRouteId?.trim();
    if (routeId) {
        return `/session/${encodeURIComponent(normalizedSessionId)}/message/${encodeURIComponent(routeId)}`;
    }

    const runId = params.subagent.runRef?.runId?.trim();
    if (runId) {
        return `/session/${encodeURIComponent(normalizedSessionId)}/runs/${encodeURIComponent(runId)}`;
    }

    return null;
}
