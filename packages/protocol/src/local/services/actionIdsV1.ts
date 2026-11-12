import { RPC_METHODS } from '../../rpc/methods.js';
import type { RuntimeActionIdV1 } from '../../actions/actionIds.js';
import type { LocalServiceActionKindV1 } from './actions/v1.js';

/** Schema-free ids: Action identity must not initialize its own spec graph. */
export const MACHINE_SERVICE_ADOPT_ACTION_ID = 'machines.services.adopt' as const;
export const MACHINE_SERVICE_ADOPT_CREATE_ROLE_V1 = 'adopt-environment' as const;
export const MACHINE_SERVICE_ADOPT_BINDINGS_ROLE_V1 = 'adopt-bindings' as const;
export const MACHINE_SERVICE_FRONTDOOR_ACTION_IDS = [
  'machines.services.list', 'machines.services.discovery', 'machines.services.detail',
  'machines.services.watch', 'machines.services.unwatch', MACHINE_SERVICE_ADOPT_ACTION_ID,
] as const;
export const MACHINE_SERVICE_LOGS_READ_ACTION_ID = 'machines.services.logs.read' as const;
export const MACHINE_SERVICE_CONTROL_ACTION_ID = 'machines.services.control' as const;
export const MACHINE_SERVICE_ACTION_IDS = [...MACHINE_SERVICE_FRONTDOOR_ACTION_IDS, MACHINE_SERVICE_LOGS_READ_ACTION_ID, MACHINE_SERVICE_CONTROL_ACTION_ID, 'machines.services.exec'] as const;

export const LOCAL_SERVICE_ACTION_KINDS_BY_RUNTIME_ACTION = Object.freeze({
  'localServices.actions.copyUrl': 'copy_url',
  'localServices.actions.openPreview': 'open_preview',
  'localServices.actions.forget': 'forget',
  'localServices.actions.stopManaged': 'stop_managed',
  'localServices.actions.restartManaged': 'restart_managed',
  'localServices.actions.terminateDetected': 'terminate_detected',
} as const satisfies Readonly<Partial<Record<RuntimeActionIdV1, LocalServiceActionKindV1>>>);

/** Route admission consumes vocabulary without initializing Action schemas. */
export const LOCAL_SERVICE_CONTROL_ACTION_RPC_METHODS = Object.freeze({
  'localServices.actions.copyUrl': RPC_METHODS.DAEMON_LOCAL_SERVICES_ACTIONS_COPY_URL,
  'localServices.actions.openPreview': RPC_METHODS.DAEMON_LOCAL_SERVICES_ACTIONS_OPEN_PREVIEW,
  'localServices.actions.forget': RPC_METHODS.DAEMON_LOCAL_SERVICES_ACTIONS_FORGET,
  'localServices.actions.stopManaged': RPC_METHODS.DAEMON_LOCAL_SERVICES_ACTIONS_STOP_MANAGED,
  'localServices.actions.restartManaged': RPC_METHODS.DAEMON_LOCAL_SERVICES_ACTIONS_RESTART_MANAGED,
  'localServices.actions.terminateDetected': RPC_METHODS.DAEMON_LOCAL_SERVICES_ACTIONS_TERMINATE_DETECTED,
} satisfies Readonly<Record<keyof typeof LOCAL_SERVICE_ACTION_KINDS_BY_RUNTIME_ACTION, string>>);
