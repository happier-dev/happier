import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

describe('RealtimeTransport provider ownership', () => {
    it('routes ElevenLabs-specific realtime semantics through a provider-owned bridge', async () => {
        const source = await readFile('sources/voice/runtime/realtime/RealtimeTransport.ts', 'utf8');

        // The core transport must stay provider-agnostic. Provider-specific wiring belongs in adapter-owned modules.
        expect(source).not.toContain('@/voice/adapters/realtimeElevenLabs/realtimeElevenLabsTransportProvider');
        expect(source).toContain('@/voice/adapters/resolveDefaultRealtimeTransportProvider');
        expect(source).not.toContain('@/sync/api/voice/apiVoice');
        expect(source).not.toContain('@/auth/storage/tokenStorage');
        expect(source).not.toContain('@/realtime/elevenLabsByo');
        expect(source).not.toContain('@/constants/Languages');
        expect(source).not.toContain('@/voice/qa/voiceQaStore');
        expect(source).not.toContain('buildElevenLabsWelcomeContext');
        expect(source).not.toContain('appendOptionalWelcomeToContext');
        expect(source).not.toContain('projectRealtimeVoiceTranscriptEvent');
        expect(source).not.toContain('appendVoiceConversationNoteText');
        expect(source).not.toContain('currentBilledMode');
        expect(source).not.toContain('currentLeaseId');
    });
});
