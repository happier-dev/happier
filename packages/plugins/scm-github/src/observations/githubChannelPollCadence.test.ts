import { describe, expect, it } from 'vitest';
import { createGithubReadCadence } from './githubChannelPollCadence.js';
import type { GithubApiClientV1 } from './githubApiClient.js';

// GitHub is the external boundary: an unchanged authenticated conditional GET
// returns 304 without spending the primary rate-limit budget.
function githubBoundary() {
  let charged = 0;
  let requests = 0;
  let revision = 'first';
  const lifetime = {};
  const client: GithubApiClientV1 = {
    immutableDefinitionLifetime: lifetime,
    requestWithoutFollowingRedirects: async () => { throw new Error('Unexpected redirect read'); },
    async request(input) {
      requests += 1;
      const notModified = input.headers?.['If-None-Match'] === revision;
      if (!notModified) charged += 1;
      return { status: notModified ? 304 : 200,
        headers: { ETag: revision, 'X-Poll-Interval': '37',
          'x-ratelimit-remaining': String(5000 - charged), 'x-ratelimit-reset': '3600' },
        body: notModified ? new Uint8Array() : new TextEncoder().encode(JSON.stringify({ revision })),
      };
    },
  };
  return { client, charged: () => charged, requests: () => requests, change: () => { revision = 'second'; } };
}

describe('GitHub demanded-read cadence', () => {
  it('makes unchanged demanded REST reads conditional across admitted clients without spending the remaining window', async () => {
    const boundary = githubBoundary();
    const urls = Array.from({ length: 1 }, (_, index) => `https://api.github.com/repos/o/r/pulls/${index + 1}`);
    const read = async (nowMs: number) => {
      const cadence = createGithubReadCadence({ ...boundary.client }, nowMs);
      for (const url of urls) {
        const result = await cadence.client.request({ url });
        expect(result.status).toBe(200);
        expect(JSON.parse(new TextDecoder().decode(result.body))).toEqual({ revision: 'first' });
      }
      expect(cadence.refreshAfterMs()).toBe(37_000);
    };
    await read(0);
    const baseline = boundary.charged();
    for (let minute = 1; minute <= 20; minute += 1) await read(minute * 60_000);
    expect(boundary.charged() - baseline).toBe(0);
    expect(boundary.requests()).toBe(urls.length * 21);
  });

  it('reads changed representations and keeps caller-managed validators and credential lifetimes separate', async () => {
    const boundary = githubBoundary();
    const url = 'https://api.github.com/repos/o/r/pulls/1';
    await createGithubReadCadence(boundary.client, 0).client.request({ url });
    boundary.change();
    const changed = await createGithubReadCadence(boundary.client, 37_000).client.request({ url });
    expect(JSON.parse(new TextDecoder().decode(changed.body))).toEqual({ revision: 'second' });
    const conditional = await createGithubReadCadence(boundary.client, 74_000).client.request({ url, headers: { 'If-None-Match': 'second' } });
    expect(conditional.status).toBe(304);
    expect(conditional.body).toHaveLength(0);
    await createGithubReadCadence({ ...boundary.client, immutableDefinitionLifetime: {} }, 111_000).client.request({ url });
    expect(boundary.charged()).toBe(3);
  });

  it('retains pagination on a 304 without reusing stale response timing, and drops bodies without validators', async () => {
    let reads = 0;
    const response = githubBoundary().client;
    const client: GithubApiClientV1 = { ...response, async request(input) {
      reads += 1;
      if (reads === 1) return { status: 200,
        headers: { ETag: 'first', Link: '<https://api.github.com/next>; rel="next"', 'Retry-After': '90' },
        body: new TextEncoder().encode('{"page":1}') };
      if (reads === 2) {
        expect(input.headers?.['If-None-Match']).toBe('first');
        return { status: 304, headers: { 'X-Poll-Interval': '37' }, body: new Uint8Array() };
      }
      if (reads === 3) {
        expect(input.headers?.['If-None-Match']).toBe('first');
        return { status: 200, headers: {}, body: new TextEncoder().encode('{"page":2}') };
      }
      expect(input.headers?.['If-None-Match']).toBeUndefined();
      return { status: 200, headers: {}, body: new TextEncoder().encode('{"page":3}') };
    } };
    const url = 'https://api.github.com/repos/o/r/pulls/1';
    await createGithubReadCadence(client, 0).client.request({ url });
    const next = createGithubReadCadence(client, 90_000);
    const retained = await next.client.request({ url });
    expect(JSON.parse(new TextDecoder().decode(retained.body))).toEqual({ page: 1 });
    expect(retained.headers.link).toBe('<https://api.github.com/next>; rel="next"');
    expect(retained.headers).not.toHaveProperty('Retry-After');
    expect(next.refreshAfterMs()).toBe(37_000);
    await createGithubReadCadence(client, 127_000).client.request({ url });
    await createGithubReadCadence(client, 164_000).client.request({ url });
  });

  it('uses the approved watching fallback and lets explicit server instructions own the delay', async () => {
    const response = (headers: Readonly<Record<string, string>>) => ({ ...githubBoundary().client,
      request: async () => ({ status: 200, headers, body: new TextEncoder().encode('{}') }) });
    for (const [headers, expected] of [
      [{ 'x-ratelimit-remaining': '10', 'x-ratelimit-reset': '1200' }, 60_000],
      [{ 'x-poll-interval': '37', 'Retry-After': '90' }, 90_000],
      [{ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '600' }, 60_000],
      [{ 'x-poll-interval': '37', 'x-ratelimit-remaining': '10', 'x-ratelimit-reset': '600' }, 37_000],
    ] as const) {
      const cadence = createGithubReadCadence(response(headers), 0);
      await cadence.client.request({ url: 'https://api.github.com/repos/o/r/pulls/1' });
      expect(cadence.refreshAfterMs()).toBe(expected);
    }
  });
});
