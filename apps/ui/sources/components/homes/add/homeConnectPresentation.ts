import { Modal } from '@/modal';
import { t } from '@/text';
import type { ConnectHomeAtAddressResult, HomeAddressChangeConfirmation } from '@/sync/ops/home/connectHomeAtAddress';

export async function confirmInsecureHomeHttp(): Promise<boolean> {
    return Boolean(await Modal.confirm(
        t('server.insecureHttpUrlTitle'),
        t('server.insecureHttpUrlBody'),
        { confirmText: t('common.ok'), cancelText: t('common.cancel') },
    ));
}

export async function confirmCanonicalHomeUrl(addressChange?: HomeAddressChangeConfirmation): Promise<boolean> {
    if (addressChange) {
        return Boolean(await Modal.confirm(
            t('errors.homeAddressMismatchTitle'),
            t('errors.homeAddressMismatchBody', { reached: addressChange.previousUrl, claimed: addressChange.nextUrl }),
            { confirmText: t('common.continue'), cancelText: t('common.cancel') },
        ));
    }
    return Boolean(await Modal.confirm(
        t('server.useCanonicalServerUrlTitle'),
        t('server.useCanonicalServerUrlBody'),
        { confirmText: t('common.use'), cancelText: t('common.keep') },
    ));
}

export function homeConnectFailureMessage(result: ConnectHomeAtAddressResult): string | null {
    switch (result.kind) {
        case 'connected':
        case 'declined':
            return null;
        case 'invalid_address':
            return t('errors.invalidFormat');
        case 'mixed_content':
            return t('homeAdd.mixedContent');
        case 'identity_mismatch':
            return t('errors.homeIdentityMismatch', { home: result.home });
        case 'unreachable':
            return t('homesJourneys.homeUnreachable');
        default:
            return t('errors.operationFailed');
    }
}
