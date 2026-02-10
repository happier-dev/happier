import { describe, expect, it } from 'vitest';
import http from 'node:http';
import { once } from 'node:events';
import { fetchOpenAiCompatSpeechAudio } from './fetchOpenAiCompatSpeechAudio';

function startServer(
  handler: (req: http.IncomingMessage, body: Buffer) => void | Promise<void>
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    await once(req, 'end');
    const body = Buffer.concat(chunks);

    try {
      await handler(req, body);
      res.writeHead(200, { 'Content-Type': 'audio/wav' });
      res.end(Buffer.from('ok'));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: (err as any)?.message ?? 'server_error' }));
    }
  });

  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') return reject(new Error('failed_to_bind'));
      resolve({
        baseUrl: `http://127.0.0.1:${addr.port}`,
        close: async () => {
          server.close();
          await once(server, 'close');
        },
      });
    });
  });
}

describe('fetchOpenAiCompatSpeechAudio', () => {
  it('posts to /v1/audio/speech with OpenAI-compatible fields and optional bearer auth', async () => {
    const srv = await startServer((req, body) => {
      expect(req.method).toBe('POST');
      expect(req.url).toBe('/v1/audio/speech');

      expect(req.headers['content-type']).toContain('application/json');
      expect(req.headers.authorization).toBe('Bearer secret');

      const json = JSON.parse(body.toString('utf8'));
      expect(json).toEqual({
        model: 'tts-1',
        input: 'hello',
        voice: 'alloy',
        response_format: 'wav',
      });
    });

    try {
      const audio = await fetchOpenAiCompatSpeechAudio({
        baseUrl: srv.baseUrl, // intentionally no /v1 suffix
        apiKey: 'secret',
        model: 'tts-1',
        voice: 'alloy',
        format: 'wav',
        input: 'hello',
      });

      expect(audio.byteLength).toBeGreaterThan(0);
    } finally {
      await srv.close();
    }
  });

  it('throws a stable error code when the endpoint fails', async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'nope' }));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('failed_to_bind');
    const baseUrl = `http://127.0.0.1:${addr.port}`;

    try {
      await expect(
        fetchOpenAiCompatSpeechAudio({
          baseUrl,
          apiKey: null,
          model: 'tts-1',
          voice: 'alloy',
          format: 'wav',
          input: 'hello',
        })
      ).rejects.toThrow('tts_failed');
    } finally {
      server.close();
      await once(server, 'close');
    }
  });
});

