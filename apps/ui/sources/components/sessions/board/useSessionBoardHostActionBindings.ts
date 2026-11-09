import * as React from 'react';

import type { ActionExecuteResult} from '@happier-dev/protocol/actions/actionExecutionResult';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';

import { publishPresentationNotice } from '@/components/sessions/presentation/presentationNotices';
import { t } from '@/text';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { sessionAddressKey } from '@/sync/domains/session/sessionAddress';

import type { SessionBoardHostActionBinding } from './sessionBoardHostActions';

type Execute = (
    actionId: ActionId,
    input: unknown,
    context: Readonly<{ serverId: string; defaultSessionId: string; surface: 'ui' }>,
) => Promise<ActionExecuteResult>;

/**
 * Binds caller-authored declarative Actions to the incumbent Action front door.
 * The Board supplies only exact Session/current-capability facts; validation,
 * settings, approval, dispatch and settlement remain owned by ActionExecutor.
 */
export function useSessionBoardHostActionBindings(input: Readonly<{
    serverId: string | null;
    sessionId: string;
    enabled: boolean;
    execute?: Execute;
}>): (itemId: string) => SessionBoardHostActionBinding {
    const execute = React.useMemo(() => input.execute ?? createFrontDoorActionExecute(), [input.execute]);
    const [pendingItemIds, setPendingItemIds] = React.useState<ReadonlySet<string>>(() => new Set());
    const latest = React.useRef(input);
    latest.current = input;

    return React.useCallback((itemId: string): SessionBoardHostActionBinding => {
        const enabled = Boolean(input.serverId) && input.enabled;
        const pending = pendingItemIds.has(itemId);
        return Object.freeze({
            enabled,
            pending,
            invoke: (invocation) => {
                if (!enabled || pending) return;
                const serverId = latest.current.serverId;
                if (!serverId || !latest.current.enabled) return;
                setPendingItemIds((current) => new Set(current).add(itemId));
                void execute(invocation.actionId as ActionId, invocation.input, {
                    serverId,
                    defaultSessionId: latest.current.sessionId,
                    surface: 'ui',
                }).then((result) => {
                    if (result.ok) return;
                    publishPresentationNotice({
                        key: JSON.stringify([
                            'session-board-action',
                            sessionAddressKey({ serverId, sessionId: latest.current.sessionId }),
                            itemId,
                            invocation.actionId,
                        ]),
                        message: result.error || t('sessionBoard.mutation.failed'),
                        severity: 'error',
                    });
                }).catch(() => {
                    publishPresentationNotice({
                        key: JSON.stringify([
                            'session-board-action',
                            sessionAddressKey({ serverId, sessionId: latest.current.sessionId }),
                            itemId,
                            invocation.actionId,
                        ]),
                        message: t('sessionBoard.mutation.offline'),
                        severity: 'error',
                    });
                }).finally(() => {
                    setPendingItemIds((current) => {
                        const next = new Set(current);
                        next.delete(itemId);
                        return next;
                    });
                });
            },
        });
    }, [execute, input.enabled, input.serverId, pendingItemIds]);
}
