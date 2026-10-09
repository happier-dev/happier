import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';
import { HappierRadioMark } from '@happier-dev/plugin-ui/presentation';

import { projectPluginUiTheme } from '@/components/plugins/surfaces/pluginUiThemeProjection';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { FieldValueItem } from '@/components/ui/forms/FieldValueItem';
import {
  DropdownMenu,
  type DropdownMenuItem,
} from '@/components/ui/forms/dropdown/DropdownMenu';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { StatusDot } from '@/components/ui/status/StatusDot';
import { t } from '@/text';

import type { ProjectOpenUse } from './projectOpenChoices';

/** What the Where row says about the chosen Machine, from the presence owner and the checkouts it holds. */
export type ProjectOpenWhereStatus =
  | Readonly<{ kind: 'none' }>
  | Readonly<{ kind: 'online'; platform: string; checkoutsHere: string | null }>
  | Readonly<{ kind: 'offline'; machineName: string }>;

/**
 * "Where" (lab `openForm` Where, `OPEN_S` cell 5): one identity row — the Machine's mark, its name
 * once, and a status line — with a quiet Change (Pick another when it is offline). On a phone the
 * row itself is the push target.
 */
export const ProjectOpenWhereRow = React.memo(function ProjectOpenWhereRow(
  props: Readonly<{
    items: readonly DropdownMenuItem[];
    selectedId: string | null;
    machineName: string | null;
    status: ProjectOpenWhereStatus;
    compact: boolean;
    onSelect: (machineId: string) => void;
  }>,
) {
  const { theme } = useUnistyles();
  const [open, setOpen] = React.useState(false);
  const status = props.status;
  const subtitle =
    status.kind === 'online'
      ? [t('projects.open.online'), status.platform, status.checkoutsHere]
          .filter(Boolean)
          .join(' · ')
      : status.kind === 'offline'
        ? t('projects.open.offline', { machine: status.machineName })
        : undefined;
  const changeLabel =
    status.kind === 'offline'
      ? t('projects.open.pickAnother')
      : props.machineName
        ? t('projects.open.change')
        : t('common.choose');
  return (
    <ItemGroup title={t('projects.open.where')}>
      <DropdownMenu
        testID="projects.open.where"
        open={open}
        onOpenChange={setOpen}
        items={props.items}
        selectedId={props.selectedId}
        onSelect={(id) => {
          setOpen(false);
          props.onSelect(id);
        }}
        trigger={({ toggle }) => (
          <Item
            testID="projects.open.where.row"
            title={props.machineName ?? t('projects.open.chooseMachine')}
            subtitle={subtitle}
            subtitleLeading={
              status.kind === 'online' ? (
                <StatusDot color={theme.colors.status.connected} size={6} />
              ) : undefined
            }
            icon={
              <Icon
                name="desktop"
                size={ICON_SIZE.md}
                color={theme.colors.text.secondary}
              />
            }
            onPress={toggle}
            showChevron={props.compact}
            {...(props.compact
              ? {}
              : {
                  rightElementOutsidePressable: true,
                  rightElement: (
                    <RoundButton
                      testID="projects.open.where.change"
                      size="small"
                      display="secondary"
                      title={changeLabel}
                      onPress={toggle}
                    />
                  ),
                })}
          />
        )}
      />
    </ItemGroup>
  );
});

export type ProjectOpenUseRowModel = Readonly<{
  use: ProjectOpenUse;
  title: string;
  subtitle: string | undefined;
}>;

/**
 * "Use" (lab `openForm` Use): the reachable ways to open, existing first. Two or more are a radio
 * group; exactly one is a statement, not a choice. The selected clone or copy carries its
 * destination inline with a quiet Change; a worktree names its new branch under its row.
 */
export const ProjectOpenUseSection = React.memo(function ProjectOpenUseSection(
  props: Readonly<{
    rows: readonly ProjectOpenUseRowModel[];
    selected: ProjectOpenUse | null;
    destination: string;
    destinationPlaceholder: string;
    branch: string;
    onSelect: (use: ProjectOpenUse) => void;
    onChangeDestination: (path: string) => void;
    onChangeBranch: (branch: string) => void;
  }>,
) {
  const { theme } = useUnistyles();
  const presentationTheme = React.useMemo(
    () => projectPluginUiTheme(theme),
    [theme],
  );
  const [editingDestination, setEditingDestination] = React.useState(false);
  if (props.rows.length === 0) return null;
  const choice = props.rows.length > 1;
  return (
    <ItemGroup
      title={t('projects.open.use')}
      description={t('projects.open.noAgent')}
      {...(choice ? { accessibilityRole: 'radiogroup' as const } : {})}
    >
      {props.rows.flatMap((row, index) => {
        const selected = choice ? row.use === props.selected : true;
        const carriesDestination =
          selected && (row.use === 'clone' || row.use === 'copy');
        // Copy always names its target; a clone shows its suggested folder until Change or an empty one asks.
        const showDestination =
          carriesDestination &&
          (row.use === 'copy' ||
            editingDestination ||
            !props.destination.trim());
        const nodes: React.ReactNode[] = [
          <Item
            key={row.use}
            testID={`projects.open.use.${row.use}`}
            title={row.title}
            subtitle={row.subtitle}
            showChevron={false}
            {...(choice
              ? {
                  leftElement: (
                    <HappierRadioMark
                      selected={selected}
                      theme={presentationTheme}
                    />
                  ),
                  accessibilityRole: 'radio' as const,
                  accessibilityChecked: selected,
                  itemGroupRadioIndex: index,
                  selected,
                  onPress: () => props.onSelect(row.use),
                }
              : props.selected !== row.use
                ? {
                    // A draft retained before its only way was taken: pressing the statement takes it.
                    onPress: () => props.onSelect(row.use),
                  }
                : {})}
            {...(row.use === 'clone' && selected && !showDestination
              ? {
                  rightElementOutsidePressable: true,
                  rightElement: (
                    <RoundButton
                      testID="projects.open.destination.change"
                      size="small"
                      display="inverted"
                      title={t('projects.open.change')}
                      onPress={() => setEditingDestination(true)}
                    />
                  ),
                }
              : {})}
          />,
        ];
        if (showDestination) {
          nodes.push(
            <FieldValueItem
              key={`${row.use}:destination`}
              testID="projects.open.destination"
              title={t('projects.open.folder')}
              value={props.destination}
              placeholder={props.destinationPlaceholder}
              autoCapitalize="none"
              monospace
              autoFocus={editingDestination}
              onCommit={(text) => {
                props.onChangeDestination(text);
                if (text.trim()) setEditingDestination(false);
                return text;
              }}
              onDraftChange={(text) => {
                // Typing keeps the field until it commits, even when it opened because the folder was empty.
                setEditingDestination(true);
                props.onChangeDestination(text);
              }}
            />,
          );
        }
        if (selected && row.use === 'worktree') {
          nodes.push(
            <FieldValueItem
              key="worktree:branch"
              testID="projects.open.branchName"
              title={t('projects.open.branch')}
              value={props.branch}
              autoCapitalize="none"
              onCommit={(text) => {
                props.onChangeBranch(text.trim());
                return text.trim();
              }}
              onDraftChange={props.onChangeBranch}
            />,
          );
        }
        return nodes;
      })}
    </ItemGroup>
  );
});
