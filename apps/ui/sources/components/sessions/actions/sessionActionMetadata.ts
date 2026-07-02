import type * as React from 'react';
import type { Ionicons } from '@expo/vector-icons';

import type { TranslationKeyNoParams } from '@/text';

import {
    SESSION_ACTION_ARCHIVE_ID,
    SESSION_ACTION_DELETE_ID,
    SESSION_ACTION_EDIT_TAGS_ID,
    SESSION_ACTION_MARK_READ_ID,
    SESSION_ACTION_MARK_UNREAD_ID,
    SESSION_ACTION_MOVE_TO_FOLDER_ID,
    SESSION_ACTION_PIN_ID,
    SESSION_ACTION_RENAME_ID,
    SESSION_ACTION_STOP_ID,
    SESSION_ACTION_UNARCHIVE_ID,
    SESSION_ACTION_UNPIN_ID,
} from './sessionActionIds';
import { SESSION_BULK_ACTION_IDS } from './sessionBulkActionTypes';

export type SessionActionIconName = React.ComponentProps<typeof Ionicons>['name'];

export type SessionActionMetadata = Readonly<{
    titleKey: TranslationKeyNoParams;
    subtitleKey?: TranslationKeyNoParams;
    icon: SessionActionIconName;
    destructive?: boolean;
    requiresConfirmation?: boolean;
}>;

const METADATA_BY_ACTION_ID: Readonly<Record<string, SessionActionMetadata>> = {
    [SESSION_ACTION_MARK_READ_ID]: {
        titleKey: 'sessionInfo.markSessionRead',
        subtitleKey: 'sessionInfo.markSessionReadSubtitle',
        icon: 'mail-open-outline',
    },
    [SESSION_ACTION_MARK_UNREAD_ID]: {
        titleKey: 'sessionInfo.markSessionUnread',
        subtitleKey: 'sessionInfo.markSessionUnreadSubtitle',
        icon: 'mail-unread-outline',
    },
    [SESSION_ACTION_RENAME_ID]: {
        titleKey: 'sessionInfo.renameSession',
        subtitleKey: 'sessionInfo.renameSessionSubtitle',
        icon: 'pencil-outline',
    },
    [SESSION_ACTION_STOP_ID]: {
        titleKey: 'sessionInfo.stopSession',
        subtitleKey: 'sessionInfo.stopSessionSubtitle',
        icon: 'stop-circle-outline',
        destructive: true,
        requiresConfirmation: true,
    },
    [SESSION_ACTION_ARCHIVE_ID]: {
        titleKey: 'sessionInfo.archiveSession',
        subtitleKey: 'sessionInfo.archiveSessionSubtitle',
        icon: 'archive-outline',
        destructive: true,
        requiresConfirmation: true,
    },
    [SESSION_ACTION_UNARCHIVE_ID]: {
        titleKey: 'sessionInfo.unarchiveSession',
        subtitleKey: 'sessionInfo.unarchiveSessionSubtitle',
        icon: 'archive-outline',
    },
    [SESSION_ACTION_DELETE_ID]: {
        titleKey: 'sessionInfo.deleteSession',
        subtitleKey: 'sessionInfo.deleteSessionSubtitle',
        icon: 'trash-outline',
        destructive: true,
        requiresConfirmation: true,
    },
    [SESSION_ACTION_PIN_ID]: {
        titleKey: 'sessionInfo.pinSession',
        icon: 'pin-outline',
    },
    [SESSION_ACTION_UNPIN_ID]: {
        titleKey: 'sessionInfo.unpinSession',
        icon: 'pin-outline',
    },
    [SESSION_ACTION_EDIT_TAGS_ID]: {
        titleKey: 'sessionTags.editTagsLabel',
        icon: 'pricetag-outline',
    },
    [SESSION_ACTION_MOVE_TO_FOLDER_ID]: {
        titleKey: 'sessionsList.moveToFolder',
        icon: 'folder-outline',
    },
    [SESSION_BULK_ACTION_IDS.tagsAdd]: {
        titleKey: 'sessionsList.selectionAddTags',
        icon: 'pricetag-outline',
    },
    [SESSION_BULK_ACTION_IDS.tagsRemove]: {
        titleKey: 'sessionsList.selectionRemoveTags',
        icon: 'pricetag-outline',
    },
    [SESSION_BULK_ACTION_IDS.tagsSet]: {
        titleKey: 'sessionsList.selectionSetTags',
        icon: 'pricetags-outline',
    },
};

export function getSessionActionMetadata(actionId: string): SessionActionMetadata | null {
    return METADATA_BY_ACTION_ID[actionId] ?? null;
}
