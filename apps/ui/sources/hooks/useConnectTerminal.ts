import * as React from 'react';
import { Platform } from 'react-native';
import { CameraView } from 'expo-camera';
import * as Updates from 'expo-updates';
import { router } from 'expo-router';
import { useAuth } from '@/auth/AuthContext';
import { decodeBase64 } from '@/encryption/base64';
import { encryptBox } from '@/encryption/libsodium';
import { authApprove } from '@/auth/authApprove';
import { useCheckScannerPermissions } from '@/hooks/useCheckCameraPermissions';
import { Modal } from '@/modal';
import { t } from '@/text';
import { sync } from '@/sync/sync';
import { getServerUrl, setServerUrl } from '@/sync/serverConfig';
import { clearPendingTerminalConnect, setPendingTerminalConnect } from '@/sync/pendingTerminalConnect';
import { parseTerminalConnectUrl } from '@/utils/terminalConnectUrl';

interface UseConnectTerminalOptions {
    onSuccess?: () => void;
    onError?: (error: any) => void;
}

export function useConnectTerminal(options?: UseConnectTerminalOptions) {
    const auth = useAuth();
    const [isLoading, setIsLoading] = React.useState(false);
    const checkScannerPermissions = useCheckScannerPermissions();

    const processAuthUrl = React.useCallback(async (url: string) => {
        const parsed = parseTerminalConnectUrl(url);
        if (!parsed) {
            Modal.alert(t('common.error'), t('modals.invalidAuthUrl'), [{ text: t('common.ok') }]);
            return false;
        }
        
        setIsLoading(true);
        try {
            if (parsed.serverUrl) {
                const currentServerUrl = getServerUrl();
                if (currentServerUrl !== parsed.serverUrl) {
                    const confirmed = await Modal.confirm(
                        t('server.changeServer'),
                        t('terminal.switchServerToConnectTerminal', { serverUrl: parsed.serverUrl }),
                        { confirmText: t('common.continue'), destructive: true }
                    );
                    if (!confirmed) return false;

                    setPendingTerminalConnect({ publicKeyB64Url: parsed.publicKeyB64Url, serverUrl: parsed.serverUrl });
                    setServerUrl(parsed.serverUrl);

                    if (Platform.OS === 'web') {
                        window.location.reload();
                    } else {
                        try {
                            await Updates.reloadAsync();
                        } catch {
                            // In dev mode, reloadAsync can throw ERR_UPDATES_DISABLED.
                        }
                    }
                    return true;
                }
            }

            if (!auth.credentials) {
                setPendingTerminalConnect({
                    publicKeyB64Url: parsed.publicKeyB64Url,
                    serverUrl: parsed.serverUrl ?? getServerUrl(),
                });
                await Modal.alert(t('terminal.connectTerminal'), t('modals.pleaseSignInFirst'), [
                    { text: t('common.continue') },
                ]);
                router.replace('/');
                return false;
            }

            const publicKey = decodeBase64(parsed.publicKeyB64Url, 'base64url');
            const responseV1 = encryptBox(decodeBase64(auth.credentials!.secret, 'base64url'), publicKey);
            let responseV2Bundle = new Uint8Array(sync.encryption.contentDataKey.length + 1);
            responseV2Bundle[0] = 0;
            responseV2Bundle.set(sync.encryption.contentDataKey, 1);
            const responseV2 = encryptBox(responseV2Bundle, publicKey);
            await authApprove(auth.credentials!.token, publicKey, responseV1, responseV2);

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
                    // Dismiss scanner on Android is called automatically when barcode is scanned
                    if (Platform.OS === 'ios') {
                        await CameraView.dismissScanner();
                    }
                    await processAuthUrl(event.data);
                }
            });
            return () => {
                subscription.remove();
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
