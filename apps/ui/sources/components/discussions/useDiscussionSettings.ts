import * as React from 'react';
import type { DiscussionSettingsResponseV1, DiscussionSettingsV1 } from '@happier-dev/protocol/discussions/settings';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { areServerAccountScopesEqual } from '@/sync/domains/scope/serverAccountScope';
import type { DiscussionClientOutcome } from '@/sync/api/discussions/discussionActions';
import type { DiscussionRepository } from '@/sync/ops/discussions/discussionRepository';

type Outcome = DiscussionClientOutcome<DiscussionSettingsResponseV1>;
type Status = 'idle' | 'loading' | 'ready' | 'unavailable';
type Key = Readonly<{ repository: DiscussionRepository; discussionId: string | null; accountLifetime: ServerAccountScopeLifetime | null }>;
type Projection = Readonly<{ key: Key; status: Status; settings: DiscussionSettingsV1 | null; operation: Outcome | null; saving: boolean }>;
type Pending = Readonly<{ key: Key; abort: AbortController; promise: Promise<Outcome | undefined> }>;

/** Demanded settings data for the existing Discussion menu; no check-in decision or rendering lives here. */
export function useDiscussionSettings(input: Key & Readonly<{ enabled: boolean }>) {
    const { repository, discussionId, accountLifetime, enabled } = input;
    const key = React.useMemo(() => ({ repository, discussionId, accountLifetime }), [repository, discussionId, accountLifetime]);
    const current = React.useRef(input);
    current.current = input;
    const mounted = React.useRef(true);
    const read = React.useRef<Pending | null>(null);
    const write = React.useRef<Pending | null>(null);
    const [projection, setProjection] = React.useState<Projection | null>(null);
    const isCurrent = React.useCallback(() => discussionId !== null && mounted.current && current.current.repository === repository
        && current.current.discussionId === discussionId && current.current.accountLifetime === accountLifetime
        && current.current.enabled && accountLifetime?.isCurrent() === true
        && areServerAccountScopesEqual(accountLifetime.scope, repository.scope)
        && repository.getSnapshot().threads[discussionId]?.status !== 'revoked', [accountLifetime, discussionId, repository]);
    const subscribe = React.useCallback((notify: () => void) => {
        if (!enabled) return () => {};
        const retirement = accountLifetime?.onRetire(notify);
        const unsubscribe = repository.subscribe(notify);
        return () => { retirement?.dispose(); unsubscribe(); };
    }, [accountLifetime, repository, enabled]);
    const readAccess = React.useCallback(() => {
        if (discussionId === null || !enabled || !accountLifetime?.isCurrent() || !areServerAccountScopesEqual(accountLifetime.scope, repository.scope)) return 'unavailable';
        const thread = repository.getSnapshot().threads[discussionId];
        return thread?.status === 'revoked' ? 'unavailable' : thread?.summary?.capabilities.manageAccess ? 'manage' : 'read';
    }, [accountLifetime, discussionId, enabled, repository]);
    const access = React.useSyncExternalStore(subscribe, readAccess, readAccess);
    const refresh = React.useCallback((signal?: AbortSignal): Promise<Outcome | undefined> => {
        if (discussionId === null || !isCurrent() || signal?.aborted) return Promise.resolve(undefined);
        if (write.current?.key === key) return write.current.promise;
        if (read.current?.key === key && !read.current.abort.signal.aborted) return read.current.promise;
        const abort = new AbortController();
        const cancel = () => abort.abort();
        signal?.addEventListener('abort', cancel, { once: true });
        const retirement = accountLifetime?.onRetire(cancel);
        setProjection(previous => ({ key, status: 'loading', settings: previous?.key === key ? previous.settings : null,
            operation: null, saving: false }));
        const promise = (async () => {
            try {
                const outcome = await repository.getSettings(discussionId, abort.signal);
                if (isCurrent() && !abort.signal.aborted) setProjection({ key,
                    status: outcome.kind === 'succeeded' ? 'ready' : 'unavailable',
                    settings: outcome.kind === 'succeeded' ? outcome.value.settings : null, operation: outcome, saving: false });
                return outcome;
            } catch {
                const outcome: Outcome = { kind: 'failed', errorCode: abort.signal.aborted ? 'canceled' : 'outcome_unknown' };
                if (isCurrent() && !abort.signal.aborted) setProjection({ key, status: 'unavailable', settings: null, operation: outcome, saving: false });
                return outcome;
            } finally {
                signal?.removeEventListener('abort', cancel);
                retirement?.dispose();
                if (read.current?.abort === abort) read.current = null;
            }
        })();
        read.current = { key, abort, promise };
        return promise;
    }, [accountLifetime, discussionId, isCurrent, key, repository]);
    const setOverride = React.useCallback((afterTurns: number | null | undefined): Promise<Outcome | undefined> => {
        if (discussionId === null || !isCurrent() || access !== 'manage' || write.current?.key === key) return Promise.resolve(undefined);
        read.current?.abort.abort();
        const abort = new AbortController();
        const retirement = accountLifetime?.onRetire(() => abort.abort());
        setProjection(previous => ({ key, status: previous?.key === key ? previous.status : 'loading',
            settings: previous?.key === key ? previous.settings : null, operation: null, saving: true }));
        const settings: DiscussionSettingsV1 = afterTurns === undefined ? {} : { coordination: { autonomousCheckIn: { afterTurns } } };
        const promise = (async () => {
            try {
                const outcome = await repository.setSettings(discussionId, settings, abort.signal);
                if (isCurrent() && !abort.signal.aborted) setProjection(previous => ({ key,
                    status: outcome.kind === 'succeeded' ? 'ready' : previous?.key === key ? previous.status : 'unavailable',
                    settings: outcome.kind === 'succeeded' ? outcome.value.settings : previous?.key === key ? previous.settings : null,
                    operation: outcome, saving: false }));
                return outcome;
            } catch {
                const outcome: Outcome = { kind: 'failed', errorCode: abort.signal.aborted ? 'canceled' : 'outcome_unknown' };
                if (isCurrent() && !abort.signal.aborted) setProjection(previous => ({ key,
                    status: previous?.key === key ? previous.status : 'unavailable',
                    settings: previous?.key === key ? previous.settings : null, operation: outcome, saving: false }));
                return outcome;
            } finally {
                retirement?.dispose();
                if (write.current?.abort === abort) write.current = null;
            }
        })();
        write.current = { key, abort, promise };
        return promise;
    }, [access, accountLifetime, discussionId, isCurrent, key, repository]);
    React.useEffect(() => {
        mounted.current = true;
        const abort = new AbortController();
        if (enabled) void refresh(abort.signal);
        return () => {
            mounted.current = false;
            abort.abort();
            if (write.current?.key === key) write.current.abort.abort();
        };
    }, [enabled, key, refresh]);
    const visible = enabled && access !== 'unavailable' && projection?.key === key ? projection : null;
    return {
        status: !enabled ? 'idle' as const : visible?.status ?? (access === 'unavailable' ? 'unavailable' as const : 'loading' as const),
        settings: visible?.settings ?? null,
        override: visible?.status === 'ready' ? visible.settings?.coordination?.autonomousCheckIn : null,
        operation: visible?.operation ?? null,
        saving: visible?.saving ?? false,
        canManage: enabled && access === 'manage',
        refresh, setOverride,
        dontPause: React.useCallback(() => setOverride(null), [setOverride]),
        inherit: React.useCallback(() => setOverride(undefined), [setOverride]),
    };
}
