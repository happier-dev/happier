import { access, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

type SourceExpectation = Readonly<{
    filePath: string;
    requiredImports: ReadonlyArray<string>;
    forbiddenImports: ReadonlyArray<string>;
}>;

const sourceExpectations: ReadonlyArray<SourceExpectation> = [
    {
        filePath: 'sources/voice/output/playAudioBytesWithStopper.ts',
        requiredImports: ['@/voice/runtime/playback/VoicePlaybackController'],
        forbiddenImports: ['@/voice/runtime/VoicePlaybackController'],
    },
    {
        filePath: 'sources/voice/output/speakAssistantText.ts',
        requiredImports: ['@/voice/runtime/playback/VoicePlaybackController'],
        forbiddenImports: ['@/voice/runtime/VoicePlaybackController'],
    },
    {
        filePath: 'sources/voice/output/KokoroTtsController.ts',
        requiredImports: ['@/voice/runtime/playback/VoicePlaybackController'],
        forbiddenImports: ['@/voice/runtime/VoicePlaybackController'],
    },
    {
        filePath: 'sources/voice/output/TtsController.ts',
        requiredImports: ['@/voice/runtime/playback/VoicePlaybackController'],
        forbiddenImports: ['@/voice/runtime/VoicePlaybackController'],
    },
    {
        filePath: 'sources/voice/runtime/bundledSpeech/bundledSpeechRuntime.ts',
        requiredImports: ['@/voice/runtime/playback/VoicePlaybackController'],
        forbiddenImports: ['@/voice/runtime/VoicePlaybackController'],
    },
    {
        filePath: 'sources/voice/backends/tts/runtime.ts',
        requiredImports: ['@/voice/runtime/playback/VoicePlaybackController'],
        forbiddenImports: ['@/voice/runtime/VoicePlaybackController'],
    },
    {
        filePath: 'sources/voice/backends/tts/localVoiceTtsProviderControllers.ts',
        requiredImports: ['@/voice/runtime/playback/VoicePlaybackController'],
        forbiddenImports: ['@/voice/runtime/VoicePlaybackController'],
    },
    {
        filePath: 'sources/voice/local/localVoiceEngine.ts',
        requiredImports: ['@/voice/runtime/playback/VoicePlaybackController'],
        forbiddenImports: ['@/voice/runtime/VoicePlaybackController'],
    },
    {
        filePath: 'sources/voice/runtime/daemonInference/DaemonTtsController.ts',
        requiredImports: ['@/voice/runtime/playback/VoicePlaybackController'],
        forbiddenImports: ['@/voice/runtime/VoicePlaybackController'],
    },
    {
        filePath: 'sources/voice/settings/panels/localTts/LocalNeuralTtsSettings.native.tsx',
        requiredImports: ['@/voice/runtime/playback/VoicePlaybackController'],
        forbiddenImports: ['@/voice/runtime/VoicePlaybackController'],
    },
];

const retiredCompatibilityWrappers = [
    'sources/voice/runtime/VoicePlaybackController.ts',
] as const;

const uiRootPath = fileURLToPath(new URL('../../../../', import.meta.url));

describe('voice playback canonical owner imports', () => {
    it('routes owned playback and TTS surfaces through the runtime/playback owner path', async () => {
        for (const expectation of sourceExpectations) {
            const source = await readFile(join(uiRootPath, expectation.filePath), 'utf8');

            for (const requiredImport of expectation.requiredImports) {
                expect(source).toContain(requiredImport);
            }

            for (const forbiddenImport of expectation.forbiddenImports) {
                expect(source).not.toContain(forbiddenImport);
            }
        }
    });

    it('deletes the playback compatibility wrapper once all remaining consumers use the canonical owner path', async () => {
        for (const retiredPath of retiredCompatibilityWrappers) {
            await expect(access(join(uiRootPath, retiredPath))).rejects.toBeDefined();
        }
    });
});
