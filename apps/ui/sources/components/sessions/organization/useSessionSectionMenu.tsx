import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import type { DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Icon, type IconName } from '@/components/ui/icons/Icon';
import { t } from '@/text';
import {
  SESSION_SECTION_ICON_CHOICES,
  resolveSessionSectionIcon,
} from './sessionSectionIcons';

/**
 * A section's "…" menu, the same wherever a section is managed (the list's group header, Settings →
 * Sessions → Sections): rename, change icon, optional new session here, archive all and remove.
 * Each choice calls its host's handler; the writes stay with the section Actions.
 */
export function useSessionSectionMenu(
  props: Readonly<{
    icon: string | null;
    /** A locked name cannot be renamed or re-iconed; remove and archive work by id. */
    displayLocked: boolean;
    disabled?: boolean;
    /** Complete membership; omitted while it is not proven (unknown is not zero). */
    memberCount?: number;
    onRename: () => void | Promise<void>;
    onChangeIcon: (icon: IconName) => void | Promise<void>;
    onRemove: () => void | Promise<void>;
    onNewSession?: () => void;
    onArchiveAll?: () => void | Promise<void>;
  }>,
): Readonly<{
  items: DropdownMenuItem[];
  onSelect: (itemId: string) => Promise<void>;
}> {
  const { theme } = useUnistyles();
  const actionsDisabled = props.disabled === true || props.displayLocked;
  const iconColor = actionsDisabled
    ? theme.colors.text.tertiary
    : theme.colors.text.secondary;
  // Archive all works by the section's id, so a locked name does not stop it; a proven-empty section has nothing to archive.
  const archiveDisabled = props.disabled === true || props.memberCount === 0;
  const archiveIconColor = archiveDisabled
    ? theme.colors.text.tertiary
    : theme.colors.text.secondary;
  const sectionIcon = resolveSessionSectionIcon(props.icon);
  const hasNewSession = Boolean(props.onNewSession);
  const hasArchiveAll = Boolean(props.onArchiveAll);
  const items = React.useMemo(
    (): DropdownMenuItem[] => [
      {
        id: 'rename',
        title: t('common.rename'),
        icon: <Icon name="pencil-simple" size={16} color={iconColor} />,
        disabled: actionsDisabled,
        category: 'edit',
      },
      {
        id: 'icon',
        title: t('sessionsList.sectionChangeIcon'),
        icon: <Icon name={sectionIcon} size={16} color={iconColor} />,
        disabled: actionsDisabled,
        category: 'edit',
        submenu: {
          title: t('sessionsList.sectionChangeIcon'),
          maxWidthCap: 200,
          items: SESSION_SECTION_ICON_CHOICES.map((choice) => ({
            id: `icon:${choice}`,
            title: t(`sessionsList.sectionIcons.${choice}` as never),
            icon: (
              <Icon
                name={choice}
                size={16}
                color={theme.colors.text.secondary}
              />
            ),
            checked: choice === sectionIcon,
          })),
        },
      },
      ...(hasNewSession
        ? [
            {
              id: 'new-session',
              title: t('sessionsList.sectionNewSessionHere'),
              icon: <Icon name="plus" size={16} color={iconColor} />,
              disabled: actionsDisabled,
              category: 'edit',
            },
          ]
        : []),
      ...(hasArchiveAll
        ? [
            {
              id: 'archive-all',
              title: t('sessionsList.sectionArchiveAll'),
              icon: <Icon name="archive" size={16} color={archiveIconColor} />,
              disabled: archiveDisabled,
              category: 'remove',
            },
          ]
        : []),
      {
        id: 'remove',
        title: t('sessionsList.removeSection'),
        subtitle: t('sessionsList.removeSectionDetail'),
        icon: (
          <Icon
            name="minus-circle"
            size={16}
            color={theme.colors.text.secondary}
          />
        ),
        category: 'remove',
      },
    ],
    [
      actionsDisabled,
      archiveDisabled,
      archiveIconColor,
      hasArchiveAll,
      hasNewSession,
      iconColor,
      sectionIcon,
      theme.colors.text.secondary,
    ],
  );
  const latest = React.useRef(props);
  latest.current = props;
  const onSelect = React.useCallback(
    async (itemId: string) => {
      const current = latest.current;
      if (itemId === 'remove') {
        await current.onRemove();
        return;
      }
      if (itemId === 'archive-all') {
        if (!archiveDisabled) await current.onArchiveAll?.();
        return;
      }
      if (actionsDisabled) return;
      if (itemId === 'new-session') {
        current.onNewSession?.();
      } else if (itemId === 'rename') {
        await current.onRename();
      } else if (itemId.startsWith('icon:')) {
        const choice = SESSION_SECTION_ICON_CHOICES.find(
          (candidate) => `icon:${candidate}` === itemId,
        );
        if (choice) await current.onChangeIcon(choice);
      }
    },
    [actionsDisabled, archiveDisabled],
  );
  return { items, onSelect };
}
