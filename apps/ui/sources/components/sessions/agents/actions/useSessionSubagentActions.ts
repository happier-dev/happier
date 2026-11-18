import * as React from 'react';

import type { ContextMenuItem } from '@/components/ui/forms/dropdown/ContextMenu';
import { Modal } from '@/modal';
import { resolveActionExecutionErrorMessage } from '@/sync/ops/actions/resolveActionExecutionFailureMessage';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import type { SessionSubagent } from '@/sync/domains/session/subagents/types';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { t } from '@/text';

type SessionSubagentActionId = 'open-full' | 'advanced' | 'stop' | 'delete';

/**
 * The operations a roster row offers on one unit of work, as menu items (right-click on web,
 * long-press on touch). The row itself stays a two-line summary (agents lab AG1): the actions a
 * person reaches for — stopping a run, shutting a teammate down, the full or advanced view — live
 * one gesture away rather than as a strip of icon buttons on every row.
 *
 * Each item is offered only when the unit's canonical capabilities allow it; mutations also
 * require the exact Home the work belongs to.
 */
export function useSessionSubagentActions(params: Readonly<{
    sessionId: string;
    serverId?: string | null;
    subagent: SessionSubagent;
    onOpenFull: (() => void) | null;
    onOpenAdvanced: (() => void) | null;
}>): Readonly<{
    items: readonly ContextMenuItem[];
    select: (itemId: string) => void;
    approval: ReturnType<typeof useMountedActionExecution>['approval'];
}> {
    const { subagent, sessionId } = params;
    const exactServerId = params.serverId?.trim() || null;
    const runId = subagent.runRef?.runId?.trim() || null;
    const teammate = subagent.recipient?.kind === 'agent_team_member' ? subagent.recipient : null;
    const pendingRef = React.useRef(false);
    const actionExecution = useMountedActionExecution(exactServerId);

    const canStop = exactServerId !== null && subagent.capabilities.canStop && runId !== null;
    const canDelete = exactServerId !== null && subagent.capabilities.canDelete && teammate !== null;

    const items = React.useMemo((): readonly ContextMenuItem[] => {
        const result: ContextMenuItem[] = [];
        if (params.onOpenFull) {
            result.push({ id: 'open-full', testID: `session-subagent-open-full:${subagent.id}`, title: t('session.subagents.panel.openFull') });
        }
        if (params.onOpenAdvanced) {
            result.push({ id: 'advanced', testID: `session-subagent-open-advanced:${subagent.id}`, title: t('session.subagents.panel.openAdvancedRun') });
        }
        if (canStop) {
            result.push({ id: 'stop', testID: `session-subagent-stop:${subagent.id}`, title: t('runs.stop.stopRunA11y') });
        }
        if (canDelete) {
            result.push({
                id: 'delete',
                testID: `session-subagent-delete:${subagent.id}`,
                title: t('session.subagents.messages.command.deleteMemberTitle'),
                destructive: true,
            });
        }
        return result;
    }, [canDelete, canStop, params.onOpenAdvanced, params.onOpenFull, subagent.id]);

    const stopRun = React.useCallback(() => {
        if (!runId || !exactServerId || pendingRef.current) return;
        pendingRef.current = true;
        fireAndForget((async () => {
            try {
                const result = await actionExecution.execute('execution.run.stop', { sessionId, runId });
                if (!result.ok && actionExecution.isCurrent()) {
                    Modal.alert(t('common.error'), resolveActionExecutionErrorMessage(result, t('runs.stop.failedToStopRun')));
                }
            } catch (error) {
                if (actionExecution.isCurrent()) {
                    Modal.alert(t('common.error'), resolveActionExecutionErrorMessage(error, t('runs.stop.failedToStopRun')));
                }
            } finally {
                pendingRef.current = false;
            }
        })(), { tag: 'useSessionSubagentActions.stopRun' });
    }, [exactServerId, runId, sessionId, actionExecution.execute, actionExecution.isCurrent]);

    const deleteTeammate = React.useCallback(() => {
        if (!teammate || !exactServerId || pendingRef.current) return;
        pendingRef.current = true;
        fireAndForget((async () => {
            try {
                const result = await actionExecution.execute('session.message.send', {
                    sessionId,
                    kind: 'sessionSubagentCommand',
                    command: {
                        kind: 'agent_team_member_delete',
                        teamId: teammate.teamId,
                        memberId: teammate.memberId,
                        ...(teammate.memberLabel ? { memberLabel: teammate.memberLabel } : {}),
                    },
                });
                if (!result.ok && actionExecution.isCurrent()) {
                    Modal.alert(t('common.error'), resolveActionExecutionErrorMessage(result, t('common.requestFailed')));
                }
            } catch (error) {
                if (actionExecution.isCurrent()) {
                    Modal.alert(t('common.error'), resolveActionExecutionErrorMessage(error, t('common.requestFailed')));
                }
            } finally {
                pendingRef.current = false;
            }
        })(), { tag: 'useSessionSubagentActions.deleteTeammate' });
    }, [exactServerId, sessionId, teammate, actionExecution.execute, actionExecution.isCurrent]);

    const { onOpenFull, onOpenAdvanced } = params;
    const select = React.useCallback((itemId: string) => {
        const id = itemId as SessionSubagentActionId;
        if (id === 'open-full') onOpenFull?.();
        else if (id === 'advanced') onOpenAdvanced?.();
        else if (id === 'stop') stopRun();
        else if (id === 'delete') deleteTeammate();
    }, [deleteTeammate, onOpenAdvanced, onOpenFull, stopRun]);

    return { items, select, approval: actionExecution.approval };
}
