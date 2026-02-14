import * as React from 'react';
import { Platform } from 'react-native';
import { CameraView } from 'expo-camera';
import { router } from 'expo-router';
import { useAuth } from '@/auth/context/AuthContext';
import { TokenStorage, type AuthCredentials, isLegacyAuthCredentials } from '@/auth/storage/tokenStorage';
import { decodeBase64 } from '@/encryption/base64';
import { authApprove } from '@/auth/flows/approve';
import { buildTerminalResponseV1, buildTerminalResponseV2 } from '@/auth/terminal/terminalProvisioning';
import { useCheckScannerPermissions } from '@/hooks/ui/useCheckCameraPermissions';
import { Modal } from '@/modal';
import { t } from '@/text';
import { sync } from '@/sync/sync';
import { getActiveServerUrl } from '@/sync/domains/server/serverProfiles';
import { normalizeServerUrl, upsertActivateAndSwitchServer } from '@/sync/domains/server/activeServerSwitch';
import { clearPendingTerminalConnect, setPendingTerminalConnect } from '@/sync/domains/pending/pendingTerminalConnect';
import { parseTerminalConnectUrl } from '@/utils/path/terminalConnectUrl';
import { storage } from '@/sync/domains/state/storageStore';

interface UseConnectTerminalOptions {
    onSuccess?: () => void;
    onError?: (error: any) => void;
}

export function useConnectTerminal(options?: UseConnectTerminalOptions) {
    const auth = useAuth();
    const [isLoading, setIsLoading] = React.useState(false);
    const checkScannerPermissions = useCheckScannerPermissions();
    const isProcessingRef = React.useRef(false);

    const processAuthUrl = React.useCallback(async (url: string) => {
        const parsed = parseTerminalConnectUrl(url);
        if (!parsed) {
            Modal.alert(t('common.error'), t('modals.invalidAuthUrl'), [{ text: t('common.ok') }]);
            return false;
        }
        
        setIsLoading(true);
        try {
            let activeCredentials: AuthCredentials | null = auth.credentials;

            if (parsed.serverUrl) {
                const targetServerUrl = normalizeServerUrl(parsed.serverUrl);
                const currentServerUrl = normalizeServerUrl(getActiveServerUrl());
                if (targetServerUrl && currentServerUrl !== targetServerUrl) {
                    setPendingTerminalConnect({ publicKeyB64Url: parsed.publicKeyB64Url, serverUrl: targetServerUrl });
                    await upsertActivateAndSwitchServer({
                        serverUrl: targetServerUrl,
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
                    serverUrl: normalizeServerUrl(parsed.serverUrl ?? '') || getActiveServerUrl(),
                });
                await Modal.alert(t('terminal.connectTerminal'), t('modals.pleaseSignInFirst'), [
                    { text: t('common.continue') },
                ]);
                router.replace('/');
                return false;
            }

            const publicKey = decodeBase64(parsed.publicKeyB64Url, 'base64url');

            const allowLegacySecretExportEnabled = Boolean(
                storage.getState().settings?.terminalConnectLegacySecretExportEnabled,
            );

            const contentPrivateKey = sync.encryption.getContentPrivateKey();
            const responseV2 = buildTerminalResponseV2({
                contentPrivateKey,
                terminalEphemeralPublicKey: publicKey,
            });

            const responseV1 =
                allowLegacySecretExportEnabled && isLegacyAuthCredentials(activeCredentials)
                    ? () =>
                        buildTerminalResponseV1({
                            legacySecretB64Url: activeCredentials.secret,
                            terminalEphemeralPublicKey: publicKey,
                        })
                    : new Uint8Array();

            await authApprove(activeCredentials.token, publicKey, responseV1, responseV2);

            // If we successfully completed a pending connect, clear it.
            clearPendingTerminalConnect();
            
            Modal.alert(t('common.success'), t('modals.terminalConnectedSuccessfully'), [
                { 
                    text: t('common.ok'), 
                    onPress: () => options?.onSuccess?.()
                }
            ]);
            return true;
        } catch (e) {
            console.error(e);
            Modal.alert(t('common.error'), t('modals.failedToConnectTerminal'), [{ text: t('common.ok') }]);
            options?.onError?.(e);
            return false;
        } finally {
            setIsLoading(false);
        }
    }, [auth.credentials, options]);

    const connectTerminal = React.useCallback(async () => {
        if (await checkScannerPermissions()) {
            // Use camera scanner
            CameraView.launchScanner({
                barcodeTypes: ['qr']
            });
        } else {
            Modal.alert(t('common.error'), t('modals.cameraPermissionsRequiredToConnectTerminal'), [{ text: t('common.ok') }]);
        }
    }, [checkScannerPermissions]);

    const connectWithUrl = React.useCallback(async (url: string) => {
        return await processAuthUrl(url);
    }, [processAuthUrl]);

    // Set up barcode scanner listener
    React.useEffect(() => {
        if (CameraView.isModernBarcodeScannerAvailable) {
            const subscription = CameraView.onModernBarcodeScanned(async (event) => {
                if (event.data.startsWith('happier://terminal?')) {
                    if (isProcessingRef.current) {
                        return;
                    }
                    isProcessingRef.current = true;
                    try {
                        // Dismiss scanner on Android is called automatically when barcode is scanned
                        if (Platform.OS === 'ios') {
                            await CameraView.dismissScanner().catch(() => {});
                        }
                        await processAuthUrl(event.data);
                    } finally {
                        isProcessingRef.current = false;
                    }
                }
            });
            return () => {
                subscription.remove();
                if (Platform.OS === 'ios') {
                    void CameraView.dismissScanner().catch(() => {});
                }
            };
        }
    }, [processAuthUrl]);

    return {
        connectTerminal,
        connectWithUrl,
        isLoading,
        processAuthUrl
    };
}
