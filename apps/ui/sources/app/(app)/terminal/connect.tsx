import React from 'react';
import { Platform } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { TerminalConnectSurface } from '@/components/terminalConnect/TerminalConnectSurface';
import { resolvePostAuthLanding } from '@/components/onboarding/state/resolvePostAuthLanding';
import { terminalLinkProblemMessage } from '@/components/terminalConnect/terminalLinkProblem';
import { useAuth } from '@/auth/context/AuthContext';
import { useTerminalConnectContinuation } from '@/hooks/session/useTerminalConnectContinuation';
import { useTerminalConnectWebRequest } from '@/hooks/session/useTerminalConnectWebRequest';
import { safeRouterBack } from '@/utils/navigation/safeRouterBack';
import { t } from '@/text';

export default function TerminalConnectScreen() {
    const router = useRouter();
    const auth = useAuth();
    const routeHash = useLocalSearchParams<{ '#': string }>()['#'];
    const { request, hashProcessed, scrubIfResumable } = useTerminalConnectWebRequest(routeHash);
    const serverUrlFromHash = request?.serverUrl ?? null;
    const homeConnectionDescriptor = request?.homeConnectionDescriptor;
    const onSuccess = React.useCallback(() => { resolvePostAuthLanding({ replace: router.replace }); }, [router]);
    const onReject = React.useCallback(() => {
        safeRouterBack({ router, fallbackHref: '/' });
    }, [router]);
    const { approve: handleConnect, reject: handleReject, isLoading, approvalDetails, retryApprovalDetails, preAuthTarget, linkState, connected } = useTerminalConnectContinuation({
        request, replace: router.replace, onReject, allowLoopbackServerOverride: true, onCaptured: scrubIfResumable,
    });
    const publicKey = linkState === 'ready' ? request?.publicKeyB64Url ?? null : null;

    if (Platform.OS !== 'web') {
        return (
            <TerminalConnectSurface
                testID="terminal-connect-surface"
                state={{
                    kind: 'message',
                    title: t('terminal.webBrowserRequired'),
                    description: t('terminal.webBrowserRequiredDescription'),
                }}
            />
        );
    }

    if (connected) {
        return <TerminalConnectSurface testID="terminal-connect-surface" state={{ kind: 'connected', result: connected, onContinue: onSuccess }} />;
    }

    if (!hashProcessed) {
        return (
            <TerminalConnectSurface
                testID="terminal-connect-surface"
                state={{
                    kind: 'message',
                    title: t('terminal.processingConnection'),
                    loading: true,
                }}
            />
        );
    }

    if (!auth.isAuthenticated && publicKey) {
        if (preAuthTarget?.canNavigateToAuth === false) {
            return (
                <TerminalConnectSurface
                    testID="terminal-connect-surface"
                    state={{
                        kind: 'message',
                        title: t('welcome.serverUnavailableTitle'),
                        description: t('welcome.serverUnavailableBody', {
                            serverUrl: homeConnectionDescriptor?.canonicalServerUrl ?? serverUrlFromHash ?? '',
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
        return (
            <TerminalConnectSurface
                testID="terminal-connect-surface"
                state={terminalLinkProblemMessage({
                    linkState: linkState === 'ready' ? 'invalid' : linkState,
                    signedIn: auth.isAuthenticated,
                    navigate: router.replace,
                })}
            />
        );
    }

    return (
        <TerminalConnectSurface
            testID="terminal-connect-surface"
            state={{
                kind: 'approval',
                isLoading,
                storageMode: approvalDetails.kind === 'ready' ? approvalDetails.storageMode : null,
                homeUrl: approvalDetails.kind === 'ready' || approvalDetails.kind === 'needs_sign_in'
                    ? approvalDetails.homeUrl : homeConnectionDescriptor?.canonicalServerUrl ?? serverUrlFromHash ?? '',
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
