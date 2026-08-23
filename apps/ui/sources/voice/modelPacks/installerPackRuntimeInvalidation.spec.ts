import { beforeEach, describe, expect, it, vi } from 'vitest';

const releaseAssetsDir = vi.fn(async (_params: { assetsDir: string }) => ({ cancelledJobs: 0, releasedEngines: 0 }));
let nativeModule: Record<string, unknown> | null = { releaseAssetsDir };

// Boundary mock: the sherpa Expo module is a native module, and the eviction it
// performs (destroying recognizer/stream handles) has no JS-observable effect.
vi.mock('@happier-dev/sherpa-native', () => ({
  getOptionalHappierSherpaNativeModule: () => nativeModule,
}));

import { checkModelPackUpdateAvailable, removeModelPack } from '@/voice/modelPacks/installer.native';
import { createMemFs } from '@/voice/modelPacks/installerTestFs';
import { cacheSpeakerCountForAssetsDir, readCachedSpeakerCountForAssetsDir } from '@/voice/kokoro/runtime/kokoroSpeakerCountCache';

describe('default pack runtime invalidation', () => {
  beforeEach(() => {
    releaseAssetsDir.mockClear();
    nativeModule = { releaseAssetsDir };
  });

  it('retires both native engine kinds for the pack directory before its bytes are removed', async () => {
    const { fs, files, root } = createMemFs();
    const packId = 'stt-en';
    const liveRoot = `${root}/${packId}`;
    files.set(`${liveRoot}/encoder.onnx`, new Uint8Array([1, 2, 3]));

    // Recorded at the moment the native module is asked to release the pack, so a
    // post-mutation implementation would show the bytes already gone.
    const observed: Array<{ assetsDir: string; liveBytesPresent: boolean }> = [];
    releaseAssetsDir.mockImplementation(async (params) => {
      observed.push({ assetsDir: params.assetsDir, liveBytesPresent: files.has(`${liveRoot}/encoder.onnx`) });
      return { cancelledJobs: 1, releasedEngines: 1 };
    });

    await removeModelPack({ packId }, { fs } as any);

    // The native cache is keyed by the filesystem path, not the uri the
    // installer works in.
    expect(observed).toEqual([{ assetsDir: '/docs/happier/voice/modelPacks/stt-en', liveBytesPresent: true }]);
    expect(files.has(`${liveRoot}/encoder.onnx`)).toBe(false);
  });

  it('retires the engines before an update check rolls back an interrupted promotion', async () => {
    // The update check reconciles a crashed swap before comparing manifests, and
    // that rollback rewrites the live directory exactly like a promote or a
    // remove does. Skipping the invalidation there leaves the native engines
    // serving the bytes the rollback just deleted.
    const { fs, files, root } = createMemFs();
    const packId = 'stt-crashed-upgrade';
    const liveRoot = `${root}/${packId}`;
    const backupRoot = `${root}/.${packId}.backup`;
    files.set(`${liveRoot}/encoder.onnx`, new TextEncoder().encode('candidate'));
    files.set(`${backupRoot}/encoder.onnx`, new TextEncoder().encode('prior'));
    files.set(`${root}/.${packId}.promote-intent`, new TextEncoder().encode(JSON.stringify({
      schemaVersion: 1,
      packId,
      phase: 'swap_prepared',
      startedAtMs: 1,
      token: 'crashed-upgrade',
      priorInstall: { scopeKey: 'device', identityKey: packId },
      recovery: null,
    })));

    const observed: Array<{ assetsDir: string; liveBytes: string | null }> = [];
    releaseAssetsDir.mockImplementation(async (params) => {
      const live = files.get(`${liveRoot}/encoder.onnx`);
      observed.push({ assetsDir: params.assetsDir, liveBytes: live ? new TextDecoder().decode(live) : null });
      return { cancelledJobs: 1, releasedEngines: 1 };
    });

    await checkModelPackUpdateAvailable(
      { packId, manifestUrl: null, timeoutMs: 1000, signal: new AbortController().signal },
      { fs } as any,
    );

    expect(observed).toEqual([
      { assetsDir: '/docs/happier/voice/modelPacks/stt-crashed-upgrade', liveBytes: 'candidate' },
    ]);
    // The rollback still ran: the prior install is live again.
    expect(new TextDecoder().decode(files.get(`${liveRoot}/encoder.onnx`)!)).toBe('prior');
  });

  it('drops the derived speaker count for the same directory', async () => {
    const { fs } = createMemFs();
    const packId = 'kokoro-en';
    const assetsDirPath = `/docs/happier/voice/modelPacks/${packId}`;
    cacheSpeakerCountForAssetsDir(assetsDirPath, 42);

    await removeModelPack({ packId }, { fs } as any);

    expect(readCachedSpeakerCountForAssetsDir(assetsDirPath)).toBeUndefined();
  });

  it('keeps the pack when the loaded native binary cannot retire its engines', async () => {
    const { fs, files, root } = createMemFs();
    const packId = 'stt-old-binary';
    files.set(`${root}/${packId}/encoder.onnx`, new Uint8Array([7]));
    // A native binary older than this JS bundle: the module resolves, but nothing
    // can retire the engines it is still serving the pack from.
    nativeModule = {};

    await expect(removeModelPack({ packId }, { fs } as any)).rejects.toThrow(
      'model_pack_runtime_invalidation_unsupported',
    );
    expect(files.has(`${root}/${packId}/encoder.onnx`)).toBe(true);
  });

  it('keeps the pack when retiring the native engines fails', async () => {
    const { fs, files, root } = createMemFs();
    const packId = 'stt-legacy-binary';
    files.set(`${root}/${packId}/encoder.onnx`, new Uint8Array([9]));
    releaseAssetsDir.mockRejectedValueOnce(new Error('unavailable'));

    await expect(removeModelPack({ packId }, { fs } as any)).rejects.toThrow('unavailable');
    expect(files.has(`${root}/${packId}/encoder.onnx`)).toBe(true);
  });

  it('removes the pack where there is no native runtime holding it', async () => {
    const { fs, files, root } = createMemFs();
    const packId = 'stt-no-native';
    files.set(`${root}/${packId}/encoder.onnx`, new Uint8Array([5]));
    // No sherpa module at all (web, or a build without it): nothing is cached
    // against the directory, so there is nothing to retire and no reason to stop.
    nativeModule = null;

    await expect(removeModelPack({ packId }, { fs } as any)).resolves.toBeUndefined();
    expect(files.has(`${root}/${packId}/encoder.onnx`)).toBe(false);
  });
});
