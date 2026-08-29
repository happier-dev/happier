import { describe, expect, it, vi } from 'vitest';

import {
  GITLAB_ORIGIN_CONFIGURATION_FIELD,
  GITLAB_PERSONAL_ACCESS_TOKEN_MODE_ID,
  GITLAB_SELF_HOSTED_PERSONAL_ACCESS_TOKEN_MODE_ID,
  GITLAB_TOKEN_CREDENTIAL_KEY,
  gitlabConnectedAccountRuntime,
} from './connectedAccountRuntime.js';

const ACCOUNT = Object.freeze({
  service: { pluginId: 'happier.scm.forge.gitlab', localId: 'gitlab-account' },
  accountId: 'account-1',
});

function harness(modeId: string, baseUrl: string) {
  const request = vi.fn(async () => ({
    status: 200,
    finalUrl: `${baseUrl}/api/v4/user`,
    headers: {},
    body: new TextEncoder().encode(JSON.stringify({ id: 42, username: 'octocat' })),
  }));
  const stored = new Map<string, string>();
  const configuration = {
    target: { kind: 'account' as const, account: ACCOUNT, modeId },
    revision: 'revision-1',
    values: { [GITLAB_ORIGIN_CONFIGURATION_FIELD]: baseUrl },
    getSecret: async () => null,
  };
  return {
    request,
    stored,
    context: {
      signal: new AbortController().signal,
      services: { http: { request } },
      service: ACCOUNT.service,
      attempt: { kind: 'connect' as const, attemptId: 'attempt-1' },
      configuration,
      attemptCredentials: {
        async get(key: string) { return stored.get(key) ?? null; },
        async set(key: string, value: string) { stored.set(key, value); },
        async delete(key: string) { stored.delete(key); },
      },
    },
  };
}

async function complete(modeId: string, baseUrl: string) {
  const fixture = harness(modeId, baseUrl);
  const mode = gitlabConnectedAccountRuntime.authentication.modes[modeId];
  if (mode?.kind !== 'manual') throw new Error('expected a manual GitLab authentication mode');
  const result = await mode.complete(
    { fields: { [GITLAB_TOKEN_CREDENTIAL_KEY]: 'gitlab-test-token' } },
    fixture.context as never,
  );
  return { ...fixture, result };
}

describe('GitLab connected-account deployment modes', () => {
  it('confirms GitLab.com through the fixed-origin mode', async () => {
    const result = await complete(GITLAB_PERSONAL_ACCESS_TOKEN_MODE_ID, 'https://gitlab.com');
    expect(result.result).toMatchObject({ status: 'connected', displayName: '@octocat · gitlab.com' });
    expect(result.request).toHaveBeenCalledWith(expect.objectContaining({
      url: 'https://gitlab.com/api/v4/user',
    }), expect.anything());
  });

  it('confirms the exact self-managed base path through the connected-origin mode', async () => {
    const result = await complete(
      GITLAB_SELF_HOSTED_PERSONAL_ACCESS_TOKEN_MODE_ID,
      'https://gitlab.example.test/Corp/GitLab',
    );
    expect(result.result).toMatchObject({ status: 'connected', displayName: '@octocat · gitlab.example.test' });
    expect(result.request).toHaveBeenCalledWith(expect.objectContaining({
      url: 'https://gitlab.example.test/Corp/GitLab/api/v4/user',
    }), expect.anything());
  });

  it('does not let either mode borrow the other mode’s network authority', async () => {
    const publicThroughPrivate = await complete(
      GITLAB_SELF_HOSTED_PERSONAL_ACCESS_TOKEN_MODE_ID,
      'https://gitlab.com',
    );
    expect(publicThroughPrivate.result).toMatchObject({
      status: 'rejected',
      diagnostic: { code: 'gitlab_origin_undeclared' },
    });
    expect(publicThroughPrivate.request).not.toHaveBeenCalled();

    const privateThroughPublic = await complete(
      GITLAB_PERSONAL_ACCESS_TOKEN_MODE_ID,
      'https://gitlab.example.test',
    );
    expect(privateThroughPublic.result).toMatchObject({
      status: 'rejected',
      diagnostic: { code: 'gitlab_origin_undeclared' },
    });
    expect(privateThroughPublic.request).not.toHaveBeenCalled();
  });
});
