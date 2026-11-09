import * as React from 'react';
import type {
  McpServerCatalogEntryV1,
  McpServerConfigOverrideV1,
} from '@happier-dev/protocol/mcp/servers/settingsV1';
import { reachPlaceKeyV1 } from '@happier-dev/protocol/reach/reachPlaceV1';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Modal } from '@/modal';
import type { SavedSecret } from '@/sync/domains/settings/savedSecretTypes';
import type { AccountSettingsScope } from '@/sync/domains/settings/scope/accountSettingsScope';
import { McpMachineDifferenceEditorModal } from './McpMachineDifferenceEditorModal';
import { Icon } from '@/components/ui/icons/Icon';
import {
  ExpandableItem,
} from '@/components/ui/lists/ExpandableItem';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';

/** What one machine's override changes, in the words of the Configuration rows. */
function describeOverride(override: McpServerConfigOverrideV1): string {
  const parts: string[] = [];
  if (override.stdio?.command)
    parts.push(t('capabilities.mcp.config.differsCommand'));
  if (override.stdio?.args)
    parts.push(t('capabilities.mcp.config.differsArguments'));
  if (override.stdio?.cwd)
    parts.push(
      t('capabilities.mcp.config.differsFolder', {
        path: override.stdio.cwd.t === 'path' ? override.stdio.cwd.path : t('capabilities.mcp.config.sessionFolder'),
      }),
    );
  if (override.remote?.url)
    parts.push(t('capabilities.mcp.config.differsAddress'));
  const names = [
    ...Object.keys(override.envPatch ?? {}),
    ...Object.keys(override.remote?.headersPatch ?? {}),
  ];
  if (names.length > 0)
    parts.push(
      t('capabilities.mcp.config.differsValues', { names: names.join(', ') }),
    );
  return parts.join(' · ');
}

/**
 * "Different on a machine…" (T5): the machines whose values differ from the Configuration above. Closed,
 * it names them; open, each is one row with what differs. A 0.2 folder override reads "In <folder> on
 * <machine>" with Remove only. Removing commits like any Configuration edit.
 */
