import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { renderPromptPlanV1 } from '@happier-dev/protocol';

import { resolveCodingProviderBehaviorBlocks } from './providerPromptBehaviorRegistry';

describe('resolveCodingProviderBehaviorBlocks', () => {
  it('does not keep provider-specific behavior in a CLI-local provider map', () => {
    const source = readFileSync(fileURLToPath(new URL('./providerPromptBehaviorRegistry.ts', import.meta.url)), 'utf8');

    expect(source).not.toContain('CODING_PROVIDER_BEHAVIOR_BLOCKS_BY_PROVIDER');
    expect(source).not.toContain('provider.claude.ask_user_question_isolation');
    expect(source).not.toContain('provider.codex.exec_sequencing');
  });

  it('returns Claude-specific sequencing guidance without duplicating generic attachment instructions', () => {
    const blocks = resolveCodingProviderBehaviorBlocks({
      agentId: 'claude',
    });

    const text = renderPromptPlanV1({ modality: 'coding', blocks });
    expect(text).toContain('AskUserQuestion');
    expect(text).not.toContain('[attachments]');
  });

  it('returns Codex exec sequencing guidance', () => {
    const blocks = resolveCodingProviderBehaviorBlocks({
      agentId: 'codex',
    });

    const text = renderPromptPlanV1({ modality: 'coding', blocks });
    expect(text).toContain('Tool execution ordering');
    expect(text).toContain('exec_command');
  });

  it('can append the remote Claude TODO suppression block', () => {
    const blocks = resolveCodingProviderBehaviorBlocks({
      agentId: 'claude',
      disableTodos: true,
    });

    const text = renderPromptPlanV1({ modality: 'coding', blocks });
    expect(text).toContain('Do not create TODO');
  });
});
