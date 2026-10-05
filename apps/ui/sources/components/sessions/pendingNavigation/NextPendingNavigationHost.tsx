import * as React from 'react';
import { buildPendingNavigationFromSource } from '@/activity/source/buildPendingNavigationFromSource';
import { nextPendingRequest } from '@/activity/source/nextPendingRequest';
import { navigateToPendingRequest } from '@/activity/source/navigateToPendingRequest';
import {
    clearPendingNavigationState,
    invokeNextPendingRequest,
    registerPendingNavigationRuntime,
    type PendingNavigationInvocation,
    type PendingNavigationResult,
} from '@/activity/source/pendingNavigationRuntime';
import { useActivityAttentionSummarySource } from '@/activity/source/useActivityAttentionSource';
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
    const summary = useActivityAttentionSummarySource();
    const homeIds = React.useMemo(() => [
        summary.activeServerId,
        ...buildPendingNavigationFromSource({ source: summary, nowMs: Date.now(), includeUnavailable: true })
            .map(candidate => candidate.address.serverId),
    ], [summary]);
    const bindings = useServerCredentialAccountScopeBindings(homeIds);
    const source = React.useMemo(() => ({
        ...summary,
        audienceScopes: new Map([...bindings].map(([serverId, binding]) => [serverId, binding.scope])),
    }), [summary, bindings]);
    const frameRef = React.useRef({ source, bindings });
    frameRef.current = { source, bindings };
    const mountedRef = React.useRef(false);
    const inFlightRef = React.useRef(new Set<Readonly<{ controller: AbortController; homeId: string | null }>>());

    const invoke = React.useCallback(async (options: PendingNavigationInvocation): Promise<PendingNavigationResult> => {
        const ownerScope = getActiveServerAccountScope();
        if (options.signal?.aborted || (options.expectedServerId && (!ownerScope
            || !areServerProfileIdentifiersEquivalent(options.expectedServerId, ownerScope.serverId)))) {
            return { status: 'unavailable' };
        }
        const frame = frameRef.current;
        const lifetime = captureActiveServerAccountScopeCurrentness();
        const controller = new AbortController();
        const abort = () => { controller.abort(); };
        const attempt = { controller, homeId: ownerScope?.serverId ?? frame.source.activeServerId ?? null };
        inFlightRef.current.add(attempt);
        const retirement = lifetime.onRetire(abort);
        options.signal?.addEventListener('abort', abort, { once: true });
        let targetRetirement: Readonly<{ dispose(): void }> | undefined;
        const isCurrent = () => mountedRef.current && !controller.signal.aborted && lifetime.isCurrent();
        const unavailable = (): PendingNavigationResult => {
            if (isCurrent()) publishPresentationNotice({ key: NOTICE_KEY, severity: 'warning', message: t('pendingNavigation.unavailableBody') });
            return { status: 'unavailable' };
        };
        try {
            if (!isCurrent()) return { status: 'unavailable' };
            const selected = await nextPendingRequest({
                source: frame.source,
                nowMs: Date.now(),
                excluding: options.excluding === undefined ? getFocusedSessionAddress() : options.excluding,
                signal: controller.signal,
            });
            if (!isCurrent()) return { status: 'unavailable' };
            if (selected.kind === 'none') return { status: 'none' };
            if (selected.kind === 'unavailable') return unavailable();
            const binding = frame.bindings.get(selected.address.serverId);
            if (!binding?.isCurrent()) return unavailable();
            targetRetirement = binding.onRetire(abort);
            const result = await navigateToPendingRequest({
                target: selected,
                details: selected.details,
                source: frame.source,
                nowMs: Date.now(),
                signal: controller.signal,
                openRoute: (route) => {
                    if (!isCurrent() || !binding.isCurrent()) throw new Error('Pending navigation retired before opening');
                    router.push(route as Href);
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
            return isCurrent() ? unavailable() : { status: 'unavailable' };
        } catch {
            return unavailable();
        } finally {
            targetRetirement?.dispose();
            retirement.dispose();
            options.signal?.removeEventListener('abort', abort);
            inFlightRef.current.delete(attempt);
        }
    }, [router]);

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
    useKeyboardShortcutHandlers({ 'session.pending.next': () => { void invokeNextPendingRequest(); } });
    return null;
}
