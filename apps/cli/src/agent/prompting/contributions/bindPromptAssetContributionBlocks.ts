import type { PromptBlockV1 } from '@happier-dev/protocol';

import type { ResolvedPromptAssetContribution } from '@/plugins/projection/registry/types';
import type { PluginRuntimeOccurrenceId } from '@/plugins/runtime/runtimeSlots';
import type { StablePluginResourcesOwner } from '@/plugins/runtime/invocation/services/resources';
import {
  evaluateContributionAvailability,
  type ContributionPolicyFacts,
} from '@/plugins/runtime/policy/evaluate';
import {
  PluginPromptAssetConsumerError,
  resolvePromptAssetContributionBlocks,
  type OptionalPromptAssetUnavailable,
} from './resolvePromptAssetContributionBlocks';

export const MAX_PLUGIN_PROMPT_ASSET_BYTES = 256 * 1024;

function failResource(message: string): never {
  throw new PluginPromptAssetConsumerError('PLUGIN_PROMPT_ASSET_RESOURCE_INVALID', message);
}

export async function bindPromptAssetContributionBlocks(params: Readonly<{
  promptAssets: readonly ResolvedPromptAssetContribution[];
  resolveContributionOccurrence(pluginId: string): PluginRuntimeOccurrenceId | null;
  isContributionOccurrenceCurrent(pluginId: string, occurrenceId: PluginRuntimeOccurrenceId): boolean;
  resources: StablePluginResourcesOwner | undefined;
  agent: Readonly<{ pluginId: string; localId: string }>;
  selectedAsset?: Readonly<{ pluginId: string; localId: string }>;
  onOptionalUnavailable?: (fact: OptionalPromptAssetUnavailable) => void;
  signal: AbortSignal;
  isOccurrenceCurrent(): boolean;
  facts: ContributionPolicyFacts;
}>): Promise<readonly PromptBlockV1[]> {
  params.signal.throwIfAborted();
  if (!params.isOccurrenceCurrent()) {
    return failResource('Prompt asset occurrence is stale');
  }
  try {
    return await resolvePromptAssetContributionBlocks({
      agent: params.agent,
      onOptionalUnavailable: params.onOptionalUnavailable,
      ...(params.selectedAsset ? { selectedAsset: params.selectedAsset } : {}),
      contributions: params.promptAssets.flatMap((asset) => {
        const occurrenceId = params.resolveContributionOccurrence(asset.pluginId);
        return occurrenceId
          ? [Object.freeze({
            pluginId: asset.pluginId,
            occurrenceId,
            definition: asset.definition,
          })]
          : [];
      }),
      evaluateAvailability(availability) {
        const decision = evaluateContributionAvailability({ availability, facts: params.facts });
        if (decision.outcome === 'unavailable') {
          throw new PluginPromptAssetConsumerError(
            'PLUGIN_PROMPT_ASSET_POLICY_UNAVAILABLE',
            'Prompt asset availability cannot be evaluated by the shared policy owner',
          );
        }
        return {
          applicable: decision.outcome !== 'hidden',
          enabled: decision.outcome === 'visible',
        };
      },
      async readResourceText(request) {
        params.signal.throwIfAborted();
        if (
          !params.isOccurrenceCurrent()
          || !params.isContributionOccurrenceCurrent(request.pluginId, request.occurrenceId)
        ) {
          return failResource('Prompt asset occurrence is stale');
        }
        if (!params.resources?.hasPlugin(request.resourcePluginId)) {
          return failResource('Prompt asset resource occurrence is unavailable');
        }
        const service = await params.resources.bindForResource({
          pluginId: request.resourcePluginId,
          resourceId: request.resourceLocalId,
          signal: params.signal,
          isOccurrenceCurrent: params.isOccurrenceCurrent,
        });
        params.signal.throwIfAborted();
        if (!params.isOccurrenceCurrent() || !params.isContributionOccurrenceCurrent(request.pluginId, request.occurrenceId)) {
          return failResource('Prompt asset occurrence is stale');
        }
        let result: Awaited<ReturnType<typeof service.read>>;
        try {
          result = await service.read(request.resourceLocalId, {
            maxBytes: MAX_PLUGIN_PROMPT_ASSET_BYTES,
            signal: params.signal,
          });
        } finally {
          params.signal.throwIfAborted();
          if (!params.isOccurrenceCurrent() || !params.isContributionOccurrenceCurrent(request.pluginId, request.occurrenceId)) {
            failResource('Prompt asset occurrence is stale');
          }
        }
        if (result.kind !== 'prompt' || !result.contentType.toLowerCase().startsWith('text/')) {
          return failResource('Prompt asset resource must be textual prompt content');
        }
        try {
          return new TextDecoder('utf-8', { fatal: true }).decode(result.bytes);
        } catch {
          return failResource('Prompt asset resource is not valid UTF-8 text');
        }
      },
    });
  } finally {
    params.signal.throwIfAborted();
    if (!params.isOccurrenceCurrent()) failResource('Prompt asset occurrence is stale');
  }
}
