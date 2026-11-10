import * as React from 'react';
import { Pressable } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { formatMachineBytes } from '@/components/machines/vitals/machineVitalsPresentation';
import { publishPresentationNotice } from '@/components/sessions/presentation/presentationNotices';
import {
  copyLocalServiceAddress,
} from '@/components/sessions/localServices/localServiceEntryActions';
import { resolveLocalServicePublicLinkOffer } from '@/components/sessions/localServices/LocalServicePublicPreviewControls';
import {
  DropdownMenu,
  type DropdownMenuItem,
} from '@/components/ui/forms/dropdown/DropdownMenu';
import { StatusPill } from '@/components/ui/status/StatusPill';
import { Typography } from '@/constants/Typography';
import { useLocalServicePublicPreviewStateController } from '@/sync/domains/local/services/publicPreview/useLocalServicePublicPreviewState';
import { t } from '@/text';
import { usePreferredLanguage } from '@/text/usePreferredLanguage';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { useClipboardWrite } from '@/hooks/ui/useClipboardWrite';

import { useMachinePortEntry } from '@/components/machines/localServices/MachinePortActions';

import { showProcessConfirmDialog } from './ProcessConfirmDialog';
import {
  processPortClosesTerminal,
  type ProcessesItem,
} from './processesPresentation';
import { ProcessesControllerContext } from './useProcessesController';

type PortEntry = DropdownMenuItem & Readonly<{ run?: () => void }>;

/**
 * A listener on the process that owns it (`:5173`). Pressed, it opens what Local services already
 * offers for that listener (lab `rp` F cell 4): Open in browser, Copy address, Public link…, then Stop. Read-only
 * surfaces (the Overview's "Using the most", the detail facts) and a tab with no controller draw the
 * chip alone.
 */
