import { randomUUID } from '@/platform/randomUUID';
import { resolveKokoroSherpaSidForVoiceIdWithSpeakerCount } from '@/voice/kokoro/voices/kokoroSherpaVoiceMapping';
import { ensureModelPackInstalled } from '@/voice/modelPacks/installer.native';
import { resolveModelPackManifestUrl } from '@/voice/modelPacks/manifests';

type KokoroNativeModuleLike = {
  initialize(params: { assetsDir: string }): Promise<void>;
  listVoices(params: { assetsDir: string }): Promise<Array<{ id: string; title: string; sid?: number }>>;
  synthesizeToWavFile(params: {
    jobId: string;
    assetsDir: string;
    text: string;
    voiceId: string | null;
    sid: number | null;
    speed: number;
    outWavPath: string | null;
  }): Promise<{ wavPath: string; sampleRate: number }>;
  cancel(params: { jobId: string }): Promise<void>;
};

const DEFAULT_KOKORO_ASSET_SET_ID = 'kokoro-82m-v1.0-onnx-q8-wasm';

function normalizeAssetSetId(assetSetId: string | null | undefined): string {
  if (typeof assetSetId === 'string' && assetSetId.trim().length > 0) return assetSetId.trim();
  return DEFAULT_KOKORO_ASSET_SET_ID;
}

type NativeOverrides = {
  kokoroNativeModule?: KokoroNativeModuleLike | null;
  ensureInstalled?: typeof ensureModelPackInstalled;
  resolveManifestUrl?: (packId: string | null) => string | null;
  fs?: {
    File: any;
    Paths: { cache: any; document: any };
    deleteAsync: (uri: string, opts?: { idempotent?: boolean }) => Promise<void>;
  };
  resolveOutWavPath?: (jobId: string) => string;
};

function createAbortPromise(signal: AbortSignal): Promise<never> {
  if (signal.aborted) return Promise.reject(new Error('aborted'));
  return new Promise((_, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort);
      reject(new Error('aborted'));
    };
    signal.addEventListener('abort', onAbort);
  });
}

function createTimeoutPromise(timeoutMs: number): Promise<never> {
  return new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
    (timer as any)?.unref?.();
  });
}

function uriToFilePath(uri: string): string {
  if (uri.startsWith('file://')) return uri.slice('file://'.length);
  return uri;
}

function filePathToUri(pathOrUri: string): string {
  if (pathOrUri.startsWith('file://')) return pathOrUri;
  if (pathOrUri.startsWith('/')) return `file://${pathOrUri}`;
  return pathOrUri;
}

const speakerCountByAssetsDirPath = new Map<string, Promise<number | null>>();

async function getSpeakerCountForAssetsDir(opts: {
  native: KokoroNativeModuleLike;
  assetsDirPath: string;
  timeoutMs: number;
  signal: AbortSignal;
}): Promise<number | null> {
  const key = opts.assetsDirPath;
  const cached = speakerCountByAssetsDirPath.get(key);
  if (cached) return cached;

  const promise = (async () => {
    try {
      const voices = await Promise.race([
        opts.native.listVoices({ assetsDir: key }),
        createAbortPromise(opts.signal),
        createTimeoutPromise(opts.timeoutMs),
      ]);
      return Array.isArray(voices) ? voices.length : null;
    } catch {
      return null;
    }
  })();

  speakerCountByAssetsDirPath.set(key, promise);
  return promise;
}

function getOptionalNativeModuleFromWorkspace(): KokoroNativeModuleLike | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('@happier-dev/sherpa-native') as any;
    const getter = mod?.getOptionalHappierSherpaNativeModule;
    if (typeof getter !== 'function') return null;
    return (getter() as KokoroNativeModuleLike | null) ?? null;
  } catch {
    return null;
  }
}

async function getFs(overrides: NativeOverrides): Promise<NonNullable<NativeOverrides['fs']>> {
  if (overrides.fs) return overrides.fs;
  const fs = await import('expo-file-system');
  return fs as any;
}

function resolveOutWavPathUri(jobId: string, fs: NonNullable<NativeOverrides['fs']>, overrides: NativeOverrides): string {
  if (overrides.resolveOutWavPath) return overrides.resolveOutWavPath(jobId);
  return new fs.File(fs.Paths.cache, `happier-kokoro-${jobId}.wav`).uri;
}

