import * as React from 'react';
import { useDestinationRouter } from '@/components/appShell/workspace/DestinationInstanceHost';
import { useAuth } from '@/auth/context/AuthContext';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { approveTerminalPairing, resolveTerminalPairingStorageMode } from '@/auth/terminal/approveTerminalPairing';
import { focusTerminalConnectHome } from '@/auth/terminal/focusTerminalConnectHome';
import { resolveHomeEnrollmentTransport } from '@/auth/enrollment/homeEnrollmentTransport';
import { resolveTerminalApprovalTarget } from '@/auth/terminal/resolveTerminalApprovalTarget';
import { Modal } from '@/modal';
import { t } from '@/text';
import { getActiveServerUrl } from '@/sync/domains/server/serverProfiles';
import { normalizeServerUrl } from '@/sync/domains/server/activeServerSwitch';
import { clearPendingTerminalConnect, setPendingTerminalConnect } from '@/sync/domains/pending/pendingTerminalConnect';
import type { PendingTerminalConnect } from '@/sync/domains/pending/pendingTerminalConnect.shared';
import {
    buildTerminalConnectAuthRedirectHref,
    parseTerminalConnectUrl,
    resolveTerminalConnectPreAuthTarget,
    type ParsedTerminalConnectUrl,
} from '@/utils/path/terminalConnectUrl';
import { canUseCurrentDeviceQrScanner } from '@/utils/platform/qrScannerSupport';
import { decodeBase64 } from '@/encryption/base64';
import { promptLegacyPairingUpdateRequired } from '@/auth/pairing/legacyPairingUpdateRequired';

interface UseConnectTerminalOptions {
    onSuccess?: () => void;
    onError?: (error: unknown) => void;
    allowLoopbackServerOverride?: boolean;
    approvalRequest?: ParsedTerminalConnectUrl | null;
}

