import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createOpenCodeServerRuntimeClient } from './client';

type FakeResponse = {
  ok: boolean;
  status: number;
  statusText: string;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
};

function createOkJsonResponse(body: unknown): FakeResponse {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

describe('createOpenCodeServerRuntimeClient (MCP)', () => {
  const prevEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();

    for (const key of ['HAPPIER_OPENCODE_SERVER_URL', 'OPENCODE_SERVER_PASSWORD', 'OPENCODE_SERVER_USERNAME'] as const) {
      prevEnv[key] = process.env[key];
    }

    process.env.HAPPIER_OPENCODE_SERVER_URL = 'http://127.0.0.1:9999';
    delete process.env.OPENCODE_SERVER_PASSWORD;
    delete process.env.OPENCODE_SERVER_USERNAME;
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(prevEnv)) {
      if (value === undefined) {
        delete (process.env as any)[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it('POSTs to /mcp with directory query and JSON body', async () => {
    const fetchSpy = vi.fn(async (_url: any, _init?: any) => createOkJsonResponse({}) as any);
    vi.stubGlobal('fetch', fetchSpy as any);

    const client = await createOpenCodeServerRuntimeClient({ directory: '/tmp', messageBuffer: { push: () => {} } as any });
    await client.mcpAdd({ name: 'my-mcp', config: { type: 'local', enabled: true } });

    const lastCall = fetchSpy.mock.calls.at(-1);
    expect(lastCall).toBeDefined();
    const [url, init] = lastCall!;

    const parsed = new URL(String(url));
    expect(parsed.pathname).toBe('/mcp');
    expect(parsed.searchParams.get('directory')).toBe('/tmp');

    expect((init as any).method).toBe('POST');
    expect((init as any).headers?.['content-type']).toBe('application/json');
    expect(JSON.parse(String((init as any).body))).toEqual({
      name: 'my-mcp',
      config: { type: 'local', enabled: true },
    });
  });

  it('POSTs to /mcp/:name/disconnect with directory query', async () => {
    const fetchSpy = vi.fn(async (_url: any, _init?: any) => createOkJsonResponse({}) as any);
    vi.stubGlobal('fetch', fetchSpy as any);

    const client = await createOpenCodeServerRuntimeClient({ directory: '/tmp', messageBuffer: { push: () => {} } as any });
    await client.mcpDisconnect({ name: 'my-mcp' });

    const lastCall = fetchSpy.mock.calls.at(-1);
    expect(lastCall).toBeDefined();
    const [url, init] = lastCall!;

    const parsed = new URL(String(url));
    expect(parsed.pathname).toBe('/mcp/my-mcp/disconnect');
    expect(parsed.searchParams.get('directory')).toBe('/tmp');

    expect((init as any).method).toBe('POST');
  });
});
