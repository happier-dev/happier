import { describe, expect, it, vi } from 'vitest';

describe('DaemonSttController', () => {
    it('delegates recorded audio transcription to the daemon inference client', async () => {
        const transcribeRecordedAudio = vi.fn().mockResolvedValue({
            text: 'hello daemon',
            language: 'en',
            modelPackId: 'stt-pack-1',
        });

        const { DaemonSttController } = await import('./DaemonSttController');
        const controller = new DaemonSttController({
            client: { transcribeRecordedAudio } as any,
        });

        await expect(controller.transcribeRecordedAudio({
            sessionId: 'session-1',
            source: { kind: 'native', uri: 'file:///tmp/recording.wav', sizeBytes: 12 },
            inputMimeType: 'audio/wav',
            packId: 'stt-pack-1',
            language: 'en',
        })).resolves.toEqual({
            text: 'hello daemon',
            language: 'en',
            modelPackId: 'stt-pack-1',
        });

        expect(transcribeRecordedAudio).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 'session-1',
            packId: 'stt-pack-1',
            language: 'en',
        }));
    });
});
