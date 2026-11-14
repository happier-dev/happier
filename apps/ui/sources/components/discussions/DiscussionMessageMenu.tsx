import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import { IconButton } from '@/components/ui/buttons/IconButton';
import {
  DropdownMenu,
  type DropdownMenuItem,
} from '@/components/ui/forms/dropdown/DropdownMenu';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { t } from '@/text';

export type DiscussionMessageMenuItemId = 'reply' | 'saveDecision' | 'select';

/**
 * A Discussion message's one ⋯ (CR5): everything a message offers beyond Reply waits here, so a row
 * reads as the message with Reply and one quiet ⋯ beside it. Each entry opens its existing owner
 * (Save as decision's sheet, the transcript's selection); this menu decides nothing about them.
 */
export function DiscussionMessageMenu(
  props: Readonly<{
    messageId: string;
    /** Who said the message, so each row's ⋯ has its own spoken name. */
    speakerLabel: string;
    saveDecision: boolean;
    /** A phone row keeps no Reply button beside the message, so Reply leads its ⋯. */
    reply?: boolean;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onSelect: (id: DiscussionMessageMenuItemId) => void;
  }>,
): React.ReactElement {
  const { theme } = useUnistyles();
  const iconColor = theme.colors.text.secondary;
  const items = React.useMemo(
    (): readonly DropdownMenuItem[] => [
      ...(props.reply
        ? [
            {
              id: 'reply',
              testID: `session-discussion-message-menu-${props.messageId}:reply`,
              title: t('session.collaboration.discussion.replyDraft.action'),
              icon: <Icon name="arrow-elbow-up-left" size={ICON_SIZE.xs} color={iconColor} />,
            },
          ]
        : []),
      ...(props.saveDecision
        ? [
            {
              id: 'saveDecision',
              testID: `session-discussion-message-menu-${props.messageId}:saveDecision`,
              title: t('memoryContext.memory.saveAsDecision'),
              icon: (
                <Icon
                  name="seal-check"
                  size={ICON_SIZE.xs}
                  color={iconColor}
                />
              ),
            },
          ]
        : []),
      {
        id: 'select',
        testID: `session-discussion-message-menu-${props.messageId}:select`,
        title: t('transcript.selection.select'),
        icon: (
          <Icon name="check-square" size={ICON_SIZE.xs} color={iconColor} />
        ),
      },
    ],
    [iconColor, props.messageId, props.reply, props.saveDecision],
  );
  const { onOpenChange, onSelect } = props;
  const select = React.useCallback(
    (id: string) => {
      onOpenChange(false);
      if (id === 'reply' || id === 'saveDecision' || id === 'select') onSelect(id);
    },
    [onOpenChange, onSelect],
  );
  return (
    <DropdownMenu
      testID={`session-discussion-message-menu-${props.messageId}`}
      open={props.open}
      onOpenChange={onOpenChange}
      items={items}
      onSelect={select}
      placement="bottom"
      popoverAnchorAlign="end"
      variant="slim"
      matchTriggerWidth={false}
      maxWidthCap={260}
      showCategoryTitles={false}
      popoverAccessibilityLabel={props.speakerLabel}
      trigger={({ toggle }) => (
        <IconButton
          testID={`session-discussion-message-more-${props.messageId}`}
          size={28}
          variant="plain"
          icon={
            <Icon name="dots-three" size={ICON_SIZE.xs} color={iconColor} />
          }
          accessibilityLabel={`${t('common.moreActions')}, ${props.speakerLabel}`}
          accessibilityHint={t('common.moreActionsHint')}
          tooltip={t('common.moreActions')}
          onPress={toggle}
        />
      )}
    />
  );
}
