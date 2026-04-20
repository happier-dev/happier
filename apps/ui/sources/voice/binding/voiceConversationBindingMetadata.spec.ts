import { describe, expect, it } from 'vitest';

import { readVoiceConversationBindingMetadata } from './voiceConversationBindingMetadata';

describe('readVoiceConversationBindingMetadata', () => {
  it('parses numeric updatedAt values stored as strings', () => {
    const binding = readVoiceConversationBindingMetadata('  carrier-s1  ', {
      voiceConversationBindingV1: {
        v: 1,
        adapterId: ' local_conversation ',
        controlSessionId: ' voice-global ',
        runId: ' run_1 ',
        streamId: ' stream_1 ',
        transcriptMode: 'native_session',
        targetSessionId: ' s1 ',
        updatedAt: '123',
      },
    });

        expect(binding).toEqual({
            adapterId: 'local_conversation',
            controlSessionId: 'voice-global',
            conversationSessionId: 'carrier-s1',
            runId: 'run_1',
            streamId: 'stream_1',
            transcriptMode: 'native_session',
            targetSessionId: 's1',
            updatedAt: 123,
        });
  });

  it('canonicalizes binding ids when writing metadata', async () => {
    const { writeVoiceConversationBindingMetadata } = await import('./voiceConversationBindingMetadata');

    expect(
      writeVoiceConversationBindingMetadata(
        { systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true } },
        {
          adapterId: ' local_conversation ',
          controlSessionId: ' voice-global ',
          conversationSessionId: ' carrier-s1 ',
          runId: ' run_2 ',
          streamId: ' stream_2 ',
          transcriptMode: 'synthetic',
          targetSessionId: ' s1 ',
          updatedAt: 123,
        } as any,
      ),
    ).toEqual({
      systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true },
        voiceConversationBindingV1: {
          v: 1,
          adapterId: 'local_conversation',
          controlSessionId: 'voice-global',
          runId: 'run_2',
          streamId: 'stream_2',
          transcriptMode: 'synthetic',
          targetSessionId: 's1',
          updatedAt: 123,
        },
    });
  });

  it('rejects writes when required binding ids normalize to empty strings', async () => {
    const { writeVoiceConversationBindingMetadata } = await import('./voiceConversationBindingMetadata');

    expect(() =>
      writeVoiceConversationBindingMetadata(
        { systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true } },
        {
          adapterId: '   ',
          controlSessionId: ' voice-global ',
          conversationSessionId: ' carrier-s1 ',
          runId: ' run_2 ',
          streamId: ' stream_2 ',
          transcriptMode: 'synthetic',
          targetSessionId: ' s1 ',
          updatedAt: 123,
        } as any,
      ),
    ).toThrow(TypeError);
  });
});
