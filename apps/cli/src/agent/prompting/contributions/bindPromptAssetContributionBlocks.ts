import type { PromptBlockV1 } from '@happier-dev/protocol';

import type { ResolvedPromptAssetContribution } from '@/plugins/projection/registry/types';
import type { StablePluginResourcesOwner } from '@/plugins/runtime/invocation/services/resources';
import {
  evaluateContributionAvailability,
  type ContributionPolicyFacts,
} from '@/plugins/runtime/policy/evaluate';
import {
  PluginPromptAssetConsumerError,
  resolvePromptAssetContributionBlocks,
} from './resolvePromptAssetContributionBlocks';

export const MAX_PLUGIN_PROMPT_ASSET_BYTES = 256 * 1024;

function failResource(message: string): never {
  throw new PluginPromptAssetConsumerError('PLUGIN_PROMPT_ASSET_RESOURCE_INVALID', message);
}

export async function bindPromptAssetContributionBlocks(params: Readonly<{
  promptAssets: readonly ResolvedPromptAssetContribution[];
  resolveContributionGeneration(pluginId: string): string | null;
  resources: StablePluginResourcesOwner | undefined;
  agent: Readonly<{ pluginId: string; localId: string }>;
  selectedAsset?: Readonly<{ pluginId: string; localId: string }>;
  signal: AbortSignal;
  isGenerationCurrent(): boolean;
  facts: ContributionPolicyFacts;
}>): Promise<readonly PromptBlockV1[]> {
  if (!params.isGenerationCurrent()) {
    return failResource('Prompt asset generation is stale');
  }
  return await resolvePromptAssetContributionBlocks({
    agent: params.agent,
    ...(params.selectedAsset ? { selectedAsset: params.selectedAsset } : {}),
    contributions: params.promptAssets.flatMap((asset) => {
      const generationId = params.resolveContributionGeneration(asset.pluginId);
      return generationId
        ? [Object.freeze({
          pluginId: asset.pluginId,
          generationId,
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
      if (!params.isGenerationCurrent() || params.signal.aborted) {
        return failResource('Prompt asset generation is stale');
      }
      if (!params.resources?.hasPlugin(request.resourcePluginId)) {
        return failResource('Prompt asset resource generation is unavailable');
      }
      const service = params.resources.bind({
        pluginId: request.resourcePluginId,
        signal: params.signal,
        isGenerationCurrent: params.isGenerationCurrent,
      });
      const descriptor = service.describe(request.resourceLocalId);
      if (descriptor.kind !== 'prompt' || !descriptor.contentType.toLowerCase().startsWith('text/')) {
        return failResource('Prompt asset resource must be textual prompt content');
      }
      const result = await service.read(request.resourceLocalId, {
        maxBytes: MAX_PLUGIN_PROMPT_ASSET_BYTES,
        signal: params.signal,
      });
      if (result.kind !== descriptor.kind
        || result.contentType !== descriptor.contentType
        || result.digest !== descriptor.digest) {
        return failResource('Prompt asset resource identity changed during materialization');
      }
      try {
        return new TextDecoder('utf-8', { fatal: true }).decode(result.bytes);
      } catch {
        return failResource('Prompt asset resource is not valid UTF-8 text');
      }
    },
  });
}
