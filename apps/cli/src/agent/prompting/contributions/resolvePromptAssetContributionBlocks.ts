import type {
  PluginPromptAssetContributionV1,
  PromptBlockV1,
} from '@happier-dev/protocol';
import {
  buildQualifiedPluginContributionKey,
  createPluginContributionIdentity,
} from '@happier-dev/protocol';

export type PromptAssetContributionOwner = Readonly<{
  pluginId: string;
  generationId: string;
  definition: PluginPromptAssetContributionV1;
}>;

export type PromptAssetAvailabilityDecision = Readonly<{
  applicable: boolean;
  enabled: boolean;
}>;

type PromptAssetAvailability = NonNullable<PluginPromptAssetContributionV1['availability']>;
type PromptAssetReference = PluginPromptAssetContributionV1['resource'];

export class PluginPromptAssetConsumerError extends Error {
  readonly code:
    | 'PLUGIN_PROMPT_ASSET_IDENTITY_CONFLICT'
    | 'PLUGIN_PROMPT_ASSET_POLICY_UNAVAILABLE'
    | 'PLUGIN_PROMPT_ASSET_POLICY_DENIED'
    | 'PLUGIN_PROMPT_ASSET_RESOURCE_INVALID';

  constructor(code: PluginPromptAssetConsumerError['code'], message: string) {
    super(message);
    this.name = 'PluginPromptAssetConsumerError';
    this.code = code;
  }
}

type QualifiedReference = Readonly<{ pluginId: string; localId: string }>;

function qualifyReference(
  ownerPluginId: string,
  reference: PromptAssetReference,
): QualifiedReference {
  return typeof reference === 'string'
    ? { pluginId: ownerPluginId, localId: reference }
    : { pluginId: reference.pluginId, localId: reference.localId };
}

function qualifiedKey(reference: QualifiedReference): string {
  return buildQualifiedPluginContributionKey(createPluginContributionIdentity(reference));
}

function blockScope(kind: PluginPromptAssetContributionV1['kind']): PromptBlockV1['scope'] {
  switch (kind) {
    case 'systemPrompt':
      return 'session';
    case 'guidelines':
      return 'provider_behavior';
    case 'context':
      return 'first_turn';
  }
}

function compareContributions(
  left: PromptAssetContributionOwner,
  right: PromptAssetContributionOwner,
): number {
  const priority = (left.definition.priority ?? 0) - (right.definition.priority ?? 0);
  if (priority !== 0) return priority;
  return qualifiedKey({ pluginId: left.pluginId, localId: left.definition.id }).localeCompare(
    qualifiedKey({ pluginId: right.pluginId, localId: right.definition.id }),
  );
}

/**
 * Canonical prompt-plan handoff for manifest prompt assets.
 *
 * Resource bytes and availability decisions stay with their existing owners:
 * callers must bind `readResourceText` to the SVC11 current-generation resource
 * lease and `evaluateAvailability` to WS2's shared policy evaluator. This
 * function owns only qualification, target filtering, deterministic ordering,
 * and injection scope.
 */
export async function resolvePromptAssetContributionBlocks(params: Readonly<{
  agent: QualifiedReference;
  selectedAsset?: QualifiedReference;
  contributions: readonly PromptAssetContributionOwner[];
  readResourceText(request: Readonly<{
    pluginId: string;
    resourcePluginId: string;
    resourceLocalId: string;
    generationId: string;
    promptAssetLocalId: string;
  }>): Promise<string>;
  evaluateAvailability?: (
    availability: PromptAssetAvailability,
    context: Readonly<{
      pluginId: string;
      generationId: string;
      promptAssetLocalId: string;
      agent: QualifiedReference;
    }>,
  ) => PromptAssetAvailabilityDecision;
}>): Promise<readonly PromptBlockV1[]> {
  const targetKey = qualifiedKey(params.agent);
  const selectedAssetKey = params.selectedAsset ? qualifiedKey(params.selectedAsset) : null;
  const targeted = params.contributions
    .filter((contribution) => {
      const target = qualifyReference(contribution.pluginId, contribution.definition.target.agent);
      return qualifiedKey(target) === targetKey;
    })
    .filter((contribution) => selectedAssetKey === null || qualifiedKey({
      pluginId: contribution.pluginId,
      localId: contribution.definition.id,
    }) === selectedAssetKey);
  if (selectedAssetKey !== null && targeted.length === 0) {
    throw new PluginPromptAssetConsumerError(
      'PLUGIN_PROMPT_ASSET_RESOURCE_INVALID',
      `Selected prompt asset '${selectedAssetKey}' is unavailable for the referenced Agent`,
    );
  }
  const applicable = targeted
    .slice()
    .sort(compareContributions);

  const qualifiedIds = new Set<string>();
  for (const contribution of applicable) {
    const id = qualifiedKey({ pluginId: contribution.pluginId, localId: contribution.definition.id });
    if (qualifiedIds.has(id)) {
      throw new PluginPromptAssetConsumerError(
        'PLUGIN_PROMPT_ASSET_IDENTITY_CONFLICT',
        `Multiple active prompt assets share qualified identity '${id}'`,
      );
    }
    qualifiedIds.add(id);
  }

  const blocks: PromptBlockV1[] = [];
  for (const contribution of applicable) {
    const availability = contribution.definition.availability;
    if (availability) {
      if (!params.evaluateAvailability) {
        throw new PluginPromptAssetConsumerError(
          'PLUGIN_PROMPT_ASSET_POLICY_UNAVAILABLE',
          'Prompt asset availability cannot be evaluated by the shared policy owner',
        );
      }
      const decision = params.evaluateAvailability(availability, {
        pluginId: contribution.pluginId,
        generationId: contribution.generationId,
        promptAssetLocalId: contribution.definition.id,
        agent: params.agent,
      });
      if (!decision.applicable) continue;
      if (!decision.enabled) {
        throw new PluginPromptAssetConsumerError(
          'PLUGIN_PROMPT_ASSET_POLICY_DENIED',
          'Prompt asset is disabled by current policy',
        );
      }
    }

    const resource = qualifyReference(contribution.pluginId, contribution.definition.resource);
    const text = await params.readResourceText({
      pluginId: contribution.pluginId,
      resourcePluginId: resource.pluginId,
      resourceLocalId: resource.localId,
      generationId: contribution.generationId,
      promptAssetLocalId: contribution.definition.id,
    });
    if (!text.trim()) {
      throw new PluginPromptAssetConsumerError(
        'PLUGIN_PROMPT_ASSET_RESOURCE_INVALID',
        'Prompt asset resource is empty',
      );
    }
    blocks.push(Object.freeze({
      id: `plugin_prompt_asset.${qualifiedKey({
        pluginId: contribution.pluginId,
        localId: contribution.definition.id,
      })}`,
      scope: blockScope(contribution.definition.kind),
      text,
    }));
  }

  return Object.freeze(blocks);
}
