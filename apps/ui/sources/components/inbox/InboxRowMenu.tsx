import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import { IconButton } from '@/components/ui/buttons/IconButton';
import {
  DropdownMenu,
  type DropdownMenuItem,
} from '@/components/ui/forms/dropdown/DropdownMenu';
import { Icon } from '@/components/ui/icons/Icon';
import { buildSessionReminderMenuItem } from '@/components/sessions/shell/row/actionMenu/buildSessionRowActionMenuItems';
import { handleSessionReminderMenuSelection, isSessionReminderMenuItemId } from '@/components/sessions/shell/row/actionMenu/handleSessionReminderMenuSelection';
import { useSettingsSelector } from '@/sync/domains/state/storage';
import { useApplySessionReminderPresetIntent } from '@/sync/store/settingsWriters';
import type { AccountNoticeArtifact } from '@/sync/domains/artifacts/usageNoticeArtifacts';
import { canSetAccountNoticeReminderV1, readAccountNoticeReminderV1 } from '@happier-dev/protocol/activity/usageNoticeArtifactV1';
import { Modal } from '@/modal';
import { t } from '@/text';

/**
 * Every Inbox row's one trailing control: "…", opening the row's actions. A group mixes Sessions,
 * notices and operations, so one control kind keeps the column calm whatever a row can do; the
 * row kind decides only what the menu lists.
 */
export function InboxRowMenu(
  props: Readonly<{
    testID: string;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    items: ReadonlyArray<DropdownMenuItem>;
    onSelect: (itemId: string) => void;
  }>,
) {
  return (
    <DropdownMenu
      open={props.open}
      onOpenChange={props.onOpenChange}
      items={props.items}
      onSelect={props.onSelect}
      search={false}
      matchTriggerWidth={false}
      maxWidthCap={260}
      placement="bottom"
      popoverAnchorAlign="end"
      trigger={({ toggle }) => (
        <IconButton
          testID={props.testID}
          iconName="dots-three"
          variant="plain"
          accessibilityLabel={t('inbox.work.rows.more')}
          hasPopup="menu"
          expanded={props.open}
          onPress={toggle}
        />
      )}
    />
  );
}

const DISMISS_ID = 'inbox.dismiss';

/**
 * A notice's or operation's row menu: Dismiss, plus the shared reminder submenu for eligible notices.
 * The trigger takes `testID`; Dismiss is the menu's `dropdown-option-inbox_dismiss`.
 */
export const InboxDismissRowMenu = React.memo(function InboxDismissRowMenu(
  props: Readonly<{
    testID: string;
    onDismiss: () => Promise<void> | void;
    reminder?: Readonly<{
      entry: AccountNoticeArtifact;
      onSetReminder: (remindAt: number | null) => Promise<void>;
    }>;
  }>,
) {
  const { theme } = useUnistyles();
  const [open, setOpen] = React.useState(false);
  const canRemind = props.reminder !== undefined && canSetAccountNoticeReminderV1(props.reminder.entry.header);
  // Closed menus and operation-only rows demand no preset details.
  const presets = useSettingsSelector(settings => open && canRemind ? settings.sessionReminderPresetsV1 : undefined,
    open && canRemind ? ['sessionReminderPresetsV1'] : []);
  const applyPresetIntent = useApplySessionReminderPresetIntent();
  const { onDismiss } = props;
  const items = React.useMemo<DropdownMenuItem[]>(
    () =>
      open
        ? [
            ...(canRemind && props.reminder ? [buildSessionReminderMenuItem(theme.colors.text.secondary, presets ?? [],
              readAccountNoticeReminderV1(props.reminder.entry.header, Date.now()), Date.now(), true)] : []),
            {
              id: DISMISS_ID,
              title: t('inbox.actionOperations.dismiss'),
              icon: (
                <Icon name="x" size={16} color={theme.colors.text.secondary} />
              ),
            },
          ]
        : [],
    [open, theme.colors.text.secondary, canRemind, presets, props.reminder],
  );
  const onSelect = React.useCallback(
    (itemId: string) => {
      if (itemId !== DISMISS_ID && !isSessionReminderMenuItemId(itemId)) return;
      void (async () => {
        try {
          if (itemId === DISMISS_ID) await onDismiss();
          else if (props.reminder) {
            const reminder = props.reminder;
            const writeReminder = async (remindAt: number | null) => {
              try { await reminder.onSetReminder(remindAt); return { success: true }; }
              catch { return { success: false }; }
            };
            await handleSessionReminderMenuSelection({ itemId, canSchedule: canRemind,
              canClear: canRemind && reminder.entry.header.remindAt !== undefined,
              presets: presets ?? [], applyPresetIntent,
              schedule: writeReminder, clear: () => writeReminder(null) });
          }
        } catch {
          Modal.alert(t('common.error'), t('errors.unknownError'));
        }
      })();
    },
    [onDismiss, props.reminder, canRemind, presets, applyPresetIntent],
  );
  return (
    <InboxRowMenu
      testID={props.testID}
      open={open}
      onOpenChange={setOpen}
      items={items}
      onSelect={onSelect}
    />
  );
});
