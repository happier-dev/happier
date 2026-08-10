import type { SubagentCommandV1 } from '@happier-dev/protocol';

import { Modal } from '@/modal';
import { resolveSubagentStructuredSend } from '@/sync/domains/input/subagents/resolveSubagentStructuredSend';
import type { SessionSubagent } from '@/sync/domains/session/subagents/types';
import { sessionExecutionRunStop } from '@/sync/ops/sessionExecutionRuns';
import { sync } from '@/sync/sync';
import { t } from '@/text';
import { fireAndForget } from '@/utils/system/fireAndForget';

/**
 * The three side effects a roster row can trigger, with no UI of their own.
 *
 * They used to live inside a component that also drew four icon buttons, which is why the same
 * commands were unreachable from anywhere else. Separating them from their old chrome is what lets
 * one overflow menu, one detail view and any future host issue the same command without any of them
 * re-deriving the payload — the structured envelopes below are protocol contracts
 * (`agent_team_member_delete`, `agent_team_delete`), not local strings.
 *
 * Confirmation is deliberately NOT here: `AgentActivityRowOverflow` owns it, so a caller cannot ship
 * a destructive action without one. These functions assume the decision has already been made.
 */

export function stopSessionSubagentRun(params: Readonly<{
    sessionId: string;
    subagent: SessionSubagent;
}>): void {
    const runId = params.subagent.runRef?.runId?.trim();
    if (!runId) return;

    fireAndForget((async () => {
        try {
            const result = await sessionExecutionRunStop(params.sessionId, { runId });
            if ((result as { ok?: boolean } | null)?.ok === false) {
                Modal.alert(
                    t('common.error'),
                    String((result as { error?: unknown } | null)?.error ?? t('runs.stop.failedToStopRun')),
                );
            }
        } catch (error) {
            Modal.alert(
                t('common.error'),
                error instanceof Error ? error.message : t('runs.stop.failedToStopRun'),
            );
        }
    })(), { tag: 'sessionSubagentCommands.stopRun' });
}

export function deleteSessionSubagentTeammate(params: Readonly<{
    sessionId: string;
    subagent: SessionSubagent;
}>): void {
    const recipient = params.subagent.recipient;
    if (recipient?.kind !== 'agent_team_member') return;

    submitSubagentCommand({
        sessionId: params.sessionId,
        tag: 'sessionSubagentCommands.deleteTeammate',
        payload: {
            kind: 'agent_team_member_delete',
            teamId: recipient.teamId,
            memberId: recipient.memberId,
            ...(recipient.memberLabel ? { memberLabel: recipient.memberLabel } : {}),
        },
    });
}

export function deleteSessionSubagentTeam(params: Readonly<{
    sessionId: string;
    teamId: string;
}>): void {
    const teamId = params.teamId.trim();
    if (!teamId) return;

    submitSubagentCommand({
        sessionId: params.sessionId,
        tag: 'sessionSubagentCommands.deleteTeam',
        payload: { kind: 'agent_team_delete', teamId },
    });
}

function submitSubagentCommand(params: Readonly<{
    sessionId: string;
    tag: string;
    payload: SubagentCommandV1;
}>): void {
    const structured = resolveSubagentStructuredSend({
        envelopeKind: 'subagent_command.v1',
        payload: params.payload,
    });

    fireAndForget((async () => {
        try {
            await sync.submitMessage(
                params.sessionId,
                structured.text,
                structured.displayText,
                structured.metaOverrides,
                { callerSurface: 'subagent_control', forceImmediate: true },
            );
        } catch (error) {
            Modal.alert(
                t('common.error'),
                error instanceof Error ? error.message : t('common.requestFailed'),
            );
        }
    })(), { tag: params.tag });
}
