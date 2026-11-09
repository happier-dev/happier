import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { useMachinePresenceSummary } from '@/components/sessions/model/useMachinePresenceSummary';
import { useIsWidgetFrameBody } from '@/components/widgets/frame/widgetFrameBody';
import { useWidgetFrameBodyMeta } from '@/components/widgets/frame/widgetFrameBodyCaption';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { ExpandableItem } from '@/components/ui/lists/ExpandableItem';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import {
  SurfaceStateCard,
  type SurfaceStateSize,
} from '@/components/ui/surfaces/SurfaceStateCard';
import { t } from '@/text';
import { describeMachinePresenceSummary, type MachineRuntimePresence } from '@/utils/sessions/machinePresenceLine';
import { formatLastSeen } from '@/utils/sessions/sessionUtils';

/** The machine a checkout lives on: reachability is a fact of the machine, not of the folder. */
export type CheckoutMachineScope = Readonly<{
  serverId: string;
  machineId: string;
}>;

/**
 * One checkout-reachability state. When the machine a checkout lives on isn't answering, the page
 * that owns the checkout says so once, with when it was last seen and Retry
 * ({@link CheckoutReachabilityLine}); every surface beneath it (Code, Local changes, Scripts, README,
 * the Git pane) inherits that and shows a quiet {@link CheckoutUnreachableState} instead of failing
 * on its own. A surface with no announcing page above it (a Session's Files pane) says it itself,
 * once, with its own Retry.
 *
 * `unknown` reachability (the machine record isn't visible from here, e.g. a shared Session) is never
 * presented as offline.
 */
export type CheckoutReachability = Readonly<{
  unreachable: boolean;
  runtime: MachineRuntimePresence;
  machineName: string;
  lastSeenAt: number | null;
  /** A page above already says it; this surface only inherits. */
  announced: boolean;
}>;

const AnnouncedCheckoutMachine =
  React.createContext<CheckoutMachineScope | null>(null);

/** Declares that this subtree's page announces its checkout machine's reachability. */
export function CheckoutReachabilityScope(
  props: Readonly<{ scope: CheckoutMachineScope; children: React.ReactNode }>,
) {
  const { serverId, machineId } = props.scope;
  const scope = React.useMemo(
    () => ({ serverId, machineId }),
    [serverId, machineId],
  );
  return (
    <AnnouncedCheckoutMachine.Provider value={scope}>
      {props.children}
    </AnnouncedCheckoutMachine.Provider>
  );
}

/** The checkout machine the page above announces, for a surface that only knows it sits under it. */
export function useAnnouncedCheckoutMachine(): CheckoutMachineScope | null {
  return React.useContext(AnnouncedCheckoutMachine);
}

export function useCheckoutReachability(
  scope: CheckoutMachineScope | null,
): CheckoutReachability {
  const presence = useMachinePresenceSummary(scope?.serverId, scope?.machineId);
  return useCheckoutReachabilityPresentation(scope, presence);
}

/** A surface already holding the selected Machine summary shares the announcement without another subscription. */
export function useCheckoutReachabilityPresentation(
  scope: CheckoutMachineScope | null,
  presence: Parameters<typeof describeMachinePresenceSummary>[0],
): CheckoutReachability {
  const announcedScope = React.useContext(AnnouncedCheckoutMachine);
  const runtime = React.useMemo(() => describeMachinePresenceSummary(presence), [presence]);
  const unreachable = runtime.showStatus;
  // Every use of this name is inside a sentence, so a Machine still loading reads "this machine", never "Loading…".
  const machineName = presence.sentenceName ?? scope?.machineId ?? '';
  const lastSeenAt = unreachable ? (presence.lastSeenAt ?? null) : null;
  const announced =
    unreachable &&
    scope != null &&
    announcedScope?.serverId === scope.serverId &&
    announcedScope.machineId === scope.machineId;
  return React.useMemo(
    () => ({ unreachable, machineName, lastSeenAt, announced, runtime }),
    [unreachable, machineName, lastSeenAt, announced, runtime],
  );
}

/**
 * Presence is pushed by the machine; Retry asks the server for the machine's current state now. The one
 * Retry of every "machine isn't answering" line (a checkout's page, a Session's Work pane).
 */
// Loaded on press: the states that offer Retry stay leaf modules without the sync engine's graph.
export async function retryMachineReachability(): Promise<unknown> {
  const { sync } = await import('@/sync/sync');
  return sync.refreshMachinesThrottled({ staleMs: 0, force: true });
}

/**
 * The page's one line ("As of 10:42 · devbox isn't answering · Retry"), under its header. Renders
 * nothing while the machine answers.
 */
