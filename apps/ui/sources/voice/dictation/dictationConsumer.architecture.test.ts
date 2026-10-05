import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('Dictation consumer ownership', () => {
    it('routes composer microphones through shared Dictation and mounts conversational presence only in the app shell', async () => {
        const [agentInput, authoringComposer, scopedComposer, workflowStep, sessionView, runtimeMounts, dictationHook] = await Promise.all([
            readFile('sources/components/sessions/agentInput/AgentInput.tsx', 'utf8'),
            readFile('sources/components/sessions/authoring/SessionAuthoringComposer.tsx', 'utf8'),
            readFile('sources/components/sessions/authoring/ScopedAuthoringComposer.tsx', 'utf8'),
            readFile('sources/components/workflows/editor/WorkflowStepEditor.tsx', 'utf8'),
            readFile('sources/components/sessions/shell/SessionView.tsx', 'utf8'),
            readFile('sources/components/appShell/runtime/AuthenticatedAppRuntimeMounts.tsx', 'utf8'),
            readFile('sources/voice/dictation/useVoiceDictation.ts', 'utf8'),
        ]);

        expect(agentInput).toContain('useSessionAuthoringComposerDictation');
        expect(agentInput).not.toContain("from '@/voice/dictation/useVoiceDictation'");
        expect(authoringComposer).toContain("from '@/voice/dictation/useVoiceDictation'");
        expect(authoringComposer).toContain('applyDictationToComposer');
        // A workflow step composes through the shared scoped authoring composer,
        // which reaches Dictation through the same authoring hook above. It must
        // not acquire a second microphone owner of its own.
        expect(workflowStep).toContain('<ScopedAuthoringComposer');
        expect(workflowStep).not.toContain("from '@/voice/dictation/useVoiceDictation'");
        expect(scopedComposer).toContain("from '@/components/sessions/agentInput'");
        expect(scopedComposer).not.toContain("from '@/voice/dictation/useVoiceDictation'");
        expect(workflowStep).not.toContain('<AgentInput');
        expect(workflowStep).not.toContain('onSend=');
        expect(workflowStep).not.toContain('sessionId=');
        expect(runtimeMounts).toContain('<VoicePresenceAppShellMount');
        expect(sessionView).not.toContain('<VoiceSurface');
        expect(sessionView).not.toContain('voiceSessionManager.toggle');
        expect(dictationHook).not.toContain('dictationCaptureOwner.releaseAdmission');
    });
});
