import { randomUUID } from '@/platform/randomUUID';
import { resolveKokoroNativeModelPackId } from '@/voice/kokoro/assets/kokoroAssetSets';
import { resolveKokoroSherpaSidForVoiceIdWithSpeakerCount } from '@/voice/kokoro/voices/kokoroSherpaVoiceMapping';
import { resolveKokoroNativeVoice } from '@/voice/kokoro/voices/resolveKokoroVoice';
import { resolveStreamingTtsChunkChars, splitSpeechSentences } from '@/voice/output/TtsChunker';
import { ensureModelPackInstalled } from '@/voice/modelPacks/installer.native';
import { resolveModelPackManifestUrl } from '@/voice/modelPacks/manifests';
import { fileUriToNativePath } from '@/voice/modelPacks/nativePath';

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

type NativeOverrides = {
  kokoroNativeModule?: KokoroNativeModuleLike | null;
  ensureInstalled?: typeof ensureModelPackInstalled;
  resolveManifestUrl?: (packId: string | null) => string | null;
  fs?: {
    File: any;
    Paths: { cache: any; document: any };
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

async function deleteFileBestEffort(fs: NonNullable<NativeOverrides['fs']>, uri: string): Promise<void> {
  try {
    await new fs.File(uri).delete();
  } catch {
    // ignore cleanup failures
  }
}

type KokoroSynthesisOpts = {
  assetSetId?: string | null;
  /** Requested voice; null or an id missing from the installed pack uses the pack default voice. */
  voiceId: string | null;
  speed: number;
  timeoutMs: number;
  signal: AbortSignal;
};

type PreparedNativeSynthesis = Readonly<{
  native: KokoroNativeModuleLike;
  fs: NonNullable<NativeOverrides['fs']>;
  assetsDirPath: string;
  voiceId: string | null;
  sid: number | null;
}>;

/** Ensures the pack is installed and initialized, and resolves the voice against its catalog. */
async function prepareNativeSynthesis(opts: KokoroSynthesisOpts, overrides: NativeOverrides): Promise<PreparedNativeSynthesis> {
  const native = overrides.kokoroNativeModule ?? getOptionalNativeModuleFromWorkspace();
  if (!native) {
    throw new Error('kokoro_native_module_unavailable');
  }

  const fs = await getFs(overrides);
  const assetSetId = resolveKokoroNativeModelPackId(opts.assetSetId);
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
  const assetsDirPath = fileUriToNativePath(installed.packDirUri);

  await Promise.race([
    native.initialize({ assetsDir: assetsDirPath }),
    createAbortPromise(opts.signal),
    createTimeoutPromise(opts.timeoutMs),
  ]);

  const catalogVoice = resolveKokoroNativeVoice(installed.manifest, opts.voiceId);
  if (catalogVoice) {
    return { native, fs, assetsDirPath, voiceId: catalogVoice.voiceId, sid: catalogVoice.sid };
  }

  // Legacy packs without a voice catalog: use the built-in sherpa speaker mapping.
  const voiceId = typeof opts.voiceId === 'string' && opts.voiceId.trim() ? opts.voiceId.trim() : null;
  if (!voiceId) {
    return { native, fs, assetsDirPath, voiceId: null, sid: null };
  }
  const speakerCount = await getSpeakerCountForAssetsDir({
    native,
    assetsDirPath,
    timeoutMs: opts.timeoutMs,
    signal: opts.signal,
  });
  const sid = resolveKokoroSherpaSidForVoiceIdWithSpeakerCount(voiceId, speakerCount) ?? null;
  return { native, fs, assetsDirPath, voiceId, sid };
}

async function synthesizePreparedWav(
  prepared: PreparedNativeSynthesis,
  text: string,
  opts: Pick<KokoroSynthesisOpts, 'speed' | 'timeoutMs' | 'signal'>,
  overrides: NativeOverrides,
): Promise<ArrayBuffer> {
  const { native, fs } = prepared;
  const jobId = randomUUID();
  const cancelJob = () => {
    void native.cancel({ jobId }).catch(() => {});
  };
  opts.signal.addEventListener('abort', cancelJob);
  const outWavUri = resolveOutWavPathUri(jobId, fs, overrides);

  // A timed-out job is cancelled too, so it does not keep the native synthesis queue busy.
  let jobTimer: ReturnType<typeof setTimeout> | null = null;
  const jobTimeout = new Promise<never>((_, reject) => {
    jobTimer = setTimeout(() => {
      cancelJob();
      reject(new Error('timeout'));
    }, opts.timeoutMs);
  });

  let wavUriToDelete: string | null = null;
  try {
    const res = await Promise.race([
      native.synthesizeToWavFile({
        jobId,
        assetsDir: prepared.assetsDirPath,
        text,
        voiceId: prepared.voiceId,
        sid: prepared.sid,
        speed: opts.speed,
        outWavPath: fileUriToNativePath(outWavUri),
      }),
      createAbortPromise(opts.signal),
      jobTimeout,
    ]);

    const wavUri = filePathToUri(res.wavPath);
    wavUriToDelete = wavUri;
    const wavFile = new fs.File(wavUri);
    const bytes = await Promise.race([wavFile.arrayBuffer(), createAbortPromise(opts.signal), createTimeoutPromise(opts.timeoutMs)]);

    await deleteFileBestEffort(fs, wavUriToDelete);
    wavUriToDelete = null;
    return bytes;
  } finally {
    if (jobTimer) clearTimeout(jobTimer);
    opts.signal.removeEventListener('abort', cancelJob);
    if (wavUriToDelete) {
      await deleteFileBestEffort(fs, wavUriToDelete);
    }
  }
}

export async function synthesizeKokoroWav(
  opts: KokoroSynthesisOpts & { text: string },
  overrides: NativeOverrides = {},
): Promise<ArrayBuffer> {
  const prepared = await prepareNativeSynthesis(opts, overrides);
  return await synthesizePreparedWav(prepared, opts.text, opts, overrides);
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
  const assetSetId = resolveKokoroNativeModelPackId(opts.assetSetId ?? null);
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
      onProgress: opts.onProgress,
    },
    { fs: fs as any },
  );
  await Promise.race([
    native.initialize({ assetsDir: fileUriToNativePath(installed.packDirUri) }),
    createAbortPromise(opts.signal),
    createTimeoutPromise(opts.timeoutMs),
  ]);
}

/**
 * Splits text into sentences and synthesizes them one at a time, so the first sentence plays while
 * the rest is still pending. Each native call keeps the existing per-operation timeout; an abort
 * cancels the in-flight sentence and skips the remaining ones.
 */
export function streamKokoroWavSentences(
  opts: KokoroSynthesisOpts & { text: string },
  overrides: NativeOverrides = {},
): AsyncIterable<{ wavBytes: ArrayBuffer; sentenceText: string }> {
  return {
    async *[Symbol.asyncIterator]() {
      const sentences = splitSpeechSentences(opts.text, resolveStreamingTtsChunkChars(undefined));
      if (sentences.length === 0) return;
      const prepared = await prepareNativeSynthesis(opts, overrides);
      for (const sentenceText of sentences) {
        if (opts.signal.aborted) throw new Error('aborted');
        const wavBytes = await synthesizePreparedWav(prepared, sentenceText, opts, overrides);
        yield { wavBytes, sentenceText };
      }
    },
  };
}
