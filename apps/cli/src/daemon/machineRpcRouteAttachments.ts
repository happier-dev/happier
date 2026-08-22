import type { ApiMachineClient } from '@/api/apiMachine';

import type { BrowserDaemonControlRoutes } from './browser/control/routes';
import type { BrowserContextRoutes } from './browser/context/routes';
import type { BrowserDiagnosticsRoutes } from './browser/diagnostics/routes';
import type { BrowserRecordingRoutes } from './browser/recording/routes';
import type { SimulatorPreviewRoutes } from './devices/simulator/previewRoutes.types';
import type { DaemonLocalServicesMachineRpcRoutes } from '@/rpc/handlers/daemonLocalServices';
import type { LocalServicePreviewRoutes } from './local/services/preview/routes';
import type { ConnectedAccountDaemonRuntime } from './connectedServices/ConnectedAccountDaemonRuntime';
import type { DaemonConnectedAccountPurposeBindingRuntime } from './connectedServices/purposeBindings/createDaemonConnectedAccountPurposeBindingRuntime';

export type DaemonMachineRpcRouteRegistrar = Pick<
  ApiMachineClient,
  | 'registerLocalServicesPreviewRoutes'
  | 'registerLocalServicesRoutes'
  | 'registerBrowserControlRoutes'
  | 'registerBrowserContextRoutes'
  | 'registerBrowserDiagnosticsRoutes'
  | 'registerBrowserRecordingRoutes'
  | 'registerSimulatorPreviewRoutes'
  | 'registerConnectedAccountDaemonRuntime'
  | 'registerConnectedAccountPurposeBindingRuntime'
>;

export type DaemonMachineRpcRouteAttachmentCache = Readonly<{
  attachLocalServicesPreviewRoutes(routes: LocalServicePreviewRoutes): void;
  attachLocalServicesRoutes(routes: DaemonLocalServicesMachineRpcRoutes): void;
  attachBrowserControlRoutes(routes: BrowserDaemonControlRoutes): void;
  attachBrowserContextRoutes(routes: BrowserContextRoutes): void;
  attachBrowserDiagnosticsRoutes(routes: BrowserDiagnosticsRoutes): void;
  attachBrowserRecordingRoutes(routes: BrowserRecordingRoutes): void;
  attachSimulatorPreviewRoutes(routes: SimulatorPreviewRoutes): void;
  attachConnectedAccountDaemonRuntime(runtime: ConnectedAccountDaemonRuntime): void;
  attachConnectedAccountPurposeBindingRuntime(runtime: Pick<
    DaemonConnectedAccountPurposeBindingRuntime,
    'listActionFormConnectedAccountOptions'
  >): void;
  prepareApiMachineForSessions(apiMachineForSessions: DaemonMachineRpcRouteRegistrar): void;
  attachApiMachineForSessions(apiMachineForSessions: DaemonMachineRpcRouteRegistrar | null): void;
}>;

