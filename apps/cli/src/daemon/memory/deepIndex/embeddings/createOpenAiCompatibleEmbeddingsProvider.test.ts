import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { encryptSecretStringV1 } from '@happier-dev/protocol';

function createEncryptedApiKeySecret(key: Uint8Array) {
  return {
    _isSecretValue: true as const,
    encryptedValue: encryptSecretStringV1(
      'sk-live-qa',
      key,
      (length) => new Uint8Array(randomBytes(length)),
    ),
  };
}

describe('createOpenAiCompatibleEmbeddingsProvider', () => {
  afterEach(() => {
    vi.resetModules();
    delete process.env.HAPPIER_MEMORY_EMBEDDINGS_REMOTE_REQUEST_TIMEOUT_MS;
  });

  it('sends trimmed inputs, auth, model, and dimensions to the embeddings endpoint', async () => {
    const { createOpenAiCompatibleEmbeddingsProvider } = await import('./createOpenAiCompatibleEmbeddingsProvider');
    const requests: Array<{ url: string | undefined; authorization: string | undefined; body: unknown }> = [];
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      requests.push({
        url: req.url,
        authorization: req.headers.authorization,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
      });
      res.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
      res.end(JSON.stringify({
        data: [
          { embedding: [0.1, 0.2, 0.3] },
          { embedding: [1.1, 1.2, 1.3] },
        ],
      }));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');

    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('expected server address');
      const key = new Uint8Array(Array.from({ length: 32 }, (_, index) => index + 1));
      const provider = await createOpenAiCompatibleEmbeddingsProvider({
        config: {
          kind: 'openai_compatible',
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          apiKey: createEncryptedApiKeySecret(key),
          model: 'text-embedding-3-small',
          dimensions: 256,
        },
        settingsSecretsReadKeys: [key],
      });

      const rows = await provider.embedDocuments([' first ', 'second ']);

      expect(rows).toEqual([
        new Float32Array([0.1, 0.2, 0.3]),
        new Float32Array([1.1, 1.2, 1.3]),
      ]);
      expect(requests).toEqual([
        {
          url: '/v1/embeddings',
          authorization: 'Bearer sk-live-qa',
          body: {
            input: ['first', 'second'],
            model: 'text-embedding-3-small',
            dimensions: 256,
          },
        },
      ]);
    } finally {
      server.close();
      server.closeAllConnections();
      await once(server, 'close');
    }
  });

  it('rejects responses that do not return one embedding per requested document', async () => {
    const { createOpenAiCompatibleEmbeddingsProvider } = await import('./createOpenAiCompatibleEmbeddingsProvider');
    const server = createServer(async (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
      res.end(JSON.stringify({
        data: [
          { embedding: [0.1, 0.2, 0.3] },
        ],
      }));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');

    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('expected server address');
      const key = new Uint8Array(Array.from({ length: 32 }, (_, index) => index + 1));
      const provider = await createOpenAiCompatibleEmbeddingsProvider({
        config: {
          kind: 'openai_compatible',
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          apiKey: createEncryptedApiKeySecret(key),
          model: 'text-embedding-3-small',
          dimensions: null,
        },
        settingsSecretsReadKeys: [key],
      });

      await expect(provider.embedDocuments(['first', 'second'])).rejects.toThrow(
        'Embeddings response length mismatch',
      );
    } finally {
      server.close();
      server.closeAllConnections();
      await once(server, 'close');
    }
  });

  it('times out hanging remote requests using the configured timeout', async () => {
    process.env.HAPPIER_MEMORY_EMBEDDINGS_REMOTE_REQUEST_TIMEOUT_MS = '1000';
    const { createOpenAiCompatibleEmbeddingsProvider } = await import('./createOpenAiCompatibleEmbeddingsProvider');
    vi.stubGlobal('fetch', vi.fn((_input: unknown, init?: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('This operation was aborted', 'AbortError'));
        }, { once: true });
      });
    }));

    const key = new Uint8Array(Array.from({ length: 32 }, (_, index) => index + 1));
    const provider = await createOpenAiCompatibleEmbeddingsProvider({
      config: {
        kind: 'openai_compatible',
        baseUrl: 'https://example.test/v1',
        apiKey: createEncryptedApiKeySecret(key),
        model: 'text-embedding-3-small',
        dimensions: null,
      },
      settingsSecretsReadKeys: [key],
    });

    await expect(provider.embedQuery('first')).rejects.toThrow('Embeddings request timed out after 1000ms');
  });
});
