import * as React from 'react';
import { MachineWorkSummaryGetResultV1Schema } from '@happier-dev/protocol/machines/machineWorkSummaryV1';

import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { subscribeHomeAccountChange, subscribeHomeCredentialChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { serverAccountScopedResourceKey, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { parseToken } from '@/utils/auth/parseToken';
import { storage } from '@/sync/domains/state/storage';
import { resolveServerScopedMachine } from '@/sync/store/domains/machines/resolveServerScopedMachine';

import { MachineWorkSummarySection, type MachineWorkSummaryState } from './MachineWorkSummarySection';

type Props = Readonly<{
    machineId: string;
    machineName: string;
    scope: ServerAccountScope;
    online: boolean;
    /** The incumbent page's explicit refresh; not a timer or a work census. */
    refreshKey?: number;
    execute?: ReturnType<typeof createFrontDoorActionExecute>;
}>;

function unavailable(previous: MachineWorkSummaryState, reason: 'loading' | 'offline' | 'unavailable'): MachineWorkSummaryState {
    if (previous.kind === 'summary' && previous.summary.kind === 'current') return { ...previous, stale: reason };
    return reason === 'loading' ? { kind: 'loading' } : reason === 'offline'
        ? { kind: 'offline' } : { kind: 'summary', summary: { kind: 'unavailable' } };
}

function ScopedMachineWorkSummaryReader(props: Props) {
    const [execute] = React.useState(() => props.execute ?? createFrontDoorActionExecute());
    const [state, setState] = React.useState<MachineWorkSummaryState>({ kind: props.online ? 'loading' : 'offline' });
    const pending = React.useRef<AbortController | null>(null);
    const lifetimeRef = React.useRef<AbortController | null>(null);
    const target = React.useMemo(() => ({ serverId: props.scope.serverId, machineId: props.machineId }), [props.scope.serverId, props.machineId]);
    const context = React.useMemo(() => ({ surface: 'ui' as const, source: 'ui_button' as const, authority: 'present_user' as const,
        serverId: props.scope.serverId, expectedAccountId: props.scope.accountId }), [props.scope.serverId, props.scope.accountId]);
    const load = React.useCallback(async () => {
        pending.current?.abort();
        const lifetime = lifetimeRef.current;
        if (!lifetime || lifetime.signal.aborted) return;
        if (!props.online) { setState(previous => unavailable(previous, 'offline')); return; }
        const request = new AbortController();
        pending.current = request;
        setState(previous => unavailable(previous, 'loading'));
        const result = await execute('machines.work.summary.get', target, { ...context, signal: request.signal }).catch(() => null);
        if (request.signal.aborted || lifetime.signal.aborted) return;
        const parsed = result?.ok ? MachineWorkSummaryGetResultV1Schema.safeParse(result.result) : null;
        const failure = result && !result.ok ? result.errorCode : undefined;
        if (parsed?.success && parsed.data.kind === 'current') {
            setState({ kind: 'summary', summary: parsed.data, asOf: Date.now() });
        } else if (parsed?.success && parsed.data.kind === 'refused'
            || failure === 'access_denied' || failure === 'account_scope_mismatch'
            || failure === 'action_account_scope_changed' || failure === 'not_authenticated') {
            // Permission loss retires identities, not merely their freshness.
            setState({ kind: 'denied' });
        } else setState(previous => unavailable(previous, 'unavailable'));
    }, [execute, target, context, props.online]);

    React.useEffect(() => {
        // Effect setup owns this resource: StrictMode may replay cleanup/setup
        // without replacing memoized values or refs.
        let lifetime = new AbortController();
        lifetimeRef.current = lifetime;
        let observedMachine = resolveServerScopedMachine(storage.getState(), props.scope.serverId, props.machineId);
        const stopMachine = storage.subscribe(nextState => {
            const next = resolveServerScopedMachine(nextState, props.scope.serverId, props.machineId);
            if (next === observedMachine) return;
            observedMachine = next;
            // The incumbent Machine writer receives readiness and liveness;
            // neither its update nor this observer carries requester counts.
            void load();
        });
        const stopWake = subscribeHomeAccountChange(event => {
            if (areServerProfileIdentifiersEquivalent(event.serverId, props.scope.serverId)
                && (event.entityIds === undefined || event.entityIds.includes(props.machineId))) void load();
        });
        const stopCredentials = subscribeHomeCredentialChange(event => {
            if (!areServerProfileIdentifiersEquivalent(event.serverId, props.scope.serverId)) return;
            let actor: string | null = null;
            try { actor = event.credentials ? parseToken(event.credentials.token) : null; } catch { /* Invalid identity retires this projection. */ }
            if (event.kind === 'credentials_removed' || actor !== props.scope.accountId) {
                lifetime.abort(); pending.current?.abort(); setState({ kind: 'denied' });
            } else {
                // Restoration is a fresh read, while old loads retain their aborted lifetime.
                if (lifetime.signal.aborted) {
                    lifetime = new AbortController();
                    lifetimeRef.current = lifetime;
                }
                void load();
            }
        });
        return () => { lifetime.abort(); stopMachine(); stopWake(); stopCredentials(); pending.current?.abort(); };
    }, [load, props.scope.serverId, props.scope.accountId, props.machineId]);
    React.useEffect(() => { void load(); }, [load, props.refreshKey]);
    return <MachineWorkSummarySection machineName={props.machineName} state={state}
        onRetry={() => { void load(); }} testID="machine-work-summary" />;
}

/** The existing Machine page reads only the safe Action, with the same focused Home wake as Sharing. */
export function MachineWorkSummaryReader(props: Props) {
    return <ScopedMachineWorkSummaryReader key={serverAccountScopedResourceKey(props.scope, props.machineId)} {...props} />;
}
