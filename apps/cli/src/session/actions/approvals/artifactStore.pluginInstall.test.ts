import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApprovalRequestV2Schema, artifactIdScopeMatchesAccountV1, deriveAccountScopedArtifactIdV1, type ApprovalRequest, type ActionExecutorDeps } from '@happier-dev/protocol';
import { createPluginInstallationReviewFixture } from '@happier-dev/protocol/testing/pluginInstallationReviewFixture';
import { readPluginInstallApprovalPendingReview } from '@happier-dev/protocol/actions/actionApprovalPresentation';
import { buildApprovalRequestArtifactHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { ArtifactBodyEnvelopeV1Schema } from '@happier-dev/protocol/artifacts/artifactBinaryV1';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDaemonPluginRuntimeOwner } from '@/plugins/daemon/runtimeOwner';
import { createPackedTestConnectedAccountsRuntime } from '@/plugins/daemon/packedTestConnectedAccounts';
import { createPluginReloadController } from '@/plugins/runtime/reload/controller';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import { createPluginRegistryStateStore } from '@/plugins/store/registry/currentState';
import { projectApprovalExecutionFailureV2 } from '@happier-dev/protocol/approvals/approvalExecutionFailure';
import { libsodiumPublicKeyFromSecretKey } from '@/api/encryption';
import type { StoredCredentials } from '@/persistence';
import { PluginAvailabilityIntentReadActionOutputV1Schema } from '@happier-dev/protocol/plugins/availability/actions';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { ActionApprovalRequestCreatedResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { createDaemonApprovalExecutionOriginCurrentness, createDaemonExternalActionTargetResolver } from '@/daemon/externalActions/daemonExternalActionTargetResolver';
import { createCliActionDeps } from '../createCliActionDeps';
import { createCliActionExecutorFromCredentials } from '../createCliActionExecutorFromCredentials';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { handleActionsCommand } from '@/cli/commands/actions';
import { captureConsoleJsonOutput } from '@/testkit/logger/captureOutput';
import { configuration } from '@/configuration';
import { updateSettings } from '@/persistence';
import { getServerProfile } from '@/server/serverProfiles';
import { seedTestServerProfile } from '@/testkit/serverProfiles';
import * as daemonPublication from '@/daemon/multiDaemon';
import * as daemonHttp from '@/daemon/controlHttp';
import { createDaemonControlApp } from '@/daemon/controlServer';
import { createTestNpmTarball } from '@/plugins/distribution/testkit/npmTarball';
import { AccountEncryptionModeResponseSchema } from '@happier-dev/protocol/account/encryptionMode';
import { ExternalActionMachineBootstrapV1Schema, ExternalActionExecutionAuthorizationRequestV1Schema, ExternalActionExecutionAuthorizationV1Schema, EXTERNAL_ACTION_HTTP_PATH_PREFIX_V1, bindExternalActionExecutionAuthorizationHttpPathV1, projectExternalActionApprovalDecisionAdmissionV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { openExternalActionRequesterAccountContextV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { readOrCreateInstallationIdentity } from '@/daemon/identity/store';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';

import { createCliApprovalsArtifactStore } from './artifactStore';

// Only the Account HTTP boundary is replaced; the real Artifact codec, header
// binding, approval parser, and lifecycle transition owner remain in the path.
const http = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), defaults: {} }));
vi.mock('axios', () => ({ default: http }));
// Process startup is outside this composed in-process daemon fixture.
vi.mock('@/daemon/ensureDaemon', () => ({ ensureDaemonRunningForSessionCommand: async () => undefined }));
vi.mock('@/configuration', () => ({ configuration: {
  apiServerUrl: 'http://plugin-approval.invalid', activeServerId: 'home-1',
  activeServerDir: '/tmp/happier-plugin-approval-test',
} }));

const pendingChangeId = '00000000-0000-4000-8000-000000000051';
const rows = new Map<string, Record<string, unknown>>();
let accountMode: 'plain' | 'e2ee' = 'plain';
const machineKey = new Uint8Array(32).fill(7);
const token = 'header.eyJzdWIiOiJhY2NvdW50LTEifQ.signature';

function credentials(): StoredCredentials {
  return { token, encryption: accountMode === 'plain' ? null : {
    type: 'dataKey', publicKey: libsodiumPublicKeyFromSecretKey(machineKey), machineKey,
  } };
}

function installRequest() {
  return ApprovalRequestV2Schema.parse({
    v: 2, actionId: 'plugins.install', status: 'open', summary: 'Review plugin install',
    createdAtMs: 1, updatedAtMs: 1, createdBy: { surface: 'system' }, requestedSurface: 'cli',
    executionOriginV1: {
      v: 1, authority: 'account_automation', surface: 'cli', caller: { kind: 'host' },
      serverId: 'home-1', serverIdentityId: 'home-identity', accountId: 'account-1',
      machineId: 'machine-1', target: { kind: 'machine', machineId: 'machine-1' },
      actionId: 'plugins.install', requestId: 'observer-request',
    },
    actionArgs: { kind: 'path', path: '/tmp/example' },
    preview: { pluginInstall: { pendingReview: {
      kind: 'reviewRequired', reviewKind: 'installation', pendingChangeId,
      reason: 'firstInstall', currentVersion: null, authorityExpansion: [],
      review: createPluginInstallationReviewFixture(),
    } } },
  });
}

function createStore() {
  const mode = accountMode;
  return createCliApprovalsArtifactStore({ credentials: credentials(), getAccountEncryptionMode: async () => mode });
}

function persist(body: Record<string, unknown>) {
  rows.set(String(body.id), { ...body, ownerAccountId: 'account-1', access: 'owner', encryptionMode: accountMode,
    headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 });
  return { status: 200, data: { id: body.id, headerVersion: 1, bodyVersion: 1 } };
}

