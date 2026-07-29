import { describe, expect, it } from 'vitest';

import { resolvePromptAssetContributionBlocks } from './resolvePromptAssetContributionBlocks';

describe('resolvePromptAssetContributionBlocks', () => {
  it('qualifies same-local ids, orders deterministically, and reads resources through the generation-bound owner', async () => {
    const reads: string[] = [];
    const blocks = await resolvePromptAssetContributionBlocks({
      agent: { pluginId: 'acme.agent', localId: 'worker' },
      contributions: [
        {
          pluginId: 'beta.prompts',
          generationId: 'generation-beta',
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
          generationId: 'generation-alpha',
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
        reads.push(`${request.pluginId}/${request.resourceLocalId}@${request.generationId}`);
        return `${request.pluginId} prompt`;
      },
    });

    expect(reads).toEqual([
      'alpha.prompts/body@generation-alpha',
      'beta.prompts/body@generation-beta',
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

  it('fails closed for unavailable policy, stale generation reads, and cross-target assets', async () => {
    const readResourceText = async () => {
      throw new Error('stale generation');
    };
    const base = {
      pluginId: 'acme.prompts',
      generationId: 'old-generation',
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
    })).rejects.toThrow('stale generation');

    await expect(resolvePromptAssetContributionBlocks({
      agent: { pluginId: 'acme.agent', localId: 'worker' },
      contributions: [{ ...base, generationId: 'current-generation' }],
      readResourceText: async () => '   ',
    })).rejects.toMatchObject({ code: 'PLUGIN_PROMPT_ASSET_RESOURCE_INVALID' });
  });

  it('rejects two active generations for the same qualified prompt asset', async () => {
    const definition = {
      id: 'instructions',
      kind: 'systemPrompt' as const,
      resource: 'body',
      target: { kind: 'agent' as const, agent: { pluginId: 'acme.agent', localId: 'worker' } },
    };

    await expect(resolvePromptAssetContributionBlocks({
      agent: { pluginId: 'acme.agent', localId: 'worker' },
      contributions: [
        { pluginId: 'acme.prompts', generationId: 'old', definition },
        { pluginId: 'acme.prompts', generationId: 'new', definition },
      ],
      readResourceText: async () => 'prompt',
    })).rejects.toMatchObject({ code: 'PLUGIN_PROMPT_ASSET_IDENTITY_CONFLICT' });
  });

  it('preserves the exact non-empty resource text', async () => {
    await expect(resolvePromptAssetContributionBlocks({
      agent: { pluginId: 'acme.agent', localId: 'worker' },
      contributions: [{
        pluginId: 'acme.prompts', generationId: 'current',
        definition: {
          id: 'instructions', kind: 'systemPrompt', resource: 'body',
          target: { kind: 'agent', agent: { pluginId: 'acme.agent', localId: 'worker' } },
        },
      }],
      readResourceText: async () => '\nExact prompt bytes\n',
    })).resolves.toEqual([{
      id: 'plugin_prompt_asset.acme.prompts/instructions',
      scope: 'session',
      text: '\nExact prompt bytes\n',
    }]);
  });

  it('materializes only the selected qualified asset when one Agent has multiple profile prompts', async () => {
    const blocks = await resolvePromptAssetContributionBlocks({
      agent: { pluginId: 'happier.review.deepsec', localId: 'deepsec' },
      selectedAsset: { pluginId: 'happier.review.deepsec', localId: 'repository-security-audit-prompt' },
      contributions: [
        {
          pluginId: 'happier.review.deepsec', generationId: 'current',
          definition: {
            id: 'review-prompt', kind: 'systemPrompt', resource: 'review-body',
            target: { kind: 'agent', agent: 'deepsec' },
          },
        },
        {
          pluginId: 'happier.review.deepsec', generationId: 'current',
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
