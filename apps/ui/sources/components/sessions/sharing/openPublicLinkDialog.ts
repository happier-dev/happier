import { Modal } from '@/modal';
import { t } from '@/text';

import type { PublicSessionShare } from '@/sync/domains/social/sharingTypes';
import type { CustomModalInjectedProps } from '@/modal';
import type { PublicLinkDialogProps } from './components/PublicLinkDialog';

export async function openPublicLinkDialog(params: Readonly<{
    publicShare: PublicSessionShare | null;
    onCreate: (options: {
        expiresInDays?: number;
        maxUses?: number;
        isConsentRequired: boolean;
    }) => Promise<PublicSessionShare | void> | PublicSessionShare | void;
    onDelete: () => Promise<void> | void;
}>): Promise<string> {
    const { PublicLinkDialog } = await import('./components/PublicLinkDialog');
    const modalId = Modal.show({
        component: PublicLinkDialog,
        props: {
            publicShare: params.publicShare,
            onCreate: async (options) => {
                const createdShare = await Promise.resolve(params.onCreate(options));
                if (createdShare) {
                    Modal.update<PublicLinkDialogProps & CustomModalInjectedProps>(modalId, {
                        publicShare: createdShare,
                    });
                }
            },
            onDelete: params.onDelete,
        },
        chrome: {
            kind: 'card',
            title: t('session.sharing.publicLink'),
            testID: 'public-link-dialog',
            dimensions: { width: 560, maxHeightRatio: 0.85, size: 'md' },
        },
        closeOnBackdrop: true,
    });
    return modalId;
}
