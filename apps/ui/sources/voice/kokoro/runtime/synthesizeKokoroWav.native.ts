import { randomUUID } from '@/platform/randomUUID';
import { createSentenceStream } from '@/voice/kokoro/runtime/streamKokoroWavSentences';
import { resolveKokoroSherpaSidForVoiceIdWithSpeakerCount } from '@/voice/kokoro/voices/kokoroSherpaVoiceMapping';
import { ensureModelPackInstalled } from '@/voice/modelPacks/installer.native';
import { resolveModelPackManifestUrl } from '@/voice/modelPacks/manifests';
import { KOKORO_DEFAULT_TTS_PACK_ID, resolveCanonicalModelPackId } from '@happier-dev/protocol';

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

const DEFAULT_KOKORO_ASSET_SET_ID = KOKORO_DEFAULT_TTS_PACK_ID;

function normalizeAssetSetId(assetSetId: string | null | undefined): string {
  return resolveCanonicalModelPackId(
    typeof assetSetId === 'string' && assetSetId.trim().length > 0 ? assetSetId : DEFAULT_KOKORO_ASSET_SET_ID,
  );
}

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

function uriToFilePath(uri: string): string {
  if (uri.startsWith('file://')) return uri.slice('file://'.length);
  return uri;
}

function filePathToUri(pathOrUri: string): string {
  if (pathOrUri.startsWith('file://')) return pathOrUri;
  if (pathOrUri.startsWith('/')) return `file://${pathOrUri}`;
  return pathOrUri;
}

const speakerCountByAssetsDirPath = new Map<string, number>();

async function getSpeakerCountForAssetsDir(opts: {
  native: KokoroNativeModuleLike;
  assetsDirPath: string;
  timeoutMs: number;
  signal: AbortSignal;
}): Promise<number | null> {
  const key = opts.assetsDirPath;
  const cached = speakerCountByAssetsDirPath.get(key);
  if (cached !== undefined) return cached;

  try {
    const voices = await Promise.race([
      opts.native.listVoices({ assetsDir: key }),
      createAbortPromise(opts.signal),
      createTimeoutPromise(opts.timeoutMs),
    ]);
    const count = Array.isArray(voices) ? voices.length : null;
    // Cache ONLY a successful, meaningful count. A transient failure (abort,
    // timeout, native error) or a non-array result must never be cached: a
    // poisoned `null` would otherwise pin the wrong speaker count for this
    // assets dir for the process lifetime and degrade every later synth.
    if (count !== null) {
      speakerCountByAssetsDirPath.set(key, count);
    }
    return count;
  } catch {
    return null;
  }
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

type KokoroSynthContext = Readonly<{
  /** Synthesize a single piece of text to WAV bytes (heavy setup already done). */
  synthesizeText: (text: string) => Promise<ArrayBuffer>;
}>;

/**
 * Resolve the model pack, initialize the native runtime, and resolve the speaker
 * id ONCE, returning a closure that synthesizes individual pieces of text. This
 * lets both the single-blob path and the streaming sentence path share the
 * expensive install/initialize/sid-resolution work, so per-sentence streaming
 * does not pay that cost again for every sentence.
 */
async function prepareKokoroSynthContext(
  opts: {
    assetSetId?: string | null;
    voiceId: string;
    speed: number;
    timeoutMs: number;
    signal: AbortSignal;
  },
  overrides: NativeOverrides,
): Promise<KokoroSynthContext> {
  const native = overrides.kokoroNativeModule ?? getOptionalNativeModuleFromWorkspace();
  if (!native) {
    throw new Error('kokoro_native_module_unavailable');
  }

  const fs = await getFs(overrides);
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
  const assetsDirPath = uriToFilePath(installedAssetsDirUri);

  await Promise.race([
    native.initialize({ assetsDir: assetsDirPath }),
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
          assetsDirPath,
          timeoutMs: opts.timeoutMs,
          signal: opts.signal,
        });
  const sid = manifestVoiceSid ?? resolveKokoroSherpaSidForVoiceIdWithSpeakerCount(opts.voiceId, speakerCount) ?? null;

  const synthesizeText = async (text: string): Promise<ArrayBuffer> => {
    const jobId = randomUUID();
    const onAbort = () => {
      void native.cancel({ jobId }).catch(() => {});
    };
    if (opts.signal.aborted) {
      // Already interrupted before this job started: cancel and bail.
      onAbort();
      throw new Error('aborted');
    }
    opts.signal.addEventListener('abort', onAbort);
    const outWavUri = resolveOutWavPathUri(jobId, fs, overrides);
    let wavUriToDelete: string | null = outWavUri;
    try {
      const res = await Promise.race([
        native.synthesizeToWavFile({
          jobId,
          assetsDir: assetsDirPath,
          text,
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
      const bytes = await Promise.race([
        wavFile.arrayBuffer(),
        createAbortPromise(opts.signal),
        createTimeoutPromise(opts.timeoutMs),
      ]);

      await deleteFileBestEffort(fs, wavUri);
      wavUriToDelete = null;
      return bytes;
    } finally {
      opts.signal.removeEventListener('abort', onAbort);
      // Always clean up the staged out-WAV, including on abort/timeout where the
      // job may have written a partial file before we bailed.
      if (wavUriToDelete) {
        await deleteFileBestEffort(fs, wavUriToDelete);
      }
    }
  };

  return { synthesizeText };
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
  const context = await prepareKokoroSynthContext(opts, overrides);
  return context.synthesizeText(opts.text);
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
        opts.onProgress?.({ loaded: p.loaded, total: p.total, file: (p as any)?.file });
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

/**
 * Stream sentence-level WAV chunks for `text`.
 *
 * Resolves the model pack and initializes the runtime once, segments the text
 * into sentences, then synthesizes and yields each sentence incrementally with a
 * one-sentence prefetch (synth of sentence `n+1` overlaps playback of sentence
 * `n`). This cuts time-to-first-audio for long replies vs. the previous
 * whole-text single-yield behavior.
 */
export function streamKokoroWavSentences(
  opts: {
    text: string;
    assetSetId?: string | null;
    voiceId: string;
    speed: number;
    timeoutMs: number;
    signal: AbortSignal;
  },
  overrides: NativeOverrides = {},
): AsyncIterable<{ wavBytes: ArrayBuffer; sentenceText: string }> {
  return {
    async *[Symbol.asyncIterator]() {
      const context = await prepareKokoroSynthContext(opts, overrides);
      yield* createSentenceStream({
        text: opts.text,
        synthesizeSentence: (sentence) => context.synthesizeText(sentence),
        signal: opts.signal,
      });
    },
  };
}

/**
 * Prewarm the Kokoro runtime: ensure the model pack is installed and the native
 * runtime is initialized so the first real synth does not pay cold-start cost.
 * Best-effort; callers may attach this to a voice-home / settings warm hook.
 */
export async function prewarmKokoroRuntime(
  opts: {
    assetSetId?: string | null;
    voiceId: string;
    speed: number;
    timeoutMs: number;
    signal: AbortSignal;
  },
  overrides: NativeOverrides = {},
): Promise<void> {
  await prepareKokoroSynthContext(opts, overrides);
}
