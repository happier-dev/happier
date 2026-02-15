import { digest } from '@/platform/digest';

type CacheKey = string;

type CacheProgress = { progress: number; loaded: number; total: number };
type CacheProgressCallback = ((data: CacheProgress) => void) | undefined;

type CacheLike = {
  match(request: CacheKey): Promise<Response | undefined>;
  put(request: CacheKey, response: Response, progress_callback?: CacheProgressCallback): Promise<void>;
  keys(): Promise<CacheKey[]>;
};

type CacheStorageLike = {
  open(name: string): Promise<CacheLike>;
  delete(name: string): Promise<boolean>;
};

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

async function hashKey(key: string): Promise<string> {
  const data = new TextEncoder().encode(key);
  const bytes = await digest('SHA-256', data);
  return toHex(bytes);
}

function createMemoryCacheStorage(): CacheStorageLike {
  const cachesByName = new Map<string, Map<string, { bytes: Uint8Array; headers: Record<string, string> }>>();

  const open = async (name: string): Promise<CacheLike> => {
    const store = cachesByName.get(name) ?? new Map();
    cachesByName.set(name, store);

    return {
      async match(request: CacheKey) {
        const hit = store.get(request);
        if (!hit) return undefined;
        return new Response(hit.bytes, { headers: hit.headers });
      },
      async put(request: CacheKey, response: Response) {
        const buf = new Uint8Array(await response.arrayBuffer());
        const headers: Record<string, string> = {};
        try {
          response.headers.forEach((value, key) => {
            headers[key] = value;
          });
        } catch {
          // ignore
        }
        store.set(request, { bytes: buf, headers });
      },
      async keys() {
        return Array.from(store.keys());
      },
    };
  };

  const del = async (name: string): Promise<boolean> => {
    const existed = cachesByName.has(name);
    cachesByName.delete(name);
    return existed;
  };

  return { open, delete: del };
}

async function createFileBackedCacheStorage(): Promise<CacheStorageLike> {
  const fs = await import('expo-file-system');
  const { Directory, File, Paths } = fs as any;

  const rootDir = new Directory(Paths.document, 'happier', 'kokoro', 'cache-api');
  try {
    rootDir.create({ intermediates: true, idempotent: true });
  } catch {
    // ignore
  }

  const open = async (name: string): Promise<CacheLike> => {
    const cacheDir = new Directory(rootDir, name);
    try {
      cacheDir.create({ intermediates: true, idempotent: true });
    } catch {
      // ignore
    }

    const metaForHash = (hash: string) => new File(cacheDir, `${hash}.json`);
    const blobForHash = (hash: string) => new File(cacheDir, `${hash}.bin`);

    return {
      async match(request: CacheKey) {
        const hash = await hashKey(request);
        const file = blobForHash(hash);
        if (!file.exists) return undefined;

        let headers: Record<string, string> = {};
        const meta = metaForHash(hash);
        if (meta.exists) {
          try {
            const text = await (meta as any).text();
            const parsed = JSON.parse(text);
            if (parsed && typeof parsed === 'object' && parsed.headers && typeof parsed.headers === 'object') {
              headers = parsed.headers;
            }
          } catch {
            // ignore
          }
        }

        const bytes = await file.arrayBuffer();
        return new Response(bytes, { headers });
      },

      async put(request: CacheKey, response: Response, progress_callback?: CacheProgressCallback) {
        const hash = await hashKey(request);
        const file = blobForHash(hash);
        const meta = metaForHash(hash);

        const headers: Record<string, string> = {};
        try {
          response.headers.forEach((value, key) => {
            headers[key] = value;
          });
        } catch {
          // ignore
        }

        const contentLength = response.headers.get('content-length');
        const total = contentLength ? Number(contentLength) : 0;
        let loaded = 0;

        try {
          const body: any = (response as any).body;
          const reader = body?.getReader?.();
          const writable: WritableStream | null = (file as any).writableStream?.() ?? null;
          const writer = writable ? (writable as any).getWriter?.() : null;

          if (reader && writer) {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              if (value) {
                await writer.write(value);
                loaded += value.length ?? value.byteLength ?? 0;
                const progress = total > 0 ? (loaded / total) * 100 : 0;
                progress_callback?.({ progress, loaded, total });
              }
            }
            await writer.close();
          } else {
            const buf = new Uint8Array(await response.arrayBuffer());
            loaded = buf.length;
            (file as any).write(buf);
            progress_callback?.({ progress: 100, loaded, total: total || loaded });
          }

          (meta as any).write(JSON.stringify({ key: request, headers }));
        } catch (error) {
          try {
            if (file.exists) file.delete();
          } catch {
            // ignore
          }
          throw error;
        }
      },

      async keys() {
        try {
          const entries = cacheDir.list();
          const metas = entries.filter((e: any) => e?.name?.endsWith?.('.json'));
          const out: string[] = [];
          for (const m of metas) {
            try {
              const text = await (m as any).text();
              const parsed = JSON.parse(text);
              if (parsed && typeof parsed.key === 'string') out.push(parsed.key);
            } catch {
              // ignore
            }
          }
          return out;
        } catch {
          return [];
        }
      },
    };
  };

  const del = async (name: string): Promise<boolean> => {
    const dir = new Directory(rootDir, name);
    if (!dir.exists) return false;
    try {
      dir.delete();
      return true;
    } catch {
      return false;
    }
  };

  return { open, delete: del };
}

export async function ensureKokoroCacheApiAvailable(): Promise<void> {
  const existing = (globalThis as any).caches;
  if (existing && typeof existing.open === 'function') return;

  try {
    const storage = await createFileBackedCacheStorage();
    (globalThis as any).caches = storage;
    return;
  } catch {
    // fall through to memory
  }

  (globalThis as any).caches = createMemoryCacheStorage();
}