export function createDaemonMachineRpcRouteAttachmentCache(input: Readonly<{
  getApiMachineForSessions: () => DaemonMachineRpcRouteRegistrar | null;
}>): DaemonMachineRpcRouteAttachmentCache {
  let localServicesPreviewRoutes: LocalServicePreviewRoutes | null = null;
  let localServicesRoutes: DaemonLocalServicesMachineRpcRoutes | null = null;
  let browserControlRoutes: BrowserDaemonControlRoutes | null = null;
  let browserContextRoutes: BrowserContextRoutes | null = null;
  let browserDiagnosticsRoutes: BrowserDiagnosticsRoutes | null = null;
  let browserRecordingRoutes: BrowserRecordingRoutes | null = null;
  let simulatorPreviewRoutes: SimulatorPreviewRoutes | null = null;
  let connectedAccountDaemonRuntime: ConnectedAccountDaemonRuntime | null = null;
  let connectedAccountPurposeBindingRuntime: Pick<
    DaemonConnectedAccountPurposeBindingRuntime,
    'listActionFormConnectedAccountOptions'
  > | null = null;
  const connectedAccountRuntimeByRegistrar =
    new WeakMap<object, ConnectedAccountDaemonRuntime>();
  const connectedAccountPurposeRuntimeByRegistrar =
    new WeakMap<object, Pick<DaemonConnectedAccountPurposeBindingRuntime, 'listActionFormConnectedAccountOptions'>>();

  function registerConnectedAccountRuntime(
    registrar: DaemonMachineRpcRouteRegistrar,
  ): void {
    if (
      !connectedAccountDaemonRuntime
      || connectedAccountRuntimeByRegistrar.get(registrar)
        === connectedAccountDaemonRuntime
    ) {
      return;
    }
    registrar.registerConnectedAccountDaemonRuntime(
      connectedAccountDaemonRuntime,
    );
    connectedAccountRuntimeByRegistrar.set(
      registrar,
      connectedAccountDaemonRuntime,
    );
  }

  function registerConnectedAccountPurposeRuntime(
    registrar: DaemonMachineRpcRouteRegistrar,
  ): void {
    if (
      !connectedAccountPurposeBindingRuntime
      || connectedAccountPurposeRuntimeByRegistrar.get(registrar)
        === connectedAccountPurposeBindingRuntime
    ) {
      return;
    }
    registrar.registerConnectedAccountPurposeBindingRuntime(
      connectedAccountPurposeBindingRuntime,
    );
    connectedAccountPurposeRuntimeByRegistrar.set(
      registrar,
      connectedAccountPurposeBindingRuntime,
    );
  }

  function localServicesRoutesForCombinedRegistration(): DaemonLocalServicesMachineRpcRoutes | null {
    if (!localServicesRoutes) return null;
    if (
      localServicesPreviewRoutes
      && localServicesRoutes.localServicesPreview === localServicesPreviewRoutes
    ) {
      const {
        localServicesPreview: _localServicesPreview,
        ...routesWithoutPreview
      } = localServicesRoutes;
      return routesWithoutPreview;
    }
    return localServicesRoutes;
  }

  return {
    attachLocalServicesPreviewRoutes(routes) {
      localServicesPreviewRoutes = routes;
      if (localServicesRoutes?.localServicesPreview === routes) return;
      input.getApiMachineForSessions()?.registerLocalServicesPreviewRoutes(routes);
    },

    attachLocalServicesRoutes(routes) {
      localServicesRoutes = routes;
      const registrationRoutes = localServicesRoutesForCombinedRegistration();
      if (registrationRoutes) {
        input.getApiMachineForSessions()?.registerLocalServicesRoutes(registrationRoutes);
      }
    },

    attachBrowserControlRoutes(routes) {
      browserControlRoutes = routes;
      input.getApiMachineForSessions()?.registerBrowserControlRoutes(routes);
    },

    attachBrowserContextRoutes(routes) {
      browserContextRoutes = routes;
      input.getApiMachineForSessions()?.registerBrowserContextRoutes?.(routes);
    },

    attachBrowserDiagnosticsRoutes(routes) {
      browserDiagnosticsRoutes = routes;
      input.getApiMachineForSessions()?.registerBrowserDiagnosticsRoutes(routes);
    },

    attachBrowserRecordingRoutes(routes) {
      browserRecordingRoutes = routes;
      input.getApiMachineForSessions()?.registerBrowserRecordingRoutes(routes);
    },

    attachSimulatorPreviewRoutes(routes) {
      simulatorPreviewRoutes = routes;
      input.getApiMachineForSessions()?.registerSimulatorPreviewRoutes(routes);
    },

    attachConnectedAccountDaemonRuntime(runtime) {
      connectedAccountDaemonRuntime = runtime;
      const registrar = input.getApiMachineForSessions();
      if (registrar) registerConnectedAccountRuntime(registrar);
    },

    attachConnectedAccountPurposeBindingRuntime(runtime) {
      connectedAccountPurposeBindingRuntime = runtime;
      const registrar = input.getApiMachineForSessions();
      if (registrar) registerConnectedAccountPurposeRuntime(registrar);
    },

    prepareApiMachineForSessions(apiMachineForSessions) {
      registerConnectedAccountRuntime(apiMachineForSessions);
      registerConnectedAccountPurposeRuntime(apiMachineForSessions);
    },

    attachApiMachineForSessions(apiMachineForSessions) {
      if (!apiMachineForSessions) return;
      // Authentication commands must be reachable as soon as the replacement
      // machine transport is published; later optional route families must not
      // delay or prevent this canonical command owner from being reattached.
      registerConnectedAccountRuntime(apiMachineForSessions);
      registerConnectedAccountPurposeRuntime(apiMachineForSessions);
      if (localServicesPreviewRoutes) {
        apiMachineForSessions.registerLocalServicesPreviewRoutes(localServicesPreviewRoutes);
      }
      const registrationRoutes = localServicesRoutesForCombinedRegistration();
      if (registrationRoutes) {
        apiMachineForSessions.registerLocalServicesRoutes(registrationRoutes);
      }
      if (browserControlRoutes) {
        apiMachineForSessions.registerBrowserControlRoutes(browserControlRoutes);
      }
      if (browserContextRoutes) {
        apiMachineForSessions.registerBrowserContextRoutes?.(browserContextRoutes);
      }
      if (browserDiagnosticsRoutes) {
        apiMachineForSessions.registerBrowserDiagnosticsRoutes(browserDiagnosticsRoutes);
      }
      if (browserRecordingRoutes) {
        apiMachineForSessions.registerBrowserRecordingRoutes(browserRecordingRoutes);
      }
      if (simulatorPreviewRoutes) {
        apiMachineForSessions.registerSimulatorPreviewRoutes(simulatorPreviewRoutes);
      }
    },
  };
}
