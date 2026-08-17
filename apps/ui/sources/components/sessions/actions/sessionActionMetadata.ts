import type * as React from 'react';

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
    SESSION_ACTION_RESUME_ID,
    SESSION_ACTION_STOP_ID,
    SESSION_ACTION_UNARCHIVE_ID,
    SESSION_ACTION_UNPIN_ID,
} from './sessionActionIds';
import { SESSION_BULK_ACTION_IDS } from './sessionBulkActionTypes';
import type { IconName } from '@/components/ui/icons/Icon';

export type SessionActionIconName = IconName;

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
        icon: 'envelope-open',
    },
    [SESSION_ACTION_MARK_UNREAD_ID]: {
        titleKey: 'sessionInfo.markSessionUnread',
        subtitleKey: 'sessionInfo.markSessionUnreadSubtitle',
        icon: 'envelope-simple-open',
    },
    [SESSION_ACTION_RENAME_ID]: {
        titleKey: 'sessionInfo.renameSession',
        subtitleKey: 'sessionInfo.renameSessionSubtitle',
        icon: 'pencil',
    },
    [SESSION_ACTION_RESUME_ID]: {
        titleKey: 'session.workState.goal.resume',
        subtitleKey: 'session.inactiveResumable',
        icon: 'play',
    },
    [SESSION_ACTION_STOP_ID]: {
        titleKey: 'sessionInfo.stopSession',
        subtitleKey: 'sessionInfo.stopSessionSubtitle',
        icon: 'stop-circle',
        destructive: true,
        requiresConfirmation: true,
    },
    [SESSION_ACTION_ARCHIVE_ID]: {
        titleKey: 'sessionInfo.archiveSession',
        subtitleKey: 'sessionInfo.archiveSessionSubtitle',
        icon: 'archive',
        destructive: true,
        requiresConfirmation: true,
    },
    [SESSION_ACTION_UNARCHIVE_ID]: {
        titleKey: 'sessionInfo.unarchiveSession',
        subtitleKey: 'sessionInfo.unarchiveSessionSubtitle',
        icon: 'archive',
    },
    [SESSION_ACTION_DELETE_ID]: {
        titleKey: 'sessionInfo.deleteSession',
        subtitleKey: 'sessionInfo.deleteSessionSubtitle',
        icon: 'trash',
        destructive: true,
        requiresConfirmation: true,
    },
    [SESSION_ACTION_PIN_ID]: {
        titleKey: 'sessionInfo.pinSession',
        icon: 'push-pin',
    },
    [SESSION_ACTION_UNPIN_ID]: {
        titleKey: 'sessionInfo.unpinSession',
        icon: 'push-pin',
    },
    [SESSION_ACTION_EDIT_TAGS_ID]: {
        titleKey: 'sessionTags.editTagsLabel',
        icon: 'tag',
    },
    [SESSION_ACTION_MOVE_TO_FOLDER_ID]: {
        titleKey: 'sessionsList.moveToFolder',
        icon: 'folder',
    },
    [SESSION_BULK_ACTION_IDS.tagsAdd]: {
        titleKey: 'sessionsList.selectionAddTags',
        icon: 'tag',
    },
    [SESSION_BULK_ACTION_IDS.tagsRemove]: {
        titleKey: 'sessionsList.selectionRemoveTags',
        icon: 'tag',
    },
    [SESSION_BULK_ACTION_IDS.tagsSet]: {
        titleKey: 'sessionsList.selectionSetTags',
        icon: 'tag',
    },
};

export function getSessionActionMetadata(actionId: string): SessionActionMetadata | null {
    return METADATA_BY_ACTION_ID[actionId] ?? null;
}
