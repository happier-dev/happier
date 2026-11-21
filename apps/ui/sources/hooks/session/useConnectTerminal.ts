import * as React from 'react';
import { ACCOUNT_TERMINALS_APPROVE_ACTION_ID_V1 } from '@happier-dev/protocol/actions/actionIds';
import { useDestinationRouter } from '@/components/appShell/workspace/DestinationInstanceHost';
import { useAuth } from '@/auth/context/AuthContext';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { approveTerminalPairing, resolveTerminalPairingStorageMode } from '@/auth/terminal/approveTerminalPairing';
import { confirmTerminalConnectHomeSwitch, focusTerminalConnectTarget, openTerminalConnectApproval, prepareTerminalConnect, resolveTerminalConnectLinkState } from '@/auth/terminal/terminalConnectContinuation';
import { resolveHomeEnrollmentTransport } from '@/auth/enrollment/homeEnrollmentTransport';
import { resolveTerminalApprovalTarget } from '@/auth/terminal/resolveTerminalApprovalTarget';
import { Modal } from '@/modal';
import { t } from '@/text';
import { getActiveServerUrl } from '@/sync/domains/server/serverProfiles';
import { normalizeServerUrl } from '@/sync/domains/server/activeServerSwitch';
import { clearPendingTerminalConnect } from '@/sync/domains/pending/pendingTerminalConnect';
import {
    buildTerminalConnectAuthRedirectHref,
    parseTerminalConnectUrl,
    type ParsedTerminalConnectUrl,
} from '@/utils/path/terminalConnectUrl';
import { canUseCurrentDeviceQrScanner } from '@/utils/platform/qrScannerSupport';
import { decodeBase64 } from '@/encryption/base64';

export type TerminalConnectSuccess = 'approved' | 'approved_without_team_access';

interface UseConnectTerminalOptions {
    onSuccess?: (result: TerminalConnectSuccess) => void;
    onError?: (error: unknown) => void;
    allowLoopbackServerOverride?: boolean;
    approvalRequest?: ParsedTerminalConnectUrl | null;
    navigateToApproval?: Parameters<typeof openTerminalConnectApproval>[1]['navigate'];
    onApprovalOpened?: () => void;
}

export type TerminalConnectApprovalDetails =
    | Readonly<{ kind: 'loading' | 'error' }>
    | Readonly<{ kind: 'needs_sign_in'; homeUrl: string }>
    | Readonly<{ kind: 'ready'; homeUrl: string; storageMode: 'plain' | 'e2ee' }>;

