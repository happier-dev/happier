import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import fastify from 'fastify';
import * as undici from 'undici';
import { afterEach, expect, it, vi } from 'vitest';
import { QualifiedConnectedAccountCredentialSnapshotV4Schema, QualifiedConnectedAccountProfileV4Schema,
  sealQualifiedConnectedAccountContentEnvelope } from '@happier-dev/protocol';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { registerAuthoredAccountActionRelease } from '@/plugins/runtime/accountPluginActions.testkit';
import { normalizePluginManifestV2 } from '@/plugins/manifest/normalize';
import { resetActiveAccountSettingsSnapshotForTests } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { PLUGIN_MANIFEST } from '../../../../../packages/plugins/scm-github/src/manifest';
import { GITHUB_OVERVIEW_TARGET_ACTION_ID } from '../../../../../packages/plugins/scm-github/src/actions/overviewContracts';
import { GITHUB_CONNECTED_ACCOUNT_SERVICE as service, GITHUB_CONNECTED_ACCOUNT_PURPOSE } from '../../../../../packages/plugins/scm-github/src/observations/githubProviderContracts';
import { createCliActionExecutor } from './createCliActionExecutor';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { resolveScmHostingRefForHost } from '@/scm/hostingProviders/resolveRefForHost';
import { projectDeploymentFailure } from '@/deployments/deploymentFailure';

// Only provider HTTP is replaced; the Account dispatcher and binding owner run.
vi.mock('undici', async importOriginal => {
  const runtime = await importOriginal<typeof import('undici')>();
  return { ...runtime, fetch: vi.fn(runtime.fetch) };
});
afterEach(() => { vi.mocked(undici.fetch).mockReset(); vi.unstubAllGlobals(); resetActiveAccountSettingsSnapshotForTests(); });

