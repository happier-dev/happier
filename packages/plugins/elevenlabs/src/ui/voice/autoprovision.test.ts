import type { VoiceClientToolDefinition } from '@happier-dev/plugin-sdk/voice/client';
import { describe, expect, it, vi } from 'vitest';

import { createElevenLabsAutoprovision } from './autoprovision.js';

describe('ElevenLabs bundled autoprovision', () => {
  it('provisions the host-normalized Voice client tools without rebuilding ActionSpec schemas', async () => {
    const provision = vi.fn(async () => ({ ok: true, agentId: 'agent_1' }));
    const tools: readonly VoiceClientToolDefinition[] = Object.freeze([Object.freeze({
      name: 'hostListMachines',
      description: 'Host-normalized machine inventory',
      parameters: Object.freeze({
        type: 'object',
        additionalProperties: false,
        properties: Object.freeze({
          limit: Object.freeze({ type: 'integer', minimum: 1, maximum: 10 }),
        }),
        required: Object.freeze(['limit']),
      }),
      execute: async () => Object.freeze({ ok: true }),
    })]);
    const autoprovision = createElevenLabsAutoprovision({
      client: { provision },
      defaultVoiceId: 'voice_default',
      tools,
    });
    const signal = new AbortController().signal;

    await expect(autoprovision.createAgent(
      {
        tts: {
          voiceId: 'voice_1',
          voiceSettings: {
            stability: 0.35,
            similarityBoost: 0.75,
            speed: 1.1,
          },
        },
      },
      signal,
    )).resolves.toEqual({ agentId: 'agent_1' });
    expect(provision).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'create',
      prompt: expect.stringContaining('{{initialConversationContext}}'),
      tools: [
        {
          name: 'hostListMachines',
          description: 'Host-normalized machine inventory',
          parameters: {
            type: 'object',
            additionalProperties: false,
            properties: { limit: { type: 'integer', minimum: 1, maximum: 10 } },
            required: ['limit'],
          },
        },
      ],
      tts: expect.objectContaining({ voiceId: 'voice_1' }),
    }), signal);
    expect(provision).toHaveBeenCalledWith(expect.objectContaining({
      tts: expect.objectContaining({
        voiceSettings: expect.objectContaining({
          stability: 0.35,
          similarityBoost: 0.75,
          speed: 1.1,
        }),
      }),
    }), signal);
    const provisionedPrompt = provision.mock.calls[0]?.[0]?.prompt;
    // ElevenLabs substitutes these dynamic variables at conversation start; the
    // plugin owns that dialect, so losing either one silently ships a prompt with
    // no session target and no conversation context.
    expect(provisionedPrompt).toContain('Active coding session (internal tool target): {{sessionId}}');
    expect(provisionedPrompt).toContain('Conversation context (may be empty):\n{{initialConversationContext}}');

    const serialized = JSON.stringify(provision.mock.calls);
    expect(serialized).toContain('hostListMachines');
    expect(serialized).not.toContain('sendSessionMessage');
    expect(serialized).not.toContain('apiKey');
    expect(serialized).not.toMatch(/(?:style|useSpeakerBoost|use_speaker_boost|voice_settings)/u);
  });
});