type TerminalConnectApprovalDetails =
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

    const processParsedAuthUrl = React.useCallback(async (parsed: ParsedTerminalConnectUrl) => {
        if (parsed.compatibility?.admission === 'update_required') {
            const action = await promptLegacyPairingUpdateRequired();
            if (action === 'scan_new_qr') router.push('/scan/terminal');
            return false;
        }
        
        setIsLoading(true);
        try {
            const currentServerUrl = normalizeServerUrl(getActiveServerUrl());
            const target = await resolveTerminalApprovalTarget({
                parsed,
                allowLoopbackServerOverride: options?.allowLoopbackServerOverride === true,
            });
            const activeCredentials = target.credentials;

            if (!activeCredentials) {
                const preAuthTarget = await resolveTerminalConnectPreAuthTarget({
                    requestedServerUrl: parsed.serverUrl ?? parsed.homeConnectionDescriptor?.canonicalServerUrl,
                    activeServerUrl: currentServerUrl,
                    ...(parsed.homeConnectionDescriptor ? { homeConnectionDescriptor: parsed.homeConnectionDescriptor } : {}),
                    allowLegacyLoopbackOverride: options?.allowLoopbackServerOverride === true,
                });
                if (!preAuthTarget) {
                    throw new Error('Terminal pairing requires a pre-auth target Home');
                }
                const pendingServerUrl = preAuthTarget.pendingServerUrl;
                const pendingConnect: PendingTerminalConnect = {
                    publicKeyB64Url: parsed.publicKeyB64Url,
                    serverUrl: pendingServerUrl,
                    serverIdentityId: parsed.serverIdentityId ?? '',
                    ...(parsed.pairing ? { pairing: parsed.pairing } : {}),
                    ...(parsed.supportsTokenOnly ? { supportsTokenOnly: true } : {}),
                    ...(parsed.homeConnectionDescriptor
                        ? { homeConnectionDescriptor: parsed.homeConnectionDescriptor }
                        : {}),
                };
                if (preAuthTarget.canNavigateToAuth === false) {
                    setPendingTerminalConnect(pendingConnect);
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
                    const shouldSwitchHome = await Modal.confirm(
                        t('terminal.connectTerminal'),
                        t('terminal.switchServerToConnectTerminal', {
                            serverUrl: target.endpointUrl,
                            signedInServerUrl: currentServerUrl,
                        }),
                        { confirmText: t('server.switchToServer') },
                    );
                    if (!shouldSwitchHome) {
                        clearPendingTerminalConnect();
                        return false;
                    }
                    setPendingTerminalConnect(pendingConnect);
                    if (parsed.homeConnectionDescriptor) {
                        const profile = await focusTerminalConnectHome({ descriptor: parsed.homeConnectionDescriptor, refreshAuth: auth.refreshFromActiveServer });
                        if (!profile) return false;
                    }
                    router.replace(buildTerminalConnectAuthRedirectHref({ serverUrl: pendingServerUrl }));
                    return false;
                }
                setPendingTerminalConnect(pendingConnect);
                await Modal.alertAsync(
                    t('terminal.connectTerminal'),
                    t('modals.pleaseSignInFirst'),
                    [{ text: t('common.continue') }],
                );
                if (parsed.homeConnectionDescriptor) {
                    const profile = await focusTerminalConnectHome({ descriptor: parsed.homeConnectionDescriptor, refreshAuth: auth.refreshFromActiveServer });
                    if (!profile) return false;
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
            const transportResolution = await resolveHomeEnrollmentTransport(target.descriptor, target.transportOptions);
            if (!transportResolution.ok) {
                throw new Error(`Terminal pairing transport unavailable: ${transportResolution.reason}`);
            }
            let approvalResult: Awaited<ReturnType<typeof approveTerminalPairing>>;
            try {
                approvalResult = await approveTerminalPairing({
                    target: transportResolution.transport,
                    requesterPublicKey: publicKey,
                    pairingContext: {
                        secret: pairingSecret,
                        createdAtMs: parsed.pairing.createdAtMs,
                        expiresAtMs: parsed.pairing.expiresAtMs,
                    },
                    targetCredentials: activeCredentials,
                    supportsTokenOnly: parsed.supportsTokenOnly === true,
                });
            } finally {
                await transportResolution.transport.close();
            }

            // If we successfully completed a pending connect, clear it.
            clearPendingTerminalConnect();

            if (approvalResult === 'approved') {
                await Modal.alertAsync(t('common.success'), t('modals.terminalConnectedSuccessfully'), [
                    {
                        text: t('common.ok'),
                    }
                ]);
                options?.onSuccess?.();
                return true;
            }

            if (approvalResult === 'already_authorized') {
                await Modal.alertAsync(
                    t('modals.terminalAlreadyConnected'),
                    t('modals.terminalConnectionAlreadyUsedDescription'),
                    [{ text: t('common.ok') }]
                );
                return false;
            }

            if (approvalResult === 'not_found') {
                await Modal.alertAsync(
                    t('modals.authRequestExpired'),
                    t('modals.authRequestExpiredDescription'),
                    [{ text: t('common.ok') }]
                );
                return false;
            }

            return true;
        } catch (e) {
            await Modal.alertAsync(t('common.error'), t('modals.failedToConnectTerminal'), [{ text: t('common.ok') }]);
            options?.onError?.(e);
            return false;
        } finally {
            setIsLoading(false);
        }
    }, [auth.credentials, auth.refreshFromActiveServer, options, router]);

    const processAuthUrl = React.useCallback(async (url: string) => {
        const parsed = parseTerminalConnectUrl(url);
        if (!parsed) {
            await Modal.alertAsync(t('common.error'), t('modals.invalidAuthUrl'), [{ text: t('common.ok') }]);
            return false;
        }
        return await processParsedAuthUrl(parsed);
    }, [processParsedAuthUrl]);

    const connectTerminal = React.useCallback(async () => {
        const canUseScanner = canUseCurrentDeviceQrScanner();
        if (!canUseScanner) {
            await Modal.alertAsync(t('common.error'), t('modals.qrScannerUnavailable'), [{ text: t('common.ok') }]);
            return;
        }
        router.push('/scan/terminal');
    }, [router]);

    const connectWithUrl = React.useCallback(async (url: string) => {
        return await processAuthUrl(url);
    }, [processAuthUrl]);

    return {
        connectTerminal,
        connectWithUrl,
        isLoading,
        processAuthUrl,
        processParsedAuthUrl,
        approvalDetails,
        retryApprovalDetails,
    };
}
