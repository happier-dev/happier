import { describe, expect, it } from 'vitest';

import { ExecutionRunIntentSchema } from '@happier-dev/protocol';

import {
  buildExecutionRunProfileCatalog,
  listExecutionRunProfileContributionDescriptors,
  listExecutionRunSupportedIntents,
  resolveExecutionRunIntentProfile,
  resolveExecutionRunIntentProfileFromCatalog,
  resolveExecutionRunProfileContributionDescriptor,
} from './intentRegistry';
import * as intentRegistry from './intentRegistry';

describe('executionRun intent profile registry', () => {
  it('keeps profile coverage aligned with the protocol intent surface', () => {
    expect(listExecutionRunSupportedIntents().slice().sort()).toEqual(ExecutionRunIntentSchema.options.slice().sort());

    for (const intent of ExecutionRunIntentSchema.options) {
      expect(resolveExecutionRunIntentProfile(intent).intent).toBe(intent);
    }
  });

  it('does not expose the built-in profile map as an unmanaged registry bypass', () => {
    expect('EXECUTION_RUN_INTENT_PROFILE_REGISTRY' in intentRegistry).toBe(false);
  });

  it('keeps special start shaping isolated to profiles that need runtime evidence', () => {
    expect(typeof resolveExecutionRunIntentProfile('voice_agent').prepareStartParams).toBe('function');
    expect(typeof resolveExecutionRunIntentProfile('scm_commit_message').prepareStartParams).toBe('function');
    expect(typeof resolveExecutionRunIntentProfile('review').prepareStartParams).toBe('function');
    expect(resolveExecutionRunIntentProfile('plan').prepareStartParams).toBeUndefined();
    expect(resolveExecutionRunIntentProfile('delegate').prepareStartParams).toBeUndefined();
    expect(resolveExecutionRunIntentProfile('memory_hints').prepareStartParams).toBeUndefined();
  });

  it('builds an O(1) descriptor catalog keyed by profile id', () => {
    const catalog = buildExecutionRunProfileCatalog([
      {
        id: 'review', intent: 'review', title: 'Acme review', promptAsset: 'review-prompt',
        compatibleAgents: ['reviewer'],
        defaults: { retention: 'ephemeral', runClass: 'bounded', io: 'streaming' },
        actions: [{ kind: 'hostAction', actionId: 'reviews.comments.create' }],
      },
    ]);

    expect(catalog.profileDescriptorsById).toBeInstanceOf(Map);
    expect(catalog.profileDescriptorIdsByIntent).toBeInstanceOf(Map);
    expect(resolveExecutionRunProfileContributionDescriptor(catalog, 'review')?.title).toBe('Acme review');
    expect(listExecutionRunProfileContributionDescriptors(catalog).map((entry) => entry.id)).toEqual([
      'review',
    ]);
    expect(resolveExecutionRunIntentProfileFromCatalog(catalog, 'review', 'review').listAvailableActionIds?.({
      start: { runId: 'run_1', callId: 'call_1' } as never,
      structuredMeta: {
        kind: 'review_findings.v2',
        payload: {
          runRef: { runId: 'run_1', callId: 'call_1' },
          proposedComments: [{ body: 'Finding', anchor: { kind: 'file', filePath: 'src/auth.ts' } }],
        },
      },
    })).toContain('reviews.comments.create');
    expect(resolveExecutionRunIntentProfileFromCatalog(catalog, 'review', 'review').listAvailableActionIds?.({
      start: { runId: 'run_1', callId: 'call_1' } as never,
      structuredMeta: { kind: 'review_findings.v2', payload: { runRef: { runId: 'run_1', callId: 'call_1' }, proposedComments: [] } },
    })).not.toContain('reviews.comments.create');
  });

  it('rejects duplicate contributed profile ids before they can shadow canonical lookup', () => {
    expect(() => buildExecutionRunProfileCatalog([
      {
        id: 'review', intent: 'review', title: 'Review', promptAsset: 'review-prompt',
        compatibleAgents: ['reviewer'],
        defaults: { retention: 'ephemeral', runClass: 'bounded', io: 'streaming' },
      },
      {
        id: 'review', intent: 'review', title: 'Duplicate', promptAsset: 'other-prompt',
        compatibleAgents: ['reviewer'],
        defaults: { retention: 'ephemeral', runClass: 'bounded', io: 'streaming' },
      },
    ])).toThrow(/Duplicate execution-run profile contribution/);
  });

  it('qualifies same-local-id profiles and local contribution action references by owning plugin', () => {
    const definition = {
      id: 'review', intent: 'review' as const, title: 'Review', promptAsset: 'review-prompt',
      compatibleAgents: ['reviewer'],
      defaults: { retention: 'ephemeral' as const, runClass: 'bounded' as const, io: 'streaming' as const },
      actions: [{ kind: 'contributionAction' as const, action: 'publish' }],
    };
    const catalog = buildExecutionRunProfileCatalog([
      {
        pluginId: 'happier.review.coderabbit',
        immutableGenerationId: 'immutable-coderabbit',
        definition,
      },
      {
        pluginId: 'happier.review.deepsec',
        immutableGenerationId: 'immutable-deepsec',
        definition: { ...definition, title: 'DeepSec review' },
      },
    ]);

    expect(listExecutionRunProfileContributionDescriptors(catalog).map((entry) => entry.id)).toEqual([
      'happier.review.coderabbit/review',
      'happier.review.deepsec/review',
    ]);
    expect(resolveExecutionRunIntentProfileFromCatalog(
      catalog, 'review', 'happier.review.coderabbit/review',
    ).listAvailableActionIds?.({ start: {} as never })).toContain('happier.review.coderabbit/publish');
  });

  it('never cross-resolves a review host action onto a non-review intent', () => {
    const catalog = buildExecutionRunProfileCatalog([{
      pluginId: 'happier.review.coderabbit',
      immutableGenerationId: 'immutable-coderabbit',
      definition: {
        id: 'review', intent: 'review', title: 'Review', promptAsset: 'review-prompt',
        compatibleAgents: ['reviewer'],
        defaults: { retention: 'ephemeral', runClass: 'bounded', io: 'streaming' },
        actions: [{ kind: 'hostAction', actionId: 'reviews.comments.create' }],
      },
    }]);
    expect(() => resolveExecutionRunIntentProfileFromCatalog(
      catalog, 'plan', 'happier.review.coderabbit/review',
    )).toThrow(/does not own intent/);
  });

  it('uses the contributed intent as the qualified runtime-profile owner and fails stale or mismatched selections closed', () => {
    const catalog = buildExecutionRunProfileCatalog([{
      pluginId: 'acme.review',
      immutableGenerationId: 'immutable-review',
      definition: {
        id: 'review', intent: 'review', title: 'Review', promptAsset: 'review-prompt',
        compatibleAgents: ['reviewer'],
        defaults: { retention: 'ephemeral', runClass: 'bounded', io: 'streaming' },
      },
    }]);

    expect(catalog.profileDescriptorIdsByIntent.get('review')).toEqual(['acme.review/review']);
    expect(catalog.runtimeProfilesById.get('acme.review/review')?.intent).toBe('review');
    expect(() => resolveExecutionRunIntentProfileFromCatalog(catalog, 'plan', 'acme.review/review'))
      .toThrow(/intent/i);
    expect(() => resolveExecutionRunIntentProfileFromCatalog(catalog, 'review', 'acme.review/missing'))
      .toThrow(/unknown|stale/i);
  });

  it('applies descriptor defaults, enforces compatible Agents, and prepends the selected prompt asset at launch', async () => {
    const requestedAssets: string[] = [];
    const catalog = buildExecutionRunProfileCatalog([{
      pluginId: 'acme.delegate',
      immutableGenerationId: 'immutable-generation-current',
      definition: {
        id: 'research', intent: 'delegate', title: 'Research',
        promptAsset: 'research-prompt',
        compatibleAgents: ['researcher'],
        defaults: { retention: 'ephemeral', runClass: 'bounded', io: 'streaming' },
      },
    }], {
      resolvePromptAssetBlocks: async ({ promptAsset }) => {
        requestedAssets.push(`${promptAsset.pluginId}/${promptAsset.localId}`);
        return [{ id: 'selected', scope: 'session', text: 'Research policy' }];
      },
    });
    const profile = resolveExecutionRunIntentProfileFromCatalog(
      catalog,
      'delegate',
      'acme.delegate/research',
    );
    const patch = await profile.prepareStartParams?.({
      cwd: process.cwd(),
      request: {
        intent: 'delegate',
        backendTarget: { kind: 'builtInAgent', agentId: 'researcher' },
        instructions: 'Inspect the repository.',
        permissionMode: 'read_only',
        retentionPolicy: 'resumable',
        runClass: 'long_lived',
        ioMode: 'request_response',
        profileGenerationId: 'immutable-generation-current',
      },
    });

    expect(requestedAssets).toEqual(['acme.delegate/research-prompt']);
    expect(patch).toMatchObject({
      instructions: 'Research policy\n\nInspect the repository.',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'streaming',
    });

    await expect(profile.prepareStartParams?.({
      cwd: process.cwd(),
      request: {
        intent: 'delegate',
        backendTarget: { kind: 'builtInAgent', agentId: 'researcher' },
        instructions: 'Inspect.', permissionMode: 'read_only', retentionPolicy: 'ephemeral',
        runClass: 'bounded', ioMode: 'streaming', profileGenerationId: 'immutable-generation-stale',
      },
    })).rejects.toMatchObject({ code: 'execution_run_profile_stale' });

    await expect(profile.prepareStartParams?.({
      cwd: process.cwd(),
      request: {
        intent: 'delegate',
        backendTarget: { kind: 'builtInAgent', agentId: 'coderabbit' },
        instructions: 'Inspect.', permissionMode: 'read_only', retentionPolicy: 'ephemeral',
        runClass: 'bounded', ioMode: 'streaming',
        profileGenerationId: 'immutable-generation-current',
      },
    })).rejects.toThrow(/compatible/i);
  });

  it('matches compatible Agent references by typed plugin identity rather than provider-like local ids', async () => {
    const catalog = buildExecutionRunProfileCatalog([{
      pluginId: 'acme.review',
      immutableGenerationId: 'immutable-review',
      definition: {
        id: 'review', intent: 'review', title: 'Review', promptAsset: 'review-prompt',
        compatibleAgents: [{ pluginId: 'acme.review', localId: 'reviewer' }],
        defaults: { retention: 'ephemeral', runClass: 'bounded', io: 'streaming' },
      },
    }], {
      resolveAgentIdentity: () => ({ pluginId: 'acme.provider-shaped', localId: 'reviewer' }),
      resolvePromptAssetBlocks: async () => [{ id: 'prompt', scope: 'session', text: 'prompt' }],
    });
    const profile = resolveExecutionRunIntentProfileFromCatalog(catalog, 'review', 'acme.review/review');

    await expect(profile.prepareStartParams?.({
      cwd: process.cwd(),
      request: {
        intent: 'review', backendTarget: { kind: 'builtInAgent', agentId: 'reviewer' },
        instructions: 'Review.', permissionMode: 'read_only', retentionPolicy: 'ephemeral',
        runClass: 'bounded', ioMode: 'streaming', profileGenerationId: 'immutable-review',
      },
    })).rejects.toMatchObject({ code: 'execution_run_profile_agent_incompatible' });
  });

  it('fails a gated contributed profile closed through the shared availability owner', async () => {
    const catalog = buildExecutionRunProfileCatalog([{
      pluginId: 'acme.review',
      immutableGenerationId: 'immutable-review',
      definition: {
        id: 'review', intent: 'review', title: 'Review', promptAsset: 'review-prompt',
        compatibleAgents: ['reviewer'],
        defaults: { retention: 'ephemeral', runClass: 'bounded', io: 'streaming' },
        availability: { when: { fact: 'plugin.enabled', operator: 'equals', value: true } },
      },
    }], {
      resolvePolicyFacts: () => ({ 'plugin.enabled': false }),
      resolvePromptAssetBlocks: async () => [{ id: 'prompt', scope: 'session', text: 'prompt' }],
    });
    const profile = resolveExecutionRunIntentProfileFromCatalog(catalog, 'review', 'acme.review/review');

    await expect(profile.prepareStartParams?.({
      cwd: process.cwd(),
      request: {
        intent: 'review', backendTarget: { kind: 'builtInAgent', agentId: 'reviewer' },
        instructions: 'Review.', permissionMode: 'read_only', retentionPolicy: 'ephemeral',
        runClass: 'bounded', ioMode: 'streaming', profileGenerationId: 'immutable-review',
      },
    })).rejects.toMatchObject({ code: 'execution_run_profile_unavailable' });
  });
});
