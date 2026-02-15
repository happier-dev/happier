import { encodeWavPcm16 } from '@/voice/kokoro/audio/encodeWavPcm16';
import { resolveKokoroRuntimeConfig } from '@/voice/kokoro/assets/kokoroAssetSets';
import { ensureKokoroCacheApiAvailable } from '@/voice/kokoro/assets/kokoroCacheApi';

type KokoroTtsInstance = {
  generate(text: string, opts: { voice: string; speed: number }): Promise<{ audio: Float32Array; sampling_rate: number }>;
};

let cachedKey: string | null = null;
let cachedTts: Promise<KokoroTtsInstance> | null = null;

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
    // Best-effort: don't keep the event loop alive if possible.
    (timer as any)?.unref?.();
  });
}

async function getKokoroTts(
  cfg: { modelId: string; dtype: string; device: string; wasmPaths: string | null },
  progress_callback: ((progress: unknown) => void) | null,
): Promise<KokoroTtsInstance> {
  const key = `${cfg.modelId}|${cfg.dtype}|${cfg.device}|${cfg.wasmPaths ?? ''}`;
  if (cachedTts && cachedKey === key) return cachedTts;

  cachedKey = key;
  cachedTts = (async () => {
    await ensureKokoroCacheApiAvailable();
    const mod: any = await import('kokoro-js');
    const KokoroTTS = mod?.KokoroTTS;
    const env = mod?.env;
    if (!KokoroTTS) {
      throw new Error('kokoro_import_failed');
    }

    // Ensure model/tokenizer downloads are cached even on platforms where Transformers.js
    // would otherwise disable the browser cache (e.g. React Native).
    try {
      const transformers: any = await import('@huggingface/transformers');
      const tEnv = transformers?.env;
      const cacheStorage = (globalThis as any).caches;
      if (tEnv && cacheStorage && typeof cacheStorage.open === 'function') {
        tEnv.allowLocalModels = false;
        tEnv.useFSCache = false;
        tEnv.useBrowserCache = false;
        tEnv.useCustomCache = true;
        tEnv.customCache = await cacheStorage.open('transformers-cache');
      }
    } catch {
      // ignore
    }

    if (env && typeof env === 'object') {
      if (typeof cfg.wasmPaths === 'string' && cfg.wasmPaths.trim().length > 0) {
        try {
          env.wasmPaths = cfg.wasmPaths.trim();
        } catch {
          // ignore
        }
      }
    }

    const tts = await KokoroTTS.from_pretrained(cfg.modelId, { dtype: cfg.dtype, device: cfg.device, progress_callback });
    return tts as KokoroTtsInstance;
  })();

  return cachedTts;
}

export async function synthesizeKokoroWav(opts: {
  text: string;
  assetSetId?: string | null;
  voiceId: string;
  speed: number;
  timeoutMs: number;
  signal: AbortSignal;
}): Promise<ArrayBuffer> {
  const cfg = resolveKokoroRuntimeConfig({ assetSetId: typeof opts.assetSetId === 'string' ? opts.assetSetId : null });
  const tts = await Promise.race([
    getKokoroTts(cfg, null),
    createAbortPromise(opts.signal),
    createTimeoutPromise(opts.timeoutMs),
  ]);

  const rawAudio = await Promise.race([
    tts.generate(opts.text, { voice: opts.voiceId, speed: opts.speed }),
    createAbortPromise(opts.signal),
    createTimeoutPromise(opts.timeoutMs),
  ]);

  return encodeWavPcm16({ samples: rawAudio.audio, sampleRate: rawAudio.sampling_rate });
}

export async function prepareKokoroTts(opts: {
  assetSetId?: string | null;
  timeoutMs: number;
  signal: AbortSignal;
  onProgress?: (progress: unknown) => void;
}): Promise<void> {
  const cfg = resolveKokoroRuntimeConfig({ assetSetId: typeof opts.assetSetId === 'string' ? opts.assetSetId : null });
  await Promise.race([
    getKokoroTts(cfg, (progress) => {
      opts.onProgress?.(progress);
    }),
    createAbortPromise(opts.signal),
    createTimeoutPromise(opts.timeoutMs),
  ]);
}
