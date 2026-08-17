import type * as React from 'react';

import { t } from '@/text';

import { getSessionActionMetadata } from './sessionActionMetadata';
import type { IconName } from '@/components/ui/icons/Icon';
import {
    SESSION_BULK_ACTION_IDS,
    type SessionBulkActionId,
    type SessionBulkActionTarget,
} from './sessionBulkActionTypes';

type BulkActionIconName = IconName;

export type SessionBulkActionDescriptor = Readonly<{
    id: SessionBulkActionId;
    title: string;
    icon: BulkActionIconName;
    requiresConfirmation?: boolean;
    destructive?: boolean;
}>;

function createBulkDescriptor(actionId: SessionBulkActionId): SessionBulkActionDescriptor {
    const metadata = getSessionActionMetadata(actionId);
    if (!metadata) {
        throw new Error(`Missing session action metadata for ${actionId}`);
    }
    return {
        id: actionId,
        title: t(metadata.titleKey),
        icon: metadata.icon,
        requiresConfirmation: metadata.requiresConfirmation,
        destructive: metadata.destructive,
    };
}

export function listSessionBulkActionDescriptors(params: Readonly<{
    targets: readonly SessionBulkActionTarget[];
    tagsEnabled: boolean;
    moveEnabled: boolean;
}>): SessionBulkActionDescriptor[] {
    const targets = params.targets;
    if (targets.length === 0) return [];
    const hasStoppable = targets.some((target) => target.active === true && target.canStop === true);
    const hasArchivable = targets.some((target) => target.archived !== true && target.canArchive === true);
    const hasUnarchivable = targets.some((target) => target.archived === true && target.hasAdminAccess === true);
    const hasPinned = targets.some((target) => target.pinned === true);
    const hasUnpinned = targets.some((target) => target.pinned !== true);
    const hasTags = targets.some((target) => (target.tags?.length ?? 0) > 0);
    const hasUnread = targets.some((target) => target.readState === 'unread');
    const hasRead = targets.some((target) => target.readState === 'read');
    const descriptors: SessionBulkActionDescriptor[] = [];

    if (hasStoppable) {
        descriptors.push(createBulkDescriptor(SESSION_BULK_ACTION_IDS.stop));
    }
    if (hasArchivable) {
        descriptors.push(createBulkDescriptor(SESSION_BULK_ACTION_IDS.archive));
    }
    if (hasUnarchivable) {
        descriptors.push(createBulkDescriptor(SESSION_BULK_ACTION_IDS.unarchive));
    }
    if (hasUnread) {
        descriptors.push(createBulkDescriptor(SESSION_BULK_ACTION_IDS.markRead));
    }
    if (hasRead) {
        descriptors.push(createBulkDescriptor(SESSION_BULK_ACTION_IDS.markUnread));
    }
    if (hasUnpinned) {
        descriptors.push(createBulkDescriptor(SESSION_BULK_ACTION_IDS.pin));
    }
    if (hasPinned) {
        descriptors.push(createBulkDescriptor(SESSION_BULK_ACTION_IDS.unpin));
    }
    if (params.tagsEnabled) {
        descriptors.push(createBulkDescriptor(SESSION_BULK_ACTION_IDS.tagsAdd));
        if (hasTags) {
            descriptors.push(createBulkDescriptor(SESSION_BULK_ACTION_IDS.tagsRemove));
        }
        descriptors.push(createBulkDescriptor(SESSION_BULK_ACTION_IDS.tagsSet));
    }
    if (params.moveEnabled && targets.some((target) => target.canMoveToFolder === true)) {
        descriptors.push(createBulkDescriptor(SESSION_BULK_ACTION_IDS.moveToFolder));
    }

    return descriptors;
}
