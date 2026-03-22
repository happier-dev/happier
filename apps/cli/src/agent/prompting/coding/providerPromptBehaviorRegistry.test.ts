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

  it('returns Codex exec sequencing guidance', () => {
    const blocks = resolveCodingProviderBehaviorBlocks({
      providerId: 'codex',
    });

    const text = renderPromptPlanV1({ modality: 'coding', blocks });
    expect(text).toContain('Tool execution ordering');
    expect(text).toContain('exec_command');
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
