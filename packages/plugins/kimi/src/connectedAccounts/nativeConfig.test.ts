import { describe, expect, it } from 'vitest';
import { parse } from 'smol-toml';
import type { ConnectedAccountRuntime } from '@happier-dev/plugin-sdk/connected-accounts';
import { createKimiConnectedAccountRuntime } from './runtime.js';

describe('Kimi selected launch representation', () => {
  it('delivers B access and B models while preserving tools and excluding A and every refresh root', async () => {
    const runtime = createKimiConnectedAccountRuntime();
    const values: Record<string, string> = { accessToken: 'fake-access-b', refreshToken: 'fake-root-b', credentialKind: 'oauth', apiBase: 'https://api.kimi.ai/coding/v1' };
    const requests: string[] = [];
    const context = { configuration: { values: {} }, signal: new AbortController().signal, invokedAtMs: 1800000000000,
      credentials: { async get(key: string) { return values[key] ?? null; } }, services: { http: { async request(input: { url: string; headers?: Record<string, string> }) {
        requests.push(input.url); expect(input.headers?.Authorization).toBe('Bearer fake-access-b');
        return { status: 200, headers: {}, finalUrl: input.url, body: new TextEncoder().encode(JSON.stringify({ data: [{ id: 'b', limit: { context: 128000 } }] })) };
      } } },
    } as Parameters<ConnectedAccountRuntime['materialize']>[1];
    const existing = new TextEncoder().encode('default_model="a"\n[providers.a]\napi_key="fake-a"\n[models.a]\nprovider="a"\nmodel="a"\n[tools]\ncustom=true\n[services.moonshot_search]\napi_key="fake-service-a"\n');
    const material = await runtime.materialize({ kind: 'files', fileIds: ['config.toml'] }, context, { existingFiles: { 'config.toml': existing } });
    if (material.kind !== 'files') throw new Error('Expected native files');
    const text = new TextDecoder().decode(material.files['config.toml']);
    const config = parse(text);
    expect(config.default_model).toBe('kimi-code/b');
    expect(config.tools).toEqual({ custom: true });
    expect(Object.keys(config.models as object)).toEqual(['kimi-code/b']);
    expect(text).not.toContain('"fake-a"');
    expect(text).not.toContain('fake-service-a');
    expect(text).not.toContain('refresh');
    expect(text).not.toContain('oauth');
    expect(await runtime.materialize({ kind: 'environment', keys: ['HAPPIER_KIMI_ACCESS_TOKEN'] }, context)).toEqual({ kind: 'environment', env: { HAPPIER_KIMI_ACCESS_TOKEN: 'fake-access-b' } });
    expect(requests).toEqual(['https://api.kimi.ai/coding/v1/models']);
    expect(new TextDecoder().decode(existing)).toContain('fake-a');
  });
});
