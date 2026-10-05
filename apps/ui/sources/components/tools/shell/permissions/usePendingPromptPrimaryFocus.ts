import * as React from 'react';
import { AccessibilityInfo, findNodeHandle, Platform } from 'react-native';
import { useOptionalSessionTranscriptSource } from '@/components/sessions/transcript/source/SessionTranscriptSourceContext';
import { normalizeSessionAddress } from '@/sync/domains/session/sessionAddress';
import { usePendingNavigationLanding, markSessionPendingAnswer, type PendingNavigationLanding } from '@/activity/source/pendingNavigationRuntime';
import type { SessionTranscriptSource } from '@/components/sessions/transcript/source/types';

/** Match the canonical landing to the mounted prompt placement, not a duplicate answer surface. */
export function usePendingPromptLanding(requestId: string | null, messageId?: string): PendingNavigationLanding | null {
    const source = useOptionalSessionTranscriptSource();
    const address = normalizeSessionAddress(source?.serverId, source?.sessionId);
    const landing = usePendingNavigationLanding(requestId === null ? null : address, requestId ?? undefined);
    const placement = messageId ? 'transcript' : 'prompt';
    return landing?.state === 'pending' && landing.requestId === requestId && landing.focusTarget === placement ? landing : null;
}

/** Focus the real answer control after it mounts; focusing never chooses or submits an answer. */
export function usePendingPromptPrimaryFocus(requestId: string | null, enabled: boolean, messageId?: string) {
    const landing = usePendingPromptLanding(requestId, messageId);
    const nodeRef = React.useRef<unknown>(null);
    const focusedToken = React.useRef<number | null>(null);
    const token = enabled && landing ? landing.token : null;
    const focus = React.useCallback(() => {
        const node = nodeRef.current;
        if (token === null || token === focusedToken.current || !node || typeof node !== 'object') return;
        let didRequestFocus = false;
        if ('focus' in node && typeof node.focus === 'function') {
            node.focus();
            didRequestFocus = true;
        }
        if (Platform.OS !== 'web') {
            // Native non-text refs expose focus(), but it can be a no-op; move accessibility focus too.
            const handle = findNodeHandle(node as Parameters<typeof findNodeHandle>[0]);
            if (handle !== null) {
                AccessibilityInfo.setAccessibilityFocus(handle);
                didRequestFocus = true;
            }
        }
        if (didRequestFocus) focusedToken.current = token;
    }, [token]);
    const ref = React.useCallback((node: unknown) => {
        nodeRef.current = node;
        focus();
    }, [focus]);
    React.useEffect(focus, [focus]);
    return ref;
}

/** Successful responses notify the one app-shell Next presenter, including answers outside Next. */
export function markTranscriptPromptAnswered(source: SessionTranscriptSource, requestId: string): void {
    const address = normalizeSessionAddress(source.serverId, source.sessionId);
    if (!address) return;
    markSessionPendingAnswer(address, requestId);
}
