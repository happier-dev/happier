import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import { IconButton } from '@/components/ui/buttons/IconButton';
import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Icon } from '@/components/ui/icons/Icon';
import { buildSessionReminderMenuItem } from '@/components/sessions/shell/row/actionMenu/buildSessionRowActionMenuItems';
import {
    handleSessionReminderMenuSelection,
    isSessionReminderMenuItemId,
} from '@/components/sessions/shell/row/actionMenu/handleSessionReminderMenuSelection';
import type { InboxModel } from '@/hooks/inbox/useInboxModel';
import { resolveSessionReminderPresentation } from '@/sync/domains/session/organization/attentionStanding';
import { buildSessionOrganizationSessionKey } from '@/sync/domains/session/organization/keys';
import { useSettingMutable } from '@/sync/domains/state/storage';
import { storage } from '@/sync/domains/state/storageStore';
import type { Session } from '@/sync/domains/state/storageTypes';
import { useApplySessionReminderPresetIntent } from '@/sync/store/settingsWriters';
import { t } from '@/text';

const INBOX_SETTLE_MENU_ID = 'inbox.settle';

/**
 * The Inbox row's ⋯ menu: snooze through the session menus' own "Remind me" submenu and handler,
 * and Settle. Both write through `session.attention.set` (the model's writers), so the Inbox has no
 * second reminder vocabulary or writer.
 */
export const InboxSessionRowMenu = React.memo(function InboxSessionRowMenu(props: Readonly<{
    session: Session;
    settle: InboxModel['settle'];
    setReminder: InboxModel['setReminder'];
}>) {
    const { theme } = useUnistyles();
    const [open, setOpen] = React.useState(false);
    const [reminderPresets] = useSettingMutable('sessionReminderPresetsV1');
    const applyReminderPresetIntent = useApplySessionReminderPresetIntent();
    const standingKey = buildSessionOrganizationSessionKey(props.session.serverId ?? '', props.session.id);
    const standing = storage((state) => state.sessionOrganizationAttentionStandingsBySessionKey?.[standingKey]);
    const { session, settle, setReminder } = props;

    const items = React.useMemo<DropdownMenuItem[]>(() => {
        if (!open) return [];
        const nowMs = Date.now();
        const reminder = standing ? resolveSessionReminderPresentation(standing, nowMs) : null;
        return [
            buildSessionReminderMenuItem(theme.colors.text.secondary, reminderPresets ?? [], reminder, nowMs, true),
            {
                id: INBOX_SETTLE_MENU_ID,
                title: t('inbox.work.rows.settle'),
                icon: <Icon name="check-circle" size={16} color={theme.colors.text.secondary} />,
            },
        ];
    }, [open, reminderPresets, standing, theme.colors.text.secondary]);

    const onSelect = React.useCallback((itemId: string) => {
        if (itemId === INBOX_SETTLE_MENU_ID) {
            void settle(session);
            return;
        }
        if (!isSessionReminderMenuItemId(itemId)) return;
        void handleSessionReminderMenuSelection({
            itemId,
            canSchedule: true,
            canClear: typeof standing?.remindAt === 'number',
            presets: reminderPresets ?? [],
            applyPresetIntent: applyReminderPresetIntent,
            schedule: async (remindAt) => {
                await setReminder(session, remindAt);
                return { success: true };
            },
            clear: async () => {
                await setReminder(session, null);
                return { success: true };
            },
        });
    }, [applyReminderPresetIntent, settle, setReminder, reminderPresets, session, standing?.remindAt]);

    return (
        <DropdownMenu
            open={open}
            onOpenChange={setOpen}
            items={items}
            onSelect={onSelect}
            search={false}
            matchTriggerWidth={false}
            maxWidthCap={260}
            placement="bottom"
            popoverAnchorAlign="end"
            trigger={({ toggle }) => (
                <IconButton
                    testID={`inbox.row_menu.${session.id}`}
                    iconName="dots-three"
                    variant="plain"
                    accessibilityLabel={t('inbox.work.rows.more')}
                    hasPopup="menu"
                    expanded={open}
                    onPress={toggle}
                />
            )}
        />
    );
});
