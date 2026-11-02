
import type { DaemonMachineAdminAccessRoutes } from '@/rpc/handlers/daemonMachineAdminAccess';
import type { ApiMachineClient } from '@/api/apiMachine';

import type { BrowserDaemonControlRoutes } from './browser/control/routes';
import type { BrowserContextRoutes } from './browser/context/routes';
import type { BrowserDiagnosticsRoutes } from './browser/diagnostics/routes';
import type { BrowserRecordingRoutes } from './browser/recording/routes';
import type { ComputerRoutes } from './computer/routes';
import type { SimulatorPreviewRoutes } from './devices/simulator/previewRoutes.types';
import type { DaemonLocalServicesMachineRpcRoutes } from '@/rpc/handlers/daemonLocalServices';
import type { DaemonMachineVitalsRoutes } from '@/rpc/handlers/daemonMachineVitals';
import type { DaemonProcessesRoutes } from '@/rpc/handlers/daemonProcesses';
import type { DaemonMachineResourcesPolicyRoutes } from '@/rpc/handlers/daemonMachineResourcesPolicy';
import type { DaemonMachineGuardRoutes } from '@/rpc/handlers/daemonMachineGuard';
import type { DaemonStorageRoutes } from '@/rpc/handlers/storage';
import type { LocalServicePreviewRoutes } from './local/services/preview/routes';
import type { ConnectedAccountDaemonRuntime } from './connectedServices/ConnectedAccountDaemonRuntime';
import type { ConnectedServicePoolSelectionRead } from '@/api/machine/rpcHandlers.connectedAccounts';

export type DaemonMachineRpcRouteRegistrar = Pick<
  ApiMachineClient,
  | 'registerLocalServicesPreviewRoutes'
  | 'registerLocalServicesRoutes'
  | 'registerMachineAccessLossReceiver'
  | 'registerMachineVitalsRoutes'
  | 'registerMachineProcessesRoutes'
  | 'registerMachineResourcesPolicyRoutes'
  | 'registerMachineAdminAccessRoutes'
  | 'registerMachineGuardRoutes'
  | 'registerStorageRoutes'
  | 'registerComputerRoutes'
  | 'registerBrowserControlRoutes'
  | 'registerBrowserContextRoutes'
  | 'registerBrowserDiagnosticsRoutes'
  | 'registerBrowserRecordingRoutes'
  | 'registerSimulatorPreviewRoutes'
  | 'registerConnectedAccountDaemonRuntime'
  | 'registerConnectedAccountPurposeBindingRuntime'
  | 'registerConnectedServicePoolSelectionRead'
>;

type DaemonMachineConnectedAccountPurposeBindingRuntime = Parameters<
  DaemonMachineRpcRouteRegistrar['registerConnectedAccountPurposeBindingRuntime']
>[0];

type MachineAccessLossReceiverOptions = Parameters<ApiMachineClient['registerMachineAccessLossReceiver']>[0];

export type DaemonMachineRpcRouteAttachmentCache = Readonly<{
  attachMachineAccessLossReceiver(options: MachineAccessLossReceiverOptions): void;
  attachLocalServicesPreviewRoutes(routes: LocalServicePreviewRoutes): void;
  attachLocalServicesRoutes(routes: DaemonLocalServicesMachineRpcRoutes): void;
  attachMachineVitalsRoutes(routes: DaemonMachineVitalsRoutes): void;
  attachMachineProcessesRoutes(routes: DaemonProcessesRoutes): void;
  attachMachineResourcesPolicyRoutes(routes: DaemonMachineResourcesPolicyRoutes): void;
  attachMachineAdminAccessRoutes(routes: DaemonMachineAdminAccessRoutes): void;
  attachMachineGuardRoutes(routes: DaemonMachineGuardRoutes): void;
  attachStorageRoutes(routes: DaemonStorageRoutes): void;
  attachComputerRoutes(resolveComputer: () => ComputerRoutes | null): void;
  attachBrowserControlRoutes(routes: BrowserDaemonControlRoutes): void;
  attachBrowserContextRoutes(routes: BrowserContextRoutes): void;
  attachBrowserDiagnosticsRoutes(routes: BrowserDiagnosticsRoutes): void;
  attachBrowserRecordingRoutes(routes: BrowserRecordingRoutes): void;
  attachSimulatorPreviewRoutes(routes: SimulatorPreviewRoutes): void;
  attachConnectedAccountDaemonRuntime(runtime: ConnectedAccountDaemonRuntime): void;
  attachConnectedServicePoolSelectionRead(read: ConnectedServicePoolSelectionRead): void;
  attachConnectedAccountPurposeBindingRuntime(
    runtime: DaemonMachineConnectedAccountPurposeBindingRuntime,
  ): void;
  prepareApiMachineForSessions(apiMachineForSessions: DaemonMachineRpcRouteRegistrar): void;
  attachApiMachineForSessions(apiMachineForSessions: DaemonMachineRpcRouteRegistrar | null): void;


}>;

