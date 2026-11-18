import * as React from 'react';
import type { MachineGuardActivityRowV1, MachineGuardActivityWayBackV1 } from '@happier-dev/protocol/machines/guard/activityV1';

import { Modal } from '@/modal';
import { resolveActionExecutionErrorMessage } from '@/sync/ops/actions/resolveActionExecutionFailureMessage';
import { machineGuardStore } from '@/sync/domains/machines/guard/machineGuardStore';
import { undoMachineGuardActivityViaAction } from '@/sync/domains/machines/guard/machineGuardRpc';
import { useMachineDaemonReadTarget } from '@/sync/domains/machines/useMachineDaemonReadTarget';
import { t } from '@/text';

import { isGuardRestoration } from './guardActivityPresentation';

/**
 * A receipt's way back. Resume, Start again, Reopen and Undo go through the receipt's own Undo on the
 * machine (it re-runs the captured original Action under that Action's approval); Empty now, Raise
 * ceiling and Review processes run their own Action. Either way the next Guard answer says what changed.
 */
export function useGuardWayBack(input: Readonly<{ serverId: string; machineId: string }>): Readonly<{
    pendingId: string | null;
    run: (entry: MachineGuardActivityRowV1, item: MachineGuardActivityWayBackV1) => void;
}> {
    const { key, accountBinding } = useMachineDaemonReadTarget(input);
    const [pendingId, setPendingId] = React.useState<string | null>(null);
    const run = React.useCallback((entry: MachineGuardActivityRowV1, item: MachineGuardActivityWayBackV1) => {
        setPendingId(`${entry.id}:${item.label}`);
        void (async () => {
            const execution = isGuardRestoration(item)
                ? undoMachineGuardActivityViaAction({ ...key, entryId: entry.id })
                : import('@/sync/ops/actions/frontDoorRuntimeActionExecutor').then(({ createFrontDoorActionExecute }) =>
                    createFrontDoorActionExecute()(item.actionId, item.input, {
                        surface: 'ui', ...(key.serverId ? { serverId: key.serverId } : {}),
                        ...(key.expectedAccountId ? { expectedAccountId: key.expectedAccountId } : {}),
                    }));
            const outcome = await execution.finally(() => {
                setPendingId(null);
                machineGuardStore.refreshMachine(key);
            });
            if (!outcome.ok && accountBinding?.isCurrent()) {
                Modal.alert(t('machineGuard.activity.title'),
                    resolveActionExecutionErrorMessage(outcome, t('machineGuard.activity.wayBackFailed')));
            }
        })();
    }, [accountBinding, key]);
    return { pendingId, run };
}
