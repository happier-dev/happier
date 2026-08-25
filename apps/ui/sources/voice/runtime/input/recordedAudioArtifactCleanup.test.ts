import { afterEach, describe, expect, it, vi } from 'vitest';
import { Platform } from 'react-native';

import {
    createRecordedAudioArtifactCleanup,
    deleteRecordedAudioArtifact,
} from './recordedAudioArtifactCleanup';

const nativeFileBoundary = vi.hoisted(() => {
    const file = {
        exists: true,
        delete: vi.fn(async () => {}),
    };
    return {
        file,
        File: vi.fn(function File(_uri: string) {
            return file;
        }),
    };
});

vi.mock('expo-file-system', () => ({
    File: nativeFileBoundary.File,
}));

const ORIGINAL_PLATFORM_OS = Platform.OS;

afterEach(() => {
    (Platform as unknown as { OS: string }).OS = ORIGINAL_PLATFORM_OS;
    nativeFileBoundary.file.exists = true;
    nativeFileBoundary.file.delete.mockReset();
    nativeFileBoundary.File.mockClear();
    vi.unstubAllGlobals();
});

describe('recorded audio artifact cleanup', () => {
    it('revokes an admitted browser recording exactly once when terminal paths converge', async () => {
        (Platform as unknown as { OS: string }).OS = 'web';
        const revokeObjectURL = vi.fn();
        vi.stubGlobal('URL', { revokeObjectURL });
        const cleanup = createRecordedAudioArtifactCleanup(deleteRecordedAudioArtifact);
        cleanup.admit('blob:voice-recording');

        const [first, second] = await Promise.all([
            cleanup.cleanup(),
            cleanup.cleanup(),
        ]);

        expect(first).toEqual({ kind: 'cleaned' });
        expect(second).toEqual({ kind: 'cleaned' });
        expect(revokeObjectURL).toHaveBeenCalledOnce();
        expect(revokeObjectURL).toHaveBeenCalledWith('blob:voice-recording');
    });

    it('retains a failed cleanup outcome instead of retrying or claiming success', async () => {
        const deletionFailure = new Error('recording_delete_failed');
        const deleteArtifact = vi.fn(async () => {
            throw deletionFailure;
        });
        const cleanup = createRecordedAudioArtifactCleanup(deleteArtifact);
        cleanup.admit('file:///recording.m4a');

        const first = await cleanup.cleanup();
        const second = await cleanup.cleanup();

        expect(first).toEqual({ kind: 'failed', error: deletionFailure });
        expect(second).toBe(first);
        expect(deleteArtifact).toHaveBeenCalledOnce();
        expect(deleteArtifact).toHaveBeenCalledWith('file:///recording.m4a');
    });

    it('deletes a finalized native recording through the same artifact owner', async () => {
        (Platform as unknown as { OS: string }).OS = 'ios';

        await deleteRecordedAudioArtifact('file:///voice-recording.m4a');

        expect(nativeFileBoundary.File).toHaveBeenCalledOnce();
        expect(nativeFileBoundary.File).toHaveBeenCalledWith('file:///voice-recording.m4a');
        expect(nativeFileBoundary.file.delete).toHaveBeenCalledOnce();
    });
});
