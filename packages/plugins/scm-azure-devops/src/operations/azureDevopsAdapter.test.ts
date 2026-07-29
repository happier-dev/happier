import type {
  ScmHostingProviderRef,
  ScmPullRequestSummary,
} from '@happier-dev/plugin-sdk/experimental/scm';
import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/plugin-sdk/experimental/scm';
import type { ScmHostingProviderRuntimeServices } from '@happier-dev/plugin-sdk/experimental/scm';
import { describe, expect, it, vi } from 'vitest';

import { createAzureDevopsOperationsAdapter } from './azureDevopsAdapter.js';

const provider: ScmHostingProviderRef = {
  id: 'happier.scm.hosting.azure-devops/azure-devops',
  kind: 'azure-devops',
  displayName: 'Azure DevOps',
  baseUrl: 'https://dev.azure.com/happier-dev',
  nameWithOwner: 'happier-dev/platform/happier',
  urlSafety: {
    allowedSchemes: ['https:'],
    allowedBaseUrls: ['https://dev.azure.com/happier-dev'],
    allowedOrigins: ['https://dev.azure.com'],
  },
};

function createRuntimeServices(stdoutByCommand: Readonly<Record<string, unknown>>): ScmHostingProviderRuntimeServices {
  return {
    executeCommand: vi.fn(async ({ executable, args }) => {
      expect(executable).toEqual({ kind: 'systemTool', id: 'azure-cli' });
      const key = args.join(' ');
      const value = stdoutByCommand[key];
      if (value instanceof Error) {
        return {
          ok: false,
          stdout: '',
          stderr: value.message,
          exitCode: 1,
        };
      }
      return {
        ok: true,
        stdout: JSON.stringify(value ?? {}),
        stderr: '',
        exitCode: 0,
      };
    }),
  };
}

function createAzurePullRequest(overrides?: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return {
    pullRequestId: 42,
    title: 'Add Azure support',
    status: 'active',
    isDraft: false,
    sourceRefName: 'refs/heads/feature/azure',
    targetRefName: 'refs/heads/main',
    url: 'https://dev.azure.com/happier-dev/platform/_git/happier/pullrequest/42',
    _links: {
      web: {
        href: 'https://dev.azure.com/happier-dev/platform/_git/happier/pullrequest/42',
      },
    },
    createdBy: {
      uniqueName: 'dev@example.com',
      displayName: 'Dev User',
      url: 'https://dev.azure.com/happier-dev/_apis/Identities/dev-user',
    },
    repository: {
      name: 'happier',
      webUrl: 'https://dev.azure.com/happier-dev/platform/_git/happier',
      project: {
        name: 'platform',
      },
    },
    lastMergeSourceCommit: {
      commitId: 'source-sha',
    },
    lastMergeTargetCommit: {
      commitId: 'target-sha',
    },
    ...overrides,
  };
}

function getOpenOrReusePullRequest(adapter: ReturnType<typeof createAzureDevopsOperationsAdapter>) {
  const openOrReusePullRequest = (adapter as Partial<Readonly<{
    openOrReusePullRequest(input: Parameters<typeof adapter.createPullRequest>[0]): Promise<Readonly<{
      pullRequest: ScmPullRequestSummary;
      reused: boolean;
    }>>;
  }>>).openOrReusePullRequest;
  expect(openOrReusePullRequest).toBeTypeOf('function');
  return openOrReusePullRequest;
}

