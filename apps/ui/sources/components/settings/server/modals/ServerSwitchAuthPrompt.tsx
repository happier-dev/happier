import { Modal } from '@/modal';
import { t } from '@/text';

export async function promptSignedOutServerSwitchConfirmation(): Promise<boolean> {
    return await Modal.confirm(
        t('server.signedOutSwitchConfirmTitle'),
        t('server.signedOutSwitchConfirmBody'),
        {
            confirmText: t('common.continue'),
            cancelText: t('common.cancel'),
        },
    );
}
