import * as React from 'react';
import { isHealthCheckEventSourceV1 } from '@happier-dev/protocol/deployments/healthCheckSourceV1';

import { useDeploymentDestinationSignal } from '@/components/appShell/destinations/useDeploymentDestinationSignal';
import { useThisComputerMachineId } from '@/components/machines/add/useMachineAddPaths';
import {
  publishPresentationNotice,
  readPresentationNotices,
  retirePresentationNotice,
  subscribePresentationNotices,
} from '@/components/sessions/presentation/presentationNotices';
import { useNavigationSurfacePlacementActionWriter } from '@/components/ui/navigation/useNavigationSurfacePlacement';
import { useEventCallback } from '@/hooks/ui/useEventCallback';
import { isPluginEventAutomationTrigger } from '@/sync/domains/automations/automationTypes';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import {
  updateNavigationPlacement,
  type NavigationPlacementPreferences,
} from '@/sync/domains/settings/navigationPlacement';
import {
  recordAppRailArrival,
  useAppRailArrival,
} from '@/sync/domains/state/appRailArrivalsUiState';
import { getStorage } from '@/sync/domains/state/storageStore';
import { resolveVisibleMachinesForActiveServerFromState } from '@/sync/store/domains/machines/resolveMachinesForActiveServerFromState';
import { ICON_SIZE, Icon, type IconName } from '@/components/ui/icons/Icon';
import { useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';
import { desktopHostKind } from '@/utils/platform/desktopHost';

import type { AppRailArrivalId } from './appRailModel';

type ArriveCallback = (id: AppRailArrivalId) => void;

/** The notice leads with the rail icon the destination just took. */
const ARRIVAL_ICONS: Readonly<Record<AppRailArrivalId, IconName>> = {
  deployments: 'rocket-launch',
  monitoring: 'pulse',
  'app-rail-machines': 'desktop',
};

/** The rail arrivals this device has recorded for the Account and Home (owner 11-28, rail C), as one stable set. */
export function useAppRailArrivals(
  scope: ServerAccountScope | null,
): ReadonlySet<string> {
  const deployments = useAppRailArrival(scope, 'deployments');
  const monitoring = useAppRailArrival(scope, 'monitoring');
  const machines = useAppRailArrival(scope, 'app-rail-machines');
  return React.useMemo(
    () =>
      new Set<string>([
        ...(deployments ? ['deployments'] : []),
        ...(monitoring ? ['monitoring'] : []),
        ...(machines ? ['app-rail-machines'] : []),
      ]),
    [deployments, machines, monitoring],
  );
}

/**
 * Watches, for each rail arrival that has neither arrived nor a placement the person chose, the one fact that
 * brings it onto the rail: a deployed Environment (the activity read's pushed count), a saved Check (the synced
 * Automation catalog), a Machine besides this computer (the Machine inventory). An arrival is recorded once and
 * then its watcher unmounts, so a settled rail reads nothing. One quiet notice offers "Move to More".
 */
export function AppRailArrivals(
  props: Readonly<{
    scope: ServerAccountScope | null;
    arrived: ReadonlySet<string>;
    preferences: NavigationPlacementPreferences;
    titles: Readonly<Record<AppRailArrivalId, string>>;
  }>,
) {
  const { scope } = props;
  const [announcing, setAnnouncing] = React.useState<AppRailArrivalId | null>(
    null,
  );
  const arrive: ArriveCallback = useEventCallback((id: AppRailArrivalId) => {
    if (scope && recordAppRailArrival(scope, id)) setAnnouncing(id);
  });
  const done = React.useCallback(() => setAnnouncing(null), []);
  const watching = (id: AppRailArrivalId) =>
    scope !== null &&
    !props.arrived.has(id) &&
    props.preferences.placements[id] === undefined;
  return (
    <>
      {watching('deployments') ? (
        <DeploymentsArrivalFact onArrive={arrive} />
      ) : null}
      {watching('monitoring') ? (
        <MonitoringArrivalFact onArrive={arrive} />
      ) : null}
      {watching('app-rail-machines') && scope ? (
        <MachinesArrivalFact scope={scope} onArrive={arrive} />
      ) : null}
      {announcing ? (
        <AppRailArrivalNotice
          key={announcing}
          id={announcing}
          title={props.titles[announcing]}
          preferences={props.preferences}
          onDone={done}
        />
      ) : null}
    </>
  );
}

function useArriveWhen(
  id: AppRailArrivalId,
  has: boolean,
  onArrive: ArriveCallback,
) {
  React.useEffect(() => {
    if (has) onArrive(id);
  }, [has, id, onArrive]);
}

const DeploymentsArrivalFact = React.memo(function DeploymentsArrivalFact(
  props: Readonly<{ onArrive: ArriveCallback }>,
) {
  const { environmentCount } = useDeploymentDestinationSignal(true);
  useArriveWhen(
    'deployments',
    environmentCount !== null && environmentCount > 0,
    props.onArrive,
  );
  return null;
});

const MonitoringArrivalFact = React.memo(function MonitoringArrivalFact(
  props: Readonly<{ onArrive: ArriveCallback }>,
) {
  // The catalog record, not a per-mutation scan: it re-derives only when an Automation changes (useAutomations).
  const automations = getStorage()((state) =>
    state.isDataReady ? state.automations : null,
  );
  const hasCheck = React.useMemo(
    () =>
      automations !== null &&
      Object.values(automations).some((automation) =>
        automation.triggers.some(
          (trigger) =>
            isPluginEventAutomationTrigger(trigger) &&
            isHealthCheckEventSourceV1(trigger),
        ),
      ),
    [automations],
  );
  useArriveWhen('monitoring', hasCheck, props.onArrive);
  return null;
});

const MachinesArrivalFact = React.memo(function MachinesArrivalFact(
  props: Readonly<{ scope: ServerAccountScope; onArrive: ArriveCallback }>,
) {
  // Only a desktop app has a computer of its own; elsewhere every Machine is one besides it.
  const [desktop] = React.useState(() => desktopHostKind() !== null);
  const thisMachineId = useThisComputerMachineId(undefined, desktop);
  const { scope } = props;
  const hasOther = getStorage()(
    React.useCallback(
      (
        state: Parameters<
          typeof resolveVisibleMachinesForActiveServerFromState
        >[0],
      ) => {
        const machines = resolveVisibleMachinesForActiveServerFromState(
          state,
          scope,
        );
        let others = 0;
        for (const machine of machines)
          if (machine.id !== thisMachineId) others += 1;
        // Before the desktop's own daemon names this computer, one Machine might be it.
        return (
          others > 1 || (others === 1 && (!desktop || thisMachineId !== null))
        );
      },
      [desktop, scope, thisMachineId],
    ),
  );
  useArriveWhen('app-rail-machines', hasOther, props.onArrive);
  return null;
});

/**
 * The one quiet notice of an arrival, with "Move to More" through the rail's placement Action. It mounts the
 * placement writer only while the notice is shown and stays until a pressed move settles.
 */
function AppRailArrivalNotice(
  props: Readonly<{
    id: AppRailArrivalId;
    title: string;
    preferences: NavigationPlacementPreferences;
    onDone: () => void;
  }>,
) {
  const write = useNavigationSurfacePlacementActionWriter('appRail');
  const { theme } = useUnistyles();
  const iconColor = theme.colors.text.secondary;
  const latest = React.useRef({
    write,
    preferences: props.preferences,
    onDone: props.onDone,
  });
  latest.current = {
    write,
    preferences: props.preferences,
    onDone: props.onDone,
  };
  const { id, title } = props;
  React.useEffect(() => {
    const key = `app-rail-arrival:${id}`;
    let pending: Promise<unknown> | null = null;
    let finished = false;
    publishPresentationNotice({
      key,
      severity: 'info',
      message: t('navigationPlacement.railArrival', { title }),
      emphasis: title,
      leading: <Icon name={ARRIVAL_ICONS[id]} size={ICON_SIZE.sm} color={iconColor} />,
      action: {
        label: t('navigationPlacement.moveToMore'),
        run: () => {
          pending = latest.current.write(
            updateNavigationPlacement(
              latest.current.preferences,
              id,
              'overflow',
            ),
          );
        },
      },
    });
    const stop = subscribePresentationNotices(() => {
      if (
        finished ||
        readPresentationNotices().some((notice) => notice.key === key)
      )
        return;
      finished = true;
      void Promise.resolve(pending).finally(() => latest.current.onDone());
    });
    return () => {
      stop();
      if (!finished) retirePresentationNotice(key);
    };
  }, [iconColor, id, title]);
  return null;
}
