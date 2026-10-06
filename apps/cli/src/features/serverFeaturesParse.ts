import { FEATURES_RESPONSE_MAX_UTF8_BYTES_V1 } from '@happier-dev/protocol/features/payload/responseLimits';
import { FeaturesResponseSchema } from '@happier-dev/protocol/features/payload/featuresResponseSchema';
import type { FeaturesResponse as ServerFeatures } from '@happier-dev/protocol';

export function parseServerFeatures(raw: unknown): ServerFeatures | null {
  const parsed = FeaturesResponseSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

type ServerFeaturesBodyReader = Readonly<{
  read(): Promise<Readonly<{ done: boolean; value?: unknown }>>;
  cancel(): Promise<void>;
  release(): void;
}>;

function responseBodyReader(body: unknown): ServerFeaturesBodyReader | null {
  if (typeof body !== 'object' || body === null) return null;
  const webBody = body as {
    getReader?: unknown;
  };
  if (typeof webBody.getReader === 'function') {
    const reader = webBody.getReader() as {
      read(): Promise<Readonly<{ done: boolean; value?: unknown }>>;
      cancel(): Promise<void>;
      releaseLock(): void;
    };
    return {
      read: async () => await reader.read(),
      cancel: async () => await reader.cancel(),
      release: () => reader.releaseLock(),
    };
  }

  const iterable = body as {
    [Symbol.asyncIterator]?: unknown;
    destroy?: unknown;
  };
  const createIterator = iterable[Symbol.asyncIterator];
  if (typeof createIterator !== 'function') return null;
  const iterator = createIterator.call(body) as AsyncIterator<unknown>;
  return {
    read: async () => {
      const next = await iterator.next();
      return next.done ? { done: true } : { done: false, value: next.value };
    },
    cancel: async () => {
      if (typeof iterable.destroy === 'function') iterable.destroy();
      else await iterator.return?.(undefined);
    },
    release: () => {},
  };
}

/**
 * Canonical CLI feature-response receive boundary for both Fetch and Node
 * streams. Bytes are charged before UTF-8 decoding, JSON parsing, or schema
 * interpretation, and a declared length is never trusted as the only bound.
 */
export async function decodeServerFeaturesResponseBody(
  body: unknown,
  declaredContentLength?: unknown,
): Promise<ServerFeatures | null> {
  const raw = await decodeBoundedJsonResponseBody(
    body,
    declaredContentLength,
    FEATURES_RESPONSE_MAX_UTF8_BYTES_V1,
  );
  return raw === null ? null : parseServerFeatures(raw);
}

export async function decodeBoundedJsonResponseBody(
  body: unknown,
  declaredContentLength: unknown,
  maxUtf8Bytes: number,
): Promise<unknown | null> {
  const reader = responseBodyReader(body);
  if (!reader) return null;
  if (typeof declaredContentLength === 'string' && /^\d+$/u.test(declaredContentLength)) {
    const length = Number(declaredContentLength);
    if (!Number.isSafeInteger(length) || length > maxUtf8Bytes) {
      await reader.cancel().catch(() => undefined);
      reader.release();
      return null;
    }
  }

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = typeof next.value === 'string'
        ? new TextEncoder().encode(next.value)
        : next.value instanceof Uint8Array
          ? next.value
          : null;
      if (!chunk) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      totalBytes += chunk.byteLength;
      if (totalBytes > maxUtf8Bytes) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(chunk);
    }
  } catch {
    return null;
  } finally {
    reader.release();
  }

  const encoded = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    encoded.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(encoded)) as unknown;
  } catch {
    return null;
  }
}
