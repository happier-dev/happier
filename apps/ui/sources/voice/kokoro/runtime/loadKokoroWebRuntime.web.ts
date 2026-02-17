export type KokoroWebRuntimeModule = {
  KokoroTTS?: unknown;
  TextSplitterStream?: unknown;
  env?: unknown;
};

type Importer = (url: string) => Promise<KokoroWebRuntimeModule>;

const EXPO_PUBLIC_KOKORO_WEB_RUNTIME_URL_ENV_VAR = 'EXPO_PUBLIC_KOKORO_WEB_RUNTIME_URL';

function resolveKokoroWebRuntimeUrl(env: Record<string, string | undefined> = process.env): string {
  const raw = env[EXPO_PUBLIC_KOKORO_WEB_RUNTIME_URL_ENV_VAR];
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  return trimmed || '/vendor/kokoro/kokoro.web.js';
}

async function defaultImporter(url: string): Promise<KokoroWebRuntimeModule> {
  return import(/* @metro-ignore */ url);
}

let cachedRuntimeUrl: string | null = null;
let cachedRuntime: Promise<KokoroWebRuntimeModule> | null = null;

export async function loadKokoroWebRuntime(opts?: {
  runtimeUrl?: string;
  importer?: Importer;
  env?: Record<string, string | undefined>;
}): Promise<Required<Pick<KokoroWebRuntimeModule, 'KokoroTTS'>> & KokoroWebRuntimeModule> {
  const runtimeUrl =
    typeof opts?.runtimeUrl === 'string' && opts.runtimeUrl.trim().length > 0
      ? opts.runtimeUrl.trim()
      : resolveKokoroWebRuntimeUrl(opts?.env);

  const importer = opts?.importer ?? defaultImporter;

  if (cachedRuntime && cachedRuntimeUrl === runtimeUrl) {
    return cachedRuntime as any;
  }

  cachedRuntimeUrl = runtimeUrl;
  cachedRuntime = (async () => {
    try {
      let mod: KokoroWebRuntimeModule;
      try {
        mod = await importer(runtimeUrl);
      } catch (err) {
        throw new Error(
          `kokoro_import_failed: unable to load Kokoro web runtime from ${runtimeUrl} (${String(
            (err as any)?.message ?? err,
          )})`,
        );
      }

      if (!mod?.KokoroTTS) {
        throw new Error(`kokoro_import_failed: KokoroTTS export missing from ${runtimeUrl}`);
      }

      return mod;
    } catch (err) {
      // If the import fails (network, 404, runtime error), allow the caller to retry after fixing
      // the underlying issue (e.g. vendoring the runtime file).
      cachedRuntimeUrl = null;
      cachedRuntime = null;
      throw err;
    }
  })();

  return cachedRuntime as any;
}
