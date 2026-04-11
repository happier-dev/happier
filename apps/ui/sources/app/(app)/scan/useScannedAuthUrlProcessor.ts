import * as React from 'react';

import { parseAccountConnectDeepLink } from '@/auth/pairing/accountConnectUrl';
import { useConnectAccount } from '@/hooks/auth/useConnectAccount';
import { useConnectTerminal } from '@/hooks/session/useConnectTerminal';
import { Modal } from '@/modal';
import { t } from '@/text';
import { parseTerminalConnectUrl } from '@/utils/path/terminalConnectUrl';

type UseScannedAuthUrlProcessorOptions = Readonly<{
    allowedUrlKind: 'account' | 'terminal';
    onSuccess?: () => void;
    onError?: (error: unknown) => void;
}>;

export function useScannedAuthUrlProcessor(options?: UseScannedAuthUrlProcessorOptions) {
    const accountConnect = useConnectAccount(options);
    const terminalConnect = useConnectTerminal(options);

    const processAuthUrl = React.useCallback(async (rawUrl: string) => {
        const url = String(rawUrl ?? '').trim();
        if (!url) return false;

        try {
            if (parseTerminalConnectUrl(url)) {
                if (options?.allowedUrlKind !== 'terminal') {
                    await Modal.alertAsync(t('common.error'), t('modals.invalidAuthUrl'), [{ text: t('common.ok') }]);
                    return false;
                }
                return await terminalConnect.processAuthUrl(url);
            }

            if (parseAccountConnectDeepLink(url)) {
                if (options?.allowedUrlKind !== 'account') {
                    await Modal.alertAsync(t('common.error'), t('modals.invalidAuthUrl'), [{ text: t('common.ok') }]);
                    return false;
                }
                return await accountConnect.processAuthUrl(url);
            }

            await Modal.alertAsync(t('common.error'), t('modals.invalidAuthUrl'), [{ text: t('common.ok') }]);
            return false;
        } catch (error) {
            options?.onError?.(error);
            throw error;
        }
    }, [accountConnect, options, terminalConnect]);

    return {
        processAuthUrl,
        isLoading: accountConnect.isLoading || terminalConnect.isLoading,
    };
}
