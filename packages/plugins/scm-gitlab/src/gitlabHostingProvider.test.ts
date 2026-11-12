import { describe, expect, it, vi } from 'vitest';
import type { HostingProviderRuntimeRegistration, ScmHostingProviderRef } from '@happier-dev/plugin-sdk/scm/hosting';
import { ingestPluginManifestV2 } from '@happier-dev/protocol';

import { createGitlabScmHostingProviderAdapter, gitlabHostingProviderAdapter } from './adapter.js';
import { PLUGIN_MANIFEST } from './manifest.js';
import { gitlabRestPullRequestAdapter } from './pullRequests/index.js';

type DetectionResult = Readonly<{
  id: string;
  kind: string;
  displayName: string;
  baseUrl: string;
  nameWithOwner?: string;
  remoteName?: string | null;
  urlSafety?: Readonly<{
    allowedSchemes: readonly string[];
    allowedBaseUrls: readonly string[];
    allowedOrigins: readonly string[];
  }>;
}>;

type Adapter = Readonly<{
  detectRemote(input: Readonly<{
    remoteName: string | null;
    remoteUrl: string;
    connectedAccountBases?: readonly string[];
  }>): DetectionResult | null;
  buildCompareUrl(input: Readonly<{
    provider: DetectionResult;
    base: string;
    head: string;
    connectedAccountBases?: readonly string[];
  }>): string | null;
}>;

