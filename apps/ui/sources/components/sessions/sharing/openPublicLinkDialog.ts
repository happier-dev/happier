import { Modal } from '@/modal';
import { t } from '@/text';

import type { PublicSessionShare } from '@/sync/domains/social/sharingTypes';

export async function openPublicLinkDialog(params: Readonly<{
    publicShare: PublicSessionShare | null;
    onCreate: (options: {
        expiresInDays?: number;
        maxUses?: number;
        isConsentRequired: boolean;
    }) => Promise<void> | void;
    onDelete: () => Promise<void> | void;
}>): Promise<string> {
    const { PublicLinkDialog } = await import('./components/PublicLinkDialog');
    return Modal.show({
        component: PublicLinkDialog,
        props: {
            publicShare: params.publicShare,
            onCreate: params.onCreate,
            onDelete: params.onDelete,
        },
        chrome: {
            kind: 'card',
            title: t('session.sharing.publicLink'),
            testID: 'public-link-dialog',
            layout: 'fill',
            dimensions: { width: 560, maxHeightRatio: 0.85, size: 'md' },
        },
        closeOnBackdrop: true,
    });
}