beforeEach(() => {
  accountMode = 'plain';
  rows.clear();
  http.get.mockReset();
  http.post.mockReset();
  http.get.mockImplementation(async (url: string) => {
    if (url.endsWith('/v1/account/encryption')) return { status: 200,
      data: AccountEncryptionModeResponseSchema.parse({ mode: accountMode, updatedAt: 0 }) };
    if (url.endsWith('/recipients')) {
      const artifactId = decodeURIComponent(url.split('/').at(-3)!);
      const artifact = rows.get(artifactId)!;
      return { status: 200, data: { artifactId, ownerAccountId: artifact.ownerAccountId, access: artifact.access,
        encryptionMode: artifact.encryptionMode, dataEncryptionKey: artifact.dataEncryptionKey,
        callerDataEncryptionKey: artifact.dataEncryptionKey, recipients: [] } };
    }
    const id = url.split('/').at(-1)!;
    return { status: rows.has(id) ? 200 : 404, data: rows.get(id) };
  });
  http.post.mockImplementation(async (url: string, body: Record<string, unknown>) => {
    if (url.endsWith('/v1/plugins/availability/intents/read')) {
      return { status: 200, data: PluginAvailabilityIntentReadActionOutputV1Schema.parse({
        availabilityCursor: 0, hostingCapability: { enabled: false }, intent: null, release: null,
        uiArtifacts: [], packageAssets: [], managedResources: [], managedResourcesReviewed: true,
      }) };
    }
    if (url.endsWith('/v1/artifacts')) {
      if (!artifactIdScopeMatchesAccountV1({ artifactId: String(body.id), accountId: 'account-1', idScope: body.idScope }))
        return { status: 400, data: { error: 'Invalid parameters' } };
      if (rows.has(String(body.id))) return { status: 409, data: { error: 'conflict' } };
      return persist(body);
    }
    const id = url.split('/').at(-1)!;
    const row = rows.get(id)!;
    rows.set(id, { ...row, header: body.header, body: body.body,
      headerVersion: Number(row.headerVersion) + 1, bodyVersion: Number(row.bodyVersion) + 1 });
    return { status: 200, data: { success: true,
      headerVersion: Number(row.headerVersion) + 1, bodyVersion: Number(row.bodyVersion) + 1 } };
  });
});