describe('bundled GitLab SCM hosting provider plugin', () => {
  it('creates drafts through the bound Connected Account at the exact deployment, without ambient CLI credentials', async () => {
    const { activate } = await import('./activate.js');
    let registration: HostingProviderRuntimeRegistration | undefined;
    // The plugin host registration is the real external boundary under test.
    activate({
      scm: { registerHostingProvider(_id: string, value: HostingProviderRuntimeRegistration) { registration = value; return { dispose() {} }; } },
      connectedAccounts: { register() { return { dispose() {} }; } },
      actions: { register() {} },
    } as unknown as Parameters<typeof activate>[0]);
    const provider: ScmHostingProviderRef = {
      id: 'happier.scm.forge.gitlab/gitlab', kind: 'gitlab', displayName: 'GitLab',
      baseUrl: 'https://code.internal.test:8443/GitLab', nameWithOwner: 'platform/app',
      urlSafety: { allowedSchemes: ['https:'] },
    };
    const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({
      iid: 11, title: 'Draft: Review', web_url: `${provider.baseUrl}/platform/app/-/merge_requests/11`,
      source_branch: 'feature', target_branch: 'main', state: 'opened', source_project_id: 1, target_project_id: 1,
    }), { status: 201 }));
    vi.stubGlobal('fetch', fetcher);
    const executeCommand = vi.fn(async () => ({ ok: true, stdout: '[]', stderr: '', exitCode: 0 }));
    const resolveScmHostingTokenMaterialization = vi.fn(async () => ({ kind: 'available' as const, token: 'test-bound-token' }));
    try {
      const adapter = registration?.adapter?.pullRequests;
      if (!adapter) throw new Error('The active provider must register a pull-request capability');
      await expect(adapter.createPullRequest({
        provider, head: 'feature', base: 'main', title: 'Review', body: '', draft: true,
        runtimeServices: { executeCommand, resolveScmHostingTokenMaterialization },
      })).resolves.toMatchObject({ number: 11, headBranch: 'feature', baseBranch: 'main' });
      expect(executeCommand).not.toHaveBeenCalled();
      expect(resolveScmHostingTokenMaterialization).toHaveBeenCalledWith(expect.objectContaining({
        providerId: provider.id, host: 'code.internal.test:8443', provider,
      }), expect.anything());
      expect(fetcher).toHaveBeenCalledWith(
        `${provider.baseUrl}/api/v4/projects/platform%2Fapp/merge_requests`,
        expect.objectContaining({ method: 'POST', headers: expect.objectContaining({ Authorization: 'Bearer test-bound-token' }), redirect: 'error' }),
      );
      const request = fetcher.mock.calls[0]?.[1] as RequestInit | undefined;
      expect(request?.body && JSON.parse(new TextDecoder().decode(request.body as Uint8Array)))
        .toEqual({ source_branch: 'feature', target_branch: 'main', title: 'Draft: Review', description: '' });
    } finally { vi.unstubAllGlobals(); }
  });

  it('declares a strict target SCM hosting-provider contribution with configured-origin access', async () => {
    expect(PLUGIN_MANIFEST).toMatchObject({
      id: 'happier.scm.forge.gitlab',
      entrypoints: { daemon: './.happier-plugin-build/daemon.js' },
      hostAccess: { required: expect.arrayContaining([
        expect.objectContaining({ id: 'gitlab-cloud-api', capability: 'network', scope: expect.objectContaining({ targets: [{ kind: 'fixedOrigin', origin: 'https://gitlab.com' }] }) }),
        expect.objectContaining({ id: 'gitlab-account-api', capability: 'network', scope: expect.objectContaining({ targets: [{ kind: 'connectedAccountOrigin', service: 'gitlab-account' }], privateNetwork: true }) }),
      ]), optional: [] },
      contributes: {
        scmHostingProviders: [
          {
            id: 'gitlab',
            kind: 'gitlab',
            title: 'GitLab',
            capabilities: expect.arrayContaining(['detect', 'pullRequest']),
          },
        ],
      },
    });
    expect(PLUGIN_MANIFEST).not.toHaveProperty('source');
    expect(PLUGIN_MANIFEST).not.toHaveProperty('uses');
    expect(PLUGIN_MANIFEST).not.toHaveProperty('permissions');
    expect(PLUGIN_MANIFEST).not.toHaveProperty('activationEvents');
    expect(ingestPluginManifestV2(PLUGIN_MANIFEST)).toMatchObject({ ok: true });
  });

  it('registers exactly what the manifest declares, and nothing else', async () => {
    const { activate } = await import('./activate.js');
    const registrations: Array<Readonly<{ id: string }>> = [];
    const accountRuntimes: string[] = [];
    const actionIds: string[] = [];
    // Boundary fixture intentionally supplies only the activation surface exercised here.
    activate({
      scm: {
        registerHostingProvider(id: string) {
          registrations.push({ id });
          return { dispose() {} };
        },
      },
      connectedAccounts: {
        register(id: string) {
          accountRuntimes.push(id);
          return { dispose() {} };
        },
      },
      actions: {
        register(id: string) {
          actionIds.push(id);
        },
      },
    } as unknown as Parameters<typeof activate>[0]);
    expect(registrations.map(({ id }) => id)).toEqual(PLUGIN_MANIFEST.contributes.scmHostingProviders.map(({ id }) => id));
    expect(accountRuntimes).toEqual(PLUGIN_MANIFEST.contributes.connectedAccountDescriptors.map(({ id }) => id));
    // Account/daemon parity is exercised through both activations in activate.test.ts.
    expect([...actionIds].sort()).toEqual(PLUGIN_MANIFEST.contributes.actions
      .filter((action) => action.execution?.target !== 'account')
      .map(({ id }) => id).sort());
  });

  it('detects bundled GitLab remotes and supports enterprise hosts through test-local options', async () => {
    const adapter = gitlabHostingProviderAdapter as Adapter;
    const enterpriseAdapter = createGitlabScmHostingProviderAdapter({
      exactHosts: ['gitlab.company.com', 'code.internal.test'],
    }) as Adapter;

    expect(adapter.detectRemote({
      remoteName: 'origin',
      remoteUrl: 'git@gitlab.com:happier-dev/mobile/app.git',
    })).toMatchObject({
      id: 'happier.scm.forge.gitlab/gitlab',
      kind: 'gitlab',
      baseUrl: 'https://gitlab.com',
      nameWithOwner: 'happier-dev/mobile/app',
      remoteName: 'origin',
    });
    expect(enterpriseAdapter.detectRemote({
      remoteName: 'origin',
      remoteUrl: 'https://gitlab.company.com/platform/happier/app.git',
    })).toMatchObject({
      id: 'happier.scm.forge.gitlab/gitlab',
      baseUrl: 'https://gitlab.company.com',
      nameWithOwner: 'platform/happier/app',
    });
    expect(enterpriseAdapter.detectRemote({
      remoteName: 'origin',
      remoteUrl: 'ssh://git@code.internal.test/platform/happier/app.git',
    })).toMatchObject({
      id: 'happier.scm.forge.gitlab/gitlab',
      baseUrl: 'https://code.internal.test',
      nameWithOwner: 'platform/happier/app',
      urlSafety: {
        allowedSchemes: ['https:'],
        allowedBaseUrls: ['https://code.internal.test'],
        allowedOrigins: ['https://code.internal.test'],
      },
    });
    expect(adapter.detectRemote({
      remoteName: 'origin',
      remoteUrl: 'ftp://gitlab.com/happier-dev/mobile/app.git',
    })).toBeNull();
    expect(adapter.detectRemote({
      remoteName: 'origin',
      remoteUrl: 'file:///gitlab.com/happier-dev/mobile/app.git',
    })).toBeNull();
  });

  describe('configured self-managed deployments', () => {
    const adapter = gitlabHostingProviderAdapter as Adapter;

    it('recognizes a configured deployment on the default port and keeps its exact base', () => {
      expect(adapter.detectRemote({
        remoteName: 'origin',
        remoteUrl: 'https://gitlab.example.test/platform/mobile/app.git',
        connectedAccountBases: ['https://gitlab.example.test'],
      })).toMatchObject({
        id: 'happier.scm.forge.gitlab/gitlab',
        kind: 'gitlab',
        baseUrl: 'https://gitlab.example.test',
        nameWithOwner: 'platform/mobile/app',
        repositoryWebUrl: 'https://gitlab.example.test/platform/mobile/app',
        remoteName: 'origin',
      });
    });

    it('recognizes a configured deployment on a custom port without folding the port into the host', () => {
      expect(adapter.detectRemote({
        remoteName: 'origin',
        remoteUrl: 'https://gitlab.example.test:8443/platform/app.git',
        connectedAccountBases: ['https://gitlab.example.test:8443'],
      })).toMatchObject({
        baseUrl: 'https://gitlab.example.test:8443',
        nameWithOwner: 'platform/app',
        urlSafety: {
          allowedBaseUrls: ['https://gitlab.example.test:8443'],
          allowedOrigins: ['https://gitlab.example.test:8443'],
        },
      });
    });

    it('recognizes a configured deployment behind a path prefix and excludes the prefix from the repository', () => {
      expect(adapter.detectRemote({
        remoteName: 'origin',
        remoteUrl: 'https://code.internal.test/GitLab/platform/mobile/app.git',
        connectedAccountBases: ['https://code.internal.test/GitLab'],
      })).toMatchObject({
        baseUrl: 'https://code.internal.test/GitLab',
        nameWithOwner: 'platform/mobile/app',
        repositoryWebUrl: 'https://code.internal.test/GitLab/platform/mobile/app',
      });
    });

    it('keeps two deployments mounted under one host apart by their configured prefixes', () => {
      expect(adapter.detectRemote({
        remoteName: 'origin',
        remoteUrl: 'https://code.internal.test/beta/platform/app.git',
        connectedAccountBases: ['https://code.internal.test/alpha', 'https://code.internal.test/beta'],
      })).toMatchObject({
        baseUrl: 'https://code.internal.test/beta',
        nameWithOwner: 'platform/app',
      });
    });

    it('recognizes the same deployment reached over ssh and scp syntax', () => {
      expect(adapter.detectRemote({
        remoteName: 'origin',
        remoteUrl: 'ssh://git@gitlab.example.test:22/platform/app.git',
        connectedAccountBases: ['https://gitlab.example.test'],
      })).toMatchObject({ baseUrl: 'https://gitlab.example.test', nameWithOwner: 'platform/app' });
      expect(adapter.detectRemote({
        remoteName: 'origin',
        remoteUrl: 'git@gitlab.example.test:platform/app.git',
        connectedAccountBases: ['https://gitlab.example.test'],
      })).toMatchObject({ baseUrl: 'https://gitlab.example.test', nameWithOwner: 'platform/app' });
    });

    it('never matches a remote whose port or deployment differs from every configured base', () => {
      expect(adapter.detectRemote({
        remoteName: 'origin',
        remoteUrl: 'https://gitlab.example.test:9443/platform/app.git',
        connectedAccountBases: ['https://gitlab.example.test:8443'],
      })).toBeNull();
      expect(adapter.detectRemote({
        remoteName: 'origin',
        remoteUrl: 'https://gitlab.example.test/platform/app.git',
        connectedAccountBases: ['https://gitlab.example.test:8443'],
      })).toBeNull();
      expect(adapter.detectRemote({
        remoteName: 'origin',
        remoteUrl: 'https://other.example.test/platform/app.git',
        connectedAccountBases: ['https://gitlab.example.test'],
      })).toBeNull();
      expect(adapter.detectRemote({
        remoteName: 'origin',
        remoteUrl: 'https://code.internal.test/other/platform/app.git',
        connectedAccountBases: ['https://code.internal.test/GitLab'],
      })).toBeNull();
    });

    it('leaves GitLab.com recognition unchanged and does not widen it through a configured base', () => {
      expect(adapter.detectRemote({
        remoteName: 'origin',
        remoteUrl: 'https://gitlab.com/happier-dev/app.git',
      })).toMatchObject({ baseUrl: 'https://gitlab.com', nameWithOwner: 'happier-dev/app' });
      expect(adapter.detectRemote({
        remoteName: 'origin',
        remoteUrl: 'https://gitlab.com:8443/happier-dev/app.git',
        connectedAccountBases: ['https://gitlab.com'],
      })).toBeNull();
    });

    it('builds a compare URL for a configured deployment only when the base is the configured one', () => {
      const provider = adapter.detectRemote({
        remoteName: 'origin',
        remoteUrl: 'https://gitlab.example.test:8443/platform/app.git',
        connectedAccountBases: ['https://gitlab.example.test:8443'],
      });
      expect(provider).not.toBeNull();
      if (!provider) return;

      expect(adapter.buildCompareUrl({
        provider,
        base: 'main',
        head: 'feature/auth',
        connectedAccountBases: ['https://gitlab.example.test:8443'],
      })).toBe('https://gitlab.example.test:8443/platform/app/-/compare/main...feature%2Fauth');
      expect(adapter.buildCompareUrl({
        provider,
        base: 'main',
        head: 'feature/auth',
        connectedAccountBases: ['https://gitlab.example.test:9443'],
      })).toBeNull();
      expect(adapter.buildCompareUrl({ provider, base: 'main', head: 'feature/auth' })).toBeNull();
    });
  });

  it('builds encoded GitLab compare URLs without write or CLI behavior', async () => {
    const adapter = gitlabHostingProviderAdapter as Adapter & Record<string, unknown>;
    const enterpriseAdapter = createGitlabScmHostingProviderAdapter({
      exactHosts: ['code.internal.test'],
    }) as Adapter;
    const provider = adapter.detectRemote({
      remoteName: 'origin',
      remoteUrl: 'git@gitlab.com:happier-dev/mobile/app.git',
    });

    expect(provider).not.toBeNull();
    if (!provider) return;

    expect(adapter.buildCompareUrl({
      provider,
      base: 'release/2026',
      head: 'feature/pr-support',
    })).toBe('https://gitlab.com/happier-dev/mobile/app/-/compare/release%2F2026...feature%2Fpr-support');
    expect(enterpriseAdapter.buildCompareUrl({
      provider: {
        ...provider,
        baseUrl: 'https://code.internal.test/gitlab',
        nameWithOwner: 'platform/happier/app',
        repositoryWebUrl: 'https://code.internal.test/gitlab/platform/happier/app',
      },
      base: 'release/2026',
      head: 'feature/pr-support',
    })).toBe('https://code.internal.test/gitlab/platform/happier/app/-/compare/release%2F2026...feature%2Fpr-support');
    expect(adapter.buildCompareUrl({
      provider: {
        ...provider,
        baseUrl: 'https://example.com',
      },
      base: 'main',
      head: 'feature/pr-support',
    })).toBeNull();
    expect(adapter.buildCompareUrl({
      provider: {
        ...provider,
        baseUrl: 'https://gitlab.com:8443',
      },
      base: 'main',
      head: 'feature/pr-support',
    })).toBeNull();
    expect(adapter.buildCompareUrl({
      provider: {
        ...provider,
        nameWithOwner: 'platform/../app',
      },
      base: 'main',
      head: 'feature/pr-support',
    })).toBeNull();
    expect(adapter[`create${'PullRequest'}`]).toBeUndefined();
    expect(adapter[`list${'PullRequests'}`]).toBeUndefined();
    expect(adapter[`get${'PullRequest'}`]).toBeUndefined();
    expect(adapter[`get${'PullRequestAuthProfileKey'}`]).toBeUndefined();
    expect(gitlabRestPullRequestAdapter.createPullRequest).toEqual(expect.any(Function));
    expect(gitlabRestPullRequestAdapter.listPullRequests).toEqual(expect.any(Function));
    expect(gitlabRestPullRequestAdapter.getPullRequest).toEqual(expect.any(Function));
    expect(gitlabRestPullRequestAdapter.getPullRequestAuthProfileKey).toEqual(expect.any(Function));
  });
});
