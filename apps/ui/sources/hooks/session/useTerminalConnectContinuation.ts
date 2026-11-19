import * as React from 'react';
import type { Router } from 'expo-router';
import { useAuth } from '@/auth/context/AuthContext';
import { focusTerminalConnectTarget, prepareTerminalConnect, resolveTerminalConnectLinkState } from '@/auth/terminal/terminalConnectContinuation';
import { useConnectTerminal } from './useConnectTerminal';
import { buildTerminalConnectAuthRedirectHref, type ParsedTerminalConnectUrl, type TerminalConnectPreAuthTargetDecision } from '@/utils/path/terminalConnectUrl';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { Modal } from '@/modal';
import { t } from '@/text';
import { clearPendingTerminalConnect } from '@/sync/domains/pending/pendingTerminalConnect';

/** One continuation for both terminal route adapters; approval remains explicit. */
export function useTerminalConnectContinuation(options: Readonly<{
    request: ParsedTerminalConnectUrl | null;
    replace: Router['replace'];
    onSuccess: () => void;
    onReject: () => void;
    allowLoopbackServerOverride?: boolean;
    onCaptured?: () => void;
}>) {
    const auth = useAuth();
    const { request, replace, allowLoopbackServerOverride, onCaptured } = options;
    const [preAuthTarget, setPreAuthTarget] = React.useState<TerminalConnectPreAuthTargetDecision | null>(null);
    const linkState = resolveTerminalConnectLinkState(request);
    const requiresUpdate = linkState === 'update_required';
    const approval = useConnectTerminal({
        approvalRequest: linkState === 'ready' ? request : null,
        allowLoopbackServerOverride,
        onSuccess: options.onSuccess,
    });
    const approve = React.useCallback(async () => { await approval.approve(); }, [approval.approve]);
    const reject = React.useCallback(() => {
        clearPendingTerminalConnect();
        options.onReject();
    }, [options.onReject]);
    React.useEffect(() => {
        if (!request || linkState !== 'ready') return;
        let cancelled = false;
        fireAndForget((async () => {
            const target = await prepareTerminalConnect(request, allowLoopbackServerOverride === true && auth.isAuthenticated);
            if (cancelled) return;
            onCaptured?.();
            setPreAuthTarget(target);
            if (auth.isAuthenticated || !target?.canNavigateToAuth) return;
            const serverUrl = await focusTerminalConnectTarget({ request, serverUrl: target.pendingServerUrl, refreshAuth: auth.refreshFromActiveServer });
            if (!cancelled && serverUrl) {
                onCaptured?.();
                replace(buildTerminalConnectAuthRedirectHref({ serverUrl }));
            }
        })().catch((error: unknown) => {
            if (!cancelled) Modal.alert(t('common.error'), error instanceof Error ? error.message : t('common.error'));
        }), { tag: 'terminalConnect.continueToAuth' });
        return () => { cancelled = true; };
    }, [allowLoopbackServerOverride, auth.isAuthenticated, auth.refreshFromActiveServer, linkState, onCaptured, replace, request]);

    return { ...approval, approve, reject, preAuthTarget, requiresUpdate, linkState };
}
