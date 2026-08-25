import { describe, expect, it } from 'vitest';
import { ingestPluginManifestV2 } from '@happier-dev/protocol';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';

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

describe('bundled Azure DevOps SCM hosting provider plugin', () => {
  it('declares a strict target SCM hosting-provider contribution with configured-origin access', async () => {
    const mod = await import('./manifest.js').catch(() => null);
    expect(mod).not.toBeNull();
    if (!mod) return;

    expect(mod.PLUGIN_MANIFEST).toMatchObject({
      id: 'happier.scm.forge.azure-devops',
      entrypoints: { daemon: './.happier-plugin/daemon.js' },
      hostAccess: { required: expect.arrayContaining([
        // The Triage source reads the deployment the Connected Account was configured with, so
        // the same grant now names that origin beside the incumbent hosting-provider one.
        expect.objectContaining({
          id: 'azure-devops-api',
          capability: 'network',
          scope: expect.objectContaining({
            targets: expect.arrayContaining([
              { kind: 'scmProviderOrigin', provider: 'azure-devops' },
              { kind: 'connectedAccountOrigin', service: 'azure-devops-account' },
            ]),
          }),
        }),
        expect.objectContaining({
          id: 'azure-cli-process',
          capability: 'process',
          scope: expect.objectContaining({ executables: [{ kind: 'systemTool', id: 'azure-cli' }] }),
        }),
      ]), optional: [] },
      contributes: {
        ui: {
          // Contribution local IDs share one plugin-wide namespace, so the
          // Settings identity cannot reuse the SCM provider's `azure-devops` id.
          settingsGroups: [{ id: 'azure-devops-triage' }],
          settingsPages: [expect.objectContaining({
            group: { kind: 'plugin', localId: 'azure-devops-triage' },
          })],
        },
        scmHostingProviders: [
          {
            id: 'azure-devops',
            kind: 'azure-devops',
            title: 'Azure DevOps',
            capabilities: expect.arrayContaining(['detect', 'pullRequest']),
          },
        ],
        systemTools: [{ id: 'azure-cli', executableNames: ['az'] }],
      },
    });
    expect(mod.PLUGIN_MANIFEST).not.toHaveProperty('source');
    expect(mod.PLUGIN_MANIFEST).not.toHaveProperty('uses');
    expect(mod.PLUGIN_MANIFEST).not.toHaveProperty('permissions');
    expect(mod.PLUGIN_MANIFEST).not.toHaveProperty('activationEvents');
    // A bundled plugin is admitted from the emitted `.happier-plugin/plugin.json` bytes, and the
    // canonical parser refuses the in-memory `definePlugin` value outright because that value
    // carries a non-enumerable `Symbol.for(...)` brand. Ingest therefore reads the serialized form.
    expect(ingestPluginManifestV2(JSON.parse(JSON.stringify(mod.PLUGIN_MANIFEST))))
      .toMatchObject({ ok: true });
    // The wall time here is the on-demand transform of the manifest's whole transitive graph —
    // every contributed Action's handler and schema — paid inside the test body by the dynamic
    // import. It is a build cost, not an assertion cost, and it grows with each contributed
    // Action, so the bound is stated rather than left at a default that turns a slow transform
    // into a red suite.
  }, 60_000);

  it('registers exactly the manifest-declared local provider id', async () => {
    const [{ activate }, { PLUGIN_MANIFEST }] = await Promise.all([
      import('./activate.js'),
      import('./manifest.js'),
    ]);
    const testkit = await createPluginTestkit({
      manifest: PLUGIN_MANIFEST,
      module: { activate },
    });
    expect(testkit.registrations()
      .filter(({ family }) => family === 'scmHostingProviders')
      .map(({ localId }) => localId))
      .toEqual(PLUGIN_MANIFEST.contributes.scmHostingProviders.map(({ id }) => id));
  }, 60_000);

  it('detects current and legacy Azure DevOps remotes with HTTPS URL safety metadata', async () => {
    const mod = await import('./detection/adapter.js').catch(() => null);
    expect(mod).not.toBeNull();
    if (!mod) return;

    const adapter = mod.azureDevopsHostingProviderAdapter as Adapter;

    expect(adapter.detectRemote({
      remoteName: 'origin',
      remoteUrl: 'https://dev.azure.com/happier-dev/platform/_git/happier.git',
    })).toMatchObject({
      id: 'happier.scm.forge.azure-devops/azure-devops',
      kind: 'azure-devops',
      baseUrl: 'https://dev.azure.com/happier-dev',
      nameWithOwner: 'happier-dev/platform/happier',
      remoteName: 'origin',
      urlSafety: {
        allowedSchemes: ['https:'],
        allowedBaseUrls: ['https://dev.azure.com/happier-dev'],
        allowedOrigins: ['https://dev.azure.com'],
      },
    });
    expect(adapter.detectRemote({
      remoteName: 'upstream',
      remoteUrl: 'git@ssh.dev.azure.com:v3/happier-dev/platform/happier',
    })).toMatchObject({
      id: 'happier.scm.forge.azure-devops/azure-devops',
      baseUrl: 'https://dev.azure.com/happier-dev',
      nameWithOwner: 'happier-dev/platform/happier',
      remoteName: 'upstream',
    });
    expect(adapter.detectRemote({
      remoteName: 'origin',
      remoteUrl: 'ssh://git@ssh.dev.azure.com/v3/happier-dev/platform/happier',
    })).toMatchObject({
      id: 'happier.scm.forge.azure-devops/azure-devops',
      baseUrl: 'https://dev.azure.com/happier-dev',
      nameWithOwner: 'happier-dev/platform/happier',
      remoteName: 'origin',
    });
    expect(adapter.detectRemote({
      remoteName: 'legacy',
      remoteUrl: 'git@happier-dev.visualstudio.com:v3/happier-dev/platform/happier',
    })).toMatchObject({
      id: 'happier.scm.forge.azure-devops/azure-devops',
      baseUrl: 'https://happier-dev.visualstudio.com',
      nameWithOwner: 'happier-dev/platform/happier',
      remoteName: 'legacy',
    });
    expect(adapter.detectRemote({
      remoteName: 'origin',
      remoteUrl: 'https://happier-dev.visualstudio.com/platform/_git/happier',
    })).toMatchObject({
      id: 'happier.scm.forge.azure-devops/azure-devops',
      baseUrl: 'https://happier-dev.visualstudio.com',
      nameWithOwner: 'happier-dev/platform/happier',
      urlSafety: {
        allowedSchemes: ['https:'],
        allowedBaseUrls: ['https://happier-dev.visualstudio.com'],
        allowedOrigins: ['https://happier-dev.visualstudio.com'],
      },
    });
    expect(adapter.detectRemote({
      remoteName: 'server',
      remoteUrl: 'https://server.example/tfs/DefaultCollection/Payments/_git/checkout',
    })).toMatchObject({
      id: 'happier.scm.forge.azure-devops/azure-devops',
      kind: 'azure-devops',
      baseUrl: 'https://server.example/tfs/DefaultCollection',
      nameWithOwner: 'DefaultCollection/Payments/checkout',
      repositoryWebUrl: 'https://server.example/tfs/DefaultCollection/Payments/_git/checkout',
      remoteName: 'server',
      urlSafety: {
        allowedSchemes: ['https:'],
        allowedBaseUrls: ['https://server.example/tfs/DefaultCollection'],
        allowedOrigins: ['https://server.example'],
      },
    });
  });

  it('builds encoded compare URLs and treats malformed Azure-like remotes as unknown', async () => {
    const mod = await import('./detection/adapter.js').catch(() => null);
    expect(mod).not.toBeNull();
    if (!mod) return;

    const adapter = mod.azureDevopsHostingProviderAdapter as Adapter & Record<string, unknown>;
    const provider = adapter.detectRemote({
      remoteName: 'origin',
      remoteUrl: 'https://dev.azure.com/happier-dev/platform/_git/happier.git',
    });

    expect(provider).not.toBeNull();
    if (!provider) return;

    expect(adapter.buildCompareUrl({
      provider,
      base: 'release/2026',
      head: 'feature/pr support',
    })).toBe('https://dev.azure.com/happier-dev/platform/_git/happier/branchCompare?baseVersion=GBrelease%2F2026&targetVersion=GBfeature%2Fpr%20support');
    expect(adapter.buildCompareUrl({
      provider: {
        ...provider,
        baseUrl: 'https://evil.example.com/happier-dev',
      },
      base: 'release/2026',
      head: 'feature/pr support',
    })).toBeNull();
    expect(adapter.buildCompareUrl({
      provider: {
        ...provider,
        baseUrl: 'http://dev.azure.com/happier-dev',
      },
      base: 'release/2026',
      head: 'feature/pr support',
    })).toBeNull();
    expect(adapter.buildCompareUrl({
      provider: {
        ...provider,
        baseUrl: 'https://dev.azure.com:8443/happier-dev',
      },
      base: 'release/2026',
      head: 'feature/pr support',
    })).toBeNull();
    expect(adapter.buildCompareUrl({
      provider: {
        ...provider,
        nameWithOwner: 'happier-dev/../happier',
      },
      base: 'release/2026',
      head: 'feature/pr support',
    })).toBeNull();
    expect(adapter.detectRemote({
      remoteName: 'origin',
      remoteUrl: 'https://dev.azure.com/happier-dev/_git/happier.git',
    })).toBeNull();
    expect(adapter.detectRemote({
      remoteName: 'origin',
      remoteUrl: 'ftp://dev.azure.com/happier-dev/platform/_git/happier.git',
    })).toBeNull();
    expect(adapter.detectRemote({
      remoteName: 'origin',
      remoteUrl: 'ssh://git@dev.azure.com/happier-dev/platform/_git/happier.git',
    })).toBeNull();
    expect(adapter.detectRemote({
      remoteName: 'origin',
      remoteUrl: 'https://ssh.dev.azure.com/v3/happier-dev/platform/happier',
    })).toBeNull();
    expect(adapter.detectRemote({
      remoteName: 'origin',
      remoteUrl: 'git@dev.azure.com:happier-dev/platform/_git/happier.git',
    })).toBeNull();
    expect(adapter.detectRemote({
      remoteName: 'origin',
      remoteUrl: 'https://not-dev.azure.com/platform/_git/happier.git',
    })).toBeNull();
    for (const remoteUrl of [
      'https://dev.azure.com:8443/happier-dev/platform/_git/happier.git',
      'https://dev.azure.com/happier-dev/platform/_git/happier.git?preview=1',
      'https://dev.azure.com/happier-dev/platform/_git/happier.git#refs',
      'https://user:token@dev.azure.com/happier-dev/platform/_git/happier.git',
      'ssh://git@ssh.dev.azure.com:2222/v3/happier-dev/platform/happier',
    ]) {
      expect(adapter.detectRemote({
        remoteName: 'origin',
        remoteUrl,
      })).toBeNull();
    }
    expect(adapter[`create${'PullRequest'}`]).toBeUndefined();
    expect(adapter[`create${'Repository'}`]).toBeUndefined();
  });
});
