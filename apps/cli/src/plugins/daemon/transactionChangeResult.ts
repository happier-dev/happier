import type { PluginRegistryTransactionResult } from '@/plugins/store/registry/service';

import type { PluginChangeApplyResult } from './changeContract';

type CurrentnessTransaction =
  | Extract<PluginRegistryTransactionResult, { status: 'committed' }>
  | Extract<PluginRegistryTransactionResult, { status: 'outcomeUnknown' }>;

/**
 * Projects the canonical registry transaction result onto the daemon control
 * contract. Primary durability/adoption ambiguity is never represented as a
 * positive commit with a pending surface.
 */
export function projectPluginTransactionChangeResult(params: Readonly<{
  pluginId: string;
  desiredGeneration: string | null;
  transaction: CurrentnessTransaction | null;
}>): PluginChangeApplyResult {
  if (params.transaction?.status === 'outcomeUnknown') {
    return Object.freeze({
      kind: 'outcomeUnknown',
      pluginId: params.pluginId,
      ...(params.desiredGeneration
        ? { expectedCandidate: params.desiredGeneration }
        : {}),
    });
  }
  return Object.freeze({
    kind: 'committed',
    pluginId: params.pluginId,
    desiredGeneration: params.desiredGeneration,
    appliedGeneration: params.transaction?.status === 'committed'
      && params.transaction.appliedGenerationsByPluginId
      && Object.prototype.hasOwnProperty.call(
        params.transaction.appliedGenerationsByPluginId,
        params.pluginId,
      )
      ? params.transaction.appliedGenerationsByPluginId[params.pluginId] ?? null
      : params.desiredGeneration,
    pendingSurfaces: params.transaction?.pendingSurfaces ?? Object.freeze([]),
  });
}
