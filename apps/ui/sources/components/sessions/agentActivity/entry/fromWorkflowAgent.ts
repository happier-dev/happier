import { fromWorkflowAgentStatus } from '@happier-dev/protocol';

import type { WorkflowAgentRowViewModel } from '@/components/sessions/workState/sessionWorkflowActivityTypes';
import { t } from '@/text';

import {
    AGENT_ACTIVITY_ROW_NO_ACTIONS,
    type AgentActivityRowEntry,
} from '../agentActivityRowEntry';
import { formatElapsedDuration } from '../presentation/formatElapsedDuration';
import { resolveAgentActivityElapsedStartMs } from '../presentation/resolveAgentActivityElapsedStartMs';

/**
 * The one projection from a durable workflow agent to the shared row's presentation contract.
 *
 * It exists because the transcript workflow card and the work-state popover render the SAME agent
 * and used to do it through a second row component with its own glyph table, its own status colours
 * and its own duration formatter. Both hosts now build their rows here, so a workflow agent reads
 * identically wherever it appears and identically to a subagent beside it in the Agents pane.
 *
 * **Where the duration lives is decided once, here.** The row's time column is the single owner of
 * "how long" whenever it can make an honest claim, and `resolveAgentActivityElapsedStartMs` is the
 * arbiter of that — the same guard the row itself uses, asked rather than restated. Only when the
 * column will render nothing does the provider's own `timeUsedSeconds` fall back into the meta line,
 * so a snapshot that reports a duration without timestamps still shows it. Without that fallback the
 * migration would silently drop a datum the old row displayed; with the duration left in the meta
 * line unconditionally, a finished agent would print the same duration twice in two formats.
 */
export function resolveAgentActivityEntryFromWorkflowAgent(
    agent: WorkflowAgentRowViewModel,
): AgentActivityRowEntry {
    const timestamps = {
        startedAtMs: agent.startedAtMs ?? null,
        endedAtMs: agent.endedAtMs ?? null,
        // Evidence of activity, so the shared row's quiet/stale note applies to a workflow agent
        // exactly as it applies to a subagent beside it. Absent stays absent: no evidence is a
        // statement about our own hydration, never about the agent (4.10).
        updatedAtMs: agent.updatedAtMs ?? null,
    };
    const status = fromWorkflowAgentStatus(agent.status);
    const rendersElapsed = resolveAgentActivityElapsedStartMs({
        id: agent.rowId,
        title: agent.title,
        status,
        actions: AGENT_ACTIVITY_ROW_NO_ACTIONS,
        ...timestamps,
    }) != null;

    return {
        id: agent.rowId,
        title: agent.title,
        status,
        metaDetail: resolveWorkflowAgentMetrics(agent, { includeDuration: !rendersElapsed }),
        ...timestamps,
        // A workflow agent has no route, no send channel and no stop control of its own — every
        // affordance §4.4 defines belongs to the run, not to one agent inside it. An empty list is
        // what makes the row render no overflow at all, rather than an empty menu.
        actions: AGENT_ACTIVITY_ROW_NO_ACTIONS,
    };
}

const META_SEPARATOR = ' · ';

/**
 * Provider metrics, in the fixed order the workflow card has always used.
 *
 * Zero is dropped rather than rendered: an agent that reports `0 tokens` has reported nothing, and
 * saying so takes width from the title for no information.
 */
function resolveWorkflowAgentMetrics(
    agent: WorkflowAgentRowViewModel,
    options: Readonly<{ includeDuration: boolean }>,
): string | null {
    const parts: string[] = [];

    if (typeof agent.tokensUsed === 'number' && agent.tokensUsed > 0) {
        parts.push(t('tools.workflowActivityView.tokens', { tokens: formatTokenCount(agent.tokensUsed) }));
    }
    if (typeof agent.toolCalls === 'number' && agent.toolCalls > 0) {
        parts.push(t('tools.workflowActivityView.toolCalls', { count: agent.toolCalls }));
    }
    if (options.includeDuration && typeof agent.timeUsedSeconds === 'number' && agent.timeUsedSeconds > 0) {
        parts.push(formatElapsedDuration(agent.timeUsedSeconds * 1_000));
    }

    return parts.length > 0 ? parts.join(META_SEPARATOR) : null;
}

function formatTokenCount(tokens: number): string {
    return tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens);
}
