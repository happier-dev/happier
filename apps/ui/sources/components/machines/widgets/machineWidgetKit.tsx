import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { useWidgetPresentation } from '@happier-dev/plugin-ui';
import type { JsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { MachineTargetV1Schema } from '@happier-dev/protocol/machines/machineAccessV1';
import type { WidgetSizeV1 } from '@happier-dev/protocol/widgets';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { machinePageHref } from '@/components/machines/page/machinePageHref';
import type { MachinePageTabParams } from '@/components/machines/page/machinePageTabQuery';
import { useMachinesDoor } from '@/components/machines/page/machinesDoor';
import { ItemLoadStateRows } from '@/components/ui/lists/ItemLoadStateRows';
import { SurfaceAsOfLabel } from '@/components/ui/surfaces/SurfaceAsOfLabel';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { useWidgetFrameBodyMeta } from '@/components/widgets/frame/widgetFrameBodyCaption';
import { Typography } from '@/constants/Typography';
import { resolveServerScopedMachine } from '@/sync/domains/machines/resolveServerScopedMachine';
import { storage } from '@/sync/domains/state/storageStore';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { t } from '@/text';
import { usePreferredLanguage } from '@/text/usePreferredLanguage';
import { getMachineDisplayName, isMachineDisplayHydrating } from '@/utils/sessions/machineDisplayNames';
import { useMachinePresenceSummary } from '@/components/sessions/model/useMachinePresenceSummary';
import { formatLastSeen } from '@/utils/sessions/sessionUtils';
import { runGuardedNavigation } from '@/utils/navigation/runGuardedNavigation';
import { fireAndForget } from '@/utils/system/fireAndForget';

/**
 * The shared vocabulary of the ten Machine widget bodies (plan 60 EU-6). It reads nothing of its own: the
 * machine comes from the widget's admitted `machine` input, its facts from the machine list owner, and
 * every value from the owner hooks the Machine page tabs use (AGW-16). It decides only how a body names
 * its machine, its size, its freshness and the states every body shares.
 */

export type MachineWidgetTarget = Readonly<{
  serverId: string;
  machineId: string;
}>;
export type MachineWidgetBodyProps = Readonly<{
  /** The platform binder's resolved input (widget value → group → surface slot). */
  input: Readonly<Record<string, JsonValue>>;
  serverId: string;
  testID: string;
}>;

/** The qualified machine the widget shows, or `null` when the binder supplied none (Activity: all machines). */
export function readMachineWidgetTarget(
  input: Readonly<Record<string, JsonValue>>,
): MachineWidgetTarget | null {
  const parsed = MachineTargetV1Schema.safeParse(input.machine);
  return parsed.success ? parsed.data : null;
}

/** The input a target-keyed body passes to its owner hooks; stable for one target. */
export function useMachineWidgetTarget(
  input: Readonly<Record<string, JsonValue>>,
): MachineWidgetTarget | null {
  const target = readMachineWidgetTarget(input);
  const serverId = target?.serverId;
  const machineId = target?.machineId;
  return React.useMemo(
    () => (serverId && machineId ? { serverId, machineId } : null),
    [machineId, serverId],
  );
}

/**
 * The size the frame resolved. A linear surface (Companion, a Project aside) has no named size: there a
 * body draws its Small composition at the column's width, as the lab's Companion does.
 */
export function useMachineWidgetSize(): WidgetSizeV1 {
  return useWidgetPresentation()?.size ?? 'small';
}

export function isWideWidgetSize(size: WidgetSizeV1): boolean {
  return size === 'wide' || size === 'full' || size === 'large';
}

export type MachineWidgetMachineFacts = Readonly<{
  machine: Machine | null;
  name: string;
  online: boolean | null;
  /** The person only uses this machine (sync proves custody with `isShared === false`). */
  recipient: boolean;
  daemonStateVersion: number | null;
  lastSeenAt: number | null;
}>;

/** The bound machine's canonical presence; null is unobserved and never admits a read. */
export function useMachineWidgetMachine(
  target: MachineWidgetTarget | null,
): MachineWidgetMachineFacts {
  const language = usePreferredLanguage();
  const serverId = target?.serverId ?? null;
  const machineId = target?.machineId ?? '';
  const machine = storage(
    React.useCallback(
      (state: Parameters<typeof resolveServerScopedMachine>[0]) =>
        machineId
          ? resolveServerScopedMachine(state, serverId, machineId)
          : null,
      [machineId, serverId],
    ),
  );
  const presence = useMachinePresenceSummary(serverId, machineId);
  // The Home's list disambiguates near-identical names ("devbox · 3ad2"); the widget says the same name.
  const inventory = storage(
    React.useCallback(
      (state: Parameters<typeof resolveServerScopedMachine>[0]) =>
        serverId ? state.machineListByServerId?.[serverId] ?? null : null,
      [serverId],
    ),
  );
  return React.useMemo(() => {
    const activeAt = machine?.activeAt;
    return {
      machine,
      // A widget sentence can use the generic subject while identity loads, never "Loading is offline".
      name: machine && !isMachineDisplayHydrating(machine)
        ? getMachineDisplayName(machine, inventory ?? undefined)
        : t('machines.widgets.body.common.unknownMachine'),
      online: presence.reachability === 'unknown' ? null : presence.reachability === 'reachable',
      recipient: machine ? machine.isShared !== false && machine.access?.role !== 'manage' : false,
      daemonStateVersion: machine?.daemonStateVersion ?? null,
      lastSeenAt:
        typeof activeAt === 'number' && activeAt > 0 ? activeAt : null,
    };
  }, [language, inventory, machine, presence.reachability]);
}

/** Opens the bound machine's page at the tab (and place) that answers what the widget shows. */
export function useOpenMachinePage(
  target: MachineWidgetTarget | null,
): (tab?: MachinePageTabParams) => void {
  const router = useRouter();
  const door = useMachinesDoor();
  return React.useCallback(
    (tab?: MachinePageTabParams) => {
      if (!target) return;
      const result = runGuardedNavigation(() =>
        router.push(
          machinePageHref({ door, target, ...(tab ? { tab } : {}) }) as never,
        ),
      );
      if (result !== true) fireAndForget(result, { tag: 'MachineWidget.open' });
    },
    [door, router, target],
  );
}

export type MachineWidgetFreshness = Readonly<
  { kind: 'live' } | { kind: 'stale'; at: number } | { kind: 'offline'; heldAt?: number }
>;

/**
 * The frame's meta slot speaks only when values are not live (R38): "As of 10:42" for a held reading,
 * "Offline" for an offline machine, with "As of 10:42" after it when the body still shows values it last read
 * (a held figure says how old it is). Live is silent.
 */
export function useMachineWidgetFreshness(
  freshness: MachineWidgetFreshness,
  testID: string,
): void {
  const language = usePreferredLanguage();
  const kind = freshness.kind;
  const at = freshness.kind === 'stale' ? freshness.at : null;
  const heldAt = freshness.kind === 'offline' ? freshness.heldAt ?? null : null;
  const meta = React.useMemo(
    () =>
      kind === 'offline' ? (
        <View style={styles.offlineMeta}>
          <Text testID={`${testID}.offline`} style={styles.meta}>
            {t('machines.widgets.body.common.offline')}
          </Text>
          {heldAt !== null ? <SurfaceAsOfLabel at={heldAt} testID={`${testID}.asOf`} /> : null}
        </View>
      ) : kind === 'stale' && at !== null ? (
        <SurfaceAsOfLabel at={at} testID={`${testID}.asOf`} />
      ) : null,
    [language, at, heldAt, kind, testID],
  );
  useWidgetFrameBodyMeta(meta);
}

/**
 * What a body says instead of its content (lab `rw` VS): reserved rows while the first answer arrives, an
 * offline machine with its last-seen time, a metric the machine does not report, an owner that could not
 * answer (with Retry), or a quiet "nothing here" line. Unknown is never drawn as zero. Each state replaces
 * the body and takes the frame's state size, so it sits balanced in the card's room (a line in a Small
 * card or a Companion, the centred state in a larger one); the card keeps its footprint.
 */
export function MachineWidgetState(
  props: Readonly<
    | { kind: 'loading'; rows?: number; testID: string }
    | {
        kind: 'offline';
        machineName: string;
        lastSeenAt: number | null;
        detail?: string;
        testID: string;
      }
    | {
        kind: 'not_reported';
        machineName: string;
        reason?: string;
        testID: string;
      }
    | { kind: 'unavailable'; title: string; reason?: string; testID: string }
    | {
        kind: 'error';
        title?: string;
        reason?: string;
        diagnosticCode?: string;
        onRetry: () => void;
        testID: string;
      }
    | {
        kind: 'empty';
        title: string;
        reason?: string;
        action?: Readonly<{ label: string; onPress: () => void }>;
        testID: string;
      }
  >,
) {
  if (props.kind === 'loading') {
    return (
      <ItemLoadStateRows
        testID={`${props.testID}.loading`}
        state={{ kind: 'loading' }}
        rows={props.rows ?? 3}
        lines={1}
        shape="list"
        accessibilityLabel={t('machines.widgets.body.common.loading')}
      />
    );
  }
  if (props.kind === 'offline') {
    const seen = props.lastSeenAt
      ? t('machines.widgets.body.common.lastSeen', {
          time: formatLastSeen(props.lastSeenAt),
        })
      : null;
    return (
      <SurfaceStateCard
        testID={`${props.testID}.offline`}
        kind="unavailable"
        replacesContent
        iconName="wifi-slash"
        // The frame's meta already says "Offline" and its subtitle names the machine, so the body says
        // only what that leaves out: when it was last seen. Never seen: it says who is offline.
        title={seen ?? t('machines.widgets.body.common.machineOffline', {
          machine: props.machineName,
        })}
        reason={props.detail || undefined}
      />
    );
  }
  if (props.kind === 'not_reported') {
    return (
      <SurfaceStateCard
        testID={`${props.testID}.notReported`}
        kind="unavailable"
        replacesContent
        title={t('machines.widgets.body.common.notReported', {
          machine: props.machineName,
        })}
        reason={
          props.reason ?? t('machines.widgets.body.common.notReportedReason')
        }
      />
    );
  }
  if (props.kind === 'unavailable') {
    return (
      <SurfaceStateCard
        testID={`${props.testID}.unavailable`}
        kind="unavailable"
        replacesContent
        title={props.title}
        {...(props.reason ? { reason: props.reason } : {})}
      />
    );
  }
  if (props.kind === 'error') {
    return (
      <SurfaceStateCard
        testID={`${props.testID}.error`}
        kind="error"
        replacesContent
        title={props.title ?? t('machines.widgets.body.common.readFailed')}
        diagnosticCode={props.diagnosticCode}
        {...(props.reason ? { reason: props.reason } : {})}
        action={{ label: t('common.retry'), onPress: props.onRetry }}
      />
    );
  }
  return (
    <SurfaceStateCard
      testID={`${props.testID}.empty`}
      kind="empty"
      replacesContent
      title={props.title}
      {...(props.reason ? { reason: props.reason } : {})}
      {...(props.action ? { action: props.action } : {})}
    />
  );
}

/** A body's one column of content; bodies compose their sizes inside it. */
export function MachineWidgetColumn(
  props: Readonly<{ children: React.ReactNode; testID: string }>,
) {
  return (
    <View testID={props.testID} style={styles.column}>
      {props.children}
    </View>
  );
}

/** Wide sizes: a lead and a second column side by side (lab `two(…, 'lead')`). */
export function MachineWidgetTwoColumns(
  props: Readonly<{ lead: React.ReactNode; rest: React.ReactNode }>,
) {
  return (
    <View style={styles.two}>
      <View style={styles.twoCell}>{props.lead}</View>
      <View style={styles.twoCell}>{props.rest}</View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  meta: {
    ...Typography.variant('meta'),
    color: theme.colors.text.tertiary,
  },
  offlineMeta: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s8, flexShrink: 1, minWidth: 0 },
  column: {
    flexGrow: 1,
    minWidth: 0,
    gap: theme.space.s12,
  },
  // Two halves while each has room to read; on a narrow body (a phone's column) the second drops beneath.
  two: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    columnGap: 28,
    rowGap: theme.space.s12,
    flexGrow: 1,
    minWidth: 0,
  },
  twoCell: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: 240,
    minWidth: 0,
    gap: theme.space.s12,
  },
}));