export function createDaemonMachineRpcRouteAttachmentCache(input: Readonly<{
  getApiMachineForSessions: () => DaemonMachineRpcRouteRegistrar | null;
}>): DaemonMachineRpcRouteAttachmentCache {
  let machineAccessLossReceiver: MachineAccessLossReceiverOptions | null = null;
  let localServicesPreviewRoutes: LocalServicePreviewRoutes | null = null;
  let localServicesRoutes: DaemonLocalServicesMachineRpcRoutes | null = null;
  let machineVitalsRoutes: DaemonMachineVitalsRoutes | null = null;
  let machineProcessesRoutes: DaemonProcessesRoutes | null = null;
  let machineResourcesPolicyRoutes: DaemonMachineResourcesPolicyRoutes | null = null;
  let machineAdminAccessRoutes: DaemonMachineAdminAccessRoutes | null = null;

  let machineGuardRoutes: DaemonMachineGuardRoutes | null = null;
  let storageRoutes: DaemonStorageRoutes | null = null;
  let resolveComputer: (() => ComputerRoutes | null) | null = null;
  let browserControlRoutes: BrowserDaemonControlRoutes | null = null;
  let browserContextRoutes: BrowserContextRoutes | null = null;
  let browserDiagnosticsRoutes: BrowserDiagnosticsRoutes | null = null;
  let browserRecordingRoutes: BrowserRecordingRoutes | null = null;
  let simulatorPreviewRoutes: SimulatorPreviewRoutes | null = null;
  let connectedAccountDaemonRuntime: ConnectedAccountDaemonRuntime | null = null;
  let connectedServicePoolSelectionRead: ConnectedServicePoolSelectionRead | null = null;
  let connectedAccountPurposeBindingRuntime:
    DaemonMachineConnectedAccountPurposeBindingRuntime | null = null;
  const connectedAccountRuntimeByRegistrar =
    new WeakMap<object, ConnectedAccountDaemonRuntime>();
  const connectedAccountPurposeRuntimeByRegistrar =
    new WeakMap<object, DaemonMachineConnectedAccountPurposeBindingRuntime>();

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
    attachMachineAccessLossReceiver(options) {
      machineAccessLossReceiver = options;
      input.getApiMachineForSessions()?.registerMachineAccessLossReceiver(options);
    },
    attachComputerRoutes(resolve) {
      resolveComputer = resolve;
      input.getApiMachineForSessions()?.registerComputerRoutes(resolve);
    },
    attachStorageRoutes(routes) {
      storageRoutes = routes;
      input.getApiMachineForSessions()?.registerStorageRoutes(routes);
    },
    attachMachineResourcesPolicyRoutes(routes) {
      machineResourcesPolicyRoutes = routes;
      input.getApiMachineForSessions()?.registerMachineResourcesPolicyRoutes(routes);
    },
    attachMachineAdminAccessRoutes(routes) {
      machineAdminAccessRoutes = routes;
      input.getApiMachineForSessions()?.registerMachineAdminAccessRoutes(routes);
    },

    attachMachineGuardRoutes(routes) {
      machineGuardRoutes = routes;
      input.getApiMachineForSessions()?.registerMachineGuardRoutes(routes);
    },
    attachMachineVitalsRoutes(routes) {
      machineVitalsRoutes = routes;
      input.getApiMachineForSessions()?.registerMachineVitalsRoutes(routes);
    },
    attachMachineProcessesRoutes(routes) {
      machineProcessesRoutes = routes;
      input.getApiMachineForSessions()?.registerMachineProcessesRoutes(routes);
    },
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

    attachConnectedServicePoolSelectionRead(read) {
      connectedServicePoolSelectionRead = read;
      input.getApiMachineForSessions()?.registerConnectedServicePoolSelectionRead(read);
    },

    attachConnectedAccountPurposeBindingRuntime(runtime) {
      connectedAccountPurposeBindingRuntime = runtime;
      const registrar = input.getApiMachineForSessions();
      if (registrar) registerConnectedAccountPurposeRuntime(registrar);
    },

    prepareApiMachineForSessions(apiMachineForSessions) {
      if (connectedServicePoolSelectionRead) {
        apiMachineForSessions.registerConnectedServicePoolSelectionRead(connectedServicePoolSelectionRead);
      }
      registerConnectedAccountRuntime(apiMachineForSessions);
      registerConnectedAccountPurposeRuntime(apiMachineForSessions);
    },

    attachApiMachineForSessions(apiMachineForSessions) {
      if (!apiMachineForSessions) return;
      if (machineAccessLossReceiver) {
        apiMachineForSessions.registerMachineAccessLossReceiver(machineAccessLossReceiver);
      }
      if (connectedServicePoolSelectionRead) {
        apiMachineForSessions.registerConnectedServicePoolSelectionRead(connectedServicePoolSelectionRead);
      }
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
      if (machineVitalsRoutes) {
        apiMachineForSessions.registerMachineVitalsRoutes(machineVitalsRoutes);
      }
      if (machineProcessesRoutes) {
        apiMachineForSessions.registerMachineProcessesRoutes(machineProcessesRoutes);
      }
      if (machineResourcesPolicyRoutes) {
        apiMachineForSessions.registerMachineResourcesPolicyRoutes(machineResourcesPolicyRoutes);
      }
      if (machineAdminAccessRoutes) {
        apiMachineForSessions.registerMachineAdminAccessRoutes(machineAdminAccessRoutes);
      }

      if (machineGuardRoutes) {
        apiMachineForSessions.registerMachineGuardRoutes(machineGuardRoutes);
      }
      if (storageRoutes) {
        apiMachineForSessions.registerStorageRoutes(storageRoutes);
      }
      if (resolveComputer) {
        apiMachineForSessions.registerComputerRoutes(resolveComputer);
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