export const ProcessPortChip = React.memo(function ProcessPortChip(
  props: Readonly<{
    port: number;
    inventoryEntryId: string;
    item: ProcessesItem;
    /** The owner's title: a terminal's name when freeing this port closes it (R42.5). */
    ownerTitle: string;
  }>,
) {
  const language = usePreferredLanguage();
  const controller = React.useContext(ProcessesControllerContext);
  const [open, setOpen] = React.useState(false);
  const { actions, services, row, offered, open: openPort } = useMachinePortEntry(props, open);
  const writeClipboard = useClipboardWrite(actions?.serverId ?? null, { enabled: open });
  // The row's public-link feed is read only while its menu is open.
  const preview = useLocalServicePublicPreviewStateController({
    machineId: row?.target.machineId ?? null,
    serverId: actions?.serverId ?? null,
    sessionId: row?.target.sessionId ?? null,
    enabled: row !== null && services?.publicPreviewEnabled === true,
  });
  const label = `:${props.port}`;
  const chip = (
    <StatusPill
      variant="neutral"
      hideDot
      label={label}
      labelStyle={styles.mono}
    />
  );

  const entries = React.useMemo((): readonly PortEntry[] => {
    if (!open || !controller) return [];
    if (!services?.rows) {
      return [{ id: 'loading', title: t('common.loading'), disabled: true }];
    }
    if (!row || !offered) {
      return [
        {
          id: 'not-listed',
          title: t('machineProcesses.portMenu.notListed'),
          disabled: true,
        },
      ];
    }
    const { handlers, run } = services;
    const blocked = controller.unavailableReason;
    const list: PortEntry[] = [];
    if (openPort) {
      const subtitle = blocked ?? offered.openUnavailableReason ?? undefined;
      list.push({
        id: 'open-browser',
        category: 'service',
        title: t('machineProcesses.portMenu.openInBrowser'),
        ...(subtitle ? { subtitle } : {}),
        disabled: subtitle !== undefined,
        run: () =>
          fireAndForget(
            openPort(),
            { tag: 'MachineProcesses.portOpen' },
          ),
      });
    }
    const address = offered.address;
    if (address) {
      list.push({
        id: 'copy',
        category: 'service',
        title: t('localServices.pane.copyAddress'),
        subtitle: address,
        run: () =>
          fireAndForget(
            copyLocalServiceAddress(
              row.target,
              address,
              handlers.onCopyServiceUrl,
              writeClipboard,
            ).then((copied) => {
              if (copied)
                publishPresentationNotice({
                  key: 'machine-processes:copied',
                  severity: 'info',
                  message: t('machineProcesses.results.copied'),
                });
            }),
            { tag: 'MachineProcesses.portCopy' },
          ),
      });
    }
    const publicPreviewActions = handlers.publicPreviewActions;
    const link = publicPreviewActions
      ? resolveLocalServicePublicLinkOffer({
          state: services.publicPreviewEnabled ? preview.state : null,
          launchTarget: row.target,
          capabilityDisabledReasons: services.capabilityDisabledReasons,
        })
      : null;
    if (link && publicPreviewActions) {
      const subtitle =
        blocked ?? (link.kind === 'disabled' ? link.subtitle : undefined);
      list.push({
        id: 'public-link',
        category: 'service',
        title: t('machineProcesses.portMenu.publicLink'),
        ...(subtitle ? { subtitle } : {}),
        disabled: blocked !== null || link.kind === 'disabled',
        ...(link.kind === 'create'
          ? {
              run: () =>
                fireAndForget(link.request(publicPreviewActions, run), {
                  tag: 'MachineProcesses.portPublicLink',
                }),
            }
          : {}),
      });
    }
    const managed = offered.stopManaged;
    if (managed || offered.terminateDetected) {
      const frees = props.item.memoryBytes
        ? t('machineProcesses.menu.freesAbout', {
            amount: formatMachineBytes(props.item.memoryBytes, 'memory'),
          })
        : undefined;
      const subtitle = blocked ?? frees;
      const closesTerminal = processPortClosesTerminal(props.item);
      list.push({
        id: 'stop',
        category: 'stop',
        title: managed
          ? t('machineProcesses.menu.stopService')
          : t('machineProcesses.portMenu.stopServer', { port: props.port }),
        ...(subtitle ? { subtitle } : {}),
        disabled: blocked !== null,
        run: () =>
          fireAndForget(
            (async () => {
              // Policy owns whether to ask; this invocation supplies its terminal-loss facts.
              const confirmation = closesTerminal ? async () => {
                const decision = await showProcessConfirmDialog({
                  testID: 'machine-processes-port-close-terminal',
                  title: t('machineProcesses.portMenu.closeTerminalTitle', {
                    port: props.port,
                  }),
                  paragraphs: [
                    t('machineProcesses.portMenu.closesTerminal', {
                      name: props.ownerTitle,
                    }),
                    t('machineProcesses.portMenu.closeTerminalBody'),
                  ],
                  facts: [],
                  confirmLabel: t(
                    'machineProcesses.portMenu.confirmCloseTerminal',
                  ),
                });
                return decision === 'confirm';
              } : undefined;
              await run({
                id: `port:${props.inventoryEntryId}`,
                failureTitle: managed
                  ? t('localServices.actions.failureTitle.stop', {
                      service: row.title,
                    })
                  : t('localServices.actions.failureTitle.terminate', {
                      service: row.title,
                    }),
                action: async () =>
                  managed
                    ? handlers.onStopManagedService?.(row.target, { confirmation })
                    : handlers.onTerminateDetectedService?.(row.target, { confirmation }),
              });
            })(),
            { tag: 'MachineProcesses.portStop' },
          ),
      });
    }
    return list;
  }, [
      language,
    controller,
    open,
    openPort,
    offered,
    preview.state,
    props.inventoryEntryId,
    props.item,
    props.ownerTitle,
    props.port,
    row,
    services,
  ]);

  const onSelect = React.useCallback(
    (id: string) => {
      setOpen(false);
      entries.find((entry) => entry.id === id)?.run?.();
    },
    [entries],
  );

  if (!actions || !controller) return chip;
  const demand = actions.demand;
  return (
    <DropdownMenu
      testID={`machine-processes-port-menu-${props.item.key}-${props.port}`}
      open={open}
      onOpenChange={setOpen}
      items={entries}
      onSelect={onSelect}
      matchTriggerWidth={false}
      placement="bottom"
      popoverAccessibilityLabel={t('machineProcesses.portMenu.label', {
        port: props.port,
      })}
      trigger={({ toggle }) => (
        <Pressable
          testID={`machine-processes-port-${props.item.key}-${props.port}`}
          accessibilityRole="button"
          accessibilityLabel={t('machineProcesses.portMenu.label', {
            port: props.port,
          })}
          onPress={() => {
            demand();
            toggle();
          }}
        >
          {chip}
        </Pressable>
      )}
    />
  );
});

const styles = StyleSheet.create(() => ({
  mono: {
    ...Typography.mono(),
  },
}));
