import { describe, expect, it, vi } from 'vitest';

import { GithubObservationRequestCoalescer } from './githubRequestCoalescer.js';

const request = {
  credentialRef: 'credential-a',
  repositoryId: '42',
  endpointKind: 'repositoryEvents' as const,
  daemonMaterializationRef: 'materialization-a',
  url: 'https://api.github.com/repos/acme/widgets/events?per_page=100&page=1',
  page: 1,
  etag: 'page-one',
};

describe('GitHub provider request coalescing', () => {
  it('shares only the same-daemon identical authenticated request for the whole cycle, including after it settles', async () => {
    const coalescer = new GithubObservationRequestCoalescer();
    let release: ((value: unknown) => void) | undefined;
    const pending = new Promise<unknown>((resolve) => { release = resolve; });
    const perform = vi.fn(() => pending);

    const first = coalescer.run(request, perform);
    const second = coalescer.run(request, perform);

    expect(first).toBe(second);
    expect(perform).toHaveBeenCalledOnce();
    release?.({ events: ['event-1'] });
    await expect(first).resolves.toEqual({ events: ['event-1'] });

    const afterSettlement = coalescer.run(request, vi.fn().mockResolvedValue({ events: ['event-2'] }));
    expect(afterSettlement).toBe(first);
    await expect(afterSettlement).resolves.toEqual({ events: ['event-1'] });
    expect(coalescer.requestCount).toBe(1);
  });

  it('never merges different credential, repository, endpoint, materialization, URL, page, or ETag requests', async () => {
    const coalescer = new GithubObservationRequestCoalescer();
    const perform = vi.fn().mockResolvedValue({ events: [] });
    const variants = [
      { ...request, credentialRef: 'credential-b' },
      { ...request, repositoryId: '43' },
      { ...request, endpointKind: 'issueComments' as const },
      { ...request, daemonMaterializationRef: 'materialization-b' },
      { ...request, url: 'https://api.github.com/repos/acme/widgets/events?per_page=100&page=2' },
      { ...request, page: 2 },
      { ...request, etag: 'page-one-revalidated' },
    ];

    await Promise.all([coalescer.run(request, perform), ...variants.map((variant) => coalescer.run(variant, perform))]);

    expect(perform).toHaveBeenCalledTimes(8);
  });
});
