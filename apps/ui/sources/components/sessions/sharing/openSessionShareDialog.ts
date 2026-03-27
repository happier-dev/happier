import { Modal } from '@/modal';
import { t } from '@/text';

import type { SessionShare, ShareAccessLevel } from '@/sync/domains/social/sharingTypes';

export async function openSessionShareDialog(params: Readonly<{
    sessionId: string;
    shares: SessionShare[];
    canManage: boolean;
    canManagePermissionDelegation: boolean;
    onAddShare: () => void;
    onUpdateShare: (shareId: string, patch: { accessLevel?: ShareAccessLevel; canApprovePermissions?: boolean }) => void;
    onRemoveShare: (shareId: string) => void;
    onManagePublicLink: () => void;
}>): Promise<string> {
    const { SessionShareDialog } = await import('./components/SessionShareDialog');
    return Modal.show({
        component: SessionShareDialog,
        props: {
            sessionId: params.sessionId,
            shares: params.shares,
            canManage: params.canManage,
            canManagePermissionDelegation: params.canManagePermissionDelegation,
            onAddShare: params.onAddShare,
            onUpdateShare: params.onUpdateShare,
            onRemoveShare: params.onRemoveShare,
            onManagePublicLink: params.onManagePublicLink,
        },
        chrome: {
            kind: 'card',
            title: t('session.sharing.title'),
            testID: 'session-share-dialog',
            layout: 'fill',
            dimensions: { width: 560, maxHeightRatio: 0.85, size: 'md' },
        },
        closeOnBackdrop: true,
    });
}
