import * as React from 'react';
import { normalizeSessionAddress } from '@/sync/domains/session/sessionAddress';
import { useServerCredentialAccountScopeResolution } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { getSyncSingleton } from '@/sync/runtime/getSyncSingleton';
import type { SessionSystemRecordObservationBase, SessionSystemRecordUnavailableReason } from './observation';

export type SessionSystemRecordUnavailable = Readonly<{ status: 'unavailable'; reason: SessionSystemRecordUnavailableReason }>;
type Unavailable<Reason extends string> = Readonly<{ status: 'unavailable'; reason: SessionSystemRecordUnavailableReason | Reason }>;
export type SessionSystemRecordObservationOptions<Binding, Reason extends string = never> = SessionSystemRecordObservationBase & Readonly<{ onChange: (binding: Binding | Unavailable<Reason>) => void }>;

/** Exact-Home authority and observation lifetime shared by Board and individual Session content. */
export function useSessionSystemRecordBinding<Binding extends { status: 'ready' }, Reason extends string = never>(input: Readonly<{
    serverId: string | null;
    sessionId: string;
    enabled: boolean;
    loading: Binding;
    observe: (options: SessionSystemRecordObservationOptions<Binding, Reason>) => () => void;
}>): (Binding | Unavailable<Reason>) & Readonly<{ refresh: () => void }> {
    const address = React.useMemo(() => normalizeSessionAddress(input.serverId, input.sessionId), [input.serverId, input.sessionId]);
    const resolution = useServerCredentialAccountScopeResolution(address?.serverId);
    const lifetime = React.useMemo(() => ({ address, resolution, observe: input.observe }), [address, resolution, input.observe]);
    const [retry, setRetry] = React.useState(0);
    const [observed, setObserved] = React.useState<Readonly<{
        lifetime: typeof lifetime;
        binding: Binding | Unavailable<Reason>;
        isCurrent: () => boolean;
        refreshRecords?: () => void;
    }> | null>(null);
    React.useEffect(() => {
        if (!input.enabled || !address || resolution.kind !== 'bound') return;
        let stopped = false;
        let unsubscribe: (() => void) | undefined;
        const sync = getSyncSingleton();
        const publish = (binding: Binding | Unavailable<Reason>, isCurrent = () => !stopped, refreshRecords?: () => void) => {
            if (!stopped) setObserved({ lifetime, binding, isCurrent, refreshRecords });
        };
        void sync.withSessionSystemRecordRuntime(address, async runtime => {
            if (stopped) return;
            if (runtime.scope.accountId !== resolution.scope.accountId || !runtime.isCurrent()) {
                publish({ status: 'unavailable', reason: 'forbidden' });
                return;
            }
            const readCapabilities = () => runtime.readSession()?.access?.capabilities ?? null;
            const capabilities = readCapabilities();
            if (!capabilities?.readTranscript) { publish({ status: 'unavailable', reason: 'forbidden' }); return; }
            unsubscribe = input.observe({
                session: address, repository: runtime.repository,
                authority: { contentContext: runtime.readContentContext(), capabilities },
                readCapabilities, readContentContext: runtime.readContentContext,
                isCurrent: () => !stopped && runtime.isCurrent(),
                renewAuthority: async () => {
                    const renewed = await sync.withSessionSystemRecordRuntime(address, async current => {
                        if (current.repository !== runtime.repository || current.scope.accountId !== runtime.scope.accountId) return null;
                        const currentCapabilities = current.readSession()?.access?.capabilities ?? null;
                        return currentCapabilities ? { contentContext: current.readContentContext(), capabilities: currentCapabilities } : null;
                    }, { forceSessionRefresh: true });
                    if (renewed.status !== 'ok') return renewed;
                    return renewed.value ? { status: 'ok', value: renewed.value } : { status: 'forbidden' };
                },
                onChange: binding => publish(binding, runtime.isCurrent, () => runtime.repository.invalidate(address)),
            });
        }).then(result => {
            if (result.status !== 'ok') publish({ status: 'unavailable', reason: result.status });
        }).catch(() => publish({ status: 'unavailable', reason: 'offline' }));
        return () => { stopped = true; unsubscribe?.(); };
    }, [address, input.enabled, input.observe, lifetime, resolution, retry]);
    const observedRef = React.useRef(observed);
    observedRef.current = observed;
    const refresh = React.useCallback(() => {
        const current = observedRef.current;
        if (current?.lifetime === lifetime && current.isCurrent() && current.binding.status === 'ready' && current.refreshRecords) current.refreshRecords();
        else { setObserved(null); setRetry(value => value + 1); }
    }, [lifetime]);
    const binding: Binding | Unavailable<Reason> = !address
        ? { status: 'unavailable', reason: 'invalid_address' }
        : resolution.kind !== 'bound'
            ? resolution.kind === 'resolving' ? input.loading : { status: 'unavailable', reason: resolution.kind }
            : observed?.lifetime !== lifetime
                ? input.loading
                : !observed.isCurrent() ? { status: 'unavailable', reason: 'forbidden' } : observed.binding;
    const ready = binding.status === 'ready' ? binding : null;
    const reason = binding.status === 'unavailable' ? binding.reason : 'forbidden';
    return React.useMemo(() => ready ? { ...ready, refresh } : { status: 'unavailable' as const, reason, refresh }, [ready, reason, refresh]);
}
