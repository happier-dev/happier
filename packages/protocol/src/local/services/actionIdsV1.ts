import { RPC_METHODS } from '../../rpc/methods.js';
import type { RuntimeActionIdV1 } from '../../actions/actionIds.js';
import type { LocalServiceActionKindV1 } from './actions/v1.js';

/** Schema-free ids: Action identity must not initialize its own spec graph. */
export const MACHINE_SERVICE_FRONTDOOR_ACTION_IDS = [
  'machines.services.list', 'machines.services.discovery', 'machines.services.detail',
  'machines.services.watch', 'machines.services.unwatch', 'machines.services.adopt',
] as const;
export const MACHINE_SERVICE_ACTION_IDS = [...MACHINE_SERVICE_FRONTDOOR_ACTION_IDS, 'machines.services.logs.read', 'machines.services.control', 'machines.services.exec'] as const;

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
