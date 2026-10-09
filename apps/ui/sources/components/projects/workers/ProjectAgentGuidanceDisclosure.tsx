import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';
import type { WorkspaceAddressV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';

import {
  readProjectSetupAgentGuidance,
  type ProjectSetupAgentGuidance,
} from '@/components/projects/projectSetup/projectSetupAuthoring';
import { ExpandableItem } from '@/components/ui/lists/ExpandableItem';
import { Item } from '@/components/ui/lists/Item';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

const RUN_COMMAND = 'happier project script run <name> [--on <machine>]';
const EXEC_COMMAND = 'happier project compute exec -- <argv>';

/**
 * The read-only facts as agents receive them, in reading order (lab `s-agent` GUIDE): which scripts
 * may leave the checkout, how to run one, and whether explicit ad-hoc commands are allowed. Advisory
 * facts only: nothing here is approval or an accepted placement.
 */
export function describeProjectAgentGuidance(
  guidance: ProjectSetupAgentGuidance,
  project: string,
): string {
  const scripts = guidance.scripts ?? [];
  const portable = scripts
    .filter((script) => script.execution === 'portable')
    .map((script) => script.name);
  const primary = scripts
    .filter((script) => script.execution !== 'portable')
    .map((script) => script.name);
  const width =
    Math.max(portable.join(', ').length, primary.join(', ').length) + 2;
  const line = (names: readonly string[], note: string) =>
    `${names.join(', ').padEnd(width)}${note}`;
  const adHocOn = guidance.adHoc.resolution.status === 'resolved';
  return [
    `# ${t('projectWorkers.guideHeader', { project })}`,
    ...(portable.length > 0
      ? [line(portable, t('projectWorkers.guideWorker'))]
      : []),
    ...(primary.length > 0
      ? [line(primary, t('projectWorkers.guidePrimary'))]
      : []),
    ...(scripts.length === 0 ? [t('projectWorkers.guideNoScripts')] : []),
    '',
    `${t('projectWorkers.guideRunOne')}  ${RUN_COMMAND}`,
    `  · ${t('projectWorkers.guideOutput')}`,
    `  · ${t('projectWorkers.guideQueue')}`,
    `  · ${t('projectWorkers.guideExit')}`,
    '',
    `${t('projectWorkers.guideOther')}  ${EXEC_COMMAND}`,
    `  · ${adHocOn ? t('projectWorkers.guideAdHocOn') : t('projectWorkers.guideAdHocOff')}`,
  ].join('\n');
}

type GuidanceRead =
  | Readonly<{ kind: 'loading' }>
  | Readonly<{ kind: 'ready'; text: string }>
  | Readonly<{ kind: 'unavailable' }>;

/**
 * "What agents are told" (R3b-07): a disclosure on Scripts › Agents that demand-reads the factual
 * owner (`readProjectSetupAgentGuidance`) only while open, and re-reads when the project file or the
 * checkout's worker preferences change (`factsKey`).
 */
export function ProjectAgentGuidanceDisclosure(
  props: Readonly<{
    testID: string;
    workspace: WorkspaceAddressV1;
    /** Identity of the facts it is generated from (definition basis + observed preference revision). */
    factsKey: string;
    showDivider?: boolean;
  }>,
) {
  const { theme } = useUnistyles();
  const [expanded, setExpanded] = React.useState(false);
  const [read, setRead] = React.useState<Readonly<{
    key: string;
    value: GuidanceRead;
  }> | null>(null);
  const project =
    props.workspace.rootPath.split(/[\\/]/).filter(Boolean).pop() ??
    props.workspace.rootPath;
  const key = JSON.stringify([
    props.factsKey,
    props.workspace.serverId,
    props.workspace.workspaceId,
  ]);

  React.useEffect(() => {
    if (!expanded) return;
    const controller = new AbortController();
    setRead((current) =>
      current?.key === key ? current : { key, value: { kind: 'loading' } },
    );
    void readProjectSetupAgentGuidance({
      workspace: props.workspace,
      page: 'scripts',
      signal: controller.signal,
    }).then(
      (result) => {
        if (controller.signal.aborted) return;
        setRead({
          key,
          value:
            result.kind === 'ready'
              ? {
                  kind: 'ready',
                  text: describeProjectAgentGuidance(result.guidance, project),
                }
              : { kind: 'unavailable' },
        });
      },
      () => {
        if (!controller.signal.aborted)
          setRead({ key, value: { kind: 'unavailable' } });
      },
    );
    return () => controller.abort();
    // The workspace fields are part of `key`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded, key, project]);

  const value = read?.key === key ? read.value : { kind: 'loading' as const };
  return (
    <ExpandableItem
      testID={props.testID}
      expanded={expanded}
      onExpandedChange={setExpanded}
      showDivider={props.showDivider}
      header={({ headerProps }) => (
        <Item
          {...(headerProps as Readonly<Record<string, unknown>>)}
          title={t('projectWorkers.guideTitle')}
          subtitle={t('projectWorkers.guideDetail')}
        />
      )}
    >
      {!expanded ? null : value.kind === 'ready' ? (
        <View
          style={[
            styles.block,
            {
              backgroundColor: theme.colors.surface.base,
              borderColor: theme.colors.border.subtle,
            },
          ]}
        >
          <Text
            testID={`${props.testID}.text`}
            selectable
            style={[styles.mono, { color: theme.colors.text.secondary }]}
          >
            {value.text}
          </Text>
        </View>
      ) : (
        <SurfaceStateCard
          size="line"
          testID={`${props.testID}.state`}
          kind={value.kind === 'loading' ? 'loading' : 'unavailable'}
          title={
            value.kind === 'loading'
              ? t('common.loading')
              : t('projectWorkers.guideUnavailable')
          }
        />
      )}
    </ExpandableItem>
  );
}

const styles = StyleSheet.create(() => ({
  block: {
    marginHorizontal: 16,
    marginBottom: 12,
    padding: 12,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
  },
  mono: { ...Typography.mono(), ...happierPageTextMetrics('rowDescription') },
}));
