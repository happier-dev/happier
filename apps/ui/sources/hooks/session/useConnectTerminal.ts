import * as React from 'react';
import { Platform, useWindowDimensions } from 'react-native';
import { router } from 'expo-router';
import { useAuth } from '@/auth/context/AuthContext';
import { TokenStorage, type AuthCredentials, isLegacyAuthCredentials } from '@/auth/storage/tokenStorage';
import { decodeBase64 } from '@/encryption/base64';
import { authApprove } from '@/auth/flows/approve';
import {
    buildTerminalResponseV1,
    buildTerminalResponseV2,
    buildTerminalResponseV3,
    buildTerminalResponseV2TokenOnly,
    buildTerminalResponseV3TokenOnly,
    resolveTerminalProvisioningContentPrivateKey,
} from '@/auth/terminal/terminalProvisioning';
import { Modal } from '@/modal';
import { t } from '@/text';
import { getActiveServerSnapshot, getActiveServerUrl } from '@/sync/domains/server/serverProfiles';
import { normalizeServerUrl, upsertActivateAndSwitchServer } from '@/sync/domains/server/activeServerSwitch';
import { resolveEffectiveServerUrlOverride } from '@/sync/domains/server/url/serverUrlOverridePolicy';
import { isLoopbackServerUrl } from '@/sync/domains/server/url/serverUrlClassification';
import { clearPendingTerminalConnect, setPendingTerminalConnect } from '@/sync/domains/pending/pendingTerminalConnect';
import { parseTerminalConnectUrl } from '@/utils/path/terminalConnectUrl';
import { storage } from '@/sync/domains/state/storageStore';
import { isRunningOnMac } from '@/utils/platform/platform';
import { isWebMobileLikeQrScannerHost } from '@/utils/platform/webMobileHeuristics';

interface UseConnectTerminalOptions {
    onSuccess?: () => void;
    onError?: (error: any) => void;
    allowLoopbackServerOverride?: boolean;
}

