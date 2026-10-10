import type { DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import type { SessionActionTarget } from '@/components/sessions/actions/sessionActionTypes';
import type { SessionReminderPresetV1 } from '@/sync/domains/session/organization/sessionReminderPreset';
import type { SessionReminderPresentation } from '@/sync/domains/session/organization/attentionStanding';

export const SESSION_ROW_ACTION_SELECT_ID = 'selection.select';
/** Opens the row's Session: the first row of the Bots roster's compact menu. */
export const SESSION_ROW_ACTION_OPEN_ID = 'row.open';
export const SESSION_ROW_ACTION_OPEN_SPLIT_RIGHT_ID = 'openInSplitRight';
export const SESSION_ROW_ACTION_OPEN_SPLIT_DOWN_ID = 'openInSplitDown';
export const SESSION_ROW_ACTION_REVEAL_IN_CURRENT_SPLIT_ID = 'revealInCurrentSplit';

export type SessionRowMoreMenuBuildParams = Readonly<{
    target: SessionActionTarget;
    iconColor: string;
    /** Which menu this row carries: the ordinary list menu, or the Bots roster's compact one. */
    surface?: 'rowMenu' | 'botsRoster';
    leadingItems?: readonly DropdownMenuItem[];
    canMoveToFolder?: boolean;
    reminderPresets?: readonly SessionReminderPresetV1[];
    reminder?: SessionReminderPresentation | null;
    reminderNowMs?: number;
}>;

export type SessionRowActionMenuState = Readonly<{
    tagMenuItems: readonly DropdownMenuItem[];
    handleTagMenuSelect: (tagId: string) => void;
    handleTagMenuCreate: (query: string) => void;
    moreMenuItems: DropdownMenuItem[];
    handleMoreMenuSelect: (itemId: string) => Promise<void>;
    contextMenuItems: DropdownMenuItem[];
    handleContextMenuSelect: (itemId: string) => void;
    mutatingSession: boolean;
}>;