export async function synthesizeKokoroWav(
  opts: {
    text: string;
    assetSetId?: string | null;
    voiceId: string;
    speed: number;
    timeoutMs: number;
    signal: AbortSignal;
  },
  overrides: NativeOverrides = {},
): Promise<ArrayBuffer> {
  const native = overrides.kokoroNativeModule ?? getOptionalNativeModuleFromWorkspace();
  if (!native) {
    throw new Error('kokoro_native_module_unavailable');
  }

  const jobId = randomUUID();

  const onAbort = () => {
    void native.cancel({ jobId }).catch(() => {});
  };
  opts.signal.addEventListener('abort', onAbort);

  const fs = await getFs(overrides);
  const outWavUri = resolveOutWavPathUri(jobId, fs, overrides);

  let wavUriToDelete: string | null = null;
  try {
    const assetSetId = normalizeAssetSetId(opts.assetSetId);
    const manifestUrl = overrides.resolveManifestUrl
      ? overrides.resolveManifestUrl(assetSetId)
      : resolveModelPackManifestUrl({ packId: assetSetId });
    const ensureInstalled = overrides.ensureInstalled ?? ensureModelPackInstalled;
    const installed = await ensureInstalled(
      {
        packId: assetSetId,
        mode: 'require_installed',
        manifestUrl,
        timeoutMs: opts.timeoutMs,
        signal: opts.signal,
      },
      { fs: fs as any },
    );
    const installedAssetsDirUri = installed.packDirUri;

    await Promise.race([
      native.initialize({ assetsDir: uriToFilePath(installedAssetsDirUri) }),
      createAbortPromise(opts.signal),
      createTimeoutPromise(opts.timeoutMs),
    ]);

    const manifestVoiceSid =
      (installed.manifest as any)?.voices?.find?.((v: any) => v?.id === opts.voiceId && typeof v?.sid === 'number')?.sid
      ?? null;
    const speakerCount =
      manifestVoiceSid != null
        ? null
        : await getSpeakerCountForAssetsDir({
            native,
            assetsDirPath: uriToFilePath(installedAssetsDirUri),
            timeoutMs: opts.timeoutMs,
            signal: opts.signal,
          });
    const sid = manifestVoiceSid ?? resolveKokoroSherpaSidForVoiceIdWithSpeakerCount(opts.voiceId, speakerCount) ?? null;

    const res = await Promise.race([
      native.synthesizeToWavFile({
        jobId,
        assetsDir: uriToFilePath(installedAssetsDirUri),
        text: opts.text,
        voiceId: opts.voiceId,
        sid,
        speed: opts.speed,
        outWavPath: uriToFilePath(outWavUri),
      }),
      createAbortPromise(opts.signal),
      createTimeoutPromise(opts.timeoutMs),
    ]);

    const wavUri = filePathToUri(res.wavPath);
    wavUriToDelete = wavUri;
    const wavFile = new fs.File(wavUri);
    const bytes = await Promise.race([wavFile.arrayBuffer(), createAbortPromise(opts.signal), createTimeoutPromise(opts.timeoutMs)]);

    await fs.deleteAsync(wavUriToDelete, { idempotent: true });
    wavUriToDelete = null;
    return bytes;
  } finally {
    opts.signal.removeEventListener('abort', onAbort);
    if (wavUriToDelete) {
      try {
        await fs.deleteAsync(wavUriToDelete, { idempotent: true });
      } catch {
        // ignore
      }
    }
  }
}

export async function prepareKokoroTts(
  opts: {
    assetSetId?: string | null;
    timeoutMs: number;
    signal: AbortSignal;
    onProgress?: (progress: unknown) => void;
  },
  overrides: NativeOverrides = {},
): Promise<void> {
  const native = overrides.kokoroNativeModule ?? getOptionalNativeModuleFromWorkspace();
  if (!native) {
    throw new Error('kokoro_native_module_unavailable');
  }

  const fs = await getFs(overrides);
  const assetSetId = normalizeAssetSetId(opts.assetSetId ?? null);
  const manifestUrl = overrides.resolveManifestUrl
    ? overrides.resolveManifestUrl(assetSetId)
    : resolveModelPackManifestUrl({ packId: assetSetId });
  const ensureInstalled = overrides.ensureInstalled ?? ensureModelPackInstalled;
  const installed = await ensureInstalled(
    {
      packId: assetSetId,
      mode: 'download_if_missing',
      manifestUrl,
      timeoutMs: opts.timeoutMs,
      signal: opts.signal,
      onProgress: (p) => {
        opts.onProgress?.({ loaded: p.loaded, total: p.total });
      },
    },
    { fs: fs as any },
  );
  await Promise.race([
    native.initialize({ assetsDir: uriToFilePath(installed.packDirUri) }),
    createAbortPromise(opts.signal),
    createTimeoutPromise(opts.timeoutMs),
  ]);
}
