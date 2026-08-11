import type { AgentActivityStatusV1 } from '@happier-dev/protocol';

import type { SessionSubagent, SessionSubagentKind } from '../../subagents/types';
import type { AgentActivityEntryKind, AgentActivityLocalEntry } from '../types';

/**
 * Locally derived subagents, adapted into the merge's vocabulary.
 *
 * It deliberately does NOT re-derive a subagent's title, meta line, status override or timestamps.
 * That projection already has one owner —
 * `components/sessions/agentActivity/entry/fromSubagent.resolveAgentActivityEntryFromSubagent`
 * — which needs route resolution and translated presentation, and lives in the component layer for
 * that reason. A second projection here would be a split-brain over exactly the question this
 * program exists to settle: what one unit of agent work is called and what state it is in. So the
 * caller hands in what it already projected, and this module adds only what the MERGE needs and the
 * row does not: the kind, and the handle the two sources are joined on.
 */

/** The already-projected presentation fields the merge carries through unchanged. */
export type SessionSubagentActivityProjection = Readonly<{
    id: string;
    status: AgentActivityStatusV1;
    title: string;
    metaDetail?: string | null;
    startedAtMs?: number | null;
    updatedAtMs?: number | null;
    endedAtMs?: number | null;
}>;

const ENTRY_KIND_BY_SUBAGENT_KIND: Record<SessionSubagentKind, AgentActivityEntryKind> = {
    subagent_sidechain: 'subagent',
    execution_run: 'execution_run',
    agent_team_member: 'agent_team_member',
};

export function resolveSessionSubagentActivityKind(subagent: SessionSubagent): AgentActivityEntryKind {
    return ENTRY_KIND_BY_SUBAGENT_KIND[subagent.kind];
}

/**
 * The provider tool-use id this subagent was launched by, or `null`.
 *
 * One rule for all three local kinds, because all three record the same thing: a Claude sidechain is
 * keyed by the tool-use id that opened it (`sdkToLogConverter` writes `sidechainId: toolUseId`;
 * `resolveToolTranscriptSidechainId` returns `tool.id`), and every derivation stores that id under
 * `transcript.sidechainId`, falling back to the tool call's own id when no sidechain was observed.
 *
 * This is the same string the CLI names an agent by, which is what makes the cross-source join
 * possible at all: the two sides cannot agree on an entry id (only the CLI knows which run it
 * attached an agent to) but they can agree on this.
 */
export function resolveSessionSubagentActivityHandle(subagent: SessionSubagent): string | null {
    const sidechainId = subagent.transcript.sidechainId?.trim();
    if (sidechainId) return sidechainId;
    const toolId = subagent.transcript.toolId?.trim();
    return toolId ? toolId : null;
}

export function toLocalAgentActivityEntry(params: Readonly<{
    subagent: SessionSubagent;
    projection: SessionSubagentActivityProjection;
}>): AgentActivityLocalEntry {
    const { projection, subagent } = params;
    return {
        id: projection.id,
        kind: resolveSessionSubagentActivityKind(subagent),
        handle: resolveSessionSubagentActivityHandle(subagent),
        status: projection.status,
        title: projection.title,
        metaDetail: projection.metaDetail ?? null,
        startedAtMs: projection.startedAtMs ?? null,
        updatedAtMs: projection.updatedAtMs ?? null,
        endedAtMs: projection.endedAtMs ?? null,
        runId: subagent.runRef?.runId ?? null,
        sidechainId: subagent.transcript.sidechainId ?? null,
        subagentId: subagent.id,
    };
}
