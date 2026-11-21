import React from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { TerminalConnectSurface } from '@/components/terminalConnect/TerminalConnectSurface';
import { resolvePostAuthLanding } from '@/components/onboarding/state/resolvePostAuthLanding';
import { terminalLinkProblemMessage } from '@/components/terminalConnect/terminalLinkProblem';
import { useAuth } from '@/auth/context/AuthContext';
import { useTerminalConnectContinuation } from '@/hooks/session/useTerminalConnectContinuation';
import { usePendingTerminalConnect } from '@/hooks/session/usePendingTerminalConnect';
import { parseTerminalConnectRouteParams, type TerminalConnectRouteParams } from '@/utils/path/terminalConnectUrl';
import { safeRouterBack } from '@/utils/navigation/safeRouterBack';
import { t } from '@/text';

export default function TerminalScreen() {
    const router = useRouter();
    const auth = useAuth();
    const searchParams = useLocalSearchParams();
    // Expo returns fresh parameter objects; parse only when route values change.
    const routeParamsJson = JSON.stringify(searchParams);
    const pending = usePendingTerminalConnect(Object.keys(searchParams).length === 0);
    const parsed = React.useMemo(() => {
        const params = JSON.parse(routeParamsJson) as TerminalConnectRouteParams;
        return parseTerminalConnectRouteParams(params);
    }, [routeParamsJson]) ?? pending;
    const serverUrl = parsed?.serverUrl ?? parsed?.homeConnectionDescriptor?.canonicalServerUrl ?? null;
    const onSuccess = React.useCallback(() => { resolvePostAuthLanding({ replace: router.replace }); }, [router]);
    const onReject = React.useCallback(() => { safeRouterBack({ router, fallbackHref: '/' }); }, [router]);
    const { approve: handleConnect, reject: handleReject, isLoading, approvalDetails, retryApprovalDetails, preAuthTarget, linkState, connected } = useTerminalConnectContinuation({
        request: parsed, replace: router.replace, onReject,
    });
    const publicKey = linkState === 'ready' ? parsed?.publicKeyB64Url ?? null : null;

    if (connected) {
        return <TerminalConnectSurface testID="terminal-connect-surface" state={{ kind: 'connected', result: connected, onContinue: onSuccess }} />;
    }

    const linkProblem = (
        <TerminalConnectSurface
            testID="terminal-connect-surface"
            state={terminalLinkProblemMessage({
                linkState: linkState === 'ready' ? 'invalid' : linkState,
                signedIn: auth.isAuthenticated,
                navigate: router.replace,
            })}
        />
    );
    if (linkState === 'update_required') return linkProblem;

    if (!auth.isAuthenticated && publicKey) {
        if (preAuthTarget?.canNavigateToAuth === false) {
            return (
                <TerminalConnectSurface
                    testID="terminal-connect-surface"
                    state={{
                        kind: 'message',
                        title: t('welcome.serverUnavailableTitle'),
                        description: t('welcome.serverUnavailableBody', {
                            serverUrl: preAuthTarget.pendingServerUrl,
                        }),
                        tone: 'critical',
                    }}
                />
            );
        }
        return (
            <TerminalConnectSurface
                testID="terminal-connect-surface"
                state={{
                    kind: 'message',
                    title: t('modals.pleaseSignInFirst'),
                }}
            />
        );
    }

    if (!publicKey) {
        return linkProblem;
    }

    return (
        <TerminalConnectSurface
            testID="terminal-connect-surface"
            state={{
                kind: 'approval',
                isLoading,
                storageMode: approvalDetails.kind === 'ready' ? approvalDetails.storageMode : null,
                homeUrl: approvalDetails.kind === 'ready' || approvalDetails.kind === 'needs_sign_in'
                    ? approvalDetails.homeUrl : serverUrl ?? '',
                needsSignIn: approvalDetails.kind === 'needs_sign_in',
                ...(approvalDetails.kind === 'error' ? {
                    errorDescription: t('modals.failedToConnectTerminal'),
                    onRetry: retryApprovalDetails,
                } : {}),
                onApprove: handleConnect,
                onReject: handleReject,
            }}
        />
    );
}
