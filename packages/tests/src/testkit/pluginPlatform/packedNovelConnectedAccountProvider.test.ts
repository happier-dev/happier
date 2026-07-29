import { get } from 'node:http';

import { describe, expect, it } from 'vitest';

import {
  classifyPackedNovelConnectedAccountProviderRequest,
  startPackedNovelConnectedAccountProvider,
} from './packedNovelConnectedAccountProvider';

function requestPath(
  origin: string,
  path: string,
): Promise<Readonly<{ status: number; body: string }>> {
  return new Promise((resolve, reject) => {
    const request = get(`${origin}${path}`, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      response.once('error', reject);
      response.once('end', () => resolve({
        status: response.statusCode ?? 0,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    request.once('error', reject);
  });
}

describe('packed novel Connected Account provider fixture', () => {
  it('classifies the one exact accepted route and rejects malformed encoding', () => {
    expect(classifyPackedNovelConnectedAccountProviderRequest({
      method: 'GET',
      rawUrl: '/@happier-dev%2fplugin-sdk',
    })).toBe('accepted');
    expect(classifyPackedNovelConnectedAccountProviderRequest({
      method: 'GET',
      rawUrl: '/other',
    })).toBe('not-found');
    expect(classifyPackedNovelConnectedAccountProviderRequest({
      method: 'GET',
      rawUrl: '/%',
    })).toBe('malformed');
  });

  it('counts only accepted requests, rejects wrong and malformed paths, and closes idempotently', async () => {
    const provider = await startPackedNovelConnectedAccountProvider();
    try {
      await expect(
        requestPath(provider.origin, '/@happier-dev%2fplugin-sdk'),
      ).resolves.toMatchObject({
        status: 200,
      });
      await expect(requestPath(provider.origin, '/other')).resolves.toEqual({
        status: 404,
        body: '{"error":"not_found"}',
      });
      await expect(requestPath(provider.origin, '/%')).resolves.toEqual({
        status: 400,
        body: '{"error":"malformed_request_path"}',
      });
      expect(provider.requestCount()).toBe(1);
    } finally {
      await provider.close();
      await provider.close();
    }
  });
});
