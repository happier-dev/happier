import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MessageBuffer } from '@/ui/ink/messageBuffer';

import { createOpenCodeServerRuntimeClient } from './client';

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('createOpenCodeServerRuntimeClient (baseUrlOverride)', () => {
  const originalFetch = globalThis.fetch;
  const originalUrl = process.env.HAPPIER_OPENCODE_SERVER_URL;
  const originalPassword = process.env.OPENCODE_SERVER_PASSWORD;
  const originalUsername = process.env.OPENCODE_SERVER_USERNAME;

  beforeEach(() => {
    process.env.HAPPIER_OPENCODE_SERVER_URL = 'http://env.test';
    delete process.env.OPENCODE_SERVER_PASSWORD;
    delete process.env.OPENCODE_SERVER_USERNAME;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (typeof originalUrl === 'string') {
      process.env.HAPPIER_OPENCODE_SERVER_URL = originalUrl;
    } else {
      delete process.env.HAPPIER_OPENCODE_SERVER_URL;
    }
    if (typeof originalPassword === 'string') {
      process.env.OPENCODE_SERVER_PASSWORD = originalPassword;
    } else {
      delete process.env.OPENCODE_SERVER_PASSWORD;
    }
    if (typeof originalUsername === 'string') {
      process.env.OPENCODE_SERVER_USERNAME = originalUsername;
    } else {
      delete process.env.OPENCODE_SERVER_USERNAME;
    }
  });

  it('uses baseUrlOverride instead of env url', async () => {
    const urls: string[] = [];
    globalThis.fetch = vi.fn(async (input) => {
      const url = typeof input === 'string' ? input : String((input as any)?.url ?? '');
      urls.push(url);
      return jsonResponse({ healthy: true, version: '1.2.15' });
    }) as any;

    await createOpenCodeServerRuntimeClient({
      directory: '',
      messageBuffer: new MessageBuffer(),
      baseUrlOverride: 'http://override.test',
    });

    expect(urls[0]).toContain('http://override.test');
    expect(urls[0]).toContain('/global/health');
  });

  it('still sends configured auth headers to explicit baseUrlOverride requests', async () => {
    const headers: Array<Record<string, string> | undefined> = [];
    process.env.OPENCODE_SERVER_USERNAME = 'tester';
    process.env.OPENCODE_SERVER_PASSWORD = 'top-secret';

    globalThis.fetch = vi.fn(async (_input, init) => {
      headers.push((init?.headers as Record<string, string> | undefined) ?? undefined);
      return jsonResponse({ healthy: true, version: '1.2.15' });
    }) as any;

    await createOpenCodeServerRuntimeClient({
      directory: '',
      messageBuffer: new MessageBuffer(),
      baseUrlOverride: 'http://override.test',
    });

    expect(headers[0]?.Authorization).toBe(`Basic ${Buffer.from('tester:top-secret', 'utf8').toString('base64')}`);
  });
});
