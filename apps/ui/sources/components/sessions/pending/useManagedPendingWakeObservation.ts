import * as React from 'react';
import { ManagedMachineV1Schema, type ManagedMachineV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import type { PendingActivationAuthorizationV1 } from '@happier-dev/protocol/sessions/pending/pendingActivationAuthorizationV1';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { subscribeHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { createDefaultActionExecutor } from '@/sync/ops/actions/defaultActionExecutor';

/** Rereads the canonical protected row on its incumbent Home invalidation edge. */
export function useManagedPendingWakeObservation(input: Readonly<{
    sessionId: string;
    authorization: PendingActivationAuthorizationV1 | null | undefined;
    accountLifetime: ServerAccountScopeLifetime | null;
    reconnectSignal: string | number | null;
}>): ManagedMachineV1 | null {
    const target = input.authorization?.managedWakeTargetV1;
    const qualified = target?.origin.kind === 'session-input'
        && target.origin.session.sessionId === input.sessionId
        && target.origin.session.homeId === target.homeId
        && target.origin.pendingRequestId === input.authorization?.requestId
        && target.origin.requestedAt === input.authorization?.requestedAt;
    const [machine, setMachine] = React.useState<ManagedMachineV1 | null>(null);
    const actionExecutor = React.useMemo(() => createDefaultActionExecutor(), []);
    const [invalidated, invalidate] = React.useReducer((value: number) => value + 1, 0);
    React.useEffect(() => {
        const lifetime = input.accountLifetime;
        if (!qualified || !target || !lifetime?.isCurrent()) return;
        return subscribeHomeAccountChange((event) => {
            if (!lifetime.isCurrent() || !areServerProfileIdentifiersEquivalent(event.serverId, lifetime.scope.serverId)) return;
            if (event.entityIds === undefined || event.entityIds.includes(target.managedId)) invalidate();
        });
    }, [input.accountLifetime, qualified, target]);
    React.useEffect(() => {
        const lifetime = input.accountLifetime;
        setMachine(null);
        if (!qualified || !target || !lifetime?.isCurrent()) return;
        const controller = new AbortController();
        const retirement = lifetime.onRetire(() => { controller.abort(); setMachine(null); });
        void (async () => {
            try {
                const result = await actionExecutor.execute('machines.managed.get', {
                    homeId: target.homeId, managedId: target.managedId,
                }, {
                    serverId: lifetime.scope.serverId, expectedAccountId: lifetime.scope.accountId,
                    surface: 'ui', signal: controller.signal,
                });
                if (controller.signal.aborted || !lifetime.isCurrent() || !result.ok) return;
                const parsed = ManagedMachineV1Schema.safeParse(result.result);
                if (!parsed.success) return;
                const row = parsed.data;
                if (row.homeId !== target.homeId || row.id !== target.managedId
                    || row.enrolledMachineId !== target.enrolledMachineId || row.creationState !== 'active') return;
                setMachine(row);
            } catch {
                // A failed protected read is unknown, never native absence or a power request.
            }
        })();
        return () => { controller.abort(); retirement.dispose(); };
    }, [actionExecutor, input.accountLifetime, input.reconnectSignal, invalidated, qualified, target]);
    return machine;
}
