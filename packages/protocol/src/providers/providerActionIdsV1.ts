import { RPC_METHODS } from '../rpc/methods.js';

export const PROVIDER_ACTION_IDS_V1 = [
  'providers.gateways.choose',
  'providers.connections.describe',
  'providers.connections.create_contribution', 'providers.connections.create_custom',
  'providers.connections.enable_detected', 'providers.connections.start_local',
  'providers.connections.update', 'providers.connections.endpoint.set',
  'providers.connections.duplicate', 'providers.connections.delete',
  'providers.connections.enabled.set', 'providers.connections.secrets.bind',
  'providers.models.list', 'providers.models.projection', 'providers.models.refresh',
  'providers.models.manual.add', 'providers.models.manual.remove',
  'providers.models.visibility.set', 'providers.models.visibility.reset', 'providers.models.visibility.bulk',
  'providers.models.source_visibility.set',
  'providers.models.experimental.confirm', 'providers.models.load', 'providers.models.cancel_load',
  'providers.probe', 'providers.usage.refresh', 'providers.binding.status', 'providers.legacy.prepare', 'providers.defaults.set',
] as const;
export type ProviderActionIdV1 = typeof PROVIDER_ACTION_IDS_V1[number];
/** Removing a Provider connection; its confirmation names the one verb its UI uses. */
export const PROVIDER_CONNECTION_DELETE_ACTION_ID_V1 = 'providers.connections.delete' as const satisfies ProviderActionIdV1;
export function isProviderActionIdV1(value: string): value is ProviderActionIdV1 {
  return (PROVIDER_ACTION_IDS_V1 as readonly string[]).includes(value);
}
type ProviderAccountActionIdV1 = 'providers.defaults.set' | 'providers.models.source_visibility.set' | 'providers.gateways.choose';
type ProviderActionRpcRouteV1 = Readonly<{ method: string; mutation: boolean }>;
export function resolveProviderActionRpcRouteV1(actionId: Exclude<ProviderActionIdV1, ProviderAccountActionIdV1>): ProviderActionRpcRouteV1;
export function resolveProviderActionRpcRouteV1(actionId: ProviderActionIdV1): ProviderActionRpcRouteV1 | null;
/** Execution and Machine admission consume this one native route declaration. */
export function resolveProviderActionRpcRouteV1(actionId: ProviderActionIdV1): ProviderActionRpcRouteV1 | null {
  switch (actionId) {
    case 'providers.defaults.set':
    case 'providers.gateways.choose':
    case 'providers.models.source_visibility.set': return null;
    case 'providers.connections.describe': return { method: RPC_METHODS.DAEMON_PROVIDERS_CONNECTIONS_DESCRIBE, mutation: false };
    case 'providers.models.list': return { method: RPC_METHODS.DAEMON_PROVIDERS_MODELS, mutation: false };
    case 'providers.models.projection':
    case 'providers.models.refresh': return { method: RPC_METHODS.DAEMON_PROVIDERS_MODEL_PROJECTION, mutation: false };
    case 'providers.probe': return { method: RPC_METHODS.DAEMON_PROVIDERS_PROBE, mutation: false };
    case 'providers.usage.refresh': return { method: RPC_METHODS.DAEMON_PROVIDERS_USAGE_REFRESH, mutation: false };
    case 'providers.binding.status': return { method: RPC_METHODS.DAEMON_PROVIDERS_BINDING_STATUS, mutation: false };
    case 'providers.legacy.prepare': return { method: RPC_METHODS.DAEMON_PROVIDERS_PROFILE_MIGRATION_PREPARE_SOURCE, mutation: true };
    case 'providers.models.load':
    case 'providers.models.cancel_load': return { method: RPC_METHODS.DAEMON_PROVIDERS_MODEL_LOAD, mutation: true };
    case 'providers.models.manual.add':
    case 'providers.models.manual.remove':
    case 'providers.models.visibility.set':
    case 'providers.models.visibility.reset':
    case 'providers.models.visibility.bulk':
    case 'providers.models.experimental.confirm': return { method: RPC_METHODS.DAEMON_PROVIDERS_MODEL_SETTINGS_MUTATE, mutation: true };
    case 'providers.connections.create_contribution':
    case 'providers.connections.create_custom':
    case 'providers.connections.enable_detected':
    case 'providers.connections.start_local':
    case 'providers.connections.update':
    case 'providers.connections.endpoint.set':
    case 'providers.connections.duplicate':
    case 'providers.connections.delete':
    case 'providers.connections.enabled.set':
    case 'providers.connections.secrets.bind': return { method: RPC_METHODS.DAEMON_PROVIDERS_CONNECTION_MUTATE, mutation: true };
  }
}

/** Internal review and saved-connection verification spend their original admission. */
export function resolveProviderActionRpcEffectV1(method: string, rootActionId: string): ProviderActionIdV1 | null {
  if (!isProviderActionIdV1(rootActionId)) return null;
  if (resolveProviderActionRpcRouteV1(rootActionId)?.method === method) return rootActionId;
  switch (rootActionId) {
    case 'providers.connections.create_custom':
    case 'providers.connections.create_contribution':
      // Both creation paths read the probe owner's published health summary.
      return method === RPC_METHODS.DAEMON_PROVIDERS_PROBE || method === RPC_METHODS.DAEMON_PROVIDERS_CONNECTIONS_DESCRIBE
        ? rootActionId : null;
    case 'providers.connections.endpoint.set':
      return method === RPC_METHODS.DAEMON_PROVIDERS_CONNECTIONS_DESCRIBE ? rootActionId : null;
    default: return null;
  }
}
