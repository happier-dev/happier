import * as React from 'react';
import { usePendingNavigationProjection } from '@/activity/source/usePendingNavigationOverview';
import { nextPendingRequest } from '@/activity/source/nextPendingRequest';
import { navigateToPendingRequest } from '@/activity/source/navigateToPendingRequest';
import {
    clearPendingNavigationState,
    invokeNextPendingRequest,
    registerPendingNavigationRuntime,
    type PendingNavigationInvocation,
    type PendingNavigationResult,
    type PendingNavigationUnavailableReason,
} from '@/activity/source/pendingNavigationRuntime';
import { useActivityActiveServer, useActivityAttentionStoreSelector } from '@/activity/source/useActivityAttentionSource';
import { storage } from '@/sync/domains/state/storageStore';
import { useRouter, type Href } from '@/components/appShell/workspace/destinationRoute';
import { publishPresentationNotice } from '@/components/sessions/presentation/presentationNotices';
import { useKeyboardShortcutHandlers } from '@/keyboard/KeyboardShortcutProvider';
import { captureActiveServerAccountScopeCurrentness, getActiveServerAccountScope } from '@/sync/domains/scope/activeServerAccountScope';
import { useServerCredentialAccountScopeBindings } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { getFocusedSessionAddress } from '@/sync/domains/session/sessionSurfaceVisibility';
import { subscribeHomeCredentialChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { t } from '@/text';

const NOTICE_KEY = 'session.pending.next';

/** Mounted navigation port shared by Actions, global keys and the Session pill. */
export function NextPendingNavigationHost() {
    const router = useRouter();
    // Rendering needs only which Homes hold pending requests (to bind their scopes), from the one
    // shared pending projection; the whole Activity source is read at invoke time, so a Session
    // update elsewhere does not redraw the host.
    const selectSource = useActivityAttentionStoreSelector(false);
    const activeServerId = useActivityActiveServer().serverId;
    const pending = usePendingNavigationProjection();
    const homeIdsRef = React.useRef<readonly (string | null | undefined)[]>([]);
    const homeIds = React.useMemo(() => {
        const next = [activeServerId, ...pending.candidates.map(candidate => candidate.address.serverId)];
        const previous = homeIdsRef.current;
        if (next.length === previous.length && next.every((id, index) => id === previous[index])) return previous;
        homeIdsRef.current = next;
        return next;
    }, [activeServerId, pending.candidates]);
    const bindings = useServerCredentialAccountScopeBindings(homeIds);
    const readSource = React.useCallback(() => ({
        ...selectSource(storage.getState()),
        audienceScopes: new Map([...bindings].map(([serverId, binding]) => [serverId, binding.scope])),
    }), [bindings, selectSource]);
    const frameRef = React.useRef({ readSource, bindings, router });
    frameRef.current = { readSource, bindings, router };
    const mountedRef = React.useRef(false);
    const inFlightRef = React.useRef(new Set<Readonly<{ controller: AbortController; homeId: string | null }>>());

    const invoke = React.useCallback(async (options: PendingNavigationInvocation): Promise<PendingNavigationResult> => {
        const ownerScope = getActiveServerAccountScope();
        if (options.signal?.aborted || (options.expectedServerId && (!ownerScope
            || !areServerProfileIdentifiersEquivalent(options.expectedServerId, ownerScope.serverId)))) {
            return { status: 'unavailable', reason: options.signal?.aborted ? 'cancelled' : 'scope_changed' };
        }
        const frame = frameRef.current;
        const source = frame.readSource();
        const lifetime = captureActiveServerAccountScopeCurrentness();
        const controller = new AbortController();
        const abort = () => { controller.abort(); };
        const attempt = { controller, homeId: ownerScope?.serverId ?? source.activeServerId ?? null };
        inFlightRef.current.add(attempt);
        const retirement = lifetime.onRetire(abort);
        options.signal?.addEventListener('abort', abort, { once: true });
        let targetRetirement: Readonly<{ dispose(): void }> | undefined;
        const isCurrent = () => mountedRef.current && !controller.signal.aborted && lifetime.isCurrent();
        const unavailable = (reason: PendingNavigationUnavailableReason): PendingNavigationResult => {
            if (isCurrent()) publishPresentationNotice({ key: NOTICE_KEY, severity: 'warning', message: t('pendingNavigation.unavailableBody') });
            return { status: 'unavailable', reason };
        };
        try {
            if (!isCurrent()) return unavailable('scope_changed');
            const selected = await nextPendingRequest({
                source,
                nowMs: Date.now(),
                excluding: options.excluding === undefined ? getFocusedSessionAddress() : options.excluding,
                signal: controller.signal,
            });
            if (!isCurrent()) return unavailable(options.signal?.aborted ? 'cancelled' : 'scope_changed');
            if (selected.kind === 'none') return { status: 'none' };
            if (selected.kind === 'unavailable') return unavailable(selected.reason);
            const binding = frame.bindings.get(selected.address.serverId);
            if (!binding?.isCurrent()) return unavailable('scope_changed');
            targetRetirement = binding.onRetire(abort);
            const result = await navigateToPendingRequest({
                target: selected,
                details: selected.details,
                source,
                nowMs: Date.now(),
                signal: controller.signal,
                openRoute: (route) => {
                    if (!isCurrent() || !binding.isCurrent()) throw new Error('Pending navigation retired before opening');
                    frameRef.current.router.push(route as Href);
                },
            });
            // A committed cross-Home route intentionally changes the active Home.
            // Its landing survives that switch; only uncommitted work is fenced.
            if (result.status === 'opened') {
                if (mountedRef.current && selected.unavailableCount > 0) publishPresentationNotice({
                    key: NOTICE_KEY,
                    severity: 'warning',
                    message: t('pendingNavigation.skippedUnavailable', { count: selected.unavailableCount }),
                });
                return result;
            }
            return isCurrent() ? unavailable(result.status === 'unavailable' ? result.reason ?? 'target_unavailable' : 'target_unavailable')
                : unavailable('scope_changed');
        } catch {
            return unavailable(isCurrent() ? 'navigation_failed' : options.signal?.aborted ? 'cancelled' : 'scope_changed');
        } finally {
            targetRetirement?.dispose();
            retirement.dispose();
            options.signal?.removeEventListener('abort', abort);
            inFlightRef.current.delete(attempt);
        }
    // Workspace navigation replaces its router as destinations change. The
    // app-shell registration must survive that update: unregistering clears
    // the landing before its answer control can hydrate, and the Next offer.
    }, []);

    React.useEffect(() => {
        mountedRef.current = true;
        const unregister = registerPendingNavigationRuntime(invoke);
        const unsubscribe = subscribeHomeCredentialChange(({ serverId }) => {
            clearPendingNavigationState(serverId);
            for (const attempt of inFlightRef.current) {
                if (attempt.homeId && areServerProfileIdentifiersEquivalent(attempt.homeId, serverId)) attempt.controller.abort();
            }
        });
        return () => {
            mountedRef.current = false;
            for (const attempt of inFlightRef.current) attempt.controller.abort();
            unsubscribe();
            unregister();
        };
    }, [invoke]);
    // The person pressed the key: when nothing waits, say so once, quietly, where they are (Find lab `fnext` ST).
    // Actions and MCP callers get the typed `none` instead; their result never interrupts the screen.
    useKeyboardShortcutHandlers({ 'session.pending.next': () => {
        void invokeNextPendingRequest().then((result) => {
            if (result.status !== 'none' || !mountedRef.current) return;
            publishPresentationNotice({ key: NOTICE_KEY, severity: 'info', message: t('pendingNavigation.nothingWaiting') });
        });
    } });
    return null;
}
