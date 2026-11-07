import { describe, expect, it } from 'vitest';
import { createStubGithubTransport, createTestGithubApiClient } from '../triage/testkit/githubTriage.test-support.js';

describe('GitHub API private media', () => {
  it('keeps API authorization on the API hop and strips it from the signed-storage hop', async () => {
    const storageUrl = 'https://productionresults.blob.core.windows.net/actions-results/log?sig=synthetic';
    const transport = createStubGithubTransport({ respond: request => {
      if (new URL(request.url).origin === 'https://api.github.com') {
        expect(request.headers.Authorization).toBeDefined();
        expect(request.redirect).toBe('manual');
        return { status: 302, headers: { location: storageUrl } };
      }
      expect(request.url).toBe(storageUrl);
      expect(Object.keys(request.headers).some(name => name.toLowerCase() === 'authorization')).toBe(false);
      expect(request.redirect).toBe('error');
      return { status: 200, rawBody: new Uint8Array([0, 255, 1]) };
    } });
    const client = await createTestGithubApiClient(transport);
    expect(await client.requestMedia({ url: 'https://api.github.com/repos/octo-org/example-app/actions/jobs/91/logs', media: 'binary' })).toMatchObject({ status: 200, body: new Uint8Array([0, 255, 1]) });
    expect(transport.requests).toHaveLength(2);
  });
  it.each(['http://storage.example/log', 'https://user:password@storage.example/log', 'https://api.github.com/repos/x/y'])('rejects inadmissible storage redirects without a second request: %s', async location => {
    const transport = createStubGithubTransport({ respond: () => ({ status: 302, headers: { location } }) });
    const client = await createTestGithubApiClient(transport);
    await expect(client.requestMedia({ url: 'https://api.github.com/repos/octo-org/example-app/actions/jobs/91/logs', media: 'binary' })).rejects.toBeDefined();
    expect(transport.requests).toHaveLength(1);
  });
});
