import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MessageBuffer } from '@/ui/ink/messageBuffer';

import { createOpenCodeServerRuntimeClient } from './client';

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('createOpenCodeServerRuntimeClient (directory override)', () => {
  const originalFetch = globalThis.fetch;
  const originalUrl = process.env.HAPPIER_OPENCODE_SERVER_URL;

  beforeEach(() => {
    process.env.HAPPIER_OPENCODE_SERVER_URL = 'http://example.test';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (typeof originalUrl === 'string') {
      process.env.HAPPIER_OPENCODE_SERVER_URL = originalUrl;
    } else {
      delete process.env.HAPPIER_OPENCODE_SERVER_URL;
    }
  });

  it('uses setDirectoryOverride() for directory-scoped endpoints', async () => {
    const urls: string[] = [];
    globalThis.fetch = vi.fn(async (input, init) => {
      const url = typeof input === 'string' ? input : String((input as any)?.url ?? '');
      urls.push(url);

      if (url.includes('/global/health')) {
        return jsonResponse({ healthy: true, version: '1.2.15' });
      }

      if (url.includes('/prompt_async')) {
        return new Response(null, { status: 204 });
      }

      return jsonResponse({});
    }) as any;

    const client = await createOpenCodeServerRuntimeClient({
      directory: '/wrong',
      messageBuffer: new MessageBuffer(),
    });

    await client.sessionPromptAsync({
      sessionId: 'ses_1',
      parts: [{ type: 'text', text: 'hello' }],
    });

    client.setDirectoryOverride('/right');
    await client.sessionPromptAsync({
      sessionId: 'ses_1',
      parts: [{ type: 'text', text: 'hello' }],
    });

    const promptUrls = urls.filter((u) => u.includes('/prompt_async'));
    expect(promptUrls.length).toBe(2);

    const first = new URL(promptUrls[0]!);
    expect(first.searchParams.get('directory')).toBe('/wrong');

    const second = new URL(promptUrls[1]!);
    expect(second.searchParams.get('directory')).toBe('/right');

    expect((globalThis.fetch as any).mock.calls[0]?.[1]?.method).toBe('GET');
  });
});