export function CheckoutReachabilityLine(
  props: Readonly<{ scope: CheckoutMachineScope; testID?: string }>,
) {
  const reachability = useCheckoutReachability(props.scope);
  // Going offline and coming back are moments, not jumps: the line reveals and folds away with the
  // shared disclosure motion (height and opacity together, instant under reduced motion), and it keeps
  // its last words while it folds.
  const shownRef = React.useRef(reachability);
  if (reachability.unreachable) shownRef.current = reachability;
  const shown = shownRef.current;
  return (
    <ExpandableItem
      expanded={reachability.unreachable}
      onExpandedChange={ignoreExpandedChange}
      header={renderNoHeader}
      showDivider={false}
    >
      {shown.unreachable ? (
        <SurfaceFreshnessLine
          testID={props.testID ?? 'checkout-reachability'}
          reason={shown.runtime.label}
          action={shown.runtime.nextAction === 'retry' ? { label: t('common.retry'), onPress: retryMachineReachability } : undefined}
        />
      ) : null}
    </ExpandableItem>
  );
}

const ignoreExpandedChange = () => {};
const renderNoHeader = () => null;

/**
 * What a surface under an unreachable checkout shows in place of its own failure. Announced above:
 * no second cause or Retry. A body of its own says in one quiet line what it waits for, so a tab is
 * never blank; a widget or a section among siblings keeps only its header. Not announced: it names
 * the cause and offers Retry.
 */
export function CheckoutUnreachableState(
  props: Readonly<{
    reachability: CheckoutReachability;
    size?: SurfaceStateSize;
    /** One section among siblings: the line would repeat under each of them, so it stays wordless. */
    silent?: boolean;
    /** What this surface shows again once the machine answers ("Your files show up here when it's back."). */
    returns?: string;
    testID?: string;
  }>,
) {
  const { reachability } = props;
  // Inside a widget it is the widget's one quiet line; elsewhere the container sizes it.
  const widget = useIsWidgetFrameBody();
  if (reachability.announced) {
    const testID = props.testID ?? 'checkout-unreachable';
    if (!widget && !props.silent) {
      return (
        <SurfaceStateCard
          testID={testID}
          kind="unavailable"
          size="line"
          iconName="wifi-slash"
          title={t('projects.checkouts.waiting', { machine: reachability.machineName })}
        />
      );
    }
    return <AnnouncedCheckoutWait machineName={reachability.machineName} testID={testID} />;
  }
  // A machine that can be asked again is "out of reach": named in the title, when it was last seen and
  // what comes back in the reason, Try again beneath (lab p5 files). A managed machine's own state
  // (stopped, starting) is its title as it stands.
  const outOfReach = reachability.runtime.nextAction === 'retry';
  const reason = outOfReach
    ? [
        reachability.lastSeenAt
          ? t('projects.checkouts.lastSeen', { when: formatLastSeen(reachability.lastSeenAt) })
          : null,
        props.returns ?? null,
      ].filter(Boolean).join(' ') || undefined
    : props.returns;
  return (
    <SurfaceStateCard
      testID={props.testID ?? 'checkout-unreachable'}
      kind="unavailable"
      size={props.size ?? (widget ? 'line' : undefined)}
      iconName="wifi-slash"
      scene="homeOffline"
      title={outOfReach
        ? t('projects.checkouts.outOfReach', { machine: reachability.machineName })
        : reachability.runtime.label}
      reason={reason}
      action={outOfReach ? { label: t('surfaceState.tryAgain'), onPress: retryMachineReachability } : undefined}
    />
  );
}

/**
 * A widget or sibling section waiting on an announced machine, with nothing last-known to show: it
 * keeps only its header. No placeholder rows (they read as loading that never
 * ends) and no second sentence. In a widget frame the header's meta slot carries the one quiet
 * offline glyph, so the bare heading reads as unavailable, not as unfinished. Assistive technology
 * still hears what it waits for.
 */
function AnnouncedCheckoutWait(
  props: Readonly<{ machineName: string; testID: string }>,
) {
  const { theme } = useUnistyles();
  const glyph = React.useMemo(
    () => (
      <Icon
        name="wifi-slash"
        size={ICON_SIZE.sm}
        color={theme.colors.text.tertiary}
      />
    ),
    [theme.colors.text.tertiary],
  );
  useWidgetFrameBodyMeta(glyph);
  return (
    <View
      testID={props.testID}
      accessible
      accessibilityLabel={t('projects.checkouts.waiting', {
        machine: props.machineName,
      })}
    />
  );
}
