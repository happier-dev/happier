import { fromSubagentStatus } from '@happier-dev/protocol';

import type { SessionSubagent, SessionSubagentKind } from '../../subagents/types';
import type { AgentActivityEntryKind, AgentActivityLocalEntry } from '../types';

/**
 * Locally derived subagents, adapted into the merge's vocabulary.
 *
 * The roster itself keeps its owner (`deriveSessionSubagents`, including its runtime-loss
 * retirement and its ordering); this module only restates one of its rows in the merged vocabulary
 * and adds the two things the MERGE needs and a subagent row does not: the kind, and the handle the
 * two sources are joined on.
 *
 * The status goes through the protocol adapter `fromSubagentStatus` rather than a local mapping, so
 * a member added to `SessionSubagentStatus` fails to compile at the adapter instead of silently
 * becoming something else here.
 */

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
 * One rule for all three local kinds, because all three record the same thing: a sidechain is keyed
 * by the tool-use id that opened it, and every derivation stores that id under
 * `transcript.sidechainId`, falling back to the tool call's own id when no sidechain was observed.
 *
 * This is the same string the producer names an agent by, which is what makes the cross-source join
 * possible at all: the two sides cannot agree on an entry id (only the producer knows which run it
 * attached an agent to) but they can agree on this.
 */
export function resolveSessionSubagentActivityHandle(subagent: SessionSubagent): string | null {
    const sidechainId = subagent.transcript.sidechainId?.trim();
    if (sidechainId) return sidechainId;
    const toolId = subagent.transcript.toolId?.trim();
    return toolId ? toolId : null;
}

function readInstant(value: number | null | undefined): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function toLocalAgentActivityEntry(params: Readonly<{
    subagent: SessionSubagent;
    /**
     * Whether a permission prompt for this subagent is on screen right now.
     *
     * Only the enriched roster can answer it — the prompt lives in the full transcript — so it is
     * an input rather than something derived here, and a count-only host passes `false` rather than
     * subscribing to a transcript to learn a number.
     */
    hasPendingPermission?: boolean;
}>): AgentActivityLocalEntry {
    const { subagent } = params;
    return {
        id: subagent.id,
        kind: resolveSessionSubagentActivityKind(subagent),
        handle: resolveSessionSubagentActivityHandle(subagent),
        // A prompt on screen means a PERSON is the blocker, which is the one thing the publisher
        // structurally cannot see. It is applied here, at the source, so the merge's own rule about
        // who owns status stays about sources rather than about statuses.
        status: params.hasPendingPermission === true ? 'waiting' : fromSubagentStatus(subagent.status),
        title: subagent.display.title,
        metaDetail: subagent.display.subtitle ?? null,
        startedAtMs: readInstant(subagent.timestamps.startedAtMs),
        updatedAtMs: readInstant(subagent.timestamps.updatedAtMs),
        endedAtMs: readInstant(subagent.timestamps.finishedAtMs),
        runId: subagent.runRef?.runId ?? null,
        sidechainId: subagent.transcript.sidechainId ?? null,
        subagentId: subagent.id,
    };
}
