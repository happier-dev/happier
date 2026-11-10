import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import { IconButton } from '@/components/ui/buttons/IconButton';
import {
  DropdownMenu,
  type DropdownMenuItem,
} from '@/components/ui/forms/dropdown/DropdownMenu';
import { Icon } from '@/components/ui/icons/Icon';
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
 * A notice's or operation's row menu: Dismiss, the one quick action every stored Inbox notice carries.
 * The trigger takes `testID`; Dismiss is the menu's `dropdown-option-inbox_dismiss`.
 */
export const InboxDismissRowMenu = React.memo(function InboxDismissRowMenu(
  props: Readonly<{
    testID: string;
    onDismiss: () => Promise<void> | void;
  }>,
) {
  const { theme } = useUnistyles();
  const [open, setOpen] = React.useState(false);
  const { onDismiss } = props;
  const items = React.useMemo<DropdownMenuItem[]>(
    () =>
      open
        ? [
            {
              id: DISMISS_ID,
              title: t('inbox.actionOperations.dismiss'),
              icon: (
                <Icon name="x" size={16} color={theme.colors.text.secondary} />
              ),
            },
          ]
        : [],
    [open, theme.colors.text.secondary],
  );
  const onSelect = React.useCallback(
    (itemId: string) => {
      if (itemId !== DISMISS_ID) return;
      void (async () => {
        try {
          await onDismiss();
        } catch {
          Modal.alert(t('common.error'), t('errors.unknownError'));
        }
      })();
    },
    [onDismiss],
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
