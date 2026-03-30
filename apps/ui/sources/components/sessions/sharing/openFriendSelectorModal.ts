import { Modal } from '@/modal';
import { t } from '@/text';

import type { ShareAccessLevel } from '@/sync/domains/social/sharingTypes';
import type { UserProfile } from '@/sync/domains/social/friendTypes';

export async function openFriendSelectorModal(params: Readonly<{
    friends: UserProfile[];
    excludedUserIds: string[];
    canManagePermissionDelegation?: boolean;
    onSelect: (userId: string, accessLevel: ShareAccessLevel, canApprovePermissions?: boolean) => Promise<void> | void;
}>): Promise<string> {
    const { FriendSelector } = await import('./components/FriendSelector');
    return Modal.show({
        component: FriendSelector,
        props: {
            friends: params.friends,
            excludedUserIds: params.excludedUserIds,
            onSelect: params.onSelect,
            canManagePermissionDelegation: params.canManagePermissionDelegation ?? false,
        },
        chrome: {
            kind: 'card',
            title: t('session.sharing.addShare'),
            testID: 'friend-selector-modal',
            layout: 'fill',
            dimensions: { width: 560, maxHeightRatio: 0.85, size: 'md' },
        },
        closeOnBackdrop: true,
    });
}
