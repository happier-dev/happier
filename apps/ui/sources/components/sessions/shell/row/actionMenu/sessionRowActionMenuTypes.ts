import type { DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import type { SessionActionTarget } from '@/components/sessions/actions/sessionActionTypes';
import type { SessionReminderPresetV1 } from '@/sync/domains/session/organization/sessionReminderPreset';
import type { SessionReminderPresentation } from '@/sync/domains/session/organization/attentionStanding';
import type { SessionAppearanceColorMenuInput } from '@/components/sessions/shell/appearance/sessionAppearanceColorMenu';

export type SessionRowMoreMenuBuildParams = Readonly<{
    target: SessionActionTarget;
    iconColor: string;
    leadingItems?: readonly DropdownMenuItem[];
    trailingItems?: readonly DropdownMenuItem[];
    canMoveToFolder?: boolean;
    reminderPresets?: readonly SessionReminderPresetV1[];
    reminder?: SessionReminderPresentation | null;
    reminderNowMs?: number;
    /** Null when the session's server cannot store a session colour; the action is then hidden. */
    appearance?: SessionAppearanceColorMenuInput | null;
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
