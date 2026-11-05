import * as React from 'react';

import { bindServicesOpenInBrowser, type OpenBrowserViewTarget } from '@/components/browser/surfaces/openBrowserTargetInWorkspace';
import { resolveBrowserSurfacePlatform } from '@/components/browser/surfaces/useBrowserSurfaceHostProps';
import { resolveLocalServiceEntryActions } from '@/components/sessions/localServices/localServiceEntryActions';
import { useLocalServiceActionRunner, type LocalServiceActionRunner } from '@/components/sessions/localServices/localServiceActionOutcome';
import { useLocalServiceEntryActions, type LocalServiceEntryActionsWiring } from '@/components/sessions/localServices/useLocalServiceEntryActions';
import { useLocalServiceLiveFeeds } from '@/components/sessions/localServices/useLocalServiceLiveFeeds';
import { useLocalServicePresentationFeatures, type LocalServiceCapabilityDisabledReasons } from '@/components/sessions/localServices/useLocalServicePublicPreviewFeature';
import type { ServiceRowOpenHandler } from '@/components/sessions/localServices/ServiceRowView';
import { selectLocalServiceInventoryPresentationRows } from '@/sync/domains/local/services/inventory/store';
import { selectLocalServiceLaunchTargets } from '@/sync/domains/local/services/launch';
import { useLocalServicePreviewStateController } from '@/sync/domains/local/services/preview/useLocalServicePreviewState';
import type { LocalServicePreviewState } from '@/sync/domains/local/services/preview/store';
import { buildLocalServiceRows, selectLocalServiceRowForInventoryEntry, type ServiceRow } from '@/sync/domains/local/services/serviceRow';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import { t } from '@/text';
import { openExternalUrl } from '@/utils/url/openExternalUrl';

/** The machine's Local services, read once a port is first pressed and kept while the tab is open. */
type PortServices = Readonly<{
  /** `null` until the launcher's first snapshot arrives. */
  rows: readonly ServiceRow[] | null;
  handlers: LocalServiceEntryActionsWiring['handlers'];
  run: LocalServiceActionRunner['run'];
  publicPreviewEnabled: boolean;
  capabilityDisabledReasons: LocalServiceCapabilityDisabledReasons;
  /** Open in browser: the Services opener, ending in an external tab (the machine page hosts no browser pane). */
  openInBrowser: ServiceRowOpenHandler;
  /** The private-preview access owner's registrations: whether Open can reach a preview from here. */
  previews: LocalServicePreviewState;
}>;

const unopenable = (errorCode: string): ActionExecuteResult => ({
  ok: false,
  errorCode,
  error: errorCode,
});

/**
 * The external-tab end of the Services opener. Registration, mapping and the access route stay the
 * Services owner's (`bindServicesOpenInBrowser`); the URL is the one it admits for this viewer — the
 * preview's access URL — never the service's raw address. No access URL means no route from here.
 */
const openInExternalTab: OpenBrowserViewTarget = async (target, options) => {
  const url = target.kind === 'externalUrl' ? target.url : options?.currentUrl;
  if (!url) return unopenable('preview_private_route_unavailable');
  return (await openExternalUrl(url))
    ? { ok: true, result: null }
    : unopenable('browser_adapter_unavailable');
};

type PortActions = Readonly<{
  serverId: string;
  /** The one intent signal: the first press on any port starts the Local services feeds. */
  demand: () => void;
  services: PortServices | null;
}>;

const MachinePortActionsContext = React.createContext<PortActions | null>(null);

/**
 * Lets machine port consumers act through Local services. Nothing is read until a
 * port is pressed; from then on the machine's feeds and the shared Action admission stay mounted with
 * the tab, so an Action waiting on approval or a review outlives the menu that started it.
 */
export function MachinePortActionsProvider(
  props: Readonly<{
    serverId: string;
    machineId: string;
    children: React.ReactNode;
  }>,
) {
  const [demanded, setDemanded] = React.useState(false);
  const [services, setServices] = React.useState<PortServices | null>(null);
  const demand = React.useCallback(() => setDemanded(true), []);
  const value = React.useMemo(
    () => ({ serverId: props.serverId, demand, services }),
    [demand, props.serverId, services],
  );
  return (
    <MachinePortActionsContext.Provider value={value}>
      {demanded ? (
        <PortServicesHost
          serverId={props.serverId}
          machineId={props.machineId}
          onServices={setServices}
        />
      ) : null}
      {props.children}
    </MachinePortActionsContext.Provider>
  );
}

