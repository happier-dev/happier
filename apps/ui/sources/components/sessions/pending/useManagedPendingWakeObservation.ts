import * as React from 'react';
import { ManagedMachineActionOutputSchemasV1, unwrapManagedMachineReadV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import type { ManagedMachineV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import type { PendingActivationAuthorizationV1 } from '@happier-dev/protocol/sessions/pending/pendingActivationAuthorizationV1';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { subscribeHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { createDefaultActionExecutor } from '@/sync/ops/actions/defaultActionExecutor';

type ManagedPendingWakeObservation = Readonly<
    | { kind: 'loading'; machine: null }
    | { kind: 'read'; machine: ManagedMachineV1 | null }
>;

/** Rereads the canonical protected row on its incumbent Home invalidation edge. */
export function useManagedPendingWakeObservation(input: Readonly<{
    sessionId: string;
    authorization: PendingActivationAuthorizationV1 | null | undefined;
    accountLifetime: ServerAccountScopeLifetime | null;
    reconnectSignal: string | number | null;
}>): ManagedPendingWakeObservation {
    const target = input.authorization?.managedWakeTargetV1;
    const qualified = target?.origin.kind === 'session-input'
        && target.origin.session.sessionId === input.sessionId
        && target.origin.session.homeId === target.homeId
        && target.origin.pendingRequestId === input.authorization?.requestId
        && target.origin.requestedAt === input.authorization?.requestedAt;
    const identityKey = qualified && target ? `${target.homeId}:${target.managedId}:${target.enrolledMachineId}` : null;
    const [read, setRead] = React.useState<Readonly<{
        identityKey: string | null;
        lifetime: ServerAccountScopeLifetime;
        machine: ManagedMachineV1 | null;
    }> | null>(null);
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
    // A reread (change edge, reconnect) keeps the incumbent observation until its answer arrives; only
    // another target or lifetime starts from nothing, and a failed read leaves the fact unknown.
    React.useEffect(() => {
        const lifetime = input.accountLifetime;
        if (!qualified || !target || !lifetime?.isCurrent()) return;
        const controller = new AbortController();
        const retirement = lifetime.onRetire(() => { controller.abort(); setRead(null); });
        const settle = (machine: ManagedMachineV1 | null) => setRead({ identityKey, lifetime, machine });
        void (async () => {
            try {
                const result = await actionExecutor.execute('machines.managed.get', {
                    homeId: target.homeId, managedId: target.managedId,
                }, {
                    serverId: lifetime.scope.serverId, expectedAccountId: lifetime.scope.accountId,
                    surface: 'ui', signal: controller.signal,
                });
                if (controller.signal.aborted || !lifetime.isCurrent()) return;
                const parsed = result.ok ? ManagedMachineActionOutputSchemasV1['machines.managed.get'].safeParse(result.result) : null;
                const row = parsed?.success ? unwrapManagedMachineReadV1(parsed.data) : null;
                settle(row && row.homeId === target.homeId && row.id === target.managedId
                    && row.enrolledMachineId === target.enrolledMachineId && row.creationState === 'active' ? row : null);
            } catch {
                // A failed protected read is unknown, never native absence or a power request.
                if (!controller.signal.aborted && lifetime.isCurrent()) settle(null);
            }
        })();
        return () => { controller.abort(); retirement.dispose(); };
    }, [actionExecutor, identityKey, input.accountLifetime, input.reconnectSignal, invalidated, qualified, target]);
    if (!qualified || input.accountLifetime && !input.accountLifetime.isCurrent()) return { kind: 'read', machine: null };
    if (!read || read.identityKey !== identityKey || read.lifetime !== input.accountLifetime) return { kind: 'loading', machine: null };
    return { kind: 'read', machine: read.machine };
}
