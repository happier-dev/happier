import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

type SourceExpectation = Readonly<{
    filePath: string;
    requiredSnippets: ReadonlyArray<string>;
    forbiddenSnippets: ReadonlyArray<string>;
}>;

const sourceExpectations: ReadonlyArray<SourceExpectation> = [
    {
        filePath: 'sources/voice/session/VoiceSessionRuntime.tsx',
        requiredSnippets: [
            './voiceSessionLifecycleController',
            './voiceSessionLifecycleControllerStore',
        ],
        forbiddenSnippets: [
            'getVoiceAdapterRegistry',
            'resolveContinuousVoiceProviderId',
        ],
    },
    {
        filePath: 'sources/voice/session/voiceSession.ts',
        requiredSnippets: [
            './voiceSessionLifecycleControllerStore',
        ],
        forbiddenSnippets: [
            './voiceAdapterRegistry',
        ],
    },
    {
        filePath: 'sources/voice/session/voiceSessionStore.ts',
        requiredSnippets: [
            './voiceSessionLifecycleControllerStore',
        ],
        forbiddenSnippets: [
            'voiceConversationRuntimeStore',
            'deriveLocalVoiceSessionSnapshot',
        ],
    },
    {
        filePath: 'sources/voice/session/voiceSessionManager.ts',
        requiredSnippets: [
            './voiceSessionLifecycleController',
        ],
        forbiddenSnippets: [
            'resolveContinuousVoiceProviderId',
        ],
    },
    {
        filePath: 'sources/voice/session/voiceSessionLifecycleController.ts',
        requiredSnippets: [
            './voiceSessionStore',
        ],
        forbiddenSnippets: [
            'setVoiceSessionSnapshot',
        ],
    },
];

describe('voice session lifecycle owner seam', () => {
    it('routes voice session lifecycle ownership through the canonical lifecycle controller seam', async () => {
        for (const expectation of sourceExpectations) {
            const source = await readFile(expectation.filePath, 'utf8');

            for (const requiredSnippet of expectation.requiredSnippets) {
                expect(source).toContain(requiredSnippet);
            }

            for (const forbiddenSnippet of expectation.forbiddenSnippets) {
                expect(source).not.toContain(forbiddenSnippet);
            }
        }
    });
});
