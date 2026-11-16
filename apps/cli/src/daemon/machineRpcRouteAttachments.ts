import type { ApiMachineClient } from '@/api/apiMachine';

import type { DaemonLocalServicesMachineRpcRoutes } from '@/rpc/handlers/daemonLocalServices';
import type { DaemonMachineVitalsRoutes } from '@/rpc/handlers/daemonMachineVitals';
import type { DaemonProcessesRoutes } from '@/rpc/handlers/daemonProcesses';
import type { DaemonMachineResourcesPolicyRoutes } from '@/rpc/handlers/daemonMachineResourcesPolicy';
import type { DaemonMachineRolesRoutes } from '@/rpc/handlers/daemonMachineRoles';
import type { DaemonMachineIsolationRoutes } from '@/rpc/handlers/daemonMachineIsolation';
import type { DaemonMachineAdminAccessRoutes } from '@/rpc/handlers/daemonMachineAdminAccess';
import type { DaemonMachineReachabilityRoutes } from '@/machines/reachability/createDaemonMachineReachabilityRoutes';
import type { AgentIsolationEffectDependencies } from './agentIsolation/agentIsolationProvisioner';
import type { DaemonMachineGuardRoutes } from '@/rpc/handlers/daemonMachineGuard';
import type { DaemonStorageRoutes } from '@/rpc/handlers/storage';
import type { LocalServicePreviewRoutes } from './local/services/preview/routes';
import type { ConnectedAccountDaemonRuntime } from './connectedServices/ConnectedAccountDaemonRuntime';
import type { ConnectedServicePoolSelectionRead } from '@/api/machine/rpcHandlers.connectedAccounts';
import type { DevicesRoleMachineRoutes } from './roles/devices/types';

export type DaemonMachineRpcRouteRegistrar = Pick<
  ApiMachineClient,
  | 'registerLocalServicesPreviewRoutes'
  | 'registerLocalServicesRoutes'
  | 'registerMachineAccessLossReceiver'
  | 'registerMachineVitalsRoutes'
  | 'registerMachineProcessesRoutes'
  | 'registerMachineResourcesPolicyRoutes'
  | 'registerMachineRolesRoutes'
  | 'registerMachineIsolationRoutes'
  | 'registerMachineAdminAccessRoutes'
  | 'registerMachineReachabilityRoutes'
  | 'registerMachineAgentIsolationRoutes'
  | 'registerMachineGuardRoutes'
  | 'registerStorageRoutes'
  | 'replaceDevicesRoleRoutes'
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
  attachMachineRolesRoutes(routes: DaemonMachineRolesRoutes): void;
  attachMachineIsolationRoutes(routes: DaemonMachineIsolationRoutes): void;
  attachMachineAdminAccessRoutes(routes: DaemonMachineAdminAccessRoutes): void;
  attachMachineReachabilityRoutes(routes: DaemonMachineReachabilityRoutes): void;
  attachMachineAgentIsolationRoutes(routes: AgentIsolationEffectDependencies): void;
  attachMachineGuardRoutes(routes: DaemonMachineGuardRoutes): void;
  attachStorageRoutes(routes: DaemonStorageRoutes): void;
  /**
   * The active `devices` role's routes, merged into one record and registered as one owned set;
   * `null` when the role stops (its RPC families unregister).
   */
  attachDevicesRoleRoutes(update: DevicesRoleMachineRoutes | null): void;
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
  let localServicesPreviewRoutes: LocalServicePreviewRoutes | null = null;
  let machineAccessLossReceiver: MachineAccessLossReceiverOptions | null = null;
  let localServicesRoutes: DaemonLocalServicesMachineRpcRoutes | null = null;
  let machineVitalsRoutes: DaemonMachineVitalsRoutes | null = null;
  let machineProcessesRoutes: DaemonProcessesRoutes | null = null;
  let machineResourcesPolicyRoutes: DaemonMachineResourcesPolicyRoutes | null = null;
  let machineRolesRoutes: DaemonMachineRolesRoutes | null = null;
  let machineIsolationRoutes: DaemonMachineIsolationRoutes | null = null;
  let machineAdminAccessRoutes: DaemonMachineAdminAccessRoutes | null = null;
  let machineReachabilityRoutes: DaemonMachineReachabilityRoutes | null = null;
  let machineAgentIsolationRoutes: AgentIsolationEffectDependencies | null = null;
  let machineGuardRoutes: DaemonMachineGuardRoutes | null = null;
  let storageRoutes: DaemonStorageRoutes | null = null;
  let devicesRoleRoutes: DevicesRoleMachineRoutes | null = null;
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

  function registerMachineSetupRoutes(registrar: DaemonMachineRpcRouteRegistrar): void {
    if (machineRolesRoutes) registrar.registerMachineRolesRoutes(machineRolesRoutes);
    if (machineIsolationRoutes) registrar.registerMachineIsolationRoutes(machineIsolationRoutes);
    if (machineReachabilityRoutes) registrar.registerMachineReachabilityRoutes(machineReachabilityRoutes);
    if (machineAdminAccessRoutes) registrar.registerMachineAdminAccessRoutes(machineAdminAccessRoutes);
    if (machineAgentIsolationRoutes) registrar.registerMachineAgentIsolationRoutes(machineAgentIsolationRoutes);
    if (machineGuardRoutes) registrar.registerMachineGuardRoutes(machineGuardRoutes);
  }

  return {
    attachMachineAccessLossReceiver(options) {
      machineAccessLossReceiver = options;
      input.getApiMachineForSessions()?.registerMachineAccessLossReceiver(options);
    },
    attachDevicesRoleRoutes(update) {
      devicesRoleRoutes = update ? { ...devicesRoleRoutes, ...update } : null;
      input.getApiMachineForSessions()?.replaceDevicesRoleRoutes(devicesRoleRoutes);
    },
    attachStorageRoutes(routes) {
      storageRoutes = routes;
      input.getApiMachineForSessions()?.registerStorageRoutes(routes);
    },
    attachMachineResourcesPolicyRoutes(routes) {
      machineResourcesPolicyRoutes = routes;
      input.getApiMachineForSessions()?.registerMachineResourcesPolicyRoutes(routes);
    },
    attachMachineRolesRoutes(routes) {
      machineRolesRoutes = routes;
      input.getApiMachineForSessions()?.registerMachineRolesRoutes(routes);
    },
    attachMachineIsolationRoutes(routes) {
      machineIsolationRoutes = routes;
      input.getApiMachineForSessions()?.registerMachineIsolationRoutes(routes);
    },
    attachMachineReachabilityRoutes(routes) {
      machineReachabilityRoutes = routes;
      input.getApiMachineForSessions()?.registerMachineReachabilityRoutes(routes);
    },
    attachMachineAdminAccessRoutes(routes) {
      machineAdminAccessRoutes = routes;
      input.getApiMachineForSessions()?.registerMachineAdminAccessRoutes(routes);
    },
    attachMachineAgentIsolationRoutes(routes) {
      machineAgentIsolationRoutes = routes;
      input.getApiMachineForSessions()?.registerMachineAgentIsolationRoutes(routes);
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
      // Enrollment consumes Machine control readiness as soon as connect publishes it.
      registerMachineSetupRoutes(apiMachineForSessions);
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
      registerMachineSetupRoutes(apiMachineForSessions);
      if (storageRoutes) {
        apiMachineForSessions.registerStorageRoutes(storageRoutes);
      }
      if (devicesRoleRoutes) {
        apiMachineForSessions.replaceDevicesRoleRoutes(devicesRoleRoutes);
      }
    },
  };
}
