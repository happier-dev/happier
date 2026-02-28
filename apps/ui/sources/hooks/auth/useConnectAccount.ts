import * as React from 'react';
import { Platform, useWindowDimensions } from 'react-native';
import { router } from 'expo-router';
import { useAuth } from '@/auth/context/AuthContext';
import { decodeBase64 } from '@/encryption/base64';
import { authAccountApprove } from '@/auth/flows/accountApprove';
import { buildAccountLinkResponse } from '@/auth/flows/buildAccountLinkResponse';
import { Modal } from '@/modal';
import { t } from '@/text';
import { parseAccountConnectDeepLink } from '@/auth/pairing/accountConnectUrl';
import { isRunningOnMac } from '@/utils/platform/platform';
import { isWebMobileLikeQrScannerHost } from '@/utils/platform/webMobileHeuristics';

interface UseConnectAccountOptions {
    onSuccess?: () => void;
    onError?: (error: any) => void;
}

export function useConnectAccount(options?: UseConnectAccountOptions) {
    const auth = useAuth();
    const { width, height } = useWindowDimensions();
    const [isLoading, setIsLoading] = React.useState(false);

    const processAuthUrl = React.useCallback(async (url: string) => {
        const parsed = parseAccountConnectDeepLink(url);
        if (!parsed) {
            await Modal.alertAsync(t('common.error'), t('modals.invalidAuthUrl'), [{ text: t('common.ok') }]);
            return false;
        }
        
        setIsLoading(true);
        try {
            const publicKey = decodeBase64(parsed.publicKeyB64Url, 'base64url');
            const creds = auth.credentials!;
            const response = buildAccountLinkResponse(creds, publicKey);
            await authAccountApprove(creds.token, publicKey, response);
            
            await Modal.alertAsync(t('common.success'), t('modals.deviceLinkedSuccessfully'), [
                { 
                    text: t('common.ok'), 
                    onPress: () => options?.onSuccess?.()
                }
            ]);
            return true;
        } catch (e) {
            await Modal.alertAsync(t('common.error'), t('modals.failedToLinkDevice'), [{ text: t('common.ok') }]);
            options?.onError?.(e);
            return false;
        } finally {
            setIsLoading(false);
        }
    }, [auth.credentials, options]);

    const connectAccount = React.useCallback(async () => {
        const isPhoneSizedWeb = Platform.OS === 'web' && isWebMobileLikeQrScannerHost({ width, height });
        const canUseScanner = !isRunningOnMac() && (Platform.OS !== 'web' || isPhoneSizedWeb);
        if (!canUseScanner) {
            await Modal.alertAsync(t('common.error'), t('modals.qrScannerUnavailable'), [{ text: t('common.ok') }]);
            return;
        }
        router.push('/scan/account');
    }, [height, width]);

    const connectWithUrl = React.useCallback(async (url: string) => {
        return await processAuthUrl(url);
    }, [processAuthUrl]);

    return {
        connectAccount,
        connectWithUrl,
        isLoading,
        processAuthUrl
    };
}
