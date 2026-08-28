import { describe, expect, it } from 'vitest';
import { ingestPluginManifestV2 } from '@happier-dev/protocol';

import { createGitlabScmHostingProviderAdapter, gitlabHostingProviderAdapter } from './adapter.js';
import { PLUGIN_MANIFEST } from './manifest.js';
import { gitlabCliPullRequestAdapter } from './pullRequests/index.js';

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
  detectRemote(input: Readonly<{ remoteName: string | null; remoteUrl: string }>): DetectionResult | null;
  buildCompareUrl(input: Readonly<{ provider: DetectionResult; base: string; head: string }>): string | null;
}>;

describe('bundled GitLab SCM hosting provider plugin', () => {
  it('declares a strict target SCM hosting-provider contribution with configured-origin access', async () => {
    expect(PLUGIN_MANIFEST).toMatchObject({
      id: 'happier.scm.forge.gitlab',
      entrypoints: { daemon: './.happier-plugin/daemon.js' },
      hostAccess: { required: expect.arrayContaining([
        expect.objectContaining({ id: 'gitlab-api', capability: 'network', scope: expect.objectContaining({ targets: expect.arrayContaining([{ kind: 'scmProviderOrigin', provider: 'gitlab' }]) }) }),
        expect.objectContaining({ id: 'gitlab-cli-process', capability: 'process', scope: { executables: [{ kind: 'systemTool', id: 'gitlab-cli' }] } }),
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
        systemTools: [{ id: 'gitlab-cli', executableNames: ['glab'] }],
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
    // Every declared Action has a registered handler, and no handler is
    // registered for an Action the manifest never declared.
    expect([...actionIds].sort()).toEqual(PLUGIN_MANIFEST.contributes.actions.map(({ id }) => id).sort());
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
    expect(gitlabCliPullRequestAdapter.createPullRequest).toEqual(expect.any(Function));
    expect(gitlabCliPullRequestAdapter.listPullRequests).toEqual(expect.any(Function));
    expect(gitlabCliPullRequestAdapter.getPullRequest).toEqual(expect.any(Function));
    expect(gitlabCliPullRequestAdapter.getPullRequestAuthProfileKey).toEqual(expect.any(Function));
  });
});
