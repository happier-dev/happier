import type { SessionSubagent } from '@/sync/domains/session/subagents/types';
import { normalizeSessionId } from '@/sync/domains/session/normalizeSessionId';

export function resolveSessionSubagentAdvancedRoute(params: Readonly<{
    sessionId: string;
    subagent: SessionSubagent;
}>): string | null {
    const normalizedSessionId = normalizeSessionId(params.sessionId);
    if (!normalizedSessionId) return null;

    const runId = params.subagent.runRef?.runId?.trim();
    if (!runId) return null;

    return `/session/${encodeURIComponent(normalizedSessionId)}/runs/${encodeURIComponent(runId)}`;
}
