import { describe, expect, it } from 'vitest';

import { listVoiceActionBlockSpecs, listVoiceToolActionSpecs } from '@happier-dev/protocol';

import { buildElevenLabsVoiceAgentPrompt, buildLocalVoiceAgentSystemPrompt } from './voiceAgentPrompt.js';

describe('voiceAgentPrompt', () => {
  it('includes all voice tool action specs in the ElevenLabs prompt', () => {
    const prompt = buildElevenLabsVoiceAgentPrompt({
      initialConversationContextPlaceholder: '{{initialConversationContext}}',
      sessionIdPlaceholder: '{{sessionId}}',
    });

    const specs = listVoiceToolActionSpecs().filter((spec) => typeof spec.bindings?.voiceClientToolName === 'string');
    for (const spec of specs) {
      expect(prompt).toContain(spec.bindings.voiceClientToolName as string);
      const argsExample = spec.examples?.voice?.argsExample ?? null;
      if (typeof argsExample === 'string' && argsExample.trim().length > 0) {
        expect(prompt).toContain(argsExample);
      }
    }
  });

  it('omits disabled voice tool action specs in the ElevenLabs prompt', () => {
    const prompt = buildElevenLabsVoiceAgentPrompt({
      initialConversationContextPlaceholder: '{{initialConversationContext}}',
      sessionIdPlaceholder: '{{sessionId}}',
      disabledActionIds: ['review.start'],
    } as any);

    const review = listVoiceToolActionSpecs().find((s) => s.id === 'review.start');
    const toolName = review?.bindings?.voiceClientToolName;
    if (typeof toolName === 'string' && toolName.trim().length > 0) {
      expect(prompt).not.toContain(toolName);
    }
  });

  it('includes all voice action-block specs in the local voice system prompt', () => {
    const prompt = buildLocalVoiceAgentSystemPrompt({
      actionsTag: 'voice_actions',
      sessionId: 's1',
    });

    expect(prompt).toContain('VOICE_TOOL_RESULTS_JSON:');

    const specs = listVoiceActionBlockSpecs().filter((spec) => typeof spec.bindings?.voiceClientToolName === 'string');
    for (const spec of specs) {
      expect(prompt).toContain(spec.bindings.voiceClientToolName as string);
    }
  });

  it('omits disabled voice action-block specs in the local voice system prompt', () => {
    const prompt = buildLocalVoiceAgentSystemPrompt({
      actionsTag: 'voice_actions',
      sessionId: 's1',
      disabledActionIds: ['review.start'],
    } as any);

    const review = listVoiceActionBlockSpecs().find((s) => s.id === 'review.start');
    const toolName = review?.bindings?.voiceClientToolName;
    if (typeof toolName === 'string' && toolName.trim().length > 0) {
      expect(prompt).not.toContain(toolName);
    }
  });
});
