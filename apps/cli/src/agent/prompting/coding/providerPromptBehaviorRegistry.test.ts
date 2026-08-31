import { describe, expect, it } from 'vitest';

import { renderPromptPlanV1 } from '@happier-dev/protocol';

import { resolveCodingProviderBehaviorBlocks } from './providerPromptBehaviorRegistry';

describe('resolveCodingProviderBehaviorBlocks', () => {
  it('returns Claude-specific sequencing guidance without duplicating generic attachment instructions', () => {
    const blocks = resolveCodingProviderBehaviorBlocks({
      providerId: 'claude',
    });

    const text = renderPromptPlanV1({ modality: 'coding', blocks });
    expect(text).toContain('AskUserQuestion');
    expect(text).not.toContain('[attachments]');
  });

  it('does not impose repository tool-execution policy on Codex sessions', () => {
    const blocks = resolveCodingProviderBehaviorBlocks({
      providerId: 'codex',
    });

    expect(blocks).toEqual([]);
  });

  it('can append the remote Claude TODO suppression block', () => {
    const blocks = resolveCodingProviderBehaviorBlocks({
      providerId: 'claude',
      disableTodos: true,
    });

    const text = renderPromptPlanV1({ modality: 'coding', blocks });
    expect(text).toContain('Do not create TODO');
  });
});
