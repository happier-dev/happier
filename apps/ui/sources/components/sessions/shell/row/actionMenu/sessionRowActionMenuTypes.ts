import type { DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import type { SessionActionTarget } from '@/components/sessions/actions/sessionActionTypes';
import type { SessionReminderPresetV1 } from '@/sync/domains/session/organization/sessionReminderPreset';
import type { SessionReminderPresentation } from '@/sync/domains/session/organization/attentionStanding';
import type { SessionSpaceMembershipMenu } from '@/components/sessions/organization/sessionSpaceMembershipMenu';

export const SESSION_ROW_ACTION_SELECT_ID = 'selection.select';
/** Opens the row's Session: the first row of the Bots roster's compact menu. */
export const SESSION_ROW_ACTION_OPEN_ID = 'row.open';

export type SessionRowMoreMenuBuildParams = Readonly<{
    archivePending?: boolean;
    target: SessionActionTarget;
    iconColor: string;
    /** Which menu this row carries: the ordinary list menu, or the Bots roster's compact one. */
    surface?: 'rowMenu' | 'botsRoster';
    leadingItems?: readonly DropdownMenuItem[];
    canMoveToFolder?: boolean;
    /** Move to section's submenu choices (lab `clsections:menu`); absent, the item opens the move sheet. */
    sectionMoveItems?: readonly DropdownMenuItem[] | null;
    /** Captured by the list's opted-in domain owner when the row menu opens. */
    spaceMembershipMenu?: SessionSpaceMembershipMenu | null;
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
