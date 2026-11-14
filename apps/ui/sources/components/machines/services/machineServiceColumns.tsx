import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { Status, type CollectionField } from '@happier-dev/plugin-ui';
import type { MachineServiceRowV1 } from '@happier-dev/protocol';

import { formatMachineBytes } from '@/components/machines/vitals/machineVitalsPresentation';
import { describeMachineUptime, describeMachineUptimeSpan } from '@/components/machines/vitals/vitalsFormat';
import { InlineCode } from '@/components/ui/text/InlineCode';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

import {
  machineServiceExpectedStop,
  machineServiceHealthQualifier,
  machineServiceIdentityLine,
  machineServiceRunFacts,
  machineServiceStateSpeaks,
  machineServiceStateTone,
} from './machineServicesPresentation';

/** The port a service listens on, as a mono chip: the phone row's end column and the wide page's Ports column. */
export function renderMachineServicePort(
  row: MachineServiceRowV1,
): React.ReactNode {
  return row.port == null ? null : (
    <InlineCode testID={`machine-service-${row.serviceId}:port`}>
      {String(row.port)}
    </InlineCode>
  );
}

/**
 * A service row's Ports, Memory and Up columns (lab `services/list`), lined up down the page and left to the byline
 * on a phone. Machine → Services and Services → Watched draw the same columns; `serviceOf` picks the service an item
 * stands for (none: the cells stay empty).
 */
export function machineServiceColumnFields<Item>(
  serviceOf: (item: Item) => MachineServiceRowV1 | null,
): CollectionField<Item>[] {
  return [
    {
      key: 'port',
      title: t('machineServices.columns.port'),
      minWidth: 64,
      priority: 3,
      listColumn: true,
      render: (item) => {
        const row = serviceOf(item);
        return row ? renderMachineServicePort(row) : null;
      },
    },
    {
      key: 'memory',
      title: t('machineServices.columns.memory'),
      align: 'end',
      minWidth: 64,
      priority: 2,
      listColumn: true,
      render: (item) => {
        const row = serviceOf(item);
        const memoryBytes = row
          ? machineServiceRunFacts(row, Date.now()).memoryBytes
          : null;
        return memoryBytes === null
          ? null
          : formatMachineBytes(memoryBytes, 'memory');
      },
    },
    {
      key: 'up',
      title: t('machineServices.columns.up'),
      align: 'end',
      minWidth: 64,
      priority: 1,
      listColumn: true,
      render: (item) => {
        const row = serviceOf(item);
        const upMs = row ? machineServiceRunFacts(row, Date.now()).upMs : null;
        return upMs === null
          ? null
          : describeMachineUptimeSpan(Date.now() - upMs, Date.now());
      },
    },
  ];
}

const NO_RUN_FACTS = Object.freeze({ memoryBytes: null, upMs: null });

/** The list row's second line: the state only when it needs the person, then what the service is. */
export function MachineServiceByline(props: Readonly<{
  row: MachineServiceRowV1;
  runFactsInColumns: boolean;
  /** A State column says the state (Services → Watched): the line keeps only what the service is. */
  stateInColumn?: boolean;
}>) {
  const { row } = props;
  const { theme } = useUnistyles();
  const identity = machineServiceIdentityLine(row);
  // A running service its own health source hasn't verified says so quietly (lab: "running, no health check").
  const qualifier = machineServiceHealthQualifier(row);
  const health = qualifier ? t('machineServices.health.running', { health: t(`machineServices.health.${qualifier}`) }) : null;
  // What its source reported about the run (lab Memory and Up): only known values, never a zero for unknown.
  // Its own columns say them on a wide page.
  const run = props.runFactsInColumns ? NO_RUN_FACTS : machineServiceRunFacts(row, Date.now());
  const memory = run.memoryBytes === null ? null : formatMachineBytes(run.memoryBytes, 'memory');
  // Up reads like the Machine header's own Up ("Up 1 d 4 h"), from the service's last start.
  const up = run.upMs === null ? null : describeMachineUptime(Date.now() - run.upMs, Date.now());
  const native = [identity, health, memory, up].filter(Boolean).join(' · ') || null;
  // A stop the person asked for reads as that stop, quiet (lab `services/states` "Stopped by you"), never as a failure.
  const expectedStop = machineServiceExpectedStop(row);
  const speaks = props.stateInColumn !== true && (expectedStop !== null || machineServiceStateSpeaks(row.state));
  if (!speaks && !native) return null;
  return (
    // Bounded to the row's text column so a long line ends in an ellipsis at the card edge on a phone, never past it;
    // the full facts are on the service's page.
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.space.s4, minWidth: 0, maxWidth: '100%', alignSelf: 'stretch' }}>
      {speaks ? (
        <Status
          tone={expectedStop ? 'secondary' : machineServiceStateTone(row.state)}
          label={expectedStop ? t(`machineServices.expectedDown.${expectedStop}`) : t(`machineServices.state.${row.state}`)}
          presentation="inline"
        />
      ) : null}
      {native ? <Text style={{ ...Typography.variant('meta'), color: theme.colors.text.secondary, flexShrink: 1 }} numberOfLines={1}>
        {speaks ? `· ${native}` : native}
      </Text> : null}
    </View>
  );
}

/**
 * A service's state word (lab svcWatch State): a stop the person asked for reads as that stop, a state that needs the
 * person speaks in its tone, and a quiet one ("Running") stays quiet.
 */
export function MachineServiceStateWord(props: Readonly<{ row: MachineServiceRowV1 }>) {
  const expectedStop = machineServiceExpectedStop(props.row);
  const speaks = expectedStop === null && machineServiceStateSpeaks(props.row.state);
  return (
    <Status
      tone={speaks ? machineServiceStateTone(props.row.state) : 'secondary'}
      label={expectedStop ? t(`machineServices.expectedDown.${expectedStop}`) : t(`machineServices.state.${props.row.state}`)}
      presentation="inline"
    />
  );
}

/** The State column beside Ports, Memory and Up; an item without its service read draws the column's quiet dash. */
export function machineServiceStateField<Item>(serviceOf: (item: Item) => MachineServiceRowV1 | null): CollectionField<Item> {
  return {
    key: 'state', title: t('projects.deployments.services.columnState'), minWidth: 120, priority: 4, align: 'end', listColumn: true,
    render: (item) => {
      const row = serviceOf(item);
      return row ? <MachineServiceStateWord row={row} /> : null;
    },
  };
}