/**
 * A body section's quiet label with its one fact at the right (lab `lab('Would stop first', 'if memory
 * ran short')`). Several bodies share it, so a section reads the same in every widget.
 */
export function MachineWidgetSectionLabel(props: Readonly<{ label: string; meta?: string | null; testID?: string }>) {
    return (
        <View testID={props.testID} style={sectionLabelStyles.row}>
            <Text accessibilityRole="header" numberOfLines={1} style={sectionLabelStyles.label}>{props.label}</Text>
            {props.meta ? <Text numberOfLines={1} style={sectionLabelStyles.meta}>{props.meta}</Text> : null}
        </View>
    );
}

/** A quiet word for the frame's meta slot ("On", "Off", "Offline"), lent by a body that has its own state word. */
export function MachineWidgetMetaText(props: Readonly<{ text: string; testID?: string }>) {
    return <Text testID={props.testID} style={sectionLabelStyles.meta}>{props.text}</Text>;
}

const sectionLabelStyles = StyleSheet.create((theme) => ({
    row: {
        flexDirection: 'row',
        alignItems: 'baseline',
        justifyContent: 'space-between',
        gap: theme.space.s12,
    },
    label: {
        ...Typography.variant('meta'),
        ...Typography.default('medium'),
        color: theme.colors.text.secondary,
        flexShrink: 1,
    },
    meta: {
        ...Typography.variant('meta'),
        color: theme.colors.text.tertiary,
        flexShrink: 0,
    },
}));
