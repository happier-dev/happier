import * as React from 'react';
import { View } from 'react-native';
import type { CollectionRowActions } from '@happier-dev/plugin-ui';

import { IconButton } from '@/components/ui/buttons/IconButton';
import {
  DropdownMenu,
  type DropdownMenuItem,
} from '@/components/ui/forms/dropdown/DropdownMenu';
import { t } from '@/text';

import { describeProcessTitle } from './processOwnerIdentity';
import { formatProcessMemory } from './processesCollectionAnatomy';
import type { ProcessesItem } from './processesPresentation';
import {
  ProcessesControllerContext,
  type ProcessesController,
} from './useProcessesController';

/** The tab's "show this row's detail in place" (the Collection's peek), for the menu's default item. */
export const ProcessesShowDetailsContext = React.createContext<
  ((key: string) => void) | null
>(null);

type MenuEntry = DropdownMenuItem &
  Readonly<{ run: () => void; previewsBytes?: number | null }>;

function buildMenu(
  item: ProcessesItem,
  controller: ProcessesController,
  showDetails: ((key: string) => void) | null,
): readonly MenuEntry[] {
  const blocked = controller.unavailableReason;
  const danger = (
    entry: Omit<MenuEntry, 'destructive' | 'disabled'>,
  ): MenuEntry => ({
    ...entry,
    destructive: true,
    disabled: blocked !== null,
    ...(blocked ? { subtitle: blocked } : {}),
  });
  const details = showDetails
    ? [
        {
          id: 'details',
          title: t('machineProcesses.menu.showDetails'),
          run: () => showDetails(item.key),
        },
      ]
    : [];
  switch (item.kind) {
    case 'owner': {
      const owner = item.owner.owner;
      if (owner.kind === 'happier' || owner.kind === 'container' || !item.rootRef) return [];
      const frees = item.memoryBytes
        ? t('machineProcesses.menu.freesAbout', {
            amount: formatProcessMemory(item.memoryBytes),
          })
        : undefined;
      const entries: MenuEntry[] = [];
      if (owner.kind === 'session') {
        entries.push({
          id: 'open',
          title: t('machineProcesses.menu.openSession'),
          run: () => controller.openSession(owner.sessionId),
        });
        entries.push({
          id: 'stop',
          title: t('machineProcesses.menu.stopSession'),
          subtitle: blocked ?? t('machineProcesses.menu.stopSessionHint'),
          disabled: blocked !== null,
          run: () => controller.stop(item),
          previewsBytes: item.memoryBytes,
        });
      } else if (owner.kind === 'service' || owner.kind === 'browser_sidecar') {
        entries.push({
          id: 'stop',
          title:
            owner.kind === 'service'
              ? t('machineProcesses.menu.stopService')
              : t('machineProcesses.menu.stop'),
          ...((blocked ?? frees) ? { subtitle: blocked ?? frees } : {}),
          disabled: blocked !== null,
          run: () => controller.stop(item),
          previewsBytes: item.memoryBytes,
        });
      }
      entries.push(
        danger({
          id: 'kill-tree',
          title: t('machineProcesses.menu.killTree'),
          run: () => controller.killTree(item),
        }),
      );
      return entries;
    }
    case 'process': {
      const proven = item.row.level === 'proven';
      const session =
        item.owner.owner.kind === 'session' ? item.owner.owner.sessionId : null;
      return [
        ...details,
        proven && item.row.command
          ? {
              id: 'copy',
              title: t('machineProcesses.menu.copyCommand'),
              run: () => controller.copy(item.row.command!),
            }
          : {
              id: 'copy',
              title: t('machineProcesses.menu.copyName'),
              run: () => controller.copy(describeProcessTitle(item.row)),
            },
        ...(proven && session
          ? [
              {
                id: 'open',
                title: t('machineProcesses.menu.openSession'),
                run: () => controller.openSession(session),
              },
            ]
          : []),
        ...(item.owner.owner.kind === 'container' ? [] : [danger({
          id: 'kill',
          title: t('machineProcesses.menu.killProcess'),
          ...(proven ? {} : { subtitle: t('machineProcesses.menu.asksFirst') }),
          run: () => controller.killProcess(item),
        })]),
      ];
    }
    case 'leftBehind':
      return [
        ...details,
        {
          id: 'copy',
          title: t('machineProcesses.menu.copyName'),
          run: () => controller.copy(describeProcessTitle(item.row)),
        },
        danger({
          id: 'kill',
          title: t('machineProcesses.menu.killProcess'),
          subtitle: t('machineProcesses.menu.asksFirst'),
          run: () => controller.killProcess(item),
        }),
      ];
    case 'appMember':
      // Other apps' command lines never leave the machine: only the name can be copied.
      return [
        {
          id: 'copy',
          title: t('machineProcesses.menu.copyName'),
          run: () => controller.copy(item.row.name),
        },
        danger({
          id: 'kill',
          title: t('machineProcesses.menu.killProcess'),
          subtitle: t('machineProcesses.menu.asksFirst'),
          run: () => controller.killProcess(item),
        }),
      ];
    default:
      return [];
  }
}

