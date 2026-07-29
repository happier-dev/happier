import {
  addOrUpdateProviderManualModelsV1,
  areProviderContributionKeysEqualV1,
  createProviderErrorV1,
  parseBackendTargetKeyV2,
  removeProviderManualModelV1,
  resetProviderModelVisibilityV1,
  setProviderExperimentalConfirmationV1,
  setProviderModelVisibilityV1,
} from '@happier-dev/protocol';

import type { ProviderConnectionServiceContext } from './context';
import { readSettings, replaceSettings } from './settings';
import type {
  ProviderConnectionServiceResult,
  ProviderModelSettingsMutationIntent,
} from './types';

export function createProviderModelSettingsOperations(
  context: ProviderConnectionServiceContext,
) {
  const mutate = async (
    intent: ProviderModelSettingsMutationIntent,
  ): Promise<ProviderConnectionServiceResult<{ action: ProviderModelSettingsMutationIntent['action'] }>> => {
    const connectionId = 'connectionId' in intent ? intent.connectionId : undefined;
    if (!context.deps.featureGate.isEnabled('providers')) {
      return { status: 'error', error: context.featureError(connectionId) };
    }
    const machineError = context.assertMachine(intent.machineId, connectionId);
    if (machineError) return { status: 'error', error: machineError };

    await context.deps.updateAccountSettings((raw) => {
      let settings = readSettings(raw, {
        ...(connectionId ? { connectionId } : {}),
        machineId: intent.machineId,
      });
      switch (intent.action) {
        case 'manualAdd': {
          const connection = settings.connections.find(
            (candidate) => candidate.id === intent.connectionId,
          );
          if (!connection) {
            throw createProviderErrorV1('provider_connection_not_found', {
              connectionId: intent.connectionId,
              machineId: intent.machineId,
            });
          }
          if (connection.revision !== intent.expectedConnectionRevision) {
            throw createProviderErrorV1('provider_connection_changed', {
              connectionId: intent.connectionId,
              machineId: intent.machineId,
            });
          }
          const sourceMatches = (
            connection.source.kind === 'custom'
            && intent.expectedManualSource.kind === 'custom'
          ) || (
            connection.source.kind === 'contribution'
            && intent.expectedManualSource.kind === 'contribution'
            && areProviderContributionKeysEqualV1(
              connection.source.contributionKey,
              intent.expectedManualSource.contributionKey,
            )
          );
          if (!sourceMatches) {
            throw createProviderErrorV1('provider_authorization_changed', {
              connectionId: intent.connectionId,
              machineId: intent.machineId,
            });
          }
          settings = addOrUpdateProviderManualModelsV1(settings, {
            connectionId: intent.connectionId,
            models: intent.models,
            addedAt: context.deps.now(),
          });
          break;
        }
        case 'manualRemove': {
          const connection = settings.connections.find(
            (candidate) => candidate.id === intent.connectionId,
          );
          if (!connection) {
            throw createProviderErrorV1('provider_connection_not_found', {
              connectionId: intent.connectionId,
              machineId: intent.machineId,
            });
          }
          if (connection.revision !== intent.expectedConnectionRevision) {
            throw createProviderErrorV1('provider_connection_changed', {
              connectionId: intent.connectionId,
              machineId: intent.machineId,
            });
          }
          settings = removeProviderManualModelV1(settings, intent);
          break;
        }
        case 'setVisibility':
          if (intent.ref.scope === 'agent') {
            parseBackendTargetKeyV2(intent.ref.agentTargetKey);
          }
          settings = setProviderModelVisibilityV1(settings, intent);
          break;
        case 'resetVisibility':
          settings = resetProviderModelVisibilityV1(settings, intent);
          break;
        case 'bulkVisibility':
          for (const change of intent.changes) {
            if (change.ref.scope === 'agent') {
              parseBackendTargetKeyV2(change.ref.agentTargetKey);
            }
            settings = setProviderModelVisibilityV1(settings, change);
          }
          break;
        case 'confirmExperimental': {
          const connection = settings.connections.find(
            (candidate) => candidate.id === intent.connectionId,
          );
          if (!connection) {
            throw createProviderErrorV1('provider_compatibility_unverified', {
              connectionId: intent.connectionId,
              machineId: intent.machineId,
            });
          }
          if (connection.revision !== intent.expectedConnectionRevision) {
            throw createProviderErrorV1('provider_connection_changed', {
              connectionId: intent.connectionId,
              machineId: intent.machineId,
            });
          }
          settings = setProviderExperimentalConfirmationV1(settings, {
            connectionId: intent.connectionId,
            agentTargetKey: intent.agentTargetKey,
            modelId: intent.modelId,
            compatibilityFingerprint: intent.compatibilityFingerprint,
            confirmedAt: context.deps.now(),
          });
          break;
        }
      }
      return replaceSettings(raw, settings);
    });
    return { status: 'success', action: intent.action };
  };

  return Object.freeze({ mutate });
}
