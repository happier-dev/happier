import { useFocusEffect } from '@react-navigation/native';
import { useRouter } from 'expo-router';
import { Platform } from 'react-native';
import * as React from 'react';

import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import type { SessionPaneUrlState } from '@/components/sessions/panes/url/sessionPaneUrlState';
import { useSessionPaneUrlSync } from '@/components/sessions/panes/url/useSessionPaneUrlSync';
import { useWarmRepositoryDirectoryCacheOnSessionOpen } from '@/hooks/session/files/useWarmRepositoryDirectoryCacheOnSessionOpen';
import { setActiveViewingSessionId, clearActiveViewingSessionId } from '@/sync/domains/session/activeViewingSession';
import { storage } from '@/sync/domains/state/storage';
import { sync } from '@/sync/sync';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { runAfterInteractionsWithFallback } from '@/utils/timing/runAfterInteractionsWithFallback';
import { useSessionMachineReachability } from '@/components/sessions/model/useSessionMachineReachability';

export type UseSessionViewBootstrapInput = Readonly<{
    sessionId: string;
    paneScopeId: string;
    paneUrlState: SessionPaneUrlState | null;
    multiPaneEnabled: boolean;
    sessionsRightPaneDefaultOpen: boolean;
    deviceType: string;
    sessionPath: string | null;
    sessionSeq: number | null;
    sessionPendingVersion: number | null;
}>;

export type UseSessionViewBootstrapResult = Readonly<{
    pane: ReturnType<typeof useAppPaneScope>;
    machineReachable: boolean;
}>;

export function useSessionViewBootstrap(input: UseSessionViewBootstrapInput): UseSessionViewBootstrapResult {
    const router = useRouter();
    const pane = useAppPaneScope(input.paneScopeId);
    const { machineReachable, machineOnline } = useSessionMachineReachability(input.sessionId);

    useSessionPaneUrlSync({
        enabled: input.multiPaneEnabled && Platform.OS === 'web',
        scopeKey: input.paneScopeId,
        scopeState: pane.scopeState,
        urlState: input.paneUrlState,
        pane,
        setParams: typeof (router as any)?.setParams === 'function' ? (router as any).setParams.bind(router) : null,
    });

    React.useEffect(() => {
        if (!input.sessionsRightPaneDefaultOpen) return;
        if (!input.multiPaneEnabled) return;
        if (!(Platform.OS === 'web' || input.deviceType === 'tablet')) return;
        if (input.paneUrlState?.rightTabId) return;
        const right = (pane.scopeState as any)?.right ?? null;
        if (!right) return;
        if (right.isOpen === true) return;
        if (right.activeTabId !== null && right.activeTabId !== undefined) return;
        pane.openRight({ tabId: 'files' });
        pane.setRightTab('files');
    }, [
        input.deviceType,
        input.multiPaneEnabled,
        input.paneUrlState?.rightTabId,
        input.sessionsRightPaneDefaultOpen,
        pane,
    ]);

    const markSessionViewed = React.useCallback((opts?: { sessionSeq?: number }) => {
        fireAndForget(sync.markSessionViewed(input.sessionId, opts), { tag: 'SessionView.markSessionViewed' });
    }, [input.sessionId]);

    const isFocusedRef = React.useRef(false);
    const markViewedTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const lastMarkedRef = React.useRef<{ sessionSeq: number } | null>(null);

    useFocusEffect(React.useCallback(() => {
        isFocusedRef.current = true;
        setActiveViewingSessionId(input.sessionId);
        {
            const current = storage.getState().sessions[input.sessionId];
            lastMarkedRef.current = {
                sessionSeq: current?.seq ?? 0,
            };
        }
        const cancelMarkViewed = runAfterInteractionsWithFallback(markSessionViewed);
        return () => {
            isFocusedRef.current = false;
            clearActiveViewingSessionId(input.sessionId);
            const sessionSeqAtBlur = storage.getState().sessions[input.sessionId]?.seq ?? 0;
            cancelMarkViewed();
            if (markViewedTimeoutRef.current) {
                clearTimeout(markViewedTimeoutRef.current);
                markViewedTimeoutRef.current = null;
            }
            runAfterInteractionsWithFallback(() => {
                markSessionViewed({ sessionSeq: sessionSeqAtBlur });
            });
        };
    }, [markSessionViewed, input.sessionId]));

    React.useEffect(() => {
        if (!isFocusedRef.current) return;

        const sessionSeq = input.sessionSeq ?? 0;
        const last = lastMarkedRef.current;
        if (last && last.sessionSeq >= sessionSeq) return;

        lastMarkedRef.current = { sessionSeq };
        if (markViewedTimeoutRef.current) clearTimeout(markViewedTimeoutRef.current);
        markViewedTimeoutRef.current = setTimeout(() => {
            markViewedTimeoutRef.current = null;
            markSessionViewed();
        }, 250);
        return () => {
            if (markViewedTimeoutRef.current) {
                clearTimeout(markViewedTimeoutRef.current);
                markViewedTimeoutRef.current = null;
            }
        };
    }, [markSessionViewed, input.sessionSeq]);

    React.useEffect(() => {
        return runAfterInteractionsWithFallback(() => {
            fireAndForget(sync.fetchPendingMessages(input.sessionId), { tag: 'SessionView.fetchPendingMessages' });
        });
    }, [input.sessionId, input.sessionPendingVersion]);

    useWarmRepositoryDirectoryCacheOnSessionOpen({
        sessionId: input.sessionId,
        sessionPath: input.sessionPath,
        machineOnline,
    });

    React.useLayoutEffect(() => {
        sync.onSessionVisible(input.sessionId);
    }, [input.sessionId]);

    return {
        pane,
        machineReachable,
    };
}
