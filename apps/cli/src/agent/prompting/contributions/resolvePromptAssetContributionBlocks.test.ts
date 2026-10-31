import { describe, expect, it } from 'vitest';
import { createPluginRuntimeOccurrenceId } from '@/plugins/runtime/runtimeSlots';

import { resolvePromptAssetContributionBlocks } from './resolvePromptAssetContributionBlocks';

describe('resolvePromptAssetContributionBlocks', () => {
  it('qualifies same-local ids, orders deterministically, and reads resources through the occurrence-bound owner', async () => {
    const reads: string[] = [];
    const betaOccurrenceId = createPluginRuntimeOccurrenceId('beta.prompts');
    const alphaOccurrenceId = createPluginRuntimeOccurrenceId('alpha.prompts');
    const blocks = await resolvePromptAssetContributionBlocks({
      agent: { pluginId: 'acme.agent', localId: 'worker' },
      contributions: [
        {
          pluginId: 'beta.prompts',
          occurrenceId: betaOccurrenceId,
          definition: {
            id: 'shared',
            kind: 'context',
            resource: 'body',
            target: { kind: 'agent', agent: { pluginId: 'acme.agent', localId: 'worker' } },
            priority: 20,
          },
        },
        {
          pluginId: 'alpha.prompts',
          occurrenceId: alphaOccurrenceId,
          definition: {
            id: 'shared',
            kind: 'systemPrompt',
            resource: 'body',
            target: { kind: 'agent', agent: { pluginId: 'acme.agent', localId: 'worker' } },
            priority: 10,
          },
        },
      ],
      readResourceText: async (request) => {
        reads.push(`${request.pluginId}/${request.resourceLocalId}@${request.occurrenceId}`);
        return `${request.pluginId} prompt`;
      },
    });

    expect(reads).toEqual([
      `alpha.prompts/body@${alphaOccurrenceId}`,
      `beta.prompts/body@${betaOccurrenceId}`,
    ]);
    expect(blocks).toEqual([
      {
        id: 'plugin_prompt_asset.alpha.prompts/shared',
        scope: 'session',
        text: 'alpha.prompts prompt',
      },
      {
        id: 'plugin_prompt_asset.beta.prompts/shared',
        scope: 'first_turn',
        text: 'beta.prompts prompt',
      },
    ]);
  });

  it('fails closed for unavailable policy, stale occurrence reads, and cross-target assets', async () => {
    const readResourceText = async () => {
      throw new Error('stale occurrence');
    };
    const base = {
      pluginId: 'acme.prompts',
      occurrenceId: createPluginRuntimeOccurrenceId('acme.prompts'),
      definition: {
        id: 'instructions',
        kind: 'guidelines' as const,
        resource: 'body',
        target: { kind: 'agent' as const, agent: { pluginId: 'acme.agent', localId: 'worker' } },
      },
    };

    await expect(resolvePromptAssetContributionBlocks({
      agent: { pluginId: 'acme.agent', localId: 'other' },
      contributions: [base],
      readResourceText,
    })).resolves.toEqual([]);

    await expect(resolvePromptAssetContributionBlocks({
      agent: { pluginId: 'acme.agent', localId: 'worker' },
      selectedAsset: { pluginId: 'acme.prompts', localId: 'instructions' },
      contributions: [{
        ...base,
        definition: {
          ...base.definition,
          availability: { when: { fact: 'plugin.enabled', operator: 'equals', value: true } },
        },
      }],
      readResourceText,
    })).rejects.toMatchObject({ code: 'PLUGIN_PROMPT_ASSET_POLICY_UNAVAILABLE' });

    await expect(resolvePromptAssetContributionBlocks({
      agent: { pluginId: 'acme.agent', localId: 'worker' },
      contributions: [base],
      readResourceText,
    })).rejects.toThrow('stale occurrence');

    await expect(resolvePromptAssetContributionBlocks({
      agent: { pluginId: 'acme.agent', localId: 'worker' },
      contributions: [{ ...base, occurrenceId: createPluginRuntimeOccurrenceId('acme.prompts') }],
      readResourceText: async () => '   ',
    })).rejects.toMatchObject({ code: 'PLUGIN_PROMPT_ASSET_RESOURCE_INVALID' });
  });

  it('rejects two active occurrences for the same qualified prompt asset', async () => {
    const definition = {
      id: 'instructions',
      kind: 'systemPrompt' as const,
      resource: 'body',
      target: { kind: 'agent' as const, agent: { pluginId: 'acme.agent', localId: 'worker' } },
    };

    await expect(resolvePromptAssetContributionBlocks({
      agent: { pluginId: 'acme.agent', localId: 'worker' },
      contributions: [
        { pluginId: 'acme.prompts', occurrenceId: createPluginRuntimeOccurrenceId('acme.prompts'), definition },
        { pluginId: 'acme.prompts', occurrenceId: createPluginRuntimeOccurrenceId('acme.prompts'), definition },
      ],
      readResourceText: async () => 'prompt',
    })).rejects.toMatchObject({ code: 'PLUGIN_PROMPT_ASSET_IDENTITY_CONFLICT' });
  });

  it('materializes only the selected qualified asset when one Agent has multiple profile prompts', async () => {
    const blocks = await resolvePromptAssetContributionBlocks({
      agent: { pluginId: 'happier.review.deepsec', localId: 'deepsec' },
      selectedAsset: { pluginId: 'happier.review.deepsec', localId: 'repository-security-audit-prompt' },
      contributions: [
        {
          pluginId: 'happier.review.deepsec', occurrenceId: createPluginRuntimeOccurrenceId('happier.review.deepsec'),
          definition: {
            id: 'review-prompt', kind: 'systemPrompt', resource: 'review-body',
            target: { kind: 'agent', agent: 'deepsec' },
          },
        },
        {
          pluginId: 'happier.review.deepsec', occurrenceId: createPluginRuntimeOccurrenceId('happier.review.deepsec'),
          definition: {
            id: 'repository-security-audit-prompt', kind: 'systemPrompt', resource: 'audit-body',
            target: { kind: 'agent', agent: 'deepsec' },
          },
        },
      ],
      readResourceText: async ({ resourceLocalId }) => `${resourceLocalId} text`,
    });

    expect(blocks).toEqual([{
      id: 'plugin_prompt_asset.happier.review.deepsec/repository-security-audit-prompt',
      scope: 'session',
      text: 'audit-body text',
    }]);
  });

  it('fails closed when a selected qualified asset is absent', async () => {
    await expect(resolvePromptAssetContributionBlocks({
      agent: { pluginId: 'happier.review.deepsec', localId: 'deepsec' },
      selectedAsset: { pluginId: 'happier.review.deepsec', localId: 'missing-prompt' },
      contributions: [],
      readResourceText: async () => 'unreachable',
    })).rejects.toMatchObject({ code: 'PLUGIN_PROMPT_ASSET_RESOURCE_INVALID' });
  });
});
