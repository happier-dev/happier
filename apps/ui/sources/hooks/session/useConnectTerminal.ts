import * as React from 'react';
import { router } from 'expo-router';
import { useAuth } from '@/auth/context/AuthContext';
import {
    TokenStorage,
    type AuthCredentials,
    isTokenOnlyAuthCredentials,
} from '@/auth/storage/tokenStorage';
import { authApprove } from '@/auth/flows/approve';
import {
    buildTerminalResponseV1,
    buildTerminalResponseV2,
    buildTerminalResponseV3,
    buildTerminalTokenOnlyResponseV3,
} from '@/auth/terminal/terminalProvisioning';
import { Modal } from '@/modal';
import { t } from '@/text';
import { getActiveServerUrl } from '@/sync/domains/server/serverProfiles';
import { isSameServerUrl, normalizeServerUrl, upsertActivateAndSwitchServer } from '@/sync/domains/server/activeServerSwitch';
import { resolveEffectiveServerUrlOverride } from '@/sync/domains/server/url/serverUrlOverridePolicy';
import { clearPendingTerminalConnect, setPendingTerminalConnect } from '@/sync/domains/pending/pendingTerminalConnect';
import { buildTerminalConnectAuthRedirectHref, parseTerminalConnectUrl } from '@/utils/path/terminalConnectUrl';
import { storage } from '@/sync/domains/state/storageStore';
import { canUseCurrentDeviceQrScanner } from '@/utils/platform/qrScannerSupport';
import { fetchAccountEncryptionMode } from '@/sync/api/account/apiAccountEncryptionMode';
import { isRuntimeFeatureEnabled } from '@/sync/domains/features/featureDecisionInputs';
import { resolveProvisioningMaterial } from '@/auth/terminal/resolveProvisioningMaterial';

interface UseConnectTerminalOptions {
    onSuccess?: () => void;
    onError?: (error: any) => void;
    allowLoopbackServerOverride?: boolean;
}

function hasTokenOnlyTerminalCredentials(credentials: AuthCredentials): boolean {
    return isTokenOnlyAuthCredentials(credentials);
}

export function useConnectTerminal(options?: UseConnectTerminalOptions) {
    const auth = useAuth();
    const [isLoading, setIsLoading] = React.useState(false);

    const processAuthUrl = React.useCallback(async (url: string) => {
        const parsed = parseTerminalConnectUrl(url);
        if (!parsed) {
            await Modal.alertAsync(t('common.error'), t('modals.invalidAuthUrl'), [{ text: t('common.ok') }]);
            return false;
        }
        
        setIsLoading(true);
        try {
            let activeCredentials: AuthCredentials | null = auth.credentials;
            const currentServerUrl = normalizeServerUrl(getActiveServerUrl());
            const effectiveParsedServerUrl = resolveEffectiveServerUrlOverride({
                requestedServerUrl: parsed.serverUrl,
                activeServerUrl: currentServerUrl,
                allowLoopbackOverride: options?.allowLoopbackServerOverride === true,
            });

            if (effectiveParsedServerUrl) {
                if (currentServerUrl && !isSameServerUrl(currentServerUrl, effectiveParsedServerUrl)) {
                    setPendingTerminalConnect({
                        publicKeyB64Url: parsed.publicKeyB64Url,
                        serverUrl: effectiveParsedServerUrl,
                        ...(parsed.pairing ? { pairing: parsed.pairing } : {}),
                        ...(parsed.supportsTokenOnly ? { supportsTokenOnly: true } : {}),
                    });
                    await upsertActivateAndSwitchServer({
                        serverUrl: effectiveParsedServerUrl,
                        source: 'url',
                        scope: 'device',
                        refreshAuth: auth.refreshFromActiveServer,
                    });
                    activeCredentials = await TokenStorage.getCredentials();
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
                    ...(parsed.supportsTokenOnly ? { supportsTokenOnly: true } : {}),
                });
                await Modal.alertAsync(t('terminal.connectTerminal'), t('modals.pleaseSignInFirst'), [
                    { text: t('common.continue') },
                ]);
                router.replace(buildTerminalConnectAuthRedirectHref({
                    serverUrl: effectiveParsedServerUrl || currentServerUrl || getActiveServerUrl(),
                }));
                return false;
            }

            const publicKey = decodeBase64(parsed.publicKeyB64Url, 'base64url');

            const allowLegacySecretExportEnabled = Boolean(
                storage.getState().settings?.terminalConnectLegacySecretExportEnabled,
            );

            const pairingSecret = parsed.pairing
                ? decodeBase64(parsed.pairing.secretB64Url, 'base64url')
                : null;
            let responseV2: Uint8Array;
            let responseV1: Uint8Array | (() => Uint8Array);
            if (hasTokenOnlyTerminalCredentials(activeCredentials)) {
                if (!parsed.pairing || pairingSecret?.length !== 32 || parsed.supportsTokenOnly !== true) {
                    throw new Error('Token-only terminal pairing requires an authenticated compatible reader');
                }
                const [accountMode, plaintextStorageEnabled, keylessAccountsEnabled] = await Promise.all([
                    fetchAccountEncryptionMode(activeCredentials, { retry: 'none' }),
                    isRuntimeFeatureEnabled({ featureId: 'encryption.plaintextStorage' }),
                    isRuntimeFeatureEnabled({ featureId: 'e2ee.keylessAccounts' }),
                ]);
                if (
                    accountMode.mode !== 'plain'
                    || !plaintextStorageEnabled
                    || !keylessAccountsEnabled
                ) {
                    throw new Error('Token-only terminal pairing is not permitted by the active account policy');
                }
                responseV2 = buildTerminalTokenOnlyResponseV3({
                    terminalEphemeralPublicKey: publicKey,
                    pairingSecret,
                    createdAtMs: parsed.pairing.createdAtMs,
                    expiresAtMs: parsed.pairing.expiresAtMs,
                });
                responseV1 = new Uint8Array();
            } else {
                const provisioningMaterial = resolveProvisioningMaterial(activeCredentials);
                if (provisioningMaterial.type === 'tokenOnly') {
                    throw new Error('Token-only terminal pairing requires an authenticated compatible reader');
                }
                const contentPrivateKey = provisioningMaterial.key;
                responseV2 =
                    parsed.pairing && pairingSecret?.length === 32
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
                        });

                const legacyCredentials =
                    isLegacyAuthCredentials(activeCredentials) ? activeCredentials : null;
                responseV1 =
                    allowLegacySecretExportEnabled && legacyCredentials
                        ? () =>
                            buildTerminalResponseV1({
                                legacySecretB64Url: legacyCredentials.secret,
                                terminalEphemeralPublicKey: publicKey,
                            })
                        : new Uint8Array();
            }

            const approvalResult = await authApprove(activeCredentials.token, publicKey, responseV1, responseV2);

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
    }, [auth.credentials, options]);

    const connectTerminal = React.useCallback(async () => {
        const canUseScanner = canUseCurrentDeviceQrScanner();
        if (!canUseScanner) {
            await Modal.alertAsync(t('common.error'), t('modals.qrScannerUnavailable'), [{ text: t('common.ok') }]);
            return;
        }
        router.push('/scan/terminal');
    }, []);

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
