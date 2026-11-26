import { createPluginHttpFixture } from '@happier-dev/plugin-sdk/testing';
import { describe, expect, it } from 'vitest';

import { writeGithubManagedRepositoryWebhook } from './githubManagedRepositoryWebhook.js';

describe('GitHub repository preview hook', () => {
  it.each([
    { kind: 'subscribePullRequests', events: ['push', 'pull_request'], change: { add_events: ['pull_request'] } },
    { kind: 'unsubscribePullRequests', events: ['push'], change: { remove_events: ['pull_request'] } },
  ] as const)('applies $kind to the existing hook and keeps push', async ({ kind, events, change }) => {
    const calls: unknown[] = [];
    const credentialRef = {
      service: { pluginId: 'happier.scm.forge.github', localId: 'github-account' }, accountId: 'fixture',
    } as const;
    const context = {
      plugin: { id: credentialRef.service.pluginId },
      signal: new AbortController().signal,
      services: {
        connectedAccounts: {
          async materialize() { return { kind: 'httpHeaders', headers: { authorization: 'Bearer fixture' } }; },
        },
        http: createPluginHttpFixture({ async request(input) {
          calls.push({ method: input.method, url: input.url,
            ...(input.body ? { body: JSON.parse(new TextDecoder().decode(input.body)) } : {}) });
          const body = input.method === 'PATCH' ? { id: 73, events }
            : { id: 42, name: 'site', full_name: 'acme/site', owner: { login: 'acme' } };
          return { status: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify(body)) };
        } }),
      },
    } as unknown as Parameters<typeof writeGithubManagedRepositoryWebhook>[0];

    await expect(writeGithubManagedRepositoryWebhook(context, {
      kind, repositoryId: '42', hookId: '73', credentialRef,
    })).resolves.toEqual({ kind: 'registered', hookId: '73' });
    expect(calls).toEqual([
      { method: 'GET', url: 'https://api.github.com/repositories/42' },
      { method: 'PATCH', url: 'https://api.github.com/repos/acme/site/hooks/73',
        body: change },
    ]);
  });
});
