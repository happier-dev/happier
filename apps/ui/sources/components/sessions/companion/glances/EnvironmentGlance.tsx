import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import { useSessionMachineName } from '@/components/sessions/agents/presentation/useSessionMachineName';
import { GitBranchButton } from '@/components/sessions/panes/git/branches/GitBranchButton';
import { useSessionBranchWritesBlocked } from '@/components/sessions/panes/git/branches/useSessionBranchWritesBlocked';
import { buildSessionScmSummary } from '@/components/sessions/sourceControl/status/statusSummary';
import { Icon, ICON_SIZE, type IconName } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import {
  WidgetFrame,
  type WidgetFrameStyle,
} from '@/components/widgets/frame/WidgetFrame';
import { DiffStat } from '@/components/workspaces/scm/DiffStat';
import type { Session } from '@/sync/domains/state/storageTypes';
import { useSessionProjectScmSummarySnapshot } from '@/sync/store/hooks';
import { t } from '@/text';
import { formatPathRelativeToHome } from '@/utils/sessions/formatPathRelativeToHome';

import {
  resolveEnvironmentSectionRows,
  type EnvironmentSectionRow,
} from './glanceModels';
import { useOpenSessionCompanionPane } from './PaneLinkRow';

const ROW_ICON: Readonly<Record<EnvironmentSectionRow['kind'], IconName>> = {
  changes: 'file-diff',
  place: 'laptop',
  branch: 'git-branch',
  commit: 'git-commit',
};
/** Where each row leads: the pane that owns the fact (Git owns changes and the commit composer). The branch row switches in place. */
const ROW_PANE: Readonly<Record<Exclude<EnvironmentSectionRow['kind'], 'branch'>, string>> = {
  changes: 'git',
  place: 'files',
  commit: 'git',
};

/**
 * The Environment section (lab crows B): what changed, where the Session runs, its branch, and Commit
 * while there is something to commit. It reads the counts snapshot (no file-list demand), the Session's
 * Machine label and its folder. Each row opens the pane that owns its fact; the branch row opens the Git
 * pane's own branch list in place.
 */
export function EnvironmentGlance(
  props: Readonly<{
    session: Session;
    sessionId: string;
    serverId: string | null;
    frameStyle: WidgetFrameStyle;
    presentation?: 'frame' | 'body';
    menu?: React.ReactNode;
    /** A configured copy outside the Session opens its Session instead of a pane beside the chat. */
    onOpenPane?: (paneId: string) => void;
    measurementOnly: boolean;
    testID: string;
  }>,
) {
  const { theme } = useUnistyles();
  const snapshot = useSessionProjectScmSummarySnapshot(
    props.sessionId,
    props.serverId,
  );
  const machineName = useSessionMachineName(props.sessionId, props.serverId);
  const path = props.session.metadata?.path ?? null;
  const homeDir = props.session.metadata?.homeDir ?? null;
  const rows = React.useMemo(
    () =>
      resolveEnvironmentSectionRows({
        scm: buildSessionScmSummary(snapshot),
        machineName,
        folder: path ? formatPathRelativeToHome(path, homeDir) : null,
      }),
    [homeDir, machineName, path, snapshot],
  );
  const openSessionPane = useOpenSessionCompanionPane(
    props.sessionId,
    props.serverId,
  );
  const openPane = props.measurementOnly
    ? undefined
    : (props.onOpenPane ?? openSessionPane);
  const branchWrites = useSessionBranchWritesBlocked(
    props.sessionId,
    props.serverId,
  );
  if (rows.length === 0) return null;
  const icon = (kind: EnvironmentSectionRow['kind']) => (
    <Icon
      name={ROW_ICON[kind]}
      size={ICON_SIZE.sm}
      color={theme.colors.text.secondary}
    />
  );
  return (
    <WidgetFrame
      testID={props.testID}
      presentation={props.presentation}
      frameStyle={props.frameStyle}
      placement="companion"
      mark="desktop"
      title={t('sessionCompanion.sections.environment')}
      menu={props.menu}
      body={{
        kind: 'content',
        children: rows.map((row) => {
          const pane = row.kind === 'branch' ? null : ROW_PANE[row.kind];
          const onPress =
            openPane && pane ? () => openPane(pane) : undefined;
          const common = {
            testID: `${props.testID}.${row.kind}`,
            density: 'compact' as const,
            icon: icon(row.kind),
            ...(onPress ? { onPress } : { mode: 'info' as const }),
          };
          switch (row.kind) {
            case 'changes':
              return (
                <Item
                  key={row.kind}
                  {...common}
                  title={t('widgetGlances.changesTitle')}
                  {...(row.hasLineChanges
                    ? {
                        rightElement: (
                          <DiffStat
                            added={row.linesAdded}
                            removed={row.linesRemoved}
                          />
                        ),
                        keepChevronWithRightElement: true,
                      }
                    : {
                        detail:
                          row.changedFiles > 0
                            ? t('widgetGlances.changedCount', {
                                count: row.changedFiles,
                              })
                            : t('widgetGlances.noChanges'),
                      })}
                />
              );
            case 'place':
              return (
                <Item
                  key={row.kind}
                  {...common}
                  title={row.machine ?? row.folder ?? ''}
                  titleQualifier={row.machine ? row.folder : null}
                  accessibilityLabel={
                    row.machine && row.folder
                      ? t('sessionCompanion.sections.machineFolderA11y', {
                          machine: row.machine,
                          folder: row.folder,
                        })
                      : undefined
                  }
                />
              );
            case 'branch':
              return openPane ? (
                <GitBranchButton
                  key={row.kind}
                  sessionId={props.sessionId}
                  serverId={props.serverId ?? undefined}
                  snapshot={snapshot}
                  disabled={branchWrites.blocked}
                  onOpenStashDetails={() => openPane('git')}
                  renderTrigger={(trigger) => (
                    <Item
                      testID={common.testID}
                      density="compact"
                      icon={common.icon}
                      title={row.name}
                      rightElement={
                        <Icon
                          name={trigger.open ? 'caret-up' : 'caret-down'}
                          size={ICON_SIZE.xs}
                          color={theme.colors.text.tertiary}
                        />
                      }
                      accessibilityLabel={trigger.accessibilityLabel}
                      accessibilityExpanded={trigger.open}
                      disabled={trigger.disabled}
                      onPress={trigger.onToggle}
                    />
                  )}
                />
              ) : (
                <Item key={row.kind} {...common} title={row.name} />
              );
            case 'commit':
              return (
                <Item
                  key={row.kind}
                  {...common}
                  title={t('sessionCompanion.sections.commit')}
                  detail={t('sessionCompanion.sections.filesCount', {
                    count: row.files,
                  })}
                />
              );
          }
        }),
      }}
    />
  );
}
