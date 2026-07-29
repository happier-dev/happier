import type { BundledVoiceUiEntry } from '@happier-dev/bundled-voice-runtime-contract';
import { BUNDLED_VOICE_UI_ENTRIES as ELEVENLABS_VOICE_UI_ENTRIES } from '@happier-dev/plugins-elevenlabs/ui/voice';
import { BUNDLED_VOICE_UI_ENTRIES as GOOGLE_VOICE_UI_ENTRIES } from '@happier-dev/plugins-google/ui/voice';
import { BUNDLED_VOICE_UI_ENTRIES as OPENAI_VOICE_UI_ENTRIES } from '@happier-dev/plugins-openai/ui/voice';
import { describe, expect, it } from 'vitest';

const producerDeclarations: readonly BundledVoiceUiEntry[] = [
  ...ELEVENLABS_VOICE_UI_ENTRIES,
  ...GOOGLE_VOICE_UI_ENTRIES,
  ...OPENAI_VOICE_UI_ENTRIES,
];

describe('bundled voice producer declarations', () => {
  it('preserves the private aggregate contract across built package declarations', () => {
    expect(producerDeclarations.map((entry) => entry.kind)).toEqual([
      'voice.conversation-provider.v1',
      'voice.speech-engine.v1',
      'voice.speech-engine.v1',
      'voice.conversation-provider.v1',
    ]);
    const openAi = producerDeclarations.find((entry) => entry.kind === 'voice.conversation-provider.v1'
      && entry.providerId === 'realtime_openai');
    expect(openAi?.internal).not.toHaveProperty('createAdapter');
  });
});