export function useConnectTerminal(options?: UseConnectTerminalOptions) {
    const auth = useAuth();
    const { width, height } = useWindowDimensions();
    const [isLoading, setIsLoading] = React.useState(false);
    const allowLoopbackServerOverride = options?.allowLoopbackServerOverride ?? false;

    const processAuthUrl = React.useCallback(async (url: string) => {
        const parsed = parseTerminalConnectUrl(url);
        if (!parsed) {
            await Modal.alertAsync(t('common.error'), t('modals.invalidAuthUrl'), [{ text: t('common.ok') }]);
            return false;
        }
        
        setIsLoading(true);
        try {
            let activeCredentials: AuthCredentials | null = auth.credentials;
            if (!activeCredentials) {
                activeCredentials = await TokenStorage.getCredentials();
            }
            const credentialsBeforeSwitch = activeCredentials;
            const activeServerSnapshot = getActiveServerSnapshot();
            const currentServerUrl = normalizeServerUrl(activeServerSnapshot.serverUrl);
            const requestedServerUrl = normalizeServerUrl(parsed.serverUrl ?? '');
            const shouldKeepCurrentLoopbackServer =
                activeCredentials
                && allowLoopbackServerOverride
                && isLoopbackServerUrl(currentServerUrl)
                && isLoopbackServerUrl(requestedServerUrl);
            const effectiveParsedServerUrl = shouldKeepCurrentLoopbackServer
                ? null
                : resolveEffectiveServerUrlOverride({
                    requestedServerUrl,
                    activeServerUrl: currentServerUrl,
                    equivalentActiveServerUrls: [
                        activeServerSnapshot.activeShareableServerUrl,
                        activeServerSnapshot.activeLocalRelayUrl,
                    ],
                    allowLoopbackSwitch: allowLoopbackServerOverride,
                });

            if (effectiveParsedServerUrl) {
                setPendingTerminalConnect({
                    publicKeyB64Url: parsed.publicKeyB64Url,
                    serverUrl: effectiveParsedServerUrl,
                    ...(parsed.pairing ? { pairing: parsed.pairing } : {}),
                });
                const switched = await upsertActivateAndSwitchServer({
                    serverUrl: effectiveParsedServerUrl,
                    source: 'url',
                    scope: 'device',
                    refreshAuth: auth.refreshFromActiveServer,
                });
                if (switched) {
                    const switchedCredentials = await TokenStorage.getCredentials();
                    if (switchedCredentials) {
                        activeCredentials = switchedCredentials;
                    } else if (
                        credentialsBeforeSwitch
                        && allowLoopbackServerOverride
                        && isLoopbackServerUrl(currentServerUrl)
                        && isLoopbackServerUrl(effectiveParsedServerUrl)
                    ) {
                        activeCredentials = credentialsBeforeSwitch;
                    } else {
                        activeCredentials = null;
                    }
                }
            }

            if (!activeCredentials) {
                activeCredentials = await TokenStorage.getCredentials();
            }

            if (!activeCredentials) {
                setPendingTerminalConnect({
                    publicKeyB64Url: parsed.publicKeyB64Url,
                    serverUrl: effectiveParsedServerUrl || currentServerUrl || getActiveServerUrl(),
                    ...(parsed.pairing ? { pairing: parsed.pairing } : {}),
                });
                await Modal.alertAsync(t('terminal.connectTerminal'), t('modals.pleaseSignInFirst'), [
                    { text: t('common.continue') },
                ]);
                router.replace('/');
                return false;
            }

            const publicKey = decodeBase64(parsed.publicKeyB64Url, 'base64url');

            const allowLegacySecretExportEnabled = Boolean(
                storage.getState().settings?.terminalConnectLegacySecretExportEnabled,
            );

            const contentPrivateKey = await resolveTerminalProvisioningContentPrivateKey(activeCredentials);
            const pairingSecret = parsed.pairing
                ? decodeBase64(parsed.pairing.secretB64Url, 'base64url')
                : null;
            const responseV2 = contentPrivateKey ?
                parsed.pairing && pairingSecret
                    ? buildTerminalResponseV3({
                        contentPrivateKey,
                        terminalEphemeralPublicKey: publicKey,
                        pairingSecret,
                        createdAtMs: parsed.pairing.createdAtMs,
                        expiresAtMs: parsed.pairing.expiresAtMs,
                    })
                    : buildTerminalResponseV2({
                        contentPrivateKey,
                        terminalEphemeralPublicKey: publicKey,
                    }) : new Uint8Array();
            const answerTokenOnly = contentPrivateKey ? undefined : () => (
                parsed.pairing && pairingSecret
                    ? buildTerminalResponseV3TokenOnly({
                        terminalEphemeralPublicKey: publicKey,
                        pairingSecret,
                        createdAtMs: parsed.pairing.createdAtMs,
                        expiresAtMs: parsed.pairing.expiresAtMs,
                    })
                    : buildTerminalResponseV2TokenOnly({ terminalEphemeralPublicKey: publicKey })
            );

            const responseV1 =
                allowLegacySecretExportEnabled && isLegacyAuthCredentials(activeCredentials)
                    ? () =>
                        buildTerminalResponseV1({
                            legacySecretB64Url: activeCredentials.secret,
                            terminalEphemeralPublicKey: publicKey,
                        })
                    : new Uint8Array();

            const approvalResult = await authApprove(activeCredentials.token, publicKey, responseV1, responseV2, { answerTokenOnly });

            // If we successfully completed a pending connect, clear it.
            clearPendingTerminalConnect();

            if (approvalResult === 'approved') {
                await Modal.alertAsync(t('common.success'), t('modals.terminalConnectedSuccessfully'), [
                    {
                        text: t('common.ok'),
                        onPress: () => options?.onSuccess?.()
                    }
                ]);
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
    }, [allowLoopbackServerOverride, auth.credentials, options]);

    const connectTerminal = React.useCallback(async () => {
        const isPhoneSizedWeb = Platform.OS === 'web' && isWebMobileLikeQrScannerHost({ width, height });
        const canUseScanner = !isRunningOnMac() && (Platform.OS !== 'web' || isPhoneSizedWeb);
        if (!canUseScanner) {
            await Modal.alertAsync(t('common.error'), t('modals.qrScannerUnavailable'), [{ text: t('common.ok') }]);
            return;
        }
        router.push('/scan/terminal');
    }, [height, width]);

    const connectWithUrl = React.useCallback(async (url: string) => {
        return await processAuthUrl(url);
    }, [processAuthUrl]);

    return {
        connectTerminal,
        connectWithUrl,
        isLoading,
        processAuthUrl
    };
}
