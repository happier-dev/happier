import type * as React from 'react';

import { t, type TranslationKeyNoParams } from '@/text';
import { getSessionName } from '@/utils/sessions/sessionUtils';
import type { SessionActionTarget } from './sessionActionTypes';

import {
    SESSION_ACTION_MAKE_BOT_ID,
    SESSION_ACTION_MAKE_REGULAR_ID,
    SESSION_ACTION_RAIL_PIN_ID,
    SESSION_ACTION_RAIL_UNPIN_ID,
    SESSION_ACTION_WORK_OPEN_ID,
    SESSION_ACTION_TALK_ID,
    SESSION_ACTION_TOOL_CALLS_TOGGLE_ID,
    SESSION_ACTION_TOOL_CALLS_USE_DEFAULT_ID,
    SESSION_ACTION_ARCHIVE_ID,
    SESSION_ACTION_CLEAR_ATTENTION_STANDING_ID,
    SESSION_ACTION_DELETE_ID,
    SESSION_ACTION_EDIT_TAGS_ID,
    SESSION_ACTION_FOLLOW_ID,
    SESSION_ACTION_MAKE_ORCHESTRATOR_ID,
    SESSION_ACTION_MARK_READ_ID,
    SESSION_ACTION_MARK_UNREAD_ID,
    SESSION_ACTION_MOVE_TO_FOLDER_ID,
    SESSION_ACTION_PIN_ID,
    SESSION_ACTION_PUT_UNDER_ID,
    SESSION_ACTION_RENAME_ID,
    SESSION_ACTION_RESUME_ID,
    SESSION_ACTION_SET_ATTENTION_STANDING_ID,
    SESSION_ACTION_STOP_ID,
    SESSION_ACTION_UNARCHIVE_ID,
    SESSION_ACTION_UNPIN_ID,
} from './sessionActionIds';
import { SESSION_BULK_ACTION_IDS } from './sessionBulkActionTypes';
import type { IconName } from '@/components/ui/icons/Icon';
import type { SessionHeaderMenuGroup } from './sessionHeaderMenuGroups';

export type SessionActionIconName = IconName;

export type SessionActionMetadata = Readonly<{
    titleKey: TranslationKeyNoParams | 'bots.talk';
    subtitleKey?: TranslationKeyNoParams;
    icon: SessionActionIconName;
    /** Where the operation sits in the session's ⋯ menu. */
    group: SessionHeaderMenuGroup;
    destructive?: boolean;
    requiresConfirmation?: boolean;
}>;

