import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import {
  CapacityBar,
  happierPageTextMetrics,
} from '@happier-dev/plugin-ui/presentation';

import { formatMachineBytes } from '@/components/machines/vitals/machineVitalsPresentation';
import { usePluginUiTheme } from '@/components/plugins/surfaces/pluginUiThemeProjection';
import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useMachineGuardView } from '@/sync/domains/machines/guard/useMachineGuardView';
import { useMachineResourceSummary } from '@/sync/domains/machines/resources/useMachineResourceSummary';
import { t } from '@/text';
import type { MachineGuardLadderV1 } from '@happier-dev/protocol/machines/guard/guardViewV1';

import { selectGuardKeptForProposal } from './resourceProposalPresentation';

/**
 * A stop proposal's context (plan 60 AGW-9, lab `ra` A3): what the one guard planner keeps and why
 * (its dry-run's `excluded` rows: working, waiting for you, …), listed without a checkbox, and the
 * machine's memory meter with the selected stops' return as its ghost. No agent-side heuristic.
 */
export const ResourceProposalProcessesContext = React.memo(
  function ResourceProposalProcessesContext(
    props: Readonly<{
      machineId: string;
      serverId: string | null;
      /** Census process refs the proposal itself asks to stop: they are never listed as kept. */
      proposedRefs: ReadonlySet<string>;
      selectedBytes: number;
    }>,
  ) {
    const guard = useMachineGuardView({ machineId: props.machineId, serverId: props.serverId });
    const summary = useMachineResourceSummary({ machineId: props.machineId, serverId: props.serverId });
    const kept = selectGuardKeptForProposal(guard.view?.ladder.excluded ?? [], props.proposedRefs);
    const memory = summary?.kind === 'reporting' ? (summary.summary?.memory ?? null) : null;
    const used = memory && memory.totalBytes !== null && memory.availableBytes !== null
      ? memory.totalBytes - memory.availableBytes : null;
    return <ResourceProposalProcessesContextView kept={kept} usedBytes={used}
      totalBytes={memory?.totalBytes ?? null} selectedBytes={props.selectedBytes} />;
  },
);

/** The presentation of {@link ResourceProposalProcessesContext}: kept rows with their reason, and the meter. */
export const ResourceProposalProcessesContextView = React.memo(
  function ResourceProposalProcessesContextView(
    props: Readonly<{
      kept: readonly MachineGuardLadderV1['excluded'][number][];
      usedBytes: number | null;
      totalBytes: number | null;
      selectedBytes: number;
    }>,
  ) {
    const { theme } = useUnistyles();
    const pluginTheme = usePluginUiTheme(theme);
    const { kept } = props;
    const used = props.usedBytes;
    const memory = props.totalBytes !== null ? { totalBytes: props.totalBytes } : null;
    return (
      <View testID="resource-proposal-processes-context">
        {kept.length > 0 ? (
          <View>
            <View style={styles.head}>
              <Icon name="lock" size={13} color={theme.colors.text.secondary} />
              <Text style={styles.headText}>
                {t('resourceProposal.keptByGuard')}
              </Text>
            </View>
            {kept.map((entry, index) => (
              <Item
                key={entry.ref}
                testID={`resource-proposal-kept-${entry.ref}`}
                title={entry.label ?? t('session.untitled')}
                subtitle={t(`machineGuard.reasons.${entry.reason}`)}
                mode="info"
                showDivider={index < kept.length - 1}
                leftElement={
                  <View style={styles.lead}>
                    <Icon
                      name="lock"
                      size={14}
                      color={theme.colors.text.tertiary}
                    />
                  </View>
                }
                rightElement={
                  entry.footprintBytes !== null ? (
                    <Text style={styles.size}>
                      {formatMachineBytes(entry.footprintBytes, 'memory')}
                    </Text>
                  ) : undefined
                }
              />
            ))}
          </View>
        ) : null}
        {memory && used !== null && memory.totalBytes !== null ? (
          <View testID="resource-proposal-memory" style={styles.meter}>
            <CapacityBar
              theme={pluginTheme}
              label={t('resourceProposal.memoryLabel')}
              value={used}
              capacity={memory.totalBytes}
              color={theme.colors.text.tertiary}
              trackColor={theme.colors.border.default}
              size="inline"
              showCaption={false}
              animated
              {...(props.selectedBytes > 0
                ? {
                    projection: 'remaining' as const,
                    projected: Math.max(0, used - props.selectedBytes),
                  }
                : {})}
            />
            <Text style={styles.caption}>
              {props.selectedBytes > 0
                ? t('resourceProposal.memoryAfter', {
                    now: formatMachineBytes(used, 'memory'),
                    after: formatMachineBytes(
                      Math.max(0, used - props.selectedBytes),
                      'memory',
                    ),
                  })
                : t('resourceProposal.memoryNow', {
                    now: formatMachineBytes(used, 'memory'),
                  })}
            </Text>
          </View>
        ) : null}
      </View>
    );
  },
);

const styles = StyleSheet.create((theme) => ({
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s6,
    paddingHorizontal: theme.space.s16,
    paddingTop: 14,
    paddingBottom: theme.space.s4,
  },
  headText: {
    ...Typography.default('semiBold'),
    ...happierPageTextMetrics('meta'),
    color: theme.colors.text.secondary,
  },
  lead: {
    width: 20,
    alignItems: 'center',
  },
  size: {
    ...Typography.default(),
    ...happierPageTextMetrics('rowTitle'),
    color: theme.colors.text.secondary,
    fontVariant: ['tabular-nums'],
  },
  meter: {
    gap: theme.space.s6,
    paddingHorizontal: theme.space.s16,
    paddingVertical: theme.space.s12,
  },
  caption: {
    ...Typography.default(),
    ...happierPageTextMetrics('rowDescription'),
    color: theme.colors.text.secondary,
    fontVariant: ['tabular-nums'],
  },
}));