function PortServicesHost(
  props: Readonly<{
    serverId: string;
    machineId: string;
    onServices: (services: PortServices | null) => void;
  }>,
) {
  const feeds = useLocalServiceLiveFeeds({
    machineId: props.machineId,
    serverId: props.serverId,
    scope: 'machine',
  });
  const wiring = useLocalServiceEntryActions({
    machineId: props.machineId,
    serverId: props.serverId,
    scope: 'machine',
    onRefresh: feeds.refresh,
    applyLauncherSnapshot: feeds.applyLauncherSnapshot,
    testID: 'machine-processes-port-services',
  });
  const runner = useLocalServiceActionRunner();
  const { publicPreviewFeatureEnabled: publicPreviewEnabled, publicPreviewCapabilityDisabledReasons: capabilityDisabledReasons } = useLocalServicePresentationFeatures(props.serverId);
  const previewController = useLocalServicePreviewStateController({
    machineId: props.machineId,
    serverId: props.serverId,
  });
  const previews = previewController.state;
  const openInBrowser = React.useMemo(
    () =>
      bindServicesOpenInBrowser({
        onOpenTarget: openInExternalTab,
        platform: resolveBrowserSurfacePlatform(),
        serverId: props.serverId,
        accountLifetime: previewController.accountLifetime,
        credentialKey: previewController.credentialKey,
      }),
    [previewController.accountLifetime, previewController.credentialKey, props.serverId],
  );
  const { inventoryState, launcherState } = feeds;
  // Scan clocks stay in raw inventory state; rows depend only on material row facts.
  const inventoryRows = selectLocalServiceInventoryPresentationRows(inventoryState);
  const rows = React.useMemo(
    () =>
      launcherState && launcherState.updatedAt !== null
        ? buildLocalServiceRows({
            inventoryRows,
            launchTargets: selectLocalServiceLaunchTargets(launcherState),
            sessionId: null,
            scope: 'machine',
          })
        : null,
    [inventoryRows, launcherState],
  );
  const services = React.useMemo(
    (): PortServices => ({
      rows,
      handlers: wiring.handlers,
      run: runner.run,
      publicPreviewEnabled,
      capabilityDisabledReasons,
      openInBrowser,
      previews,
    }),
    [
      capabilityDisabledReasons,
      openInBrowser,
      previews,
      publicPreviewEnabled,
      rows,
      runner.run,
      wiring.handlers,
    ],
  );
  const { onServices } = props;
  React.useEffect(() => {
    onServices(services);
  }, [onServices, services]);
  React.useEffect(() => () => onServices(null), [onServices]);
  // A Start/Restart review never starts from a port; this keeps the shared admission's review placed.
  return wiring.review;
}

/** The one intent signal and lazy Local services owner shared by Processes and Services. */
export function useMachinePortActions() {
  return React.useContext(MachinePortActionsContext);
}

/** A port's existing Local services offer, selected only while its affordance is open. */
export function useMachinePortEntry(
  entry: Readonly<{ port: number; inventoryEntryId?: string }>,
  enabled: boolean,
) {
  const actions = useMachinePortActions();
  const services = actions?.services ?? null;
  const row = enabled && services?.rows
    ? selectLocalServiceRowForInventoryEntry(services.rows, entry)
    : null;
  const offered = row && services
    ? resolveLocalServiceEntryActions(row, { ...services.handlers, onOpenServiceInBrowser: services.openInBrowser }, services.previews)
    : null;
  const target = offered?.open ?? null;
  const open = React.useMemo(() => target && row && services
    ? () => services.run({
        id: `port:${entry.inventoryEntryId ?? row.target.id}:open`,
        failureTitle: t('localServices.actions.failureTitle.open', { service: row.title }),
        action: async () => services.openInBrowser(target),
      })
    : null, [entry.inventoryEntryId, row, services, target]);
  return { actions, services, row, offered, open };
}
