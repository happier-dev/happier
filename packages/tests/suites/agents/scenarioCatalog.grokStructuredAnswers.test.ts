import { describe, expect, it } from 'vitest';

import { scenarioCatalog } from '../../src/testkit/providers/scenarios/scenarioCatalog';

describe('providers: Grok structured question answers', () => {
  const provider = {
    id: 'grok',
    protocol: 'acp',
  } as any;

  it('preserves exact ordered answer arrays through the generic permission responder', () => {
    const scenario = scenarioCatalog.grok_structured_question_answers(provider);

    expect(scenario.permissionAutoAnswers).toEqual({
      components: ['alpha-beta', 'gamma', 'Custom, other'],
    });
    expect(scenario.permissionAutoDecision).toBe('approved');
    expect(scenario.allowPermissionAutoApproveInYolo).toBe(true);
    expect(scenario.requiredMessageSubstrings).toContain('GROK_STRUCTURED_ANSWERS_OK');

    const prompt = scenario.prompt?.({ workspaceDir: '/tmp/happier-grok-answers' }) ?? '';
    expect(prompt).toContain('components');
    expect(prompt).toContain('alpha-beta');
    expect(prompt).toContain('Alpha, Beta');
    expect(prompt).toContain('Custom, other');
  });
});
