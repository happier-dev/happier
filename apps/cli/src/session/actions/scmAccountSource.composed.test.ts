import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import fastify from 'fastify';
import * as undici from 'undici';
import { expect, it, vi } from 'vitest';
import { QualifiedConnectedAccountCredentialSnapshotV4Schema, QualifiedConnectedAccountProfileV4Schema,
  sealQualifiedConnectedAccountContentEnvelope } from '@happier-dev/protocol';
import { createTriageSourceV1Fixture } from '@happier-dev/triage-protocol/testing/v1';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { registerAuthoredAccountActionRelease } from '@/plugins/runtime/accountPluginActions.testkit';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { createLocalScmRepositoryFixture } from '@/testkit/scm/scmBackendContractFixtures';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { configuration, reloadConfiguration } from '@/configuration';
import { updateSettings } from '@/persistence';
import { resetActiveAccountSettingsSnapshotForTests } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { normalizePluginManifestV2 } from '@/plugins/manifest/normalize';
import { PLUGIN_MANIFEST } from '../../../../../packages/plugins/scm-github/src/manifest';
import { GITHUB_CONNECTED_ACCOUNT_SERVICE as service, GITHUB_CONNECTED_ACCOUNT_PURPOSE } from '../../../../../packages/plugins/scm-github/src/observations/githubProviderContracts';
import { encodeGithubTriageConfiguration } from '../../../../../packages/plugins/scm-github/src/triage/configuration';
import { buildGithubPullRequestComparisonSourceV1 } from '../../../../../packages/plugins/scm-github/src/triage/mapping/protocol';
import { GITHUB_FIXTURE_OWNER, GITHUB_FIXTURE_REPOSITORY, GITHUB_FIXTURE_REPOSITORY_ID,
  GITHUB_REPOSITORY_RESPONSE, GITHUB_PULL_REQUEST_RESPONSE, githubChangedFile } from '../../../../../packages/plugins/scm-github/src/triage/__fixtures__/githubResponses';
import { createCommittedContributedActionInvoker } from '@/plugins/runtime/invocation/actions/createCommittedContributedActionDeps';
import { createCliActionExecutor } from './createCliActionExecutor';
import { registerAccountHomeHttp } from './widgetApproval.testkit';
import { registerScmHandlers } from '@/rpc/handlers/scm';
import type { RpcHandler } from '@/api/rpc/types';
import { createTargetedActionRpcRequestV1 } from '@happier-dev/protocol/actions/actionRpcTransport';

// Provider HTTP and the Home HTTP adapter are the only substituted boundaries.
vi.mock('undici', async original => {
  const runtime = await original<typeof import('undici')>();
  return { ...runtime, fetch: vi.fn(runtime.fetch) };
});

