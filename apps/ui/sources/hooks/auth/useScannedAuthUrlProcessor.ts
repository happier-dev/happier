import * as React from 'react';
import { useRouter } from 'expo-router';

import { classifyPairingLink } from '@/auth/pairing/classifyPairingLink';
import { buildExpiredHomeQrRestoreRoutePath, buildHomeQrInviteRestoreRoutePath } from '@/auth/pairing/pairingUrl';
import type { HomeQrEntryIntent } from '@/auth/pairing/homeQrEntryIntent';
import { promptLegacyPairingUpdateRequired } from '@/auth/pairing/legacyPairingUpdateRequired';
import { promptAccountConnectApprovalRequired } from '@/components/account/restore/accountConnectApprovalGuidance';
import { useConnectTerminal } from '@/hooks/session/useConnectTerminal';
import { Modal } from '@/modal';
import { t } from '@/text';

type UseScannedAuthUrlProcessorCallbacks = Readonly<{
    onError?: (error: unknown) => void;
    onScanNewQr?: () => void;
}>;

type UseScannedAuthUrlProcessorOptions = UseScannedAuthUrlProcessorCallbacks & (
    | Readonly<{
        allowedUrlKind: 'account';
        homeQrEntryIntent: HomeQrEntryIntent;
        /** Offered from the account-connect guidance only when provided. */
        onShowQrInstead?: () => void;
    }>
    | Readonly<{
        allowedUrlKind: 'terminal';
        homeQrEntryIntent?: never;
        onShowQrInstead?: never;
        navigateToApproval?: NonNullable<Parameters<typeof useConnectTerminal>[0]>['navigateToApproval'];
        onApprovalOpened?: () => void;
    }>
);

export function useScannedAuthUrlProcessor(options: UseScannedAuthUrlProcessorOptions) {
    const router = useRouter();
    const terminalConnect = useConnectTerminal(options);

    const processAuthUrl = React.useCallback(async (rawUrl: string) => {
        const url = String(rawUrl ?? '').trim();
        if (!url) return false;

        const rejectAsInvalid = async () => {
            await Modal.alertAsync(t('common.error'), t('modals.invalidAuthUrl'), [{ text: t('common.ok') }]);
            return false;
        };

        try {
            // Classification is owned by classifyPairingLink; this surface owns only
            // which kinds it admits (`allowedUrlKind`) and where each one goes.
            const link = classifyPairingLink(url);
            switch (link.kind) {
                case 'home_qr_invite': {
                    if (options.allowedUrlKind !== 'account') return await rejectAsInvalid();
                    const restorePath = buildHomeQrInviteRestoreRoutePath(link.rawLink, options.homeQrEntryIntent);
                    if (!restorePath) return await rejectAsInvalid();
                    router.push(restorePath);
                    return true;
                }
                case 'expired_home_qr_invite':
                    if (options.allowedUrlKind !== 'account') return await rejectAsInvalid();
                    router.push(buildExpiredHomeQrRestoreRoutePath(options.homeQrEntryIntent));
                    return true;
                case 'terminal_connect':
                    if (options.allowedUrlKind !== 'terminal') return await rejectAsInvalid();
                    return await terminalConnect.openApproval(link.terminal);
                case 'account_connect': {
                    if (options.allowedUrlKind !== 'account') return await rejectAsInvalid();
                    const onShowQrInstead = options.onShowQrInstead;
                    const action = await promptAccountConnectApprovalRequired({ showQr: Boolean(onShowQrInstead) });
                    if (action !== 'showQr' || !onShowQrInstead) return false;
                    onShowQrInstead();
                    return true;
                }
                case 'team_join':
                case 'source_setup':
                    // A Team join link joins a Home through its Team; the join screen owns the rest.
                    if (options.allowedUrlKind !== 'account') return await rejectAsInvalid();
                    router.push(link.path);
                    return true;
                case 'legacy_pairing':
                    if (await promptLegacyPairingUpdateRequired() === 'scan_new_qr') options.onScanNewQr?.();
                    return true;
                case 'unknown':
                    return await rejectAsInvalid();
            }
        } catch (error) {
            options.onError?.(error);
            throw error;
        }
    }, [options, router, terminalConnect]);

    return {
        processAuthUrl,
        isLoading: terminalConnect.isLoading,
    };
}
