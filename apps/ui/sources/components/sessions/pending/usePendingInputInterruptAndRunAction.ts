import * as React from 'react';
import type { ActionId } from '@happier-dev/protocol';

import { Modal } from '@/modal';
import { t } from '@/text';
import { createDefaultActionExecutor } from '@/sync/ops/actions/defaultActionExecutor';
import { resolveServerIdForSessionIdFromLocalCache } from '@/sync/runtime/orchestration/serverScopedRpc/resolveServerIdForSessionIdFromLocalCache';

const ACTION_ID = 'session.pendingInput.interruptAndRun' as ActionId;

function readRecord(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

export function usePendingInputInterruptAndRunAction(sessionId: string): Readonly<{
    busy: boolean;
    interruptAndRun: (input: Readonly<{ localId: string; expectedStateAtMs?: number }>) => Promise<void>;
}> {
    const [busy, setBusy] = React.useState(false);
    const actionExecutor = React.useMemo(
        () => createDefaultActionExecutor({ resolveServerIdForSessionId: resolveServerIdForSessionIdFromLocalCache }),
        [],
    );

    const interruptAndRun = React.useCallback(async (input: Readonly<{
        localId: string;
        expectedStateAtMs?: number;
    }>) => {
        if (busy) return;
        const confirmed = await Modal.confirm(
            t('session.pendingMessages.actions.interruptAndRunNow'),
            t('session.pendingMessages.sendConfirm.body'),
            { confirmText: t('session.pendingMessages.actions.interruptAndRunNow'), destructive: true },
        );
        if (!confirmed) return;

        setBusy(true);
        try {
            const result = await actionExecutor.execute(ACTION_ID, {
                sessionId,
                localId: input.localId,
                ...(typeof input.expectedStateAtMs === 'number'
                    ? { expectedStateAtMs: input.expectedStateAtMs }
                    : {}),
            }, {
                defaultSessionId: sessionId,
                surface: 'ui',
            });
            if (result.ok !== true) {
                Modal.alert(t('common.error'), result.error ?? t('session.pendingMessages.errors.sendFailed'));
                return;
            }
            const runtimeResult = readRecord(result.result);
            if (runtimeResult?.kind === 'approval_request_created' || runtimeResult?.ok === true) return;
            const error = typeof runtimeResult?.error === 'string' ? runtimeResult.error : null;
            Modal.alert(t('common.error'), error ?? t('session.pendingMessages.errors.sendFailed'));
        } catch (error) {
            Modal.alert(
                t('common.error'),
                error instanceof Error ? error.message : t('session.pendingMessages.errors.sendFailed'),
            );
        } finally {
            setBusy(false);
        }
    }, [actionExecutor, busy, sessionId]);

    return { busy, interruptAndRun };
}
