import { access, readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

describe('realtime voice runtime ownership', () => {
  it('keeps provider semantics out of generic connection/controller/protocol owners', async () => {
    for (const path of [
      'sources/voice/runtime/connection/VoiceRealtimeConnection.ts',
      'sources/voice/runtime/controller/VoiceConversationController.ts',
      'sources/voice/runtime/protocol/VoiceRealtimeProtocolAdapter.ts',
    ]) {
      const source = await readFile(path, 'utf8');
      expect(source).not.toContain('realtime_elevenlabs');
      expect(source).not.toContain('ElevenLabs');
      expect(source).not.toContain('@/sync/api/voice/apiVoice');
      expect(source).not.toContain('@/auth/storage/tokenStorage');
    }
  });

  it('removes the private ElevenLabs adapter and singleton runtime corridor', async () => {
    for (const path of [
      'sources/voice/runtime/realtime/RealtimeTransport.ts',
      'sources/voice/runtime/realtime/realtimeTransportProvider.ts',
      'sources/voice/adapters/resolveDefaultRealtimeTransportProvider.ts',
      'sources/voice/adapters/realtimeElevenLabs/realtimeElevenLabsTransportProvider.ts',
    ]) {
      await expect(access(path)).rejects.toMatchObject({ code: 'ENOENT' });
    }

    const productionComposition = await readFile(
      'sources/voice/adapters/registerBuiltinVoiceAdapters.ts',
      'utf8',
    );
    expect(productionComposition).not.toContain('createRealtimeElevenLabsVoiceAdapter');
    expect(productionComposition).not.toContain("entry.providerId !== 'realtime_elevenlabs'");
    expect(productionComposition).toContain(
      'input.bundledEntries ?? BUNDLED_FIRST_PARTY_VOICE_CONVERSATION_RUNTIME_ENTRIES',
    );
  });
});