export function useConnectTerminal(options?: UseConnectTerminalOptions) {
    const router = useDestinationRouter();
    const auth = useAuth();
    const [isLoading, setIsLoading] = React.useState(false);
    const approvalRequest = options?.approvalRequest;
    const [detailsRead, setDetailsRead] = React.useState<Readonly<{
        request: ParsedTerminalConnectUrl;
        credentials: AuthCredentials;
        details: TerminalConnectApprovalDetails;
    }> | null>(null);
    const [detailsRetry, retryApprovalDetails] = React.useReducer((attempt: number) => attempt + 1, 0);

    const resolveApprovalDetails = React.useCallback(async (parsed: ParsedTerminalConnectUrl): Promise<Readonly<{
        homeUrl: string;
        storageMode: 'plain' | 'e2ee' | null;
        needsSignIn: boolean;
    }>> => {
        const target = await resolveTerminalApprovalTarget({
            parsed,
            allowLoopbackServerOverride: options?.allowLoopbackServerOverride === true,
        });
        if (!target.credentials) {
            return { homeUrl: target.endpointUrl, storageMode: null, needsSignIn: true };
        }
        if (!target.descriptor) throw new Error('Terminal pairing requires a verified Home connection descriptor');
        const resolution = await resolveHomeEnrollmentTransport(target.descriptor, target.transportOptions);
        if (!resolution.ok) throw new Error(`Terminal pairing transport unavailable: ${resolution.reason}`);
        try {
            const storageMode = await resolveTerminalPairingStorageMode({
                target: resolution.transport,
                targetCredentials: target.credentials,
            });
            return { homeUrl: target.endpointUrl, storageMode, needsSignIn: false };
        } finally {
            await resolution.transport.close();
        }
    }, [options?.allowLoopbackServerOverride]);

    React.useEffect(() => {
        const credentials = auth.credentials;
        if (!approvalRequest || !credentials) return;
        let cancelled = false;
        setDetailsRead(null);
        void resolveApprovalDetails(approvalRequest).then((result) => {
            if (cancelled) return;
            setDetailsRead({
                request: approvalRequest,
                credentials,
                details: result.storageMode
                    ? { kind: 'ready', homeUrl: result.homeUrl, storageMode: result.storageMode }
                    : { kind: 'needs_sign_in', homeUrl: result.homeUrl },
            });
        }).catch(() => {
            if (!cancelled) setDetailsRead({ request: approvalRequest, credentials, details: { kind: 'error' } });
        });
        return () => { cancelled = true; };
    }, [approvalRequest, auth.credentials, detailsRetry, resolveApprovalDetails]);

    // A previous Account/link read cannot disclose a mode for the current approval.
    const approvalDetails: TerminalConnectApprovalDetails = detailsRead && detailsRead.request === approvalRequest
        && detailsRead.credentials === auth.credentials
        ? detailsRead.details
        : { kind: 'loading' };

    const approve = React.useCallback(async () => {
        const parsed = approvalRequest;
        if (!parsed) return false;
        const linkState = resolveTerminalConnectLinkState(parsed);
        if (linkState === 'expired') {
            await Modal.alertAsync(t('modals.authRequestExpired'), t('modals.authRequestExpiredDescription'), [{ text: t('common.ok') }]);
            return false;
        }
        if (linkState !== 'ready') return false;
        
        setIsLoading(true);
        // The connect work is in flight only until an outcome or question is shown: an alert or confirmation
        // waits for the person, and the button's spinner must not keep animating under it.
        try {
            const currentServerUrl = normalizeServerUrl(getActiveServerUrl());
            const target = await resolveTerminalApprovalTarget({
                parsed,
                allowLoopbackServerOverride: options?.allowLoopbackServerOverride === true,
            });
            const activeCredentials = target.credentials;

            if (!activeCredentials) {
                const preAuthTarget = await prepareTerminalConnect(parsed, options?.allowLoopbackServerOverride === true);
                if (!preAuthTarget) {
                    throw new Error('Terminal pairing requires a pre-auth target Home');
                }
                const pendingServerUrl = preAuthTarget.pendingServerUrl;
                if (preAuthTarget.canNavigateToAuth === false) {
                    setIsLoading(false);
                    await Modal.alertAsync(
                        t('welcome.serverUnavailableTitle'),
                        t('welcome.serverUnavailableBody', { serverUrl: pendingServerUrl }),
                        [{ text: t('common.continue') }],
                    );
                    return false;
                }
                // Signed in, just not to the Home this link belongs to. The sign-in prompt is a
                // dead end there: it redirects to auth, the pending intent brings the user back
                // here, and the same prompt reappears. Name both Homes once instead, and leave
                // nothing pending when the switch is declined so nothing can bounce back.
                if (auth.credentials) {
                    setIsLoading(false);
                    if (!await confirmTerminalConnectHomeSwitch(target.endpointUrl, currentServerUrl)) return false;
                    if (parsed.homeConnectionDescriptor) {
                        const focused = await focusTerminalConnectTarget({ request: parsed, serverUrl: pendingServerUrl, refreshAuth: auth.refreshFromActiveServer });
                        if (!focused) return false;
                    }
                    router.replace(buildTerminalConnectAuthRedirectHref({ serverUrl: pendingServerUrl }));
                    return false;
                }
                setIsLoading(false);
                await Modal.alertAsync(
                    t('terminal.connectTerminal'),
                    t('modals.pleaseSignInFirst'),
                    [{ text: t('common.continue') }],
                );
                if (parsed.homeConnectionDescriptor) {
                    const focused = await focusTerminalConnectTarget({ request: parsed, serverUrl: pendingServerUrl, refreshAuth: auth.refreshFromActiveServer });
                    if (!focused) return false;
                }
                router.replace(buildTerminalConnectAuthRedirectHref({ serverUrl: pendingServerUrl }));
                return false;
            }

            const publicKey = decodeBase64(parsed.publicKeyB64Url, 'base64url');

            const pairingSecret = parsed.pairing
                ? decodeBase64(parsed.pairing.secretB64Url, 'base64url')
                : null;
            if (!parsed.pairing || pairingSecret?.length !== 32) {
                // Every current approval seals a pairing-bound v3 response. Unbound V1/V2
                // issuance is retired, so a requester without pairing context can only be
                // served by upgrading the remote.
                throw new Error('Terminal pairing requires an authenticated v3 pairing context');
            }
            if (!target.descriptor) {
                throw new Error('Terminal pairing requires a verified Home connection descriptor');
            }
            const descriptor = target.descriptor;
            const pairing = parsed.pairing;
            const { createActionExecutor } = await import('@happier-dev/protocol/actions/actionExecutor');
            let pairingError: unknown;
            let restrictedTeamAccessUnavailable = false;
            const executor = createActionExecutor({
                accountTerminalsApproveAction: async (signal) => {
                    const resolution = await resolveHomeEnrollmentTransport(descriptor, target.transportOptions);
                    if (!resolution.ok) throw new Error(`Terminal pairing transport unavailable: ${resolution.reason}`);
                    try {
                        const result = await approveTerminalPairing({
                            target: resolution.transport,
                            requesterPublicKey: publicKey,
                            pairingContext: {
                                secret: pairingSecret,
                                createdAtMs: pairing.createdAtMs,
                                expiresAtMs: pairing.expiresAtMs,
                            },
                            targetCredentials: activeCredentials,
                            supportsTokenOnly: parsed.supportsTokenOnly === true,
                            ...(signal ? { signal } : {}),
                        });
                        if (result === 'approved_without_team_access') {
                            // The notice belongs to this local approval receipt. The Action still completed.
                            restrictedTeamAccessUnavailable = true;
                            return 'approved';
                        }
                        return result;
                    } catch (error) {
                        pairingError = error;
                        // The Action boundary only reports the operation failure.
                        throw new Error('Terminal approval failed');
                    } finally {
                        await resolution.transport.close().catch(() => {});
                    }
                },
            });
            const approved = await executor.execute(ACCOUNT_TERMINALS_APPROVE_ACTION_ID_V1, {}, {
                surface: 'ui', authority: 'present_user', bypassApprovals: true,
            });
            if (!approved.ok) throw pairingError ?? new Error(approved.error);
            const approvalResult = approved.result && typeof approved.result === 'object' && 'status' in approved.result
                ? approved.result.status : undefined;
            if (approvalResult === undefined) throw new Error('Terminal approval did not settle');

            // If we successfully completed a pending connect, clear it.
            clearPendingTerminalConnect();

            if (approvalResult === 'approved') {
                const result = restrictedTeamAccessUnavailable ? 'approved_without_team_access' : 'approved';
                setIsLoading(false);
                if (options?.onSuccess) options.onSuccess(result);
                else await Modal.alertAsync(
                    t('common.success'),
                    restrictedTeamAccessUnavailable
                        ? t('terminal.connectedStep.restrictedTeamAccessUnavailable')
                        : t('modals.terminalConnectedSuccessfully'),
                    [{ text: t('common.ok') }],
                );
                return true;
            }

            if (approvalResult === 'already_authorized') {
                setIsLoading(false);
                await Modal.alertAsync(
                    t('modals.terminalAlreadyConnected'),
                    t('modals.terminalConnectionAlreadyUsedDescription'),
                    [{ text: t('common.ok') }]
                );
                return false;
            }

            if (approvalResult === 'not_found') {
                setIsLoading(false);
                await Modal.alertAsync(
                    t('modals.authRequestExpired'),
                    t('modals.authRequestExpiredDescription'),
                    [{ text: t('common.ok') }]
                );
                return false;
            }

            return false;
        } catch (e) {
            setIsLoading(false);
            await Modal.alertAsync(t('common.error'), t('modals.failedToConnectTerminal'), [{ text: t('common.ok') }]);
            options?.onError?.(e);
            return false;
        } finally {
            setIsLoading(false);
        }
    }, [approvalRequest, auth.credentials, auth.refreshFromActiveServer, options, router]);

    const openApproval = React.useCallback(async (parsed: ParsedTerminalConnectUrl) => {
        setIsLoading(true);
        try {
            const result = await openTerminalConnectApproval(parsed, {
                navigate: options?.navigateToApproval ?? router.push,
                refreshAuth: auth.refreshFromActiveServer,
                isAuthenticated: auth.isAuthenticated,
            });
            if (result === 'expired') {
                await Modal.alertAsync(t('modals.authRequestExpired'), t('modals.authRequestExpiredDescription'), [{ text: t('common.ok') }]);
            }
            if (result === 'opened') options?.onApprovalOpened?.();
            return result === 'opened';
        } catch (error) {
            await Modal.alertAsync(t('common.error'), t('modals.failedToConnectTerminal'), [{ text: t('common.ok') }]);
            options?.onError?.(error);
            return false;
        } finally {
            setIsLoading(false);
        }
    }, [auth.isAuthenticated, auth.refreshFromActiveServer, options, router]);

    const connectTerminal = React.useCallback(async () => {
        const canUseScanner = canUseCurrentDeviceQrScanner();
        if (!canUseScanner) {
            await Modal.alertAsync(t('common.error'), t('modals.qrScannerUnavailable'), [{ text: t('common.ok') }]);
            return;
        }
        router.push('/scan/terminal');
    }, [router]);

    const connectWithUrl = React.useCallback(async (url: string) => {
        const parsed = parseTerminalConnectUrl(url);
        if (!parsed) {
            await Modal.alertAsync(t('common.error'), t('modals.invalidAuthUrl'), [{ text: t('common.ok') }]);
            return false;
        }
        return await openApproval(parsed);
    }, [openApproval]);

    return {
        connectTerminal,
        connectWithUrl,
        isLoading,
        openApproval,
        approve,
        approvalDetails,
        retryApprovalDetails,
    };
}
