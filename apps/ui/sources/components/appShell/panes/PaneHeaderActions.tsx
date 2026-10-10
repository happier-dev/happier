import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import { IconButton } from '@/components/ui/buttons/IconButton';
import {
  DropdownMenu,
  type DropdownMenuItem,
} from '@/components/ui/forms/dropdown/DropdownMenu';
import { Icon } from '@/components/ui/icons/Icon';
import type { ItemAction } from '@/components/ui/lists/itemActions';
import { t } from '@/text';

import type { PaneHeaderSlotContent } from './paneHeaderSlot';

/**
 * A pane header's trailing controls from what its tab publishes: the tab's action, then one ⋯ that
 * holds the tab's rare operations followed by the pane's own. Every header that reads the slot (the
 * right sidebar, the phone cockpit screen) draws them through here, so no band carries two ⋯.
 *
 * The ⋯ is a chrome menu, drawn like the header controls beside it (the Work tab's "+", the session
 * header's ⋯): a light dropdown under its trigger that leaves the window sharp and sizes to its
 * labels. A row's spotlight menu (`ItemRowActions`) is for an item in a list, not for chrome.
 */
export function PaneHeaderActions(
  props: Readonly<{
    published: PaneHeaderSlotContent | null;
    title: string;
    /** The pane's own operations (for a session pane: Add to Companion). */
    paneMenuActions?: readonly ItemAction[];
    testID: string;
  }>,
): React.ReactElement | null {
  const tabMenuActions = props.published?.menuActions;
  const { paneMenuActions } = props;
  const menuActions = React.useMemo(
    () => [...(tabMenuActions ?? []), ...(paneMenuActions ?? [])],
    [paneMenuActions, tabMenuActions],
  );
  const action = props.published?.action ?? null;
  if (menuActions.length === 0) return action === null ? null : <>{action}</>;
  return (
    <>
      {action}
      <PaneHeaderMenu
        title={props.title}
        actions={menuActions}
        testID={`${props.testID}.menu`}
      />
    </>
  );
}

const PaneHeaderMenu = React.memo(function PaneHeaderMenu(
  props: Readonly<{
    title: string;
    actions: readonly ItemAction[];
    testID: string;
  }>,
) {
  const { theme } = useUnistyles();
  const [open, setOpen] = React.useState(false);
  const { actions, title } = props;
  const iconColor = theme.colors.text.secondary;
  const dangerColor = theme.colors.state.danger.foreground;
  const items = React.useMemo(
    (): readonly DropdownMenuItem[] =>
      actions.map((action) => ({
        id: action.id,
        testID: action.id,
        title: action.title,
        subtitle: action.subtitle,
        accessibilityLabel: action.accessibilityLabel,
        // Ungrouped operations sit under the pane's own name, as one section.
        category: action.group?.title ?? title,
        icon:
          typeof action.icon === 'string' ? (
            <Icon
              name={action.icon}
              size={16}
              color={
                action.color ?? (action.destructive ? dangerColor : iconColor)
              }
            />
          ) : (
            action.icon
          ),
        disabled: action.disabled === true || !action.onPress,
        destructive: action.destructive,
        ...(action.selected === undefined ? {} : { checked: action.selected }),
      })),
    [actions, dangerColor, iconColor, title],
  );
  const select = React.useCallback(
    (id: string) => {
      setOpen(false);
      actions.find((action) => action.id === id)?.onPress?.();
    },
    [actions],
  );
  const label = t('common.moreActions');
  return (
    <DropdownMenu
      open={open}
      onOpenChange={setOpen}
      items={items}
      onSelect={select}
      matchTriggerWidth={false}
      showCategoryTitles
      placement="bottom"
      trigger={({ open: isOpen, toggle }) => (
        <IconButton
          testID={props.testID}
          iconName="dots-three"
          variant="plain"
          selected={isOpen}
          accessibilityLabel={label}
          accessibilityHint={t('common.moreActionsHint')}
          tooltip={label}
          onPress={toggle}
        />
      )}
    />
  );
});
