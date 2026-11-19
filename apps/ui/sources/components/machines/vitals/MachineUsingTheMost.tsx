import * as React from 'react';
import { Collection, useHappierCollection } from '@happier-dev/plugin-ui';
import type { MachineProcessesAnswerV1 } from '@happier-dev/protocol/machines/processes/machineProcessesV1';
import type { MachineVitalsSampleV1 } from '@happier-dev/protocol/machines/vitals/machineVitalsSampleV1';
import { StyleSheet } from 'react-native-unistyles';

import {
  buildProcessesSummaryRows,
  useProcessesCollectionAnatomy,
} from '@/components/machines/processes/processesCollectionAnatomy';
import { useProcessOwnerTitles } from '@/components/machines/processes/processOwnerIdentity';
import {
  buildMachineProcessesView,
  selectMachineProcessesTotals,
  type ProcessesItem,
  type ProcessesSort,
} from '@/components/machines/processes/processesPresentation';
import type { MachineProcessesState } from '@/sync/domains/machines/processes/machineProcessesStore';
import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';
import { CoreCollectionScope } from '@/components/ui/lists/collection/CoreCollectionScope';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SectionActionButton } from '@/components/ui/lists/SectionActionButton';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { usePreferredLanguage } from '@/text/usePreferredLanguage';
import { useDeviceType } from '@/utils/platform/responsive';

/** Lab `rv` O: the four biggest owners, then the two totals. The tab lists the rest. */
const USING_THE_MOST_OWNERS = 4;
const BY_MEMORY: ProcessesSort = { key: 'memory', direction: 'descending' };
const TABLE_MIN_WIDTH_PX = 520;
const keyOf = (item: ProcessesItem) => item.key;

/**
 * "Using the most" (VU-7): the Processes tab's own rows, read-only and owners only, biggest by memory, closed by
 * "Happier in total · N in Processes" and "Everything else on <machine>". Data is the Overview's attribution
 * owner (plan 30 owner totals beside this sample); nothing here samples or stores. A row, the count and the
 * section action all open the Processes tab.
 */
export const MachineUsingTheMost = React.memo(function MachineUsingTheMost(
  props: Readonly<{
    serverId: string;
    machineId: string;
    machineName: string;
    processes: MachineProcessesAnswerV1 | null;
    /** The Processes store's own status: a null answer is still being read only while it says `loading`. */
    processesStatus: MachineProcessesState['status'];
    /** An offline machine has no census to read; say that once, in the Processes tab's own words. */
    offline: boolean;
    nativePresenceWord?: string | null;
    sample: MachineVitalsSampleV1;
    cpuCapacityCores: number | null;
    onOpenProcesses: () => void;
  }>,
) {
  const language = usePreferredLanguage();
  const compact = useDeviceType() === 'phone';
  const answer =
    props.processes?.state === 'live' ? props.processes : null;
  const titles = useProcessOwnerTitles(answer?.owners, props.serverId);
  const items = React.useMemo(
    () =>
      answer
        ? buildMachineProcessesView({
            answer,
            scope: 'happier',
            sort: BY_MEMORY,
            ownersOnly: true,
            limit: USING_THE_MOST_OWNERS,
            ownerTitle: (owner) => titles.get(owner.rowId) ?? null,
          }).items
        : [],
    [answer, titles],
  );
  const { onOpenProcesses } = props;
  const onOpenChange = React.useCallback(
    (key: string | null) => {
      if (key) onOpenProcesses();
    },
    [onOpenProcesses],
  );
  const model = useHappierCollection<ProcessesItem>({
    items,
    keyOf,
    openKey: null,
    onOpenChange,
    expandable: false,
  });
  const anatomyInput = React.useMemo(
    () => ({
      serverId: props.serverId,
      machineId: props.machineId,
      machineName: props.machineName,
      titles,
      cpuCapacityCores: props.cpuCapacityCores,
      compact,
      readOnly: true,
    }),
    [
      compact,
      props.cpuCapacityCores,
      props.machineId,
      props.machineName,
      props.serverId,
      titles,
    ],
  );
  const anatomy = useProcessesCollectionAnatomy(anatomyInput);
  const { sample } = props;
  const summaryRows = React.useMemo(() => {
    if (!answer) return [];
    const totals = selectMachineProcessesTotals(answer, {
      usedMemoryBytes: sample.memory.reported ? sample.memory.usedBytes : null,
      cpuBusyPercent: sample.cpu.reported ? sample.cpu.busyPct : null,
    });
    return buildProcessesSummaryRows({
      totals,
      machineName: props.machineName,
      happierLink: (
        <TextLinkButton
          testID="machine-using-the-most-count"
          tone="strong"
          onPress={onOpenProcesses}
          label={t('machineVitals.usingTheMost.inProcesses', {
            count: totals.happier.processCount,
          })}
        />
      ),
    });
  }, [language, answer, onOpenProcesses, props.machineName, sample]);

  // The section keeps its place: while the census is first read, when it cannot be read, or when a finished read
  // found nothing Happier started, it says so in one quiet line instead of disappearing (and moving the page when
  // the answer lands). A null answer is "reading" only while the store is still reading; after a failure it is not.
  const quiet = items.length > 0 ? null : answer !== null
    ? { id: 'empty', kind: 'empty' as const, title: t('machineVitals.usingTheMost.empty', { machine: props.machineName }) }
    : props.offline
      ? { id: 'offline', kind: 'unavailable' as const,
          title: props.nativePresenceWord ? `${props.machineName} · ${props.nativePresenceWord}` : t('machineProcesses.states.offlineTitle', { machine: props.machineName }),
          reason: t('machineProcesses.states.offlineReason') }
    : props.processes === null && props.processesStatus === 'loading'
      ? { id: 'reading', kind: 'loading' as const, title: t('machineVitals.usingTheMost.reading') }
      : { id: 'unavailable', kind: 'unavailable' as const, title: t('machineVitals.usingTheMost.unavailable') };
  return (
    <ItemGroup
      title={t('machineVitals.usingTheMost.title')}
      titleAccessory={
        <Text style={styles.meta}>
          {t('machineVitals.usingTheMost.byWhatStartedIt')}
        </Text>
      }
      action={
        <SectionActionButton
          testID="machine-using-the-most-open"
          title={t('machineVitals.usingTheMost.processes')}
          icon="caret-right"
          onPress={onOpenProcesses}
        />
      }
    >
      {quiet ? (
        <SurfaceStateCard testID={`machine-using-the-most-${quiet.id}`} size="line" kind={quiet.kind} title={quiet.title}
          {...('reason' in quiet ? { reason: quiet.reason } : {})} />
      ) : (
      <CoreCollectionScope>
        <Collection<ProcessesItem>
          testID="machine-using-the-most"
          model={model}
          anatomy={anatomy}
          accessibilityLabel={t('machineVitals.usingTheMost.tableLabel', {
            machine: props.machineName,
          })}
          presentation={compact ? 'list' : 'table'}
          detail="none"
          scroll="page"
          minListWidth={TABLE_MIN_WIDTH_PX}
          minDetailWidth={TABLE_MIN_WIDTH_PX}
          preferredListRatio={1}
          summaryRows={summaryRows}
        />
      </CoreCollectionScope>
      )}
    </ItemGroup>
  );
});

const styles = StyleSheet.create((theme) => ({
  meta: {
    ...Typography.variant('meta'),
    color: theme.colors.text.secondary,
  },
}));
