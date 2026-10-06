import { createActionExecutor, type ActionExecutorDeps } from '@happier-dev/protocol/actions';
import { ActionsSettingsV1Schema, isApprovalRequiredByActionsSettings } from '@happier-dev/protocol';
import { createActionExecutorBoundaryFixture } from '@/dev/testkit';

import { createSessionBoardActionAdapter } from '@/sync/api/session/sessionBoardActions';
import { createSessionBoardActionsPort } from '@/sync/domains/session/board/sessionBoardActionsPort';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';
import { createSessionSystemRecordRepository } from '@/sync/domains/sessionSystemRecords/repository';

/** Real Board owners above the Home HTTP and approval Artifact boundaries. */
export function realBoardActions(
    request: Parameters<typeof createSessionBoardActionAdapter>[0]['request'],
    approvalsCreate?: ActionExecutorDeps['approvalsCreate'],
    session: SessionAddress = { serverId: 'home-a', sessionId: 'session-one' },
) {
    const scope = { serverId: session.serverId, accountId: 'alice' };
    const adapter = createSessionBoardActionAdapter({
        scope,
        session,
        request,
        repository: createSessionSystemRecordRepository({ scope, request }),
        contentContext: { mode: 'plain' },
        capabilities: { readTranscript: true, editSessionRecords: true },
    });
    const settings = ActionsSettingsV1Schema.parse({
        v: 1,
        actions: approvalsCreate ? { 'session.board.item.upsert': { approvalRequiredSurfaces: ['ui'] } } : {},
        // Direct-save fixtures explicitly waive approval; approval fixtures retain it.
        ...(approvalsCreate ? {} : { approvalWaivedSurfaces: {
            'session.board.item.upsert': ['ui'],
            'session.board.layout.update': ['ui'],
            'session.board.item.remove': ['ui'],
        } }),
    });
    const deps: Pick<ActionExecutorDeps, 'sessionBoardAction' | 'isActionApprovalRequired' | 'approvalsCreate'> = {
        sessionBoardAction: adapter,
        isActionApprovalRequired: (actionId, context, input) => isApprovalRequiredByActionsSettings(actionId, settings, context, undefined, undefined, input),
        ...(approvalsCreate ? { approvalsCreate } : {}),
    };
    const executor = createActionExecutor(createActionExecutorBoundaryFixture(deps));
    return createSessionBoardActionsPort({
        ...session,
        execute: (actionId, input, context) => executor.execute(actionId, input, {
            ...context, authority: 'present_user', runtimeAccountId: 'alice', actionRequestId: 'request-one',
        }),
    });
}
