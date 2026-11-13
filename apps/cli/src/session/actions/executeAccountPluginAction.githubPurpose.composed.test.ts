import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, resolve } from 'node:path';
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
import { stagePluginDaemonRuntime } from '@/plugins/authoring/bundleDaemonRuntime';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { writeExecutableShim } from '@/testkit/fs/executableShim';
import { reloadConfiguration } from '@/configuration';
import { getActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { createInvocationSavedSecretOperationContextV1 } from '@/settings/secrets/savedSecretOperationContext';
import { ensureCliActionPolicySettings } from './ensureCliActionPolicySettings';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { REQUESTER_ACCOUNT_MCP_AGENT_PLUGIN, startRequesterAccountMcpSession } from '@/agent/runtime/session/loop/requesterAccountMcpSession.testkit';

// Only Home/provider HTTP and the gh executable boundary vary; runtime owners remain real.
vi.mock('undici', async importOriginal => {
  const runtime = await importOriginal<typeof import('undici')>();
  return { ...runtime, fetch: vi.fn(runtime.fetch) };
});
afterEach(() => { vi.mocked(undici.fetch).mockReset(); vi.unstubAllGlobals(); resetActiveAccountSettingsSnapshotForTests(); });

it.each(['unselected', 'selected', 'native custodian', 'native retained Session'] as const)(
  'runs Deploy source HEAD through the requester GitHub purpose (%s)', async scenario => {
  const selected = scenario === 'selected';
  const native = scenario.startsWith('native');
  const retained = scenario === 'native retained Session';
  const home = await mkdtemp(resolve(tmpdir(), 'requester-github-purpose-'));
  const env = createEnvKeyScope(['HAPPIER_HOME_DIR', 'PATH']);
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
  let retainedParent: Awaited<ReturnType<typeof startRequesterAccountMcpSession>> | undefined;
  try {
    env.patch({ HAPPIER_HOME_DIR: home });
    reloadConfiguration();
    const declaration = normalizePluginManifestV2(PLUGIN_MANIFEST);
    const files: Record<string, string | Uint8Array> = {
      ...Object.fromEntries(declaration.contributes.resources.flatMap(resource =>
        'path' in resource && typeof resource.path === 'string' ? [[resource.path, '{}']] : [])),
      [declaration.entrypoints!.daemon!]: 'exports.activate = () => {};',
    };
    const nativeCommandTrace = resolve(home, 'gh-calls');
    if (native) {
      // Compile the actual daemon activation and native credential runtime through
      // the existing author owner; the admitted registry loads these physical bytes.
      const stagedRoot = resolve(home, 'github-daemon');
      await mkdir(stagedRoot);
      const staged = await stagePluginDaemonRuntime({
        sourceRootPath: resolve(import.meta.dirname, '../../../../../packages/plugins/scm-github'),
        sourceEntryPath: resolve(import.meta.dirname, '../../../../../packages/plugins/scm-github/src/index.ts'),
        stagedRootPath: stagedRoot, daemonEntrypoint: declaration.entrypoints!.daemon!,
      });
      for (const path of staged.outputRelativePaths) files[path] = await readFile(resolve(stagedRoot, path));
      files['package.json'] = JSON.stringify({ type: 'module' });
      const executableDirectory = resolve(home, 'bin');
      await writeExecutableShim({ dir: executableDirectory, fileName: process.platform === 'win32' ? 'gh.cmd' : 'gh',
        contents: process.platform === 'win32'
          ? `@echo off\r\necho %*>>"${nativeCommandTrace}"\r\necho ${sentinel}\r\n`
          : `#!/bin/sh\nprintf '%s\\n' "$*" >> '${nativeCommandTrace}'\nprintf '%s\\n' '${sentinel}'\n`,
      });
      env.patch({ PATH: `${executableDirectory}${delimiter}${process.env.PATH ?? ''}` });
    }
    runtime = await createAuthoredAdmittedPluginRuntimeFixture({ happyHomeDir: home, controller: pluginReloadController,
      plugins: [{ manifest: declaration, files }, ...(retained ? [REQUESTER_ACCOUNT_MCP_AGENT_PLUGIN] : [])], coldStart: true });
    const admittedRuntime = runtime;
    await runWithServerHttpBaseUrl(serverHttpBaseUrl, () => ensureCliActionPolicySettings(credentials, serverHttpBaseUrl));
    const snapshot = getActiveAccountSettingsSnapshot();
    if (!snapshot) throw new Error('Expected requester policy admission');
    // One physical native runtime serves the admitted custodian and both refusals.
    for (const admission of retained ? ['custodian'] as const : native ? ['custodian', 'foreign', 'unadmitted'] as const : ['unadmitted'] as const) {
      const succeeds = selected || admission === 'custodian';
      providerPaths.length = 0;
      await rm(nativeCommandTrace, { force: true });
      const savedSecretOperationContext = createInvocationSavedSecretOperationContextV1({ credentials, snapshot,
        serverHttpBaseUrl, isCurrent: async () => true,
        ...(admission === 'custodian' || admission === 'foreign' ? { machineAdmission: {
          actorAccountId: accountId, custodianAccountId: admission === 'custodian' ? accountId : 'another-custodian',
          role: 'manage' as const,
        } } : {}),
      });
      const cli = createCliActionExecutor({ token, credentials, happyHomeDir: home, sessionId: 'cli-global', mode: 'plain', ctx: null,
        serverId: 'requester-github-home', serverHttpBaseUrl, runtimeActionMachineId: 'controller', savedSecretOperationContext });
      if (retained) retainedParent = await startRequesterAccountMcpSession({
        credentials, snapshot, serverId: 'requester-github-home', serverHttpBaseUrl,
        accountId, machineId: 'controller', installationId: 'installation',
        sessionId: 'retained-github-source-session', happyHomeDir: home,
        pluginRuntimeRegistryLease: admittedRuntime.lease,
      });
      const result = await resolveScmHostingRefForHost({
        repository: { protocol: 'https', provider: { id: `${service.pluginId}/github`, kind: 'github',
          displayName: 'GitHub', baseUrl: repository.deployment },
          repository: { nameWithOwner: repository.repository, cloneUrl: 'https://github.com/example/project.git' } },
        ref: 'main', context: { surface: 'cli' },
        acquireRuntimeRegistryLease: () => admittedRuntime.controller.acquireRuntimeRegistry(),
        executeSourceReadAction: retainedParent?.executeSourceReadAction
          ?? ((sourceAction, input, context) => cli.execute('action.invoke', { action: sourceAction, input }, context)),
      }).then(headSha => ({ ok: true, result: headSha }), (error: unknown) => {
        if (!(error instanceof Error) || !('code' in error) || typeof error.code !== 'string') throw error;
        return projectDeploymentFailure(error.code, error);
      });
      expect(result, JSON.stringify(result)).toMatchObject(succeeds
        ? { ok: true, result: sha }
        : { ok: false, errorCode: 'plugin_connected_account_native_unavailable', details: {
          remediation: { kind: 'selectAccount', service },
        } });
      expect(providerPaths).toEqual(succeeds ? ['/repos/example/project', '/repos/example/project/commits/main'] : []);
      if (native) {
        const commandTrace = await readFile(nativeCommandTrace, 'utf8').catch(error => {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
          throw error;
        });
        expect(commandTrace.trim().split(/\r?\n/u).filter(Boolean)).toEqual(
          succeeds ? ['auth token --hostname github.com'] : []);
      }
      expect(JSON.stringify(result)).not.toContain(sentinel);
    }
  } finally {
    try { await retainedParent?.stop(); await runtime?.dispose(); }
    finally { env.restore(); reloadConfiguration(); restore(); await app.close(); await rm(home, { recursive: true, force: true }); }
  }
}, 60_000);
