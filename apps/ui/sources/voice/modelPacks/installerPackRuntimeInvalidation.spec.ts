import { beforeEach, describe, expect, it, vi } from 'vitest';

const releaseStreamingAssetsDir = vi.fn(async (_params: { assetsDir: string }) => ({ cancelledJobs: 0 }));
let nativeModule: Record<string, unknown> | null = { releaseStreamingAssetsDir };

// Boundary mock: the sherpa Expo module is a native module, and the eviction it
// performs (destroying recognizer/stream handles) has no JS-observable effect.
vi.mock('@happier-dev/sherpa-native', () => ({
  getOptionalHappierSherpaNativeModule: () => nativeModule,
}));

import { removeModelPack } from '@/voice/modelPacks/installer.native';
import { createMemFs } from '@/voice/modelPacks/installerTestFs';
import { cacheSpeakerCountForAssetsDir, readCachedSpeakerCountForAssetsDir } from '@/voice/kokoro/runtime/kokoroSpeakerCountCache';

describe('default pack runtime invalidation', () => {
  beforeEach(() => {
    releaseStreamingAssetsDir.mockClear();
    nativeModule = { releaseStreamingAssetsDir };
  });

  it('evicts the native streaming recognizer for the pack directory before its bytes are removed', async () => {
    const { fs, files, root } = createMemFs();
    const packId = 'stt-en';
    const liveRoot = `${root}/${packId}`;
    files.set(`${liveRoot}/encoder.onnx`, new Uint8Array([1, 2, 3]));

    // Recorded at the moment the native module is asked to release the pack, so a
    // post-mutation implementation would show the bytes already gone.
    const observed: Array<{ assetsDir: string; liveBytesPresent: boolean }> = [];
    releaseStreamingAssetsDir.mockImplementation(async (params) => {
      observed.push({ assetsDir: params.assetsDir, liveBytesPresent: files.has(`${liveRoot}/encoder.onnx`) });
      return { cancelledJobs: 1 };
    });

    await removeModelPack({ packId }, { fs } as any);

    // The native cache is keyed by the filesystem path, not the uri the
    // installer works in.
    expect(observed).toEqual([{ assetsDir: '/docs/happier/voice/modelPacks/stt-en', liveBytesPresent: true }]);
    expect(files.has(`${liveRoot}/encoder.onnx`)).toBe(false);
  });

  it('drops the derived speaker count for the same directory', async () => {
    const { fs } = createMemFs();
    const packId = 'kokoro-en';
    const assetsDirPath = `/docs/happier/voice/modelPacks/${packId}`;
    cacheSpeakerCountForAssetsDir(assetsDirPath, 42);

    await removeModelPack({ packId }, { fs } as any);

    expect(readCachedSpeakerCountForAssetsDir(assetsDirPath)).toBeUndefined();
  });

  it('still removes the pack against a native binary that predates streaming eviction', async () => {
    const { fs, files, root } = createMemFs();
    const packId = 'stt-old-binary';
    files.set(`${root}/${packId}/encoder.onnx`, new Uint8Array([7]));
    nativeModule = {};

    await expect(removeModelPack({ packId }, { fs } as any)).resolves.toBeUndefined();
    expect(files.has(`${root}/${packId}/encoder.onnx`)).toBe(false);
  });

  it('still removes the pack when the native eviction fails', async () => {
    const { fs, files, root } = createMemFs();
    const packId = 'stt-legacy-binary';
    files.set(`${root}/${packId}/encoder.onnx`, new Uint8Array([9]));
    releaseStreamingAssetsDir.mockRejectedValueOnce(new Error('unavailable'));

    await expect(removeModelPack({ packId }, { fs } as any)).resolves.toBeUndefined();
    expect(files.has(`${root}/${packId}/encoder.onnx`)).toBe(false);
  });
});
