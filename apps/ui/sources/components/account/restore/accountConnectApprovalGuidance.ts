import { Modal } from '@/modal';
import { t } from '@/text';

export type AccountConnectApprovalGuidanceAction = 'dismiss' | 'showQr';

export async function promptAccountConnectApprovalRequired(): Promise<AccountConnectApprovalGuidanceAction> {
    let action: AccountConnectApprovalGuidanceAction = 'dismiss';
    await Modal.alertAsync(
        t('connect.restoreAccount'),
        t('connect.restoreQrInstructions'),
        [
            { text: t('common.cancel'), style: 'cancel' },
            {
                text: t('connect.showQrInstead'),
                onPress: () => {
                    action = 'showQr';
                },
            },
        ],
    );
    return action;
}