export const McpServerMachineDifferences = React.memo(
  function McpServerMachineDifferences(
    props: Readonly<{
      server: McpServerCatalogEntryV1;
      machineName: (machineId: string) => string;
      /** The Account's machines a difference can name. */
      machines: readonly Readonly<{ machineId: string; name: string }>[];
      secrets: SavedSecret[];
      scope: AccountSettingsScope | null | undefined;
      onChangeServer: (
        updater: (current: McpServerCatalogEntryV1) => McpServerCatalogEntryV1,
      ) => void;
      onCommit: () => void;
    }>,
  ) {
    const { theme } = useUnistyles();
    const overrides = props.server.configOverrides ?? [];
    const [expanded, setExpanded] = React.useState(false);
    const [pickOpen, setPickOpen] = React.useState(false);
    const { onChangeServer, onCommit } = props;

    // One machine's values: the existing override editor, prefilled when the machine already differs.
    const edit = (target: McpServerConfigOverrideV1['target'], current: McpServerConfigOverrideV1 | undefined) => {
      const key = reachPlaceKeyV1(target);
      const { target: _target, ...fields } = current ?? { target };
      Modal.show({
        component: McpMachineDifferenceEditorModal,
        props: {
          server: props.server,
          current: current ? fields : undefined,
          secrets: props.secrets,
          scope: props.scope,
          onSubmit: (next: Omit<McpServerConfigOverrideV1, 'target'> | undefined) => {
            onChangeServer((server) => {
              const rest = (server.configOverrides ?? []).filter((item) => reachPlaceKeyV1(item.target) !== key);
              const configOverrides = next ? [...rest, { ...next, target }] : rest;
              return { ...server, configOverrides, updatedAt: Date.now() };
            });
            onCommit();
            setExpanded(true);
          },
        },
        chrome: {
          kind: 'card',
          title: t('capabilities.mcp.config.differentOn', { machine: props.machineName(target.machineId) }),
          dimensions: { size: 'lg' },
        },
        closeOnBackdrop: true,
      });
    };
    const differing = new Set(overrides.filter((item) => item.target.t === 'machine').map((item) => item.target.machineId));
    const choices = props.machines
      .filter((machine) => !differing.has(machine.machineId))
      .map((machine) => ({ id: machine.machineId, title: machine.name }));
    const add = choices.length > 0 ? (
      <DropdownMenu
        testID="mcp.server.differences.add"
        open={pickOpen}
        onOpenChange={setPickOpen}
        variant="selectable"
        search={choices.length > 8}
        searchPlaceholder={t('newSession.machinePicker.searchPlaceholder')}
        showCategoryTitles={false}
        connectToTrigger
        items={choices}
        onSelect={(machineId) => {
          setPickOpen(false);
          edit({ t: 'machine', machineId }, undefined);
        }}
        trigger={({ toggle }) => (
          <RoundButton
            testID="mcp.server.differences.add.trigger"
            size="small"
            display="inverted"
            leading={<Icon name="plus" size={14} color={theme.colors.text.primary} />}
            title={t('capabilities.mcp.config.addDifference')}
            onPress={toggle}
          />
        )}
      />
    ) : null;

    if (overrides.length === 0) {
      return (
        <ItemGroup testID="mcp.server.differences">
          <Item
            testID="mcp.server.differences.none"
            title={t('capabilities.mcp.config.different')}
            subtitle={t('capabilities.mcp.config.differentNone')}
            accessoryLayout="adaptive"
            showChevron={false}
            rightElement={add ?? undefined}
          />
        </ItemGroup>
      );
    }
    const names = overrides.map((override) =>
      props.machineName(override.target.machineId),
    );
    const summary =
      overrides.length === 1
        ? t('capabilities.mcp.config.differentOne', { machine: names[0]! })
        : t('capabilities.mcp.config.differentCount', {
            count: overrides.length,
          });

    const remove = (override: McpServerConfigOverrideV1) => {
      const key = reachPlaceKeyV1(override.target);
      props.onChangeServer((current) => ({
        ...current,
        configOverrides: (current.configOverrides ?? []).filter(
          (item) => reachPlaceKeyV1(item.target) !== key,
        ),
        updatedAt: Date.now(),
      }));
      props.onCommit();
    };

    return (
      <ItemGroup testID="mcp.server.differences">
        <ExpandableItem
          testID="mcp.server.differences.toggle"
          expanded={expanded}
          onExpandedChange={setExpanded}
          header={({ headerProps }) => (
            <Item
              {...(headerProps as Readonly<Record<string, unknown>>)}
              title={t('capabilities.mcp.config.different')}
              detail={summary}
            />
          )}
        >
          {overrides.map((override, index) => {
            const machine = props.machineName(override.target.machineId);
            const title =
              override.target.t === 'workspace'
                ? t('capabilities.mcp.config.inFolderOn', {
                    folder: override.target.workspaceRoot,
                    machine,
                  })
                : machine;
            return (
              <Item
                key={reachPlaceKeyV1(override.target)}
                testID={`mcp.server.differences.row.${index}`}
                title={title}
                subtitle={describeOverride(override) || undefined}
                onPress={override.target.t === 'machine' ? () => edit(override.target, override) : undefined}
                icon={
                  <Icon
                    name="desktop"
                    size={20}
                    color={theme.colors.text.secondary}
                  />
                }
                showChevron={false}
                rightElementOutsidePressable
                rightElement={
                  <RoundButton
                    testID={`mcp.server.differences.row.${index}.remove`}
                    size="small"
                    display="inverted"
                    title={t('capabilities.mcp.config.removeDifference')}
                    onPress={() => remove(override)}
                  />
                }
              />
            );
          })}
          {add ? (
            <Item testID="mcp.server.differences.addRow" title={t('capabilities.mcp.config.addAnother')} showChevron={false} rightElement={add} />
          ) : null}
        </ExpandableItem>
      </ItemGroup>
    );
  },
);