const METADATA_BY_ACTION_ID: Readonly<Record<string, SessionActionMetadata>> = {
    [SESSION_ACTION_WORK_OPEN_ID]: { titleKey: 'bots.instructionsAndVoice', icon: 'file-text', group: 'open' },
    [SESSION_ACTION_TALK_ID]: { titleKey: 'bots.talk', icon: 'microphone', group: 'session' },
    [SESSION_ACTION_RAIL_PIN_ID]: { titleKey: 'bots.pin', icon: 'push-pin', group: 'session' },
    [SESSION_ACTION_RAIL_UNPIN_ID]: { titleKey: 'bots.unpin', icon: 'push-pin', group: 'session' },
    [SESSION_ACTION_MAKE_BOT_ID]: { titleKey: 'bots.promote', subtitleKey: 'bots.menu.promoteSubtitle', icon: 'robot', group: 'behavior' },
    [SESSION_ACTION_MAKE_REGULAR_ID]: { titleKey: 'bots.demote', subtitleKey: 'bots.menu.demoteSubtitle', icon: 'robot', group: 'behavior' },
    [SESSION_ACTION_TOOL_CALLS_TOGGLE_ID]: { titleKey: 'session.toolCallActions.show', subtitleKey: 'bots.menu.toolsSubtitle', icon: 'list-bullets', group: 'behavior' },
    [SESSION_ACTION_TOOL_CALLS_USE_DEFAULT_ID]: { titleKey: 'session.toolCallActions.useDefault', icon: 'arrows-clockwise', group: 'behavior' },
    [SESSION_ACTION_FOLLOW_ID]: {
        titleKey: 'session.follow.editor.title',
        icon: 'bell', group: 'session',
    },
    [SESSION_ACTION_MARK_READ_ID]: {
        titleKey: 'sessionInfo.markSessionRead',
        subtitleKey: 'sessionInfo.markSessionReadSubtitle',
        icon: 'envelope-open', group: 'session',
    },
    [SESSION_ACTION_MARK_UNREAD_ID]: {
        titleKey: 'sessionInfo.markSessionUnread',
        subtitleKey: 'sessionInfo.markSessionUnreadSubtitle',
        icon: 'envelope-simple-open', group: 'session',
    },
    [SESSION_ACTION_MAKE_ORCHESTRATOR_ID]: {
        titleKey: 'sessionWork.actions.makeOrchestrator',
        subtitleKey: 'sessionWork.actions.makeOrchestratorSubtitle',
        icon: 'tree-structure', group: 'work',
    },
    [SESSION_ACTION_PUT_UNDER_ID]: {
        titleKey: 'sessionWork.putUnder.title',
        subtitleKey: 'sessionWork.putUnder.subtitle',
        icon: 'tree-structure', group: 'work',
    },
    [SESSION_ACTION_RENAME_ID]: {
        titleKey: 'sessionInfo.renameSession',
        subtitleKey: 'sessionInfo.renameSessionSubtitle',
        icon: 'pencil', group: 'session',
    },
    [SESSION_ACTION_RESUME_ID]: {
        titleKey: 'session.workState.goal.resume',
        subtitleKey: 'session.inactiveResumable',
        icon: 'play', group: 'work',
    },
    [SESSION_ACTION_STOP_ID]: {
        titleKey: 'sessionInfo.stopSession',
        subtitleKey: 'sessionInfo.stopSessionSubtitle',
        icon: 'stop-circle', group: 'finish',
        destructive: true,
        requiresConfirmation: true,
    },
    [SESSION_ACTION_ARCHIVE_ID]: {
        titleKey: 'sessionInfo.archiveSession',
        subtitleKey: 'sessionInfo.archiveSessionSubtitle',
        icon: 'archive', group: 'finish',
        destructive: true,
        requiresConfirmation: true,
    },
    [SESSION_ACTION_UNARCHIVE_ID]: {
        titleKey: 'sessionInfo.unarchiveSession',
        subtitleKey: 'sessionInfo.unarchiveSessionSubtitle',
        icon: 'archive', group: 'session',
    },
    [SESSION_ACTION_DELETE_ID]: {
        titleKey: 'sessionInfo.deleteSession',
        subtitleKey: 'sessionInfo.deleteSessionSubtitle',
        icon: 'trash', group: 'finish',
        destructive: true,
        requiresConfirmation: true,
    },
    [SESSION_ACTION_PIN_ID]: {
        titleKey: 'sessionInfo.pinSession',
        icon: 'push-pin', group: 'session',
    },
    [SESSION_ACTION_UNPIN_ID]: {
        titleKey: 'sessionInfo.unpinSession',
        icon: 'push-pin', group: 'session',
    },
    [SESSION_ACTION_EDIT_TAGS_ID]: {
        titleKey: 'sessionTags.editTagsLabel',
        icon: 'tag', group: 'session',
    },
    [SESSION_ACTION_MOVE_TO_FOLDER_ID]: {
        titleKey: 'sessionsList.moveToFolder',
        icon: 'folder', group: 'session',
    },
    [SESSION_ACTION_SET_ATTENTION_STANDING_ID]: {
        titleKey: 'sessionInfo.keepInAttention',
        subtitleKey: 'sessionInfo.keepInAttentionSubtitle',
        icon: 'bell', group: 'session',
    },
    [SESSION_ACTION_CLEAR_ATTENTION_STANDING_ID]: {
        titleKey: 'sessionInfo.removeFromAttention',
        subtitleKey: 'sessionInfo.removeFromAttentionSubtitle',
        icon: 'bell-slash', group: 'session',
    },
    [SESSION_BULK_ACTION_IDS.tagsAdd]: {
        titleKey: 'sessionsList.selectionAddTags',
        icon: 'tag', group: 'session',
    },
    [SESSION_BULK_ACTION_IDS.tagsRemove]: {
        titleKey: 'sessionsList.selectionRemoveTags',
        icon: 'tag', group: 'session',
    },
    [SESSION_BULK_ACTION_IDS.tagsSet]: {
        titleKey: 'sessionsList.selectionSetTags',
        icon: 'tag', group: 'session',
    },
};

export function getSessionActionMetadata(actionId: string): SessionActionMetadata | null {
    return METADATA_BY_ACTION_ID[actionId] ?? null;
}

export function resolveSessionActionTitle(metadata: SessionActionMetadata, target?: SessionActionTarget): string {
    return metadata.titleKey === 'bots.talk'
        ? t('bots.talk', { name: target ? getSessionName(target.session, target.serverId) : t('session.folderless.untitledChat') })
        : t(metadata.titleKey);
}