it.each([false, true])('runs Deploy source HEAD through the requester GitHub purpose (selected: %s)', async selected => {
  const home = await mkdtemp(resolve(tmpdir(), 'requester-github-purpose-'));
  const app = fastify();
  const serverHttpBaseUrl = 'http://requester-github-purpose.test';
  const accountId = 'requester-github-purpose';
  const token = `e30.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`;
  const credentials = { token, encryption: null, credentialProvenance: 'stored_session' as const };
  const action = { pluginId: service.pluginId, localId: GITHUB_OVERVIEW_TARGET_ACTION_ID };
  const recorded = { service, accountId: 'requester-github' };
  const revision = 'csr_0123456789ABCDEFGHJKMNPQRS';
  const authenticationModeId = normalizePluginManifestV2(PLUGIN_MANIFEST).contributes.connectedAccountDescriptors
    .find(descriptor => descriptor.id === service.localId)!.authentication.defaultModeId;
  const sentinel = 'synthetic-requester-github-credential';
  const sha = 'a'.repeat(40);
  const repository = { kind: 'github' as const, deployment: 'https://github.com', repository: 'example/project' };
  await registerAuthoredAccountActionRelease(app, accountId, { primary: {
    manifest: PLUGIN_MANIFEST, projectRoot: resolve(import.meta.dirname, '../../../../../packages/plugins/scm-github'),
    entryPath: resolve(import.meta.dirname, '../../../../../packages/plugins/scm-github/src/accountRuntime.ts'),
    artifactId: 'github-account-runtime', activateExport: 'activate', manifestExport: null,
  } });
  app.get('/v1/account/encryption', async () => ({ mode: 'plain', updatedAt: 1 }));
  app.get('/v1/account/encryption/currentness', async () => ({ mode: 'plain', version: 1, settingsVersion: 1,
    signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 }));
  app.get('/v2/account/settings', async () => ({ content: { t: 'plain', v: {} }, version: 1 }));
  app.get('/v1/account/entity-rows/connected-accounts/purposes', async request => {
    expect(request.headers.authorization === `Bearer ${token}`).toBe(true);
    return { status: 'present', revision: 1, content: { t: 'plain', v: { key: 'purposes', value: { v: 1,
      bindings: selected ? [{ purpose: { consumer: action, purpose: GITHUB_CONNECTED_ACCOUNT_PURPOSE },
        target: { kind: 'account', account: recorded } }] : [] } } } };
  });
  app.get('/v4/connect/qualified/accounts', async request => {
    expect(request.headers.authorization === `Bearer ${token}`).toBe(true);
    return { service, accounts: [QualifiedConnectedAccountProfileV4Schema.parse({ ref: recorded, status: 'connected',
      authenticationModeId, revisionSemantics: 'revisioned', credentialRevision: revision,
      configurationReady: true, configurationRevision: null, kind: 'token', expiresAt: null, displayName: 'Requester GitHub', scopes: [] })] };
  });
  app.get('/v4/connect/qualified/credential', async request => {
    expect(request.headers.authorization === `Bearer ${token}`).toBe(true);
    expect(JSON.parse(new URL(request.url, serverHttpBaseUrl).searchParams.get('ref') ?? 'null')).toEqual(recorded);
    return QualifiedConnectedAccountCredentialSnapshotV4Schema.parse({ ref: recorded, authenticationModeId,
      revisionSemantics: 'revisioned', credentialRevision: revision, configurationRevision: null,
      content: sealQualifiedConnectedAccountContentEnvelope({ kind: 'credential', accountMode: 'plain',
        payload: { v: 1, values: { token: sentinel } }, randomBytes: length => new Uint8Array(length) }), metadata: { scopes: [] } });
  });
  await app.ready();
  const restore = installAxiosFastifyAdapter({ app, origin: serverHttpBaseUrl });
  const providerPaths: string[] = [];
  vi.mocked(undici.fetch).mockImplementation(async (url, init) => {
    expect(new Headers(init?.headers as HeadersInit).get('authorization') === `Bearer ${sentinel}`).toBe(true);
    const path = new URL(String(url)).pathname;
    providerPaths.push(path);
    return new undici.Response(JSON.stringify(path.endsWith('/commits/main') ? { sha }
      : { full_name: 'example/project', default_branch: 'main' }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ features: { connectedServices: { enabled: true } },
    capabilities: { connectedServices: { qualifiedAccounts: { protocolVersion: 4 } } } })));
  let runtime: Awaited<ReturnType<typeof createAuthoredAdmittedPluginRuntimeFixture>> | undefined;
  try {
    const declaration = normalizePluginManifestV2(PLUGIN_MANIFEST);
    // The daemon supplies full declarations; Account executable bytes above stay real.
    // Static UI assets need only filesystem presence in this source-read fixture.
    runtime = await createAuthoredAdmittedPluginRuntimeFixture({ happyHomeDir: home,
      plugins: [{ manifest: declaration, files: {
        ...Object.fromEntries(declaration.contributes.resources.flatMap(resource =>
          'path' in resource && typeof resource.path === 'string' ? [[resource.path, '{}']] : [])),
        [declaration.entrypoints!.daemon!]: 'exports.activate = () => {};',
      } }], coldStart: true });
    const admittedRuntime = runtime;
    const cli = createCliActionExecutor({ token, credentials, happyHomeDir: home, sessionId: 'cli-global', mode: 'plain', ctx: null,
      serverId: 'requester-github-home', serverHttpBaseUrl, runtimeActionMachineId: 'controller' });
    const result = await resolveScmHostingRefForHost({
      repository: { protocol: 'https', provider: { id: `${service.pluginId}/github`, kind: 'github',
        displayName: 'GitHub', baseUrl: repository.deployment },
        repository: { nameWithOwner: repository.repository, cloneUrl: 'https://github.com/example/project.git' } },
      ref: 'main', context: { surface: 'cli' },
      acquireRuntimeRegistryLease: () => admittedRuntime.controller.acquireRuntimeRegistry(),
      executeSourceReadAction: (sourceAction, input, context) => cli.execute('action.invoke', { action: sourceAction, input }, context),
    }).then(headSha => ({ ok: true, result: headSha }), (error: unknown) => {
      if (!(error instanceof Error) || !('code' in error) || typeof error.code !== 'string') throw error;
      return projectDeploymentFailure(error.code, error);
    });
    expect(result, JSON.stringify(result)).toMatchObject(selected
      ? { ok: true, result: sha }
      : { ok: false, errorCode: 'plugin_connected_account_native_unavailable', details: {
        remediation: { kind: 'selectAccount', service },
      } });
    expect(providerPaths).toEqual(selected ? ['/repos/example/project', '/repos/example/project/commits/main'] : []);
    expect(JSON.stringify(result)).not.toContain(sentinel);
  } finally { await runtime?.dispose(); restore(); await app.close(); await rm(home, { recursive: true, force: true }); }
});