describe('plugin install approval Artifact rejoin', () => {
  it('installs a non-dev archive from a saved Home through daemon review and one approval without a Machine flag', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-saved-home-install-'));
    const happyHomeDir = join(root, 'home');
    const source = join(root, 'plugin.tgz');
    const pluginId = 'acme.saved-home-review';
    await mkdir(happyHomeDir, { recursive: true });
    await writeFile(source, await createTestNpmTarball([
      { name: 'package/package.json', body: JSON.stringify({ name: '@acme/saved-home-review', version: '1.0.0',
        keywords: ['happier-plugin'], files: ['.happier-plugin'], happier: { manifest: '.happier-plugin/plugin.json' } }) },
      { name: 'package/.happier-plugin/plugin.json', body: JSON.stringify(createPluginManifestV2Fixture({
        id: pluginId, version: '1.0.0', entrypoints: undefined, engines: undefined,
      })) },
    ]));
    const storedCredentials: StoredCredentials = { token: `fixture.${Buffer.from(JSON.stringify({ sub: 'account-1',
      tokenEpoch: 0, provenance: { v: 1, kind: 'terminal', authority: 'account_automation' } })).toString('base64url')}.signature`,
      encryption: null, credentialProvenance: 'stored_session' };
    const store = createCliApprovalsArtifactStore({ credentials: storedCredentials, getAccountEncryptionMode: async () => 'plain' });
    const reloadController = createPluginReloadController({ happyHomeDir });
    const origin = { machineId: 'machine-1', serverIdentityId: 'srv_saved_home' };
    const previousConfiguration = { happyHomeDir: configuration.happyHomeDir,
      settingsFile: configuration.settingsFile, serversDir: configuration.serversDir };
    Object.assign(configuration, { happyHomeDir, settingsFile: join(happyHomeDir, 'settings.json'),
      serversDir: join(happyHomeDir, 'servers') });
    const installation = await readOrCreateInstallationIdentity(join(root, 'installation.json'));
    const accountChanges = await createRequesterCurrentnessSocketHarness();
    const canonical = await seedTestServerProfile({ id: 'env-home', homeId: origin.serverIdentityId,
      serverUrl: 'https://plugin-approval.invalid' });
    await updateSettings(settings => ({ ...settings, servers: { ...settings.servers, 'home-1': {
      id: 'home-1', name: 'Saved Home', serverUrl: canonical.serverUrl,
      localServerUrl: 'http://plugin-approval.invalid', webappUrl: canonical.serverUrl, createdAt: 1, updatedAt: 1,
    } } }));
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => Response.json({ features: {},
      capabilities: { serverIdentity: { serverIdentityId: origin.serverIdentityId } },
      homeConnectionDescriptor: canonical.homeConnectionDescriptor })));
    const owner = createDaemonPluginRuntimeOwner({ happyHomeDir, reloadController, staleCandidateCleanup: 'disabled',
      approvalStore: store, connectedAccounts: createPackedTestConnectedAccountsRuntime({ happyHomeDir, pluginId }).owner,
      managedResourcePreflight: { credentials: storedCredentials, serverUrl: 'http://plugin-approval.invalid',
        homeId: origin.serverIdentityId, controller: { machineId: origin.machineId, installationId: installation.installationId } },
      resolveCurrentMachineExecutionOriginContext: async () => origin });
    const isApprovalExecutionOriginCurrent = createDaemonApprovalExecutionOriginCurrentness({ accountId: 'account-1',
      ...origin, serverId: 'home-1', resolveCurrentMachineExecutionOriginContext: async () => origin,
      resolveTarget: createDaemonExternalActionTargetResolver({ credentials: storedCredentials }),
      isAccountCurrent: async () => true, listAccountApiTokens: async () => ({ tokens: [] }) });
    const replayExecutor = createActionExecutor({ ...createCliActionDeps({ token: storedCredentials.token,
      credentials: storedCredentials, sessionId: 'cli-global', mode: 'plain', ctx: null, serverId: 'home-1',
      serverHttpBaseUrl: 'http://plugin-approval.invalid', happyHomeDir, pluginChangeService: owner.changeService }), ...store,
      isApprovalExecutionOriginCurrent });
    const daemonExecutor = createCliActionExecutorFromCredentials({ credentials: storedCredentials,
      serverId: 'home-1', serverApiUrl: 'http://plugin-approval.invalid', serverIdentityId: origin.serverIdentityId,
      machineId: origin.machineId, happyHomeDir, pluginChangeService: owner.changeService,
      isApprovalExecutionOriginCurrent,
      pluginActionExecutionOwner: 'current_process' });
    // OS publication and local HTTP are the process boundaries. Keep CLI routing,
    // daemon ingress, candidate preparation, Artifact custody and execution real.
    const publication = vi.spyOn(daemonPublication, 'resolveLiveDaemonControlTargetForServer').mockImplementation(async serverId =>
      serverId === 'home-1' ? { pid: process.pid, httpPort: 1, controlToken: 'test-control',
        machineId: origin.machineId, accountId: 'account-1' } : null);
    const app = createDaemonControlApp({ machineId: origin.machineId, controlToken: 'test-control',
      getChildren: () => [], stopSession: async () => { throw new Error('Unexpected stop'); }, spawnSession: async () => { throw new Error('Unexpected spawn'); },
      requestShutdown: () => {}, onHappySessionWebhook: () => {}, pluginChangeService: owner.changeService,
      externalActionApi: { currentServerId: 'home-1', currentAccountId: 'account-1', executor: daemonExecutor,
        resolveTarget: createDaemonExternalActionTargetResolver({ credentials: storedCredentials }),
        resolvePluginExecutionOriginContext: async () => origin, resolveInstallationId: () => installation.installationId,
        verifyPat: async () => { throw new Error('Unexpected PAT'); } } });
    const control = vi.spyOn(daemonHttp, 'daemonPost').mockImplementation(async (path, body) => {
      const response = await app.inject({ method: 'POST', url: path,
        headers: { 'x-happier-daemon-token': 'test-control' }, ...(body === undefined ? {} : { payload: body }) });
      return response.json();
    });
    const accountGet = http.get.getMockImplementation()!;
    const accountPost = http.post.getMockImplementation()!;
    http.get.mockImplementation(async (url: string, ...args: unknown[]) => {
      if (url.endsWith(`/v1/machines/${origin.machineId}`)) return { status: 200, data: {
        machine: { ...ExternalActionMachineBootstrapV1Schema.parse({ id: origin.machineId,
          managedMachineRef: null, active: true, revokedAt: null, replacedByMachineId: null,
          kind: 'persistent', installationId: installation.installationId, access: {
            custodian: { accountId: 'account-1', displayName: 'Fixture owner' }, role: 'manage',
            resourceMode: 'plain', accessState: 'ready',
          } }), installationPublicKey: Buffer.from(installation.publicKey, 'base64url').toString('base64') },
      } };
      return accountGet(url, ...args);
    });
    http.post.mockImplementation(async (url: string, body: Record<string, unknown>, ...args: unknown[]) => {
      if (url.endsWith(bindExternalActionExecutionAuthorizationHttpPathV1('approval.request.decide'))) {
        const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
        if (request.envelope.v !== 1) throw new Error('Expected plain Account request');
        return { status: 200, data: ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1,
          token: 'fixture-home-admission', binding: { accountId: 'account-1', custodianAccountId: 'account-1',
            authentication: { kind: 'terminal', tokenEpoch: 0 }, accountEncryptionMode: 'plain',
            serverIdentityId: origin.serverIdentityId, machineId: origin.machineId,
            installationId: installation.installationId, actionId: 'approval.request.decide',
            requestId: request.envelope.requestId,
            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(request.envelope),
            target: request.envelope.target,
            approvalDecisionAdmission: projectExternalActionApprovalDecisionAdmissionV1(request.envelope.input),
          } }) };
      }
      if (url.endsWith(`${EXTERNAL_ACTION_HTTP_PATH_PREFIX_V1}approval.request.decide`)) {
        // Model the remote Home/installed executor boundary, retaining the
        // actual sealed CLI requester rather than inventing approving authority.
        const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
        const requester = openExternalActionRequesterAccountContextV1({ authorization: request.executionAuthorization,
          purpose: { kind: 'external_action' }, ...origin, installationId: installation.installationId,
          installationPrivateKey: Buffer.from(installation.privateKey, 'base64url'), includeInvocation: true });
        expect(requester?.invocation).toMatchObject({ surface: 'cli', authority: 'present_user', caller: { kind: 'host' } });
        if (!requester?.invocation || request.envelope.v !== 1) throw new Error('Missing original CLI requester');
        const execution = await replayExecutor.execute('approval.request.decide', request.envelope.input, {
          surface: requester.invocation.surface, authority: requester.invocation.authority,
          actionCaller: requester.invocation.caller, runtimeAccountId: 'account-1',
          serverId: 'home-1', serverIdentityId: origin.serverIdentityId,
          actionRequestId: request.envelope.requestId, externalActionTarget: request.envelope.target });
        await accountChanges.hintAccountChange();
        return { status: 200, data: { v: 1, actionId: 'approval.request.decide', requestId: request.envelope.requestId, execution } };
      }
      return accountPost(url, body, ...args);
    });
    try {
      const output = captureConsoleJsonOutput<unknown>();
      try {
        await handleActionsCommand(['invoke', 'plugins.install', '--server-id', 'home-1', '--kind', 'archive',
          '--path', source, '--yes', '--json'], {
          readCredentialsFn: async () => storedCredentials,
          readCredentialsForServerIdFn: async () => storedCredentials,
          getServerProfileFn: getServerProfile,
          createExecutorFn: params => createCliActionExecutorFromCredentials({ ...params,
            actionsSettingsProvider: createActionSettingsProvider() }),
        });
        const result = output.json();
        expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
      } finally { output.restore(); process.exitCode = 0; }
      const artifactId = [...rows.keys()][0]!;
      expect(await store.approvalsGet({ artifactId, serverId: 'home-1' })).toMatchObject({ status: 'executed',
        executionOriginV1: { ...origin, accountId: 'account-1', target: { kind: 'machine', machineId: origin.machineId } } });
      const decision = () => replayExecutor.execute('approval.request.decide', { artifactId, decision: 'approve' }, {
        surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' }, runtimeAccountId: 'account-1',
        serverId: 'home-1', serverIdentityId: origin.serverIdentityId });
      expect((await createPluginRegistryStateStore({ happyHomeDir }).read()).plugins[pluginId]?.install.manifestVersion).toBe('1.0.0');
      expect(await decision()).toMatchObject({ ok: true, result: { status: 'executed' } });
      expect(control).toHaveBeenCalledTimes(1);
    } finally {
      control.mockRestore(); publication.mockRestore();
      vi.unstubAllGlobals();
      Object.assign(configuration, previousConfiguration);
      await app.close();
      await accountChanges.close();
      await owner.changeService.shutdown(); await reloadController.shutdown();
      await rm(root, { recursive: true, force: true });
    }
  });
  it.each([['install', 'plain'], ['install', 'e2ee'], ['cancel', 'plain'], ['unmounted', 'plain']] as const)(
    'uses product confirmation for the exact Machine candidate: %s in %s', async (outcome, mode) => {
      accountMode = mode;
      const root = await mkdtemp(join(tmpdir(), 'happier-plugin-approval-machines-'));
      const store = createStore();
      const pluginId = 'acme.machine-review';
      const serverIdentityId = 'srv_machine_review';
      const machines = await Promise.all(['machine-a', 'machine-b'].map(async machineId => {
        const happyHomeDir = join(root, machineId, 'home');
        const source = join(root, machineId, 'plugin.tgz');
        await mkdir(happyHomeDir, { recursive: true });
        const writeCandidate = async (version: string) => writeFile(source, await createTestNpmTarball([
          { name: 'package/package.json', body: JSON.stringify({ name: '@acme/machine-review', version, keywords: ['happier-plugin'], files: ['.happier-plugin'],
            happier: { manifest: '.happier-plugin/plugin.json' } }) },
          { name: 'package/.happier-plugin/plugin.json', body: JSON.stringify(createPluginManifestV2Fixture({
            id: pluginId, version, entrypoints: undefined, engines: undefined,
          })) },
        ]));
        await writeCandidate('1.0.0');
        const reloadController = createPluginReloadController({ happyHomeDir });
        const currentOrigin = { machineId, serverIdentityId };
        const owner = createDaemonPluginRuntimeOwner({ happyHomeDir, reloadController,
          staleCandidateCleanup: 'disabled', approvalStore: store,
          connectedAccounts: createPackedTestConnectedAccountsRuntime({ happyHomeDir, pluginId }).owner,
          managedResourcePreflight: { credentials: credentials(), serverUrl: 'http://plugin-approval.invalid',
            homeId: serverIdentityId, controller: { machineId, installationId: `installation-${machineId}` } },
          resolveCurrentMachineExecutionOriginContext: async () => currentOrigin,
        });
        const preparation = { calls: 0 };
        const deps = createCliActionDeps({ token, credentials: credentials(), sessionId: 'cli-global',
          mode: 'plain', ctx: null, serverId: 'home-1', serverHttpBaseUrl: 'http://plugin-approval.invalid', happyHomeDir,
          pluginChangeService: { ...owner.changeService, requestPluginChange: (...args) => {
            preparation.calls += 1;
            return owner.changeService.requestPluginChange(...args);
          } },
        });
        const reviews: string[] = [];
        // The mounted product presenter is the human UI boundary. Candidate
        // preparation and installation use the real owners.
        const presentUserActionConfirmation: NonNullable<ActionExecutorDeps['presentUserActionConfirmation']> = async ({ preview }) => {
          const candidate = readPluginInstallApprovalPendingReview(preview);
          if (!candidate) throw new Error('Missing daemon-evaluated review');
          expect(candidate.review.source).toMatchObject({ kind: 'archive', locator: source });
          expect(await owner.changeService.statusPluginChange({ pendingChangeId: candidate.pendingChangeId }))
            .toMatchObject({ kind: 'reviewRequired', pendingChangeId: candidate.pendingChangeId });
          expect((await createPluginRegistryStateStore({ happyHomeDir }).read()).plugins[pluginId]).toBeUndefined();
          reviews.push(candidate.pendingChangeId);
          // Consent applies to the retained candidate, even if its source changes.
          if (outcome === 'install') await writeCandidate('2.0.0');
          return outcome === 'install';
        };
        const executor = createActionExecutor({ ...deps, ...store,
          ...(outcome === 'unmounted' ? {} : { presentUserActionConfirmation }),
        });
        return { machineId, happyHomeDir, source, reloadController, owner, executor, reviews, preparation };
      }));
      try {
        for (const machine of machines) {
          const result = await machine.executor.execute('plugins.install', {
            kind: 'archive', path: machine.source, machineId: machine.machineId,
          }, { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
            serverId: 'home-1', serverIdentityId, runtimeAccountId: 'account-1',
            actionRequestId: `install-${machine.machineId}` });
          expect(result, JSON.stringify(result)).toMatchObject(outcome === 'install'
            ? { ok: true, result: { ok: true, outcome: 'applied' } }
            : { ok: false, errorCode: outcome === 'unmounted' ? 'action_interactive_review_required' : 'approval_canceled' });
          expect(machine.reviews).toHaveLength(outcome === 'unmounted' ? 0 : 1);
          expect(machine.preparation.calls).toBe(outcome === 'unmounted' ? 0 : 1);
          expect((await createPluginRegistryStateStore({ happyHomeDir: machine.happyHomeDir }).read()).plugins[pluginId]?.install.manifestVersion)
            .toBe(outcome === 'install' ? '1.0.0' : undefined);
        }
        if (outcome !== 'unmounted') {
          expect(machines[0]!.reviews[0]).not.toBe(machines[1]!.reviews[0]);
          expect(await machines[1]!.owner.changeService.statusPluginChange({ pendingChangeId: machines[0]!.reviews[0]! }))
            .toEqual({ kind: 'expired' });
        }
        // Native product review must never manufacture an agent approval Artifact.
        expect(rows.size).toBe(0);
      } finally {
        for (const machine of machines) {
          await machine.owner.changeService.shutdown();
          await machine.reloadController.shutdown();
        }
        await rm(root, { recursive: true, force: true });
      }
    });

  it.each([['rejected', 'plain'], ['canceled', 'plain'], ['withdrawn', 'plain'], ['expired_origin', 'plain'],
    ['superseded_source', 'plain'], ['approved', 'plain'], ['successor', 'plain'], ['canceled', 'e2ee']] as const)(
    'settles the exact %s approval candidate in %s through the real daemon and approval lifecycle', async (outcome, mode) => {
    accountMode = mode;
    const root = await mkdtemp(join(tmpdir(), 'happier-plugin-approval-retirement-'));
    const pluginRoot = join(root, 'source');
    const happyHomeDir = join(root, 'home');
    const pluginId = 'acme.approval-retirement';
    const store = createStore();
    const reloadController = createPluginReloadController({ happyHomeDir });
    const owner = createDaemonPluginRuntimeOwner({ happyHomeDir, staleCandidateCleanup: 'disabled', reloadController,
      connectedAccounts: createPackedTestConnectedAccountsRuntime({ happyHomeDir, pluginId }).owner,
      approvalStore: store,
      managedResourcePreflight: { credentials: credentials(), serverUrl: 'http://plugin-approval.invalid',
        homeId: 'home-identity', controller: { machineId: 'machine-1', installationId: 'installation-1' } },
      resolveCurrentMachineExecutionOriginContext: async () => ({ machineId: 'machine-1', serverIdentityId: 'home-identity' }),
    });
    try {
      const manifestPath = join(pluginRoot, '.happier-plugin', 'plugin.json');
      await mkdir(happyHomeDir, { recursive: true });
      await mkdir(join(pluginRoot, '.happier-plugin'), { recursive: true });
      await writeFile(manifestPath, JSON.stringify(createPluginManifestV2Fixture({ id: pluginId, entrypoints: undefined, engines: undefined })));
      const first = await owner.changeService.requestPluginChange({ kind: 'installPath', locator: pluginRoot });
      if (first.kind !== 'reviewRequired') throw new Error(`Expected first installation review: ${JSON.stringify(first)}`);
      expect(await owner.changeService.decidePluginChange({ pendingChangeId: first.pendingChangeId, decision: 'installAndTrust' }))
        .toMatchObject({ kind: 'committed', pluginId });
      await writeFile(manifestPath, JSON.stringify({ ...JSON.parse(await readFile(manifestPath, 'utf8')), version: '1.1.0' }));
      const candidate = await owner.changeService.requestPluginChange({ kind: 'installPath', locator: pluginRoot }, { retainReview: true });
      if (candidate.kind !== 'reviewRequired') throw new Error(`Expected retained update review: ${candidate.kind}`);
      const request = ApprovalRequestV2Schema.parse({ ...installRequest(), actionArgs: { kind: 'path', path: pluginRoot },
        preview: { pluginInstall: { pendingReview: candidate } } });
      const created = await store.approvalsCreate({ request, serverId: 'home-1' });
      let terminal = ApprovalRequestV2Schema.parse({ ...request,
        status: outcome === 'rejected' ? 'rejected' : 'canceled', updatedAtMs: 2,
        ...(outcome === 'rejected' ? { decision: { kind: 'reject', decidedAtMs: 2 } } : {}) });
      if (outcome !== 'rejected' && outcome !== 'canceled' && outcome !== 'successor') {
        const approved = ApprovalRequestV2Schema.parse({ ...request, status: 'approved', updatedAtMs: 2,
          decision: { kind: 'approve', authority: 'present_user', decidedAtMs: 2 } });
        expect(await store.approvalsUpdate({ ...created, request: approved, serverId: 'home-1' })).toEqual({ ok: true });
        // Existing approval owners record withdrawal as approval_canceled and
        // unavailable origin/source authority as approval_stale, not new states.
        terminal = ApprovalRequestV2Schema.parse({ ...approved, status: 'failed', updatedAtMs: 3,
          execution: projectApprovalExecutionFailureV2({ request: approved, executedAtMs: 3, effectAttempted: false,
            failure: outcome === 'withdrawn'
              ? { ok: false, errorCode: 'approval_canceled', error: 'approval_canceled' }
              : { ok: false, errorCode: 'approval_stale', error: 'approval_stale',
                  details: { reason: outcome === 'expired_origin' ? 'credential_expired' : 'plugin_source_changed' } } }),
        });
        if (outcome === 'approved') {
          expect(await owner.changeService.statusPluginChange({ pendingChangeId: candidate.pendingChangeId }))
            .toMatchObject({ kind: 'reviewRequired', pendingChangeId: candidate.pendingChangeId });
          const decision = { pendingChangeId: candidate.pendingChangeId, decision: 'installAndTrust' as const };
          const [applied, duplicate] = await Promise.all([
            owner.changeService.decidePluginChange(decision), owner.changeService.decidePluginChange(decision),
          ]);
          expect(applied).toMatchObject({ kind: 'committed', pluginId });
          expect(duplicate).toEqual(applied);
          expect((await createPluginRegistryStateStore({ happyHomeDir }).read()).plugins[pluginId]?.install.manifestVersion).toBe('1.1.0');
          return;
        }
      }
      // Another client's real Artifact lifecycle write bypasses cliActionDeps.
      expect(await createStore().approvalsUpdate({ ...created, request: terminal, serverId: 'home-1' })).toEqual({ ok: true });
      if (outcome === 'successor') {
        const nextRequest = ApprovalRequestV2Schema.parse({ ...request,
          executionOriginV1: { ...request.executionOriginV1, requestId: 'fresh-owner-consent' } });
        const successor = await createStore().approvalsCreate({ request: nextRequest, serverId: 'home-1' });
        expect(successor.artifactId).not.toBe(created.artifactId);
        expect(await owner.changeService.statusPluginChange({ pendingChangeId: candidate.pendingChangeId }))
          .toMatchObject({ kind: 'reviewRequired', pendingChangeId: candidate.pendingChangeId });
        const approved = ApprovalRequestV2Schema.parse({ ...nextRequest, status: 'approved', updatedAtMs: 2,
          decision: { kind: 'approve', authority: 'present_user', decidedAtMs: 2 } });
        expect(await store.approvalsUpdate({ ...successor, request: approved, serverId: 'home-1' })).toEqual({ ok: true });
        expect(await owner.changeService.statusPluginChange({ pendingChangeId: candidate.pendingChangeId }))
          .toMatchObject({ kind: 'reviewRequired', pendingChangeId: candidate.pendingChangeId });
        expect(await owner.changeService.decidePluginChange({ pendingChangeId: candidate.pendingChangeId, decision: 'installAndTrust' }))
          .toMatchObject({ kind: 'committed', pluginId });
        expect((await createPluginRegistryStateStore({ happyHomeDir }).read()).plugins[pluginId]?.install.manifestVersion).toBe('1.1.0');
        return;
      }
      if (outcome === 'canceled' && mode === 'plain') {
        const owned = rows.get(created.artifactId)!;
        for (const mismatch of ['account', 'home', 'machine', 'review', 'access'] as const) {
          const foreign = ApprovalRequestV2Schema.parse({ ...terminal,
            executionOriginV1: { ...terminal.executionOriginV1,
              ...(mismatch === 'account' ? { accountId: 'another-account' } : {}),
              ...(mismatch === 'home' ? { serverIdentityId: 'another-home' } : {}),
              ...(mismatch === 'machine' ? { machineId: 'another-machine', target: { kind: 'machine', machineId: 'another-machine' } } : {}) },
            ...(mismatch === 'review' ? { preview: { pluginInstall: { pendingReview: { ...candidate,
              review: { ...candidate.review, version: '9.0.0' } } } } } : {}),
          });
          rows.set(created.artifactId, { ...owned,
            ...(mismatch === 'access' ? { ownerAccountId: 'another-account', access: 'view' } : {}),
            header: encodePlainArtifactStoredContent(buildApprovalRequestArtifactHeaderV1(foreign)),
            body: encodePlainArtifactStoredContent(ArtifactBodyEnvelopeV1Schema.parse({ body: JSON.stringify(foreign) })) });
          expect(await owner.changeService.statusPluginChange({ pendingChangeId: candidate.pendingChangeId }), mismatch)
            .toMatchObject({ kind: 'reviewRequired', pendingChangeId: candidate.pendingChangeId });
        }
        rows.set(created.artifactId, owned);
      }
      if (outcome === 'rejected') {
        // The next mutation must work even if no client opened status first.
        expect(await owner.changeService.requestPluginChange({ kind: 'uninstall', pluginId }))
          .toMatchObject({ kind: 'committed', pluginId });
        expect(await owner.changeService.statusPluginChange({ pendingChangeId: candidate.pendingChangeId }))
          .toMatchObject({ kind: 'terminal', result: { kind: 'cancelled' } });
        expect((await createPluginRegistryStateStore({ happyHomeDir }).read()).plugins[pluginId]).toBeUndefined();
        return;
      }
      if (outcome === 'withdrawn') expect((await owner.changeService.listPendingPluginChanges()).changes).toEqual([]);
      if (outcome === 'expired_origin') {
        expect(await owner.changeService.statusPluginChange({ pendingChangeId: candidate.pendingChangeId }))
          .toMatchObject({ kind: 'terminal', result: { kind: 'cancelled' } });
        expect(await owner.changeService.decidePluginChange({ pendingChangeId: candidate.pendingChangeId, decision: 'installAndTrust' }))
          .toEqual({ kind: 'expired' });
      }
      if (outcome === 'superseded_source') {
        const next = await owner.changeService.requestPluginChange({ kind: 'installPath', locator: pluginRoot }, { retainReview: true });
        expect(next).toMatchObject({ kind: 'reviewRequired' });
        if (next.kind !== 'reviewRequired') throw new Error('Expected a fresh candidate for the next install');
        expect(next.pendingChangeId).not.toBe(candidate.pendingChangeId);
        await owner.changeService.decidePluginChange({ pendingChangeId: next.pendingChangeId, decision: 'cancel' });
      }
      const readsBeforeRetirement = http.get.mock.calls.length;
      expect(await owner.changeService.statusPluginChange({ pendingChangeId: candidate.pendingChangeId }))
        .toMatchObject({ kind: 'terminal', result: { kind: 'cancelled' } });
      // One terminal row, then the existing scoped/legacy lookup for its absent successor.
      if (mode === 'plain') expect(http.get.mock.calls.length - readsBeforeRetirement).toBe(outcome === 'canceled' ? 3 : 0);
      const readsAfterRetirement = http.get.mock.calls.length;
      await owner.changeService.statusPluginChange({ pendingChangeId: candidate.pendingChangeId });
      expect(http.get.mock.calls.length).toBe(readsAfterRetirement);
      expect((await createPluginRegistryStateStore({ happyHomeDir }).read()).plugins[pluginId]?.install.manifestVersion).toBe('1.0.0');
      expect(await owner.changeService.decidePluginChange({ pendingChangeId: candidate.pendingChangeId, decision: 'installAndTrust' }))
        .toEqual({ kind: 'expired' });
      if (outcome === 'withdrawn') {
        expect(await owner.changeService.requestPluginChange({ kind: 'update', pluginId }))
          .toMatchObject({ kind: 'committed', pluginId });
      }
      expect(await owner.changeService.requestPluginChange({ kind: 'uninstall', pluginId }))
        .toMatchObject({ kind: 'committed', pluginId });
      expect((await createPluginRegistryStateStore({ happyHomeDir }).read()).plugins[pluginId]).toBeUndefined();
    } finally {
      await owner.changeService.shutdown();
      await reloadController.shutdown();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('refuses changed input and retains the terminal receipt for one install request identity', async () => {
    const store = createStore();
    const request = installRequest();
    const first = await store.approvalsCreate({ request, serverId: 'home-1' });
    await expect(store.approvalsCreate({ request: { ...request, actionArgs: { kind: 'path', path: '/tmp/other' } }, serverId: 'home-1' }))
      .rejects.toMatchObject({ code: 'approval_request_conflict' });
    const rejected = ApprovalRequestV2Schema.parse({ ...request, status: 'rejected', updatedAtMs: 2,
      decision: { kind: 'reject', decidedAtMs: 2 } });
    expect(await store.approvalsUpdate({ ...first, request: rejected, serverId: 'home-1' })).toEqual({ ok: true });
    expect(await store.approvalsCreate({ request, serverId: 'home-1' })).toEqual({ artifactId: first.artifactId, request: rejected });
    expect(rows.size).toBe(1);
  });

  it('rejoins the retained review across observers without replacing its approved body', async () => {
    const store = createStore();
    const request = installRequest();
    const first = await store.approvalsCreate({ request, serverId: 'home-1' });
    expect(first.artifactId).toBe(deriveAccountScopedArtifactIdV1('account-1', pendingChangeId));
    const approved = ApprovalRequestV2Schema.parse({ ...request, status: 'approved', updatedAtMs: 2,
      decision: { kind: 'approve', decidedAtMs: 2, authority: 'present_user' } });
    expect(await store.approvalsUpdate({ ...first, request: approved, serverId: 'home-1' })).toEqual({ ok: true });
    const retained = { ...rows.get(first.artifactId) };
    const cliRequest = ApprovalRequestV2Schema.parse({ ...request,
      createdBy: { surface: 'cli' }, createdAtMs: 3, updatedAtMs: 3,
      executionOriginV1: { ...request.executionOriginV1, serverId: 'home-alias',
        authority: 'present_user', requestId: 'cli-request' } });
    expect(await createStore().approvalsCreate({ request: cliRequest, serverId: 'home-alias' }))
      .toEqual({ artifactId: first.artifactId, request: approved });
    expect(rows.size).toBe(1);
    expect(rows.get(first.artifactId)).toEqual(retained);
    expect(await store.approvalsGet({ ...first, serverId: 'home-1' })).toEqual(approved);
  });

  it('rejoins the winning Artifact after a concurrent create conflict without another write', async () => {
    const store = createStore();
    http.post.mockImplementationOnce(async (_url: string, body: Record<string, unknown>) => {
      persist(body);
      return { status: 409, data: { error: 'conflict' } };
    });
    expect(await store.approvalsCreate({ request: installRequest(), serverId: 'home-1' }))
      .toEqual({ artifactId: deriveAccountScopedArtifactIdV1('account-1', pendingChangeId), request: installRequest() });
    expect(rows.size).toBe(1);
    expect(http.post).toHaveBeenCalledTimes(1);
  });

  it.each(['rejected', 'executed'] as const)(
    'creates a fresh approval after the retained review Artifact is %s', async (status) => {
      const store = createStore();
      const request = installRequest();
      const first = await store.approvalsCreate({ request, serverId: 'home-1' });
      if (status === 'executed') {
        const approved = ApprovalRequestV2Schema.parse({ ...request, status: 'approved', updatedAtMs: 2,
          decision: { kind: 'approve', decidedAtMs: 2, authority: 'present_user' } });
        expect(await store.approvalsUpdate({ ...first, request: approved, serverId: 'home-1' })).toEqual({ ok: true });
        const executing = ApprovalRequestV2Schema.parse({ ...approved, status: 'executing', updatedAtMs: 3 });
        expect(await store.approvalsUpdate({ ...first, request: executing, serverId: 'home-1' })).toEqual({ ok: true });
      }
      const terminal = ApprovalRequestV2Schema.parse(status === 'rejected'
        ? { ...request, status, updatedAtMs: 2,
            decision: { kind: 'reject', decidedAtMs: 2 } }
        : { ...request, status, updatedAtMs: 4,
            decision: { kind: 'approve', decidedAtMs: 2, authority: 'present_user' },
            execution: { executedAtMs: 4, ok: true, result: { kind: 'committed' } } });
      expect(await store.approvalsUpdate({ ...first, request: terminal, serverId: 'home-1' })).toEqual({ ok: true });

      const nextRequest = ApprovalRequestV2Schema.parse({
        ...request,
        createdAtMs: 5,
        updatedAtMs: 5,
        executionOriginV1: { ...request.executionOriginV1, requestId: `request-after-${status}` },
      });
      const next = await createStore().approvalsCreate({ request: nextRequest, serverId: 'home-1' });

      expect(next.artifactId).not.toBe(first.artifactId);
      expect(rows.size).toBe(2);
      expect(await store.approvalsGet({ ...first, serverId: 'home-1' })).toEqual(terminal);
      expect(await store.approvalsGet({ ...next, serverId: 'home-1' })).toEqual(nextRequest);
      const recreated = createStore();
      expect(await recreated.approvalsCreate({ request: nextRequest, serverId: 'home-1' })).toEqual(next);
      expect(await createStore().approvalsCreate({ request: nextRequest, serverId: 'home-1' })).toEqual(next);
      expect(rows.size).toBe(2);
    },
  );

  it('concurrent rejoin after terminal history creates one exact successor', async () => {
    const request = installRequest();
    const store = createStore();
    const first = await store.approvalsCreate({ request, serverId: 'home-1' });
    const rejected = ApprovalRequestV2Schema.parse({ ...request, status: 'rejected', updatedAtMs: 2,
      decision: { kind: 'reject', decidedAtMs: 2 } });
    expect(await store.approvalsUpdate({ ...first, request: rejected, serverId: 'home-1' })).toEqual({ ok: true });

    const nextRequest = ApprovalRequestV2Schema.parse({ ...request,
      executionOriginV1: { ...request.executionOriginV1, requestId: 'next-install-intent' } });
    const joined = await Promise.all([createStore(), createStore()].map(observer =>
      observer.approvalsCreate({ request: nextRequest, serverId: 'home-1' })));
    expect(joined[0]).toEqual(joined[1]);
    expect(rows.size).toBe(2);
    expect(await store.approvalsGet({ ...first, serverId: 'home-1' })).toEqual(rejected);
    expect(await store.approvalsGet({ ...joined[0]!, serverId: 'home-1' })).toEqual(nextRequest);
  });

  it('refuses a successor whose retained subject belongs to another Home', async () => {
    const request = installRequest();
    const store = createStore();
    const first = await store.approvalsCreate({ request, serverId: 'home-1' });
    const rejected = ApprovalRequestV2Schema.parse({ ...request, status: 'rejected', updatedAtMs: 2,
      decision: { kind: 'reject', decidedAtMs: 2 } });
    await store.approvalsUpdate({ ...first, request: rejected, serverId: 'home-1' });
    const nextRequest = ApprovalRequestV2Schema.parse({ ...request,
      executionOriginV1: { ...request.executionOriginV1, requestId: 'next-install-intent' } });
    const next = await createStore().approvalsCreate({ request: nextRequest, serverId: 'home-1' });
    const foreign = ApprovalRequestV2Schema.parse({ ...nextRequest,
      executionOriginV1: { ...nextRequest.executionOriginV1, serverIdentityId: 'other-home' } });
    const row = rows.get(next.artifactId)!;
    rows.set(next.artifactId, { ...row,
      header: encodePlainArtifactStoredContent(buildApprovalRequestArtifactHeaderV1(foreign)),
      body: encodePlainArtifactStoredContent(ArtifactBodyEnvelopeV1Schema.parse({ body: JSON.stringify(foreign) })) });

    await expect(createStore().approvalsCreate({ request: nextRequest, serverId: 'home-1' }))
      .rejects.toThrow('approval_request_subject_mismatch');
    expect(rows.size).toBe(2);
  });

  it.each(['review', 'machine', 'home', 'account', 'family', 'access'] as const)(
    'refuses to rejoin a pending id with a different %s', async (mismatch) => {
      const store = createStore();
      const request = installRequest();
      const first = await store.approvalsCreate({ request, serverId: 'home-1' });
      if (mismatch === 'access') rows.get(first.artifactId)!.access = 'view';
      let next: ApprovalRequest = request;
      if (mismatch === 'review') next = ApprovalRequestV2Schema.parse({ ...request, preview: {
        pluginInstall: { pendingReview: { ...readPluginInstallApprovalPendingReview(request.preview),
          review: createPluginInstallationReviewFixture({ version: '2.0.0' }) } },
      } });
      if (mismatch === 'machine') next = ApprovalRequestV2Schema.parse({ ...request,
        executionOriginV1: { ...request.executionOriginV1, machineId: 'machine-2',
          target: { kind: 'machine', machineId: 'machine-2' } } });
      if (mismatch === 'home') next = ApprovalRequestV2Schema.parse({ ...request,
        executionOriginV1: { ...request.executionOriginV1, serverIdentityId: 'other-home' } });
      if (mismatch === 'account') next = ApprovalRequestV2Schema.parse({ ...request,
        executionOriginV1: { ...request.executionOriginV1, accountId: 'other-account' } });
      if (mismatch === 'family') {
        rows.clear();
        const other = ApprovalRequestV2Schema.parse({ ...request, actionId: 'session.message.send',
          actionArgs: { sessionId: 'session-1', message: 'hello' },
          executionOriginV1: { ...request.executionOriginV1, actionId: 'session.message.send' } });
        await store.approvalsCreate({ request: other, serverId: 'home-1' });
        const row = [...rows.values()][0]!;
        rows.clear(); rows.set(pendingChangeId, { ...row, id: pendingChangeId });
      }
      const retained = [...rows.entries()].map(([id, row]) => [id, { ...row }]);
      await expect(store.approvalsCreate({ request: next, serverId: 'home-1' }))
        .rejects.toThrow('approval_request_subject_mismatch');
      expect([...rows.entries()]).toEqual(retained);
    },
  );
});
