import type { DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import type { SessionActionTarget } from '@/components/sessions/actions/sessionActionTypes';

export const SESSION_ROW_ACTION_SELECT_ID = 'selection.select';
export const SESSION_ROW_ACTION_OPEN_SPLIT_RIGHT_ID = 'openInSplitRight';
export const SESSION_ROW_ACTION_OPEN_SPLIT_DOWN_ID = 'openInSplitDown';
export const SESSION_ROW_ACTION_REVEAL_IN_CURRENT_SPLIT_ID = 'revealInCurrentSplit';

export type SessionRowMoreMenuBuildParams = Readonly<{
    target: SessionActionTarget;
    iconColor: string;
    leadingItems?: readonly DropdownMenuItem[];
    folderMoveMenuItems?: readonly DropdownMenuItem[];
    canMoveToFolder?: boolean;
}>;

export type SessionRowActionMenuState = Readonly<{
    tagMenuItems: DropdownMenuItem[];
    handleTagMenuSelect: (tagId: string) => void;
    handleTagMenuCreate: (query: string) => void;
    moreMenuItems: DropdownMenuItem[];
    handleMoreMenuSelect: (itemId: string) => Promise<void>;
    contextMenuItems: DropdownMenuItem[];
    handleContextMenuSelect: (itemId: string) => void;
    mutatingSession: boolean;
}>;
