import type { ClassifiedPairingLink } from '@/auth/pairing/classifyPairingLink';
import { buildExpiredHomeQrRestoreRoutePath, buildHomeQrInviteRestoreRoutePath } from '@/auth/pairing/pairingUrl';
import { Modal } from '@/modal';
import { t } from '@/text';
import type { ConnectHomeAtAddressResult, HomeAddressChangeConfirmation } from '@/sync/ops/home/connectHomeAtAddress';

/** The destinations accepted by the add-Home form's link entry points. */
export function resolveHomeConnectLink(link: ClassifiedPairingLink): string | null | undefined {
    switch (link.kind) {
        case 'home_qr_invite':
            return buildHomeQrInviteRestoreRoutePath(link.rawLink, 'add_home');
        case 'expired_home_qr_invite':
            return buildExpiredHomeQrRestoreRoutePath('add_home');
        case 'team_join':
        case 'source_setup':
            return link.path;
        case 'unknown':
            // The caller can try it as an address.
            return undefined;
        default:
            // A recognized link outside the add-Home flow.
            return null;
    }
}

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
            t('errors.homeAddressMismatchBody', { reached: addressChange.nextUrl, claimed: addressChange.previousUrl }),
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
