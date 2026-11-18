import { readAccountSettingValueForBackendTarget } from '@happier-dev/protocol/account/settings/accountSettings';
import { buildBackendTargetKeyV2, type PersistedBackendTargetRefV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import type { ConnectedAccountCatalogSnapshotV1 } from '@happier-dev/protocol/connect/connectedAccountCatalogV1';
import { readAgentDefaultModelSelectionV1 } from '@happier-dev/protocol/providers/selection/v1';
import { parseAgentPermissionIntentV1Alias } from '@happier-dev/protocol/runtime/permissionIntentV1';
import type { ManagedSessionDefaultsV1 } from '@happier-dev/protocol/teams/managedDefaults';
import { readAgentPurposeDefaults } from '@/session/services/spawnConnectedServicesDefaults';

/** Project the requester's saved facets into the shared defaults precedence owner. */
export function readSessionSpawnMemberDefaults(target: PersistedBackendTargetRefV2, params: Readonly<{
  agentId: string;
  accountSettings: unknown;
  purposeCatalog?: ConnectedAccountCatalogSnapshotV1;
}>): ManagedSessionDefaultsV1 {
  const settings = params.accountSettings && typeof params.accountSettings === 'object' && !Array.isArray(params.accountSettings)
    ? params.accountSettings as Readonly<Record<string, unknown>> : {};
  const key = buildBackendTargetKeyV2(target);
  const permission = parseAgentPermissionIntentV1Alias(String(readAccountSettingValueForBackendTarget(
    settings, 'sessionDefaultPermissionModeByTargetKey', target) ?? ''));
  const model = readAgentDefaultModelSelectionV1(settings.providerDefaultModelSelectionsByAgentTargetKeyV1, target);
  return {
    ...(permission ? { permissionModeByAgentTargetKey: { [key]: permission } } : {}),
    ...(model ? { modelByAgentTargetKey: { [key]: model } } : {}),
    connectedServicesByAgentTargetKey: { [key]: readAgentPurposeDefaults({ ...params, accountSettings: settings, onlySavedDefaults: true }) },
  };
}
