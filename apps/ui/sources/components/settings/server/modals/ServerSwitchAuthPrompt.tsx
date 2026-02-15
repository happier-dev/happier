import { Modal } from '@/modal';
import { t } from '@/text';

export async function promptSignedOutServerSwitchConfirmation(): Promise<boolean> {
    return await Modal.confirm(
        'You are not connected',
        'Switch to this server and continue to the home screen so you can sign in or create an account?',
        {
            confirmText: 'Continue',
            cancelText: t('common.cancel'),
        },
    );
}