describe('Azure DevOps operations adapter', () => {
  it('lists valid Azure pull requests and skips malformed rows', async () => {
    const runtimeServices = createRuntimeServices({
      'repos pr list --organization https://dev.azure.com/happier-dev --project platform --repository happier --source-branch feature/azure --target-branch main --status active --output json': [
        createAzurePullRequest(),
        { pullRequestId: 99, title: '', sourceRefName: 'refs/heads/bad' },
      ],
    });
    const adapter = createAzureDevopsOperationsAdapter();

    await expect(adapter.listPullRequests({
      provider,
      base: 'main',
      head: 'feature/azure',
      state: 'open',
      runtimeServices,
    })).resolves.toEqual([
      expect.objectContaining({
        number: 42,
        title: 'Add Azure support',
        baseBranch: 'main',
        headBranch: 'feature/azure',
        headRepositoryNameWithOwner: 'happier-dev/platform/happier',
        state: 'open',
      }),
    ]);
  });

  it('skips Azure pull request rows with incomplete fork source repository metadata', async () => {
    const runtimeServices = createRuntimeServices({
      'repos pr list --organization https://dev.azure.com/happier-dev --project platform --repository happier --source-branch feature/azure --status active --output json': [
        createAzurePullRequest({
          forkSource: {
            repository: {
              name: 'forked-happier',
            },
          },
        }),
        createAzurePullRequest({ pullRequestId: 43 }),
      ],
    });
    const adapter = createAzureDevopsOperationsAdapter();

    await expect(adapter.listPullRequests({
      provider,
      head: 'feature/azure',
      state: 'open',
      runtimeServices,
    })).resolves.toEqual([
      expect.objectContaining({
        number: 43,
        headRepositoryNameWithOwner: 'happier-dev/platform/happier',
        isCrossRepository: false,
      }),
    ]);
  });

  it('maps complete Azure source repository metadata as cross-repository head context', async () => {
    const runtimeServices = createRuntimeServices({
      'repos pr list --organization https://dev.azure.com/happier-dev --project platform --repository happier --source-branch feature/azure --status active --output json': [
        createAzurePullRequest({
          sourceRepository: {
            name: 'forked-happier',
            project: {
              name: 'external-platform',
            },
          },
        }),
      ],
    });
    const adapter = createAzureDevopsOperationsAdapter();

    await expect(adapter.listPullRequests({
      provider,
      head: 'feature/azure',
      state: 'open',
      runtimeServices,
    })).resolves.toEqual([
      expect.objectContaining({
        number: 42,
        headRepositoryNameWithOwner: 'happier-dev/external-platform/forked-happier',
        isCrossRepository: true,
      }),
    ]);
  });

  it('creates a pull request with Azure route coordinates and maps the response', async () => {
    const runtimeServices = createRuntimeServices({
      'repos pr create --organization https://dev.azure.com/happier-dev --project platform --repository happier --source-branch feature/azure --target-branch main --title Add Azure support --description Body --draft false --output json': createAzurePullRequest(),
    });
    const adapter = createAzureDevopsOperationsAdapter();

    await expect(adapter.createPullRequest({
      provider,
      base: 'main',
      head: 'feature/azure',
      title: 'Add Azure support',
      body: 'Body',
      draft: false,
      runtimeServices,
    })).resolves.toMatchObject({
      number: 42,
      baseBranch: 'main',
      headBranch: 'feature/azure',
      headRepositoryNameWithOwner: 'happier-dev/platform/happier',
    });
  });

  it('rejects unsupported Azure provider coordinates before invoking az', async () => {
    const executeCommand = vi.fn();
    const adapter = createAzureDevopsOperationsAdapter();

    await expect(adapter.listPullRequests({
      provider: {
        ...provider,
        baseUrl: 'https://dev.azure.com/happier-dev/extra',
      },
      head: 'feature/azure',
      runtimeServices: {
        executeCommand,
      },
    })).rejects.toMatchObject({
      errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
    });
    expect(executeCommand).not.toHaveBeenCalled();
  });

  it('surfaces missing Azure CLI as auth remediation without generic shellout', async () => {
    const adapter = createAzureDevopsOperationsAdapter();

    await expect(adapter.listPullRequests({
      provider,
      head: 'feature/azure',
      runtimeServices: {},
    })).rejects.toMatchObject({
      errorCode: SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED,
    });
  });

  it('reports Azure CLI install remediation when publish-target discovery cannot resolve az', async () => {
    const adapter = createAzureDevopsOperationsAdapter();

    await expect(adapter.describePublishTargets({
      provider,
      defaultRepositoryName: 'next-repo',
      runtimeServices: {},
    })).resolves.toMatchObject({
      auth: {
        state: 'unsupported',
        profileKind: 'provider_cli',
        remediation: {
          kind: 'install_required',
          url: expect.stringContaining('learn.microsoft.com'),
        },
      },
      targets: [
        expect.objectContaining({
          auth: expect.objectContaining({
            state: 'unsupported',
          }),
        }),
      ],
    });
  });

  it('describes Azure repository publish targets and creates repositories inside the provider project', async () => {
    const runtimeServices = createRuntimeServices({
      'repos create --organization https://dev.azure.com/happier-dev --project platform --name next-repo --output json': {
        name: 'next-repo',
        webUrl: 'https://dev.azure.com/happier-dev/platform/_git/next-repo',
        remoteUrl: 'https://happier-dev@dev.azure.com/happier-dev/platform/_git/next-repo',
        sshUrl: 'git@ssh.dev.azure.com:v3/happier-dev/platform/next-repo',
        defaultBranch: 'refs/heads/main',
      },
    });
    const adapter = createAzureDevopsOperationsAdapter();

    await expect(adapter.describePublishTargets({
      provider,
      defaultRepositoryName: 'next-repo',
      runtimeServices,
    })).resolves.toMatchObject({
      auth: {
        state: 'authenticated',
        profileKind: 'provider_cli',
      },
      targets: [
        expect.objectContaining({
          owner: 'happier-dev/platform',
          ownerKind: 'org',
          supportedRemoteUrlKinds: ['https', 'ssh'],
        }),
      ],
    });

    await expect(adapter.createRepository({
      provider,
      owner: 'happier-dev/platform',
      ownerKind: 'org',
      repositoryName: 'next-repo',
      visibility: 'private',
      runtimeServices,
    })).resolves.toMatchObject({
      nameWithOwner: 'happier-dev/platform/next-repo',
      webUrl: 'https://dev.azure.com/happier-dev/platform/_git/next-repo',
      cloneUrl: 'https://happier-dev@dev.azure.com/happier-dev/platform/_git/next-repo',
      sshUrl: 'git@ssh.dev.azure.com:v3/happier-dev/platform/next-repo',
      defaultBranch: 'main',
    });
  });

  it('requires fetched duplicate hints to preserve Azure branch-head coordinates', async () => {
    const duplicate = createAzurePullRequest({
      pullRequestId: 7,
      sourceRefName: 'refs/heads/other-branch',
      _links: {
        web: {
          href: 'https://dev.azure.com/happier-dev/platform/_git/happier/pullrequest/7',
        },
      },
    });
    const runtimeServices = createRuntimeServices({
      'repos pr show --organization https://dev.azure.com/happier-dev --project platform --repository happier --id 7 --output json': duplicate,
    });
    const adapter = createAzureDevopsOperationsAdapter();

    const fetched = await adapter.getPullRequest({
      provider,
      reference: {
        url: 'https://dev.azure.com/happier-dev/platform/_git/happier/pullrequest/7',
      },
      runtimeServices,
    }) as ScmPullRequestSummary;

    expect(fetched.headBranch).toBe('other-branch');
    expect(fetched.headRepositoryNameWithOwner).toBe('happier-dev/platform/happier');
  });

  it('reuses duplicate pull requests only after Azure branch-head context validation', async () => {
    const wrongHint = createAzurePullRequest({
      pullRequestId: 7,
      sourceRefName: 'refs/heads/other-branch',
    });
    const validExisting = createAzurePullRequest({ pullRequestId: 42 });
    const runtimeServices = createRuntimeServices({
      'repos pr list --organization https://dev.azure.com/happier-dev --project platform --repository happier --source-branch feature/azure --target-branch main --status active --output json': [],
      'repos pr create --organization https://dev.azure.com/happier-dev --project platform --repository happier --source-branch feature/azure --target-branch main --title Add Azure support --description Body --draft false --output json': new Error('TF401179: An active pull request already exists: https://dev.azure.com/happier-dev/platform/_git/happier/pullrequest/7'),
      'repos pr show --organization https://dev.azure.com/happier-dev --project platform --repository happier --id 7 --output json': wrongHint,
      'repos pr list --organization https://dev.azure.com/happier-dev --project platform --repository happier --source-branch feature/azure --target-branch main --status active --output json#2': [validExisting],
    });
    const executeCommand = runtimeServices.executeCommand as ReturnType<typeof vi.fn>;
    executeCommand.mockImplementation(async ({ args }) => {
      const key = args.join(' ');
      const callCount = executeCommand.mock.calls.filter(([call]) => call.args.join(' ') === key).length;
      const value = (key.endsWith('--status active --output json') && callCount > 1)
        ? [validExisting]
        : ({
          'repos pr list --organization https://dev.azure.com/happier-dev --project platform --repository happier --source-branch feature/azure --target-branch main --status active --output json': [],
          'repos pr create --organization https://dev.azure.com/happier-dev --project platform --repository happier --source-branch feature/azure --target-branch main --title Add Azure support --description Body --draft false --output json': new Error('TF401179: An active pull request already exists: https://dev.azure.com/happier-dev/platform/_git/happier/pullrequest/7'),
          'repos pr show --organization https://dev.azure.com/happier-dev --project platform --repository happier --id 7 --output json': wrongHint,
        } as Readonly<Record<string, unknown>>)[key];
      if (value instanceof Error) {
        return { ok: false, stdout: '', stderr: value.message, exitCode: 1 };
      }
      return { ok: true, stdout: JSON.stringify(value ?? {}), stderr: '', exitCode: 0 };
    });
    const adapter = createAzureDevopsOperationsAdapter();
    const openOrReusePullRequest = getOpenOrReusePullRequest(adapter);
    await expect(openOrReusePullRequest?.({
      provider,
      base: 'main',
      head: 'feature/azure',
      title: 'Add Azure support',
      body: 'Body',
      draft: false,
      runtimeServices,
    })).resolves.toMatchObject({
      reused: true,
      pullRequest: expect.objectContaining({
        number: 42,
        headBranch: 'feature/azure',
      }),
    });
  });

  it('reuses exact duplicate hints without a second Azure list lookup', async () => {
    const hintedExisting = createAzurePullRequest({ pullRequestId: 7 });
    const duplicate = new Error(
      'TF401179: An active pull request already exists: https://dev.azure.com/happier-dev/platform/_git/happier/pullrequest/7',
    );
    const listKey = 'repos pr list --organization https://dev.azure.com/happier-dev --project platform --repository happier --source-branch feature/azure --target-branch main --status active --output json';
    const runtimeServices = createRuntimeServices({
      [listKey]: [],
      'repos pr create --organization https://dev.azure.com/happier-dev --project platform --repository happier --source-branch feature/azure --target-branch main --title Add Azure support --description Body --draft false --output json': duplicate,
      'repos pr show --organization https://dev.azure.com/happier-dev --project platform --repository happier --id 7 --output json': hintedExisting,
    });
    const adapter = createAzureDevopsOperationsAdapter();
    const openOrReusePullRequest = getOpenOrReusePullRequest(adapter);

    await expect(openOrReusePullRequest?.({
      provider,
      base: 'main',
      head: 'feature/azure',
      title: 'Add Azure support',
      body: 'Body',
      draft: false,
      runtimeServices,
    })).resolves.toMatchObject({
      reused: true,
      pullRequest: expect.objectContaining({
        number: 7,
        headBranch: 'feature/azure',
        headRepositoryNameWithOwner: 'happier-dev/platform/happier',
      }),
    });
    const executeCommand = runtimeServices.executeCommand as ReturnType<typeof vi.fn>;
    expect(executeCommand.mock.calls.filter(([call]) => call.args.join(' ') === listKey)).toHaveLength(1);
  });

  it('does not reuse duplicate hints with incomplete cross-repository metadata', async () => {
    const incompleteHint = createAzurePullRequest({
      pullRequestId: 7,
      sourceRepository: {
        name: 'forked-happier',
      },
    });
    const validExisting = createAzurePullRequest({ pullRequestId: 42 });
    const listKey = 'repos pr list --organization https://dev.azure.com/happier-dev --project platform --repository happier --source-branch feature/azure --target-branch main --status active --output json';
    const createKey = 'repos pr create --organization https://dev.azure.com/happier-dev --project platform --repository happier --source-branch feature/azure --target-branch main --title Add Azure support --description Body --draft false --output json';
    const showKey = 'repos pr show --organization https://dev.azure.com/happier-dev --project platform --repository happier --id 7 --output json';
    const runtimeServices = createRuntimeServices({});
    const executeCommand = runtimeServices.executeCommand as ReturnType<typeof vi.fn>;
    executeCommand.mockImplementation(async ({ args }) => {
      const key = args.join(' ');
      const callCount = executeCommand.mock.calls.filter(([call]) => call.args.join(' ') === key).length;
      const value = key === listKey && callCount > 1
        ? [validExisting]
        : ({
          [listKey]: [],
          [createKey]: new Error('TF401179: An active pull request already exists: https://dev.azure.com/happier-dev/platform/_git/happier/pullrequest/7'),
          [showKey]: incompleteHint,
        } as Readonly<Record<string, unknown>>)[key];
      if (value instanceof Error) {
        return { ok: false, stdout: '', stderr: value.message, exitCode: 1 };
      }
      return { ok: true, stdout: JSON.stringify(value ?? {}), stderr: '', exitCode: 0 };
    });
    const adapter = createAzureDevopsOperationsAdapter();
    const openOrReusePullRequest = getOpenOrReusePullRequest(adapter);

    await expect(openOrReusePullRequest?.({
      provider,
      base: 'main',
      head: 'feature/azure',
      title: 'Add Azure support',
      body: 'Body',
      draft: false,
      runtimeServices,
    })).resolves.toMatchObject({
      reused: true,
      pullRequest: expect.objectContaining({
        number: 42,
        headRepositoryNameWithOwner: 'happier-dev/platform/happier',
      }),
    });
    expect(executeCommand.mock.calls.filter(([call]) => call.args.join(' ') === listKey)).toHaveLength(2);
  });
});
