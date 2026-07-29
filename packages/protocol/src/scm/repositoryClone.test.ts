import { describe, expect, it } from 'vitest';

import * as protocol from '../index.js';

type ZodLikeSchema<TValue = unknown> = {
  parse: (value: unknown) => TValue;
  safeParse: (value: unknown) => { success: boolean };
};

function readProtocolSchema<TValue = unknown>(name: string): ZodLikeSchema<TValue> {
  const value = (protocol as Record<string, unknown>)[name];
  expect(value).toMatchObject({
    parse: expect.any(Function),
    safeParse: expect.any(Function),
  });
  return value as ZodLikeSchema<TValue>;
}

describe('SCM repository clone protocol contracts', () => {
  it('requires an explicit destination parent, safe child name, protocol preference, and user authorization', () => {
    const schema = readProtocolSchema<protocol.ScmRepositoryCloneInput>(
      'ScmRepositoryCloneInputSchema',
    );

    const parsed = schema.parse({
      provider: {
        id: 'github:github.com',
        kind: 'github',
        displayName: 'GitHub',
        baseUrl: 'https://github.com',
      },
      repository: {
        nameWithOwner: 'happier-dev/happier',
        webUrl: 'https://github.com/happier-dev/happier',
        visibility: 'public',
      },
      destinationParentPath: '/Users/example/Code',
      destinationDirectoryName: 'happier',
      protocol: 'auto',
      confirmed: true,
      authorizationToken: 'clone-repository',
    });

    expect(parsed.destinationParentPath).toBe('/Users/example/Code');
    expect(parsed.destinationDirectoryName).toBe('happier');
    expect(parsed.protocol).toBe('auto');
    expect(parsed.confirmed).toBe(true);
    expect(parsed.authorizationToken).toBe('clone-repository');

    expect(schema.safeParse({
      provider: parsed.provider,
      repository: parsed.repository,
      destinationParentPath: '~/Code',
      destinationDirectoryName: 'happier',
      protocol: 'https',
      confirmed: true,
      authorizationToken: 'clone-repository',
    }).success).toBe(false);

    expect(schema.safeParse({
      provider: parsed.provider,
      repository: parsed.repository,
      destinationParentPath: '/Users/example/Code',
      destinationDirectoryName: '../happier',
      protocol: 'https',
      confirmed: true,
      authorizationToken: 'clone-repository',
    }).success).toBe(false);

    expect(schema.safeParse({
      provider: parsed.provider,
      repository: parsed.repository,
      destinationParentPath: '/Users/example/Code',
      destinationDirectoryName: 'happier',
      protocol: 'https',
      confirmed: false,
      authorizationToken: 'clone-repository',
    }).success).toBe(false);
  });

  it('parses clone success responses with rediscovered SCM snapshot identity', () => {
    const schema = readProtocolSchema<protocol.ScmRepositoryCloneOutput>(
      'ScmRepositoryCloneOutputSchema',
    );

    const response = schema.parse({
      success: true,
      destinationPath: '/Users/example/Code/happier',
      cloneProtocol: 'https',
      cloneUrl: 'https://github.com/happier-dev/happier.git',
      repository: {
        provider: {
          id: 'github:github.com',
          kind: 'github',
          displayName: 'GitHub',
          baseUrl: 'https://github.com',
        },
        nameWithOwner: 'happier-dev/happier',
        webUrl: 'https://github.com/happier-dev/happier',
        cloneUrl: 'https://github.com/happier-dev/happier.git',
        sshUrl: 'git@github.com:happier-dev/happier.git',
        visibility: 'public',
        defaultBranch: 'main',
      },
      snapshot: {
        projectKey: 'git:/Users/example/Code/happier',
        fetchedAt: 1,
        repo: {
          isRepo: true,
          backendId: 'git',
          mode: '.git',
          rootPath: '/Users/example/Code/happier',
          remotes: [],
        },
        branch: {
          head: 'main',
          upstream: null,
          ahead: 0,
          behind: 0,
          detached: false,
        },
        capabilities: protocol.createScmCapabilities(),
        hasConflicts: false,
        entries: [],
        totals: {
          includedFiles: 0,
          pendingFiles: 0,
          untrackedFiles: 0,
          includedAdded: 0,
          includedRemoved: 0,
          pendingAdded: 0,
          pendingRemoved: 0,
        },
      },
    });

    expect(response.success).toBe(true);
    if (response.success) {
      expect(response.cloneProtocol).toBe('https');
      expect(response.snapshot?.repo.rootPath).toBe('/Users/example/Code/happier');
    }
  });
});
