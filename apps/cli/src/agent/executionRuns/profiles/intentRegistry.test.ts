import { describe, expect, it } from 'vitest';

import { ExecutionRunIntentSchema } from '@happier-dev/protocol';

import {
  buildExecutionRunProfileCatalog,
  listExecutionRunProfileContributionDescriptors,
  listExecutionRunSupportedIntents,
  resolveExecutionRunIntentProfile,
  resolveExecutionRunIntentProfileFromCatalog,
  resolveExecutionRunProfileSelectionForAgent,
  resolveExecutionRunProfileContributionDescriptor,
} from './intentRegistry';
import * as intentRegistry from './intentRegistry';

const managedProfileCustody = {
  kind: 'managed',
  immutableGenerationId: 'immutable-review',
  installSource: 'archive',
} as const;

describe('executionRun intent profile registry', () => {
  it('selects the same first compatible profile for default launches and preserves an explicit authored selection', () => {
    const catalog = buildExecutionRunProfileCatalog(['first', 'second'].map((id) => ({
      pluginId: 'acme.review', sourceCustody: managedProfileCustody,
      definition: {
        id, intent: 'review' as const, title: id, promptAsset: 'review-prompt', compatibleAgents: ['reviewer'],
        defaults: { retention: 'ephemeral' as const, runClass: 'bounded' as const, io: 'streaming' as const },
      },
    })), { resolveAgentIdentity: (agentId) => agentId === 'public-reviewer'
      ? { pluginId: 'acme.review', localId: 'reviewer' } : null });
    expect(resolveExecutionRunProfileSelectionForAgent(catalog, { intent: 'review', agentId: 'public-reviewer' }))
      .toEqual({ profileId: 'acme.review/first', profileSourceCustody: managedProfileCustody });
    expect(resolveExecutionRunProfileSelectionForAgent(catalog, { intent: 'review', agentId: 'public-reviewer',
      profileId: 'acme.review/second', profileSourceCustody: managedProfileCustody }))
      .toEqual({ profileId: 'acme.review/second', profileSourceCustody: managedProfileCustody });
    expect(resolveExecutionRunProfileSelectionForAgent(catalog, { intent: 'review', agentId: 'unknown' })).toBeNull();
    expect(() => resolveExecutionRunProfileSelectionForAgent(catalog, { intent: 'review', agentId: 'unknown',
      profileId: 'acme.review/second', profileSourceCustody: managedProfileCustody }))
      .toThrowError(expect.objectContaining({ code: 'execution_run_profile_agent_incompatible' }));
    expect(() => resolveExecutionRunProfileSelectionForAgent(catalog, { intent: 'review', agentId: 'public-reviewer',
      profileId: 'acme.review/second', profileSourceCustody: { ...managedProfileCustody, immutableGenerationId: 'stale' } }))
      .toThrow(/source custody/);
  });

  it('admits only engine options declared by the selected plugin profile before loading prompt assets', async () => {
    let promptReads = 0;
    const catalog = buildExecutionRunProfileCatalog([{
      pluginId: 'acme.review', sourceCustody: managedProfileCustody,
      definition: {
        id: 'review', intent: 'delegate', title: 'Review', promptAsset: 'review-prompt', compatibleAgents: ['reviewer'],
        defaults: { retention: 'ephemeral', runClass: 'bounded', io: 'streaming' },
        optionsSchema: { type: 'object', additionalProperties: false, properties: { effort: { type: 'string', enum: ['deep', 'fast'] } } },
      },
    }], { resolvePromptAssetBlocks: async () => { promptReads += 1; return []; } });
    const profile = resolveExecutionRunIntentProfileFromCatalog(catalog, 'delegate', 'acme.review/review', managedProfileCustody);
    const prepare = (options: unknown) => profile.prepareStartParams!({ cwd: process.cwd(), request: {
      intent: 'delegate', backendTarget: { kind: 'builtInAgent', agentId: 'reviewer' },
      instructions: 'Review.', permissionMode: 'read_only', retentionPolicy: 'ephemeral', runClass: 'bounded', ioMode: 'streaming',
      profileSourceCustody: managedProfileCustody, intentInput: { engines: { reviewer: options } },
    } });
    await expect(prepare({ effort: 'deep' })).resolves.toMatchObject({ retentionPolicy: 'ephemeral' });
    const knownGoodReads = promptReads;
    for (const invalid of [{ effort: 'unknown' }, { promptOnly: true }]) {
      await expect(prepare(invalid)).rejects.toMatchObject({ code: 'execution_run_profile_options_invalid' });
    }
    expect(promptReads).toBe(knownGoodReads);
  });

  it('validates the qualified review selection options before reading its prompt asset', async () => {
    const promptRead = new Error('prompt asset boundary reached');
    const catalog = buildExecutionRunProfileCatalog([{
      pluginId: 'acme.review', sourceCustody: managedProfileCustody,
      definition: {
        id: 'review', intent: 'review', title: 'Review', promptAsset: 'review-prompt', compatibleAgents: ['reviewer'],
        defaults: { retention: 'ephemeral', runClass: 'bounded', io: 'streaming' },
        optionsSchema: { type: 'object', additionalProperties: false, properties: { effort: { type: 'string', enum: ['deep'] } } },
      },
    }], { resolvePromptAssetBlocks: async () => { throw promptRead; } });
    const profile = resolveExecutionRunIntentProfileFromCatalog(catalog, 'review', 'acme.review/review', managedProfileCustody);
    const prepare = (options: unknown) => profile.prepareStartParams!({ cwd: process.cwd(), request: {
      intent: 'review', backendTarget: { kind: 'builtInAgent', agentId: 'reviewer' },
      instructions: 'Review.', permissionMode: 'read_only', retentionPolicy: 'ephemeral', runClass: 'bounded', ioMode: 'streaming',
      profileSourceCustody: managedProfileCustody, intentInput: {
        reviewers: [{ kind: 'engine', engineId: 'agent:acme.review/reviewer', options }],
        engines: { reviewer: { effort: 'deep' } },
      },
    } });
    await expect(prepare({ effort: 'deep' })).rejects.toBe(promptRead);
    await expect(prepare({ effort: 'unsupported' })).rejects.toMatchObject({ code: 'execution_run_profile_options_invalid' });
  });

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
        sourceCustody: { kind: 'bundled_first_party', packagedRuntime: { kind: 'cli_version_root', versionRootId: 'cli-coderabbit' } },
        definition,
      },
      {
        pluginId: 'happier.review.deepsec',
        sourceCustody: { kind: 'development', registeredRootId: '/plugins/deepsec' },
        definition: { ...definition, title: 'DeepSec review' },
      },
    ]);

    expect(listExecutionRunProfileContributionDescriptors(catalog).map((entry) => entry.id)).toEqual([
      'happier.review.coderabbit/review',
      'happier.review.deepsec/review',
    ]);
    expect(resolveExecutionRunIntentProfileFromCatalog(
      catalog, 'review', 'happier.review.coderabbit/review',
      { kind: 'bundled_first_party', packagedRuntime: { kind: 'cli_version_root', versionRootId: 'cli-coderabbit' } },
    ).listAvailableActionIds?.({ start: {} as never })).toContain('happier.review.coderabbit/publish');
  });

  it('uses the contributed intent as the qualified runtime-profile owner and fails stale or mismatched selections closed', () => {
    const catalog = buildExecutionRunProfileCatalog([{
      pluginId: 'acme.review',
      sourceCustody: managedProfileCustody,
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
      sourceCustody: { ...managedProfileCustody, immutableGenerationId: 'immutable-generation-current' },
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
      { ...managedProfileCustody, immutableGenerationId: 'immutable-generation-current' },
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
        profileSourceCustody: { ...managedProfileCustody, immutableGenerationId: 'immutable-generation-current' },
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
        runClass: 'bounded', ioMode: 'streaming',
        profileSourceCustody: { ...managedProfileCustody, immutableGenerationId: 'immutable-generation-stale' },
      },
    })).rejects.toMatchObject({ code: 'execution_run_profile_stale' });

    await expect(profile.prepareStartParams?.({
      cwd: process.cwd(),
      request: {
        intent: 'delegate',
        backendTarget: { kind: 'builtInAgent', agentId: 'coderabbit' },
        instructions: 'Inspect.', permissionMode: 'read_only', retentionPolicy: 'ephemeral',
        runClass: 'bounded', ioMode: 'streaming',
        profileSourceCustody: { ...managedProfileCustody, immutableGenerationId: 'immutable-generation-current' },
      },
    })).rejects.toThrow(/compatible/i);
  });

  it.each([
    ['happier.review.coderabbit', { kind: 'bundled_first_party', packagedRuntime: { kind: 'cli_version_root', versionRootId: 'cli-0.3.0' } }],
    ['happier.review.deepsec', { kind: 'development', registeredRootId: '/plugins/deepsec' }],
  ] as const)('starts %s only with matching source custody', async (pluginId, sourceCustody) => {
    const catalog = buildExecutionRunProfileCatalog([{
      pluginId,
      sourceCustody,
      definition: {
        id: 'profile', intent: 'delegate', title: 'Delegated review', promptAsset: 'review-prompt',
        compatibleAgents: ['reviewer'],
        defaults: { retention: 'ephemeral', runClass: 'bounded', io: 'streaming' },
      },
    }]);
    const profileId = `${pluginId}/profile`;
    const profile = resolveExecutionRunIntentProfileFromCatalog(
      catalog, 'delegate', profileId, sourceCustody,
    );
    await expect(profile.prepareStartParams?.({
      cwd: process.cwd(),
      request: {
        intent: 'delegate', backendTarget: { kind: 'builtInAgent', agentId: 'reviewer' },
        instructions: 'Review.', permissionMode: 'read_only', retentionPolicy: 'ephemeral',
        runClass: 'bounded', ioMode: 'streaming', profileSourceCustody: sourceCustody,
      },
    })).resolves.toMatchObject({ retentionPolicy: 'ephemeral' });
    expect(() => resolveExecutionRunIntentProfileFromCatalog(
      catalog,
      'delegate',
      profileId,
      { kind: 'managed', immutableGenerationId: 'other', installSource: 'archive' },
    )).toThrow(/current source custody/);
  });

  it('matches compatible Agent references by typed plugin identity rather than provider-like local ids', async () => {
    const catalog = buildExecutionRunProfileCatalog([{
      pluginId: 'acme.review',
      sourceCustody: managedProfileCustody,
      definition: {
        id: 'review', intent: 'review', title: 'Review', promptAsset: 'review-prompt',
        compatibleAgents: [{ pluginId: 'acme.review', localId: 'reviewer' }],
        defaults: { retention: 'ephemeral', runClass: 'bounded', io: 'streaming' },
      },
    }], {
      resolveAgentIdentity: () => ({ pluginId: 'acme.provider-shaped', localId: 'reviewer' }),
      resolvePromptAssetBlocks: async () => [{ id: 'prompt', scope: 'session', text: 'prompt' }],
    });
    const profile = resolveExecutionRunIntentProfileFromCatalog(
      catalog, 'review', 'acme.review/review', managedProfileCustody,
    );

    await expect(profile.prepareStartParams?.({
      cwd: process.cwd(),
      request: {
        intent: 'review', backendTarget: { kind: 'builtInAgent', agentId: 'reviewer' },
        instructions: 'Review.', permissionMode: 'read_only', retentionPolicy: 'ephemeral',
        runClass: 'bounded', ioMode: 'streaming', profileSourceCustody: managedProfileCustody,
      },
    })).rejects.toMatchObject({ code: 'execution_run_profile_agent_incompatible' });
  });

  it('fails a gated contributed profile closed through the shared availability owner', async () => {
    const catalog = buildExecutionRunProfileCatalog([{
      pluginId: 'acme.review',
      sourceCustody: managedProfileCustody,
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
    const profile = resolveExecutionRunIntentProfileFromCatalog(
      catalog, 'review', 'acme.review/review', managedProfileCustody,
    );

    await expect(profile.prepareStartParams?.({
      cwd: process.cwd(),
      request: {
        intent: 'review', backendTarget: { kind: 'builtInAgent', agentId: 'reviewer' },
        instructions: 'Review.', permissionMode: 'read_only', retentionPolicy: 'ephemeral',
        runClass: 'bounded', ioMode: 'streaming', profileSourceCustody: managedProfileCustody,
      },
    })).rejects.toMatchObject({ code: 'execution_run_profile_unavailable' });
  });
});
