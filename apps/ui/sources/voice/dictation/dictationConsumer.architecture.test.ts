import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('Dictation consumer ownership', () => {
    it('routes the composer microphone through Dictation while retaining conversational VoiceSurface', async () => {
        const [agentInput, sessionView, dictationHook] = await Promise.all([
            readFile('sources/components/sessions/agentInput/AgentInput.tsx', 'utf8'),
            readFile('sources/components/sessions/shell/SessionView.tsx', 'utf8'),
            readFile('sources/voice/dictation/useVoiceDictation.ts', 'utf8'),
        ]);

        expect(agentInput).toContain("from '@/voice/dictation/useVoiceDictation'");
        expect(agentInput).toContain('applyDictationToComposer');
        expect(sessionView).toContain('<VoiceSurface variant="session"');
        expect(sessionView).not.toContain('voiceSessionManager.toggle');
        expect(dictationHook).not.toContain('dictationCaptureOwner.releaseAdmission');
    });
});
