import { access, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const canonicalPlaybackOwnerPath = 'sources/voice/runtime/playback/VoicePlaybackController.ts';
const canonicalPlaybackOwnerImport = '@/voice/runtime/playback/VoicePlaybackController';
const retiredPlaybackOwnerImport = '@/voice/runtime/VoicePlaybackController';

// Keep this inventory to direct consumers of the interruption/stopper owner.
// TtsController owns ordering for one speak generation; it neither creates nor
// consumes the interruption controller, so requiring it to import this module
// would assert a false cross-owner dependency rather than canonicalization.
const directPlaybackConsumerPaths = [
    'sources/voice/backends/tts/localVoiceTtsProviderControllers.ts',
    'sources/voice/backends/tts/runtime.ts',
    'sources/voice/local/localVoiceEngine.ts',
    'sources/voice/local/sendVoiceTextTurn.ts',
    'sources/voice/output/KokoroTtsController.ts',
    'sources/voice/output/playAudioBytesWithStopper.ts',
    'sources/voice/output/speakAssistantText.ts',
    'sources/voice/qa/voiceQaOutputFixturePlayback.ts',
    'sources/voice/runtime/bundledSpeech/bundledSpeechRuntime.ts',
    'sources/voice/runtime/connection/VoiceRealtimeConnection.ts',
    'sources/voice/runtime/connection/WebSocketPcmMedia.ts',
    'sources/voice/runtime/controller/VoiceConversationController.ts',
    'sources/voice/runtime/daemonInference/DaemonTtsController.ts',
    'sources/voice/runtime/machine/voiceBargeInController.ts',
    'sources/voice/runtime/realtime/createRealtimeBargeInCoordinator.ts',
    'sources/voice/settings/panels/localTts/LocalNeuralTtsSettings.native.tsx',
] as const;

const retiredCompatibilityWrappers = [
    'sources/voice/runtime/VoicePlaybackController.ts',
] as const;

const uiRootPath = fileURLToPath(new URL('../../../../', import.meta.url));

describe('voice playback canonical owner imports', () => {
    it('routes every direct interruption/stopper consumer through the runtime/playback owner path', async () => {
        expect(directPlaybackConsumerPaths).not.toContain(canonicalPlaybackOwnerPath);

        for (const consumerPath of directPlaybackConsumerPaths) {
            const source = await readFile(join(uiRootPath, consumerPath), 'utf8');

            expect(source).toContain(canonicalPlaybackOwnerImport);
            expect(source).not.toContain(retiredPlaybackOwnerImport);
        }
    });

    it('keeps the canonical owner self-contained rather than requiring a self-import', async () => {
        const source = await readFile(join(uiRootPath, canonicalPlaybackOwnerPath), 'utf8');

        expect(source).not.toContain(canonicalPlaybackOwnerImport);
        expect(source).not.toContain(retiredPlaybackOwnerImport);
    });

    it('deletes the playback compatibility wrapper once all remaining consumers use the canonical owner path', async () => {
        for (const retiredPath of retiredCompatibilityWrappers) {
            await expect(access(join(uiRootPath, retiredPath))).rejects.toBeDefined();
        }
    });
});
