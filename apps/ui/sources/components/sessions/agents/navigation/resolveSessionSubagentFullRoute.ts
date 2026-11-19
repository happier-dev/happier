import type { SessionSubagent } from '@/sync/domains/session/subagents/types';
import { normalizeSessionId } from '@/sync/domains/session/normalizeSessionId';
import { buildScopedSessionRouteHref } from '@/hooks/session/sessionRouteServerScope';

export function resolveSessionSubagentFullRoute(params: Readonly<{
    sessionId: string;
    serverId?: string | null;
    subagent: Pick<SessionSubagent, 'kind' | 'runRef' | 'transcript'>;
}>): string | null {
    const normalizedSessionId = normalizeSessionId(params.sessionId);
    if (!normalizedSessionId) return null;

    const runId = params.subagent.runRef?.runId?.trim();
    // Execution Runs have one canonical Details destination on every host. Transcript
    // evidence may arrive after a row is first rendered, but that must enrich the Run
    // surface rather than changing the row's navigation identity to a tool message.
    if (params.subagent.kind === 'execution_run' && runId) {
        return buildScopedSessionRouteHref({
            sessionId: normalizedSessionId,
            serverId: params.serverId,
            suffix: `/runs/${encodeURIComponent(runId)}`,
        });
    }

    const routeId = params.subagent.transcript.toolMessageRouteId?.trim();
    if (routeId) {
        return buildScopedSessionRouteHref({
            sessionId: normalizedSessionId,
            serverId: params.serverId,
            suffix: `/message/${encodeURIComponent(routeId)}`,
        });
    }

    if (runId) {
        return buildScopedSessionRouteHref({
            sessionId: normalizedSessionId,
            serverId: params.serverId,
            suffix: `/runs/${encodeURIComponent(runId)}`,
        });
    }

    return null;
}