it.each(['ui', 'rpc'] as const)('captures Files through the source-owned Account Action from the Machine SCM %s ingress', async ingress => {
  const home = await mkdtemp(join(tmpdir(), 'scm-account-source-'));
  const env = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_ACTIVE_SERVER_ID', 'HAPPIER_SERVER_URL']);
  const fixture = createLocalScmRepositoryFixture({ executable: 'git', repoMode: '.git', prefix: 'scm-account-source-repo-' });
  const serverHttpBaseUrl = 'http://scm-account-source.test';
  const serverId = 'scm-account-source-home';
  const accountId = 'scm-source-owner';
  const machineId = 'scm-source-machine';
  const token = `e30.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`;
  const credentials = { token, encryption: null, credentialProvenance: 'stored_session' as const };
  const app = fastify();
  let runtime: Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>> | undefined;
  let restore: (() => void) | undefined;
  try {
    env.patch({ HAPPIER_HOME_DIR: home, HAPPIER_ACTIVE_SERVER_ID: serverId, HAPPIER_SERVER_URL: serverHttpBaseUrl });
    reloadConfiguration();
    await updateSettings(settings => ({ ...settings, machineIdByServerId: { [serverId]: machineId } }));
    registerAccountHomeHttp(app, { accountId, serverId });
    await registerAuthoredAccountActionRelease(app, accountId, { primary: {
      manifest: PLUGIN_MANIFEST, projectRoot: resolve(import.meta.dirname, '../../../../../packages/plugins/scm-github'),
      entryPath: resolve(import.meta.dirname, '../../../../../packages/plugins/scm-github/src/accountRuntime.ts'),
      artifactId: 'github-account-runtime', activateExport: 'activate', manifestExport: null,
    } });
    const recorded = { service, accountId: 'source-github' };
    const revision = 'csr_0123456789ABCDEFGHJKMNPQRS';
    const authenticationModeId = normalizePluginManifestV2(PLUGIN_MANIFEST).contributes.connectedAccountDescriptors
      .find(descriptor => descriptor.id === service.localId)!.authentication.defaultModeId;
    app.get('/v4/connect/qualified/accounts', async () => ({ service,
      accounts: [QualifiedConnectedAccountProfileV4Schema.parse({ ref: recorded, status: 'connected', authenticationModeId,
        revisionSemantics: 'revisioned', credentialRevision: revision, configurationReady: true, configurationRevision: null,
        kind: 'token', expiresAt: null, displayName: 'Source GitHub', scopes: [] })] }));
    app.get('/v4/connect/qualified/credential', async () => QualifiedConnectedAccountCredentialSnapshotV4Schema.parse({
      ref: recorded, authenticationModeId, revisionSemantics: 'revisioned', credentialRevision: revision, configurationRevision: null,
      content: sealQualifiedConnectedAccountContentEnvelope({ kind: 'credential', accountMode: 'plain',
        payload: { v: 1, values: { token: 'synthetic-source-github-credential' } }, randomBytes: length => new Uint8Array(length) }),
      metadata: { scopes: [] },
    }));
    await app.ready();
    restore = installAxiosFastifyAdapter({ app, origin: serverHttpBaseUrl });
    const repository = `${GITHUB_FIXTURE_OWNER}/${GITHUB_FIXTURE_REPOSITORY}`;
    const baseSha = '1b0847af63d5c1e299f2c1a7d4b6e08f3a5c9d2e';
    const headSha = '9f2c1a7d4b6e08f3a5c9d2e1b0847af63d5c1e29';
    const paths: string[] = [];
    vi.mocked(undici.fetch).mockImplementation(async (url, init) => {
      expect(new Headers(init?.headers as HeadersInit).get('authorization')).toBe('Bearer synthetic-source-github-credential');
      const path = new URL(String(url)).pathname;
      paths.push(path);
      const body = path === `/repos/${repository}` ? GITHUB_REPOSITORY_RESPONSE
        : path === `/repos/${repository}/pulls/1284` ? { ...GITHUB_PULL_REQUEST_RESPONSE, changed_files: 1 }
          : path === `/repos/${repository}/pulls/1284/files` ? [{ ...githubChangedFile({ filename: 'current.ts', additions: 1, deletions: 1 }),
            patch: '@@ -1 +1 @@\n-old\n+new\n' }]
            : path.startsWith(`/repos/${repository}/compare/`) ? { base_commit: { sha: baseSha }, merge_base_commit: { sha: baseSha } }
              : undefined;
      if (!body) throw new Error(`Unexpected provider route: ${path}`);
      return new undici.Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ features: { connectedServices: { enabled: true } },
      capabilities: { connectedServices: { qualifiedAccounts: { protocolVersion: 4 } } } })));
    runtime = await createAdmittedPluginRuntimeFixture({ happyHomeDir: home, controller: pluginReloadController,
      runtimeOptions: { pluginIds: ['happier.scm.backend.git'] } });
    const configured = createTriageSourceV1Fixture().configuredInstance;
    const configurationToken = encodeGithubTriageConfiguration({ v: 1, scope: { kind: 'repository', repositoryKey: repository } });
    if (configurationToken === null) throw new Error('Invalid configured-source fixture');
    const source = buildGithubPullRequestComparisonSourceV1({
      instance: { ...configured, instance: { source: { pluginId: service.pluginId, localId: 'github-forge' },
        sourceInstanceId: configured.instance.sourceInstanceId }, binding: { purpose: GITHUB_CONNECTED_ACCOUNT_PURPOSE, account: recorded },
        localInstanceKey: 'github.com', configuration: { v: 1, token: configurationToken } },
      localRef: { kindId: 'pull-request', collisionScope: `github:${GITHUB_FIXTURE_REPOSITORY_ID}`, entryId: '1284' },
      routingToken: repository, revision: { baseSha, headSha },
    });
    if (!source) throw new Error('Expected source-owned comparison');
    const cli = createCliActionExecutor({ token, credentials, happyHomeDir: home, sessionId: '', mode: 'plain', ctx: null,
      serverId, serverHttpBaseUrl, runtimeActionMachineId: machineId, accountPluginActions: true,
      pluginActionExecutionOwner: 'current_process',
      invokeContributedAction: createCommittedContributedActionInvoker(),
      scmFilesystemAccessPolicy: { kind: 'restrictedRoots', roots: [fixture.rootPath] },
    });
    const input = { cwd: fixture.rootPath, source };
    const target = { kind: 'machine' as const, machineId, project: { machineId, directory: fixture.rootPath } };
    const handlers = new Map<string, RpcHandler>();
    registerScmHandlers({ registerHandler: (method, handler) => { handlers.set(method, handler); } }, fixture.rootPath,
      { machineId, actionExecutor: cli, accessPolicy: { kind: 'restrictedRoots', roots: [fixture.rootPath] } });
    // Files uses the authenticated Machine RPC ingress, whose surface is rpc,
    // rather than the public UI Action path exercised by the original regression.
    const result = ingress === 'ui'
      ? await cli.execute('scm.diffSummary.capture', input, {
          surface: 'ui', serverId: configuration.activeServerId, externalActionTarget: target,
        })
      : await handlers.get('scm.diffSummary.capture')!(createTargetedActionRpcRequestV1(input, target), {
          signal: new AbortController().signal,
          machineAdmission: { actorAccountId: accountId, custodianAccountId: accountId, machineId,
            installationId: 'source-installation', role: 'manage', encryptionMode: 'plain' },
          verifyMachineAdmissionCurrent: async () => true,
          transportRequestId: 'rpc-source-comparison',
        });
    const capture = ingress === 'ui' && result && typeof result === 'object' && 'result' in result ? result.result : result;
    expect(capture, JSON.stringify(result)).toMatchObject({ success: true, comparison: {
      source, freshness: 'current', inventory: { state: 'complete', files: [expect.objectContaining({ path: 'current.ts',
        evidence: { state: 'available', unifiedDiff: expect.stringContaining('+new') } })], reasons: [] },
    } });
    expect(paths.filter(path => path.endsWith('/files'))).toHaveLength(1);
  } finally {
    await runtime?.dispose(); restore?.(); await app.close();
    vi.restoreAllMocks(); vi.unstubAllGlobals(); resetActiveAccountSettingsSnapshotForTests();
    env.restore(); reloadConfiguration();
    await Promise.all([rm(home, { recursive: true, force: true }), rm(fixture.rootPath, { recursive: true, force: true })]);
  }
});
