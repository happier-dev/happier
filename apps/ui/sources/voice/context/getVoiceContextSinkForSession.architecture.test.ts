import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

describe('voice context sink provider boundary', () => {
  it('resolves active provider context capabilities without vendor imports or ids', async () => {
    const source = await readFile('sources/voice/context/getVoiceContextSinkForSession.ts', 'utf8');

    expect(source).not.toContain('realtimeElevenLabs');
    expect(source).not.toContain('realtime_elevenlabs');
    expect(source).not.toContain('local_conversation');
    expect(source).not.toContain('sendContextText');
    expect(source).not.toContain('readLocalConversationSettingsFromAccountSettings');
    expect(source).not.toContain('/adapters/realtimeElevenLabs/');
  });
});
