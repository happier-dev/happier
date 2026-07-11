import { listVoiceToolActionSpecs } from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';

import { createElevenLabsAutoprovision } from './autoprovision.js';

describe('ElevenLabs bundled autoprovision', () => {
  it('builds bounded non-secret provider input and provider-owned client tool shapes', async () => {
    const provision = vi.fn(async () => ({ ok: true, agentId: 'agent_1' }));
    const autoprovision = createElevenLabsAutoprovision({
      client: { provision },
      defaultVoiceId: 'voice_default',
      async buildContext() {
        return {
          disabledActionIds: [],
          extraSystemAppendBlocks: [],
          actionSpecs: listVoiceToolActionSpecs().slice(0, 2),
        };
      },
    });

    await expect(autoprovision.createAgent({ tts: { voiceId: 'voice_1' } })).resolves.toEqual({ agentId: 'agent_1' });
    expect(provision).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'create',
      prompt: expect.any(String),
      tools: expect.any(Array),
      tts: expect.objectContaining({ voiceId: 'voice_1' }),
    }));
    expect(JSON.stringify(provision.mock.calls)).not.toContain('apiKey');
  });
});