/**
 * The row's ⋯ menu (lab `rp` KF): items by what the row is, destructive ones last in rose. Resting on a
 * Stop previews its effect on the memory meter (the ghost) before anything happens; choosing it closes
 * the menu at once.
 */
const ProcessRowMenu = React.memo(function ProcessRowMenu(
  props: Readonly<{
    item: ProcessesItem;
    entries: readonly MenuEntry[];
    controller: ProcessesController;
  }>,
) {
  const [open, setOpen] = React.useState(false);
  const { controller, entries } = props;
  const onOpenChange = React.useCallback(
    (next: boolean) => {
      setOpen(next);
      if (!next) controller.previewStop(null);
    },
    [controller],
  );
  const onSelect = React.useCallback(
    (id: string) => {
      setOpen(false);
      controller.previewStop(null);
      entries.find((entry) => entry.id === id)?.run();
    },
    [controller, entries],
  );
  const wrapItem = React.useCallback(
    (menuItem: { id: string }, content: React.ReactNode) => {
      const entry = entries.find((candidate) => candidate.id === menuItem.id);
      if (!entry || entry.previewsBytes === undefined) return content;
      return (
        <View
          onPointerEnter={() =>
            controller.previewStop(entry.previewsBytes ?? null)
          }
          onPointerLeave={() => controller.previewStop(null)}
        >
          {content}
        </View>
      );
    },
    [controller, entries],
  );
  const title = controller.titleOf(props.item);
  return (
    <DropdownMenu
      testID={`machine-processes-menu-${props.item.key}`}
      open={open}
      onOpenChange={onOpenChange}
      items={entries}
      onSelect={onSelect}
      wrapItem={wrapItem}
      matchTriggerWidth={false}
      placement="bottom"
      popoverAccessibilityLabel={t('machineProcesses.menu.label', {
        name: title,
      })}
      trigger={({ toggle }) => (
        <IconButton
          testID={`machine-processes-menu-trigger-${props.item.key}`}
          iconName="dots-three"
          variant="plain"
          accessibilityLabel={t('machineProcesses.menu.label', { name: title })}
          onPress={toggle}
        />
      )}
    />
  );
});

const NO_ACTIONS: CollectionRowActions = {};

/** The Collection's row-actions hook (stable, module level): reads the tab's controller from context. */
export function useProcessRowActions(
  item: ProcessesItem,
): CollectionRowActions {
  const controller = React.useContext(ProcessesControllerContext);
  const showDetails = React.useContext(ProcessesShowDetailsContext);
  const entries = React.useMemo(
    () => (controller ? buildMenu(item, controller, showDetails) : []),
    [controller, item, showDetails],
  );
  return React.useMemo(
    () =>
      controller && entries.length > 0
        ? {
            accessory: (
              <ProcessRowMenu
                item={item}
                entries={entries}
                controller={controller}
              />
            ),
          }
        : NO_ACTIONS,
    [controller, entries, item],
  );
}
