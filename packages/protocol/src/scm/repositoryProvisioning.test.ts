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

describe('SCM repository provisioning protocol contracts', () => {
  it('keeps repository init requests on the cwd convention', () => {
    const parsed = readProtocolSchema<protocol.ScmRepositoryInitRequest>(
      'ScmRepositoryInitRequestSchema',
    ).parse({
      cwd: '/repo',
      initialBranch: 'main',
    });

    expect(parsed.cwd).toBe('/repo');
    expect(parsed.initialBranch).toBe('main');
    expect('workingDirectory' in parsed).toBe(false);
  });

  it('requires explicit confirmation for index-lock removal without accepting lock paths', () => {
    const requestSchema = readProtocolSchema('ScmRepositoryRemoveIndexLockRequestSchema');
    const responseSchema = readProtocolSchema<protocol.ScmRepositoryRemoveIndexLockResponse>(
      'ScmRepositoryRemoveIndexLockResponseSchema',
    );

    expect(requestSchema.safeParse({
      cwd: '/repo',
      confirmed: true,
      confirmationToken: 'remove-stale-index-lock',
      lockPath: '/repo/.git/index.lock',
    }).success).toBe(false);
    expect(requestSchema.safeParse({
      cwd: '/repo',
      confirmed: true,
      confirmationToken: 'remove-stale-index-lock',
      indexLockPath: '/repo/.git/index.lock',
    }).success).toBe(false);
    // Strict: any other unknown caller-supplied path field is rejected
    // (defense in depth for the path-resolution boundary).
    expect(requestSchema.safeParse({
      cwd: '/repo',
      confirmed: true,
      confirmationToken: 'remove-stale-index-lock',
      gitDir: '/repo/.git',
    }).success).toBe(false);
    // Confirmation token must be the pinned literal; arbitrary tokens are rejected.
    expect(requestSchema.safeParse({
      cwd: '/repo',
      confirmed: true,
      confirmationToken: 'arbitrary-string',
    }).success).toBe(false);

    const parsedRequest = requestSchema.parse({
      cwd: '/repo',
      confirmed: true,
      confirmationToken: 'remove-stale-index-lock',
    });
    expect(parsedRequest).toMatchObject({
      cwd: '/repo',
      confirmed: true,
      confirmationToken: 'remove-stale-index-lock',
    });

    const parsedResponse = responseSchema.parse({
      success: true,
      removed: false,
      lockPath: null,
      reason: 'absent',
    });
    expect(parsedResponse).toMatchObject({
      success: true,
      removed: false,
      lockPath: null,
      reason: 'absent',
    });
  });

  it('parses hosting repository target discovery without GitHub-only auth vocabulary', () => {
    const requestSchema = readProtocolSchema<protocol.ScmHostingRepositoryDescribePublishTargetsRequest>(
      'ScmHostingRepositoryDescribePublishTargetsRequestSchema',
    );
    const schema = readProtocolSchema<protocol.ScmHostingRepositoryDescribePublishTargetsResponse>(
      'ScmHostingRepositoryDescribePublishTargetsResponseSchema',
    );

    expect(requestSchema.parse({
      cwd: '/repo',
      providerId: 'scm.github.enterprise',
      providerKind: 'github',
    })).toMatchObject({
      providerId: 'scm.github.enterprise',
      providerKind: 'github',
    });

    const parsed = schema.parse({
      success: true,
      auth: {
        state: 'authenticated',
        profileKind: 'connected_account',
        profileKey: 'github:account-1',
      },
      defaultRepositoryName: 'happier',
      targets: [
        {
          provider: {
            id: 'github:github.com',
            kind: 'github',
            displayName: 'GitHub',
            baseUrl: 'https://github.com',
          },
          owner: 'happier-dev',
          ownerKind: 'org',
          label: 'happier-dev',
          isDefault: true,
          supportedVisibilities: ['private', 'public'],
          supportedRemoteUrlKinds: ['https', 'ssh'],
        },
      ],
    });

    expect(parsed.auth.profileKind).toBe('connected_account');
    expect(parsed.targets[0]?.provider.kind).toBe('github');
    expect(parsed.targets[0]?.supportedRemoteUrlKinds).toEqual(['https', 'ssh']);
  });

  it('parses publish success and structured failure paths', () => {
    const requestSchema = readProtocolSchema<protocol.ScmHostingRepositoryPublishRequest>(
      'ScmHostingRepositoryPublishRequestSchema',
    );
    const responseSchema = readProtocolSchema<protocol.ScmHostingRepositoryPublishResponse>(
      'ScmHostingRepositoryPublishResponseSchema',
    );

    const request = requestSchema.parse({
      cwd: '/repo',
      providerId: 'scm.github',
      providerKind: 'github',
      owner: 'happier-dev',
      ownerKind: 'org',
      repositoryName: 'happier',
      visibility: 'private',
      remoteName: 'origin',
      remoteUrlKind: 'https',
      remoteConflictStrategy: 'set-url',
      pushCurrentBranch: false,
    });
    expect(request).toMatchObject({
      cwd: '/repo',
      providerId: 'scm.github',
      providerKind: 'github',
      remoteConflictStrategy: 'set-url',
      pushCurrentBranch: false,
    });
    expect('workingDirectory' in request).toBe(false);

    const success = responseSchema.parse({
      success: true,
      repository: {
        provider: {
          id: 'github:github.com:happier-dev/happier',
          kind: 'github',
          displayName: 'GitHub',
          baseUrl: 'https://github.com',
        },
        nameWithOwner: 'happier-dev/happier',
        webUrl: 'https://github.com/happier-dev/happier',
        cloneUrl: 'https://github.com/happier-dev/happier.git',
        sshUrl: 'git@github.com:happier-dev/happier.git',
        visibility: 'private',
        defaultBranch: 'main',
      },
      remote: {
        name: 'origin',
        fetchUrl: 'https://github.com/happier-dev/happier.git',
      },
      pushed: false,
    });
    expect(success.success).toBe(true);
    if (success.success) {
      expect(success.pushed).toBe(false);
    }

    const commitRequired = responseSchema.parse({
      success: false,
      error: 'Commit required before pushing',
      errorCode: protocol.SCM_OPERATION_ERROR_CODES.COMMIT_REQUIRED,
      remediation: {
        kind: 'commit_required',
      },
    });
    expect(commitRequired.success).toBe(false);
    if (!commitRequired.success) {
      expect(commitRequired.errorCode).toBe(protocol.SCM_OPERATION_ERROR_CODES.COMMIT_REQUIRED);
      expect(commitRequired.remediation?.kind).toBe('commit_required');
    }
  });

  it('normalizes and validates publish remote names with the shared SCM ref guards', () => {
    const requestSchema = readProtocolSchema<protocol.ScmHostingRepositoryPublishRequest>(
      'ScmHostingRepositoryPublishRequestSchema',
    );

    expect(requestSchema.parse({
      cwd: '/repo',
      providerKind: 'github',
      owner: 'happier-dev',
      repositoryName: 'happier',
      visibility: 'private',
      remoteName: ' origin ',
    }).remoteName).toBe('origin');

    expect(requestSchema.safeParse({
      cwd: '/repo',
      providerKind: 'github',
      owner: 'happier-dev',
      repositoryName: 'happier',
      visibility: 'private',
      remoteName: 'origin\n--upload-pack=evil',
    }).success).toBe(false);

    expect(requestSchema.safeParse({
      cwd: '/repo',
      providerKind: 'github',
      owner: 'happier-dev',
      repositoryName: 'happier',
      visibility: 'private',
      remoteName: 'origin/team',
    }).success).toBe(false);
  });
});
