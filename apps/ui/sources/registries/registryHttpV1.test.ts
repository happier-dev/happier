import { describe, expect, it } from 'vitest';
import { createUiRegistryHttpV1 } from './registryHttpV1';

describe('UI registry HTTP boundary', () => {
  it('posts form data through the same result projection as GET', async () => {
    let method = '';
    let body: BodyInit | null | undefined;
    const http = createUiRegistryHttpV1(async (_url, init) => {
      method = init?.method ?? '';
      body = init?.body;
      return new Response('fixture', { status: 200 });
    });
    await expect(http.postForm?.('https://registry-form.example/rpc', 'f.req=fixture')).resolves
      .toMatchObject({ ok: true, value: 'fixture' });
    expect(method).toBe('POST');
    expect(body).toBe('f.req=fixture');
  });
});
