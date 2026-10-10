export const PROVIDER_ACTION_IDS_V1 = [
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
  'providers.probe', 'providers.binding.status', 'providers.legacy.prepare', 'providers.defaults.set',
] as const;
export type ProviderActionIdV1 = typeof PROVIDER_ACTION_IDS_V1[number];
export function isProviderActionIdV1(value: string): value is ProviderActionIdV1 {
  return (PROVIDER_ACTION_IDS_V1 as readonly string[]).includes(value);
}
