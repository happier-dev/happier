import { describe, expect, it } from 'vitest';
import { ingestPluginManifestV2 } from '@happier-dev/protocol';
import type { ConnectedAccountRuntime as PluginConnectedAccountRuntime } from '@happier-dev/plugin-sdk/connected-accounts';

import { encodeBitbucketBasicAuthorization } from './auth/basicCredentials.js';
import { BITBUCKET_TRIAGE_ACTION_IDS } from './triage/source/actions.js';
import { BITBUCKET_TRIAGE_DETAIL_ACTION_IDS } from './triage/source/detailActions.js';
import { BITBUCKET_TRIAGE_MUTATION_ACTION_IDS } from './triage/source/mutationActions.js';

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
  listPullRequests?: unknown;
  getPullRequest?: unknown;
  createPullRequest?: unknown;
  resolvePullRequestCheckoutReference?: unknown;
  describePublishTargets?: unknown;
  createRepository?: unknown;
  getRepository?: unknown;
}>;

function decodeBasicAuthorization(value: string): string {
  const binary = atob(value.slice('Basic '.length));
  return new TextDecoder().decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
}

describe('bundled Bitbucket SCM hosting provider plugin', () => {
  it('declares a strict target SCM hosting-provider contribution and manual account identity', async () => {
    const mod = await import('./manifest.js').catch(() => null);
    expect(mod).not.toBeNull();
    if (!mod) return;

    expect(mod.PLUGIN_MANIFEST).toMatchObject({
      id: 'happier.scm.forge.bitbucket',
      entrypoints: { daemon: './.happier-plugin/daemon.js' },
      hostAccess: { required: expect.arrayContaining([
        expect.objectContaining({ id: 'bitbucket-api', capability: 'network', scope: { targets: expect.arrayContaining([
          { kind: 'fixedOrigin', origin: 'https://api.bitbucket.org' },
          { kind: 'scmProviderOrigin', provider: 'bitbucket' },
          { kind: 'connectedAccountOrigin', service: 'bitbucket-account' },
        ]), methods: ['GET', 'POST', 'DELETE'] } }),
        expect.objectContaining({
          id: 'bitbucket-connected-account',
          capability: 'connectedAccounts',
          scope: {
            serviceRefs: ['bitbucket-account'],
            operations: ['select', 'use'],
            materializationKinds: ['httpHeaders'],
          },
        }),
      ]), optional: [] },
      contributes: {
        scmHostingProviders: [
          {
            id: 'bitbucket',
            kind: 'bitbucket',
            title: 'Bitbucket',
            capabilities: expect.arrayContaining(['detect', 'pullRequest']),
            authService: 'bitbucket-account',
          },
        ],
        connectedAccountDescriptors: [
          expect.objectContaining({
            id: 'bitbucket-account',
            authentication: {
              defaultModeId: 'manual',
              modes: [
                expect.objectContaining({
                  id: 'manual',
                  kind: 'manual',
                  outcomeReconciliation: 'none',
                  fields: expect.arrayContaining([
                    expect.objectContaining({ id: 'identity' }),
                    expect.objectContaining({ id: 'token', secret: true }),
                  ]),
                }),
              ],
            },
          }),
        ],
      },
    });
    expect(mod.PLUGIN_MANIFEST).not.toHaveProperty('source');
    expect(mod.PLUGIN_MANIFEST).not.toHaveProperty('uses');
    expect(mod.PLUGIN_MANIFEST).not.toHaveProperty('permissions');
    expect(mod.PLUGIN_MANIFEST).not.toHaveProperty('activationEvents');
    // Ingested the way the host does it: from the serialized manifest bytes the build emits to
    // `.happier-plugin/plugin.json`, not from the branded in-memory object.
    expect(ingestPluginManifestV2(JSON.parse(JSON.stringify(mod.PLUGIN_MANIFEST)))).toMatchObject({ ok: true });
    // This direct cold manifest retains author-declared shape. Canonical host
    // ingestion later normalizes an undeclared hooks family to an empty array.
    expect(mod.PLUGIN_MANIFEST.contributes).not.toHaveProperty('hooks');
    expect(mod.PLUGIN_MANIFEST.contributes.hooks).toBeUndefined();
  });

  it('rejects dangling and wrong-family SCM/account origin references', async () => {
    const { PLUGIN_MANIFEST } = await import('./manifest.js');
    expect(ingestPluginManifestV2({
      ...PLUGIN_MANIFEST,
      contributes: {
        ...PLUGIN_MANIFEST.contributes,
        scmHostingProviders: [{
          ...PLUGIN_MANIFEST.contributes.scmHostingProviders[0],
          authService: 'missing-account',
        }],
      },
    })).toMatchObject({
      ok: false,
      diagnostics: [expect.objectContaining({ code: 'plugin_manifest_dangling_reference' })],
    });
    expect(ingestPluginManifestV2({
      ...PLUGIN_MANIFEST,
      hostAccess: {
        required: [...PLUGIN_MANIFEST.hostAccess.required, {
          id: 'wrong-account-family',
          capability: 'network',
          reason: 'Wrong account family',
          scope: {
            targets: [{ kind: 'connectedAccountOrigin', service: 'bitbucket' }],
            methods: ['GET'],
          },
        }],
        optional: [],
      },
    })).toMatchObject({
      ok: false,
      diagnostics: [expect.objectContaining({ code: 'plugin_manifest_wrong_family_reference' })],
    });
    expect(ingestPluginManifestV2({
      ...PLUGIN_MANIFEST,
      hostAccess: {
        required: [...PLUGIN_MANIFEST.hostAccess.required, {
          id: 'wrong-provider-family',
          capability: 'network',
          reason: 'Wrong provider family',
          scope: {
            targets: [{ kind: 'scmProviderOrigin', provider: 'bitbucket-account' }],
            methods: ['GET'],
          },
        }],
        optional: [],
      },
    })).toMatchObject({
      ok: false,
      diagnostics: [expect.objectContaining({ code: 'plugin_manifest_wrong_family_reference' })],
    });
  });

  it('detects only Bitbucket Cloud remotes with owner and repository path segments', async () => {
    const mod = await import('./adapter.js').catch(() => null);
    expect(mod).not.toBeNull();
    if (!mod) return;

    const adapter = mod.bitbucketHostingProviderAdapter as Adapter;

    expect(adapter.detectRemote({
      remoteName: 'origin',
      remoteUrl: 'https://bitbucket.org/happier-dev/happier.git',
    })).toMatchObject({
      id: 'happier.scm.forge.bitbucket/bitbucket',
      kind: 'bitbucket',
      baseUrl: 'https://bitbucket.org',
      nameWithOwner: 'happier-dev/happier',
      remoteName: 'origin',
      urlSafety: {
        allowedSchemes: ['https:'],
        allowedBaseUrls: ['https://bitbucket.org'],
        allowedOrigins: ['https://bitbucket.org'],
      },
    });
    expect(adapter.detectRemote({
      remoteName: 'origin',
      remoteUrl: 'https://bitbucket.org/workspace/project/repository.git',
    })).toBeNull();
    expect(adapter.detectRemote({
      remoteName: 'origin',
      remoteUrl: 'ftp://bitbucket.org/happier-dev/happier.git',
    })).toBeNull();
    expect(adapter.detectRemote({
      remoteName: 'origin',
      remoteUrl: 'file:///bitbucket.org/happier-dev/happier.git',
    })).toBeNull();
  });

  it('builds encoded Bitbucket compare URLs and registers operation behavior at activation', async () => {
    const mod = await import('./adapter.js').catch(() => null);
    expect(mod).not.toBeNull();
    if (!mod) return;

    const adapter = mod.bitbucketHostingProviderAdapter as Adapter & Record<string, unknown>;
    const provider = adapter.detectRemote({
      remoteName: 'origin',
      remoteUrl: 'git@bitbucket.org:happier-dev/happier.git',
    });

    expect(provider).not.toBeNull();
    if (!provider) return;

    expect(adapter.buildCompareUrl({
      provider,
      base: 'release/2026',
      head: 'space branch',
    })).toBe('https://bitbucket.org/happier-dev/happier/branch/space%20branch?dest=release%2F2026');
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
        baseUrl: 'https://bitbucket.org:8443',
      },
      base: 'main',
      head: 'feature/pr-support',
    })).toBeNull();
    expect(adapter.buildCompareUrl({
      provider: {
        ...provider,
        nameWithOwner: 'happier-dev/../happier',
      },
      base: 'main',
      head: 'feature/pr-support',
    })).toBeNull();
  });

  it('registers the Bitbucket API operations adapter during plugin activation', async () => {
    const mod = await import('./activate.js').catch(() => null);
    expect(mod).not.toBeNull();
    if (!mod) return;

    const registrations: Array<Readonly<{ id: string; adapter: Adapter }>> = [];
    const hooks: Array<Readonly<{ hookId: string; handler: unknown }>> = [];
    const connectedAccountRegistrations: Array<Readonly<{
      id: string;
      runtime: PluginConnectedAccountRuntime;
    }>> = [];
    const actionRegistrations: Array<Readonly<{ id: string; handler: unknown }>> = [];
    // Boundary fixture intentionally supplies only the activation surface exercised here.
    mod.activate({
      scm: {
        registerHostingProvider(
          id: string,
          runtime: Readonly<{ adapter: Adapter }>,
        ) {
          registrations.push({ id, ...runtime });
          return { dispose() {} };
        },
      },
      hooks: {
        register(hookId: string, handler: unknown) {
          hooks.push({ hookId, handler });
          return { dispose() {} };
        },
      },
      connectedAccounts: {
        register(id: string, runtime: PluginConnectedAccountRuntime) {
          connectedAccountRegistrations.push({ id, runtime });
          return { dispose() {} };
        },
      },
      actions: {
        register(id: string, handler: unknown) {
          actionRegistrations.push({ id, handler });
        },
      },
    } as Parameters<typeof mod.activate>[0]);

    // The three source roles, the three source-native detail planes AND the two
    // pull-request writes. The list is exhaustive on purpose: a declared Action
    // with no registered handler passes conformance and then fails at
    // invocation, and a registered handler with no declaration is a path the
    // host never admits — which for a write would be an external effect
    // reachable through an owner the manifest never described.
    expect(actionRegistrations.map(({ id }) => id).sort())
      .toEqual([
        ...Object.values(BITBUCKET_TRIAGE_ACTION_IDS),
        ...Object.values(BITBUCKET_TRIAGE_DETAIL_ACTION_IDS),
        ...Object.values(BITBUCKET_TRIAGE_MUTATION_ACTION_IDS),
      ].sort());

    expect(registrations).toHaveLength(1);
    expect(hooks).toEqual([]);
    expect(connectedAccountRegistrations.map(({ id }) => id))
      .toEqual((await import('./manifest.js')).PLUGIN_MANIFEST.contributes.connectedAccountDescriptors.map(({ id }) => id));
    const connectedAccountRuntime = connectedAccountRegistrations[0]?.runtime;
    expect(connectedAccountRuntime?.authentication.modes).toEqual({
      manual: expect.objectContaining({ kind: 'manual', complete: expect.any(Function) }),
    });
    expect(connectedAccountRuntime).toMatchObject({
      refresh: expect.any(Function),
      revoke: expect.any(Function),
      status: expect.any(Function),
      materialize: expect.any(Function),
    });
    const authentication = connectedAccountRuntime?.authentication.modes.manual;
    if (!connectedAccountRuntime || !authentication || authentication.kind !== 'manual') return;

    const credentialValues = new Map<string, string>();
    const credentialStore = {
      async get(key: string) { return credentialValues.get(key) ?? null; },
      async set(key: string, value: string) { credentialValues.set(key, value); },
      async delete(key: string) { credentialValues.delete(key); },
    };
    const authenticationResult = await authentication.complete({
      fields: { identity: ' account@example.com ', token: ' token-secret ' },
    }, {
      attempt: { kind: 'connect', attemptId: 'connect-attempt' },
      attemptCredentials: credentialStore,
    } as Parameters<typeof authentication.complete>[1]);
    expect(authenticationResult).toEqual({
      status: 'connected',
      providerIdentity: {
        accountId: 'account@example.com',
      },
      displayName: 'account@example.com',
      scopes: [],
    });

    const reconnectCredentialValues = new Map<string, string>();
    const reconnectResult = await authentication.complete({
      fields: { identity: ' renamed@example.com ', token: ' replacement-token ' },
    }, {
      attempt: {
        kind: 'reconnect',
        attemptId: 'reconnect-attempt',
        account: {
          service: { pluginId: 'happier.scm.forge.bitbucket', contributionId: 'bitbucket-account' },
          accountId: 'account@example.com',
        },
      },
      attemptCredentials: {
        async get(key: string) { return reconnectCredentialValues.get(key) ?? null; },
        async set(key: string, value: string) { reconnectCredentialValues.set(key, value); },
        async delete(key: string) { reconnectCredentialValues.delete(key); },
      },
    } as Parameters<typeof authentication.complete>[1]);
    expect(reconnectResult).toEqual({
      status: 'connected',
      accountId: 'account@example.com',
      providerIdentity: {
        accountId: 'renamed@example.com',
      },
      displayName: 'renamed@example.com',
      scopes: [],
    });

    const readContext = { credentials: credentialStore } as Parameters<typeof connectedAccountRuntime.status>[0];
    expect(await connectedAccountRuntime.status(readContext)).toEqual({
      status: 'connected',
      displayName: 'account@example.com',
      scopes: [],
    });
    expect(await connectedAccountRuntime.refresh(readContext as Parameters<typeof connectedAccountRuntime.refresh>[0]))
      .toEqual({ status: 'connected', displayName: 'account@example.com', scopes: [] });
    expect(await connectedAccountRuntime.revoke(readContext)).toEqual({ status: 'remoteUnsupported' });

    const materialized = await connectedAccountRuntime.materialize({
      kind: 'httpHeaders',
      origin: 'https://api.bitbucket.org',
      headerNames: ['aUtHoRiZaTiOn'],
    }, readContext);
    expect(materialized.kind).toBe('httpHeaders');
    if (materialized.kind === 'httpHeaders') {
      const authorization = materialized.headers.Authorization;
      expect(authorization).toMatch(/^Basic /);
      expect(decodeBasicAuthorization(authorization ?? ''))
        .toBe('account@example.com:token-secret');
    }
    expect(await connectedAccountRuntime.materialize({
      kind: 'httpHeaders',
      origin: 'https://bitbucket.org',
      headerNames: ['Accept'],
    }, readContext)).toEqual({ kind: 'httpHeaders', headers: {} });
    for (const origin of [
      'http://api.bitbucket.org',
      'https://api.bitbucket.org.evil.example',
      'https://api.bitbucket.org@evil.example',
      'https://api.b\u0131tbucket.org',
      'https://bitbucket.org.',
      'https://bitbucket.org:444',
    ]) {
      await expect(connectedAccountRuntime.materialize({
        kind: 'httpHeaders',
        origin,
        headerNames: ['Authorization'],
      }, readContext), origin).rejects.toThrow('cannot materialize credentials for this origin');
    }
    await expect(connectedAccountRuntime.materialize({
      kind: 'processEnv',
      envNames: ['BITBUCKET_TOKEN'],
    } as never, readContext)).rejects.toThrow('HTTP-header materialization only');

    await authentication.complete({
      fields: { identity: ' J\u00f6rg@example.com ', token: ' t\u00f8k\u00e9n-\ud83d\udd10 ' },
    }, {
      attempt: { kind: 'connect', attemptId: 'unicode-connect-attempt' },
      attemptCredentials: credentialStore,
    } as Parameters<typeof authentication.complete>[1]);
    const unicodeMaterialized = await connectedAccountRuntime.materialize({
      kind: 'httpHeaders',
      origin: 'https://api.bitbucket.org',
      headerNames: ['authorization'],
    }, readContext);
    expect(unicodeMaterialized.kind).toBe('httpHeaders');
    if (unicodeMaterialized.kind === 'httpHeaders') {
      expect(decodeBasicAuthorization(unicodeMaterialized.headers.Authorization ?? ''))
        .toBe('J\u00f6rg@example.com:t\u00f8k\u00e9n-\ud83d\udd10');
    }

    await credentialStore.delete('token');
    expect(await connectedAccountRuntime.status(readContext)).toMatchObject({
      status: 'unavailable',
      diagnostic: { code: 'bitbucket_credentials_unavailable' },
    });
    await expect(connectedAccountRuntime.materialize({
      kind: 'httpHeaders',
      origin: 'https://api.bitbucket.org',
      headerNames: ['Authorization'],
    }, readContext)).rejects.toThrow('credentials are unavailable');

    const rejected = await authentication.complete({
      fields: { identity: 'account@example.com', token: '' },
    }, {
      attempt: { kind: 'connect', attemptId: 'rejected-connect-attempt' },
      attemptCredentials: credentialStore,
    } as Parameters<typeof authentication.complete>[1]);
    expect(rejected).toMatchObject({
      status: 'rejected',
      diagnostic: { code: 'bitbucket_manual_credentials_invalid', severity: 'error' },
    });
    expect(JSON.stringify(rejected)).not.toContain('token-secret');
    expect(registrations[0]?.id).toBe('bitbucket');
    expect(registrations.map(({ id }) => id))
      .toEqual((await import('./manifest.js')).PLUGIN_MANIFEST.contributes.scmHostingProviders.map(({ id }) => id));
    expect(registrations[0]).not.toHaveProperty('auth');
    expect(registrations[0]?.adapter).toMatchObject({
      detectRemote: expect.any(Function),
      buildCompareUrl: expect.any(Function),
      listPullRequests: expect.any(Function),
      getPullRequest: expect.any(Function),
      createPullRequest: expect.any(Function),
      resolvePullRequestCheckoutReference: expect.any(Function),
      describePublishTargets: expect.any(Function),
      createRepository: expect.any(Function),
      getRepository: expect.any(Function),
    });
  });

  // Write-declaration conformance — surfaces, danger level, confirmation, grants and the granted
  // verb set — is owned by `triage/source/mutationActions.test.ts`, colocated with the writes it
  // describes. A second copy here had already DIVERGED from it: this one pinned the `plugin`
  // reachability surface and that one did not, so the weaker copy was the one a reader
  // strengthening the writes would have found. One owner, so there is no weaker copy to find.

  it('encodes Unicode Bitbucket credentials without the retired SCM materializer', () => {
    expect(decodeBasicAuthorization(encodeBitbucketBasicAuthorization({
      username: 'J\u00f6rg@example.com',
      password: 't\u00f8k\u00e9n-\ud83d\udd10',
    }))).toBe('J\u00f6rg@example.com:t\u00f8k\u00e9n-\ud83d\udd10');
  });
});
