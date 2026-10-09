import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { PROJECT_ACTION_INPUT_SCHEMAS_V1 } from '@happier-dev/protocol/actions/projectActionFamily';
import type { ApprovalRequest } from '@happier-dev/protocol';
import type { ProjectExecutionChoiceV1 } from '@happier-dev/protocol/workspaces/projectWorkerPreferencesV1';

import { Icon } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import {
  useMachinePoolListForServer,
  useServerScopedMachine,
} from '@/sync/store/hooks';
import { t } from '@/text';
import { getMachineDisplayName } from '@/utils/sessions/machineDisplayNames';

export type ProjectCommandApprovalPresentation =
  | Readonly<{
      kind: 'exec';
      serverId: string;
      sourceMachineId: string;
      command: string;
      cwd: string;
      destination: Destination;
    }>
  | Readonly<{
      kind: 'script';
      serverId: string;
      sourceMachineId: string;
      name: string;
      destination: Destination;
    }>;
type Destination =
  | Readonly<{ kind: 'primary' }>
  | Readonly<{ kind: 'machine'; machineId: string }>
  | Readonly<{ kind: 'pool'; poolId: string }>;

/**
 * An agent's finite Project command waiting on the person's configurable Action approval (lab `s-agent`
 * ADHOC, plan 21 §6): the exact command, where it would run, what files it sees and as whom. It reads the
 * request's own strict Action input; it decides nothing and grants no setup consent.
 */
export function readProjectCommandApproval(
  approval: Pick<ApprovalRequest, 'actionId' | 'actionArgs'>,
): ProjectCommandApprovalPresentation | null {
  if (approval.actionId === 'projects.compute.exec') {
    const input = PROJECT_ACTION_INPUT_SCHEMAS_V1[
      'projects.compute.exec'
    ].safeParse(approval.actionArgs);
    if (!input.success) return null;
    const { workspace, executable, argv, cwd, choice } = input.data;
    return {
      kind: 'exec',
      serverId: workspace.serverId,
      sourceMachineId: workspace.machineId,
      command: [executable, ...argv].join(' '),
      cwd,
      destination: readDestination(choice),
    };
  }
  if (approval.actionId === 'projects.script.run') {
    const input = PROJECT_ACTION_INPUT_SCHEMAS_V1[
      'projects.script.run'
    ].safeParse(approval.actionArgs);
    if (!input.success) return null;
    const { workspace, selection, choice } = input.data;
    const name =
      selection.kind === 'named'
        ? selection.name
        : `${selection.source.file}#${selection.source.target}`;
    return {
      kind: 'script',
      serverId: workspace.serverId,
      sourceMachineId: workspace.machineId,
      name,
      destination: readDestination(choice),
    };
  }
  return null;
}

function readDestination(choice: ProjectExecutionChoiceV1 | undefined): Destination {
  if (!choice || choice.kind === 'primary') return { kind: 'primary' };
  return choice.destination.kind === 'machine'
    ? { kind: 'machine', machineId: choice.destination.machineId }
    : { kind: 'pool', poolId: choice.destination.poolId };
}

/** The card's question: one-off commands and named Scripts ask differently; a worker is named as such. */
export function describeProjectCommandApprovalTitle(
  presentation: ProjectCommandApprovalPresentation,
): string {
  if (presentation.kind === 'script')
    return t('projects.scripts.adhocRunScriptTitle', { name: presentation.name });
  return presentation.destination.kind === 'primary'
    ? t('projects.scripts.adhocTitle')
    : t('projects.scripts.adhocTitleWorker');
}

export const ProjectCommandApprovalFacts = React.memo(
  function ProjectCommandApprovalFacts(
    props: Readonly<{
      presentation: ProjectCommandApprovalPresentation;
      testID: string;
    }>,
  ) {
    const { theme } = useUnistyles();
    const { presentation } = props;
    const destination = presentation.destination;
    const source = useServerScopedMachine(
      presentation.serverId,
      presentation.sourceMachineId,
    );
    const target = useServerScopedMachine(
      presentation.serverId,
      destination.kind === 'machine' ? destination.machineId : '',
    );
    const pools = useMachinePoolListForServer(presentation.serverId);
    const sourceName =
      getMachineDisplayName(source) ?? presentation.sourceMachineId;
    const pool =
      destination.kind === 'pool'
        ? (pools?.find((candidate) => candidate.id === destination.poolId) ??
          null)
        : null;
    const where =
      destination.kind === 'primary'
        ? sourceName
        : destination.kind === 'machine'
          ? (getMachineDisplayName(target) ?? destination.machineId)
          : t('projects.scripts.adhocWherePool', {
              pool: pool?.name ?? destination.poolId,
            });
    const runsOn =
      destination.kind === 'primary'
        ? source
        : destination.kind === 'machine'
          ? target
          : null;
    const runsAs =
      runsOn?.isShared && runsOn.metadata?.username
        ? t('projects.scripts.adhocAsUser', {
            user: runsOn.metadata.username,
            machine: where,
          })
        : destination.kind === 'pool'
          ? t('projects.scripts.adhocAsYouAnywhere')
          : t('projects.scripts.adhocAsYou', { machine: where });
    const rows: ReadonlyArray<readonly [string, string, string]> = [
      ['where', t('projects.scripts.adhocWhere'), where],
      [
        'files',
        t('projects.scripts.adhocFiles'),
        destination.kind === 'primary'
          ? t('projects.scripts.adhocFilesHere')
          : t('projects.scripts.adhocFilesCopy', { machine: sourceName }),
      ],
      ['as', t('projects.scripts.adhocAs'), runsAs],
    ];
    return (
      <View style={styles.root} testID={props.testID}>
        <View
          style={[
            styles.command,
            { backgroundColor: theme.colors.surface.inset },
          ]}
        >
          <Text
            style={[styles.mono, { color: theme.colors.text.primary }]}
            testID={`${props.testID}.command`}
          >
            {presentation.kind === 'exec'
              ? `$ ${presentation.command}`
              : presentation.name}
          </Text>
        </View>
        <View style={styles.rows}>
          {rows.map(([key, label, value]) => (
            <View key={key} style={styles.row}>
              <Text
                style={[styles.label, { color: theme.colors.text.tertiary }]}
              >
                {label}
              </Text>
              <Text
                style={[styles.value, { color: theme.colors.text.secondary }]}
                testID={`${props.testID}.${key}`}
              >
                {value}
              </Text>
            </View>
          ))}
        </View>
        {presentation.kind === 'exec' ? (
          <View
            style={[
              styles.note,
              { borderTopColor: theme.colors.border.subtle },
            ]}
          >
            <Icon name="info" size={12} color={theme.colors.text.tertiary} />
            <Text
              style={[styles.noteText, { color: theme.colors.text.tertiary }]}
            >
              {t('projects.scripts.adhocAllowedBy')}
            </Text>
          </View>
        ) : null}
      </View>
    );
  },
);

const styles = StyleSheet.create(() => ({
  root: { gap: 10 },
  command: { borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8 },
  mono: { ...Typography.mono(), fontSize: 12, lineHeight: 18 },
  rows: { gap: 4 },
  row: { flexDirection: 'row', gap: 12 },
  label: { fontSize: 12, lineHeight: 17, width: 52 },
  value: { fontSize: 12, lineHeight: 17, flex: 1, minWidth: 0 },
  note: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 6,
    paddingTop: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  noteText: { fontSize: 11, lineHeight: 16, flex: 1, minWidth: 0 },
}));
